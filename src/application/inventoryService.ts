import type {
    ExperienceTransfer,
    FakePlayerId,
    FakePlayerRecord,
    InventoryTransfer,
    InventoryTransferRequest,
    PendingOperations,
    WorldCatalog,
} from "../domain/model.js";
import { INVENTORY_SLOT_COUNT, TOTAL_SLOT_COUNT } from "../domain/inventory.js";
import { isAllowed, type ActorIdentity } from "../domain/permissions.js";
import { err, ok, type Result } from "../domain/results.js";
import { OperationCoordinator } from "./operationCoordinator.js";
import type {
    FakePlayerRuntime,
    InventoryAccess,
    InventoryImageState,
    InventorySlotOverview,
    InventorySnapshotStore,
    WorldStateStore,
} from "./ports.js";

export interface InventoryCheckpoint {
    readonly record: FakePlayerRecord;
    readonly structureId: string;
}

export interface TransferRecoverySummary {
    readonly recovered: number;
    readonly diagnostics: readonly string[];
}

export interface PendingTransferOverview {
    readonly id: string;
    readonly kind: "experience" | "inventory";
    readonly fakePlayerId: FakePlayerId;
    readonly playerId: string;
    readonly phase: string;
}

export interface FakePlayerInventoryOverview {
    readonly id: FakePlayerId;
    readonly name: string;
    readonly recordRevision: number;
    readonly inventoryRevision: number;
    readonly selectedSlot: number;
    readonly totalExperience: number;
    readonly lastCheckpointTick: number | null;
    readonly slots: readonly InventorySlotOverview[];
}

export class InventoryService {
    private readonly dirty = new Set<FakePlayerId>();
    private lastAttemptedId: FakePlayerId | undefined;

    public constructor(
        private readonly stateStore: WorldStateStore,
        private readonly runtime: FakePlayerRuntime,
        private readonly snapshots: InventorySnapshotStore,
        private readonly coordinator: OperationCoordinator,
        private readonly access: InventoryAccess,
    ) {}

    public markDirty(id: FakePlayerId): void {
        this.dirty.add(id);
    }

    public getOverview(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<FakePlayerInventoryOverview> {
        const authorization = this.authorize(actor);
        if (!authorization.ok) return authorization;
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok) return lease;
        try {
            const context = this.loadOfflineRecord(id, expectedRecordRevision);
            if (!context.ok) return context;
            const inventoryRevision = context.value.record.inventoryRevision;
            if (inventoryRevision === null) return err("INVALID_STATE", `假人 ${id} 尚无库存快照。`);
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok) return available;
            const slots = this.access.readSnapshotOverview(
                snapshotId(id, inventoryRevision),
                actor.playerId,
            );
            return slots.ok ? ok({
                id,
                name: context.value.record.name,
                recordRevision: context.value.record.recordRevision,
                inventoryRevision,
                selectedSlot: context.value.record.selectedSlot,
                totalExperience: context.value.record.totalExperience,
                lastCheckpointTick: context.value.record.lastCheckpointTick,
                slots: slots.value,
            }) : slots;
        } finally {
            lease.value.release();
        }
    }

    public checkpoint(
        id: FakePlayerId,
        expectedRecordRevision: number,
        currentTick: number,
    ): Result<InventoryCheckpoint> {
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok) return lease;
        try {
            return this.checkpointWithLease(id, expectedRecordRevision, currentTick);
        } finally {
            lease.value.release();
        }
    }

    public checkpointNext(currentTick: number): Result<InventoryCheckpoint | undefined> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const candidates = Object.values(loaded.state.value.records)
            .filter((record) => record.lifecycle.kind === "online" && this.runtime.get(record.id)?.alive === true)
            .sort((left, right) => this.compareCheckpointPriority(left, right));
        const lastIndex = candidates.findIndex((record) => record.id === this.lastAttemptedId);
        const rotated = lastIndex < 0
            ? candidates
            : [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)];
        for (const candidate of rotated) {
            this.lastAttemptedId = candidate.id;
            const lease = this.coordinator.tryAcquire([`fake:${candidate.id}`]);
            if (!lease.ok) continue;
            try {
                return this.checkpointWithLease(candidate.id, candidate.recordRevision, currentTick);
            } finally {
                lease.value.release();
            }
        }
        return ok(undefined);
    }

    public transferItems(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        request: InventoryTransferRequest,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor);
        if (!authorization.ok) return authorization;
        const validRequest = validateTransferRequest(request);
        if (!validRequest.ok) return validRequest;
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok) return lease;
        try {
            const context = this.loadOfflineRecord(id, expectedRecordRevision);
            if (!context.ok) return context;
            if (context.value.record.inventoryRevision === null) {
                return err("INVALID_STATE", `假人 ${id} 尚无库存快照。`);
            }
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok) return available;
            const transfer = createInventoryTransfer(context.value.record, actor.playerId, request);
            const prepared = this.addInventoryTransfer(transfer);
            return prepared.ok ? this.finishInventoryTransfer(transfer.id) : prepared;
        } finally {
            lease.value.release();
        }
    }

    public transferExperience(
        actor: ActorIdentity,
        id: FakePlayerId,
        expectedRecordRevision: number,
        amount: number,
    ): Result<FakePlayerRecord> {
        const authorization = this.authorize(actor);
        if (!authorization.ok) return authorization;
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return err("INVALID_STATE", "经验转移量必须是正安全整数。");
        }
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok) return lease;
        try {
            const context = this.loadOfflineRecord(id, expectedRecordRevision);
            if (!context.ok) return context;
            if (amount > context.value.record.totalExperience) {
                return err("INVALID_STATE", "转移量不能超过假人当前总经验。");
            }
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok) return available;
            const playerBefore = this.access.getPlayerExperience(actor.playerId);
            if (!playerBefore.ok) return playerBefore;
            if (!Number.isSafeInteger(playerBefore.value + amount)) {
                return err("DATA_CAPACITY", "经验转移后的玩家总经验超出安全整数范围。");
            }
            const transfer = createExperienceTransfer(context.value.record, actor.playerId, playerBefore.value, amount);
            const prepared = this.addExperienceTransfer(transfer);
            return prepared.ok ? this.finishExperienceTransfer(transfer.id) : prepared;
        } finally {
            lease.value.release();
        }
    }

    public listPendingTransfers(actor: ActorIdentity): Result<readonly PendingTransferOverview[]> {
        if (!actor.isOperator) return err("PERMISSION_DENIED", "只有 OP 可以查看待恢复事务。");
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        return ok([
            ...Object.values(loaded.value.operations.inventoryTransfers).map((transfer) => ({
                id: transfer.id,
                kind: "inventory" as const,
                fakePlayerId: transfer.fakePlayerId,
                playerId: transfer.playerId,
                phase: transfer.phase,
            })),
            ...Object.values(loaded.value.operations.experienceTransfers).map((transfer) => ({
                id: transfer.id,
                kind: "experience" as const,
                fakePlayerId: transfer.fakePlayerId,
                playerId: transfer.playerId,
                phase: transfer.phase,
            })),
        ].sort((left, right) => left.id.localeCompare(right.id)));
    }

    public retryPendingTransfer(actor: ActorIdentity, operationId: string): Result<FakePlayerRecord> {
        if (!actor.isOperator) return err("PERMISSION_DENIED", "只有 OP 可以重试待恢复事务。");
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const inventoryTransfer = loaded.value.operations.inventoryTransfers[operationId];
        const experienceTransfer = loaded.value.operations.experienceTransfers[operationId];
        const transfer = inventoryTransfer ?? experienceTransfer;
        if (transfer === undefined) return err("NOT_FOUND", `未找到待恢复事务 ${operationId}。`);
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.fakePlayerId}`,
            `player:${transfer.playerId}`,
        ]);
        if (!lease.ok) return lease;
        try {
            return inventoryTransfer === undefined
                ? this.finishExperienceTransfer(operationId)
                : this.finishInventoryTransfer(operationId);
        } finally {
            lease.value.release();
        }
    }

    public recoverPendingTransfers(): Result<TransferRecoverySummary> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const inventoryIds = Object.keys(loaded.value.operations.inventoryTransfers).sort();
        const experienceIds = Object.keys(loaded.value.operations.experienceTransfers).sort();
        let recovered = 0;
        const diagnostics: string[] = [];
        for (const operationId of inventoryIds) {
            const result = this.resumeInventoryTransfer(operationId);
            if (result.ok) recovered += 1;
            else diagnostics.push(`${operationId}: ${result.error.code}: ${result.error.message}`);
        }
        for (const operationId of experienceIds) {
            const result = this.resumeExperienceTransfer(operationId);
            if (result.ok) recovered += 1;
            else diagnostics.push(`${operationId}: ${result.error.code}: ${result.error.message}`);
        }
        return ok({ recovered, diagnostics });
    }

    public ensureNoPendingTransfer(fakePlayerId: FakePlayerId): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const transfer = [
            ...Object.values(loaded.value.operations.inventoryTransfers),
            ...Object.values(loaded.value.operations.experienceTransfers),
        ].find((candidate) => candidate.fakePlayerId === fakePlayerId);
        return transfer === undefined
            ? ok(undefined)
            : err("CONFLICT", `假人 ${fakePlayerId} 正由待恢复事务 ${transfer.id} 占用。`);
    }

    private checkpointWithLease(
        id: FakePlayerId,
        expectedRecordRevision: number,
        currentTick: number,
    ): Result<InventoryCheckpoint> {
        if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
            return err("INVALID_STATE", "检查点 tick 必须是非负安全整数。");
        }
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        if (record.lifecycle.kind !== "online") {
            return err("INVALID_STATE", `假人 ${id} 当前处于 ${record.lifecycle.kind}，不能建立在线检查点。`);
        }
        const runtime = this.runtime.get(id);
        if (runtime === undefined || !runtime.alive) {
            return err("INVALID_STATE", `假人 ${id} 没有存活的在线实例。`);
        }

        const snapshotRevision = (record.inventoryRevision ?? 0) + 1;
        const saved = this.snapshots.save(id, snapshotRevision);
        if (!saved.ok) return saved;
        const nextRecord: FakePlayerRecord = {
            ...record,
            recordRevision: record.recordRevision + 1,
            location: {
                dimension: runtime.dimension,
                position: runtime.position,
                rotation: runtime.rotation,
            },
            gameMode: runtime.gameMode,
            selectedSlot: runtime.selectedSlot,
            totalExperience: runtime.totalExperience,
            inventoryRevision: snapshotRevision,
            lastCheckpointTick: currentTick,
        };
        const committed = commitRecord(this.stateStore, loaded.state.revision, loaded.state.value, nextRecord);
        if (!committed.ok) {
            const cleanup = this.snapshots.remove(saved.value);
            return cleanup.ok
                ? committed
                : err("CONFLICT", `${committed.error.message}；且无法清理未引用快照 ${saved.value}：${cleanup.error.message}`);
        }

        this.dirty.delete(id);
        if (record.inventoryRevision !== null) {
            const previousId = snapshotId(id, record.inventoryRevision);
            const removed = this.snapshots.remove(previousId);
            if (!removed.ok) {
                return err("CONFLICT", `新快照 ${saved.value} 已提交，但旧快照 ${previousId} 清理失败：${removed.error.message}`);
            }
        }
        return ok({ record: nextRecord, structureId: saved.value });
    }

    private resumeInventoryTransfer(operationId: string): Result<FakePlayerRecord> {
        const transfer = this.getInventoryTransfer(operationId);
        if (!transfer.ok) return transfer;
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.value.fakePlayerId}`,
            `player:${transfer.value.playerId}`,
        ]);
        if (!lease.ok) return lease;
        try {
            return this.finishInventoryTransfer(operationId);
        } finally {
            lease.value.release();
        }
    }

    private finishInventoryTransfer(operationId: string): Result<FakePlayerRecord> {
        for (let step = 0; step < 6; step += 1) {
            const loaded = this.getInventoryTransfer(operationId);
            if (!loaded.ok) return loaded;
            const transfer = loaded.value;
            switch (transfer.phase) {
                case "prepared": {
                    const staged = this.access.prepareTransfer(transfer);
                    if (!staged.ok) return staged;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "prepared", "staged");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "staged": {
                    const advanced = this.advanceInventoryTransfer(transfer.id, "staged", "applying");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "applying": {
                    const playerAfter = this.ensurePlayerInventoryAfter(transfer);
                    if (!playerAfter.ok) return playerAfter;
                    const record = this.commitInventoryCatalog(transfer);
                    if (!record.ok) return record;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "applying", "committed");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "committed": {
                    const verified = this.verifyCommittedInventoryTransfer(transfer);
                    if (!verified.ok) return verified;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "committed", "checkpointed");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "checkpointed": {
                    const oldSnapshot = this.snapshots.remove(transfer.fakeSnapshotId);
                    if (!oldSnapshot.ok) return oldSnapshot;
                    const images = this.access.removeTransferImages(transfer);
                    if (!images.ok) return images;
                    const removed = this.removeInventoryTransfer(transfer.id);
                    return removed.ok ? this.loadCommittedInventoryRecord(transfer) : removed;
                }
            }
        }
        return err("INVALID_STATE", `库存事务 ${operationId} 超出允许的状态推进次数。`);
    }

    private resumeExperienceTransfer(operationId: string): Result<FakePlayerRecord> {
        const transfer = this.getExperienceTransfer(operationId);
        if (!transfer.ok) return transfer;
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.value.fakePlayerId}`,
            `player:${transfer.value.playerId}`,
        ]);
        if (!lease.ok) return lease;
        try {
            return this.finishExperienceTransfer(operationId);
        } finally {
            lease.value.release();
        }
    }

    private finishExperienceTransfer(operationId: string): Result<FakePlayerRecord> {
        for (let step = 0; step < 3; step += 1) {
            const loaded = this.getExperienceTransfer(operationId);
            if (!loaded.ok) return loaded;
            const transfer = loaded.value;
            switch (transfer.phase) {
                case "prepared": {
                    const advanced = this.advanceExperienceTransfer(transfer.id, "prepared", "applying");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "applying": {
                    const playerAfter = this.ensurePlayerExperienceAfter(transfer);
                    if (!playerAfter.ok) return playerAfter;
                    const record = this.commitExperienceCatalog(transfer);
                    if (!record.ok) return record;
                    const advanced = this.advanceExperienceTransfer(transfer.id, "applying", "committed");
                    if (!advanced.ok) return advanced;
                    break;
                }
                case "committed": {
                    const verified = this.verifyCommittedExperienceTransfer(transfer);
                    if (!verified.ok) return verified;
                    const removed = this.removeExperienceTransfer(transfer.id);
                    return removed.ok ? this.loadCommittedExperienceRecord(transfer) : removed;
                }
            }
        }
        return err("INVALID_STATE", `经验事务 ${operationId} 超出允许的状态推进次数。`);
    }

    private ensurePlayerInventoryAfter(transfer: InventoryTransfer): Result<void> {
        const state = this.access.compareWithImages(transfer);
        if (!state.ok) return state;
        if (state.value === "after") return ok(undefined);
        if (state.value !== "before") return transferConflict(transfer.id, state.value);
        const applied = this.access.applyAfterImage(transfer);
        if (!applied.ok) return applied;
        const verified = this.access.compareWithImages(transfer);
        return verified.ok && verified.value === "after"
            ? ok(undefined)
            : inventoryVerificationFailure(transfer.id, verified);
    }

    private ensurePlayerExperienceAfter(transfer: ExperienceTransfer): Result<void> {
        const state = this.access.compareExperience(transfer);
        if (!state.ok) return state;
        if (state.value === "after") return ok(undefined);
        if (state.value !== "before") return transferConflict(transfer.id, state.value);
        const applied = this.access.setPlayerExperience(transfer.playerId, transfer.playerBefore + transfer.amount);
        if (!applied.ok) return applied;
        const verified = this.access.compareExperience(transfer);
        return verified.ok && verified.value === "after"
            ? ok(undefined)
            : inventoryVerificationFailure(transfer.id, verified);
    }

    private commitInventoryCatalog(transfer: InventoryTransfer): Result<FakePlayerRecord> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${transfer.fakePlayerId}。`);
        if (recordMatchesInventoryAfter(record, transfer)) return ok(record);
        if (!recordMatchesInventoryBefore(record, transfer) || record.inventoryRevision === null) {
            return err("CONFLICT", `库存事务 ${transfer.id} 与当前假人 revision 或快照不一致。`);
        }
        const nextRevision = record.inventoryRevision + 1;
        if (snapshotId(record.id, nextRevision) !== transfer.fakeAfterSnapshotId || !this.snapshots.has(transfer.fakeAfterSnapshotId)) {
            return err("NOT_FOUND", `库存事务 ${transfer.id} 的假人 after 快照不存在或编号无效。`);
        }
        const nextRecord: FakePlayerRecord = {
            ...record,
            recordRevision: record.recordRevision + 1,
            inventoryRevision: nextRevision,
        };
        const committed = commitRecord(this.stateStore, loaded.state.revision, loaded.state.value, nextRecord);
        return committed.ok ? ok(nextRecord) : committed;
    }

    private commitExperienceCatalog(transfer: ExperienceTransfer): Result<FakePlayerRecord> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${transfer.fakePlayerId}。`);
        if (recordMatchesExperienceAfter(record, transfer)) return ok(record);
        if (!recordMatchesExperienceBefore(record, transfer)) {
            return err("CONFLICT", `经验事务 ${transfer.id} 与当前假人 revision 或经验不一致。`);
        }
        const nextRecord: FakePlayerRecord = {
            ...record,
            recordRevision: record.recordRevision + 1,
            totalExperience: record.totalExperience - transfer.amount,
        };
        const committed = commitRecord(this.stateStore, loaded.state.revision, loaded.state.value, nextRecord);
        return committed.ok ? ok(nextRecord) : committed;
    }

    private verifyCommittedInventoryTransfer(transfer: InventoryTransfer): Result<void> {
        const state = this.access.compareWithImages(transfer);
        if (!state.ok) return state;
        if (state.value !== "after") return transferConflict(transfer.id, state.value);
        const record = this.loadCommittedInventoryRecord(transfer);
        return record.ok ? ok(undefined) : record;
    }

    private verifyCommittedExperienceTransfer(transfer: ExperienceTransfer): Result<void> {
        const state = this.access.compareExperience(transfer);
        if (!state.ok) return state;
        if (state.value !== "after") return transferConflict(transfer.id, state.value);
        const record = this.loadCommittedExperienceRecord(transfer);
        return record.ok ? ok(undefined) : record;
    }

    private loadCommittedInventoryRecord(transfer: InventoryTransfer): Result<FakePlayerRecord> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        return record !== undefined && recordMatchesInventoryAfter(record, transfer)
            ? ok(record)
            : err("CONFLICT", `库存事务 ${transfer.id} 的 catalog 提交状态不一致。`);
    }

    private loadCommittedExperienceRecord(transfer: ExperienceTransfer): Result<FakePlayerRecord> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        return record !== undefined && recordMatchesExperienceAfter(record, transfer)
            ? ok(record)
            : err("CONFLICT", `经验事务 ${transfer.id} 的 catalog 提交状态不一致。`);
    }

    private loadOfflineRecord(
        id: FakePlayerId,
        expectedRecordRevision: number,
    ): Result<{ readonly record: FakePlayerRecord }> {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined) return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        return record.lifecycle.kind === "offline"
            ? ok({ record })
            : err("INVALID_STATE", `库存和经验事务只允许从 offline 状态开始，当前为 ${record.lifecycle.kind}。`);
    }

    private ensureTransferResourcesAvailable(fakePlayerId: string, playerId: string): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const pending = [
            ...Object.values(loaded.value.operations.inventoryTransfers),
            ...Object.values(loaded.value.operations.experienceTransfers),
        ].find((transfer) => transfer.fakePlayerId === fakePlayerId || transfer.playerId === playerId);
        return pending === undefined
            ? ok(undefined)
            : err("CONFLICT", `资源正由待恢复事务 ${pending.id} 占用。`);
    }

    private authorize(actor: ActorIdentity): Result<void> {
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        return isAllowed(actor, loaded.state.value, "manage")
            ? ok(undefined)
            : err("PERMISSION_DENIED", "你没有管理假人背包或经验的权限。");
    }

    private loadOperations(): Result<{ readonly operations: PendingOperations; readonly revision: number }> {
        const loaded = this.stateStore.loadOperations();
        return loaded.ok
            ? ok({ operations: loaded.state.value, revision: loaded.state.revision })
            : err("CONFLICT", loaded.diagnostics.join("; "));
    }

    private getInventoryTransfer(operationId: string): Result<InventoryTransfer> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const transfer = loaded.value.operations.inventoryTransfers[operationId];
        return transfer === undefined ? err("NOT_FOUND", `未找到库存事务 ${operationId}。`) : ok(transfer);
    }

    private getExperienceTransfer(operationId: string): Result<ExperienceTransfer> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const transfer = loaded.value.operations.experienceTransfers[operationId];
        return transfer === undefined ? err("NOT_FOUND", `未找到经验事务 ${operationId}。`) : ok(transfer);
    }

    private addInventoryTransfer(transfer: InventoryTransfer): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            inventoryTransfers: { ...loaded.value.operations.inventoryTransfers, [transfer.id]: transfer },
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private addExperienceTransfer(transfer: ExperienceTransfer): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            experienceTransfers: { ...loaded.value.operations.experienceTransfers, [transfer.id]: transfer },
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private advanceInventoryTransfer(
        operationId: string,
        expectedPhase: InventoryTransfer["phase"],
        phase: InventoryTransfer["phase"],
    ): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const transfer = loaded.value.operations.inventoryTransfers[operationId];
        if (transfer === undefined) return err("NOT_FOUND", `未找到库存事务 ${operationId}。`);
        if (transfer.phase !== expectedPhase) {
            return err("CONFLICT", `库存事务 ${operationId} 期望阶段 ${expectedPhase}，实际为 ${transfer.phase}。`);
        }
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            inventoryTransfers: {
                ...loaded.value.operations.inventoryTransfers,
                [operationId]: { ...transfer, phase },
            },
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private advanceExperienceTransfer(
        operationId: string,
        expectedPhase: ExperienceTransfer["phase"],
        phase: ExperienceTransfer["phase"],
    ): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const transfer = loaded.value.operations.experienceTransfers[operationId];
        if (transfer === undefined) return err("NOT_FOUND", `未找到经验事务 ${operationId}。`);
        if (transfer.phase !== expectedPhase) {
            return err("CONFLICT", `经验事务 ${operationId} 期望阶段 ${expectedPhase}，实际为 ${transfer.phase}。`);
        }
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            experienceTransfers: {
                ...loaded.value.operations.experienceTransfers,
                [operationId]: { ...transfer, phase },
            },
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private removeInventoryTransfer(operationId: string): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const inventoryTransfers = { ...loaded.value.operations.inventoryTransfers };
        delete inventoryTransfers[operationId];
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            inventoryTransfers,
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private removeExperienceTransfer(operationId: string): Result<void> {
        const loaded = this.loadOperations();
        if (!loaded.ok) return loaded;
        const experienceTransfers = { ...loaded.value.operations.experienceTransfers };
        delete experienceTransfers[operationId];
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            experienceTransfers,
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private compareCheckpointPriority(left: FakePlayerRecord, right: FakePlayerRecord): number {
        const leftTick = left.lastCheckpointTick ?? -1;
        const rightTick = right.lastCheckpointTick ?? -1;
        if (leftTick !== rightTick) return leftTick - rightTick;
        const dirtyDifference = Number(this.dirty.has(right.id)) - Number(this.dirty.has(left.id));
        return dirtyDifference !== 0 ? dirtyDifference : left.id.localeCompare(right.id);
    }
}

export function snapshotId(id: FakePlayerId, revision: number): string {
    return `xiaobo:${id}_inv_${revision}`;
}

function commitRecord(
    store: WorldStateStore,
    catalogRevision: number,
    catalog: WorldCatalog,
    record: FakePlayerRecord,
): Result<void> {
    const committed = store.commitCatalog(catalogRevision, {
        ...catalog,
        records: { ...catalog.records, [record.id]: record },
    });
    return committed.ok ? ok(undefined) : committed;
}

function createInventoryTransfer(
    record: FakePlayerRecord,
    playerId: string,
    request: InventoryTransferRequest,
): InventoryTransfer {
    const nextInventoryRevision = (record.inventoryRevision ?? 0) + 1;
    const id = `${record.id}:inventory:${record.recordRevision}`;
    return {
        id,
        fakePlayerId: record.id,
        playerId,
        fakePlayerRevision: record.recordRevision,
        fakeSnapshotId: snapshotId(record.id, record.inventoryRevision ?? 0),
        fakeAfterSnapshotId: snapshotId(record.id, nextInventoryRevision),
        request,
        beforeStructureId: `xiaobo:${record.id}_tx_${record.recordRevision}_before`,
        afterStructureId: `xiaobo:${record.id}_tx_${record.recordRevision}_after`,
        phase: "prepared",
    };
}

function validateTransferRequest(request: InventoryTransferRequest): Result<void> {
    switch (request.kind) {
        case "recycle_all":
            return ok(undefined);
        case "swap":
        case "take":
        case "put":
            if (!validSlot(request.fakeSlot, TOTAL_SLOT_COUNT)) {
                return err("INVALID_SLOT", `无效假人槽位：${request.fakeSlot}。`);
            }
            return validSlot(request.playerSlot, INVENTORY_SLOT_COUNT)
                ? ok(undefined)
                : err("INVALID_SLOT", `无效玩家槽位：${request.playerSlot}。`);
        case "swap_fake":
            if (!validSlot(request.firstSlot, TOTAL_SLOT_COUNT)) {
                return err("INVALID_SLOT", `无效假人槽位：${request.firstSlot}。`);
            }
            return validSlot(request.secondSlot, TOTAL_SLOT_COUNT)
                ? ok(undefined)
                : err("INVALID_SLOT", `无效假人槽位：${request.secondSlot}。`);
    }
}

function validSlot(slot: number, size: number): boolean {
    return Number.isInteger(slot) && slot >= 0 && slot < size;
}

function createExperienceTransfer(
    record: FakePlayerRecord,
    playerId: string,
    playerBefore: number,
    amount: number,
): ExperienceTransfer {
    return {
        id: `${record.id}:experience:${record.recordRevision}`,
        fakePlayerId: record.id,
        playerId,
        fakePlayerRevision: record.recordRevision,
        kind: "fake_to_player",
        fakePlayerBefore: record.totalExperience,
        playerBefore,
        amount,
        phase: "prepared",
    };
}

function recordMatchesInventoryBefore(record: FakePlayerRecord, transfer: InventoryTransfer): boolean {
    return record.recordRevision === transfer.fakePlayerRevision
        && record.inventoryRevision !== null
        && snapshotId(record.id, record.inventoryRevision) === transfer.fakeSnapshotId;
}

function recordMatchesInventoryAfter(record: FakePlayerRecord, transfer: InventoryTransfer): boolean {
    return record.recordRevision === transfer.fakePlayerRevision + 1
        && record.inventoryRevision !== null
        && snapshotId(record.id, record.inventoryRevision) === transfer.fakeAfterSnapshotId;
}

function recordMatchesExperienceBefore(record: FakePlayerRecord, transfer: ExperienceTransfer): boolean {
    return record.recordRevision === transfer.fakePlayerRevision
        && record.totalExperience === transfer.fakePlayerBefore;
}

function recordMatchesExperienceAfter(record: FakePlayerRecord, transfer: ExperienceTransfer): boolean {
    return record.recordRevision === transfer.fakePlayerRevision + 1
        && record.totalExperience === transfer.fakePlayerBefore - transfer.amount;
}

function transferConflict(operationId: string, state: InventoryImageState): Result<void> {
    return err("CONFLICT", `事务 ${operationId} 当前为 ${state}，已保留 before/after 数据等待恢复。`);
}

function inventoryVerificationFailure(
    operationId: string,
    verification: Result<InventoryImageState>,
): Result<void> {
    return verification.ok
        ? transferConflict(operationId, verification.value)
        : verification;
}