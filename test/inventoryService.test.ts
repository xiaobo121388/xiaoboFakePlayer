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

    public constructor(public catalog: WorldCatalog) {}

    public loadCatalog() {
        return loaded(this.catalog, this.catalogRevision);
    }

    public loadPermissions() {
        return loaded<PermissionTable>({ grants: {} }, 0);
    }

    public loadOperations() {
        return loaded<PendingOperations>({ workspace: {}, inventoryTransfers: {}, experienceTransfers: {} }, 0);
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
    public constructor(public player: RuntimeFakePlayer) {}

    public capturePlayerSkin() {
        return undefined;
    }

    public spawn(_request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        return this.player;
    }

    public disconnect(): boolean {
        return true;
    }

    public respawn(_id: FakePlayerId, _location?: SavedLocation): boolean {
        return true;
    }

    public perform(_id: FakePlayerId, _action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        return { accepted: true };
    }

    public get(id: FakePlayerId): RuntimeFakePlayer | undefined {
        return id === this.player.id ? this.player : undefined;
    }

    public listTagged(): readonly RuntimeFakePlayer[] {
        return [this.player];
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