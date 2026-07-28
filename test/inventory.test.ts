import assert from "node:assert/strict";
import test from "node:test";

import { fromStructureSlot, TOTAL_SLOT_COUNT, toStructureSlot } from "../src/domain/inventory.js";

test("all 41 logical slots round-trip through the two-barrel mapping", () => {
    const seen = new Set<string>();
    for (let logicalSlot = 0; logicalSlot < TOTAL_SLOT_COUNT; logicalSlot += 1) {
        const mapped = toStructureSlot(logicalSlot);
        assert.equal(mapped.ok, true);
        if (!mapped.ok) continue;
        const key = `${mapped.value.barrel}:${mapped.value.slot}`;
        assert.equal(seen.has(key), false, `duplicate structure slot ${key}`);
        seen.add(key);
        assert.deepEqual(fromStructureSlot(mapped.value), { ok: true, value: logicalSlot });
    }
    assert.equal(seen.size, TOTAL_SLOT_COUNT);
});

test("unused and out-of-range slots are rejected", () => {
    assert.equal(toStructureSlot(-1).ok, false);
    assert.equal(toStructureSlot(41).ok, false);
    assert.equal(fromStructureSlot({ barrel: "B", slot: 14 }).ok, false);
});