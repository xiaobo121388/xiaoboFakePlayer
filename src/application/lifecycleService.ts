import { createDefaultBehaviorConfig } from "../domain/behavior.js";
import { advanceLifecycleOperation, transitionLifecycle } from "../domain/lifecycle.js";
import type {
    FakePlayerGameMode,
    FakePlayerId,
    FakePlayerRecord,
    FakePlayerSkin,
    LifecycleOperation,
    PlayerPersistentId,
    RespawnMode,
    SavedLocation,
    WorldCatalog,
} from "../domain/model.js";
import { DEFAULT_FAKE_PLAYER_SKIN } from "../domain/model.js";
import { isAllowed, type ActorIdentity, type PermissionAction } from "../domain/permissions.js";
import { err, ok, type Result } from "../domain/results.js";
import { formatFakePlayerId, MAX_FAKE_PLAYERS, reserveUniqueName } from "../domain/validation.js";
import {
    availableInventoryFallbackRevision,
    InventoryService,
    restoreInventorySnapshot,
    snapshotId,
} from "./inventoryService.js";
import type {
    FakePlayerRuntime,
    InventorySnapshotStore,
    RuntimeFakePlayer,
    WorldStateStore,
} from "./ports.js";
import { OperationCoordinator } from "./operationCoordinator.js";

export interface CreateFakePlayerRequest {
    readonly requestedName: string;
    readonly location: SavedLocation;
    readonly gameMode: FakePlayerGameMode;
    readonly skinMode: "copy_actor" | "default";
    readonly unavailablePlayerNames: readonly string[];
}

export interface RenameFakePlayerRequest {
    readonly requestedName: string;
    readonly unavailablePlayerNames: readonly string[];
}

export interface DeletedFakePlayer {
    readonly id: FakePlayerId;
    readonly name: string;
}

interface RecordContext {
    readonly catalog: WorldCatalog;
    readonly catalogRevision: number;
    readonly record: FakePlayerRecord;
}

export class LifecycleService {
    private lastAutoRespawnId: FakePlayerId | undefined;

    public constructor(
        private readonly stateStore: WorldStateStore,
        private readonly runtime: FakePlayerRuntime,
        private readonly snapshots: InventorySnapshotStore,
        private readonly coordinator: OperationCoordinator,
        private readonly inventory: InventoryService,
    ) {}

    public list(actor: ActorIdentity): Result<readonly FakePlayerRecord[]> {
        const authorization = this.authorize(actor, "view");
        if (!authorization.ok) return authorization;
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        return ok(Object.values(loaded.state.value.records).sort((left, right) => left.id.localeCompare(right.id)));
    }

    public create(actor: ActorIdentity, request: CreateFakePlayerRequest): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "create");
        if (!authorization.ok) return authorization;
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const catalog = loaded.state.value;
        if (Object.keys(catalog.records).length >= MAX_FAKE_PLAYERS) {
            return err("CONFLICT", `一个世界最多创建 ${MAX_FAKE_PLAYERS} 个假人。`);
        }
        const name = reserveUniqueName(request.requestedName, [
            ...request.unavailablePlayerNames,
            ...Object.values(catalog.records).map((record) => record.name),
        ]);
        if (!name.ok) return name;

        const id = formatFakePlayerId(catalog.nextId);
        const skin = request.skinMode === "copy_actor"
            ? this.runtime.capturePlayerSkin(actor.playerId) ?? DEFAULT_FAKE_PLAYER_SKIN
            : DEFAULT_FAKE_PLAYER_SKIN;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const operation = createOperation(id, 0, "create", "missing", "online");
            const provisioning = createProvisioningRecord(id, name.value, actor.playerId, request, skin, operation);
            const prepared = this.stateStore.commitCatalog(loaded.state.revision, addRecord(catalog, provisioning));
            if (!prepared.ok) return prepared;

            this.runtime.spawn({
                id,
                name: provisioning.name,
                dimension: provisioning.location.dimension,
                position: provisioning.location.position,
                rotation: provisioning.location.rotation,
                gameMode: provisioning.gameMode,
                skin: provisioning.skin,
                selectedSlot: provisioning.selectedSlot,
                totalExperience: provisioning.totalExperience,
            });
            const online = transitionLifecycle(provisioning, provisioning.recordRevision, { kind: "online" });
            if (!online.ok) return online;
            const committed = commitCatalogRecord(
                this.stateStore,
                prepared.value.revision,
                prepared.value.value,
                online.value,
            );
            return committed.ok ? ok(committed.value.record) : committed;
        } finally {
            lease.value.release();
        }
    }

    public takeOffline(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const runtimeState = this.runtime.get(id);
            if (runtimeState === undefined) return err("INVALID_STATE", `假人 ${id} 没有在线运行时实例。`);
            const checkpointedRecord: FakePlayerRecord = {
                ...context.value.record,
                location: {
                    dimension: runtimeState.dimension,
                    position: runtimeState.position,
                    rotation: runtimeState.rotation,
                },
                gameMode: runtimeState.gameMode,
                selectedSlot: runtimeState.selectedSlot,
                totalExperience: runtimeState.totalExperience,
            };
            const operation = createOperation(id, checkpointedRecord.recordRevision, "offline", "online", "offline");
            const pending = transitionLifecycle(checkpointedRecord, expectedRecordRevision, {
                kind: "snapshotting",
                operation,
            });
            if (!pending.ok) return pending;
            const prepared = commitCatalogRecord(
                this.stateStore,
                context.value.catalogRevision,
                context.value.catalog,
                pending.value,
            );
            if (!prepared.ok) return prepared;

            const snapshotRevision = (context.value.record.inventoryRevision ?? 0) + 1;
            const snapshot = this.snapshots.save(id, snapshotRevision);
            if (!snapshot.ok) return snapshot;
            const verified = advanceLifecycleOperation(
                pending.value,
                pending.value.recordRevision,
                `snapshot_verified:${snapshotRevision}`,
            );
            if (!verified.ok) return verified;
            const verifiedCommit = commitCatalogRecord(
                this.stateStore,
                prepared.value.catalogRevision,
                prepared.value.catalog,
                verified.value,
            );
            if (!verifiedCommit.ok) return verifiedCommit;
            if (!this.runtime.disconnect(id)) {
                return err("CONFLICT", `无法断开待下线假人 ${id}。`);
            }
            const offline = transitionLifecycle(verified.value, verified.value.recordRevision, { kind: "offline" });
            if (!offline.ok) return offline;
            const fallbackRevision = availableInventoryFallbackRevision(this.snapshots, context.value.record);
            const finalRecord: FakePlayerRecord = {
                ...offline.value,
                inventoryRevision: snapshotRevision,
                inventoryFallbackRevision: fallbackRevision,
            };
            const committed = commitCatalogRecord(
                this.stateStore,
                verifiedCommit.value.catalogRevision,
                verifiedCommit.value.catalog,
                finalRecord,
            );
            if (!committed.ok) return committed;
            if (context.value.record.inventoryFallbackRevision !== null
                && context.value.record.inventoryFallbackRevision !== fallbackRevision) {
                const removed = this.snapshots.remove(
                    snapshotId(id, context.value.record.inventoryFallbackRevision),
                );
                if (!removed.ok) return removed;
            }
            return ok(committed.value.record);
        } finally {
            lease.value.release();
        }
    }

    public bringOnline(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        location?: SavedLocation,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const source = location === undefined ? context.value.record : { ...context.value.record, location };
            const operation = createOperation(id, source.recordRevision, "online", "offline", "online");
            const pending = transitionLifecycle(source, expectedRecordRevision, { kind: "restoring", operation });
            if (!pending.ok) return pending;
            const prepared = commitCatalogRecord(
                this.stateStore,
                context.value.catalogRevision,
                context.value.catalog,
                pending.value,
            );
            if (!prepared.ok) return prepared;

            this.runtime.spawn({
                id,
                name: pending.value.name,
                dimension: pending.value.location.dimension,
                position: pending.value.location.position,
                rotation: pending.value.location.rotation,
                gameMode: pending.value.gameMode,
                skin: pending.value.skin,
                selectedSlot: pending.value.selectedSlot,
                totalExperience: pending.value.totalExperience,
            });
            const restored = restoreInventorySnapshot(this.snapshots, pending.value);
            if (!restored.ok) {
                return this.runtime.disconnect(id)
                    ? restored
                    : err("CONFLICT", `${restored.error.message}；且无法断开未恢复库存的假人 ${id}。`);
            }
            const online = transitionLifecycle(pending.value, pending.value.recordRevision, { kind: "online" });
            if (!online.ok) return online;
            const finalRecord: FakePlayerRecord = restored.value.usedFallback
                ? {
                    ...online.value,
                    inventoryRevision: restored.value.inventoryRevision,
                    inventoryFallbackRevision: restored.value.inventoryFallbackRevision,
                    lastCheckpointTick: null,
                }
                : online.value;
            const committed = commitCatalogRecord(
                this.stateStore,
                prepared.value.catalogRevision,
                prepared.value.catalog,
                finalRecord,
            );
            return committed.ok ? ok(committed.value.record) : committed;
        } finally {
            lease.value.release();
        }
    }

    public rename(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        request: RenameFakePlayerRequest,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        let context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        if (context.value.record.lifecycle.kind !== "online" && context.value.record.lifecycle.kind !== "offline") {
            return err("INVALID_STATE", `假人 ${id} 当前处于 ${context.value.record.lifecycle.kind}，不能重命名。`);
        }
        if (request.requestedName.trim().toLowerCase() === context.value.record.name.toLowerCase()) {
            return ok(context.value.record);
        }
        const returnOnline = context.value.record.lifecycle.kind === "online";
        if (returnOnline) {
            const offline = this.takeOffline(actor, id, expectedRecordRevision);
            if (!offline.ok) return offline;
            context = this.loadRecord(id, offline.value.recordRevision);
            if (!context.ok) return context;
        }
        const name = reserveUniqueName(request.requestedName, [
            ...request.unavailablePlayerNames,
            ...reservedCatalogNames(context.value.catalog, id),
        ]);
        if (!name.ok) return name;

        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const operation: LifecycleOperation = {
                ...createOperation(
                    id,
                    context.value.record.recordRevision,
                    "rename",
                    "offline",
                    returnOnline ? "online" : "offline",
                ),
                previousName: context.value.record.name,
                targetName: name.value,
            };
            const source = { ...context.value.record, name: name.value };
            const renaming = transitionLifecycle(source, source.recordRevision, { kind: "renaming", operation });
            if (!renaming.ok) return renaming;
            const prepared = commitCatalogRecord(
                this.stateStore,
                context.value.catalogRevision,
                context.value.catalog,
                renaming.value,
            );
            return prepared.ok ? this.finishRenaming(prepared.value) : prepared;
        } finally {
            lease.value.release();
        }
    }

    public purge(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<DeletedFakePlayer> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        if (context.value.record.lifecycle.kind !== "offline") {
            return err("INVALID_STATE", "彻底删除只允许从 offline 状态开始，请先安全下线。");
        }
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const operation = createOperation(id, expectedRecordRevision, "delete", "offline", null);
            const deleting = transitionLifecycle(context.value.record, expectedRecordRevision, {
                kind: "deleting",
                operation,
            });
            if (!deleting.ok) return deleting;
            const prepared = commitCatalogRecord(
                this.stateStore,
                context.value.catalogRevision,
                context.value.catalog,
                deleting.value,
            );
            return prepared.ok ? this.finishDeleting(prepared.value) : prepared;
        } finally {
            lease.value.release();
        }
    }

    public recycle(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<DeletedFakePlayer> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        if (context.value.record.lifecycle.kind !== "offline") {
            return err("INVALID_STATE", "无损回收只允许从 offline 状态开始，请先安全下线。");
        }
        const recycled = this.inventory.recycleContents(
            actor,
            id,
            context.value.record.recordRevision,
        );
        return recycled.ok ? this.purge(actor, id, recycled.value.recordRevision) : recycled;
    }

    public respawn(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const context = this.loadRecord(id, expectedRecordRevision);
        return context.ok ? this.beginRespawn(context.value) : context;
    }

    public autoRespawn(id: FakePlayerId): Result<FakePlayerRecord | undefined> {
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined) return err("NOT_FOUND", `未找到死亡假人 ${id}。`);
        if (record.respawnMode === "manual") return ok(undefined);
        const runtimeState = this.runtime.get(id);
        if (record.lifecycle.kind !== "online" || runtimeState === undefined || runtimeState.alive) {
            return ok(undefined);
        }
        return this.beginRespawn({
            catalog: loaded.state.value,
            catalogRevision: loaded.state.revision,
            record,
        });
    }

    public autoRespawnNext(): Result<FakePlayerRecord | undefined> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const candidates = Object.values(loaded.state.value.records)
            .filter((record) => (
                record.lifecycle.kind === "online"
                && record.respawnMode !== "manual"
                && this.runtime.get(record.id)?.alive === false
            ))
            .sort((left, right) => left.id.localeCompare(right.id));
        const lastIndex = candidates.findIndex((record) => record.id === this.lastAutoRespawnId);
        const candidate = candidates[(lastIndex + 1) % candidates.length];
        if (candidate === undefined) return ok(undefined);
        this.lastAutoRespawnId = candidate.id;
        return this.autoRespawn(candidate.id);
    }

    public setRespawnRule(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        mode: RespawnMode,
        manualLocation?: SavedLocation,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor, "manage");
        if (!authorization.ok) return authorization;
        const available = this.inventory.ensureNoPendingTransfer(id);
        if (!available.ok) return available;
        const context = this.loadRecord(id, expectedRecordRevision);
        if (!context.ok) return context;
        if (context.value.record.lifecycle.kind !== "online" && context.value.record.lifecycle.kind !== "offline") {
            return err("INVALID_STATE", `假人 ${id} 当前处于 ${context.value.record.lifecycle.kind}，不能修改复活规则。`);
        }
        if (mode === "manual" && manualLocation === undefined) {
            return err("INVALID_STATE", "手动复活规则必须提供复活位置。");
        }
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            const next: FakePlayerRecord = {
                ...context.value.record,
                recordRevision: context.value.record.recordRevision + 1,
                respawnMode: mode,
                respawnLocation: manualLocation ?? context.value.record.respawnLocation,
            };
            const committed = commitCatalogRecord(
                this.stateStore,
                context.value.catalogRevision,
                context.value.catalog,
                next,
            );
            return committed.ok ? ok(committed.value.record) : committed;
        } finally {
            lease.value.release();
        }
    }

    private finishRenaming(context: RecordContext): Result<FakePlayerRecord> {
        const operation = lifecycleOperation(context.record);
        if (context.record.lifecycle.kind !== "renaming" || operation?.targetName === undefined) {
            return err("INVALID_STATE", `${context.record.id} 没有有效的重命名操作。`);
        }
        if (operation.target === "online") {
            const existing = this.runtime.get(context.record.id);
            if (existing !== undefined && existing.name !== operation.targetName) {
                if (!this.runtime.disconnect(context.record.id)) {
                    return err("CONFLICT", `无法断开旧名称假人 ${context.record.id}。`);
                }
            }
            const spawned = this.runtime.get(context.record.id) === undefined;
            if (spawned) this.runtime.spawn(spawnRequest(context.record));
            const restored = restoreInventorySnapshot(this.snapshots, context.record);
            if (!restored.ok) {
                if (!spawned) return restored;
                return this.runtime.disconnect(context.record.id)
                    ? restored
                    : err(
                        "CONFLICT",
                        `${restored.error.message}；且无法断开未恢复库存的假人 ${context.record.id}。`,
                    );
            }
            context = restored.value.usedFallback
                ? {
                    ...context,
                    record: {
                        ...context.record,
                        inventoryRevision: restored.value.inventoryRevision,
                        inventoryFallbackRevision: restored.value.inventoryFallbackRevision,
                        lastCheckpointTick: null,
                    },
                }
                : context;
        } else if (this.runtime.get(context.record.id) !== undefined && !this.runtime.disconnect(context.record.id)) {
            return err("CONFLICT", `无法断开离线重命名假人 ${context.record.id}。`);
        }
        const stable = transitionLifecycle(context.record, context.record.recordRevision, {
            kind: operation.target === "online" ? "online" : "offline",
        });
        if (!stable.ok) return stable;
        const committed = commitCatalogRecord(
            this.stateStore,
            context.catalogRevision,
            context.catalog,
            stable.value,
        );
        return committed.ok ? ok(committed.value.record) : committed;
    }

    private finishDeleting(context: RecordContext): Result<DeletedFakePlayer> {
        let current = context;
        let operation = lifecycleOperation(current.record);
        if (current.record.lifecycle.kind !== "deleting" || operation?.kind !== "delete") {
            return err("INVALID_STATE", `${current.record.id} 没有有效的删除操作。`);
        }
        if (this.runtime.get(current.record.id) !== undefined && !this.runtime.disconnect(current.record.id)) {
            return err("CONFLICT", `无法断开待删除假人 ${current.record.id}。`);
        }
        if (operation.phase !== "snapshot_removed") {
            if (current.record.inventoryRevision !== null) {
                const removed = this.snapshots.remove(snapshotId(current.record.id, current.record.inventoryRevision));
                if (!removed.ok) return removed;
            }
            if (current.record.inventoryFallbackRevision !== null) {
                const removed = this.snapshots.remove(
                    snapshotId(current.record.id, current.record.inventoryFallbackRevision),
                );
                if (!removed.ok) return removed;
            }
            const advanced = advanceLifecycleOperation(
                current.record,
                current.record.recordRevision,
                "snapshot_removed",
            );
            if (!advanced.ok) return advanced;
            const committed = commitCatalogRecord(
                this.stateStore,
                current.catalogRevision,
                current.catalog,
                advanced.value,
            );
            if (!committed.ok) return committed;
            current = committed.value;
            operation = lifecycleOperation(current.record);
        }
        if (operation?.phase !== "snapshot_removed") {
            return err("INVALID_STATE", `${current.record.id} 的删除阶段无效。`);
        }
        const removed = commitCatalogRemoval(
            this.stateStore,
            current.catalogRevision,
            current.catalog,
            current.record.id,
        );
        return removed.ok ? ok({ id: current.record.id, name: current.record.name }) : removed;
    }

    private beginRespawn(context: RecordContext): Result<FakePlayerRecord> {
        if (context.record.lifecycle.kind !== "online") {
            return err("INVALID_STATE", `假人 ${context.record.id} 当前处于 ${context.record.lifecycle.kind}，不能复活。`);
        }
        const runtimeState = this.runtime.get(context.record.id);
        if (runtimeState === undefined) return err("INVALID_STATE", `死亡假人 ${context.record.id} 缺少运行时实例。`);
        if (runtimeState.alive) return err("INVALID_STATE", `假人 ${context.record.id} 当前没有死亡。`);
        const lease = this.coordinator.tryAcquire([`fake:${context.record.id}`]);
        if (!lease.ok) return lease;
        try {
            const source = context.record.respawnMode === "death_location"
                ? { ...context.record, location: runtimeLocation(runtimeState) }
                : context.record;
            const operation = createOperation(
                source.id,
                source.recordRevision,
                "respawn",
                "online",
                "online",
            );
            const pending = transitionLifecycle(source, source.recordRevision, {
                kind: "respawning",
                operation,
            });
            if (!pending.ok) return pending;
            const prepared = commitCatalogRecord(
                this.stateStore,
                context.catalogRevision,
                context.catalog,
                pending.value,
            );
            return prepared.ok ? this.finishRespawning(prepared.value) : prepared;
        } finally {
            lease.value.release();
        }
    }

    private finishRespawning(context: RecordContext): Result<FakePlayerRecord> {
        let current = context;
        let operation = lifecycleOperation(current.record);
        if (current.record.lifecycle.kind !== "respawning" || operation?.kind !== "respawn") {
            return err("INVALID_STATE", `${current.record.id} 没有有效的复活操作。`);
        }
        if (operation.phase === "prepared") {
            if (!this.runtime.respawn(current.record.id, respawnTarget(current.record))) {
                return err("CONFLICT", `无法复活假人 ${current.record.id}。`);
            }
            const advanced = advanceLifecycleOperation(current.record, current.record.recordRevision, "respawned");
            if (!advanced.ok) return advanced;
            const committed = commitCatalogRecord(
                this.stateStore,
                current.catalogRevision,
                current.catalog,
                advanced.value,
            );
            if (!committed.ok) return committed;
            current = committed.value;
            operation = lifecycleOperation(current.record);
        }
        let snapshotRevision = verifiedSnapshotRevision(current.record);
        if (operation?.phase === "respawned") {
            snapshotRevision = (current.record.inventoryRevision ?? 0) + 1;
            const snapshot = this.snapshots.save(current.record.id, snapshotRevision);
            if (!snapshot.ok) return snapshot;
            const advanced = advanceLifecycleOperation(
                current.record,
                current.record.recordRevision,
                `snapshot_verified:${snapshotRevision}`,
            );
            if (!advanced.ok) return advanced;
            const committed = commitCatalogRecord(
                this.stateStore,
                current.catalogRevision,
                current.catalog,
                advanced.value,
            );
            if (!committed.ok) return committed;
            current = committed.value;
        }
        if (snapshotRevision === undefined || !this.snapshots.has(snapshotId(current.record.id, snapshotRevision))) {
            return err("NOT_FOUND", `${current.record.id} 复活后的库存快照不存在。`);
        }
        const runtimeState = this.runtime.get(current.record.id);
        if (runtimeState === undefined || !runtimeState.alive) {
            return err("INVALID_STATE", `${current.record.id} 复活后仍没有存活实例。`);
        }
        const online = transitionLifecycle(current.record, current.record.recordRevision, { kind: "online" });
        if (!online.ok) return online;
        const finalRecord: FakePlayerRecord = {
            ...online.value,
            location: runtimeLocation(runtimeState),
            gameMode: runtimeState.gameMode,
            selectedSlot: runtimeState.selectedSlot,
            totalExperience: runtimeState.totalExperience,
            inventoryRevision: snapshotRevision,
            inventoryFallbackRevision: null,
        };
        const committed = commitCatalogRecord(
            this.stateStore,
            current.catalogRevision,
            current.catalog,
            finalRecord,
        );
        if (!committed.ok) return committed;
        for (const revision of [context.record.inventoryRevision, context.record.inventoryFallbackRevision]) {
            if (revision === null) continue;
            const removed = this.snapshots.remove(snapshotId(context.record.id, revision));
            if (!removed.ok) return removed;
        }
        return ok(committed.value.record);
    }

    private loadRecord(id: FakePlayerId, expectedRecordRevision: number): Result<RecordContext> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        return ok({ catalog: loaded.state.value, catalogRevision: loaded.state.revision, record });
    }

    private authorize(actor: ActorIdentity, action: PermissionAction): Result<void> {
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        return isAllowed(actor, loaded.state.value, action)
            ? ok(undefined)
            : err("PERMISSION_DENIED", "你没有执行此操作的权限。");
    }
}

function createProvisioningRecord(
    id: FakePlayerId,
    name: string,
    ownerId: PlayerPersistentId,
    request: CreateFakePlayerRequest,
    skin: FakePlayerSkin,
    operation: LifecycleOperation,
): FakePlayerRecord {
    return {
        id,
        name,
        ownerId,
        recordRevision: 1,
        lifecycle: { kind: "provisioning", operation },
        expectedOnline: true,
        location: request.location,
        gameMode: request.gameMode,
        skin,
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual",
        respawnLocation: null,
        inventoryRevision: null,
        inventoryFallbackRevision: null,
        lastCheckpointTick: null,
        behavior: createDefaultBehaviorConfig(),
    };
}

function createOperation(
    fakePlayerId: FakePlayerId,
    revision: number,
    kind: LifecycleOperation["kind"],
    previous: LifecycleOperation["previous"],
    target: LifecycleOperation["target"],
): LifecycleOperation {
    return {
        id: `${fakePlayerId}:${kind}:${revision}`,
        kind,
        previous,
        target,
        phase: "prepared",
    };
}

function addRecord(catalog: WorldCatalog, record: FakePlayerRecord): WorldCatalog {
    return {
        nextId: catalog.nextId + 1,
        records: { ...catalog.records, [record.id]: record },
    };
}

export function commitCatalogRecord(
    store: WorldStateStore,
    catalogRevision: number,
    catalog: WorldCatalog,
    record: FakePlayerRecord,
): Result<{
    readonly catalog: WorldCatalog;
    readonly catalogRevision: number;
    readonly record: FakePlayerRecord;
}> {
    const nextCatalog: WorldCatalog = {
        ...catalog,
        records: { ...catalog.records, [record.id]: record },
    };
    const committed = store.commitCatalog(catalogRevision, nextCatalog);
    return committed.ok
        ? ok({ catalog: committed.value.value, catalogRevision: committed.value.revision, record })
        : committed;
}

function reservedCatalogNames(catalog: WorldCatalog, excludingId?: FakePlayerId): readonly string[] {
    const names: string[] = [];
    for (const record of Object.values(catalog.records)) {
        if (record.id === excludingId) continue;
        names.push(record.name);
        const operation = lifecycleOperation(record);
        if (operation?.targetName !== undefined) names.push(operation.targetName);
    }
    return names;
}

function runtimeLocation(runtime: RuntimeFakePlayer): SavedLocation {
    return {
        dimension: runtime.dimension,
        position: runtime.position,
        rotation: runtime.rotation,
    };
}

function lifecycleOperation(record: FakePlayerRecord): LifecycleOperation | undefined {
    return "operation" in record.lifecycle ? record.lifecycle.operation : undefined;
}

function respawnTarget(record: FakePlayerRecord): SavedLocation | undefined {
    if (record.respawnMode === "death_location") return record.location;
    if (record.respawnMode === "manual") return record.respawnLocation ?? undefined;
    return undefined;
}

function verifiedSnapshotRevision(record: FakePlayerRecord): number | undefined {
    const operation = lifecycleOperation(record);
    if (operation === undefined) return undefined;
    const match = /^snapshot_verified:(\d+)$/.exec(operation.phase);
    if (match === null) return undefined;
    const revision = Number(match[1]);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

function spawnRequest(record: FakePlayerRecord) {
    return {
        id: record.id,
        name: record.name,
        dimension: record.location.dimension,
        position: record.location.position,
        rotation: record.location.rotation,
        gameMode: record.gameMode,
        skin: record.skin,
        selectedSlot: record.selectedSlot,
        totalExperience: record.totalExperience,
    };
}

export function commitCatalogRemoval(
    store: WorldStateStore,
    catalogRevision: number,
    catalog: WorldCatalog,
    id: FakePlayerId,
): Result<WorldCatalog> {
    const records = { ...catalog.records };
    delete records[id];
    const nextCatalog = { ...catalog, records };
    const committed = store.commitCatalog(catalogRevision, nextCatalog);
    return committed.ok ? ok(committed.value.value) : committed;
}