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
    public readonly fakeStates = new Map<string, InventoryImageState>();
    public readonly playerExperience = new Map<string, number>();
    public readonly fakePlayerExperience = new Map<string, number>();
    public readonly preparedRequests: InventoryTransfer["request"][] = [];
    public overviewReadCount = 0;
    public liveOverviewReadCount = 0;
    public applyAfterCount = 0;
    public applyFakeAfterCount = 0;
    public experienceWriteCount = 0;
    public fakeExperienceWriteCount = 0;
    public playerMainhandItemTypeId: string | null = "minecraft:oak_log";

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

    public readLiveOverview(): Result<readonly {
        readonly slot: number;
        readonly item: null;
    }[]> {
        this.liveOverviewReadCount += 1;
        return ok(Array.from({ length: 41 }, (_, slot) => ({ slot, item: null })));
    }

    public getPlayerMainhandItemTypeId(): Result<string | null> {
        return ok(this.playerMainhandItemTypeId);
    }

    public prepareTransfer(transfer: InventoryTransfer): Result<void> {
        this.preparedRequests.push(transfer.request);
        this.snapshots.ids.add(transfer.fakeAfterSnapshotId);
        this.states.set(transfer.id, "before");
        this.fakeStates.set(transfer.id, "before");
        return ok(undefined);
    }

    public compareWithImages(transfer: InventoryTransfer): Result<InventoryImageState> {
        return ok(this.states.get(transfer.id) ?? "before");
    }

    public compareFakeWithImages(transfer: InventoryTransfer): Result<InventoryImageState> {
        return ok(this.fakeStates.get(transfer.id) ?? "before");
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

    public applyFakeAfterImage(transfer: InventoryTransfer): Result<void> {
        this.applyFakeAfterCount += 1;
        this.fakeStates.set(transfer.id, "after");
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

    public getFakePlayerExperience(fakePlayerId: FakePlayerId): Result<number> {
        return ok(this.fakePlayerExperience.get(fakePlayerId) ?? 0);
    }

    public setFakePlayerExperience(fakePlayerId: FakePlayerId, totalExperience: number): Result<void> {
        this.fakeExperienceWriteCount += 1;
        this.fakePlayerExperience.set(fakePlayerId, totalExperience);
        return ok(undefined);
    }

    public compareExperience(transfer: ExperienceTransfer): Result<InventoryImageState> {
        const current = this.playerExperience.get(transfer.playerId) ?? 0;
        if (current === transfer.playerBefore) return ok("before");
        if (current === transfer.playerBefore + transfer.amount) return ok("after");
        return ok("conflict");
    }
}

class MemoryRuntime implements FakePlayerRuntime {
    public current: RuntimeFakePlayer | undefined;

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

    public resolveInventorySlot() {
        return undefined;
    }

    public perform(_id: FakePlayerId, _action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        return { accepted: false };
    }

    public get(id: FakePlayerId): RuntimeFakePlayer | undefined {
        return this.current?.id === id ? this.current : undefined;
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
        inventoryFallbackRevision: null,
        lastCheckpointTick: 10,
        behavior: createDefaultBehaviorConfig(),
    };
    const state = new MemoryStateStore({ nextId: 2, records: { [record.id]: record } });
    const snapshots = new MemorySnapshots();
    snapshots.ids.add(snapshotId(record.id, 1));
    const access = new MemoryInventoryAccess(snapshots);
    const runtime = new MemoryRuntime();
    const service = new InventoryService(
        state,
        runtime,
        snapshots,
        new OperationCoordinator(),
        access,
    );
    return { access, record, runtime, service, snapshots, state };
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

test("inventory transfer removes a non-adjacent fallback after ownership changes", () => {
    const fixture = createFixture();
    const record: FakePlayerRecord = {
        ...fixture.record,
        inventoryRevision: 4,
        inventoryFallbackRevision: 1,
    };
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: { [record.id]: record },
    };
    fixture.snapshots.ids.add(snapshotId(record.id, 4));

    const result = fixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        record.id,
        record.recordRevision,
        { kind: "recycle_all" },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.inventoryRevision, 5);
    assert.equal(result.value.inventoryFallbackRevision, null);
    assert.equal(fixture.snapshots.has(snapshotId(record.id, 1)), false);
    assert.equal(fixture.snapshots.has(snapshotId(record.id, 4)), false);
    assert.equal(fixture.snapshots.has(snapshotId(record.id, 5)), true);
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

test("mainhand item lookup is authorized and preserves empty hand", () => {
    const fixture = createFixture();

    assert.deepEqual(fixture.service.getPlayerMainhandItemTypeId({
        playerId: "member",
        isOperator: false,
    }), {
        ok: false,
        error: {
            code: "PERMISSION_DENIED",
            message: "你没有管理假人背包或经验的权限。",
        },
    });
    assert.deepEqual(fixture.service.getPlayerMainhandItemTypeId({
        playerId: "owner",
        isOperator: true,
    }), ok("minecraft:oak_log"));
    fixture.access.playerMainhandItemTypeId = null;
    assert.deepEqual(fixture.service.getPlayerMainhandItemTypeId({
        playerId: "owner",
        isOperator: true,
    }), ok(null));
});

test("inventory overview rejects a stale record before reading an inventory", () => {
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
    assert.equal(fixture.access.overviewReadCount, 0);
    assert.equal(fixture.access.liveOverviewReadCount, 0);
});

test("inventory overview reads the live inventory while the fake player is online", () => {
    const fixture = createFixture();
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: { ...fixture.record, lifecycle: { kind: "online" } },
        },
    };
    fixture.runtime.current = {
        id: fixture.record.id,
        name: fixture.record.name,
        dimension: fixture.record.location.dimension,
        position: fixture.record.location.position,
        headPosition: { ...fixture.record.location.position, y: fixture.record.location.position.y + 1.62 },
        rotation: fixture.record.location.rotation,
        gameMode: fixture.record.gameMode,
        isSneaking: false,
        selectedSlot: 3,
        totalExperience: 27,
        alive: true,
    };

    const online = fixture.service.getOverview(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
    );

    assert.equal(online.ok, true);
    if (!online.ok) return;
    assert.equal(online.value.selectedSlot, 3);
    assert.equal(online.value.totalExperience, 27);
    assert.equal(online.value.slots.length, 41);
    assert.equal(fixture.access.liveOverviewReadCount, 1);
    assert.equal(fixture.access.overviewReadCount, 0);
});

test("online inventory transfer checkpoints and writes the after image to the live fake player", () => {
    const fixture = createFixture();
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: {
                ...fixture.record,
                lifecycle: { kind: "online" },
                expectedOnline: true,
            },
        },
    };
    fixture.runtime.current = {
        id: fixture.record.id,
        name: fixture.record.name,
        dimension: fixture.record.location.dimension,
        position: fixture.record.location.position,
        headPosition: { ...fixture.record.location.position, y: fixture.record.location.position.y + 1.62 },
        rotation: fixture.record.location.rotation,
        gameMode: fixture.record.gameMode,
        isSneaking: false,
        selectedSlot: fixture.record.selectedSlot,
        totalExperience: fixture.record.totalExperience,
        alive: true,
    };

    const result = fixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
        { kind: "swap", fakeSlot: 0, playerSlot: 0 },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.lifecycle.kind, "online");
    assert.equal(result.value.recordRevision, 6);
    assert.equal(result.value.inventoryRevision, 3);
    assert.equal(fixture.access.applyAfterCount, 1);
    assert.equal(fixture.access.applyFakeAfterCount, 1);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 1)), false);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 2)), false);
    assert.equal(fixture.snapshots.has(snapshotId(fixture.record.id, 3)), true);
    assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
});

test("online experience transfer updates the live fake player and catalog exactly once", () => {
    const fixture = createFixture();
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: {
            [fixture.record.id]: {
                ...fixture.record,
                lifecycle: { kind: "online" },
                expectedOnline: true,
            },
        },
    };
    fixture.runtime.current = {
        id: fixture.record.id,
        name: fixture.record.name,
        dimension: fixture.record.location.dimension,
        position: fixture.record.location.position,
        headPosition: { ...fixture.record.location.position, y: fixture.record.location.position.y + 1.62 },
        rotation: fixture.record.location.rotation,
        gameMode: fixture.record.gameMode,
        isSneaking: false,
        selectedSlot: fixture.record.selectedSlot,
        totalExperience: fixture.record.totalExperience,
        alive: true,
    };
    fixture.access.playerExperience.set("owner", 5);
    fixture.access.fakePlayerExperience.set(fixture.record.id, fixture.record.totalExperience);

    const result = fixture.service.transferExperience(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
        7,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.lifecycle.kind, "online");
    assert.equal(result.value.recordRevision, 6);
    assert.equal(result.value.inventoryRevision, 2);
    assert.equal(result.value.totalExperience, 13);
    assert.equal(fixture.access.playerExperience.get("owner"), 12);
    assert.equal(fixture.access.fakePlayerExperience.get(fixture.record.id), 13);
    assert.equal(fixture.access.experienceWriteCount, 1);
    assert.equal(fixture.access.fakeExperienceWriteCount, 1);
    assert.deepEqual(fixture.state.operations.experienceTransfers, {});
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

test("bulk inventory and equipment swaps use the recoverable transfer pipeline", () => {
    for (const kind of ["swap_inventory", "swap_equipment"] as const) {
        const fixture = createFixture();

        const result = fixture.service.transferItems(
            { playerId: "owner", isOperator: true },
            fixture.record.id,
            fixture.record.recordRevision,
            { kind },
        );

        assert.equal(result.ok, true);
        if (!result.ok) continue;
        assert.deepEqual(fixture.access.preparedRequests, [{ kind }]);
        assert.equal(result.value.inventoryRevision, 2);
        assert.equal(fixture.access.applyAfterCount, 1);
        assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
    }
});

test("swap accepts the player offhand slot while one-way transfers still require inventory slots", () => {
    const swapFixture = createFixture();
    const swapped = swapFixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        swapFixture.record.id,
        swapFixture.record.recordRevision,
        { kind: "swap", fakeSlot: 40, playerSlot: 40 },
    );
    assert.equal(swapped.ok, true);
    assert.deepEqual(swapFixture.access.preparedRequests, [{ kind: "swap", fakeSlot: 40, playerSlot: 40 }]);

    const takeFixture = createFixture();
    const taken = takeFixture.service.transferItems(
        { playerId: "owner", isOperator: true },
        takeFixture.record.id,
        takeFixture.record.recordRevision,
        { kind: "take", fakeSlot: 40, playerSlot: 40 },
    );
    assert.equal(taken.ok, false);
    if (!taken.ok) assert.equal(taken.error.code, "INVALID_SLOT");
    assert.deepEqual(takeFixture.access.preparedRequests, []);
});

test("content recycling transfers items and all experience without deleting the fake player", () => {
    const fixture = createFixture();
    fixture.access.playerExperience.set("owner", 5);

    const result = fixture.service.recycleContents(
        { playerId: "owner", isOperator: true },
        fixture.record.id,
        fixture.record.recordRevision,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.lifecycle.kind, "offline");
    assert.equal(result.value.recordRevision, 6);
    assert.equal(result.value.inventoryRevision, 2);
    assert.equal(result.value.totalExperience, 0);
    assert.equal(fixture.access.playerExperience.get("owner"), 25);
    assert.deepEqual(fixture.access.preparedRequests, [{ kind: "recycle_all" }]);
    assert.notEqual(fixture.state.catalog.records[fixture.record.id], undefined);
    assert.deepEqual(fixture.state.operations.inventoryTransfers, {});
    assert.deepEqual(fixture.state.operations.experienceTransfers, {});
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

test("online recovery only applies the missing fake-player after image", () => {
    const fixture = createFixture();
    const transfer: InventoryTransfer = {
        ...inventoryTransfer("applying"),
        id: "fp0001:inventory:5",
        fakePlayerRevision: 5,
        fakeSnapshotId: snapshotId(fixture.record.id, 2),
        fakeAfterSnapshotId: snapshotId(fixture.record.id, 3),
    };
    const onlineRecord: FakePlayerRecord = {
        ...fixture.record,
        recordRevision: 5,
        lifecycle: { kind: "online" },
        expectedOnline: true,
        inventoryRevision: 2,
    };
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: { [fixture.record.id]: onlineRecord },
    };
    fixture.state.operations = {
        ...fixture.state.operations,
        inventoryTransfers: { [transfer.id]: transfer },
    };
    fixture.snapshots.ids.delete(snapshotId(fixture.record.id, 1));
    fixture.snapshots.ids.add(transfer.fakeSnapshotId);
    fixture.snapshots.ids.add(transfer.fakeAfterSnapshotId);
    fixture.runtime.current = {
        id: onlineRecord.id,
        name: onlineRecord.name,
        dimension: onlineRecord.location.dimension,
        position: onlineRecord.location.position,
        headPosition: { ...onlineRecord.location.position, y: onlineRecord.location.position.y + 1.62 },
        rotation: onlineRecord.location.rotation,
        gameMode: onlineRecord.gameMode,
        isSneaking: false,
        selectedSlot: onlineRecord.selectedSlot,
        totalExperience: onlineRecord.totalExperience,
        alive: true,
    };
    fixture.access.states.set(transfer.id, "after");
    fixture.access.fakeStates.set(transfer.id, "before");

    const result = fixture.service.recoverPendingTransfers();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recovered, 1);
    assert.equal(fixture.access.applyAfterCount, 0);
    assert.equal(fixture.access.applyFakeAfterCount, 1);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.recordRevision, 6);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.inventoryRevision, 3);
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

test("online experience recovery does not write either after value twice", () => {
    const fixture = createFixture();
    const transfer: ExperienceTransfer = {
        id: "fp0001:experience:5",
        fakePlayerId: fixture.record.id,
        playerId: "owner",
        fakePlayerRevision: 5,
        kind: "fake_to_player",
        fakePlayerBefore: 20,
        playerBefore: 10,
        amount: 7,
        phase: "applying",
    };
    const onlineRecord: FakePlayerRecord = {
        ...fixture.record,
        recordRevision: 5,
        lifecycle: { kind: "online" },
        expectedOnline: true,
        inventoryRevision: 2,
    };
    fixture.state.catalog = {
        ...fixture.state.catalog,
        records: { [fixture.record.id]: onlineRecord },
    };
    fixture.state.operations = {
        ...fixture.state.operations,
        experienceTransfers: { [transfer.id]: transfer },
    };
    fixture.runtime.current = {
        id: onlineRecord.id,
        name: onlineRecord.name,
        dimension: onlineRecord.location.dimension,
        position: onlineRecord.location.position,
        headPosition: { ...onlineRecord.location.position, y: onlineRecord.location.position.y + 1.62 },
        rotation: onlineRecord.location.rotation,
        gameMode: onlineRecord.gameMode,
        isSneaking: false,
        selectedSlot: onlineRecord.selectedSlot,
        totalExperience: 13,
        alive: true,
    };
    fixture.access.playerExperience.set(transfer.playerId, 17);
    fixture.access.fakePlayerExperience.set(transfer.fakePlayerId, 13);

    const result = fixture.service.recoverPendingTransfers();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recovered, 1);
    assert.equal(fixture.access.experienceWriteCount, 0);
    assert.equal(fixture.access.fakeExperienceWriteCount, 0);
    assert.equal(fixture.state.catalog.records[fixture.record.id]?.recordRevision, 6);
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
