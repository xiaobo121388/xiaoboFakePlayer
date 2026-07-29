import { INVENTORY_SLOT_COUNT } from "../domain/inventory.js";
import { decodeBehaviorConfig } from "../domain/behavior.js";
import type {
    BehaviorConfig,
    DimensionKey,
    FakePlayerId,
    FakePlayerRecord,
    Point,
    SavedLocation,
} from "../domain/model.js";
import { isAllowed, type ActorIdentity } from "../domain/permissions.js";
import { err, ok, type Result } from "../domain/results.js";
import { InventoryService } from "./inventoryService.js";
import { OperationCoordinator } from "./operationCoordinator.js";
import type {
    BlockFace,
    FakePlayerRuntime,
    RuntimeActionReceipt,
    RuntimeBlockInfo,
    RuntimeFakePlayerAction,
    WorldQueries,
    WorldStateStore,
} from "./ports.js";

const MAX_INTERACTION_DISTANCE = 6;
const MAX_INTERACTION_DISTANCE_SQUARED = MAX_INTERACTION_DISTANCE * MAX_INTERACTION_DISTANCE;
const MAX_AUTOMATIC_ACTIONS_PER_TICK = 8;
const MAX_BLOCK_READS_PER_TICK = 256;
const ATTACK_QUERY_LIMIT = 16;
const AUTOMATIC_BEHAVIORS = ["follow", "attack", "mine", "use"] as const;

type AutomaticBehaviorKind = typeof AUTOMATIC_BEHAVIORS[number];

interface BehaviorTask {
    readonly key: string;
    readonly kind: AutomaticBehaviorKind;
    readonly record: FakePlayerRecord;
}

interface AutomaticBehaviorOutcome {
    readonly attempted: boolean;
    readonly accepted: boolean;
    readonly blockReads: number;
    readonly continueNextTick?: boolean;
}

interface MineScanState {
    readonly signature: string;
    readonly origin: Point;
    radius: number;
    cursor: number;
}

interface CachedMineTarget {
    readonly dimension: DimensionKey;
    readonly position: Point;
}

export interface BehaviorTickReport {
    readonly consideredTasks: number;
    readonly attemptedActions: number;
    readonly acceptedActions: number;
    readonly blockReads: number;
}

export type FakePlayerAction =
    | { readonly kind: "attack_entity"; readonly targetId: string }
    | { readonly kind: "break_block"; readonly dimension: DimensionKey; readonly position: Point; readonly face: BlockFace }
    | { readonly kind: "interact_block"; readonly dimension: DimensionKey; readonly position: Point; readonly face: BlockFace }
    | { readonly kind: "interact_entity"; readonly targetId: string }
    | { readonly kind: "jump" }
    | { readonly kind: "look_at"; readonly dimension: DimensionKey; readonly position: Point }
    | { readonly kind: "look_at_entity"; readonly targetId: string }
    | { readonly kind: "move_to"; readonly dimension: DimensionKey; readonly position: Point; readonly speed?: number }
    | { readonly kind: "navigate"; readonly dimension: DimensionKey; readonly position: Point; readonly speed?: number }
    | { readonly kind: "navigate_entity"; readonly targetId: string; readonly speed?: number }
    | { readonly kind: "rotate"; readonly angle: number }
    | { readonly kind: "set_rotation"; readonly angle: number }
    | { readonly kind: "set_sneaking"; readonly enabled: boolean }
    | { readonly kind: "stop" }
    | { readonly kind: "teleport"; readonly location: SavedLocation }
    | { readonly kind: "use_item"; readonly slot: number }
    | {
        readonly kind: "use_item_on_block";
        readonly slot: number;
        readonly dimension: DimensionKey;
        readonly position: Point;
        readonly face: BlockFace;
    };

export class BehaviorService {
    private readonly nextDueTicks = new Map<string, number>();
    private readonly following = new Set<FakePlayerId>();
    private readonly mineScans = new Map<FakePlayerId, MineScanState>();
    private readonly mineTargets = new Map<FakePlayerId, CachedMineTarget>();
    private lastTaskKey: string | undefined;

    public constructor(
        private readonly stateStore: WorldStateStore,
        private readonly runtime: FakePlayerRuntime,
        private readonly worldQueries: WorldQueries,
        private readonly coordinator: OperationCoordinator,
        private readonly inventory: InventoryService,
    ) {}

    public perform(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        action: FakePlayerAction,
    ): Result<RuntimeActionReceipt> {
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok) return err("CONFLICT", permissions.diagnostics.join("; "));
        if (!isAllowed(actor, permissions.state.value, "manage")) {
            return err("PERMISSION_DENIED", "你没有管理假人的权限。");
        }
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const catalog = this.stateStore.loadCatalog();
        if (!catalog.ok) return err("CONFLICT", catalog.diagnostics.join("; "));
        const record = catalog.state.value.records[id];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        if (record.lifecycle.kind !== "online") {
            return err("INVALID_STATE", `假人 ${id} 当前处于 ${record.lifecycle.kind}，不能执行动作。`);
        }
        const runtime = this.runtime.get(id);
        if (runtime === undefined || !runtime.alive) {
            return err("INVALID_STATE", `假人 ${id} 没有存活的在线实例。`);
        }
        const mapped = mapAction(id, action, runtime.dimension, this.worldQueries);
        if (!mapped.ok) return mapped;

        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const receipt = this.runtime.perform(id, mapped.value);
            if (receipt.accepted && receipt.inventoryChanged === true) this.inventory.markDirty(id);
            return receipt.accepted
                ? ok(receipt)
                : err("CONFLICT", `假人 ${id} 未接受 ${action.kind} 动作。`);
        } finally {
            lease.value.release();
        }
    }

    public updateBehaviorConfig(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        expectedConfig: BehaviorConfig,
        config: BehaviorConfig,
    ): Result<FakePlayerRecord> {
        const normalizedExpected = decodeBehaviorConfig(expectedConfig);
        const normalized = decodeBehaviorConfig(config);
        if (normalizedExpected === undefined || normalized === undefined) {
            return err("INVALID_STATE", "自动行为配置无效。");
        }
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok) return err("CONFLICT", permissions.diagnostics.join("; "));
        if (!isAllowed(actor, permissions.state.value, "manage")) {
            return err("PERMISSION_DENIED", "你没有管理假人的权限。");
        }
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const catalog = this.stateStore.loadCatalog();
            if (!catalog.ok) return err("CONFLICT", catalog.diagnostics.join("; "));
            const record = catalog.state.value.records[id];
            if (record === undefined) return err("NOT_FOUND", `未找到假人 ${id}。`);
            if (record.recordRevision !== expectedRecordRevision
                && !behaviorConfigsEqual(record.behavior, normalizedExpected)) {
                return err(
                    "STALE_REVISION",
                    `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`,
                );
            }
            if (behaviorConfigsEqual(record.behavior, normalized)) return ok(record);
            const nextRecord: FakePlayerRecord = {
                ...record,
                recordRevision: record.recordRevision + 1,
                behavior: normalized,
            };
            const committed = this.stateStore.commitCatalog(catalog.state.revision, {
                ...catalog.state.value,
                records: { ...catalog.state.value.records, [id]: nextRecord },
            });
            if (!committed.ok) return committed;

            this.clearRuntimeState(id);
            if (this.runtime.get(id) !== undefined) this.runtime.perform(id, { kind: "stop" });
            return ok(nextRecord);
        } finally {
            lease.value.release();
        }
    }

    public tick(currentTick: number): Result<BehaviorTickReport> {
        if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
            return err("INVALID_STATE", "行为调度 tick 必须是非负安全整数。");
        }
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const tasks = Object.values(loaded.state.value.records)
            .filter((record) => record.lifecycle.kind === "online" && this.runtime.get(record.id)?.alive === true)
            .sort((left, right) => left.id.localeCompare(right.id))
            .flatMap((record) => AUTOMATIC_BEHAVIORS
                .filter((kind) => record.behavior[kind].enabled)
                .map((kind): BehaviorTask => ({ key: `${record.id}:${kind}`, kind, record })));
        this.removeInactiveRuntimeState(tasks);
        if (tasks.length === 0) {
            this.lastTaskKey = undefined;
            return ok({ consideredTasks: 0, attemptedActions: 0, acceptedActions: 0, blockReads: 0 });
        }

        const lastIndex = tasks.findIndex((task) => task.key === this.lastTaskKey);
        const rotated = lastIndex < 0
            ? tasks
            : [...tasks.slice(lastIndex + 1), ...tasks.slice(0, lastIndex + 1)];
        const actedIds = new Set<FakePlayerId>();
        let consideredTasks = 0;
        let attemptedActions = 0;
        let acceptedActions = 0;
        let blockReads = 0;
        for (const task of rotated) {
            if (attemptedActions >= MAX_AUTOMATIC_ACTIONS_PER_TICK) break;
            if ((this.nextDueTicks.get(task.key) ?? 0) > currentTick || actedIds.has(task.record.id)) continue;
            if (task.kind === "mine" && blockReads >= MAX_BLOCK_READS_PER_TICK) continue;
            this.lastTaskKey = task.key;
            consideredTasks += 1;
            const lease = this.coordinator.tryAcquire([`fake:${task.record.id}`]);
            if (!lease.ok) continue;
            try {
                const outcome = this.runAutomaticBehavior(
                    task.record,
                    task.kind,
                    MAX_BLOCK_READS_PER_TICK - blockReads,
                );
                blockReads += outcome.blockReads;
                if (outcome.attempted) {
                    actedIds.add(task.record.id);
                    attemptedActions += 1;
                    if (outcome.accepted) acceptedActions += 1;
                }
                this.nextDueTicks.set(
                    task.key,
                    currentTick + (outcome.continueNextTick === true
                        ? 1
                        : task.record.behavior[task.kind].intervalTicks),
                );
            } finally {
                lease.value.release();
            }
        }
        return ok({ consideredTasks, attemptedActions, acceptedActions, blockReads });
    }

    private runAutomaticBehavior(
        record: FakePlayerRecord,
        kind: AutomaticBehaviorKind,
        blockBudget: number,
    ): AutomaticBehaviorOutcome {
        switch (kind) {
            case "follow": return this.runFollow(record);
            case "attack": return this.runAttack(record);
            case "mine": return this.runMine(record, blockBudget);
            case "use": return this.runUse(record);
        }
    }

    private runFollow(record: FakePlayerRecord): AutomaticBehaviorOutcome {
        const config = record.behavior.follow;
        const runtime = this.runtime.get(record.id);
        const target = config.targetPlayerId === null
            ? undefined
            : this.worldQueries.findOnlinePlayer(config.targetPlayerId);
        if (runtime === undefined || target === undefined || target.dimension !== runtime.dimension) {
            return this.stopFollowing(record.id);
        }
        if (distanceSquared(runtime.position, target.position) <= config.stopDistance * config.stopDistance) {
            return this.stopFollowing(record.id);
        }
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate_entity",
            targetId: target.id,
            speed: config.speed,
        });
        if (receipt.accepted) this.following.add(record.id);
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }

    private runAttack(record: FakePlayerRecord): AutomaticBehaviorOutcome {
        const config = record.behavior.attack;
        const runtime = this.runtime.get(record.id);
        if (runtime === undefined) return emptyOutcome();
        const targets = this.worldQueries.findAttackTargets(record.id, {
            maxDistance: config.maxDistance,
            families: config.targetFamilies,
            typeIds: config.targetTypeIds,
            limit: ATTACK_QUERY_LIMIT,
        });
        const reachSquared = Math.min(config.maxDistance, MAX_INTERACTION_DISTANCE) ** 2;
        for (const target of targets) {
            if (distanceSquared(runtime.position, target.position) > reachSquared
                || !this.worldQueries.hasLineOfSight(record.id, target.id)) continue;
            const receipt = this.executeRuntime(record.id, { kind: "attack_entity", targetId: target.id });
            return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
        }
        const chaseTarget = targets[0];
        if (!config.chase || chaseTarget === undefined) return emptyOutcome();
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate_entity",
            targetId: chaseTarget.id,
            speed: 1,
        });
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }

    private runMine(record: FakePlayerRecord, blockBudget: number): AutomaticBehaviorOutcome {
        const runtime = this.runtime.get(record.id);
        if (runtime === undefined || blockBudget <= 0) return emptyOutcome(true);
        const resolved = this.resolveMineTarget(record, runtime.position, runtime.dimension, blockBudget);
        if (resolved.target === undefined) {
            return {
                attempted: false,
                accepted: false,
                blockReads: resolved.blockReads,
                continueNextTick: resolved.scanPending,
            };
        }
        const target = resolved.target.position;
        if (this.worldQueries.hasBlockLineOfSight(
            record.id,
            resolved.target.dimension,
            target,
            MAX_INTERACTION_DISTANCE,
        )) {
            const receipt = this.executeRuntime(record.id, {
                kind: "break_block",
                position: target,
                face: mineTargetFace(runtime.position, target),
            });
            return { attempted: true, accepted: receipt.accepted, blockReads: resolved.blockReads };
        }
        if (!record.behavior.mine.approach) {
            return { attempted: false, accepted: false, blockReads: resolved.blockReads };
        }
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate",
            position: { x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5 },
            speed: 1,
        });
        return { attempted: true, accepted: receipt.accepted, blockReads: resolved.blockReads };
    }

    private resolveMineTarget(
        record: FakePlayerRecord,
        runtimePosition: Point,
        dimension: DimensionKey,
        blockBudget: number,
    ): { readonly target?: CachedMineTarget; readonly blockReads: number; readonly scanPending: boolean } {
        const config = record.behavior.mine;
        const cached = this.mineTargets.get(record.id);
        let blockReads = 0;
        if (cached !== undefined && cached.dimension === dimension) {
            const info = this.worldQueries.getBlockInfo(dimension, cached.position);
            blockReads += 1;
            if (isMineTarget(info, config.blockTypeId)) {
                return { target: cached, blockReads, scanPending: false };
            }
            this.mineTargets.delete(record.id);
        }

        const origin = directMineTarget(runtimePosition, this.runtime.get(record.id)?.rotation.y ?? 0, config.direction);
        if (config.blockTypeId === null || config.searchRadius === 0) {
            if (blockReads >= blockBudget) return { blockReads, scanPending: true };
            const info = this.worldQueries.getBlockInfo(dimension, origin);
            blockReads += 1;
            return isMineTarget(info, config.blockTypeId)
                ? { target: { dimension, position: origin }, blockReads, scanPending: false }
                : { blockReads, scanPending: false };
        }

        const signature = `${dimension}:${origin.x}:${origin.y}:${origin.z}:${config.blockTypeId}:${config.searchRadius}`;
        let scan = this.mineScans.get(record.id);
        if (scan === undefined || scan.signature !== signature) {
            scan = { signature, origin, radius: 0, cursor: 0 };
            this.mineScans.set(record.id, scan);
        }
        while (blockReads < blockBudget) {
            const offset = nextShellOffset(scan, config.searchRadius);
            if (offset === undefined) {
                this.mineScans.delete(record.id);
                return { blockReads, scanPending: false };
            }
            const position = addPoints(scan.origin, offset);
            const info = this.worldQueries.getBlockInfo(dimension, position);
            blockReads += 1;
            if (!isMineTarget(info, config.blockTypeId)) continue;
            const target = { dimension, position };
            this.mineScans.delete(record.id);
            this.mineTargets.set(record.id, target);
            return { target, blockReads, scanPending: false };
        }
        return { blockReads, scanPending: true };
    }

    private runUse(record: FakePlayerRecord): AutomaticBehaviorOutcome {
        const receipt = this.executeRuntime(record.id, {
            kind: "use_item",
            slot: record.behavior.use.slot,
        });
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }

    private stopFollowing(id: FakePlayerId): AutomaticBehaviorOutcome {
        if (!this.following.delete(id)) return emptyOutcome();
        const receipt = this.executeRuntime(id, { kind: "stop_moving" });
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }

    private executeRuntime(id: FakePlayerId, action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        const receipt = this.runtime.perform(id, action);
        if (receipt.accepted && receipt.inventoryChanged === true) this.inventory.markDirty(id);
        return receipt;
    }

    private clearRuntimeState(id: FakePlayerId): void {
        const prefix = `${id}:`;
        for (const key of this.nextDueTicks.keys()) {
            if (key.startsWith(prefix)) this.nextDueTicks.delete(key);
        }
        this.following.delete(id);
        this.mineScans.delete(id);
        this.mineTargets.delete(id);
    }

    private removeInactiveRuntimeState(tasks: readonly BehaviorTask[]): void {
        const activeKeys = new Set(tasks.map((task) => task.key));
        const activeIds = new Set(tasks.map((task) => task.record.id));
        for (const key of this.nextDueTicks.keys()) {
            if (!activeKeys.has(key)) this.nextDueTicks.delete(key);
        }
        for (const id of this.following) {
            if (!activeIds.has(id)) this.following.delete(id);
        }
        for (const id of this.mineScans.keys()) {
            if (!activeIds.has(id)) this.mineScans.delete(id);
        }
        for (const id of this.mineTargets.keys()) {
            if (!activeIds.has(id)) this.mineTargets.delete(id);
        }
    }
}

function emptyOutcome(continueNextTick = false): AutomaticBehaviorOutcome {
    return { attempted: false, accepted: false, blockReads: 0, continueNextTick };
}

function behaviorConfigsEqual(left: BehaviorConfig, right: BehaviorConfig): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isMineTarget(info: RuntimeBlockInfo | undefined, typeId: string | null): boolean {
    return info !== undefined && info.solid && (typeId === null || info.typeId === typeId);
}

function directMineTarget(position: Point, yaw: number, direction: BehaviorConfig["mine"]["direction"]): Point {
    const base = floorPoint(position);
    if (direction === "down") return { x: base.x, y: base.y - 1, z: base.z };
    if (direction === "up") return { x: base.x, y: base.y + 2, z: base.z };
    const radians = yaw * Math.PI / 180;
    return {
        x: base.x + Math.round(-Math.sin(radians)),
        y: base.y + 1,
        z: base.z + Math.round(Math.cos(radians)),
    };
}

function nextShellOffset(scan: MineScanState, maximumRadius: number): Point | undefined {
    while (scan.radius <= maximumRadius) {
        const width = scan.radius * 2 + 1;
        const volume = width * width * width;
        while (scan.cursor < volume) {
            const index = scan.cursor;
            scan.cursor += 1;
            const x = index % width - scan.radius;
            const y = Math.floor(index / width) % width - scan.radius;
            const z = Math.floor(index / (width * width)) - scan.radius;
            if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) === scan.radius) return { x, y, z };
        }
        scan.radius += 1;
        scan.cursor = 0;
    }
    return undefined;
}

function addPoints(left: Point, right: Point): Point {
    return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function mineTargetFace(origin: Point, target: Point): BlockFace {
    const x = target.x + 0.5 - origin.x;
    const y = target.y + 0.5 - origin.y;
    const z = target.z + 0.5 - origin.z;
    if (Math.abs(y) >= Math.abs(x) && Math.abs(y) >= Math.abs(z)) return y > 0 ? "down" : "up";
    if (Math.abs(x) >= Math.abs(z)) return x > 0 ? "west" : "east";
    return z > 0 ? "north" : "south";
}

function distanceSquared(left: Point, right: Point): number {
    const x = left.x - right.x;
    const y = left.y - right.y;
    const z = left.z - right.z;
    return x * x + y * y + z * z;
}

function mapAction(
    fakePlayerId: FakePlayerId,
    action: FakePlayerAction,
    runtimeDimension: string,
    worldQueries: WorldQueries,
): Result<RuntimeFakePlayerAction> {
    switch (action.kind) {
        case "jump":
        case "stop":
        case "set_sneaking":
            return ok(action);
        case "use_item":
            return validInventorySlot(action.slot)
                ? ok(action)
                : err("INVALID_SLOT", `物品槽位必须是 0 到 ${INVENTORY_SLOT_COUNT - 1} 的整数。`);
        case "rotate":
        case "set_rotation":
            return Number.isFinite(action.angle)
                ? ok(action)
                : err("INVALID_STATE", "旋转角度必须是有限数字。");
        case "look_at":
            if (!isFinitePoint(action.position)) return err("INVALID_STATE", "目标坐标必须是有限数字。");
            if (action.dimension !== runtimeDimension) {
                return err("INVALID_STATE", "假人只能看向同维度坐标。");
            }
            if (!worldQueries.isChunkLoaded(action.dimension, action.position)) {
                return err("INVALID_STATE", "目标坐标所在区块未加载。");
            }
            return ok({ kind: "look_at", position: action.position });
        case "look_at_entity":
        {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries);
            return target.ok ? ok(action) : target;
        }
        case "move_to": {
            const destination = validateCoordinateTarget(action.dimension, action.position, runtimeDimension, worldQueries);
            if (!destination.ok) return destination;
            const speed = normalizeSpeed(action.speed);
            return speed.ok ? ok({ kind: "move_to", position: action.position, speed: speed.value }) : speed;
        }
        case "navigate": {
            const destination = validateCoordinateTarget(action.dimension, action.position, runtimeDimension, worldQueries);
            if (!destination.ok) return destination;
            const speed = normalizeSpeed(action.speed);
            return speed.ok ? ok({ kind: "navigate", position: action.position, speed: speed.value }) : speed;
        }
        case "navigate_entity": {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries, false);
            if (!target.ok) return target;
            const speed = normalizeSpeed(action.speed);
            return speed.ok ? ok({ kind: "navigate_entity", targetId: action.targetId, speed: speed.value }) : speed;
        }
        case "teleport":
            if (!isFinitePoint(action.location.position)
                || !Number.isFinite(action.location.rotation.x)
                || !Number.isFinite(action.location.rotation.y)) {
                return err("INVALID_STATE", "传送坐标与旋转必须是有限数字。");
            }
            if (!worldQueries.isChunkLoaded(action.location.dimension, action.location.position)) {
                return err("INVALID_STATE", "传送目标所在区块未加载。");
            }
            return ok(action);
        case "attack_entity":
        case "interact_entity": {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries);
            return target.ok ? ok(action) : target;
        }
        case "break_block":
        case "interact_block": {
            const target = validateBlockTarget(fakePlayerId, action, runtimeDimension, worldQueries);
            return target.ok
                ? ok({ kind: action.kind, position: target.value, face: action.face })
                : target;
        }
        case "use_item_on_block": {
            if (!validInventorySlot(action.slot)) {
                return err("INVALID_SLOT", `物品槽位必须是 0 到 ${INVENTORY_SLOT_COUNT - 1} 的整数。`);
            }
            const target = validateBlockTarget(fakePlayerId, action, runtimeDimension, worldQueries);
            return target.ok
                ? ok({ kind: action.kind, slot: action.slot, position: target.value, face: action.face })
                : target;
        }
    }
}

function validateCoordinateTarget(
    dimension: DimensionKey,
    position: Point,
    runtimeDimension: DimensionKey,
    worldQueries: WorldQueries,
): Result<void> {
    if (!isFinitePoint(position)) return err("INVALID_STATE", "目标坐标必须是有限数字。");
    if (dimension !== runtimeDimension) return err("INVALID_STATE", "移动目标必须与假人位于同一维度。");
    return worldQueries.isChunkLoaded(dimension, position)
        ? ok(undefined)
        : err("INVALID_STATE", "目标坐标所在区块未加载。");
}

function validateEntityTarget(
    fakePlayerId: FakePlayerId,
    targetId: string,
    worldQueries: WorldQueries,
    requireReach = true,
): Result<void> {
    if (targetId.length === 0) return err("NOT_FOUND", "目标实体已失效。");
    const distanceSquared = worldQueries.distanceSquared(fakePlayerId, targetId);
    if (distanceSquared === undefined) return err("NOT_FOUND", "目标实体不存在或不在同一维度。");
    if (requireReach && distanceSquared > MAX_INTERACTION_DISTANCE_SQUARED) {
        return err("INVALID_STATE", `目标实体距离超过 ${MAX_INTERACTION_DISTANCE} 格。`);
    }
    if (requireReach && !worldQueries.hasLineOfSight(fakePlayerId, targetId)) {
        return err("INVALID_STATE", "目标实体被方块遮挡。");
    }
    return ok(undefined);
}

function validateBlockTarget(
    fakePlayerId: FakePlayerId,
    action: { readonly dimension: DimensionKey; readonly position: Point },
    runtimeDimension: DimensionKey,
    worldQueries: WorldQueries,
): Result<Point> {
    const coordinate = validateCoordinateTarget(action.dimension, action.position, runtimeDimension, worldQueries);
    if (!coordinate.ok) return coordinate;
    const position = floorPoint(action.position);
    if (!worldQueries.isSolidBlock(action.dimension, position)) {
        return err("INVALID_STATE", "目标位置不是可交互的固体方块。");
    }
    if (!worldQueries.hasBlockLineOfSight(
        fakePlayerId,
        action.dimension,
        position,
        MAX_INTERACTION_DISTANCE,
    )) {
        return err("INVALID_STATE", `目标方块不在 ${MAX_INTERACTION_DISTANCE} 格可见范围内。`);
    }
    return ok(position);
}

function normalizeSpeed(speed: number | undefined): Result<number> {
    const value = speed ?? 1;
    return Number.isFinite(value) && value >= 0 && value <= 1
        ? ok(value)
        : err("INVALID_STATE", "移动速度必须在 0 到 1 之间。");
}

function validInventorySlot(slot: number): boolean {
    return Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SLOT_COUNT;
}

function isFinitePoint(point: Point): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function floorPoint(point: Point): Point {
    return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
}