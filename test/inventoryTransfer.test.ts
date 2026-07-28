import assert from "node:assert/strict";
import test from "node:test";

import { InventoryService, snapshotId } from "../src/application/inventoryService.js";
import { OperationCoordinator } from "../src/application/operationCoordinator.js";
import type {
    FakePlayerRuntime,
    InventoryAccess,
    InventoryImageState,
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
    ExperienceTransfer,
    FakePlayerId,
    FakePlayerRecord,
    InventoryTransfer,
    PendingOperations,
    PermissionTable,
    SavedLocation,
    WorldCatalog,
} from "../src/domain/model.js";
import { err, ok, type Result } from "../src/domain/results.js";

class MemoryStateStore implements WorldStateStore {
    public catalogRevision = 0;
    public operationsRevision = 0;
    public operations: PendingOperations = { workspace: {}, inventoryTransfers: {}, experienceTransfers: {} };

    public constructor(public catalog: WorldCatalog) {}

    public loadCatalog() {
        return loaded(this.catalog, this.catalogRevision);
    }

    public loadPermissions() {
        return loaded<PermissionTable>({ grants: {} }, 0);
    }

    public loadOperations() {
        return loaded(this.operations, this.operationsRevision);
    }

    public commitCatalog(expectedRevision: number, value: WorldCatalog): Result<VersionedState<WorldCatalog>> {
        if (expectedRevision !== this.catalogRevision) return err("STALE_REVISION", "stale catalog");
        this.catalog = value;
        this.catalogRevision += 1;
        return ok({ value, revision: this.catalogRevision, recovered: false, diagnostics: [] });
    }

    public commitPermissions(): Result<VersionedState<PermissionTable>> {
        return err("INVALID_STATE", "unused");
    }

    public commitOperations(
        expectedRevision: number,
        value: PendingOperations,
    ): Result<VersionedState<PendingOperations>> {
        if (expectedRevision !== this.operationsRevision) return err("STALE_REVISION", "stale operations");
        this.operations = value;
        this.operationsRevision += 1;
        return ok({ value, revision: this.operationsRevision, recovered: false, diagnostics: [] });
    }
}

class MemorySnapshots implements InventorySnapshotStore {
    public readonly ids = new Set<string>();

    public save(fakePlayerId: FakePlayerId, revision: number): Result<string> {
        const id = snapshotId(fakePlayerId, revision);
        this.ids.add(id);
        return ok(id);
    }

    public restore(): Result<void> {
        return ok(undefined);
    }

    public remove(structureId: string): Result<void> {
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

class MemoryInventoryAccess implements InventoryAccess {
    public readonly states = new Map<string, InventoryImageState>();
    public readonly playerExperience = new Map<string, number>();
    public overviewReadCount = 0;
    public applyAfterCount = 0;
    public experienceWriteCount = 0;

    public constructor(private readonly snapshots: MemorySnapshots) {}

    public readSnapshotOverview(structureId: string): Result<readonly {
        readonly slot: number;
        readonly item: null | {
            readonly typeId: string;
            readonly amount: number;
            readonly nameTag: string | null;
            readonly lore: readonly string[];
            readonly durability: null;
            readonly enchantments: readonly [];
        };
    }[]> {
        this.overviewReadCount += 1;
        if (!this.snapshots.has(structureId)) return err("NOT_FOUND", "snapshot missing");
        return ok(Array.from({ length: 41 }, (_, slot) => ({
            slot,
            item: slot === 0 ? {
                typeId: "minecraft:diamond_pickaxe",
                amount: 1,
                nameTag: "Miner",
                lore: ["trusted snapshot"],
                durability: null,
                enchantments: [],
            } : null,
        })));
    }

    public prepareTransfer(transfer: InventoryTransfer): Result<void> {
        this.snapshots.ids.add(transfer.fakeAfterSnapshotId);
        this.states.set(transfer.id, "before");
        return ok(undefined);
    }

    public compareWithImages(transfer: InventoryTransfer): Result<InventoryImageState> {
        return ok(this.states.get(transfer.id) ?? "before");
    }

    public applyBeforeImage(transfer: InventoryTransfer): Result<void> {
        this.states.set(transfer.id, "before");
        return ok(undefined);
    }

    public applyAfterImage(transfer: InventoryTransfer): Result<void> {
        this.applyAfterCount += 1;
        this.states.set(transfer.id, "after");
        return ok(undefined);
    }

    public removeTransferImages(): Result<void> {
        return ok(undefined);
    }

    public getPlayerExperience(playerId: string): Result<number> {
        return ok(this.playerExperience.get(playerId) ?? 0);
    }

    public setPlayerExperience(playerId: string, totalExperience: number): Result<void> {
        this.experienceWriteCount += 1;
        this.playerExperience.set(playerId, totalExperience);
        return ok(undefined);
    }

    public compareExperience(transfer: ExperienceTransfer): Result<InventoryImageState> {
        const current = this.playerExperience.get(transfer.playerId) ?? 0;
        if (current === transfer.playerBefore) return ok("before");
        if (current === transfer.playerBefore + transfer.amount) return ok("after");
        return ok("conflict");
    }
}

class UnusedRuntime implements FakePlayerRuntime {
    public capturePlayerSkin() {
        return undefined;
    }

    public spawn(_request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        throw new Error("unused");
    }

    public disconnect(): boolean {
        return false;
    }

    public respawn(_id: FakePlayerId, _location?: SavedLocation): boolean {
        return false;
    }

    public perform(_id: FakePlayerId, _action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        return { accepted: false };
    }

    public get(): RuntimeFakePlayer | undefined {
        return undefined;
    }

    public listTagged(): readonly RuntimeFakePlayer[] {
        return [];
    }
}

function createFixture() {
    const record: FakePlayerRecord = {
        id: "fp0001",
        name: "Alex",
        ownerId: "owner",
        recordRevision: 4,
        lifecycle: { kind: "offline" },
        expectedOnline: false,
        location: {
            dimension: "minecraft:overworld",
            position: { x: 0, y: 64, z: 0 },
            rotation: { x: 0, y: 0 },
        },
        gameMode: "survival",
        skin: { kind: "default" },
        selectedSlot: 0,
        totalExperience: 20,
        respawnMode: "manual",
        respawnLocation: null,
        inventoryRevision: 1,
        lastCheckpointTick: 10,
        behavior: createDefaultBehaviorConfig(),
    };
    const state = new MemoryStateStore({ nextId: 2, records: { [record.id]: record } });
    const snapshots = new MemorySnapshots();
    snapshots.ids.add(snapshotId(record.id, 1));
    const access = new MemoryInventoryAccess(snapshots);
    const service = new InventoryService(
        state,
        new UnusedRuntime(),
        snapshots,
        new OperationCoordinator(),
        access,
    );
    return { access, record, service, snapshots, state };
}

test("inventory transfer commits the after snapshot before removing the old authority", () => {
    const fixture = createFixture();

    const result = fixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
        { kind: "recycle_all" },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recordRevision, 5);
    assert.equal(result.value.inventoryRevision, 2);
    assert.equal(fixture.access.applyAfterCount, 1);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 1)), false);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 2)), true);
    assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
});

test("inventory overview reads the authoritative offline snapshot after revision validation", () => {
    const fixture = createFixture();

    const result = fixture.service.getOverview(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.inventoryRevision, 1);
    assert.equal(result.value.totalExperience, 20);
    assert.equal(result.value.slots.length, 41);
    assert.equal(result.value.slots[0]?.item?.typeId, "minecraft:diamond_pickaxe");
    assert.equal(fixture.access.overviewReadCount, 1);
});

test("inventory overview rejects stale or online records before reading a snapshot", () => {
    const fixture = createFixture();
    const actor = { playerId: "owner", isOperator: true };

    const stale = fixture.service.getOverview(actor, fixture.record.id, fixture.record.recordRevision - 1);
    assert.deepEqual(stale, {
        ok: false,
        error: {
            code: "STALE_REVISION",
            message: "期望 revision 3，实际为 4。",
        },
    });
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: { ...fixture.record, lifecycle: { kind: "online" } },
        },
    };
    const online = fixture.service.getOverview(actor, fixture.record.id, fixture.record.recordRevision);
    assert.equal(online.ok, false);
    if (!online.ok) assert.equal(online.error.code, "INVALID_STATE");
    assert.equal(fixture.access.overviewReadCount, 0);
});

test("inventory transfer rejects invalid slots before creating a pending operation", () => {
    const fixture = createFixture();

    const result = fixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
        { kind: "swap_fake", firstSlot: Number.NaN, secondSlot: 41 },
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_SLOT");
    assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
    assert.equal(fixture.access.applyAfterCount, 0);
});

test("recovery completes an applying transfer whose player and catalog already match after", () => {
    const fixture = createFixture();
    const transfer = inventoryTransfer("applying");
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: {
                ...fixture.record,
                recordRevision: 5,
                inventoryRevision: 2,
            },
        },
    };
    fixture.state.operations = {
        ...fixture.state.operations,
        inventoryTransfers: { [transfer.id]: transfer },
    };
    fixture.snapshots.ids.add(transfer.fakeAfterSnapshotId);
    fixture.access.states.set(transfer.id, "after");

    const result = fixture.service.recoverPendingTransfers();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recovered, 1);
    assert.equal(fixture.access.applyAfterCount, 0);
    assert.equal(fixture.snapshots.has(transfer.fakeSnapshotId), false);
    assert.equal(fixture.snapshots.has(transfer.fakeAfterSnapshotId), true);
    assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
});

test("mixed inventory recovery remains pending without changing catalog or snapshots", () => {
    const fixture = createFixture();
    const transfer = inventoryTransfer("applying");
    fixture.state.operations = {
        ...fixture.state.operations,
        inventoryTransfers: { [transfer.id]: transfer },
    };
    fixture.snapshots.ids.add(transfer.fakeAfterSnapshotId);
    fixture.access.states.set(transfer.id, "mixed");

    const result = fixture.service.recoverPendingTransfers();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recovered, 0);
    assert.match(result.value.diagnostics[0] ?? "", /mixed/);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.recordRevision, 4);
    assert.equal(fixture.snapshots.has(transfer.fakeSnapshotId), true);
    assert.equal(fixture.snapshots.has(transfer.fakeAfterSnapshotId), true);
    assert.equal(fixture.state.operations.inventoryTransfers[transfer.id]?.phase, "applying");
});

test("only operators can list and retry pending transfers", () => {
    const fixture = createFixture();
    const transfer = inventoryTransfer("applying");
    fixture.state.operations = {
        ...fixture.state.operations,
        inventoryTransfers: { [transfer.id]: transfer },
    };
    fixture.snapshots.ids.add(transfer.fakeAfterSnapshotId);
    fixture.access.states.set(transfer.id, "mixed");

    const denied = fixture.service.listPendingTransfers({ playerId: "owner", isOperator: false });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");
    const listed = fixture.service.listPendingTransfers({ playerId: "operator", isOperator: true });
    assert.deepEqual(listed, {
        ok: true,
        value: [{
            id: transfer.id,
            kind: "inventory",
            fakePlayerId: transfer.fakePlayerId,
            playerId: transfer.playerId,
            phase: "applying",
        }],
    });
    const retry = fixture.service.retryPendingTransfer({ playerId: "owner", isOperator: false }, transfer.id);
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.error.code, "PERMISSION_DENIED");
});

test("experience recovery does not add experience twice after player and catalog match after", () => {
    const fixture = createFixture();
    const transfer: ExperienceTransfer = {
        id: "fp0001:experience:4",
        fakePlayerId: "fp0001",
        playerId: "owner",
        fakePlayerRevision: 4,
        kind: "fake_to_player",
        fakePlayerBefore: 20,
        playerBefore: 10,
        amount: 7,
        phase: "applying",
    };
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: {
                ...fixture.record,
                recordRevision: 5,
                totalExperience: 13,
            },
        },
    };
    fixture.state.operations = {
        ...fixture.state.operations,
        experienceTransfers: { [transfer.id]: transfer },
    };
    fixture.access.playerExperience.set("owner", 17);

    const result = fixture.service.recoverPendingTransfers();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recovered, 1);
    assert.equal(fixture.access.experienceWriteCount, 0);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.totalExperience, 13);
    assert.deepEqual(fixture.state.operations.experienceTransfers, {});
});

function inventoryTransfer(phase: InventoryTransfer["phase"]): InventoryTransfer {
    return {
        id: "fp0001:inventory:4",
        fakePlayerId: "fp0001",
        playerId: "owner",
        fakePlayerRevision: 4,
        fakeSnapshotId: snapshotId("fp0001", 1),
        fakeAfterSnapshotId: snapshotId("fp0001", 2),
        request: { kind: "recycle_all" },
        beforeStructureId: "xiaobo:fp0001_tx_4_before",
        afterStructureId: "xiaobo:fp0001_tx_4_after",
        phase,
    };
}

function loaded<T>(value: T, revision: number) {
    return {
        ok: true as const,
        state: { value, revision, recovered: false, diagnostics: [] },
    };
}
