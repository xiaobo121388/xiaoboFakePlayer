import { advanceLifecycleOperation, transitionLifecycle } from "../domain/lifecycle.js";
import { err, ok } from "../domain/results.js";
import { availableInventoryFallbackRevision, restoreInventorySnapshot, snapshotId, } from "./inventoryService.js";
import { commitCatalogRecord, commitCatalogRemoval } from "./lifecycleService.js";
export class RecoveryRunner {
    stateStore;
    runtime;
    snapshots;
    coordinator;
    inventory;
    constructor(stateStore, runtime, snapshots, coordinator, inventory) {
        this.stateStore = stateStore;
        this.runtime = runtime;
        this.snapshots = snapshots;
        this.coordinator = coordinator;
        this.inventory = inventory;
    }
    run() {
        const initialCatalog = this.stateStore.loadCatalog();
        if (!initialCatalog.ok)
            return err("CONFLICT", initialCatalog.diagnostics.join("; "));
        const permissions = this.stateStore.loadPermissions();
        if (!permissions.ok)
            return err("CONFLICT", permissions.diagnostics.join("; "));
        const operations = this.stateStore.loadOperations();
        if (!operations.ok)
            return err("CONFLICT", operations.diagnostics.join("; "));
        const workspaceRecovery = this.snapshots.recoverWorkspaces();
        if (!workspaceRecovery.ok)
            return workspaceRecovery;
        const tagged = this.runtime.listTagged();
        for (const player of tagged) {
            if (initialCatalog.state.value.records[player.id] === undefined) {
                return err("CONFLICT", `发现没有 catalog 记录的稳定标签实体 ${player.id}。`);
            }
        }
        const pendingRuntime = this.restorePendingOnlineRuntimes(initialCatalog.state.value, operations.state.value);
        if (!pendingRuntime.ok)
            return pendingRuntime;
        const transferRecovery = this.inventory.recoverPendingTransfers();
        if (!transferRecovery.ok)
            return transferRecovery;
        const catalog = this.stateStore.loadCatalog();
        if (!catalog.ok)
            return err("CONFLICT", catalog.diagnostics.join("; "));
        const remainingOperations = this.stateStore.loadOperations();
        if (!remainingOperations.ok)
            return err("CONFLICT", remainingOperations.diagnostics.join("; "));
        const pendingInvariant = validatePendingTransferRecords(catalog.state.value, remainingOperations.state.value, this.runtime);
        if (!pendingInvariant.ok)
            return pendingInvariant;
        let recoveredRecords = 0;
        const diagnostics = [
            ...catalog.state.diagnostics,
            ...permissions.state.diagnostics,
            ...operations.state.diagnostics,
            ...transferRecovery.value.diagnostics,
        ];
        for (const id of Object.keys(catalog.state.value.records).sort()) {
            const recovered = this.recoverRecord(id);
            if (!recovered.ok) {
                const isolated = this.isolateMissingSnapshot(id, recovered.error);
                if (!isolated.ok)
                    return isolated;
                recoveredRecords += 1;
                diagnostics.push(`${id}: ${isolated.value}`);
                continue;
            }
            if (recovered.value !== "unchanged") {
                recoveredRecords += 1;
                diagnostics.push(`${id}: ${recovered.value}`);
            }
        }
        return ok({
            recoveredRecords,
            recoveredTransfers: transferRecovery.value.recovered,
            reboundEntities: tagged.length,
            diagnostics,
        });
    }
    isolateMissingSnapshot(id, failure) {
        if (failure.code !== "NOT_FOUND" || this.runtime.get(id) !== undefined)
            return err(failure.code, failure.message);
        const operations = this.stateStore.loadOperations();
        if (!operations.ok)
            return err("CONFLICT", operations.diagnostics.join("; "));
        const hasPendingTransfer = [
            ...Object.values(operations.state.value.inventoryTransfers),
            ...Object.values(operations.state.value.experienceTransfers),
        ].some((transfer) => transfer.fakePlayerId === id);
        if (hasPendingTransfer)
            return err(failure.code, failure.message);
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok)
            return lease;
        try {
            const loaded = this.stateStore.loadCatalog();
            if (!loaded.ok)
                return err("CONFLICT", loaded.diagnostics.join("; "));
            const record = loaded.state.value.records[id];
            if (record === undefined)
                return err("NOT_FOUND", `隔离恢复错误时未找到假人 ${id}。`);
            const operation = "operation" in record.lifecycle ? record.lifecycle.operation : undefined;
            const isolated = transitionLifecycle(record, record.recordRevision, {
                kind: "error",
                message: `${failure.code}: ${failure.message}`,
                ...(operation === undefined ? {} : { operation }),
            });
            if (!isolated.ok)
                return isolated;
            const committed = commitCatalogRecord(this.stateStore, loaded.state.revision, loaded.state.value, isolated.value);
            return committed.ok
                ? ok(`已隔离库存恢复错误：${failure.message}`)
                : committed;
        }
        finally {
            lease.value.release();
        }
    }
    restorePendingOnlineRuntimes(catalog, operations) {
        const inventoryTransferIds = new Set(Object.values(operations.inventoryTransfers).map((transfer) => transfer.fakePlayerId));
        const ids = new Set([
            ...inventoryTransferIds,
            ...Object.values(operations.experienceTransfers).map((transfer) => transfer.fakePlayerId),
        ]);
        for (const id of [...ids].sort()) {
            const record = catalog.records[id];
            if (record === undefined || record.lifecycle.kind !== "online")
                continue;
            const existing = this.runtime.get(id);
            if (existing !== undefined) {
                if (!existing.alive)
                    return err("INVALID_STATE", `待恢复事务的在线假人 ${id} 当前未存活。`);
                continue;
            }
            const requiresExactSnapshot = inventoryTransferIds.has(id);
            if (requiresExactSnapshot && record.inventoryRevision === null) {
                return err("INVALID_STATE", `待恢复库存事务的在线假人 ${id} 没有库存快照。`);
            }
            if (requiresExactSnapshot
                && !this.snapshots.has(snapshotId(id, record.inventoryRevision))) {
                return err("NOT_FOUND", `待恢复库存事务的精确快照 ${record.inventoryRevision} 不存在。`);
            }
            this.runtime.spawn(spawnRequest(record));
            if (record.inventoryRevision === null)
                continue;
            if (requiresExactSnapshot) {
                const restored = this.snapshots.restore(id, snapshotId(id, record.inventoryRevision));
                if (!restored.ok) {
                    return this.runtime.disconnect(id)
                        ? restored
                        : err("CONFLICT", `${restored.error.message}；且无法断开未恢复库存的假人 ${id}。`);
                }
                continue;
            }
            const restored = restoreInventorySnapshot(this.snapshots, record);
            if (!restored.ok) {
                return this.runtime.disconnect(id)
                    ? restored
                    : err("CONFLICT", `${restored.error.message}；且无法断开未恢复库存的假人 ${id}。`);
            }
            if (restored.value.usedFallback)
                this.inventory.markDirty(id);
        }
        return ok(undefined);
    }
    recoverRecord(id) {
        const lease = this.coordinator.tryAcquire([`fake:${id}`]);
        if (!lease.ok)
            return lease;
        try {
            const loaded = this.stateStore.loadCatalog();
            if (!loaded.ok)
                return err("CONFLICT", loaded.diagnostics.join("; "));
            const record = loaded.state.value.records[id];
            if (record === undefined)
                return err("NOT_FOUND", `恢复时未找到假人 ${id}。`);
            switch (record.lifecycle.kind) {
                case "online":
                    if (this.runtime.get(id) !== undefined)
                        return ok("unchanged");
                    return this.markMissingAndRestore(loaded.state.revision, loaded.state.value, record);
                case "offline":
                    if (this.runtime.get(id) !== undefined && !this.runtime.disconnect(id)) {
                        return err("CONFLICT", `无法断开应为离线状态的假人 ${id}。`);
                    }
                    return ok("unchanged");
                case "provisioning":
                    return this.finishProvisioning(loaded.state.revision, loaded.state.value, record);
                case "snapshotting":
                    return this.finishSnapshotting(loaded.state.revision, loaded.state.value, record);
                case "restoring":
                    return this.finishRestoring(loaded.state.revision, loaded.state.value, record);
                case "renaming":
                    return this.finishRenaming(loaded.state.revision, loaded.state.value, record);
                case "deleting":
                    return this.finishDeleting(loaded.state.revision, loaded.state.value, record);
                case "respawning":
                    return this.finishRespawning(loaded.state.revision, loaded.state.value, record);
                case "missing":
                    return record.expectedOnline
                        ? this.beginRestore(loaded.state.revision, loaded.state.value, record)
                        : err("INVALID_STATE", `${id} 为 missing 但 expectedOnline=false。`);
                case "error":
                    return ok("unchanged");
            }
        }
        finally {
            lease.value.release();
        }
    }
    markMissingAndRestore(catalogRevision, catalog, record) {
        const missing = transitionLifecycle(record, record.recordRevision, { kind: "missing" });
        if (!missing.ok)
            return missing;
        const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, missing.value);
        if (!committed.ok)
            return committed;
        return this.beginRestore(committed.value.catalogRevision, committed.value.catalog, committed.value.record);
    }
    beginRestore(catalogRevision, catalog, record) {
        const operation = {
            id: `${record.id}:online:${record.recordRevision}`,
            kind: "online",
            previous: "missing",
            target: "online",
            phase: "prepared",
        };
        const pending = transitionLifecycle(record, record.recordRevision, { kind: "restoring", operation });
        if (!pending.ok)
            return pending;
        const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, pending.value);
        if (!committed.ok)
            return committed;
        return this.finishRestoring(committed.value.catalogRevision, committed.value.catalog, committed.value.record);
    }
    finishProvisioning(catalogRevision, catalog, record) {
        if (this.runtime.get(record.id) === undefined)
            this.runtime.spawn(spawnRequest(record));
        const online = transitionLifecycle(record, record.recordRevision, { kind: "online" });
        if (!online.ok)
            return online;
        const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, online.value);
        return committed.ok ? ok("completed provisioning") : committed;
    }
    finishSnapshotting(catalogRevision, catalog, record) {
        const verifiedRevision = parseVerifiedSnapshotRevision(record);
        let pending = record;
        let currentCatalog = catalog;
        let currentCatalogRevision = catalogRevision;
        let snapshotRevision = verifiedRevision;
        let usedPriorSnapshot = false;
        if (snapshotRevision === undefined) {
            if (this.runtime.get(record.id) === undefined) {
                return err("INVALID_STATE", `${record.id} 在未验证快照阶段缺少在线实例。`);
            }
            snapshotRevision = (record.inventoryRevision ?? 0) + 1;
            const snapshot = this.snapshots.save(record.id, snapshotRevision);
            if (!snapshot.ok)
                return snapshot;
            const advanced = advanceLifecycleOperation(record, record.recordRevision, `snapshot_verified:${snapshotRevision}`);
            if (!advanced.ok)
                return advanced;
            const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, advanced.value);
            if (!committed.ok)
                return committed;
            pending = committed.value.record;
            currentCatalog = committed.value.catalog;
            currentCatalogRevision = committed.value.catalogRevision;
        }
        else if (!this.snapshots.has(snapshotId(record.id, snapshotRevision))) {
            const priorRevision = availableInventoryFallbackRevision(this.snapshots, pending);
            if (priorRevision === null) {
                return err("NOT_FOUND", `${record.id} 已验证的库存快照 ${snapshotRevision} 不存在，且没有可用的旧快照。`);
            }
            snapshotRevision = priorRevision;
            usedPriorSnapshot = true;
        }
        if (this.runtime.get(record.id) !== undefined && !this.runtime.disconnect(record.id)) {
            return err("CONFLICT", `恢复快照后无法断开假人 ${record.id}。`);
        }
        const offline = transitionLifecycle(pending, pending.recordRevision, { kind: "offline" });
        if (!offline.ok)
            return offline;
        const fallbackRevision = usedPriorSnapshot
            ? pending.inventoryRevision === snapshotRevision
                && pending.inventoryFallbackRevision !== null
                && this.snapshots.has(snapshotId(record.id, pending.inventoryFallbackRevision))
                ? pending.inventoryFallbackRevision
                : null
            : this.inventory.getSessionRecoveryBaselineRevision(pending);
        const finalRecord = {
            ...offline.value,
            inventoryRevision: snapshotRevision,
            inventoryFallbackRevision: fallbackRevision,
            ...(usedPriorSnapshot ? { lastCheckpointTick: null } : {}),
        };
        const committed = commitCatalogRecord(this.stateStore, currentCatalogRevision, currentCatalog, finalRecord);
        if (!committed.ok)
            return committed;
        const cleanup = this.inventory.removeUnreferencedSnapshots(pending, [snapshotRevision, fallbackRevision]);
        if (!cleanup.ok)
            return cleanup;
        return ok(usedPriorSnapshot
            ? `已从旧库存快照 ${snapshotRevision} 完成下线恢复`
            : "completed snapshotting");
    }
    finishRestoring(catalogRevision, catalog, record) {
        const spawned = this.runtime.get(record.id) === undefined;
        if (spawned)
            this.runtime.spawn(spawnRequest(record));
        const restored = restoreInventorySnapshot(this.snapshots, record);
        if (!restored.ok) {
            if (!spawned)
                return restored;
            return this.runtime.disconnect(record.id)
                ? restored
                : err("CONFLICT", `${restored.error.message}；且无法断开未恢复库存的假人 ${record.id}。`);
        }
        const online = transitionLifecycle(record, record.recordRevision, { kind: "online" });
        if (!online.ok)
            return online;
        const finalRecord = restored.value.usedFallback
            ? {
                ...online.value,
                inventoryRevision: restored.value.inventoryRevision,
                inventoryFallbackRevision: restored.value.inventoryFallbackRevision,
                lastCheckpointTick: null,
            }
            : online.value;
        const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, finalRecord);
        return committed.ok
            ? ok(restored.value.usedFallback
                ? `已从上一代库存快照 ${restored.value.inventoryRevision} 完成恢复`
                : "completed restoring")
            : committed;
    }
    finishRenaming(catalogRevision, catalog, record) {
        const operation = lifecycleOperation(record);
        if (record.lifecycle.kind !== "renaming" || operation?.targetName === undefined) {
            return err("INVALID_STATE", `${record.id} 没有有效的重命名恢复数据。`);
        }
        if (operation.target === "online") {
            const existing = this.runtime.get(record.id);
            if (existing !== undefined && existing.name !== operation.targetName && !this.runtime.disconnect(record.id)) {
                return err("CONFLICT", `无法断开旧名称假人 ${record.id}。`);
            }
            const spawned = this.runtime.get(record.id) === undefined;
            if (spawned)
                this.runtime.spawn(spawnRequest(record));
            const restored = restoreInventorySnapshot(this.snapshots, record);
            if (!restored.ok) {
                if (!spawned)
                    return restored;
                return this.runtime.disconnect(record.id)
                    ? restored
                    : err("CONFLICT", `${restored.error.message}；且无法断开未恢复库存的假人 ${record.id}。`);
            }
            record = restored.value.usedFallback
                ? {
                    ...record,
                    inventoryRevision: restored.value.inventoryRevision,
                    inventoryFallbackRevision: restored.value.inventoryFallbackRevision,
                    lastCheckpointTick: null,
                }
                : record;
        }
        else if (this.runtime.get(record.id) !== undefined && !this.runtime.disconnect(record.id)) {
            return err("CONFLICT", `无法断开离线重命名假人 ${record.id}。`);
        }
        const stable = transitionLifecycle(record, record.recordRevision, {
            kind: operation.target === "online" ? "online" : "offline",
        });
        if (!stable.ok)
            return stable;
        const committed = commitCatalogRecord(this.stateStore, catalogRevision, catalog, stable.value);
        return committed.ok ? ok("completed renaming") : committed;
    }
    finishDeleting(catalogRevision, catalog, record) {
        let currentRecord = record;
        let currentCatalog = catalog;
        let currentRevision = catalogRevision;
        let operation = lifecycleOperation(currentRecord);
        if (currentRecord.lifecycle.kind !== "deleting" || operation?.kind !== "delete") {
            return err("INVALID_STATE", `${record.id} 没有有效的删除恢复数据。`);
        }
        if (this.runtime.get(record.id) !== undefined && !this.runtime.disconnect(record.id)) {
            return err("CONFLICT", `无法断开待删除假人 ${record.id}。`);
        }
        if (operation.phase !== "snapshot_removed") {
            const revisions = new Set([
                record.inventoryRevision,
                record.inventoryFallbackRevision,
                ...(operation.phase === "repair_discard" ? [(record.inventoryRevision ?? 0) + 1] : []),
            ]);
            for (const revision of revisions) {
                if (revision === null)
                    continue;
                const removed = this.snapshots.remove(snapshotId(record.id, revision));
                if (!removed.ok)
                    return removed;
            }
            const advanced = advanceLifecycleOperation(currentRecord, currentRecord.recordRevision, "snapshot_removed");
            if (!advanced.ok)
                return advanced;
            const committed = commitCatalogRecord(this.stateStore, currentRevision, currentCatalog, advanced.value);
            if (!committed.ok)
                return committed;
            currentRecord = committed.value.record;
            currentCatalog = committed.value.catalog;
            currentRevision = committed.value.catalogRevision;
            operation = lifecycleOperation(currentRecord);
        }
        if (operation?.phase !== "snapshot_removed") {
            return err("INVALID_STATE", `${record.id} 的删除恢复阶段无效。`);
        }
        const removed = commitCatalogRemoval(this.stateStore, currentRevision, currentCatalog, record.id);
        return removed.ok ? ok("completed deleting") : removed;
    }
    finishRespawning(catalogRevision, catalog, record) {
        let currentRecord = record;
        let currentCatalog = catalog;
        let currentRevision = catalogRevision;
        let operation = lifecycleOperation(currentRecord);
        if (currentRecord.lifecycle.kind !== "respawning" || operation?.kind !== "respawn") {
            return err("INVALID_STATE", `${record.id} 没有有效的复活恢复数据。`);
        }
        if (operation.phase === "prepared") {
            if (!this.runtime.respawn(record.id, respawnTarget(record))) {
                return err("CONFLICT", `无法恢复假人 ${record.id} 的复活操作。`);
            }
            const advanced = advanceLifecycleOperation(currentRecord, currentRecord.recordRevision, "respawned");
            if (!advanced.ok)
                return advanced;
            const committed = commitCatalogRecord(this.stateStore, currentRevision, currentCatalog, advanced.value);
            if (!committed.ok)
                return committed;
            currentRecord = committed.value.record;
            currentCatalog = committed.value.catalog;
            currentRevision = committed.value.catalogRevision;
            operation = lifecycleOperation(currentRecord);
        }
        let snapshotRevision = parseVerifiedSnapshotRevision(currentRecord);
        if (operation?.phase === "respawned") {
            snapshotRevision = (currentRecord.inventoryRevision ?? 0) + 1;
            const snapshot = this.snapshots.save(record.id, snapshotRevision);
            if (!snapshot.ok)
                return snapshot;
            const advanced = advanceLifecycleOperation(currentRecord, currentRecord.recordRevision, `snapshot_verified:${snapshotRevision}`);
            if (!advanced.ok)
                return advanced;
            const committed = commitCatalogRecord(this.stateStore, currentRevision, currentCatalog, advanced.value);
            if (!committed.ok)
                return committed;
            currentRecord = committed.value.record;
            currentCatalog = committed.value.catalog;
            currentRevision = committed.value.catalogRevision;
        }
        if (snapshotRevision === undefined || !this.snapshots.has(snapshotId(record.id, snapshotRevision))) {
            return err("NOT_FOUND", `${record.id} 复活后的库存快照不存在。`);
        }
        const runtimeState = this.runtime.get(record.id);
        if (runtimeState === undefined || !runtimeState.alive) {
            return err("INVALID_STATE", `${record.id} 复活后仍没有存活实例。`);
        }
        if (currentRecord.keepSaturated
            && !this.runtime.perform(record.id, { kind: "set_saturation", enabled: true }).accepted) {
            return err("CONFLICT", `无法为恢复复活后的假人 ${record.id} 启用持续饱和。`);
        }
        const online = transitionLifecycle(currentRecord, currentRecord.recordRevision, { kind: "online" });
        if (!online.ok)
            return online;
        const finalRecord = {
            ...online.value,
            location: {
                dimension: runtimeState.dimension,
                position: runtimeState.position,
                rotation: runtimeState.rotation,
            },
            gameMode: runtimeState.gameMode,
            selectedSlot: runtimeState.selectedSlot,
            totalExperience: runtimeState.totalExperience,
            inventoryRevision: snapshotRevision,
            inventoryFallbackRevision: null,
        };
        const committed = commitCatalogRecord(this.stateStore, currentRevision, currentCatalog, finalRecord);
        if (!committed.ok)
            return committed;
        for (const revision of [record.inventoryRevision, record.inventoryFallbackRevision]) {
            if (revision === null)
                continue;
            const removed = this.snapshots.remove(snapshotId(record.id, revision));
            if (!removed.ok)
                return removed;
        }
        return ok("completed respawning");
    }
}
function validatePendingTransferRecords(catalog, operations, runtime) {
    const transfers = [
        ...Object.values(operations.inventoryTransfers),
        ...Object.values(operations.experienceTransfers),
    ];
    for (const transfer of transfers) {
        const record = catalog.records[transfer.fakePlayerId];
        if (record === undefined) {
            return err("CONFLICT", `待恢复事务 ${transfer.id} 指向不存在的假人 ${transfer.fakePlayerId}。`);
        }
        if (record.lifecycle.kind === "online" && runtime.get(record.id)?.alive === true)
            continue;
        if (record.lifecycle.kind !== "offline") {
            return err("CONFLICT", `待恢复事务 ${transfer.id} 要求假人 ${record.id} 保持 offline，或保持有存活实例的 online 状态；实际为 ${record.lifecycle.kind}。`);
        }
    }
    return ok(undefined);
}
function parseVerifiedSnapshotRevision(record) {
    if (!("operation" in record.lifecycle) || record.lifecycle.operation === undefined)
        return undefined;
    const match = /^snapshot_verified:(\d+)$/.exec(record.lifecycle.operation.phase);
    if (match === null)
        return undefined;
    const revision = Number(match[1]);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}
function spawnRequest(record) {
    return {
        id: record.id,
        name: record.name,
        dimension: record.location.dimension,
        position: record.location.position,
        rotation: record.location.rotation,
        gameMode: record.gameMode,
        keepSaturated: record.keepSaturated,
        skin: record.skin,
        selectedSlot: record.selectedSlot,
        totalExperience: record.totalExperience,
    };
}
function lifecycleOperation(record) {
    return "operation" in record.lifecycle ? record.lifecycle.operation : undefined;
}
function respawnTarget(record) {
    if (record.respawnMode === "death_location")
        return record.location;
    if (record.respawnMode === "manual")
        return record.respawnLocation ?? undefined;
    return undefined;
}
//# sourceMappingURL=recoveryRunner.js.map