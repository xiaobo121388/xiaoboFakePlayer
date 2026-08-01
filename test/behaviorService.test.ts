import assert from "node:assert/strict";
import test from "node:test";

import { BehaviorService } from "../src/application/behaviorService.js";
import { InventoryService, snapshotId } from "../src/application/inventoryService.js";
import { OperationCoordinator } from "../src/application/operationCoordinator.js";
import type {
    AttackTargetQuery,
    BehaviorRuntime,
    EntityInteractionTargetQuery,
    InventoryAccess,
    InventorySnapshotStore,
    RuntimeActionReceipt,
    RuntimeBlockHit,
    RuntimeBlockInfo,
    RuntimeEntityInteractionTarget,
    RuntimeEntityTarget,
    RuntimeFakePlayer,
    RuntimeFakePlayerAction,
    RuntimeInventorySelection,
    RuntimeInventorySlot,
    SpawnFakePlayerRequest,
    WorldQueries,
} from "../src/application/ports.js";
import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import type { BehaviorConfig, DimensionKey, FakePlayerId, Point, SavedLocation } from "../src/domain/model.js";
import { ok, type Result } from "../src/domain/results.js";
import type { StringPropertyBackend } from "../src/infrastructure/state/bankedJsonStore.js";
import { BankedWorldStateStore } from "../src/infrastructure/state/bankedWorldStateStore.js";

class MemoryBackend implements StringPropertyBackend {
    private readonly values = new Map<string, string>();

    public get(key: string): string | undefined {
        return this.values.get(key);
    }

    public set(key: string, value: string): void {
        this.values.set(key, value);
    }
}

class MemoryRuntime implements BehaviorRuntime {
    public readonly players = new Map<FakePlayerId, RuntimeFakePlayer>();
    public readonly actions: RuntimeFakePlayerAction[] = [];
    public readonly projectileClaims: { readonly id: FakePlayerId; readonly radius: number }[] = [];
    public readonly inventorySlots = new Map<number, Omit<RuntimeInventorySlot, "slot">>();
    public nextReceipt: RuntimeActionReceipt | undefined;

    public capturePlayerSkin() {
        return undefined;
    }

    public spawn(request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        const player = {
            ...request,
            headPosition: { x: request.position.x, y: request.position.y + 1.62, z: request.position.z },
            isSneaking: false,
            alive: true,
        };
        this.players.set(request.id, player);
        return player;
    }

    public disconnect(id: FakePlayerId): boolean {
        return this.players.delete(id);
    }

    public respawn(id: FakePlayerId, _location?: SavedLocation): boolean {
        return this.players.has(id);
    }

    public claimProjectiles(id: FakePlayerId, radius: number): number {
        this.projectileClaims.push({ id, radius });
        return 1;
    }

    public resolveInventorySlot(
        _id: FakePlayerId,
        selection: RuntimeInventorySelection,
    ): RuntimeInventorySlot | undefined {
        if (selection.mode === "slot") {
            return {
                slot: selection.slot,
                ...(this.inventorySlots.get(selection.slot) ?? {
                    itemTypeId: "minecraft:stone",
                    placeableBlock: true,
                }),
            };
        }
        if (selection.itemTypeId === null) {
            return { slot: 0, itemTypeId: null, placeableBlock: false };
        }
        for (let slot = 0; slot < 36; slot += 1) {
            const item = this.inventorySlots.get(slot);
            if (item?.itemTypeId === selection.itemTypeId) {
                return {
                    slot,
                    ...item,
                };
            }
        }
        return undefined;
    }

    public perform(_id: FakePlayerId, action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        this.actions.push(action);
        if (this.nextReceipt !== undefined) {
            const receipt = this.nextReceipt;
            this.nextReceipt = undefined;
            return receipt;
        }
        if (action.kind === "navigate") return { accepted: true, fullPath: true };
        const changesInventory = action.kind === "attack_entity"
            || action.kind === "break_block"
            || action.kind === "build_block"
            || action.kind === "interact_block"
            || action.kind === "interact_entity"
            || action.kind === "place_block_direct"
            || action.kind === "use_item"
            || action.kind === "use_item_on_block";
        return changesInventory ? { accepted: true, inventoryChanged: true } : { accepted: true };
    }

    public get(id: FakePlayerId): RuntimeFakePlayer | undefined {
        return this.players.get(id);
    }

    public listTagged(): readonly RuntimeFakePlayer[] {
        return [...this.players.values()];
    }
}

class MemorySnapshots implements InventorySnapshotStore {
    private readonly ids = new Set<string>();

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

class MemoryWorldQueries implements WorldQueries {
    public loaded = true;
    public solid = true;
    public visible = true;
    public entityDistanceSquared: number | undefined = 1;
    public viewBlockHit: RuntimeBlockHit | undefined;
    public readonly viewBlockMaxDistances: number[] = [];
    public readonly onlinePlayers = new Map<string, RuntimeEntityTarget>();
    public interactionTargets: readonly RuntimeEntityInteractionTarget[] = [];
    public readonly interactionQueries: EntityInteractionTargetQuery[] = [];
    public attackTargets: readonly RuntimeEntityTarget[] = [];
    public blockInfo: RuntimeBlockInfo | undefined;
    public readonly blockInfoByPosition = new Map<string, RuntimeBlockInfo>();
    public readonly hiddenBlocks = new Set<string>();
    public readonly blockReads: Point[] = [];

    public isChunkLoaded(): boolean {
        return this.loaded;
    }

    public isSolidBlock(): boolean {
        return this.solid;
    }

    public hasBlockLineOfSight(
        _fakePlayerId: FakePlayerId,
        _dimension: DimensionKey,
        position: Point,
    ): boolean {
        return this.visible && !this.hiddenBlocks.has(pointKey(position));
    }

    public hasLineOfSight(): boolean {
        return this.visible;
    }

    public distanceSquared(): number | undefined {
        return this.entityDistanceSquared;
    }

    public findOnlinePlayer(playerId: string): RuntimeEntityTarget | undefined {
        return this.onlinePlayers.get(playerId);
    }

    public findInteractionTargets(
        _fakePlayerId: FakePlayerId,
        query: EntityInteractionTargetQuery,
    ): readonly RuntimeEntityInteractionTarget[] {
        this.interactionQueries.push(query);
        return this.interactionTargets;
    }

    public findAttackTargets(_fakePlayerId: FakePlayerId, _query: AttackTargetQuery): readonly RuntimeEntityTarget[] {
        return this.attackTargets;
    }

    public getBlockFromViewDirection(_fakePlayerId: FakePlayerId, maxDistance: number) {
        this.viewBlockMaxDistances.push(maxDistance);
        return this.viewBlockHit;
    }

    public getBlockInfo(_dimension: DimensionKey, position: Point): RuntimeBlockInfo | undefined {
        this.blockReads.push({ ...position });
        return this.blockInfoByPosition.get(pointKey(position)) ?? this.blockInfo;
    }
}

function pointKey({ x, y, z }: Point): string {
    return `${x}:${y}:${z}`;
}

function createFixture() {
    const state = new BankedWorldStateStore(new MemoryBackend(), "behavior");
    const runtime = new MemoryRuntime();
    const queries = new MemoryWorldQueries();
    const coordinator = new OperationCoordinator();
    const inventory = new InventoryService(
        state,
        runtime,
        new MemorySnapshots(),
        coordinator,
        {} as InventoryAccess,
    );
    const service = new BehaviorService(state, runtime, queries, coordinator, inventory);
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
        keepSaturated: false,
        skin: { kind: "default" as const },
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual" as const,
        respawnLocation: null,
        inventoryRevision: null,
        inventoryFallbackRevision: null,
        lastCheckpointTick: null,
        behavior: createDefaultBehaviorConfig(),
    };
    const catalog = state.loadCatalog();
    assert.equal(catalog.ok, true);
    if (!catalog.ok) throw new Error("catalog unavailable");
    assert.equal(state.commitCatalog(catalog.state.revision, {
        nextId: 2,
        records: { [record.id]: record },
    }).ok, true);
    runtime.players.set(record.id, {
        id: record.id,
        name: record.name,
        dimension: record.location.dimension,
        position: record.location.position,
        headPosition: { x: 0, y: 65.62, z: 0 },
        rotation: record.location.rotation,
        gameMode: record.gameMode,
        isSneaking: false,
        selectedSlot: record.selectedSlot,
        totalExperience: record.totalExperience,
        alive: true,
    });
    return { state, runtime, queries, service, inventory, record };
}

test("behavior actions require canSet and the current online revision", () => {
    const fixture = createFixture();
    const member = { playerId: "member", isOperator: false };
    const operator = { playerId: "operator", isOperator: true };

    assert.equal(fixture.service.perform(member, fixture.record.id, 4, { kind: "jump" }).ok, false);
    assert.equal(fixture.service.perform(operator, fixture.record.id, 3, { kind: "jump" }).ok, false);
    assert.equal(fixture.runtime.actions.length, 0);
    assert.deepEqual(fixture.service.perform(operator, fixture.record.id, 4, { kind: "jump" }), {
        ok: true,
        value: { accepted: true },
    });
    assert.deepEqual(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "set_sneaking",
        enabled: true,
    }), {
        ok: true,
        value: { accepted: true },
    });
    assert.deepEqual(fixture.runtime.actions, [
        { kind: "jump" },
        { kind: "set_sneaking", enabled: true },
    ]);
});

test("coordinate actions reject cross-dimension and unloaded targets before runtime", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };

    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "look_at",
        dimension: "minecraft:nether",
        position: { x: 1, y: 64, z: 1 },
    }).ok, false);
    fixture.queries.loaded = false;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 10 },
    }).ok, false);
    assert.equal(fixture.runtime.actions.length, 0);
});

test("one-shot look sets eye-to-eye rotation while continuous look keeps tracking the entity", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };

    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "look_at_once",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 75.62, z: 0 },
    }).ok, true);
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "look_at_entity",
        targetId: "operator",
    }).ok, true);
    assert.deepEqual(fixture.runtime.actions, [
        { kind: "look_at_once", rotation: { x: -45, y: -90 } },
        { kind: "look_at_entity", targetId: "operator" },
    ]);
});

test("navigation validates speed and reports whether a full path exists", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };

    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 10 },
        speed: 2,
    }).ok, false);
    assert.deepEqual(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 10 },
        speed: 0.75,
    }), {
        ok: true,
        value: { accepted: true, fullPath: true },
    });
});

test("block breaking requires a solid loaded visible block within reach", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const action = {
        kind: "break_block" as const,
        dimension: "minecraft:overworld",
        position: { x: 1.9, y: 64.2, z: -1.1 },
        face: "up" as const,
    };

    fixture.queries.solid = false;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, action).ok, false);
    fixture.queries.solid = true;
    fixture.queries.visible = false;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, action).ok, false);
    fixture.queries.visible = true;
    assert.deepEqual(fixture.service.perform(operator, fixture.record.id, 4, action), {
        ok: true,
        value: { accepted: true, inventoryChanged: true },
    });
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "break_block",
        position: { x: 1, y: 64, z: -2 },
        face: "up",
    }]);
});

test("block interaction accepts a visible non-solid button", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    fixture.queries.solid = false;
    fixture.queries.blockInfo = { typeId: "minecraft:stone_button", solid: false };

    assert.deepEqual(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "interact_block",
        dimension: "minecraft:overworld",
        position: { x: 1, y: 64, z: 0 },
        face: "south",
    }), {
        ok: true,
        value: { accepted: true, inventoryChanged: true },
    });
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 1, y: 64, z: 0 },
        face: "south",
    }]);
});

test("entity interactions reject out-of-range or obstructed transient targets", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const action = { kind: "attack_entity" as const, targetId: "entity-1" };

    fixture.queries.entityDistanceSquared = 37;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, action).ok, false);
    fixture.queries.entityDistanceSquared = 4;
    fixture.queries.visible = false;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, action).ok, false);
    fixture.queries.visible = true;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, action).ok, true);

    fixture.queries.entityDistanceSquared = 81;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "interact_entity",
        targetId: "entity-1",
    }).ok, true);
    fixture.queries.entityDistanceSquared = 101;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "interact_entity",
        targetId: "entity-1",
    }).ok, false);
});

test("interaction target lookup lists nearby entities and supports an exact type filter", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const member = { playerId: "member", isOperator: false };
    fixture.queries.interactionTargets = [{
        id: "item-1",
        typeId: "minecraft:item",
        nameTag: "",
        dimension: "minecraft:overworld",
        position: { x: 6, y: 64, z: 8 },
    }];

    assert.deepEqual(fixture.service.listInteractionTargets(operator, fixture.record.id, 4), {
        ok: true,
        value: [{
            id: "item-1",
            typeId: "minecraft:item",
            nameTag: "",
            distance: 10,
        }],
    });
    assert.deepEqual(fixture.queries.interactionQueries, [{ maxDistance: 10 }]);

    assert.equal(fixture.service.listInteractionTargets(member, fixture.record.id, 4).ok, false);
    assert.equal(fixture.service.listInteractionTargets(operator, fixture.record.id, 3).ok, false);
    assert.equal(fixture.queries.interactionQueries.length, 1);

    assert.equal(fixture.service.listInteractionTargets(
        operator,
        fixture.record.id,
        4,
        "Cow",
    ).ok, false);
    assert.equal(fixture.service.listInteractionTargets(
        operator,
        fixture.record.id,
        4,
        "minecraft:cow",
    ).ok, true);
    assert.deepEqual(fixture.queries.interactionQueries.at(-1), {
        maxDistance: 10,
        typeId: "minecraft:cow",
    });
});

test("item actions only accept real inventory slots", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };

    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "use_item",
        slot: 36,
    }).ok, false);
    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "use_item",
        slot: 35,
    }).ok, true);
    const checkpoint = fixture.inventory.checkpointNext(20);
    assert.equal(checkpoint.ok, true);
    if (checkpoint.ok) assert.equal(checkpoint.value?.record.inventoryRevision, 1);
});

test("behavior configuration commits with optimistic record revision", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        use: { enabled: true, intervalTicks: 5, slot: 2 },
    };

    const updated = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    );
    assert.equal(updated.ok, true);
    if (updated.ok) {
        assert.equal(updated.value.recordRevision, 5);
        assert.deepEqual(updated.value.behavior, config);
    }
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "stop");
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, false);
});

test("behavior configuration rejects new interaction slots outside the hotbar", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();

    const result = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        {
            ...defaults,
            place: { ...defaults.place, slot: 9 },
        },
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_SLOT");
});

test("enabling an action behavior disables the other action behaviors", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const kinds = ["attack", "mine", "place", "use"] as const;
    const enableActions: readonly ((config: BehaviorConfig) => BehaviorConfig)[] = [
        (config) => ({ ...config, attack: { ...config.attack, enabled: true } }),
        (config) => ({ ...config, mine: { ...config.mine, enabled: true } }),
        (config) => ({ ...config, place: { ...config.place, enabled: true } }),
        (config) => ({ ...config, use: { ...config.use, enabled: true } }),
    ];
    let revision = fixture.record.recordRevision;
    let behavior = fixture.record.behavior;

    for (const [index, enable] of enableActions.entries()) {
        const updated = fixture.service.updateBehaviorConfig(
            operator,
            fixture.record.id,
            revision,
            behavior,
            enable(behavior),
        );
        assert.equal(updated.ok, true);
        if (!updated.ok) throw new Error("behavior update failed");
        revision = updated.value.recordRevision;
        behavior = updated.value.behavior;
        for (const kind of kinds) {
            assert.equal(behavior[kind].enabled, kind === kinds[index]);
        }
    }
});

test("behavior configuration tolerates checkpoint-only revision advances", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        follow: {
            enabled: true,
            targetPlayerId: "playfab-target",
            lastKnownName: "Steve",
            intervalTicks: 10,
            speed: 0.8,
            stopDistance: 2,
        },
    };

    const checkpoint = fixture.inventory.checkpoint(fixture.record.id, 4, 20);
    assert.equal(checkpoint.ok, true);
    const updated = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    );

    assert.equal(updated.ok, true);
    if (updated.ok) {
        assert.equal(updated.value.recordRevision, 6);
        assert.deepEqual(updated.value.behavior, config);
    }
});

test("projectile claim behavior scans every five seconds without consuming the action slot", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    const config = {
        ...defaults,
        use: { enabled: true, intervalTicks: 1, slot: 0 },
        projectileClaim: { enabled: true, radius: 24 },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        fixture.record.recordRevision,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const first = fixture.service.tick(0);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.value.attemptedActions, 1);
    assert.deepEqual(fixture.runtime.projectileClaims, [{ id: fixture.record.id, radius: 24 }]);
    assert.deepEqual(fixture.runtime.actions, [{ kind: "use_item", slot: 0 }]);

    assert.equal(fixture.service.tick(99).ok, true);
    assert.equal(fixture.runtime.projectileClaims.length, 1);
    assert.equal(fixture.service.tick(100).ok, true);
    assert.deepEqual(fixture.runtime.projectileClaims, [
        { id: fixture.record.id, radius: 24 },
        { id: fixture.record.id, radius: 24 },
    ]);
});

test("one-shot navigation pauses automatic pathfinding until the destination is reached", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 12,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    }];

    assert.equal(fixture.service.perform(operator, fixture.record.id, 5, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 20, y: 64, z: 0 },
        speed: 0.75,
    }).ok, true);
    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "navigate",
        position: { x: 20, y: 64, z: 0 },
        speed: 0.75,
    }]);

    fixture.runtime.players.set(fixture.record.id, {
        ...fixture.runtime.players.get(fixture.record.id)!,
        position: { x: 20, y: 64, z: 0 },
    });
    assert.equal(fixture.service.tick(1).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
});

test("stalled one-shot navigation releases automatic pathfinding", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 12,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    }];
    assert.equal(fixture.service.perform(operator, fixture.record.id, 5, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 20, y: 64, z: 0 },
    }).ok, true);

    for (let currentTick = 0; currentTick < 19; currentTick += 1) {
        assert.equal(fixture.service.tick(currentTick).ok, true);
    }
    assert.equal(fixture.runtime.actions.length, 1);
    assert.equal(fixture.service.tick(19).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
});

test("one-shot entity navigation releases when its target becomes invalid", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 12,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.entityDistanceSquared = 100;
    assert.equal(fixture.service.perform(operator, fixture.record.id, 5, {
        kind: "navigate_entity",
        targetId: "manual-target",
    }).ok, true);
    fixture.queries.entityDistanceSquared = undefined;
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    }];

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "navigate_entity",
        targetId: "zombie-runtime",
        speed: 1,
    });
});

test("manual stop releases one-shot navigation immediately", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 12,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    }];
    assert.equal(fixture.service.perform(operator, fixture.record.id, 5, {
        kind: "navigate",
        dimension: "minecraft:overworld",
        position: { x: 20, y: 64, z: 0 },
    }).ok, true);
    assert.equal(fixture.service.perform(operator, fixture.record.id, 5, { kind: "stop" }).ok, true);

    assert.equal(fixture.service.tick(0).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
});

test("distant follow pathfinding takes priority over other automatic pathfinding", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        follow: {
            enabled: true,
            targetPlayerId: "playfab-target",
            lastKnownName: "Steve",
            intervalTicks: 10,
            speed: 0.8,
            stopDistance: 2,
        },
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 12,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.onlinePlayers.set("playfab-target", {
        id: "player-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    });
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    }];

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "navigate_entity",
        targetId: "player-runtime",
        speed: 0.8,
    }]);
    assert.equal(fixture.service.tick(1).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
    assert.equal(fixture.runtime.actions.length, 1);
    assert.equal(fixture.service.tick(2).ok, true);
    assert.equal(fixture.runtime.actions.length, 1);
    assert.equal(fixture.service.tick(3).ok, true);
    assert.equal(fixture.runtime.actions.length, 1);
    assert.equal(fixture.service.tick(10).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
    assert.equal(fixture.runtime.actions.length, 2);
});

test("follow within its distance yields to other automatic pathfinding", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        follow: {
            enabled: true,
            targetPlayerId: "playfab-target",
            lastKnownName: "Steve",
            intervalTicks: 10,
            speed: 0.8,
            stopDistance: 4,
        },
        attack: {
            enabled: true,
            intervalTicks: 2,
            maxDistance: 6,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.onlinePlayers.set("playfab-target", {
        id: "player-runtime",
        dimension: "minecraft:overworld",
        position: { x: 3, y: 64, z: 0 },
    });
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 5, y: 64, z: 0 },
    }];

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "attack_entity",
        targetId: "zombie-runtime",
        selectBestWeapon: true,
    }]);
});

test("follow yields to mining pathfinding only within its configured distance", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        follow: {
            enabled: true,
            targetPlayerId: "playfab-target",
            lastKnownName: "Steve",
            intervalTicks: 10,
            speed: 0.8,
            stopDistance: 4,
        },
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "down" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 0,
            approach: true,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.visible = false;
    fixture.queries.blockInfoByPosition.set("0:63:0", { typeId: "minecraft:stone", solid: true });
    fixture.queries.onlinePlayers.set("playfab-target", {
        id: "player-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    });

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "navigate_entity",
        targetId: "player-runtime",
        speed: 0.8,
    }]);
    assert.equal(fixture.service.tick(1).ok, true);
    assert.equal(fixture.runtime.actions.length, 1);

    fixture.queries.onlinePlayers.set("playfab-target", {
        id: "player-runtime",
        dimension: "minecraft:overworld",
        position: { x: 3, y: 64, z: 0 },
    });
    assert.equal(fixture.service.tick(2).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "navigate",
        position: { x: 0.5, y: 64, z: 0.5 },
        speed: 1,
    });
});

test("automatic behaviors pause while a transfer is pending", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        use: { enabled: true, intervalTicks: 1, slot: 0 },
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        fixture.record.recordRevision,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;
    const operations = fixture.state.loadOperations();
    assert.equal(operations.ok, true);
    if (!operations.ok) throw new Error("operations unavailable");
    const transfer = {
        id: "fp0001:inventory:5",
        fakePlayerId: fixture.record.id,
        playerId: "owner",
        fakePlayerRevision: 5,
        fakeSnapshotId: "before-fake",
        fakeAfterSnapshotId: "after-fake",
        request: { kind: "swap_inventory" as const },
        beforeStructureId: "before-player",
        afterStructureId: "after-player",
        phase: "prepared" as const,
    };
    assert.equal(fixture.state.commitOperations(operations.state.revision, {
        ...operations.state.value,
        inventoryTransfers: { [transfer.id]: transfer },
    }).ok, true);

    assert.deepEqual(fixture.service.tick(0), ok({
        consideredTasks: 0,
        attemptedActions: 0,
        acceptedActions: 0,
        blockReads: 0,
    }));
    assert.deepEqual(fixture.runtime.actions, []);
});

test("automatic mine search consumes at most 256 unique block reads per tick and resumes", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "down" as const,
            blockTypeId: "minecraft:diamond_ore",
            searchRadius: 10,
            approach: false,
        },
    };
    fixture.queries.blockInfo = { typeId: "minecraft:stone", solid: true };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const first = fixture.service.tick(0);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.value.blockReads, 256);
    const second = fixture.service.tick(1);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.value.blockReads, 256);
    assert.equal(fixture.queries.blockReads.length, 512);
    assert.equal(new Set(fixture.queries.blockReads.map(({ x, y, z }) => `${x}:${y}:${z}`)).size, 512);
    assert.equal(fixture.runtime.actions.length, 0);
});

test("automatic front mine uses the block hit by the eye ray", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "front" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 0,
            approach: false,
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 68, z: 4 },
        face: "west",
        faceLocation: { x: 0, y: 0.5, z: 0.5 },
        distance: 5,
    };
    fixture.queries.blockInfoByPosition.set("2:68:4", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("0:65:1", { typeId: "minecraft:stone", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "break_block",
        position: { x: 2, y: 68, z: 4 },
        face: "west",
        replaceExhaustedTool: true,
    });
    assert.deepEqual(fixture.queries.viewBlockMaxDistances, [7]);
});

test("automatic front placement uses the exact face hit by the eye ray", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 10,
            mode: "front" as const,
            position: null,
            slot: 4,
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.25, z: 0.75 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("1:65:2", { typeId: "minecraft:air", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 2);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "build_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        target: { x: 1, y: 65, z: 2 },
        selection: { mode: "slot", slot: 4 },
    }]);
    assert.deepEqual(fixture.queries.viewBlockMaxDistances, [7]);
});

test("automatic interaction rejects legacy slots outside the hotbar", () => {
    const fixture = createFixture();
    const defaults = createDefaultBehaviorConfig();
    const catalog = fixture.state.loadCatalog();
    assert.equal(catalog.ok, true);
    if (!catalog.ok) throw new Error("catalog unavailable");
    assert.equal(fixture.state.commitCatalog(catalog.state.revision, {
        ...catalog.state.value,
        records: {
            ...catalog.state.value.records,
            [fixture.record.id]: {
                ...fixture.record,
                behavior: {
                    ...defaults,
                    place: { ...defaults.place, enabled: true, slot: 9 },
                },
            },
        },
    }).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);

    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.value.placeDiagnostic ?? "", /state=hotbar_slot_invalid/);
    assert.equal(fixture.runtime.actions.length, 0);
});

test("automatic interaction resolves an item on every run and supports empty hand", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 10,
            selectionMode: "item" as const,
            itemTypeId: "minecraft:stick",
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.25, z: 0.75 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("1:65:2", { typeId: "minecraft:air", solid: false });
    fixture.runtime.inventorySlots.set(5, { itemTypeId: "minecraft:stick", placeableBlock: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "item", slot: 5, emptyHand: false },
    });
    fixture.runtime.inventorySlots.delete(5);
    fixture.runtime.inventorySlots.set(8, { itemTypeId: "minecraft:stick", placeableBlock: false });
    assert.equal(fixture.service.tick(10).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "item", slot: 8, emptyHand: false },
    });

    const latest = fixture.state.loadCatalog();
    assert.equal(latest.ok, true);
    if (!latest.ok) throw new Error("catalog unavailable");
    const current = latest.state.value.records[fixture.record.id];
    assert.notEqual(current, undefined);
    const emptyHand = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        current!.recordRevision,
        current!.behavior,
        {
            ...current!.behavior,
            place: { ...current!.behavior.place, itemTypeId: null },
        },
    );
    assert.equal(emptyHand.ok, true);
    fixture.runtime.actions.length = 0;
    assert.equal(fixture.service.tick(20).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "item", slot: 0, emptyHand: true },
    });
});

test("automatic empty-hand interaction activates a non-solid button without requiring an empty placement cell", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.5, z: 0.5 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:stone_button", solid: false });
    fixture.queries.blockInfoByPosition.set("1:65:2", { typeId: "minecraft:stone", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        {
            ...defaults,
            place: {
                ...defaults.place,
                enabled: true,
                selectionMode: "item",
                itemTypeId: null,
            },
        },
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);

    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 1);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "item", slot: 0, emptyHand: true },
    }]);
});

test("automatic interaction activates a non-solid button while holding a placeable block", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.5, z: 0.5 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:stone_button", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        { ...defaults, place: { ...defaults.place, enabled: true, slot: 4 } },
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.blockReads, 1);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "slot", slot: 4 },
    }]);
});

test("automatic interaction skips the action when the configured item is missing", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        {
            ...defaults,
            place: {
                ...defaults.place,
                enabled: true,
                selectionMode: "item",
                itemTypeId: "minecraft:stick",
            },
        },
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(result.value.placeDiagnostic ?? "", /state=item_not_found/);
    assert.equal(fixture.runtime.actions.length, 0);
});

test("automatic front chest placement directly places only while sneaking", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 10,
            mode: "front" as const,
            position: null,
            slot: 4,
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.25, z: 0.75 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:chest", solid: false });
    fixture.queries.blockInfoByPosition.set("1:65:2", { typeId: "minecraft:air", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 1);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        preserveView: true,
        selection: { mode: "slot", slot: 4 },
    }]);

    const runtimePlayer = fixture.runtime.players.get(fixture.record.id);
    assert.notEqual(runtimePlayer, undefined);
    fixture.runtime.players.set(fixture.record.id, { ...runtimePlayer!, isSneaking: true });
    fixture.runtime.actions.length = 0;

    const sneakingResult = fixture.service.tick(10);
    assert.equal(sneakingResult.ok, true);
    if (sneakingResult.ok) {
        assert.equal(sneakingResult.value.blockReads, 2);
        assert.match(sneakingResult.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "place_block_direct",
        slot: 4,
        position: { x: 1, y: 65, z: 2 },
    }]);
    assert.deepEqual(fixture.queries.viewBlockMaxDistances, [7, 7]);
});

test("automatic coordinate placement resolves the target cell to an adjacent support face", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 10,
            mode: "position" as const,
            position: { x: 3, y: 64, z: 0 },
            slot: 2,
        },
    };
    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:air", solid: false });
    fixture.queries.blockInfoByPosition.set("3:63:0", { typeId: "minecraft:stone", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 2);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "build_block",
        position: { x: 3, y: 63, z: 0 },
        face: "up",
        target: { x: 3, y: 64, z: 0 },
        selection: { mode: "slot", slot: 2 },
    }]);
});

test("automatic coordinate placement directly places when a chest support is not reported solid", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 10,
            mode: "position" as const,
            position: { x: 3, y: 64, z: 0 },
            slot: 2,
        },
    };
    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:air", solid: false });
    fixture.queries.blockInfoByPosition.set("3:63:0", { typeId: "minecraft:chest", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 2);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "place_block_direct",
        slot: 2,
        position: { x: 3, y: 64, z: 0 },
    }]);
});

test("automatic coordinate interaction uses an empty hand on chest support", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:air", solid: false });
    fixture.queries.blockInfoByPosition.set("3:63:0", { typeId: "minecraft:chest", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        {
            ...defaults,
            place: {
                ...defaults.place,
                enabled: true,
                mode: "position",
                position: { x: 3, y: 64, z: 0 },
                selectionMode: "item",
                itemTypeId: null,
            },
        },
    ).ok, true);
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 3, y: 63, z: 0 },
        face: "up",
        selection: { mode: "item", slot: 0, emptyHand: true },
    }]);
});

test("automatic coordinate interaction activates a non-solid button at the configured position", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const defaults = createDefaultBehaviorConfig();
    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:stone_button", solid: false });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        {
            ...defaults,
            place: {
                ...defaults.place,
                enabled: true,
                mode: "position",
                position: { x: 3, y: 64, z: 0 },
                selectionMode: "item",
                itemTypeId: null,
            },
        },
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);

    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 1);
        assert.match(result.value.placeDiagnostic ?? "", /state=accepted/);
    }
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "interact_block",
        position: { x: 3, y: 64, z: 0 },
        face: "west",
        selection: { mode: "item", slot: 0, emptyHand: true },
    }]);
});

test("automatic coordinate placement delegates support reachability to the runtime", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const position = { x: 3, y: 64, z: 0 };
    const config = {
        ...createDefaultBehaviorConfig(),
        place: {
            ...createDefaultBehaviorConfig().place,
            enabled: true,
            intervalTicks: 1,
            mode: "position" as const,
            position,
            slot: 2,
        },
    };
    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("3:63:0", { typeId: "minecraft:stone", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const occupied = fixture.service.tick(0);
    assert.equal(occupied.ok, true);
    if (occupied.ok) assert.match(occupied.value.placeDiagnostic ?? "", /state=target_not_air/);
    assert.equal(fixture.runtime.actions.length, 0);

    fixture.queries.blockInfoByPosition.set("3:64:0", { typeId: "minecraft:air", solid: false });
    fixture.queries.visible = false;
    const delegated = fixture.service.tick(1);
    assert.equal(delegated.ok, true);
    if (delegated.ok) assert.match(delegated.value.placeDiagnostic ?? "", /state=accepted/);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "build_block",
        position: { x: 3, y: 63, z: 0 },
        face: "up",
        target: { x: 3, y: 64, z: 0 },
        selection: { mode: "slot", slot: 2 },
    }]);
});

test("automatic front mine does not fall back to nearby blocks when the eye ray misses", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "front" as const,
            blockTypeId: null,
            searchRadius: 1,
            approach: false,
        },
    };
    fixture.queries.blockInfoByPosition.set("0:64:1", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("-1:65:0", { typeId: "minecraft:stone", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.blockReads, 0);
    assert.equal(fixture.runtime.actions.length, 0);
});

test("automatic front mine does not look through an unmatched first ray hit", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "front" as const,
            blockTypeId: "minecraft:diamond_ore",
            searchRadius: 1,
            approach: false,
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 0, y: 65, z: 1 },
        face: "north",
        faceLocation: { x: 0.5, y: 0.5, z: 0 },
        distance: 1,
    };
    fixture.queries.blockInfoByPosition.set("0:65:1", { typeId: "minecraft:stone", solid: true });
    fixture.queries.blockInfoByPosition.set("0:65:2", { typeId: "minecraft:diamond_ore", solid: true });
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const result = fixture.service.tick(0);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.blockReads, 1);
        assert.match(result.value.mineDiagnostic ?? "", /observed=minecraft:stone/);
    }
    assert.equal(fixture.runtime.actions.length, 0);
});

test("automatic front mine trusts the exact eye ray hit instead of recasting to the block center", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "front" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 1,
            approach: false,
        },
    };
    fixture.queries.viewBlockHit = {
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        faceLocation: { x: 0, y: 0.5, z: 0.5 },
        distance: 3,
    };
    fixture.queries.blockInfoByPosition.set("2:65:2", { typeId: "minecraft:stone", solid: true });
    fixture.queries.hiddenBlocks.add("2:65:2");
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "break_block",
        position: { x: 2, y: 65, z: 2 },
        face: "west",
        replaceExhaustedTool: true,
    });
});

test("automatic mining starts once and waits for the block to finish breaking", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 1,
            direction: "front" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 0,
            approach: false,
        },
    };
    fixture.queries.blockInfo = { typeId: "minecraft:stone", solid: true };
    fixture.queries.viewBlockHit = {
        position: { x: 0, y: 65, z: 1 },
        face: "north",
        faceLocation: { x: 0.5, y: 0.5, z: 0 },
        distance: 1,
    };
    assert.equal(fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    ).ok, true);
    fixture.runtime.actions.length = 0;

    const started = fixture.service.tick(0);
    assert.equal(started.ok, true);
    if (started.ok) assert.match(started.value.mineDiagnostic ?? "", /state=starting;.*target=0,65,1/);
    assert.deepEqual(fixture.runtime.actions.at(-1), {
        kind: "break_block",
        position: { x: 0, y: 65, z: 1 },
        face: "north",
        replaceExhaustedTool: true,
    });
    const waiting = fixture.service.tick(1);
    assert.equal(waiting.ok, true);
    if (waiting.ok) assert.match(waiting.value.mineDiagnostic ?? "", /state=waiting;.*observed=minecraft:stone/);
    assert.equal(fixture.runtime.actions.filter(({ kind }) => kind === "break_block").length, 1);

    fixture.service.notifyBlockBroken(
        fixture.record.id,
        "minecraft:overworld",
        { x: 0, y: 65, z: 1 },
    );
    assert.equal(fixture.service.tick(2).ok, true);
    assert.equal(fixture.runtime.actions.filter(({ kind }) => kind === "break_block").length, 2);
});

test("automatic mining restarts after a manual stop interrupts the active block", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 1,
            direction: "front" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 0,
            approach: false,
        },
    };
    fixture.queries.blockInfo = { typeId: "minecraft:stone", solid: true };
    fixture.queries.viewBlockHit = {
        position: { x: 0, y: 65, z: 1 },
        face: "north",
        faceLocation: { x: 0.5, y: 0.5, z: 0 },
        distance: 1,
    };
    const updated = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        config,
    );
    assert.equal(updated.ok, true);
    if (!updated.ok) throw new Error("behavior update failed");
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.equal(fixture.service.perform(operator, fixture.record.id, updated.value.recordRevision, {
        kind: "stop",
    }).ok, true);
    assert.equal(fixture.service.tick(1).ok, true);
    assert.equal(fixture.runtime.actions.filter(({ kind }) => kind === "break_block").length, 2);
});

test("enabling automatic item use stops and disables active mining", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const mineConfig = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 1,
            direction: "front" as const,
            blockTypeId: "minecraft:stone",
            searchRadius: 0,
            approach: false,
        },
    };
    fixture.queries.blockInfo = { typeId: "minecraft:stone", solid: true };
    fixture.queries.viewBlockHit = {
        position: { x: 0, y: 65, z: 1 },
        face: "north",
        faceLocation: { x: 0.5, y: 0.5, z: 0 },
        distance: 1,
    };
    const mining = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        4,
        fixture.record.behavior,
        mineConfig,
    );
    assert.equal(mining.ok, true);
    if (!mining.ok) throw new Error("behavior update failed");
    fixture.runtime.actions.length = 0;

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions.map(({ kind }) => kind), ["break_block"]);

    const using = fixture.service.updateBehaviorConfig(
        operator,
        fixture.record.id,
        mining.value.recordRevision,
        mining.value.behavior,
        {
            ...mining.value.behavior,
            use: { enabled: true, intervalTicks: 1, slot: 0 },
        },
    );
    assert.equal(using.ok, true);
    if (!using.ok) throw new Error("behavior update failed");
    assert.equal(using.value.behavior.mine.enabled, false);
    assert.equal(using.value.behavior.use.enabled, true);
    assert.deepEqual(fixture.runtime.actions.map(({ kind }) => kind), ["break_block", "stop"]);

    fixture.runtime.actions.length = 0;
    assert.equal(fixture.service.tick(1).ok, true);
    assert.deepEqual(fixture.runtime.actions.map(({ kind }) => kind), ["use_item"]);
});

test("inventory changes are checkpointed even when the runtime action is rejected", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    fixture.runtime.nextReceipt = { accepted: false, inventoryChanged: true };

    assert.equal(fixture.service.perform(operator, fixture.record.id, 4, {
        kind: "attack_entity",
        targetId: "entity-1",
    }).ok, false);
    const checkpoint = fixture.inventory.checkpointNext(20);
    assert.equal(checkpoint.ok, true);
    if (checkpoint.ok) assert.equal(checkpoint.value?.record.inventoryRevision, 1);
});