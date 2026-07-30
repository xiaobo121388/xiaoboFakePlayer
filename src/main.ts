import { system, world } from "@minecraft/server";

import { BehaviorService } from "./application/behaviorService.js";
import { InventoryService } from "./application/inventoryService.js";
import { LifecycleService } from "./application/lifecycleService.js";
import { OperationCoordinator } from "./application/operationCoordinator.js";
import { PermissionService } from "./application/permissionService.js";
import { RecoveryRunner } from "./application/recoveryRunner.js";
import { startRecovery } from "./application/startupRecovery.js";
import { SapiFakePlayerRuntime } from "./infrastructure/sapi/fakePlayerRuntime.js";
import { SapiInventoryAccess } from "./infrastructure/sapi/inventoryAccess.js";
import { StructureInventorySnapshotStore } from "./infrastructure/sapi/structureInventorySnapshotStore.js";
import { SapiWorldQueries } from "./infrastructure/sapi/worldQueries.js";
import { BankedWorldStateStore } from "./infrastructure/state/bankedWorldStateStore.js";
import { SapiStringPropertyBackend } from "./infrastructure/state/sapiStringPropertyBackend.js";
import { registerCommands, type CommandServices, type StartupStatus } from "./presentation/commands.js";
import { openFakePlayerForm } from "./presentation/forms/main.js";
import { isRealPlayer } from "./presentation/playerContext.js";

const stateStore = new BankedWorldStateStore(new SapiStringPropertyBackend());
const runtime = new SapiFakePlayerRuntime();
const coordinator = new OperationCoordinator();
const snapshots = new StructureInventorySnapshotStore(stateStore, runtime);
const inventoryAccess = new SapiInventoryAccess(snapshots, runtime);
const inventory = new InventoryService(stateStore, runtime, snapshots, coordinator, inventoryAccess);
const lifecycle = new LifecycleService(stateStore, runtime, snapshots, coordinator, inventory);
const behavior = new BehaviorService(stateStore, runtime, new SapiWorldQueries(runtime), coordinator, inventory);
const permissions = new PermissionService(stateStore);
const recovery = new RecoveryRunner(stateStore, runtime, snapshots, coordinator, inventory);

let startupStatus: StartupStatus = { state: "recovering" };
let nextMineDiagnosticTick = 0;
let nextPlaceDiagnosticTick = 0;
const openInteractionForms = new Set<string>();
const services: CommandServices = {
	behavior,
	inventory,
	lifecycle,
	permissions,
	getStartupStatus: () => startupStatus,
};

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
	registerCommands(customCommandRegistry, services);
});

world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
	if (event.itemStack !== undefined || !isRealPlayer(event.player)) return;
	const tag = event.target.getTags().find((candidate) => /^xiaobo_fp_fp\d{4,}$/.test(candidate));
	if (tag === undefined) return;

	event.cancel = true;
	const player = event.player;
	const playerId = player.id;
	if (openInteractionForms.has(playerId)) return;
	openInteractionForms.add(playerId);
	const id = tag.slice("xiaobo_fp_".length);
	system.run(() => {
		if (!player.isValid) {
			openInteractionForms.delete(playerId);
			return;
		}
		void openFakePlayerForm(player, services, id)
			.finally(() => openInteractionForms.delete(playerId));
	});
});

world.afterEvents.worldLoad.subscribe(() => {
	system.run(() => {
		startRecovery(recovery, {
			scheduleRetry: (retry) => {
				system.runTimeout(retry, 20);
			},
			updateStatus: (status) => {
				startupStatus = status;
			},
			onReady: (summary) => {
				console.info(
					`[xiaobo-fake-player] ready; rebound=${summary.reboundEntities}; `
					+ `records=${summary.recoveredRecords}; transfers=${summary.recoveredTransfers}`,
				);
				summary.diagnostics.forEach((diagnostic) => console.warn(`[xiaobo-fake-player] ${diagnostic}`));
			},
			onBlocked: (message) => {
				console.error(`[xiaobo-fake-player] recovery blocked: ${message}`);
			},
		});
	});
});

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
	if (!deadEntity.isValid) return;
	const tag = deadEntity.getTags().find((candidate) => /^xiaobo_fp_fp\d{4,}$/.test(candidate));
	if (tag === undefined) return;
	const id = tag.slice("xiaobo_fp_".length);
	system.runTimeout(() => {
		if (startupStatus.state !== "ready") return;
		try {
			const result = lifecycle.autoRespawn(id);
			if (!result.ok) console.error(`[xiaobo-fake-player] auto respawn ${id} failed: ${result.error.message}`);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			console.error(`[xiaobo-fake-player] auto respawn ${id} crashed: ${message}`);
		}
	}, 20);
});

world.afterEvents.playerBreakBlock.subscribe(({ block, player }) => {
	const tag = player.getTags().find((candidate) => /^xiaobo_fp_fp\d{4,}$/.test(candidate));
	if (tag === undefined) return;
	const id = tag.slice("xiaobo_fp_".length);
	const { x, y, z } = block.location;
	behavior.notifyBlockBroken(id, block.dimension.id, block.location);
	inventory.markDirty(id);
	console.info(
		`[xiaobo-fake-player] mine ${id} completed; dimension=${block.dimension.id}; target=${x},${y},${z}`,
	);
});

system.runInterval(() => {
	if (startupStatus.state !== "ready") return;
	try {
		const result = inventory.checkpointNext(system.currentTick);
		if (!result.ok) console.error(`[xiaobo-fake-player] periodic checkpoint failed: ${result.error.message}`);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`[xiaobo-fake-player] periodic checkpoint tick crashed: ${message}`);
	}
}, 2);

system.runInterval(() => {
	if (startupStatus.state !== "ready") return;
	try {
		const result = lifecycle.autoRespawnNext();
		if (!result.ok) console.error(`[xiaobo-fake-player] auto respawn poll failed: ${result.error.message}`);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`[xiaobo-fake-player] periodic lifecycle tick crashed: ${message}`);
	}
}, 20);

system.runInterval(() => {
	if (startupStatus.state !== "ready") return;
	try {
		const result = behavior.tick(system.currentTick);
		if (!result.ok) console.error(`[xiaobo-fake-player] behavior tick failed: ${result.error.message}`);
		else {
			if (result.value.mineDiagnostic !== undefined && system.currentTick >= nextMineDiagnosticTick) {
				console.info(
					`[xiaobo-fake-player] mine diagnostic; tick=${system.currentTick}; `
					+ `considered=${result.value.consideredTasks}; attempted=${result.value.attemptedActions}; `
					+ `accepted=${result.value.acceptedActions}; blockReads=${result.value.blockReads}; `
					+ result.value.mineDiagnostic,
				);
				nextMineDiagnosticTick = system.currentTick + 200;
			}
			if (result.value.placeDiagnostic !== undefined && system.currentTick >= nextPlaceDiagnosticTick) {
				console.info(
					`[xiaobo-fake-player] place diagnostic; tick=${system.currentTick}; `
					+ `considered=${result.value.consideredTasks}; attempted=${result.value.attemptedActions}; `
					+ `accepted=${result.value.acceptedActions}; blockReads=${result.value.blockReads}; `
					+ result.value.placeDiagnostic,
				);
				nextPlaceDiagnosticTick = system.currentTick + 200;
			}
		}
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		console.error(`[xiaobo-fake-player] behavior tick crashed: ${message}`);
	}
});