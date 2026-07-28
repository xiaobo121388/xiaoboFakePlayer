import assert from "node:assert/strict";
import test from "node:test";

import { BehaviorService } from "../src/application/behaviorService.js";
import { InventoryService, snapshotId } from "../src/application/inventoryService.js";
import { OperationCoordinator } from "../src/application/operationCoordinator.js";
import type {
    AttackTargetQuery,
    FakePlayerRuntime,
    InventoryAccess,
    InventorySnapshotStore,
    RuntimeActionReceipt,
    RuntimeBlockInfo,
    RuntimeEntityTarget,
    RuntimeFakePlayer,
    RuntimeFakePlayerAction,
    SpawnFakePlayerRequest,
    WorldQueries,
} from "../src/application/ports.js";
import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import type { DimensionKey, FakePlayerId, Point, SavedLocation } from "../src/domain/model.js";
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

class MemoryRuntime implements FakePlayerRuntime {
    public readonly players = new Map<FakePlayerId, RuntimeFakePlayer>();
    public readonly actions: RuntimeFakePlayerAction[] = [];

    public capturePlayerSkin() {
        return undefined;
    }

    public spawn(request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        const player = { ...request, alive: true };
        this.players.set(request.id, player);
        return player;
    }

    public disconnect(id: FakePlayerId): boolean {
        return this.players.delete(id);
    }

    public respawn(id: FakePlayerId, _location?: SavedLocation): boolean {
        return this.players.has(id);
    }

    public perform(_id: FakePlayerId, action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        this.actions.push(action);
        if (action.kind === "navigate") return { accepted: true, fullPath: true };
        const changesInventory = action.kind === "attack_entity"
            || action.kind === "break_block"
            || action.kind === "interact_block"
            || action.kind === "interact_entity"
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
    public readonly onlinePlayers = new Map<string, RuntimeEntityTarget>();
    public attackTargets: readonly RuntimeEntityTarget[] = [];
    public blockInfo: RuntimeBlockInfo | undefined;
    public readonly blockReads: Point[] = [];

    public isChunkLoaded(): boolean {
        return this.loaded;
    }

    public isSolidBlock(): boolean {
        return this.solid;
    }

    public hasBlockLineOfSight(): boolean {
        return this.visible;
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

    public findAttackTargets(_fakePlayerId: FakePlayerId, _query: AttackTargetQuery): readonly RuntimeEntityTarget[] {
        return this.attackTargets;
    }

    public getBlockInfo(_dimension: DimensionKey, position: Point): RuntimeBlockInfo | undefined {
        this.blockReads.push({ ...position });
        return this.blockInfo;
    }
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
        skin: { kind: "default" as const },
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual" as const,
        respawnLocation: null,
        inventoryRevision: null,
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
        rotation: record.location.rotation,
        gameMode: record.gameMode,
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
    assert.deepEqual(fixture.runtime.actions, [{ kind: "jump" }]);
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

test("block interactions require a solid loaded visible block within reach", () => {
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

    const updated = fixture.service.updateBehaviorConfig(operator, fixture.record.id, 4, config);
    assert.equal(updated.ok, true);
    if (updated.ok) {
        assert.equal(updated.value.recordRevision, 5);
        assert.deepEqual(updated.value.behavior, config);
    }
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "stop");
    assert.equal(fixture.service.updateBehaviorConfig(operator, fixture.record.id, 4, config).ok, false);
});

test("automatic follow and attack share a fair per-player action slot and honor cooldowns", () => {
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
            maxDistance: 6,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: false,
        },
    };
    assert.equal(fixture.service.updateBehaviorConfig(operator, fixture.record.id, 4, config).ok, true);
    fixture.runtime.actions.length = 0;
    fixture.queries.onlinePlayers.set("playfab-target", {
        id: "player-runtime",
        dimension: "minecraft:overworld",
        position: { x: 10, y: 64, z: 0 },
    });
    fixture.queries.attackTargets = [{
        id: "zombie-runtime",
        dimension: "minecraft:overworld",
        position: { x: 2, y: 64, z: 0 },
    }];

    assert.equal(fixture.service.tick(0).ok, true);
    assert.deepEqual(fixture.runtime.actions, [{
        kind: "navigate_entity",
        targetId: "player-runtime",
        speed: 0.8,
    }]);
    assert.equal(fixture.service.tick(1).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "attack_entity");
    assert.equal(fixture.runtime.actions.length, 2);
    assert.equal(fixture.service.tick(2).ok, true);
    assert.equal(fixture.runtime.actions.length, 2);
    assert.equal(fixture.service.tick(3).ok, true);
    assert.equal(fixture.runtime.actions.length, 3);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "attack_entity");
    assert.equal(fixture.service.tick(10).ok, true);
    assert.equal(fixture.runtime.actions.at(-1)?.kind, "navigate_entity");
});

test("automatic mine search consumes at most 256 unique block reads per tick and resumes", () => {
    const fixture = createFixture();
    const operator = { playerId: "operator", isOperator: true };
    const config = {
        ...createDefaultBehaviorConfig(),
        mine: {
            enabled: true,
            intervalTicks: 10,
            direction: "front" as const,
            blockTypeId: "minecraft:diamond_ore",
            searchRadius: 10,
            approach: false,
        },
    };
    fixture.queries.blockInfo = { typeId: "minecraft:stone", solid: true };
    assert.equal(fixture.service.updateBehaviorConfig(operator, fixture.record.id, 4, config).ok, true);
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