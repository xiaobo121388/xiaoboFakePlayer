import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import { advanceLifecycleOperation, transitionLifecycle } from "../src/domain/lifecycle.js";
import type { FakePlayerRecord, LifecycleOperation } from "../src/domain/model.js";

function record(kind: "online" | "offline", revision = 2): FakePlayerRecord {
    return {
        id: "fp0001",
        name: "Alice",
        ownerId: "owner",
        recordRevision: revision,
        lifecycle: { kind },
        expectedOnline: kind === "online",
        location: {
            dimension: "minecraft:overworld",
            position: { x: 0, y: 64, z: 0 },
            rotation: { x: 0, y: 0 },
        },
        gameMode: "survival",
        skin: { kind: "default" },
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual",
        respawnLocation: null,
        inventoryRevision: null,
        lastCheckpointTick: null,
        behavior: createDefaultBehaviorConfig(),
    };
}

function operation(kind: LifecycleOperation["kind"], target: LifecycleOperation["target"]): LifecycleOperation {
    return { id: "op1", kind, previous: "offline", target, phase: "prepared" };
}

test("lifecycle transition checks revision and legal edges", () => {
    const stale = transitionLifecycle(record("online"), 1, {
        kind: "snapshotting",
        operation: operation("offline", "offline"),
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "STALE_REVISION");

    const illegal = transitionLifecycle(record("offline"), 2, { kind: "online" });
    assert.equal(illegal.ok, false);
    if (!illegal.ok) assert.equal(illegal.error.code, "INVALID_STATE");
});

test("pending lifecycle target controls expected online state", () => {
    const restoring = transitionLifecycle(record("offline"), 2, {
        kind: "restoring",
        operation: operation("online", "online"),
    });
    assert.equal(restoring.ok, true);
    if (restoring.ok) {
        assert.equal(restoring.value.expectedOnline, true);
        assert.equal(restoring.value.recordRevision, 3);
    }

    const snapshotting = transitionLifecycle(record("online"), 2, {
        kind: "snapshotting",
        operation: operation("offline", "offline"),
    });
    assert.equal(snapshotting.ok, true);
    if (snapshotting.ok) assert.equal(snapshotting.value.expectedOnline, false);
});

test("pending lifecycle operations advance phase with a new record revision", () => {
    const pending = transitionLifecycle(record("online"), 2, {
        kind: "snapshotting",
        operation: operation("offline", "offline"),
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    const advanced = advanceLifecycleOperation(pending.value, 3, "snapshot_verified:1");
    assert.equal(advanced.ok, true);
    if (advanced.ok) {
        assert.equal(advanced.value.recordRevision, 4);
        assert.equal("operation" in advanced.value.lifecycle && advanced.value.lifecycle.operation?.phase, "snapshot_verified:1");
    }
    assert.equal(advanceLifecycleOperation(record("offline"), 2, "invalid").ok, false);
});