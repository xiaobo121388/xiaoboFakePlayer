import assert from "node:assert/strict";
import test from "node:test";

import { formatFakePlayerId, reserveUniqueName } from "../src/domain/validation.js";

test("reserveUniqueName trims and appends the smallest available suffix", () => {
    assert.deepEqual(reserveUniqueName("  Alice  ", []), { ok: true, value: "Alice" });
    assert.deepEqual(reserveUniqueName("Alice", ["alice", "Alice1", "ALICE2"]), { ok: true, value: "Alice3" });
});

test("reserveUniqueName preserves the 16-code-point limit when adding a suffix", () => {
    const result = reserveUniqueName("1234567890123456", ["1234567890123456"]);
    assert.deepEqual(result, { ok: true, value: "1234567890123451" });
});

test("reserveUniqueName rejects empty and formatting-code names", () => {
    assert.equal(reserveUniqueName("  ", []).ok, false);
    assert.equal(reserveUniqueName("bad§name", []).ok, false);
});

test("formatFakePlayerId creates stable sequential IDs", () => {
    assert.equal(formatFakePlayerId(1), "fp0001");
    assert.equal(formatFakePlayerId(10_001), "fp10001");
    assert.throws(() => formatFakePlayerId(0), RangeError);
});