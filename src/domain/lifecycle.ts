import type { FakePlayerRecord, LifecycleStatus } from "./model.js";
import { err, ok, type Result } from "./results.js";

const ALLOWED_TRANSITIONS: Readonly<Record<LifecycleStatus["kind"], ReadonlySet<LifecycleStatus["kind"]>>> = {
    provisioning: new Set(["online", "error"]),
    online: new Set(["snapshotting", "respawning", "missing", "error"]),
    snapshotting: new Set(["online", "offline", "renaming", "error"]),
    offline: new Set(["restoring", "renaming", "deleting", "error"]),
    restoring: new Set(["online", "offline", "error"]),
    renaming: new Set(["online", "offline", "error"]),
    respawning: new Set(["online", "error"]),
    deleting: new Set(["offline", "error"]),
    missing: new Set(["restoring", "error"]),
    error: new Set(["offline", "restoring"]),
};

export function transitionLifecycle(
    record: FakePlayerRecord,
    expectedRevision: number,
    next: LifecycleStatus,
): Result<FakePlayerRecord> {
    if (record.recordRevision !== expectedRevision) {
        return err("STALE_REVISION", `期望 revision ${expectedRevision}，实际为 ${record.recordRevision}。`);
    }
    if (!ALLOWED_TRANSITIONS[record.lifecycle.kind].has(next.kind)) {
        return err("INVALID_STATE", `不能从 ${record.lifecycle.kind} 转换到 ${next.kind}。`);
    }
    const operationTarget = "operation" in next ? next.operation?.target : null;
    const expectedOnline = operationTarget !== null && operationTarget !== undefined
        ? operationTarget === "online"
        : next.kind === "online"
            ? true
            : next.kind === "offline"
                ? false
                : record.expectedOnline;
    return ok({
        ...record,
        recordRevision: record.recordRevision + 1,
        lifecycle: next,
        expectedOnline,
    });
}

export function advanceLifecycleOperation(
    record: FakePlayerRecord,
    expectedRevision: number,
    phase: string,
): Result<FakePlayerRecord> {
    if (record.recordRevision !== expectedRevision) {
        return err("STALE_REVISION", `期望 revision ${expectedRevision}，实际为 ${record.recordRevision}。`);
    }
    if (!("operation" in record.lifecycle) || record.lifecycle.operation === undefined) {
        return err("INVALID_STATE", `${record.lifecycle.kind} 状态没有可推进的操作。`);
    }
    return ok({
        ...record,
        recordRevision: record.recordRevision + 1,
        lifecycle: {
            ...record.lifecycle,
            operation: { ...record.lifecycle.operation, phase },
        },
    });
}