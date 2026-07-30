import { INVENTORY_SLOT_COUNT, TOTAL_SLOT_COUNT } from "../domain/inventory.js";
import { isAllowed } from "../domain/permissions.js";
import { err, ok } from "../domain/results.js";
const PERIODIC_CHECKPOINT_INTERVAL_TICKS = 20;
export class InventoryService {
    stateStore;
    runtime;
    snapshots;
    coordinator;
    access;
    dirty = new Set();
    lastAttemptedId;
    constructor(stateStore, runtime, snapshots, coordinator, access) {
        this.stateStore = stateStore;
        this.runtime = runtime;
        this.snapshots = snapshots;
        this.coordinator = coordinator;
        this.access = access;
    }
    markDirty(id) {
        this.dirty.add(id);
    }
    getPlayerMainhandItemTypeId(actor) {
        const authorization = this.authorize(actor);
        return authorization.ok
            ? this.access.getPlayerMainhandItemTypeId(actor.playerId)
            : authorization;
    }
    getOverview(actor, id, expectedRecordRevision) {
        const authorization = this.authorize(actor);
        if (!authorization.ok)
            return authorization;
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok)
            return lease;
        try {
            const context = this.loadInventoryRecord(id, expectedRecordRevision);
            if (!context.ok)
                return context;
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok)
                return available;
            const record = context.value.record;
            const runtime = record.lifecycle.kind === "online" ? this.runtime.get(id) : undefined;
            if (record.lifecycle.kind === "online" && (runtime === undefined || !runtime.alive)) {
                return err("INVALID_STATE", `假人 ${id} 没有存活的在线实例。`);
            }
            if (record.lifecycle.kind === "offline" && record.inventoryRevision === null) {
                return err("INVALID_STATE", `假人 ${id} 尚无库存快照。`);
            }
            const slots = record.lifecycle.kind === "online"
                ? this.access.readLiveOverview(id)
                : this.access.readSnapshotOverview(snapshotId(id, record.inventoryRevision), actor.playerId);
            return slots.ok ? ok({
                id,
                name: record.name,
                recordRevision: record.recordRevision,
                inventoryRevision: record.inventoryRevision,
                selectedSlot: runtime?.selectedSlot ?? record.selectedSlot,
                totalExperience: runtime?.totalExperience ?? record.totalExperience,
                lastCheckpointTick: record.lastCheckpointTick,
                slots: slots.value,
            }) : slots;
        }
        finally {
            lease.value.release();
        }
    }
    checkpoint(id, expectedRecordRevision, currentTick) {
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok)
            return lease;
        try {
            return this.checkpointWithLease(id, expectedRecordRevision, currentTick);
        }
        finally {
            lease.value.release();
        }
    }
    checkpointNext(currentTick) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const operations = this.loadOperations();
        if (!operations.ok)
            return operations;
        const pendingIds = new Set([
            ...Object.values(operations.value.operations.inventoryTransfers).map((transfer) => transfer.fakePlayerId),
            ...Object.values(operations.value.operations.experienceTransfers).map((transfer) => transfer.fakePlayerId),
        ]);
        const candidates = Object.values(loaded.state.value.records)
            .filter((record) => (record.lifecycle.kind === "online"
            && this.runtime.get(record.id)?.alive === true
            && !pendingIds.has(record.id)
            && (this.dirty.has(record.id) || checkpointDue(record, currentTick))))
            .sort((left, right) => this.compareCheckpointPriority(left, right));
        const lastIndex = candidates.findIndex((record) => record.id === this.lastAttemptedId);
        const rotated = lastIndex < 0
            ? candidates
            : [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)];
        for (const candidate of rotated) {
            this.lastAttemptedId = candidate.id;
            const lease = this.coordinator.tryAcquire([`fake:${candidate.id}`]);
            if (!lease.ok)
                continue;
            try {
                return this.checkpointWithLease(candidate.id, candidate.recordRevision, currentTick);
            }
            finally {
                lease.value.release();
            }
        }
        return ok(undefined);
    }
    transferItems(actor, id, expectedRecordRevision, request) {
        const authorization = this.authorize(actor);
        if (!authorization.ok)
            return authorization;
        const validRequest = validateTransferRequest(request);
        if (!validRequest.ok)
            return validRequest;
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok)
            return lease;
        try {
            const context = this.loadInventoryRecord(id, expectedRecordRevision);
            if (!context.ok)
                return context;
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok)
                return available;
            const synchronized = this.synchronizeOnlineRecord(context.value.record);
            if (!synchronized.ok)
                return synchronized;
            if (synchronized.value.inventoryRevision === null) {
                return err("INVALID_STATE", `假人 ${id} 尚无库存快照。`);
            }
            const transfer = createInventoryTransfer(synchronized.value, actor.playerId, request);
            const prepared = this.addInventoryTransfer(transfer);
            return prepared.ok ? this.finishInventoryTransfer(transfer.id) : prepared;
        }
        finally {
            lease.value.release();
        }
    }
    transferExperience(actor, id, expectedRecordRevision, amount) {
        const authorization = this.authorize(actor);
        if (!authorization.ok)
            return authorization;
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            return err("INVALID_STATE", "经验转移量必须是正安全整数。");
        }
        const lease = this.coordinator.tryAcquire([`fake:${id}`, `player:${actor.playerId}`]);
        if (!lease.ok)
            return lease;
        try {
            const context = this.loadInventoryRecord(id, expectedRecordRevision);
            if (!context.ok)
                return context;
            const available = this.ensureTransferResourcesAvailable(id, actor.playerId);
            if (!available.ok)
                return available;
            const synchronized = this.synchronizeOnlineRecord(context.value.record);
            if (!synchronized.ok)
                return synchronized;
            if (amount > synchronized.value.totalExperience) {
                return err("INVALID_STATE", "转移量不能超过假人当前总经验。");
            }
            const playerBefore = this.access.getPlayerExperience(actor.playerId);
            if (!playerBefore.ok)
                return playerBefore;
            if (!Number.isSafeInteger(playerBefore.value + amount)) {
                return err("DATA_CAPACITY", "经验转移后的玩家总经验超出安全整数范围。");
            }
            const transfer = createExperienceTransfer(synchronized.value, actor.playerId, playerBefore.value, amount);
            const prepared = this.addExperienceTransfer(transfer);
            return prepared.ok ? this.finishExperienceTransfer(transfer.id) : prepared;
        }
        finally {
            lease.value.release();
        }
    }
    recycleContents(actor, id, expectedRecordRevision) {
        const items = this.transferItems(actor, id, expectedRecordRevision, { kind: "recycle_all" });
        if (!items.ok || items.value.totalExperience === 0)
            return items;
        return this.transferExperience(actor, id, items.value.recordRevision, items.value.totalExperience);
    }
    listPendingTransfers(actor) {
        if (!actor.isOperator)
            return err("PERMISSION_DENIED", "只有 OP 可以查看待恢复事务。");
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        return ok([
            ...Object.values(loaded.value.operations.inventoryTransfers).map((transfer) => ({
                id: transfer.id,
                kind: "inventory",
                fakePlayerId: transfer.fakePlayerId,
                playerId: transfer.playerId,
                phase: transfer.phase,
            })),
            ...Object.values(loaded.value.operations.experienceTransfers).map((transfer) => ({
                id: transfer.id,
                kind: "experience",
                fakePlayerId: transfer.fakePlayerId,
                playerId: transfer.playerId,
                phase: transfer.phase,
            })),
        ].sort((left, right) => left.id.localeCompare(right.id)));
    }
    retryPendingTransfer(actor, operationId) {
        if (!actor.isOperator)
            return err("PERMISSION_DENIED", "只有 OP 可以重试待恢复事务。");
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const inventoryTransfer = loaded.value.operations.inventoryTransfers[operationId];
        const experienceTransfer = loaded.value.operations.experienceTransfers[operationId];
        const transfer = inventoryTransfer ?? experienceTransfer;
        if (transfer === undefined)
            return err("NOT_FOUND", `未找到待恢复事务 ${operationId}。`);
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.fakePlayerId}`,
            `player:${transfer.playerId}`,
        ]);
        if (!lease.ok)
            return lease;
        try {
            return inventoryTransfer === undefined
                ? this.finishExperienceTransfer(operationId)
                : this.finishInventoryTransfer(operationId);
        }
        finally {
            lease.value.release();
        }
    }
    recoverPendingTransfers() {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const inventoryIds = Object.keys(loaded.value.operations.inventoryTransfers).sort();
        const experienceIds = Object.keys(loaded.value.operations.experienceTransfers).sort();
        let recovered = 0;
        const diagnostics = [];
        for (const operationId of inventoryIds) {
            const result = this.resumeInventoryTransfer(operationId);
            if (result.ok)
                recovered += 1;
            else
                diagnostics.push(`${operationId}: ${result.error.code}: ${result.error.message}`);
        }
        for (const operationId of experienceIds) {
            const result = this.resumeExperienceTransfer(operationId);
            if (result.ok)
                recovered += 1;
            else
                diagnostics.push(`${operationId}: ${result.error.code}: ${result.error.message}`);
        }
        return ok({ recovered, diagnostics });
    }
    ensureNoPendingTransfer(fakePlayerId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const transfer = [
            ...Object.values(loaded.value.operations.inventoryTransfers),
            ...Object.values(loaded.value.operations.experienceTransfers),
        ].find((candidate) => candidate.fakePlayerId === fakePlayerId);
        return transfer === undefined
            ? ok(undefined)
            : err("CONFLICT", `假人 ${fakePlayerId} 正由待恢复事务 ${transfer.id} 占用。`);
    }
    checkpointWithLease(id, expectedRecordRevision, currentTick) {
        if (!Number.isSafeInteger(currentTick) || currentTick < 0) {
            return err("INVALID_STATE", "检查点 tick 必须是非负安全整数。");
        }
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${id}。`);
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
        if (!saved.ok)
            return saved;
        const currentSnapshotExists = record.inventoryRevision !== null
            && this.snapshots.has(snapshotId(id, record.inventoryRevision));
        const fallbackSnapshotExists = record.inventoryFallbackRevision !== null
            && this.snapshots.has(snapshotId(id, record.inventoryFallbackRevision));
        const fallbackRevision = currentSnapshotExists
            ? record.inventoryRevision
            : fallbackSnapshotExists
                ? record.inventoryFallbackRevision
                : null;
        const nextRecord = {
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
            inventoryFallbackRevision: fallbackRevision,
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
        if (record.inventoryFallbackRevision !== null
            && record.inventoryFallbackRevision !== fallbackRevision) {
            const obsoleteId = snapshotId(id, record.inventoryFallbackRevision);
            const removed = this.snapshots.remove(obsoleteId);
            if (!removed.ok) {
                return err("CONFLICT", `新快照 ${saved.value} 已提交，但过期快照 ${obsoleteId} 清理失败：${removed.error.message}`);
            }
        }
        return ok({ record: nextRecord, structureId: saved.value });
    }
    resumeInventoryTransfer(operationId) {
        const transfer = this.getInventoryTransfer(operationId);
        if (!transfer.ok)
            return transfer;
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.value.fakePlayerId}`,
            `player:${transfer.value.playerId}`,
        ]);
        if (!lease.ok)
            return lease;
        try {
            return this.finishInventoryTransfer(operationId);
        }
        finally {
            lease.value.release();
        }
    }
    finishInventoryTransfer(operationId) {
        for (let step = 0; step < 6; step += 1) {
            const loaded = this.getInventoryTransfer(operationId);
            if (!loaded.ok)
                return loaded;
            const transfer = loaded.value;
            switch (transfer.phase) {
                case "prepared": {
                    const staged = this.access.prepareTransfer(transfer);
                    if (!staged.ok)
                        return staged;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "prepared", "staged");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "staged": {
                    const advanced = this.advanceInventoryTransfer(transfer.id, "staged", "applying");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "applying": {
                    const playerAfter = this.ensurePlayerInventoryAfter(transfer);
                    if (!playerAfter.ok)
                        return playerAfter;
                    const fakePlayerAfter = this.ensureFakePlayerInventoryAfter(transfer);
                    if (!fakePlayerAfter.ok)
                        return fakePlayerAfter;
                    const record = this.commitInventoryCatalog(transfer);
                    if (!record.ok)
                        return record;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "applying", "committed");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "committed": {
                    const verified = this.verifyCommittedInventoryTransfer(transfer);
                    if (!verified.ok)
                        return verified;
                    const advanced = this.advanceInventoryTransfer(transfer.id, "committed", "checkpointed");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "checkpointed": {
                    const record = this.loadCommittedInventoryRecord(transfer);
                    if (!record.ok || record.value.inventoryRevision === null) {
                        return record.ok
                            ? err("INVALID_STATE", `库存事务 ${transfer.id} 提交后缺少库存 revision。`)
                            : record;
                    }
                    const obsoleteSnapshots = new Set([
                        transfer.fakeSnapshotId,
                        ...(transfer.fakeFallbackSnapshotId === undefined
                            ? record.value.inventoryRevision > 2
                                ? [snapshotId(transfer.fakePlayerId, record.value.inventoryRevision - 2)]
                                : []
                            : [transfer.fakeFallbackSnapshotId]),
                    ]);
                    for (const structureId of obsoleteSnapshots) {
                        const removed = this.snapshots.remove(structureId);
                        if (!removed.ok)
                            return removed;
                    }
                    const images = this.access.removeTransferImages(transfer);
                    if (!images.ok)
                        return images;
                    const removed = this.removeInventoryTransfer(transfer.id);
                    return removed.ok ? this.loadCommittedInventoryRecord(transfer) : removed;
                }
            }
        }
        return err("INVALID_STATE", `库存事务 ${operationId} 超出允许的状态推进次数。`);
    }
    resumeExperienceTransfer(operationId) {
        const transfer = this.getExperienceTransfer(operationId);
        if (!transfer.ok)
            return transfer;
        const lease = this.coordinator.tryAcquire([
            `fake:${transfer.value.fakePlayerId}`,
            `player:${transfer.value.playerId}`,
        ]);
        if (!lease.ok)
            return lease;
        try {
            return this.finishExperienceTransfer(operationId);
        }
        finally {
            lease.value.release();
        }
    }
    finishExperienceTransfer(operationId) {
        for (let step = 0; step < 3; step += 1) {
            const loaded = this.getExperienceTransfer(operationId);
            if (!loaded.ok)
                return loaded;
            const transfer = loaded.value;
            switch (transfer.phase) {
                case "prepared": {
                    const advanced = this.advanceExperienceTransfer(transfer.id, "prepared", "applying");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "applying": {
                    const playerAfter = this.ensurePlayerExperienceAfter(transfer);
                    if (!playerAfter.ok)
                        return playerAfter;
                    const fakePlayerAfter = this.ensureFakePlayerExperienceAfter(transfer);
                    if (!fakePlayerAfter.ok)
                        return fakePlayerAfter;
                    const record = this.commitExperienceCatalog(transfer);
                    if (!record.ok)
                        return record;
                    const advanced = this.advanceExperienceTransfer(transfer.id, "applying", "committed");
                    if (!advanced.ok)
                        return advanced;
                    break;
                }
                case "committed": {
                    const verified = this.verifyCommittedExperienceTransfer(transfer);
                    if (!verified.ok)
                        return verified;
                    const removed = this.removeExperienceTransfer(transfer.id);
                    return removed.ok ? this.loadCommittedExperienceRecord(transfer) : removed;
                }
            }
        }
        return err("INVALID_STATE", `经验事务 ${operationId} 超出允许的状态推进次数。`);
    }
    ensurePlayerInventoryAfter(transfer) {
        const state = this.access.compareWithImages(transfer);
        if (!state.ok)
            return state;
        if (state.value === "after")
            return ok(undefined);
        if (state.value !== "before")
            return transferConflict(transfer.id, state.value);
        const applied = this.access.applyAfterImage(transfer);
        if (!applied.ok)
            return applied;
        const verified = this.access.compareWithImages(transfer);
        return verified.ok && verified.value === "after"
            ? ok(undefined)
            : inventoryVerificationFailure(transfer.id, verified);
    }
    ensureFakePlayerInventoryAfter(transfer) {
        const online = this.transferRequiresLiveFakePlayer(transfer.fakePlayerId);
        if (!online.ok || !online.value)
            return online.ok ? ok(undefined) : online;
        const state = this.access.compareFakeWithImages(transfer);
        if (!state.ok)
            return state;
        if (state.value === "after")
            return ok(undefined);
        if (state.value !== "before")
            return transferConflict(transfer.id, state.value);
        const applied = this.access.applyFakeAfterImage(transfer);
        if (!applied.ok)
            return applied;
        const verified = this.access.compareFakeWithImages(transfer);
        return verified.ok && verified.value === "after"
            ? ok(undefined)
            : inventoryVerificationFailure(transfer.id, verified);
    }
    ensurePlayerExperienceAfter(transfer) {
        const state = this.access.compareExperience(transfer);
        if (!state.ok)
            return state;
        if (state.value === "after")
            return ok(undefined);
        if (state.value !== "before")
            return transferConflict(transfer.id, state.value);
        const applied = this.access.setPlayerExperience(transfer.playerId, transfer.playerBefore + transfer.amount);
        if (!applied.ok)
            return applied;
        const verified = this.access.compareExperience(transfer);
        return verified.ok && verified.value === "after"
            ? ok(undefined)
            : inventoryVerificationFailure(transfer.id, verified);
    }
    ensureFakePlayerExperienceAfter(transfer) {
        const online = this.transferRequiresLiveFakePlayer(transfer.fakePlayerId);
        if (!online.ok || !online.value)
            return online.ok ? ok(undefined) : online;
        const current = this.access.getFakePlayerExperience(transfer.fakePlayerId);
        if (!current.ok)
            return current;
        const after = transfer.fakePlayerBefore - transfer.amount;
        if (current.value === after)
            return ok(undefined);
        if (current.value !== transfer.fakePlayerBefore)
            return transferConflict(transfer.id, "conflict");
        const applied = this.access.setFakePlayerExperience(transfer.fakePlayerId, after);
        if (!applied.ok)
            return applied;
        const verified = this.access.getFakePlayerExperience(transfer.fakePlayerId);
        return verified.ok && verified.value === after
            ? ok(undefined)
            : err("CONFLICT", `经验事务 ${transfer.id} 写入假人后回读失败。`);
    }
    commitInventoryCatalog(transfer) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${transfer.fakePlayerId}。`);
        if (recordMatchesInventoryAfter(record, transfer))
            return ok(record);
        if (!recordMatchesInventoryBefore(record, transfer) || record.inventoryRevision === null) {
            return err("CONFLICT", `库存事务 ${transfer.id} 与当前假人 revision 或快照不一致。`);
        }
        const nextRevision = record.inventoryRevision + 1;
        if (snapshotId(record.id, nextRevision) !== transfer.fakeAfterSnapshotId || !this.snapshots.has(transfer.fakeAfterSnapshotId)) {
            return err("NOT_FOUND", `库存事务 ${transfer.id} 的假人 after 快照不存在或编号无效。`);
        }
        const nextRecord = {
            ...record,
            recordRevision: record.recordRevision + 1,
            inventoryRevision: nextRevision,
            inventoryFallbackRevision: null,
        };
        const committed = commitRecord(this.stateStore, loaded.state.revision, loaded.state.value, nextRecord);
        return committed.ok ? ok(nextRecord) : committed;
    }
    commitExperienceCatalog(transfer) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${transfer.fakePlayerId}。`);
        if (recordMatchesExperienceAfter(record, transfer))
            return ok(record);
        if (!recordMatchesExperienceBefore(record, transfer)) {
            return err("CONFLICT", `经验事务 ${transfer.id} 与当前假人 revision 或经验不一致。`);
        }
        const nextRecord = {
            ...record,
            recordRevision: record.recordRevision + 1,
            totalExperience: record.totalExperience - transfer.amount,
        };
        const committed = commitRecord(this.stateStore, loaded.state.revision, loaded.state.value, nextRecord);
        return committed.ok ? ok(nextRecord) : committed;
    }
    verifyCommittedInventoryTransfer(transfer) {
        const state = this.access.compareWithImages(transfer);
        if (!state.ok)
            return state;
        if (state.value !== "after")
            return transferConflict(transfer.id, state.value);
        const fakePlayer = this.ensureFakePlayerInventoryAfter(transfer);
        if (!fakePlayer.ok)
            return fakePlayer;
        const record = this.loadCommittedInventoryRecord(transfer);
        return record.ok ? ok(undefined) : record;
    }
    verifyCommittedExperienceTransfer(transfer) {
        const state = this.access.compareExperience(transfer);
        if (!state.ok)
            return state;
        if (state.value !== "after")
            return transferConflict(transfer.id, state.value);
        const fakePlayer = this.ensureFakePlayerExperienceAfter(transfer);
        if (!fakePlayer.ok)
            return fakePlayer;
        const record = this.loadCommittedExperienceRecord(transfer);
        return record.ok ? ok(undefined) : record;
    }
    loadCommittedInventoryRecord(transfer) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        return record !== undefined && recordMatchesInventoryAfter(record, transfer)
            ? ok(record)
            : err("CONFLICT", `库存事务 ${transfer.id} 的 catalog 提交状态不一致。`);
    }
    loadCommittedExperienceRecord(transfer) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[transfer.fakePlayerId];
        return record !== undefined && recordMatchesExperienceAfter(record, transfer)
            ? ok(record)
            : err("CONFLICT", `经验事务 ${transfer.id} 的 catalog 提交状态不一致。`);
    }
    loadInventoryRecord(id, expectedRecordRevision) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[id];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${id}。`);
        if (record.recordRevision !== expectedRecordRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRecordRevision}，实际为 ${record.recordRevision}。`);
        }
        return record.lifecycle.kind === "offline" || record.lifecycle.kind === "online"
            ? ok({ record })
            : err("INVALID_STATE", `假人 ${id} 当前处于 ${record.lifecycle.kind}，不能管理背包。`);
    }
    synchronizeOnlineRecord(record) {
        if (record.lifecycle.kind === "offline")
            return ok(record);
        const checkpoint = this.checkpointWithLease(record.id, record.recordRevision, record.lastCheckpointTick ?? 0);
        return checkpoint.ok ? ok(checkpoint.value.record) : checkpoint;
    }
    transferRequiresLiveFakePlayer(fakePlayerId) {
        const loaded = this.stateStore.loadCatalog();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const record = loaded.state.value.records[fakePlayerId];
        if (record === undefined)
            return err("NOT_FOUND", `未找到假人 ${fakePlayerId}。`);
        if (record.lifecycle.kind === "online")
            return ok(true);
        if (record.lifecycle.kind === "offline")
            return ok(false);
        return err("CONFLICT", `假人 ${fakePlayerId} 在库存事务期间进入 ${record.lifecycle.kind}。`);
    }
    ensureTransferResourcesAvailable(fakePlayerId, playerId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const pending = [
            ...Object.values(loaded.value.operations.inventoryTransfers),
            ...Object.values(loaded.value.operations.experienceTransfers),
        ].find((transfer) => transfer.fakePlayerId === fakePlayerId || transfer.playerId === playerId);
        return pending === undefined
            ? ok(undefined)
            : err("CONFLICT", `资源正由待恢复事务 ${pending.id} 占用。`);
    }
    authorize(actor) {
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        return isAllowed(actor, loaded.state.value, "manage")
            ? ok(undefined)
            : err("PERMISSION_DENIED", "你没有管理假人背包或经验的权限。");
    }
    loadOperations() {
        const loaded = this.stateStore.loadOperations();
        return loaded.ok
            ? ok({ operations: loaded.state.value, revision: loaded.state.revision })
            : err("CONFLICT", loaded.diagnostics.join("; "));
    }
    getInventoryTransfer(operationId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const transfer = loaded.value.operations.inventoryTransfers[operationId];
        return transfer === undefined ? err("NOT_FOUND", `未找到库存事务 ${operationId}。`) : ok(transfer);
    }
    getExperienceTransfer(operationId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const transfer = loaded.value.operations.experienceTransfers[operationId];
        return transfer === undefined ? err("NOT_FOUND", `未找到经验事务 ${operationId}。`) : ok(transfer);
    }
    addInventoryTransfer(transfer) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            inventoryTransfers: { ...loaded.value.operations.inventoryTransfers, [transfer.id]: transfer },
        });
        return committed.ok ? ok(undefined) : committed;
    }
    addExperienceTransfer(transfer) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            experienceTransfers: { ...loaded.value.operations.experienceTransfers, [transfer.id]: transfer },
        });
        return committed.ok ? ok(undefined) : committed;
    }
    advanceInventoryTransfer(operationId, expectedPhase, phase) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const transfer = loaded.value.operations.inventoryTransfers[operationId];
        if (transfer === undefined)
            return err("NOT_FOUND", `未找到库存事务 ${operationId}。`);
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
    advanceExperienceTransfer(operationId, expectedPhase, phase) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const transfer = loaded.value.operations.experienceTransfers[operationId];
        if (transfer === undefined)
            return err("NOT_FOUND", `未找到经验事务 ${operationId}。`);
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
    removeInventoryTransfer(operationId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const inventoryTransfers = { ...loaded.value.operations.inventoryTransfers };
        delete inventoryTransfers[operationId];
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            inventoryTransfers,
        });
        return committed.ok ? ok(undefined) : committed;
    }
    removeExperienceTransfer(operationId) {
        const loaded = this.loadOperations();
        if (!loaded.ok)
            return loaded;
        const experienceTransfers = { ...loaded.value.operations.experienceTransfers };
        delete experienceTransfers[operationId];
        const committed = this.stateStore.commitOperations(loaded.value.revision, {
            ...loaded.value.operations,
            experienceTransfers,
        });
        return committed.ok ? ok(undefined) : committed;
    }
    compareCheckpointPriority(left, right) {
        const leftTick = left.lastCheckpointTick ?? -1;
        const rightTick = right.lastCheckpointTick ?? -1;
        if (leftTick !== rightTick)
            return leftTick - rightTick;
        const dirtyDifference = Number(this.dirty.has(right.id)) - Number(this.dirty.has(left.id));
        return dirtyDifference !== 0 ? dirtyDifference : left.id.localeCompare(right.id);
    }
}
export function snapshotId(id, revision) {
    return `xiaobo:${id}_inv_${revision}`;
}
export function availableInventoryFallbackRevision(snapshots, record) {
    if (record.inventoryRevision !== null
        && snapshots.has(snapshotId(record.id, record.inventoryRevision))) {
        return record.inventoryRevision;
    }
    return record.inventoryFallbackRevision !== null
        && snapshots.has(snapshotId(record.id, record.inventoryFallbackRevision))
        ? record.inventoryFallbackRevision
        : null;
}
export function restoreInventorySnapshot(snapshots, record) {
    if (record.inventoryRevision === null) {
        return ok({ inventoryRevision: null, inventoryFallbackRevision: null, usedFallback: false });
    }
    const currentId = snapshotId(record.id, record.inventoryRevision);
    if (snapshots.has(currentId)) {
        const restored = snapshots.restore(record.id, currentId);
        return restored.ok
            ? ok({
                inventoryRevision: record.inventoryRevision,
                inventoryFallbackRevision: record.inventoryFallbackRevision,
                usedFallback: false,
            })
            : restored;
    }
    if (record.inventoryFallbackRevision !== null) {
        const fallbackId = snapshotId(record.id, record.inventoryFallbackRevision);
        if (snapshots.has(fallbackId)) {
            const restored = snapshots.restore(record.id, fallbackId);
            return restored.ok
                ? ok({
                    inventoryRevision: record.inventoryFallbackRevision,
                    inventoryFallbackRevision: null,
                    usedFallback: true,
                })
                : restored;
        }
    }
    return err("NOT_FOUND", `库存快照 ${currentId} 不存在，且没有可用的上一代快照。`);
}
function checkpointDue(record, currentTick) {
    return record.lastCheckpointTick === null
        || currentTick < record.lastCheckpointTick
        || currentTick - record.lastCheckpointTick >= PERIODIC_CHECKPOINT_INTERVAL_TICKS;
}
function commitRecord(store, catalogRevision, catalog, record) {
    const committed = store.commitCatalog(catalogRevision, {
        ...catalog,
        records: { ...catalog.records, [record.id]: record },
    });
    return committed.ok ? ok(undefined) : committed;
}
function createInventoryTransfer(record, playerId, request) {
    const nextInventoryRevision = (record.inventoryRevision ?? 0) + 1;
    const id = `${record.id}:inventory:${record.recordRevision}`;
    return {
        id,
        fakePlayerId: record.id,
        playerId,
        fakePlayerRevision: record.recordRevision,
        fakeSnapshotId: snapshotId(record.id, record.inventoryRevision ?? 0),
        ...(record.inventoryFallbackRevision === null
            ? {}
            : { fakeFallbackSnapshotId: snapshotId(record.id, record.inventoryFallbackRevision) }),
        fakeAfterSnapshotId: snapshotId(record.id, nextInventoryRevision),
        request,
        beforeStructureId: `xiaobo:${record.id}_tx_${record.recordRevision}_before`,
        afterStructureId: `xiaobo:${record.id}_tx_${record.recordRevision}_after`,
        phase: "prepared",
    };
}
function validateTransferRequest(request) {
    switch (request.kind) {
        case "recycle_all":
        case "swap_inventory":
        case "swap_equipment":
            return ok(undefined);
        case "swap":
            if (!validSlot(request.fakeSlot, TOTAL_SLOT_COUNT)) {
                return err("INVALID_SLOT", `无效假人槽位：${request.fakeSlot}。`);
            }
            return validSlot(request.playerSlot, TOTAL_SLOT_COUNT)
                ? ok(undefined)
                : err("INVALID_SLOT", `无效玩家槽位：${request.playerSlot}。`);
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
function validSlot(slot, size) {
    return Number.isInteger(slot) && slot >= 0 && slot < size;
}
function createExperienceTransfer(record, playerId, playerBefore, amount) {
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
function recordMatchesInventoryBefore(record, transfer) {
    return record.recordRevision === transfer.fakePlayerRevision
        && record.inventoryRevision !== null
        && snapshotId(record.id, record.inventoryRevision) === transfer.fakeSnapshotId;
}
function recordMatchesInventoryAfter(record, transfer) {
    return record.recordRevision === transfer.fakePlayerRevision + 1
        && record.inventoryRevision !== null
        && snapshotId(record.id, record.inventoryRevision) === transfer.fakeAfterSnapshotId;
}
function recordMatchesExperienceBefore(record, transfer) {
    return record.recordRevision === transfer.fakePlayerRevision
        && record.totalExperience === transfer.fakePlayerBefore;
}
function recordMatchesExperienceAfter(record, transfer) {
    return record.recordRevision === transfer.fakePlayerRevision + 1
        && record.totalExperience === transfer.fakePlayerBefore - transfer.amount;
}
function transferConflict(operationId, state) {
    return err("CONFLICT", `事务 ${operationId} 当前为 ${state}，已保留 before/after 数据等待恢复。`);
}
function inventoryVerificationFailure(operationId, verification) {
    return verification.ok
        ? transferConflict(operationId, verification.value)
        : verification;
}
//# sourceMappingURL=inventoryService.js.map