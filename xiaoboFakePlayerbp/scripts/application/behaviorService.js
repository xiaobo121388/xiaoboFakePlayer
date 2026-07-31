import { HOTBAR_SLOT_COUNT, INVENTORY_SLOT_COUNT } from "../domain/inventory.js";
import { decodeBehaviorConfig, EXCLUSIVE_ACTION_BEHAVIORS, normalizeExclusiveActionBehaviors, } from "../domain/behavior.js";
import { isAllowed } from "../domain/permissions.js";
import { err, ok } from "../domain/results.js";
const MAX_INTERACTION_DISTANCE = 6;
const MAX_ENTITY_INTERACTION_DISTANCE = 10;
const MAX_AUTOMATIC_ACTIONS_PER_TICK = 8;
const MAX_BLOCK_READS_PER_TICK = 256;
const ATTACK_QUERY_LIMIT = 16;
const ONE_SHOT_NAVIGATION_ARRIVAL_DISTANCE_SQUARED = 1;
// 公开 API 不暴露导航状态；连续 20 tick 未移动 0.1 格时按引擎已因卡住停止处理。
const ONE_SHOT_NAVIGATION_PROGRESS_DISTANCE_SQUARED = 0.01;
const ONE_SHOT_NAVIGATION_STALL_TICKS = 20;
// 挂机假人的“面前”语义是眼睛视线 7 格内的首个方块命中。
const FRONT_MINE_RAY_DISTANCE = 7;
const FRONT_PLACE_RAY_DISTANCE = 7;
// 非射线目标没有原生命中面，以眼睛位置推导破坏面。
const MINE_EYE_HEIGHT = 1.62;
const AUTOMATIC_BEHAVIORS = ["follow", "attack", "mine", "place", "use"];
const CHEST_BLOCK_TYPE_IDS = new Set([
    "minecraft:chest",
    "minecraft:ender_chest",
    "minecraft:trapped_chest",
]);
const PLACEMENT_SUPPORTS = [
    { offset: { x: 0, y: -1, z: 0 }, face: "up" },
    { offset: { x: 0, y: 1, z: 0 }, face: "down" },
    { offset: { x: 0, y: 0, z: -1 }, face: "south" },
    { offset: { x: 0, y: 0, z: 1 }, face: "north" },
    { offset: { x: -1, y: 0, z: 0 }, face: "east" },
    { offset: { x: 1, y: 0, z: 0 }, face: "west" },
];
export class BehaviorService {
    stateStore;
    runtime;
    worldQueries;
    coordinator;
    inventory;
    nextDueTicks = new Map();
    following = new Set();
    mineScans = new Map();
    mineTargets = new Map();
    activeMineTargets = new Map();
    oneShotNavigations = new Map();
    lastTaskKey;
    constructor(stateStore, runtime, worldQueries, coordinator, inventory) {
        this.stateStore = stateStore;
        this.runtime = runtime;
        this.worldQueries = worldQueries;
        this.coordinator = coordinator;
        this.inventory = inventory;
    }
    perform(actor, id, expectedRecordRevision, action) {
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok)
            return err("CONFLICT", permissions.diagnostics.join("; "));
        if (!isAllowed(actor, permissions.state.value, "manage")) {
            return err("PERMISSION_DENIED", "你没有管理假人的权限。");
        }
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok)
            return available;
        const catalog = this.stateStore.loadCatalog();
        if (!catalog.ok)
            return err("CONFLICT", catalog.diagnostics.join("; "));
        const record = catalog.state.value.records[id];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${id}。`);
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
        const mapped = mapAction(id, action, runtime, this.worldQueries);
        if (!mapped.ok)
            return mapped;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok)
            return lease;
        try {
            const receipt = this.executeRuntime(id, mapped.value);
            if (receipt.accepted)
                this.recordOneShotNavigation(id, mapped.value, runtime);
            return receipt.accepted
                ? ok(receipt)
                : err("CONFLICT", `假人 ${id} 未接受 ${action.kind} 动作。`);
        }
        finally {
            lease.value.release();
        }
    }
    listInteractionTargets(actor, id, expectedRecordRevision, typeId) {
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok)
            return err("CONFLICT", permissions.diagnostics.join("; "));
        if (!isAllowed(actor, permissions.state.value, "manage")) {
            return err("PERMISSION_DENIED", "你没有管理假人的权限。");
        }
        const catalog = this.stateStore.loadCatalog();
        if (!catalog.ok)
            return err("CONFLICT", catalog.diagnostics.join("; "));
        const record = catalog.state.value.records[id];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        if (record.lifecycle.kind !== "online") {
            return err("INVALID_STATE", `假人 ${id} 当前处于 ${record.lifecycle.kind}，不能查找实体。`);
        }
        const runtime = this.runtime.get(id);
        if (runtime === undefined || !runtime.alive) {
            return err("INVALID_STATE", `假人 ${id} 没有存活的在线实例。`);
        }
        const normalizedTypeId = typeId?.trim();
        if (normalizedTypeId !== undefined && !validEntityTypeId(normalizedTypeId)) {
            return err("INVALID_STATE", "实体 ID 必须是 namespace:path 格式的小写标识符。");
        }
        return ok(this.worldQueries.findInteractionTargets(id, {
            maxDistance: MAX_ENTITY_INTERACTION_DISTANCE,
            ...(normalizedTypeId === undefined ? {} : { typeId: normalizedTypeId }),
        }).map((target) => toEntityInteractionTarget(runtime, target)));
    }
    updateBehaviorConfig(actor, id, expectedRecordRevision, expectedConfig, config) {
        const normalizedExpected = decodeBehaviorConfig(expectedConfig);
        const normalized = decodeBehaviorConfig(config);
        if (normalizedExpected === undefined || normalized === undefined) {
            return err("INVALID_STATE", "自动行为配置无效。");
        }
        if (normalized.place.selectionMode === "slot"
            && normalized.place.slot >= HOTBAR_SLOT_COUNT
            && JSON.stringify(normalized.place) !== JSON.stringify(normalizedExpected.place)) {
            return err("INVALID_SLOT", `自动交互快捷栏必须是 0 到 ${HOTBAR_SLOT_COUNT - 1} 的整数。`);
        }
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok)
            return err("CONFLICT", permissions.diagnostics.join("; "));
        if (!isAllowed(actor, permissions.state.value, "manage")) {
            return err("PERMISSION_DENIED", "你没有管理假人的权限。");
        }
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok)
            return available;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok)
            return lease;
        try {
            const catalog = this.stateStore.loadCatalog();
            if (!catalog.ok)
                return err("CONFLICT", catalog.diagnostics.join("; "));
            const record = catalog.state.value.records[id];
            if (record === undefined)
                return err("NOT_FOUND", `未找到假人 ${id}。`);
            if (record.recordRevision !== expectedRecordRevision
                && !behaviorConfigsEqual(record.behavior, normalizedExpected)) {
                return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
            }
            const newlyEnabled = EXCLUSIVE_ACTION_BEHAVIORS.filter((kind) => !record.behavior[kind].enabled && normalized[kind].enabled);
            if (newlyEnabled.length > 1) {
                return err("INVALID_STATE", "攻击、挖掘、放置和定时使用一次只能启用一种。");
            }
            const nextBehavior = normalizeExclusiveActionBehaviors(normalized, newlyEnabled[0]);
            if (behaviorConfigsEqual(record.behavior, nextBehavior))
                return ok(record);
            const nextRecord = {
                ...record,
                recordRevision: record.recordRevision + 1,
                behavior: nextBehavior,
            };
            const committed = this.stateStore.commitCatalog(catalog.state.revision, {
                ...catalog.state.value,
                records: { ...catalog.state.value.records, [id]: nextRecord },
            });
            if (!committed.ok)
                return committed;
            this.clearRuntimeState(id);
            if (this.runtime.get(id) !== undefined)
                this.runtime.perform(id, { kind: "stop" });
            return ok(nextRecord);
        }
        finally {
            lease.value.release();
        }
    }
    notifyBlockBroken(id, dimension, position) {
        const activeTarget = this.activeMineTargets.get(id);
        if (activeTarget === undefined
            || activeTarget.dimension !== dimension
            || activeTarget.position.x !== position.x
            || activeTarget.position.y !== position.y
            || activeTarget.position.z !== position.z)
            return;
        this.activeMineTargets.delete(id);
        this.mineTargets.delete(id);
    }
    tick(currentTick) {
        if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
            return err("INVALID_STATE", "行为调度 tick 必须是非负安全整数。");
        }
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const operations = this.stateStore.loadOperations();
        if (!operations.ok)
            return err("CONFLICT", operations.diagnostics.join("; "));
        const pendingIds = new Set([
            ...Object.values(operations.state.value.inventoryTransfers).map((transfer) => transfer.fakePlayerId),
            ...Object.values(operations.state.value.experienceTransfers).map((transfer) => transfer.fakePlayerId),
        ]);
        const records = Object.values(loaded.state.value.records)
            .filter((record) => (record.lifecycle.kind === "online"
            && this.runtime.get(record.id)?.alive === true))
            .sort((left, right) => left.id.localeCompare(right.id));
        const activeIds = new Set(records.map((record) => record.id));
        for (const id of this.oneShotNavigations.keys()) {
            if (!activeIds.has(id))
                this.oneShotNavigations.delete(id);
        }
        for (const record of records)
            this.refreshOneShotNavigation(record.id);
        const tasks = records
            .filter((record) => !pendingIds.has(record.id))
            .flatMap((record) => AUTOMATIC_BEHAVIORS
            .filter((kind) => record.behavior[kind].enabled)
            .map((kind) => ({ key: `${record.id}:${kind}`, kind, record })));
        this.removeInactiveRuntimeState(tasks);
        if (tasks.length === 0) {
            this.lastTaskKey = undefined;
            return ok({ consideredTasks: 0, attemptedActions: 0, acceptedActions: 0, blockReads: 0 });
        }
        const lastIndex = tasks.findIndex((task) => task.key === this.lastTaskKey);
        const rotated = lastIndex < 0
            ? tasks
            : [...tasks.slice(lastIndex + 1), ...tasks.slice(0, lastIndex + 1)];
        const actedIds = new Set();
        let consideredTasks = 0;
        let attemptedActions = 0;
        let acceptedActions = 0;
        let blockReads = 0;
        let mineDiagnostic;
        let placeDiagnostic;
        for (const task of rotated) {
            if (attemptedActions >= MAX_AUTOMATIC_ACTIONS_PER_TICK)
                break;
            if (task.kind !== "mine" && this.activeMineTargets.has(task.record.id))
                continue;
            if ((this.nextDueTicks.get(task.key) ?? 0) > currentTick || actedIds.has(task.record.id))
                continue;
            if ((task.kind === "mine" || task.kind === "place")
                && blockReads >= MAX_BLOCK_READS_PER_TICK)
                continue;
            this.lastTaskKey = task.key;
            consideredTasks += 1;
            const lease = this.coordinator.tryAcquire([`fake:${task.record.id}`]);
            if (!lease.ok)
                continue;
            try {
                const outcome = this.runAutomaticBehavior(task.record, task.kind, MAX_BLOCK_READS_PER_TICK - blockReads);
                blockReads += outcome.blockReads;
                if (outcome.mineDiagnostic !== undefined)
                    mineDiagnostic = outcome.mineDiagnostic;
                if (outcome.placeDiagnostic !== undefined)
                    placeDiagnostic = outcome.placeDiagnostic;
                if (outcome.attempted) {
                    actedIds.add(task.record.id);
                    attemptedActions += 1;
                    if (outcome.accepted)
                        acceptedActions += 1;
                }
                this.nextDueTicks.set(task.key, currentTick + (outcome.continueNextTick === true
                    ? 1
                    : task.record.behavior[task.kind].intervalTicks));
            }
            finally {
                lease.value.release();
            }
        }
        return ok({
            consideredTasks,
            attemptedActions,
            acceptedActions,
            blockReads,
            ...(mineDiagnostic === undefined ? {} : { mineDiagnostic }),
            ...(placeDiagnostic === undefined ? {} : { placeDiagnostic }),
        });
    }
    runAutomaticBehavior(record, kind, blockBudget) {
        switch (kind) {
            case "follow": return this.runFollow(record);
            case "attack": return this.runAttack(record);
            case "mine": return this.runMine(record, blockBudget);
            case "place": return this.runPlace(record, blockBudget);
            case "use": return this.runUse(record);
        }
    }
    canUseAutomaticNavigation(record, source) {
        if (this.oneShotNavigations.has(record.id))
            return false;
        if (!record.behavior.follow.enabled || !hasNonFollowPathfinding(record))
            return true;
        return (source === "follow") === this.shouldPrioritizeFollow(record);
    }
    shouldPrioritizeFollow(record) {
        const runtime = this.runtime.get(record.id);
        const config = record.behavior.follow;
        const target = config.targetPlayerId === null
            ? undefined
            : this.worldQueries.findOnlinePlayer(config.targetPlayerId);
        return runtime !== undefined
            && target !== undefined
            && target.dimension === runtime.dimension
            && distanceSquared(runtime.position, target.position) > config.stopDistance * config.stopDistance;
    }
    runFollow(record) {
        if (this.oneShotNavigations.has(record.id))
            return emptyOutcome(true);
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
        if (!this.canUseAutomaticNavigation(record, "follow"))
            return this.stopFollowing(record.id);
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate_entity",
            targetId: target.id,
            speed: config.speed,
        });
        if (receipt.accepted)
            this.following.add(record.id);
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }
    runAttack(record) {
        const config = record.behavior.attack;
        const runtime = this.runtime.get(record.id);
        if (runtime === undefined)
            return emptyOutcome();
        const targets = this.worldQueries.findAttackTargets(record.id, {
            maxDistance: config.maxDistance,
            families: config.targetFamilies,
            typeIds: config.targetTypeIds,
            limit: ATTACK_QUERY_LIMIT,
        });
        const reachSquared = Math.min(config.maxDistance, MAX_INTERACTION_DISTANCE) ** 2;
        for (const target of targets) {
            if (distanceSquared(runtime.position, target.position) > reachSquared
                || !this.worldQueries.hasLineOfSight(record.id, target.id))
                continue;
            const receipt = this.executeRuntime(record.id, { kind: "attack_entity", targetId: target.id });
            return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
        }
        const chaseTarget = targets[0];
        if (!config.chase || chaseTarget === undefined)
            return emptyOutcome();
        if (!this.canUseAutomaticNavigation(record, "other"))
            return emptyOutcome(true);
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate_entity",
            targetId: chaseTarget.id,
            speed: 1,
        });
        if (receipt.accepted)
            this.following.delete(record.id);
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }
    runMine(record, blockBudget) {
        const runtime = this.runtime.get(record.id);
        if (runtime === undefined || blockBudget <= 0)
            return emptyOutcome(true);
        let blockReads = 0;
        const activeTarget = this.activeMineTargets.get(record.id);
        if (activeTarget !== undefined && activeTarget.dimension === runtime.dimension) {
            const info = this.worldQueries.getBlockInfo(activeTarget.dimension, activeTarget.position);
            blockReads += 1;
            if (isMineTarget(info, record.behavior.mine.blockTypeId)) {
                return {
                    attempted: false,
                    accepted: false,
                    blockReads,
                    mineDiagnostic: describeMine(record, "waiting", activeTarget.position, info),
                };
            }
        }
        if (activeTarget !== undefined) {
            this.activeMineTargets.delete(record.id);
            this.mineTargets.delete(record.id);
        }
        if (blockReads >= blockBudget) {
            return { attempted: false, accepted: false, blockReads, continueNextTick: true };
        }
        const resolved = this.resolveMineTarget(record, runtime.position, runtime.dimension, blockBudget - blockReads);
        blockReads += resolved.blockReads;
        if (resolved.target === undefined) {
            return {
                attempted: false,
                accepted: false,
                blockReads,
                continueNextTick: resolved.scanPending,
                mineDiagnostic: resolved.diagnostic,
            };
        }
        const target = resolved.target.position;
        const inReach = resolved.target.distance === undefined
            ? this.worldQueries.hasBlockLineOfSight(record.id, resolved.target.dimension, target, MAX_INTERACTION_DISTANCE)
            : resolved.target.distance <= MAX_INTERACTION_DISTANCE;
        if (inReach) {
            const receipt = this.executeRuntime(record.id, {
                kind: "break_block",
                position: target,
                face: resolved.target.face ?? mineTargetFace(eyePosition(runtime.position), target),
            });
            if (receipt.accepted)
                this.activeMineTargets.set(record.id, resolved.target);
            return {
                attempted: true,
                accepted: receipt.accepted,
                blockReads,
                mineDiagnostic: describeMine(record, receipt.accepted ? "starting" : "rejected", target),
            };
        }
        if (!record.behavior.mine.approach) {
            return {
                attempted: false,
                accepted: false,
                blockReads,
                mineDiagnostic: describeMine(record, "blocked", target),
            };
        }
        if (!this.canUseAutomaticNavigation(record, "other")) {
            return {
                attempted: false,
                accepted: false,
                blockReads,
                continueNextTick: true,
                mineDiagnostic: describeMine(record, "deferred", target),
            };
        }
        const receipt = this.executeRuntime(record.id, {
            kind: "navigate",
            position: { x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5 },
            speed: 1,
        });
        if (receipt.accepted)
            this.following.delete(record.id);
        return {
            attempted: true,
            accepted: receipt.accepted,
            blockReads,
            mineDiagnostic: describeMine(record, "approaching", target),
        };
    }
    resolveMineTarget(record, runtimePosition, dimension, blockBudget) {
        const config = record.behavior.mine;
        if (config.direction === "front") {
            if (blockBudget < 1)
                return { blockReads: 0, scanPending: true };
            const hit = this.worldQueries.getBlockFromViewDirection(record.id, FRONT_MINE_RAY_DISTANCE);
            if (hit === undefined) {
                return {
                    blockReads: 0,
                    scanPending: false,
                    diagnostic: describeMine(record, "no_target", floorPoint(eyePosition(runtimePosition))),
                };
            }
            const info = this.worldQueries.getBlockInfo(dimension, hit.position);
            if (!isMineTarget(info, config.blockTypeId)) {
                return {
                    blockReads: 1,
                    scanPending: false,
                    diagnostic: describeMine(record, "no_target", hit.position, info),
                };
            }
            return {
                target: { dimension, position: hit.position, face: hit.face, distance: hit.distance },
                blockReads: 1,
                scanPending: false,
            };
        }
        const cached = this.mineTargets.get(record.id);
        let blockReads = 0;
        if (cached !== undefined && cached.dimension === dimension) {
            const info = this.worldQueries.getBlockInfo(dimension, cached.position);
            blockReads += 1;
            if (isMineTarget(info, config.blockTypeId)) {
                if (config.approach || this.worldQueries.hasBlockLineOfSight(record.id, dimension, cached.position, MAX_INTERACTION_DISTANCE)) {
                    return { target: cached, blockReads, scanPending: false };
                }
            }
            this.mineTargets.delete(record.id);
        }
        const origin = directMineTarget(runtimePosition, config.direction);
        if (config.searchRadius === 0) {
            if (blockReads >= blockBudget)
                return { blockReads, scanPending: true };
            const info = this.worldQueries.getBlockInfo(dimension, origin);
            blockReads += 1;
            return isMineTarget(info, config.blockTypeId)
                ? { target: { dimension, position: origin }, blockReads, scanPending: false }
                : {
                    blockReads,
                    scanPending: false,
                    diagnostic: describeMine(record, "no_target", origin, info),
                };
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
                return {
                    blockReads,
                    scanPending: false,
                    diagnostic: describeMine(record, "no_target", scan.origin),
                };
            }
            const position = addPoints(scan.origin, offset);
            const info = this.worldQueries.getBlockInfo(dimension, position);
            blockReads += 1;
            if (!isMineTarget(info, config.blockTypeId))
                continue;
            if (!config.approach && !this.worldQueries.hasBlockLineOfSight(record.id, dimension, position, MAX_INTERACTION_DISTANCE))
                continue;
            const target = { dimension, position };
            this.mineScans.delete(record.id);
            this.mineTargets.set(record.id, target);
            return { target, blockReads, scanPending: false };
        }
        return {
            blockReads,
            scanPending: true,
            diagnostic: describeMine(record, "scanning", scan.origin),
        };
    }
    runUse(record) {
        const receipt = this.executeRuntime(record.id, {
            kind: "use_item",
            slot: record.behavior.use.slot,
        });
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }
    runPlace(record, blockBudget) {
        const runtime = this.runtime.get(record.id);
        if (runtime === undefined) {
            return { ...emptyOutcome(), placeDiagnostic: describePlace(record, "runtime_missing") };
        }
        if (blockBudget <= 0) {
            return { ...emptyOutcome(true), placeDiagnostic: describePlace(record, "block_budget_exhausted") };
        }
        const config = record.behavior.place;
        if (config.selectionMode === "slot" && config.slot >= HOTBAR_SLOT_COUNT) {
            return { ...emptyOutcome(), placeDiagnostic: describePlace(record, "hotbar_slot_invalid") };
        }
        const inventorySlot = this.runtime.resolveInventorySlot(record.id, config.selectionMode === "slot"
            ? { mode: "slot", slot: config.slot }
            : { mode: "item", itemTypeId: config.itemTypeId });
        if (inventorySlot === undefined) {
            const state = config.itemTypeId === null ? "empty_slot_missing" : "item_not_found";
            return { ...emptyOutcome(), placeDiagnostic: describePlace(record, state) };
        }
        if (config.mode === "front") {
            const hit = this.worldQueries.getBlockFromViewDirection(record.id, FRONT_PLACE_RAY_DISTANCE);
            if (hit === undefined) {
                return { ...emptyOutcome(), placeDiagnostic: describePlace(record, "no_view_hit") };
            }
            if (hit.distance > MAX_INTERACTION_DISTANCE) {
                return {
                    ...emptyOutcome(),
                    placeDiagnostic: describePlace(record, "out_of_range", undefined, undefined, hit.position, hit.face, hit.distance),
                };
            }
            const support = this.worldQueries.getBlockInfo(runtime.dimension, hit.position);
            const target = addPoints(hit.position, faceOffset(hit.face));
            if (support === undefined || isAirBlock(support)) {
                return {
                    attempted: false,
                    accepted: false,
                    blockReads: 1,
                    placeDiagnostic: describePlace(record, "target_missing", undefined, support, hit.position, hit.face, hit.distance),
                };
            }
            const chestSupport = CHEST_BLOCK_TYPE_IDS.has(support.typeId);
            const directPlacement = chestSupport && runtime.isSneaking && inventorySlot.placeableBlock;
            if (!directPlacement && (!inventorySlot.placeableBlock || support.solid !== true)) {
                const receipt = this.executeRuntime(record.id, {
                    kind: "interact_block",
                    position: hit.position,
                    face: hit.face,
                    preserveView: true,
                    selection: config.selectionMode === "slot"
                        ? { mode: "slot", slot: inventorySlot.slot }
                        : {
                            mode: "item",
                            slot: inventorySlot.slot,
                            emptyHand: inventorySlot.itemTypeId === null,
                        },
                });
                return {
                    attempted: true,
                    accepted: receipt.accepted,
                    blockReads: 1,
                    placeDiagnostic: describePlace(record, receipt.accepted ? "accepted" : "runtime_rejected", undefined, support, hit.position, hit.face, hit.distance, inventorySlot),
                };
            }
            if (blockBudget < 2) {
                return {
                    ...emptyOutcome(true),
                    placeDiagnostic: describePlace(record, "block_budget_exhausted"),
                };
            }
            const targetInfo = this.worldQueries.getBlockInfo(runtime.dimension, target);
            if (support === undefined || (!chestSupport && support.solid !== true)) {
                return {
                    attempted: false,
                    accepted: false,
                    blockReads: 2,
                    placeDiagnostic: describePlace(record, "support_not_solid", target, targetInfo, hit.position, hit.face, hit.distance),
                };
            }
            if (!isAirBlock(targetInfo)) {
                return {
                    attempted: false,
                    accepted: false,
                    blockReads: 2,
                    placeDiagnostic: describePlace(record, "target_not_air", target, targetInfo, hit.position, hit.face, hit.distance),
                };
            }
            const receipt = this.executeRuntime(record.id, directPlacement
                ? { kind: "place_block_direct", slot: inventorySlot.slot, position: target }
                : {
                    kind: "build_block",
                    position: hit.position,
                    face: hit.face,
                    preserveView: true,
                    target,
                    selection: config.selectionMode === "slot"
                        ? { mode: "slot", slot: inventorySlot.slot }
                        : { mode: "item", slot: inventorySlot.slot, emptyHand: false },
                });
            return {
                attempted: true,
                accepted: receipt.accepted,
                blockReads: 2,
                placeDiagnostic: describePlace(record, receipt.accepted ? "accepted" : "runtime_rejected", target, targetInfo, hit.position, hit.face, hit.distance, inventorySlot),
            };
        }
        const target = config.position;
        if (target === null) {
            return { ...emptyOutcome(), placeDiagnostic: describePlace(record, "target_missing") };
        }
        const targetInfo = this.worldQueries.getBlockInfo(runtime.dimension, target);
        let blockReads = 1;
        if (targetInfo !== undefined
            && !isAirBlock(targetInfo)
            && (!inventorySlot.placeableBlock || targetInfo.solid !== true)) {
            const face = mineTargetFace(runtime.headPosition, target);
            const receipt = this.executeRuntime(record.id, {
                kind: "interact_block",
                position: target,
                face,
                selection: config.selectionMode === "slot"
                    ? { mode: "slot", slot: inventorySlot.slot }
                    : {
                        mode: "item",
                        slot: inventorySlot.slot,
                        emptyHand: inventorySlot.itemTypeId === null,
                    },
            });
            return {
                attempted: true,
                accepted: receipt.accepted,
                blockReads,
                placeDiagnostic: describePlace(record, receipt.accepted ? "accepted" : "runtime_rejected", target, targetInfo, target, face, undefined, inventorySlot),
            };
        }
        if (!isAirBlock(targetInfo)) {
            return {
                attempted: false,
                accepted: false,
                blockReads,
                placeDiagnostic: describePlace(record, "target_not_air", target, targetInfo),
            };
        }
        for (const candidate of PLACEMENT_SUPPORTS) {
            if (blockReads >= blockBudget) {
                return {
                    attempted: false,
                    accepted: false,
                    blockReads,
                    continueNextTick: true,
                    placeDiagnostic: describePlace(record, "block_budget_exhausted", target, targetInfo),
                };
            }
            const supportPosition = addPoints(target, candidate.offset);
            const support = this.worldQueries.getBlockInfo(runtime.dimension, supportPosition);
            blockReads += 1;
            if (support === undefined)
                continue;
            const chestSupport = CHEST_BLOCK_TYPE_IDS.has(support.typeId);
            const directPlacement = chestSupport && inventorySlot.placeableBlock;
            if (!chestSupport && support.solid !== true)
                continue;
            const receipt = this.executeRuntime(record.id, directPlacement
                ? { kind: "place_block_direct", slot: inventorySlot.slot, position: target }
                : inventorySlot.placeableBlock
                    ? {
                        kind: "build_block",
                        position: supportPosition,
                        face: candidate.face,
                        target,
                        selection: config.selectionMode === "slot"
                            ? { mode: "slot", slot: inventorySlot.slot }
                            : { mode: "item", slot: inventorySlot.slot, emptyHand: false },
                    }
                    : {
                        kind: "interact_block",
                        position: supportPosition,
                        face: candidate.face,
                        selection: config.selectionMode === "slot"
                            ? { mode: "slot", slot: inventorySlot.slot }
                            : {
                                mode: "item",
                                slot: inventorySlot.slot,
                                emptyHand: inventorySlot.itemTypeId === null,
                            },
                    });
            return {
                attempted: true,
                accepted: receipt.accepted,
                blockReads,
                placeDiagnostic: describePlace(record, receipt.accepted ? "accepted" : "runtime_rejected", target, targetInfo, supportPosition, candidate.face, undefined, inventorySlot),
            };
        }
        return {
            attempted: false,
            accepted: false,
            blockReads,
            placeDiagnostic: describePlace(record, "no_solid_support", target, targetInfo),
        };
    }
    stopFollowing(id) {
        if (!this.following.delete(id))
            return emptyOutcome();
        const receipt = this.executeRuntime(id, { kind: "stop_moving" });
        return { attempted: true, accepted: receipt.accepted, blockReads: 0 };
    }
    recordOneShotNavigation(id, action, runtime) {
        if (action.kind === "navigate") {
            this.oneShotNavigations.set(id, {
                target: { kind: "location", dimension: runtime.dimension, position: { ...action.position } },
                lastPosition: { ...runtime.position },
                stalledTicks: 0,
            });
            this.following.delete(id);
        }
        else if (action.kind === "navigate_entity") {
            this.oneShotNavigations.set(id, {
                target: { kind: "entity", targetId: action.targetId },
                lastPosition: { ...runtime.position },
                stalledTicks: 0,
            });
            this.following.delete(id);
        }
        else if (action.kind === "move_to" || action.kind === "stop" || action.kind === "teleport") {
            this.oneShotNavigations.delete(id);
        }
    }
    refreshOneShotNavigation(id) {
        const navigation = this.oneShotNavigations.get(id);
        if (navigation === undefined)
            return;
        const runtime = this.runtime.get(id);
        if (runtime === undefined || !runtime.alive || oneShotNavigationReached(id, runtime, navigation.target, this.worldQueries)) {
            this.oneShotNavigations.delete(id);
            return;
        }
        if (distanceSquared(runtime.position, navigation.lastPosition)
            > ONE_SHOT_NAVIGATION_PROGRESS_DISTANCE_SQUARED) {
            navigation.lastPosition = { ...runtime.position };
            navigation.stalledTicks = 0;
            return;
        }
        navigation.stalledTicks += 1;
        if (navigation.stalledTicks >= ONE_SHOT_NAVIGATION_STALL_TICKS) {
            this.oneShotNavigations.delete(id);
        }
    }
    executeRuntime(id, action) {
        const receipt = this.runtime.perform(id, action);
        if (receipt.accepted && interruptsMining(action.kind))
            this.activeMineTargets.delete(id);
        if (receipt.accepted && receipt.inventoryChanged === true)
            this.inventory.markDirty(id);
        return receipt;
    }
    clearRuntimeState(id) {
        const prefix = `${id}:`;
        for (const key of this.nextDueTicks.keys()) {
            if (key.startsWith(prefix))
                this.nextDueTicks.delete(key);
        }
        this.following.delete(id);
        this.mineScans.delete(id);
        this.mineTargets.delete(id);
        this.activeMineTargets.delete(id);
        this.oneShotNavigations.delete(id);
    }
    removeInactiveRuntimeState(tasks) {
        const activeKeys = new Set(tasks.map((task) => task.key));
        const activeIds = new Set(tasks.map((task) => task.record.id));
        for (const key of this.nextDueTicks.keys()) {
            if (!activeKeys.has(key))
                this.nextDueTicks.delete(key);
        }
        for (const id of this.following) {
            if (!activeIds.has(id))
                this.following.delete(id);
        }
        for (const id of this.mineScans.keys()) {
            if (!activeIds.has(id))
                this.mineScans.delete(id);
        }
        for (const id of this.mineTargets.keys()) {
            if (!activeIds.has(id))
                this.mineTargets.delete(id);
        }
        for (const id of this.activeMineTargets.keys()) {
            if (!activeIds.has(id))
                this.activeMineTargets.delete(id);
        }
    }
}
function emptyOutcome(continueNextTick = false) {
    return { attempted: false, accepted: false, blockReads: 0, continueNextTick };
}
function hasNonFollowPathfinding(record) {
    return (record.behavior.attack.enabled && record.behavior.attack.chase)
        || (record.behavior.mine.enabled && record.behavior.mine.approach);
}
function oneShotNavigationReached(id, runtime, target, worldQueries) {
    if (target.kind === "entity") {
        const targetDistance = worldQueries.distanceSquared(id, target.targetId);
        return targetDistance === undefined || targetDistance <= ONE_SHOT_NAVIGATION_ARRIVAL_DISTANCE_SQUARED;
    }
    return runtime.dimension !== target.dimension
        || distanceSquared(runtime.position, target.position) <= ONE_SHOT_NAVIGATION_ARRIVAL_DISTANCE_SQUARED;
}
function interruptsMining(kind) {
    return kind === "break_block"
        || kind === "build_block"
        || kind === "interact_block"
        || kind === "interact_entity"
        || kind === "place_block_direct"
        || kind === "stop"
        || kind === "teleport"
        || kind === "use_item"
        || kind === "use_item_on_block";
}
function behaviorConfigsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function isMineTarget(info, typeId) {
    return info !== undefined && info.solid && (typeId === null || info.typeId === typeId);
}
function isAirBlock(info) {
    return info !== undefined && (info.typeId === "minecraft:air"
        || info.typeId === "minecraft:cave_air"
        || info.typeId === "minecraft:void_air");
}
function faceOffset(face) {
    switch (face) {
        case "down": return { x: 0, y: -1, z: 0 };
        case "east": return { x: 1, y: 0, z: 0 };
        case "north": return { x: 0, y: 0, z: -1 };
        case "south": return { x: 0, y: 0, z: 1 };
        case "up": return { x: 0, y: 1, z: 0 };
        case "west": return { x: -1, y: 0, z: 0 };
    }
}
function faceCenter(face) {
    switch (face) {
        case "down": return { x: 0.5, y: 0, z: 0.5 };
        case "east": return { x: 1, y: 0.5, z: 0.5 };
        case "north": return { x: 0.5, y: 0.5, z: 0 };
        case "south": return { x: 0.5, y: 0.5, z: 1 };
        case "up": return { x: 0.5, y: 1, z: 0.5 };
        case "west": return { x: 0, y: 0.5, z: 0.5 };
    }
}
function describeMine(record, state, position, info) {
    const config = record.behavior.mine;
    return `id=${record.id}; state=${state}; direction=${config.direction}; target=${formatPoint(position)}; `
        + `configured=${config.blockTypeId ?? "any"}; observed=${info?.typeId ?? "unknown"}; `
        + `solid=${info?.solid ?? "unknown"}; radius=${config.searchRadius}; approach=${config.approach}`;
}
function describePlace(record, state, target, targetInfo, support, face, distance, inventorySlot) {
    const config = record.behavior.place;
    return `id=${record.id}; state=${state}; mode=${config.mode}; selection=${config.selectionMode}; `
        + `configured=${config.selectionMode === "slot" ? config.slot : config.itemTypeId ?? "empty"}; `
        + `slot=${inventorySlot?.slot ?? "unresolved"}; item=${inventorySlot?.itemTypeId ?? "empty"}; `
        + `target=${target === undefined ? "unknown" : formatPoint(target)}; `
        + `targetType=${targetInfo?.typeId ?? "unknown"}; `
        + `support=${support === undefined ? "unknown" : formatPoint(support)}; `
        + `face=${face ?? "unknown"}; distance=${distance ?? "unknown"}`;
}
function formatPoint({ x, y, z }) {
    return `${x},${y},${z}`;
}
function directMineTarget(position, direction) {
    if (direction === "down") {
        const base = floorPoint(position);
        return { x: base.x, y: base.y - 1, z: base.z };
    }
    const base = floorPoint(position);
    return { x: base.x, y: base.y + 2, z: base.z };
}
function eyePosition(position) {
    return { x: position.x, y: position.y + MINE_EYE_HEIGHT, z: position.z };
}
function nextShellOffset(scan, maximumRadius) {
    while (scan.radius <= maximumRadius) {
        const width = scan.radius * 2 + 1;
        const volume = width * width * width;
        while (scan.cursor < volume) {
            const index = scan.cursor;
            scan.cursor += 1;
            const x = index % width - scan.radius;
            const y = Math.floor(index / width) % width - scan.radius;
            const z = Math.floor(index / (width * width)) - scan.radius;
            if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) === scan.radius)
                return { x, y, z };
        }
        scan.radius += 1;
        scan.cursor = 0;
    }
    return undefined;
}
function addPoints(left, right) {
    return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}
function mineTargetFace(origin, target) {
    const x = target.x + 0.5 - origin.x;
    const y = target.y + 0.5 - origin.y;
    const z = target.z + 0.5 - origin.z;
    if (Math.abs(y) >= Math.abs(x) && Math.abs(y) >= Math.abs(z))
        return y > 0 ? "down" : "up";
    if (Math.abs(x) >= Math.abs(z))
        return x > 0 ? "west" : "east";
    return z > 0 ? "north" : "south";
}
function distanceSquared(left, right) {
    const x = left.x - right.x;
    const y = left.y - right.y;
    const z = left.z - right.z;
    return x * x + y * y + z * z;
}
function mapAction(fakePlayerId, action, runtime, worldQueries) {
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
        case "look_at_once": {
            if (!isFinitePoint(action.position))
                return err("INVALID_STATE", "目标坐标必须是有限数字。");
            if (action.dimension !== runtime.dimension) {
                return err("INVALID_STATE", "假人只能看向同维度坐标。");
            }
            if (!worldQueries.isChunkLoaded(action.dimension, action.position)) {
                return err("INVALID_STATE", "目标坐标所在区块未加载。");
            }
            if (action.kind === "look_at")
                return ok({ kind: "look_at", position: action.position });
            const rotation = lookRotation(runtime.headPosition, action.position);
            return rotation === undefined
                ? err("INVALID_STATE", "目标眼睛与假人眼睛重合，无需转向。")
                : ok({ kind: "look_at_once", rotation });
        }
        case "look_at_entity":
            {
                const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries);
                return target.ok ? ok(action) : target;
            }
        case "move_to": {
            const destination = validateCoordinateTarget(action.dimension, action.position, runtime.dimension, worldQueries);
            if (!destination.ok)
                return destination;
            const speed = normalizeSpeed(action.speed);
            return speed.ok ? ok({ kind: "move_to", position: action.position, speed: speed.value }) : speed;
        }
        case "navigate": {
            const destination = validateCoordinateTarget(action.dimension, action.position, runtime.dimension, worldQueries);
            if (!destination.ok)
                return destination;
            const speed = normalizeSpeed(action.speed);
            return speed.ok ? ok({ kind: "navigate", position: action.position, speed: speed.value }) : speed;
        }
        case "navigate_entity": {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries, null);
            if (!target.ok)
                return target;
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
        case "attack_entity": {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries);
            return target.ok ? ok(action) : target;
        }
        case "interact_entity": {
            const target = validateEntityTarget(fakePlayerId, action.targetId, worldQueries, MAX_ENTITY_INTERACTION_DISTANCE);
            return target.ok ? ok(action) : target;
        }
        case "break_block": {
            const target = validateBlockTarget(fakePlayerId, action, runtime.dimension, worldQueries);
            return target.ok
                ? ok({ kind: action.kind, position: target.value, face: action.face })
                : target;
        }
        case "interact_block": {
            const target = validateBlockTarget(fakePlayerId, action, runtime.dimension, worldQueries, false);
            return target.ok
                ? ok({ kind: action.kind, position: target.value, face: action.face })
                : target;
        }
        case "use_item_on_block": {
            if (!validInventorySlot(action.slot)) {
                return err("INVALID_SLOT", `物品槽位必须是 0 到 ${INVENTORY_SLOT_COUNT - 1} 的整数。`);
            }
            const target = validateBlockTarget(fakePlayerId, action, runtime.dimension, worldQueries);
            return target.ok
                ? ok({
                    kind: action.kind,
                    slot: action.slot,
                    position: target.value,
                    face: action.face,
                    faceLocation: faceCenter(action.face),
                })
                : target;
        }
    }
}
function lookRotation(origin, target) {
    const x = target.x - origin.x;
    const y = target.y - origin.y;
    const z = target.z - origin.z;
    const horizontalDistance = Math.sqrt(x * x + z * z);
    if (horizontalDistance < 0.001 && Math.abs(y) < 0.001)
        return undefined;
    return {
        x: -Math.atan2(y, horizontalDistance) * 180 / Math.PI,
        y: Math.atan2(-x, z) * 180 / Math.PI,
    };
}
function validateCoordinateTarget(dimension, position, runtimeDimension, worldQueries) {
    if (!isFinitePoint(position))
        return err("INVALID_STATE", "目标坐标必须是有限数字。");
    if (dimension !== runtimeDimension)
        return err("INVALID_STATE", "移动目标必须与假人位于同一维度。");
    return worldQueries.isChunkLoaded(dimension, position)
        ? ok(undefined)
        : err("INVALID_STATE", "目标坐标所在区块未加载。");
}
function validateEntityTarget(fakePlayerId, targetId, worldQueries, maxDistance = MAX_INTERACTION_DISTANCE) {
    if (targetId.length === 0)
        return err("NOT_FOUND", "目标实体已失效。");
    const distanceSquared = worldQueries.distanceSquared(fakePlayerId, targetId);
    if (distanceSquared === undefined)
        return err("NOT_FOUND", "目标实体不存在或不在同一维度。");
    if (maxDistance !== null && distanceSquared > maxDistance * maxDistance) {
        return err("INVALID_STATE", `目标实体距离超过 ${maxDistance} 格。`);
    }
    if (maxDistance !== null && !worldQueries.hasLineOfSight(fakePlayerId, targetId)) {
        return err("INVALID_STATE", "目标实体被方块遮挡。");
    }
    return ok(undefined);
}
function toEntityInteractionTarget(source, target) {
    return {
        id: target.id,
        typeId: target.typeId,
        nameTag: target.nameTag,
        distance: Math.sqrt(distanceSquared(source.position, target.position)),
    };
}
function validEntityTypeId(typeId) {
    return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(typeId);
}
function validateBlockTarget(fakePlayerId, action, runtimeDimension, worldQueries, requireSolid = true) {
    const coordinate = validateCoordinateTarget(action.dimension, action.position, runtimeDimension, worldQueries);
    if (!coordinate.ok)
        return coordinate;
    const position = floorPoint(action.position);
    if (requireSolid && !worldQueries.isSolidBlock(action.dimension, position)) {
        return err("INVALID_STATE", "目标位置不是可交互的固体方块。");
    }
    if (!requireSolid) {
        const info = worldQueries.getBlockInfo(action.dimension, position);
        if (info === undefined || isAirBlock(info))
            return err("INVALID_STATE", "目标位置没有可交互方块。");
    }
    if (!worldQueries.hasBlockLineOfSight(fakePlayerId, action.dimension, position, MAX_INTERACTION_DISTANCE)) {
        return err("INVALID_STATE", `目标方块不在 ${MAX_INTERACTION_DISTANCE} 格可见范围内。`);
    }
    return ok(position);
}
function normalizeSpeed(speed) {
    const value = speed ?? 1;
    return Number.isFinite(value) && value >= 0 && value <= 1
        ? ok(value)
        : err("INVALID_STATE", "移动速度必须在 0 到 1 之间。");
}
function validInventorySlot(slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SLOT_COUNT;
}
function isFinitePoint(point) {
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}
function floorPoint(point) {
    return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
}
//# sourceMappingURL=behaviorService.js.map