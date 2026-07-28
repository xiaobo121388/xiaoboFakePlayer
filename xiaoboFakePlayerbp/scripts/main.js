import { system, world } from "@minecraft/server";
import { BehaviorService } from "./application/behaviorService.js";
import { InventoryService } from "./application/inventoryService.js";
import { LifecycleService } from "./application/lifecycleService.js";
import { OperationCoordinator } from "./application/operationCoordinator.js";
import { PermissionService } from "./application/permissionService.js";
import { RecoveryRunner } from "./application/recoveryRunner.js";
import { SapiFakePlayerRuntime } from "./infrastructure/sapi/fakePlayerRuntime.js";
import { SapiInventoryAccess } from "./infrastructure/sapi/inventoryAccess.js";
import { StructureInventorySnapshotStore } from "./infrastructure/sapi/structureInventorySnapshotStore.js";
import { SapiWorldQueries } from "./infrastructure/sapi/worldQueries.js";
import { BankedWorldStateStore } from "./infrastructure/state/bankedWorldStateStore.js";
import { SapiStringPropertyBackend } from "./infrastructure/state/sapiStringPropertyBackend.js";
import { registerCommands } from "./presentation/commands.js";
const stateStore = new BankedWorldStateStore(new SapiStringPropertyBackend());
const runtime = new SapiFakePlayerRuntime();
const coordinator = new OperationCoordinator();
const snapshots = new StructureInventorySnapshotStore(stateStore, runtime);
const inventoryAccess = new SapiInventoryAccess(snapshots);
const inventory = new InventoryService(stateStore, runtime, snapshots, coordinator, inventoryAccess);
const lifecycle = new LifecycleService(stateStore, runtime, snapshots, coordinator, inventory);
const behavior = new BehaviorService(stateStore, runtime, new SapiWorldQueries(runtime), coordinator, inventory);
const permissions = new PermissionService(stateStore);
const recovery = new RecoveryRunner(stateStore, runtime, snapshots, coordinator, inventory);
let startupStatus = { state: "recovering" };
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
    registerCommands(customCommandRegistry, {
        behavior,
        inventory,
        lifecycle,
        permissions,
        getStartupStatus: () => startupStatus,
    });
});
world.afterEvents.worldLoad.subscribe(() => {
    system.run(() => {
        try {
            const result = recovery.run();
            if (!result.ok) {
                startupStatus = { state: "blocked", message: result.error.message };
                console.error(`[xiaobo-fake-player] recovery blocked: ${result.error.message}`);
                return;
            }
            startupStatus = { state: "ready" };
            console.info(`[xiaobo-fake-player] ready; rebound=${result.value.reboundEntities}; `
                + `records=${result.value.recoveredRecords}; transfers=${result.value.recoveredTransfers}`);
            result.value.diagnostics.forEach((diagnostic) => console.warn(`[xiaobo-fake-player] ${diagnostic}`));
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            startupStatus = { state: "blocked", message };
            console.error(`[xiaobo-fake-player] recovery crashed: ${message}`);
        }
    });
});
world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    const tag = deadEntity.getTags().find((candidate) => /^xiaobo_fp_fp\d{4,}$/.test(candidate));
    if (tag === undefined)
        return;
    const id = tag.slice("xiaobo_fp_".length);
    system.runTimeout(() => {
        if (startupStatus.state !== "ready")
            return;
        try {
            const result = lifecycle.autoRespawn(id);
            if (!result.ok)
                console.error(`[xiaobo-fake-player] auto respawn ${id} failed: ${result.error.message}`);
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            console.error(`[xiaobo-fake-player] auto respawn ${id} crashed: ${message}`);
        }
    }, 20);
});
system.runInterval(() => {
    if (startupStatus.state !== "ready")
        return;
    try {
        const result = inventory.checkpointNext(system.currentTick);
        if (!result.ok)
            console.error(`[xiaobo-fake-player] periodic checkpoint failed: ${result.error.message}`);
        const respawned = lifecycle.autoRespawnNext();
        if (!respawned.ok)
            console.error(`[xiaobo-fake-player] auto respawn poll failed: ${respawned.error.message}`);
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[xiaobo-fake-player] periodic lifecycle tick crashed: ${message}`);
    }
}, 20);
system.runInterval(() => {
    if (startupStatus.state !== "ready")
        return;
    try {
        const result = behavior.tick(system.currentTick);
        if (!result.ok)
            console.error(`[xiaobo-fake-player] behavior tick failed: ${result.error.message}`);
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[xiaobo-fake-player] behavior tick crashed: ${message}`);
    }
});
