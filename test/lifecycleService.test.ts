import assert from "node:assert/strict";
import test from "node:test";

import { InventoryService, snapshotId } from "../src/application/inventoryService.js";
import { LifecycleService } from "../src/application/lifecycleService.js";
import { OperationCoordinator } from "../src/application/operationCoordinator.js";
import { RecoveryRunner } from "../src/application/recoveryRunner.js";
import type {
    FakePlayerRuntime,
    InventoryAccess,
    InventoryImageState,
    InventorySnapshotStore,
    RuntimeActionReceipt,
    RuntimeFakePlayer,
    RuntimeFakePlayerAction,
    SpawnFakePlayerRequest,
} from "../src/application/ports.js";
import type {
    ExperienceTransfer,
    FakePlayerId,
    FakePlayerSkin,
    InventoryTransfer,
    LifecycleOperation,
    SavedLocation,
} from "../src/domain/model.js";
import { err, ok, type Result } from "../src/domain/results.js";
import type { StringPropertyBackend } from "../src/infrastructure/state/bankedJsonStore.js";
import { BankedWorldStateStore } from "../src/infrastructure/state/bankedWorldStateStore.js";

class MemoryBackend implements StringPropertyBackend {
    private readonly values = new Map<string, string>();
    public failCatalogPointerSetAfter: number | undefined;

    public get(key: string): string | undefined {
        return this.values.get(key);
    }

    public set(key: string, value: string): void {
        if (key.endsWith(":catalog:active") && this.failCatalogPointerSetAfter !== undefined) {
            this.failCatalogPointerSetAfter -= 1;
            if (this.failCatalogPointerSetAfter === 0) {
                this.failCatalogPointerSetAfter = undefined;
                throw new Error("injected catalog pointer failure");
            }
        }
        this.values.set(key, value);
    }
}

class MemoryRuntime implements FakePlayerRuntime {
    public readonly players = new Map<FakePlayerId, RuntimeFakePlayer>();
    public failSpawn = false;
    public spawnCount = 0;
    public capturedSkin: FakePlayerSkin | undefined;
    public readonly spawnRequests: SpawnFakePlayerRequest[] = [];

    public capturePlayerSkin() {
        return this.capturedSkin;
    }

    public spawn(request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        if (this.failSpawn) throw new Error("injected spawn failure");
        this.spawnRequests.push(request);
        const player: RuntimeFakePlayer = {
            id: request.id,
            name: request.name,
            dimension: request.dimension,
            position: request.position,
            headPosition: { x: request.position.x, y: request.position.y + 1.62, z: request.position.z },
            rotation: request.rotation,
            gameMode: request.gameMode,
            isSneaking: false,
            selectedSlot: request.selectedSlot,
            totalExperience: request.totalExperience,
            alive: true,
        };
        this.players.set(request.id, player);
        this.spawnCount += 1;
        return player;
    }

    public disconnect(id: FakePlayerId): boolean {
        return this.players.delete(id);
    }

    public respawn(id: FakePlayerId, location?: SavedLocation): boolean {
        const player = this.players.get(id);
        if (player === undefined) return false;
        this.players.set(id, {
            ...player,
            alive: true,
            ...(location === undefined ? {} : {
                dimension: location.dimension,
                position: location.position,
                rotation: location.rotation,
            }),
        });
        return true;
    }

    public resolveInventorySlot() {
        return undefined;
    }

    public perform(_id: FakePlayerId, _action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        return { accepted: true };
    }

    public get(id: FakePlayerId): RuntimeFakePlayer | undefined {
        return this.players.get(id);
    }

    public listTagged(): readonly RuntimeFakePlayer[] {
        return [...this.players.values()];
    }
}

class MemorySnapshots implements InventorySnapshotStore {
    public readonly saved = new Set<string>();
    public failSave = false;
    public failRestore = false;
    public saveCount = 0;
    public restoreCount = 0;

    public save(fakePlayerId: FakePlayerId, revision: number): Result<string> {
        if (this.failSave) return err("CONFLICT", "injected snapshot failure");
        const id = snapshotId(fakePlayerId, revision);
        this.saved.add(id);
        this.saveCount += 1;
        return ok(id);
    }

    public restore(_fakePlayerId: FakePlayerId, structureId: string): Result<void> {
        this.restoreCount += 1;
        if (this.failRestore) return err("CONFLICT", "injected restore failure");
        return this.saved.has(structureId) ? ok(undefined) : err("NOT_FOUND", "snapshot missing");
    }

    public remove(structureId: string): Result<void> {
        this.saved.delete(structureId);
        return ok(undefined);
    }

    public has(structureId: string): boolean {
        return this.saved.has(structureId);
    }

    public recoverWorkspaces(): Result<void> {
        return ok(undefined);
    }
}

class MemoryInventoryAccess implements InventoryAccess {
    public readLiveOverview() {
        return ok([]);
    }

    public getPlayerMainhandItemTypeId() {
        return ok(null);
    }

    public readonly states = new Map<string, InventoryImageState>();
    public readonly playerExperience = new Map<string, number>();

    public constructor(private readonly snapshots: MemorySnapshots) {}

    public readSnapshotOverview(): Result<readonly []> {
        return ok([]);
    }

    public prepareTransfer(transfer: InventoryTransfer): Result<void> {
        this.snapshots.saved.add(transfer.fakeAfterSnapshotId);
        this.states.set(transfer.id, "before");
        return ok(undefined);
    }

    public compareWithImages(transfer: InventoryTransfer): Result<InventoryImageState> {
        return ok(this.states.get(transfer.id) ?? "before");
    }

    public compareFakeWithImages(transfer: InventoryTransfer): Result<InventoryImageState> {
        return ok(this.states.get(`fake:${transfer.id}`) ?? "before");
    }

    public applyBeforeImage(transfer: InventoryTransfer): Result<void> {
        this.states.set(transfer.id, "before");
        return ok(undefined);
    }

    public applyAfterImage(transfer: InventoryTransfer): Result<void> {
        this.states.set(transfer.id, "after");
        return ok(undefined);
    }

    public applyFakeAfterImage(transfer: InventoryTransfer): Result<void> {
        this.states.set(`fake:${transfer.id}`, "after");
        return ok(undefined);
    }

    public removeTransferImages(): Result<void> {
        return ok(undefined);
    }

    public getPlayerExperience(playerId: string): Result<number> {
        return ok(this.playerExperience.get(playerId) ?? 0);
    }

    public setPlayerExperience(playerId: string, totalExperience: number): Result<void> {
        this.playerExperience.set(playerId, totalExperience);
        return ok(undefined);
    }

    public getFakePlayerExperience(fakePlayerId: FakePlayerId): Result<number> {
        return ok(this.playerExperience.get(`fake:${fakePlayerId}`) ?? 0);
    }

    public setFakePlayerExperience(fakePlayerId: FakePlayerId, totalExperience: number): Result<void> {
        this.playerExperience.set(`fake:${fakePlayerId}`, totalExperience);
        return ok(undefined);
    }

    public compareExperience(transfer: ExperienceTransfer): Result<InventoryImageState> {
        const current = this.playerExperience.get(transfer.playerId) ?? 0;
        if (current === transfer.playerBefore) return ok("before");
        if (current === transfer.playerBefore + transfer.amount) return ok("after");
        return ok("conflict");
    }
}

function createFixture() {
    const backend = new MemoryBackend();
    const state = new BankedWorldStateStore(backend, "test");
    const runtime = new MemoryRuntime();
    const snapshots = new MemorySnapshots();
    const coordinator = new OperationCoordinator();
    const inventoryAccess = new MemoryInventoryAccess(snapshots);
    const inventory = new InventoryService(
        state,
        runtime,
        snapshots,
        coordinator,
        inventoryAccess,
    );
    const service = new LifecycleService(state, runtime, snapshots, coordinator, inventory);
    return { backend, state, runtime, snapshots, coordinator, inventory, inventoryAccess, service };
}

const createRequest = {
    requestedName: "Alex",
    location: {
        dimension: "minecraft:overworld",
        position: { x: 1, y: 64, z: 2 },
        rotation: { x: 10, y: 20 },
    },
    gameMode: "survival" as const,
    skinMode: "default" as const,
    unavailablePlayerNames: [] as string[],
};

const operator = { playerId: "playfab-owner", isOperator: true };

test("create, offline, and online commit recoverable lifecycle states", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.id, "fp0001");
    assert.equal(created.value.lifecycle.kind, "online");
    assert.equal(created.value.recordRevision, 2);

    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    assert.equal(offline.value.lifecycle.kind, "offline");
    assert.equal(offline.value.inventoryRevision, 1);
    assert.equal(fixture.runtime.players.has(created.value.id), false);

    const online = fixture.service.bringOnline(operator, offline.value.id, offline.value.recordRevision);
    assert.equal(online.ok, true);
    if (online.ok) {
        assert.equal(online.value.lifecycle.kind, "online");
        assert.equal(online.value.recordRevision, 7);
        assert.equal(fixture.runtime.players.has(created.value.id), true);
    }
});

test("copied Persona skin persists and is reused when the fake player returns online", () => {
    const fixture = createFixture();
    const skin: FakePlayerSkin = {
        kind: "persona",
        armSize: "Slim",
        personaPieces: [{
            id: "hair",
            packId: "pack",
            productId: "product",
            type: "Hair",
        }],
        skinColor: { red: 0.25, green: 0.5, blue: 0.75 },
    };
    fixture.runtime.capturedSkin = skin;
    const created = fixture.service.create(operator, { ...createRequest, skinMode: "copy_actor" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(created.value.skin, skin);
    assert.deepEqual(fixture.runtime.spawnRequests[0]?.skin, skin);

    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    const online = fixture.service.bringOnline(operator, offline.value.id, offline.value.recordRevision);
    assert.equal(online.ok, true);
    assert.deepEqual(fixture.runtime.spawnRequests[1]?.skin, skin);
});

test("spawn failure leaves provisioning state and releases the operation lease", () => {
    const fixture = createFixture();
    fixture.runtime.failSpawn = true;

    assert.throws(() => fixture.service.create(operator, createRequest), /injected spawn failure/);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
        assert.equal(loaded.state.value.records.fp0001?.lifecycle.kind, "provisioning");
        assert.equal(loaded.state.value.records.fp0001?.expectedOnline, true);
    }
    assert.equal(fixture.coordinator.tryAcquire(["fake:fp0001"]).ok, true);
});

test("snapshot failure leaves an online entity with snapshotting recovery intent", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    fixture.snapshots.failSave = true;

    const result = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(result.ok, false);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
        const record = loaded.state.value.records[created.value.id];
        assert.equal(record?.lifecycle.kind, "snapshotting");
        assert.equal(record?.expectedOnline, false);
    }
    assert.equal(fixture.runtime.players.has(created.value.id), true);
});

test("bring online removes the spawned fake player when no inventory snapshot can be restored", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok || offline.value.inventoryRevision === null) return;
    fixture.snapshots.remove(snapshotId(offline.value.id, offline.value.inventoryRevision));

    const result = fixture.service.bringOnline(operator, offline.value.id, offline.value.recordRevision);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "NOT_FOUND");
    assert.equal(fixture.runtime.get(offline.value.id), undefined);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.state.value.records[offline.value.id]?.lifecycle.kind, "restoring");
});

test("recovery removes the spawned fake player when a pending restore has no safe snapshot", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok || offline.value.inventoryRevision === null) return;
    fixture.snapshots.remove(snapshotId(offline.value.id, offline.value.inventoryRevision));
    assert.equal(fixture.service.bringOnline(operator, offline.value.id, offline.value.recordRevision).ok, false);
    fixture.runtime.players.delete(offline.value.id);
    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );

    const result = recovery.run();

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "NOT_FOUND");
    assert.equal(fixture.runtime.get(offline.value.id), undefined);
});

test("operation coordinator sorts, deduplicates, and releases resource keys", () => {
    const coordinator = new OperationCoordinator();
    const first = coordinator.tryAcquire(["player:b", "fake:a", "fake:a"]);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.value.keys, ["fake:a", "player:b"]);
    assert.equal(coordinator.tryAcquire(["fake:a"]).ok, false);
    first.value.release();
    first.value.release();
    assert.equal(coordinator.tryAcquire(["fake:a"]).ok, true);
});

test("recovery completes provisioning exactly once after a spawn interruption", () => {
    const fixture = createFixture();
    fixture.runtime.failSpawn = true;
    assert.throws(() => fixture.service.create(operator, createRequest), /injected spawn failure/);
    fixture.runtime.failSpawn = false;

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const first = recovery.run();
    assert.equal(first.ok, true);
    assert.equal(fixture.runtime.spawnCount, 1);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.state.value.records.fp0001?.lifecycle.kind, "online");

    const second = recovery.run();
    assert.equal(second.ok, true);
    assert.equal(fixture.runtime.spawnCount, 1);
});

test("recovery falls back to the previous snapshot after a forced exit loses the latest image", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const first = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 20);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = fixture.inventory.checkpoint(first.value.record.id, first.value.record.recordRevision, 40);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(fixture.snapshots.has(snapshotId(created.value.id, 1)), true);

    fixture.snapshots.remove(second.value.structureId);
    fixture.runtime.players.delete(created.value.id);
    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );

    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.diagnostics.join("; "), /上一代库存快照/);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
        const record = loaded.state.value.records[created.value.id];
        assert.equal(record?.lifecycle.kind, "online");
        assert.equal(record?.inventoryRevision, 1);
        assert.equal(record?.lastCheckpointTick, null);
    }
    assert.equal(fixture.runtime.get(created.value.id)?.alive, true);
});

test("recovery commits a verified snapshot without saving it twice", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    fixture.backend.failCatalogPointerSetAfter = 3;

    assert.throws(
        () => fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision),
        /injected catalog pointer failure/,
    );
    const interrupted = fixture.state.loadCatalog();
    assert.equal(interrupted.ok, true);
    if (interrupted.ok) {
        const record = interrupted.state.value.records[created.value.id];
        assert.equal(record?.lifecycle.kind, "snapshotting");
        assert.equal("operation" in (record?.lifecycle ?? {}) && record?.lifecycle.operation?.phase, "snapshot_verified:1");
    }
    assert.equal(fixture.snapshots.saveCount, 1);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.snapshots.saveCount, 1);
    assert.equal(fixture.runtime.players.has(created.value.id), false);
    const recovered = fixture.state.loadCatalog();
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.state.value.records[created.value.id]?.lifecycle.kind, "offline");
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.snapshots.saveCount, 1);
});

test("recovery completes snapshotting from the prior image when the verified structure was not persisted", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const checkpoint = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 20);
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) return;
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const operation: LifecycleOperation = {
        id: `${checkpoint.value.record.id}:offline:${checkpoint.value.record.recordRevision}`,
        kind: "offline",
        previous: "online",
        target: "offline",
        phase: "snapshot_verified:2",
    };
    const pending = {
        ...checkpoint.value.record,
        recordRevision: checkpoint.value.record.recordRevision + 1,
        lifecycle: { kind: "snapshotting" as const, operation },
        expectedOnline: false,
    };
    assert.equal(fixture.state.commitCatalog(loaded.state.revision, {
        ...loaded.state.value,
        records: { ...loaded.state.value.records, [pending.id]: pending },
    }).ok, true);
    assert.equal(fixture.snapshots.has(snapshotId(pending.id, 1)), true);
    assert.equal(fixture.snapshots.has(snapshotId(pending.id, 2)), false);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const recovered = fixture.state.loadCatalog();
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    const record = recovered.state.value.records[pending.id];
    assert.equal(record?.lifecycle.kind, "offline");
    assert.equal(record?.inventoryRevision, 1);
    assert.equal(record?.inventoryFallbackRevision, null);
    assert.equal(fixture.runtime.get(pending.id), undefined);
});

test("online rename checkpoints once and restores the same record under the new name", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const renamed = fixture.service.rename(operator, created.value.id, created.value.recordRevision, {
        requestedName: "Builder",
        unavailablePlayerNames: [],
    });
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal(renamed.value.name, "Builder");
    assert.equal(renamed.value.lifecycle.kind, "online");
    assert.equal(renamed.value.inventoryRevision, 1);
    assert.equal(fixture.runtime.players.get(created.value.id)?.name, "Builder");
    assert.equal(fixture.snapshots.saveCount, 1);
    assert.equal(fixture.snapshots.restoreCount, 1);
});

test("online rename removes its spawned target when inventory restore fails", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    fixture.snapshots.failRestore = true;

    const result = fixture.service.rename(operator, created.value.id, created.value.recordRevision, {
        requestedName: "Builder",
        unavailablePlayerNames: [],
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CONFLICT");
    assert.equal(fixture.runtime.get(created.value.id), undefined);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.state.value.records[created.value.id]?.lifecycle.kind, "renaming");
});

test("rename recovery removes its spawned target when inventory restore still fails", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    fixture.snapshots.failRestore = true;
    assert.equal(fixture.service.rename(operator, created.value.id, created.value.recordRevision, {
        requestedName: "Builder",
        unavailablePlayerNames: [],
    }).ok, false);
    fixture.runtime.players.delete(created.value.id);
    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );

    const result = recovery.run();

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CONFLICT");
    assert.equal(fixture.runtime.get(created.value.id), undefined);
});

test("offline rename changes the reserved name without spawning an entity", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;

    const renamed = fixture.service.rename(operator, offline.value.id, offline.value.recordRevision, {
        requestedName: "Storage",
        unavailablePlayerNames: [],
    });
    assert.equal(renamed.ok, true);
    if (!renamed.ok) return;
    assert.equal(renamed.value.name, "Storage");
    assert.equal(renamed.value.lifecycle.kind, "offline");
    assert.equal(fixture.runtime.players.has(created.value.id), false);
});

test("purge refuses online records then removes an offline record and its snapshot", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(fixture.service.purge(operator, created.value.id, created.value.recordRevision).ok, false);

    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    const structureId = snapshotId(offline.value.id, offline.value.inventoryRevision ?? 0);
    assert.equal(fixture.snapshots.has(structureId), true);

    const purged = fixture.service.purge(operator, offline.value.id, offline.value.recordRevision);
    assert.deepEqual(purged, { ok: true, value: { id: offline.value.id, name: offline.value.name } });
    assert.equal(fixture.snapshots.has(structureId), false);
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.state.value.records[offline.value.id], undefined);
});

test("recycle transfers inventory and experience before deleting the offline record", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const runtime = fixture.runtime.players.get(created.value.id);
    assert.notEqual(runtime, undefined);
    if (runtime === undefined) return;
    fixture.runtime.players.set(created.value.id, { ...runtime, totalExperience: 12 });
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;

    const recycled = fixture.service.recycle(operator, offline.value.id, offline.value.recordRevision);

    assert.deepEqual(recycled, { ok: true, value: { id: offline.value.id, name: offline.value.name } });
    assert.equal(fixture.inventoryAccess.playerExperience.get(operator.playerId), 12);
    const catalog = fixture.state.loadCatalog();
    assert.equal(catalog.ok, true);
    if (catalog.ok) assert.equal(catalog.state.value.records[offline.value.id], undefined);
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (operations.ok) {
        assert.deepEqual(operations.state.value.inventoryTransfers, {});
        assert.deepEqual(operations.state.value.experienceTransfers, {});
    }
    assert.equal(fixture.snapshots.saved.size, 0);
});

test("respawn snapshots post-death inventory without restoring the previous snapshot", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    const online = fixture.service.bringOnline(operator, offline.value.id, offline.value.recordRevision);
    assert.equal(online.ok, true);
    if (!online.ok) return;
    const runtime = fixture.runtime.players.get(online.value.id);
    assert.notEqual(runtime, undefined);
    if (runtime === undefined) return;
    fixture.runtime.players.set(online.value.id, { ...runtime, alive: false });
    const restoresBeforeRespawn = fixture.snapshots.restoreCount;

    const respawned = fixture.service.respawn(operator, online.value.id, online.value.recordRevision);
    assert.equal(respawned.ok, true);
    if (!respawned.ok) return;
    assert.equal(respawned.value.lifecycle.kind, "online");
    assert.equal(respawned.value.inventoryRevision, 2);
    assert.equal(fixture.runtime.players.get(online.value.id)?.alive, true);
    assert.equal(fixture.snapshots.restoreCount, restoresBeforeRespawn);
    assert.equal(fixture.snapshots.has(snapshotId(online.value.id, 2)), true);
});

test("health polling auto-respawns one dead player and ignores a delayed duplicate event", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const configured = fixture.service.setRespawnRule(
        operator,
        created.value.id,
        created.value.recordRevision,
        "death_location",
    );
    assert.equal(configured.ok, true);
    if (!configured.ok) return;
    const runtime = fixture.runtime.players.get(configured.value.id);
    assert.notEqual(runtime, undefined);
    if (runtime === undefined) return;
    fixture.runtime.players.set(configured.value.id, { ...runtime, alive: false });

    const respawned = fixture.service.autoRespawnNext();
    assert.equal(respawned.ok, true);
    if (!respawned.ok) return;
    assert.equal(respawned.value?.lifecycle.kind, "online");
    assert.equal(fixture.runtime.players.get(configured.value.id)?.alive, true);
    const savesAfterPoll = fixture.snapshots.saveCount;

    const duplicate = fixture.service.autoRespawn(configured.value.id);
    assert.deepEqual(duplicate, { ok: true, value: undefined });
    assert.equal(fixture.snapshots.saveCount, savesAfterPoll);
});

test("recovery finishes an online rename once", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const operation: LifecycleOperation = {
        id: `${offline.value.id}:rename:${offline.value.recordRevision}`,
        kind: "rename",
        previous: "offline",
        target: "online",
        phase: "prepared",
        previousName: offline.value.name,
        targetName: "RecoveredName",
    };
    const pending = {
        ...offline.value,
        name: "RecoveredName",
        recordRevision: offline.value.recordRevision + 1,
        lifecycle: { kind: "renaming" as const, operation },
        expectedOnline: true,
    };
    assert.equal(fixture.state.commitCatalog(loaded.state.revision, {
        ...loaded.state.value,
        records: { ...loaded.state.value.records, [pending.id]: pending },
    }).ok, true);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.runtime.spawnCount, 2);
    assert.equal(fixture.snapshots.restoreCount, 1);
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.runtime.spawnCount, 2);
    assert.equal(fixture.snapshots.restoreCount, 1);
    assert.equal(fixture.runtime.players.get(pending.id)?.name, "RecoveredName");
});

test("recovery removes a deleting record after its snapshot was already removed", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const offline = fixture.service.takeOffline(operator, created.value.id, created.value.recordRevision);
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const operation: LifecycleOperation = {
        id: `${offline.value.id}:delete:${offline.value.recordRevision}`,
        kind: "delete",
        previous: "offline",
        target: null,
        phase: "snapshot_removed",
    };
    const pending = {
        ...offline.value,
        recordRevision: offline.value.recordRevision + 1,
        lifecycle: { kind: "deleting" as const, operation },
        expectedOnline: false,
    };
    fixture.snapshots.remove(snapshotId(pending.id, pending.inventoryRevision ?? 0));
    assert.equal(fixture.state.commitCatalog(loaded.state.revision, {
        ...loaded.state.value,
        records: { ...loaded.state.value.records, [pending.id]: pending },
    }).ok, true);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    assert.equal(recovery.run().ok, true);
    assert.equal(recovery.run().ok, true);
    const recovered = fixture.state.loadCatalog();
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.state.value.records[pending.id], undefined);
});

test("recovery checkpoints a respawned inventory once without restoring the old image", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const loaded = fixture.state.loadCatalog();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const operation: LifecycleOperation = {
        id: `${created.value.id}:respawn:${created.value.recordRevision}`,
        kind: "respawn",
        previous: "online",
        target: "online",
        phase: "respawned",
    };
    const pending = {
        ...created.value,
        recordRevision: created.value.recordRevision + 1,
        lifecycle: { kind: "respawning" as const, operation },
        expectedOnline: true,
    };
    assert.equal(fixture.state.commitCatalog(loaded.state.revision, {
        ...loaded.state.value,
        records: { ...loaded.state.value.records, [pending.id]: pending },
    }).ok, true);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const restoresBefore = fixture.snapshots.restoreCount;
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.snapshots.saveCount, 1);
    assert.equal(fixture.snapshots.restoreCount, restoresBefore);
    assert.equal(recovery.run().ok, true);
    assert.equal(fixture.snapshots.saveCount, 1);
    assert.equal(fixture.snapshots.restoreCount, restoresBefore);
});

test("recovery preserves a conflicting transfer while its fake player remains online", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const transfer: InventoryTransfer = {
        id: `${created.value.id}:inventory:${created.value.recordRevision}`,
        fakePlayerId: created.value.id,
        playerId: operator.playerId,
        fakePlayerRevision: created.value.recordRevision,
        fakeSnapshotId: snapshotId(created.value.id, 1),
        fakeAfterSnapshotId: snapshotId(created.value.id, 2),
        request: { kind: "recycle_all" },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "applying",
    };
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        inventoryTransfers: { [transfer.id]: transfer },
    }).ok, true);
    fixture.inventoryAccess.states.set(transfer.id, "mixed");

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.diagnostics.join("; "), /mixed/);
    const remaining = fixture.state.loadOperations();
    assert.equal(remaining.ok, true);
    if (remaining.ok) assert.equal(remaining.state.value.inventoryTransfers[transfer.id]?.phase, "applying");
});

test("recovery rebuilds a missing online fake player before preserving its conflicting transfer", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const checkpoint = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 10);
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) return;
    const transfer: InventoryTransfer = {
        id: `${checkpoint.value.record.id}:inventory:${checkpoint.value.record.recordRevision}`,
        fakePlayerId: checkpoint.value.record.id,
        playerId: operator.playerId,
        fakePlayerRevision: checkpoint.value.record.recordRevision,
        fakeSnapshotId: checkpoint.value.structureId,
        fakeAfterSnapshotId: snapshotId(checkpoint.value.record.id, 2),
        request: { kind: "recycle_all" },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "applying",
    };
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        inventoryTransfers: { [transfer.id]: transfer },
    }).ok, true);
    fixture.inventoryAccess.states.set(transfer.id, "mixed");
    fixture.runtime.players.delete(created.value.id);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const restoresBefore = fixture.snapshots.restoreCount;
    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(fixture.runtime.get(created.value.id)?.alive, true);
    assert.equal(fixture.snapshots.restoreCount, restoresBefore + 1);
    assert.match(result.value.diagnostics.join("; "), /mixed/);
});

test("recovery does not spawn a pending inventory transfer without its exact snapshot", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const first = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 10);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = fixture.inventory.checkpoint(first.value.record.id, first.value.record.recordRevision, 30);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const transfer: InventoryTransfer = {
        id: `${second.value.record.id}:inventory:${second.value.record.recordRevision}`,
        fakePlayerId: second.value.record.id,
        playerId: operator.playerId,
        fakePlayerRevision: second.value.record.recordRevision,
        fakeSnapshotId: second.value.structureId,
        fakeAfterSnapshotId: snapshotId(second.value.record.id, 3),
        request: { kind: "recycle_all" },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "applying",
    };
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        inventoryTransfers: { [transfer.id]: transfer },
    }).ok, true);
    fixture.snapshots.remove(second.value.structureId);
    fixture.runtime.players.delete(created.value.id);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const restoresBefore = fixture.snapshots.restoreCount;
    const result = recovery.run();

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "NOT_FOUND");
    assert.equal(fixture.runtime.get(created.value.id), undefined);
    assert.equal(fixture.snapshots.restoreCount, restoresBefore);
    assert.equal(fixture.snapshots.has(snapshotId(created.value.id, 1)), true);
});

test("recovery uses the fallback inventory for a pending experience-only transfer", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const first = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 10);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = fixture.inventory.checkpoint(first.value.record.id, first.value.record.recordRevision, 30);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const catalog = fixture.state.loadCatalog();
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const pendingRecord = { ...second.value.record, totalExperience: 20 };
    assert.equal(fixture.state.commitCatalog(catalog.state.revision, {
        ...catalog.state.value,
        records: { ...catalog.state.value.records, [pendingRecord.id]: pendingRecord },
    }).ok, true);
    const transfer: ExperienceTransfer = {
        id: `${pendingRecord.id}:experience:${pendingRecord.recordRevision}`,
        fakePlayerId: pendingRecord.id,
        playerId: operator.playerId,
        fakePlayerRevision: pendingRecord.recordRevision,
        kind: "fake_to_player",
        fakePlayerBefore: 20,
        playerBefore: 10,
        amount: 7,
        phase: "applying",
    };
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        experienceTransfers: { [transfer.id]: transfer },
    }).ok, true);
    fixture.inventoryAccess.playerExperience.set(operator.playerId, transfer.playerBefore);
    fixture.inventoryAccess.playerExperience.set(`fake:${pendingRecord.id}`, transfer.fakePlayerBefore);
    fixture.snapshots.remove(second.value.structureId);
    fixture.runtime.players.delete(created.value.id);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(fixture.runtime.get(created.value.id)?.alive, true);
    assert.equal(fixture.inventoryAccess.playerExperience.get(operator.playerId), 17);
    assert.equal(fixture.inventoryAccess.playerExperience.get(`fake:${pendingRecord.id}`), 13);
    const recovered = fixture.state.loadCatalog();
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    const record = recovered.state.value.records[pendingRecord.id];
    assert.equal(record?.totalExperience, 13);
    assert.equal(record?.inventoryRevision, 2);
    assert.equal(record?.inventoryFallbackRevision, 1);
    const remaining = fixture.state.loadOperations();
    assert.equal(remaining.ok, true);
    if (remaining.ok) assert.deepEqual(remaining.state.value.experienceTransfers, {});
});

test("recovery rebuilds a missing online fake player from a committed after snapshot", () => {
    const fixture = createFixture();
    const created = fixture.service.create(operator, createRequest);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const checkpoint = fixture.inventory.checkpoint(created.value.id, created.value.recordRevision, 10);
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) return;
    const transfer: InventoryTransfer = {
        id: `${checkpoint.value.record.id}:inventory:${checkpoint.value.record.recordRevision}`,
        fakePlayerId: checkpoint.value.record.id,
        playerId: operator.playerId,
        fakePlayerRevision: checkpoint.value.record.recordRevision,
        fakeSnapshotId: checkpoint.value.structureId,
        fakeAfterSnapshotId: snapshotId(checkpoint.value.record.id, 2),
        request: { kind: "recycle_all" },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "committed",
    };
    fixture.snapshots.saved.add(transfer.fakeAfterSnapshotId);
    const catalog = fixture.state.loadCatalog();
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const committedRecord = {
        ...checkpoint.value.record,
        recordRevision: checkpoint.value.record.recordRevision + 1,
        inventoryRevision: 2,
    };
    assert.equal(fixture.state.commitCatalog(catalog.state.revision, {
        ...catalog.state.value,
        records: { ...catalog.state.value.records, [committedRecord.id]: committedRecord },
    }).ok, true);
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) return;
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        inventoryTransfers: { [transfer.id]: transfer },
    }).ok, true);
    fixture.inventoryAccess.states.set(transfer.id, "after");
    fixture.inventoryAccess.states.set(`fake:${transfer.id}`, "after");
    fixture.runtime.players.delete(created.value.id);

    const recovery = new RecoveryRunner(
        fixture.state,
        fixture.runtime,
        fixture.snapshots,
        fixture.coordinator,
        fixture.inventory,
    );
    const restoresBefore = fixture.snapshots.restoreCount;
    const result = recovery.run();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recoveredTransfers, 1);
    assert.equal(fixture.runtime.get(created.value.id)?.alive, true);
    assert.equal(fixture.snapshots.restoreCount, restoresBefore + 1);
    assert.equal(fixture.snapshots.has(transfer.fakeSnapshotId), false);
    assert.equal(fixture.snapshots.has(transfer.fakeAfterSnapshotId), true);
    const remaining = fixture.state.loadOperations();
    assert.equal(remaining.ok, true);
    if (remaining.ok) assert.deepEqual(remaining.state.value.inventoryTransfers, {});
    const recoveredCatalog = fixture.state.loadCatalog();
    assert.equal(recoveredCatalog.ok, true);
    if (recoveredCatalog.ok) {
        assert.equal(recoveredCatalog.state.value.records[created.value.id]?.recordRevision, 4);
        assert.equal(recoveredCatalog.state.value.records[created.value.id]?.inventoryRevision, 2);
    }
});