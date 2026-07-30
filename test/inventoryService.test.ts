import assert from "node:assert/strict";
import test from "node:test";

import { InventoryService, snapshotId } from "../src/application/inventoryService.js";
import { OperationCoordinator } from "../src/application/operationCoordinator.js";
import type {
    InventoryAccess,
    FakePlayerRuntime,
    InventorySnapshotStore,
    RuntimeActionReceipt,
    RuntimeFakePlayer,
    RuntimeFakePlayerAction,
    SpawnFakePlayerRequest,
    VersionedState,
    WorldStateStore,
} from "../src/application/ports.js";
import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import type {
    FakePlayerId,
    PendingOperations,
    PermissionTable,
    SavedLocation,
    WorldCatalog,
} from "../src/domain/model.js";
import { err, ok, type Result } from "../src/domain/results.js";

class MemoryStateStore implements WorldStateStore {
    public catalogRevision = 0;
    public failCatalogCommit = false;
    public operations: PendingOperations = { workspace: {}, inventoryTransfers: {}, experienceTransfers: {} };

    public constructor(public catalog: WorldCatalog) {}

    public loadCatalog() {
        return loaded(this.catalog, this.catalogRevision);
    }

    public loadPermissions() {
        return loaded<PermissionTable>({ grants: {} }, 0);
    }

    public loadOperations() {
        return loaded(this.operations, 0);
    }

    public commitCatalog(
        expectedRevision: number,
        value: WorldCatalog,
    ): Result<VersionedState<WorldCatalog>> {
        if (this.failCatalogCommit) return err("CONFLICT" as const, "injected catalog failure");
        if (expectedRevision !== this.catalogRevision) return err("STALE_REVISION" as const, "stale catalog");
        this.catalog = value;
        this.catalogRevision += 1;
        return ok({ value, revision: this.catalogRevision, recovered: false, diagnostics: [] });
    }

    public commitPermissions(
        _expectedRevision: number,
        _value: PermissionTable,
    ): Result<VersionedState<PermissionTable>> {
        return err("INVALID_STATE", "unused");
    }

    public commitOperations(
        _expectedRevision: number,
        _value: PendingOperations,
    ): Result<VersionedState<PendingOperations>> {
        return err("INVALID_STATE", "unused");
    }
}

class MemoryRuntime implements FakePlayerRuntime {
    public readonly players = new Map<FakePlayerId, RuntimeFakePlayer>();

    public constructor(player: RuntimeFakePlayer) {
        this.players.set(player.id, player);
    }

    public capturePlayerSkin() {
        return undefined;
    }

    public spawn(_request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        const player = this.players.values().next().value;
        if (player === undefined) throw new Error("memory runtime has no fake player");
        return player;
    }

    public disconnect(): boolean {
        return true;
    }

    public respawn(_id: FakePlayerId, _location?: SavedLocation): boolean {
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
    public readonly ids = new Set<string>();
    public readonly removals: string[] = [];

    public save(fakePlayerId: FakePlayerId, revision: number): Result<string> {
        const id = snapshotId(fakePlayerId, revision);
        this.ids.add(id);
        return ok(id);
    }

    public restore(): Result<void> {
        return ok(undefined);
    }

    public remove(structureId: string): Result<void> {
        this.removals.push(structureId);
        this.ids.delete(structureId);
        return ok(undefined);
    }

    public has(structureId: string): boolean {
        return this.ids.has(structureId);
    }

    public recoverWorkspaces(): Result<void> {
        return ok(undefined);
    }
}

const unusedInventoryAccess = {} as InventoryAccess;

function createFixture() {
    const record = {
        id: "fp0001",
        name: "Alex",
        ownerId: "owner",
        recordRevision: 4,
        lifecycle: { kind: "online" as const },
        expectedOnline: true,
        location: {
            dimension: "minecraft:overworld",
            position: { x: 0, y: 64, z: 0 },
            rotation: { x: 0, y: 0 },
        },
        gameMode: "survival" as const,
        skin: { kind: "default" as const },
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual" as const,
        respawnLocation: null,
        inventoryRevision: 1,
        lastCheckpointTick: 10,
        behavior: createDefaultBehaviorConfig(),
    };
    const state = new MemoryStateStore({ nextId: 2, records: { [record.id]: record } });
    const runtime = new MemoryRuntime({
        id: record.id,
        name: record.name,
        dimension: "minecraft:nether",
        position: { x: 3, y: 70, z: 4 },
        rotation: { x: 5, y: 90 },
        gameMode: "creative",
        isSneaking: false,
        selectedSlot: 2,
        totalExperience: 27,
        alive: true,
    });
    const snapshots = new MemorySnapshots();
    snapshots.ids.add(snapshotId(record.id, 1));
    const service = new InventoryService(
        state,
        runtime,
        snapshots,
        new OperationCoordinator(),
        unusedInventoryAccess,
    );
    return { record, state, runtime, snapshots, service };
}

test("checkpoint commits the verified image before removing the previous snapshot", () => {
    const fixture = createFixture();
    const result = fixture.service.checkpoint(fixture.record.id, 4, 40);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.structureId, snapshotId(fixture.record.id, 2));
    assert.equal(result.value.record.recordRevision, 5);
    assert.equal(result.value.record.inventoryRevision, 2);
    assert.equal(result.value.record.lastCheckpointTick, 40);
    assert.equal(result.value.record.location.dimension, "minecraft:nether");
    assert.deepEqual(fixture.snapshots.removals, [snapshotId(fixture.record.id, 1)]);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 2)), true);
});

test("checkpoint polling skips a clean fake player before its next periodic checkpoint", () => {
    const fixture = createFixture();

    const result = fixture.service.checkpointNext(20);

    assert.deepEqual(result, ok(undefined));
    assert.equal(fixture.state.catalogRevision, 0);
    assert.deepEqual(fixture.snapshots.removals, []);
});

test("checkpoint polling saves all ten online fake players once within twenty ticks", () => {
    const fixture = createFixture();
    const records = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
        const sequence = index + 1;
        const id = `fp${String(sequence).padStart(4, "0")}`;
        const record = {
            ...fixture.record,
            id,
            name: `Fake ${sequence}`,
            lastCheckpointTick: 0,
        };
        fixture.runtime.players.set(id, { ...fixture.runtime.players.get(fixture.record.id)!, id, name: record.name });
        fixture.snapshots.ids.add(snapshotId(id, 1));
        return [id, record];
    }));
    fixture.state.catalog = { nextId: 11, records };

    const checkpointedIds: FakePlayerId[] = [];
    for (let tick = 20; tick < 40; tick += 2) {
        const result = fixture.service.checkpointNext(tick);
        assert.equal(result.ok, true);
        if (result.ok && result.value !== undefined) checkpointedIds.push(result.value.record.id);
    }

    assert.deepEqual(checkpointedIds, Object.keys(records));
    assert.deepEqual(fixture.service.checkpointNext(39), ok(undefined));
    const nextSecond = fixture.service.checkpointNext(40);
    assert.equal(nextSecond.ok, true);
    if (nextSecond.ok) assert.equal(nextSecond.value?.record.id, "fp0001");
});

test("checkpoint polling skips fake players with pending transfers", () => {
    const fixture = createFixture();
    const transfer = {
        id: "fp0001:inventory:4",
        fakePlayerId: fixture.record.id,
        playerId: "owner",
        fakePlayerRevision: fixture.record.recordRevision,
        fakeSnapshotId: snapshotId(fixture.record.id, 1),
        fakeAfterSnapshotId: snapshotId(fixture.record.id, 2),
        request: { kind: "swap_inventory" as const },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "prepared" as const,
    };
    fixture.state.operations = {
        workspace: {},
        inventoryTransfers: { [transfer.id]: transfer },
        experienceTransfers: {},
    };

    assert.deepEqual(fixture.service.checkpointNext(40), ok(undefined));
    assert.equal(fixture.state.catalogRevision, 0);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 2)), false);
    assert.deepEqual(fixture.snapshots.removals, []);
});

test("world tick reset rebases the checkpoint once without continuous revision advances", () => {
    const fixture = createFixture();

    const rebased = fixture.service.checkpointNext(5);
    const nextPoll = fixture.service.checkpointNext(6);

    assert.equal(rebased.ok, true);
    if (rebased.ok) assert.equal(rebased.value?.record.lastCheckpointTick, 5);
    assert.deepEqual(nextPoll, ok(undefined));
    assert.equal(fixture.state.catalogRevision, 1);
});

test("catalog failure removes the unreferenced new image and preserves the authoritative snapshot", () => {
    const fixture = createFixture();
    fixture.state.failCatalogCommit = true;

    const result = fixture.service.checkpoint(fixture.record.id, 4, 40);

    assert.equal(result.ok, false);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 1)), true);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 2)), false);
    assert.deepEqual(fixture.snapshots.removals, [snapshotId(fixture.record.id, 2)]);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.inventoryRevision, 1);
});

function loaded<T>(value: T, revision: number) {
    return {
        ok: true as const,
        state: { value, revision, recovered: false, diagnostics: [] },
    };
}