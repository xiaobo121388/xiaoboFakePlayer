import { err, ok } from "../../domain/results.js";
const DEFAULT_MAX_PROPERTY_BYTES = 30_000;
export class BankedJsonStore {
    backend;
    prefix;
    codec;
    maxPropertyBytes;
    constructor(backend, prefix, codec, maxPropertyBytes = DEFAULT_MAX_PROPERTY_BYTES) {
        this.backend = backend;
        this.prefix = prefix;
        this.codec = codec;
        this.maxPropertyBytes = maxPropertyBytes;
    }
    load() {
        const pointerValue = this.backend.get(this.pointerKey());
        const bankAValue = this.backend.get(this.bankKey("A"));
        const bankBValue = this.backend.get(this.bankKey("B"));
        if (pointerValue === undefined && bankAValue === undefined && bankBValue === undefined) {
            return {
                ok: true,
                state: { value: this.codec.initialValue, revision: 0, recovered: false, diagnostics: [] },
            };
        }
        const validBanks = [this.readBank("A", bankAValue), this.readBank("B", bankBValue)].filter((bank) => bank !== undefined);
        if ((pointerValue === "A" || pointerValue === "B")) {
            const active = validBanks.find((candidate) => candidate.bank === pointerValue);
            if (active !== undefined) {
                return { ok: true, state: active.state };
            }
        }
        if (validBanks.length === 0) {
            return {
                ok: false,
                readOnly: true,
                diagnostics: [`${this.prefix}: active pointer and both banks are invalid`],
            };
        }
        const recovered = validBanks.reduce((latest, candidate) => candidate.state.revision > latest.state.revision ? candidate : latest);
        this.backend.set(this.pointerKey(), recovered.bank);
        return {
            ok: true,
            state: {
                ...recovered.state,
                recovered: true,
                diagnostics: [`${this.prefix}: recovered active pointer to bank ${recovered.bank}`],
            },
        };
    }
    commit(expectedRevision, value) {
        const loaded = this.load();
        if (!loaded.ok) {
            return err("CONFLICT", loaded.diagnostics.join("; "));
        }
        if (loaded.state.revision !== expectedRevision) {
            return err("STALE_REVISION", `期望 revision ${expectedRevision}，实际为 ${loaded.state.revision}。`);
        }
        const active = this.backend.get(this.pointerKey());
        const target = active === "A" ? "B" : "A";
        const envelope = createEnvelope(this.codec.schemaVersion, expectedRevision + 1, value);
        const serialized = JSON.stringify(envelope);
        if (utf8ByteLength(serialized) > this.maxPropertyBytes) {
            return err("DATA_CAPACITY", `${this.prefix} 聚合超过动态属性容量。`);
        }
        this.backend.set(this.bankKey(target), serialized);
        const verified = this.readBank(target, this.backend.get(this.bankKey(target)));
        if (verified === undefined || verified.state.revision !== expectedRevision + 1) {
            return err("CONFLICT", `${this.prefix} bank ${target} 回读校验失败。`);
        }
        this.backend.set(this.pointerKey(), target);
        return ok(verified.state);
    }
    readBank(bank, serialized) {
        if (serialized === undefined)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(serialized);
        }
        catch {
            return undefined;
        }
        if (!isEnvelope(parsed))
            return undefined;
        if (parsed.checksum !== calculateChecksum(parsed.schemaVersion, parsed.revision, parsed.payload)) {
            return undefined;
        }
        const value = this.codec.decode(parsed.schemaVersion, parsed.payload);
        if (value === undefined)
            return undefined;
        return {
            bank,
            state: { value, revision: parsed.revision, recovered: false, diagnostics: [] },
        };
    }
    pointerKey() {
        return `${this.prefix}:active`;
    }
    bankKey(bank) {
        return `${this.prefix}:${bank.toLowerCase()}`;
    }
}
function createEnvelope(schemaVersion, revision, payload) {
    return {
        schemaVersion,
        revision,
        checksum: calculateChecksum(schemaVersion, revision, payload),
        payload,
    };
}
function isEnvelope(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    return Number.isSafeInteger(candidate.schemaVersion)
        && Number.isSafeInteger(candidate.revision)
        && typeof candidate.checksum === "string"
        && "payload" in candidate;
}
export function calculateChecksum(schemaVersion, revision, payload) {
    const text = JSON.stringify([schemaVersion, revision, payload]);
    let hash = 0x811c9dc5;
    for (const byte of utf8Bytes(text)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
export function utf8ByteLength(value) {
    return utf8Bytes(value).length;
}
function utf8Bytes(value) {
    const bytes = [];
    for (let index = 0; index < value.length; index += 1) {
        let codePoint = value.charCodeAt(index);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
            const trailing = value.charCodeAt(index + 1);
            if (trailing >= 0xdc00 && trailing <= 0xdfff) {
                codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + trailing - 0xdc00;
                index += 1;
            }
        }
        if (codePoint <= 0x7f) {
            bytes.push(codePoint);
        }
        else if (codePoint <= 0x7ff) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        }
        else if (codePoint <= 0xffff) {
            bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
        }
        else {
            bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
        }
    }
    return bytes;
}
