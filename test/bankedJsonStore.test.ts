import assert from "node:assert/strict";
import test from "node:test";

import {
    BankedJsonStore,
    calculateChecksum,
    utf8ByteLength,
    type StateCodec,
    type StringPropertyBackend,
} from "../src/infrastructure/state/bankedJsonStore.js";

interface CounterState {
    readonly value: number;
}

const codec: StateCodec<CounterState> = {
    schemaVersion: 1,
    initialValue: { value: 0 },
    decode(schemaVersion, payload) {
        if (schemaVersion !== 1 || typeof payload !== "object" || payload === null) return undefined;
        const value = (payload as Partial<CounterState>).value;
        return typeof value === "number" ? { value } : undefined;
    },
};

class MemoryBackend implements StringPropertyBackend {
    public readonly values = new Map<string, string>();
    public failNextSetFor: string | undefined;

    public get(key: string): string | undefined {
        return this.values.get(key);
    }

    public set(key: string, value: string): void {
        if (this.failNextSetFor === key) {
            this.failNextSetFor = undefined;
            throw new Error(`injected failure for ${key}`);
        }
        this.values.set(key, value);
    }
}

function envelope(revision: number, payload: CounterState): string {
    return JSON.stringify({
        schemaVersion: 1,
        revision,
        checksum: calculateChecksum(1, revision, payload),
        payload,
    });
}

test("a new aggregate starts at revision zero and commits through the active pointer", () => {
    const backend = new MemoryBackend();
    const store = new BankedJsonStore(backend, "test", codec);

    assert.deepEqual(store.load(), {
        ok: true,
        state: { value: { value: 0 }, revision: 0, recovered: false, diagnostics: [] },
    });
    assert.deepEqual(store.commit(0, { value: 1 }), {
        ok: true,
        value: { value: { value: 1 }, revision: 1, recovered: false, diagnostics: [] },
    });
    assert.equal(backend.values.get("test:active"), "A");
});

test("a higher inactive bank remains uncommitted when pointer switching is interrupted", () => {
    const backend = new MemoryBackend();
    const store = new BankedJsonStore(backend, "test", codec);
    assert.equal(store.commit(0, { value: 1 }).ok, true);

    backend.failNextSetFor = "test:active";
    assert.throws(() => store.commit(1, { value: 2 }), /injected failure/);
    assert.equal(backend.values.get("test:active"), "A");
    assert.deepEqual(store.load(), {
        ok: true,
        state: { value: { value: 1 }, revision: 1, recovered: false, diagnostics: [] },
    });
});

test("an invalid active bank recovers to the highest valid bank", () => {
    const backend = new MemoryBackend();
    backend.values.set("test:active", "A");
    backend.values.set("test:a", "corrupt");
    backend.values.set("test:b", envelope(3, { value: 3 }));

    const loaded = new BankedJsonStore(backend, "test", codec).load();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
        assert.equal(loaded.state.value.value, 3);
        assert.equal(loaded.state.revision, 3);
        assert.equal(loaded.state.recovered, true);
    }
    assert.equal(backend.values.get("test:active"), "B");
});

test("partially present but invalid banks enter read-only mode", () => {
    const backend = new MemoryBackend();
    backend.values.set("test:active", "A");
    backend.values.set("test:a", "corrupt");

    const loaded = new BankedJsonStore(backend, "test", codec).load();
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.equal(loaded.readOnly, true);
});

test("capacity checks use UTF-8 bytes before writing a bank", () => {
    assert.equal(utf8ByteLength("小波"), 6);
    const backend = new MemoryBackend();
    const tinyCodec: StateCodec<{ text: string }> = {
        schemaVersion: 1,
        initialValue: { text: "" },
        decode: (schemaVersion, payload) => schemaVersion === 1 && typeof payload === "object" && payload !== null
            && typeof (payload as { text?: unknown }).text === "string"
            ? payload as { text: string }
            : undefined,
    };
    const result = new BankedJsonStore(backend, "tiny", tinyCodec, 80).commit(0, { text: "小".repeat(30) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "DATA_CAPACITY");
    assert.equal(backend.values.size, 0);
});