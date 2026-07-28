import { err, ok, type Result } from "./results.js";

export const MAX_FAKE_PLAYERS = 10;
export const MAX_NAME_LENGTH = 16;

const INVALID_NAME_CHARACTER = /[\u0000-\u001f\u007f§]/u;

function codePointLength(value: string): number {
    return Array.from(value).length;
}

function takeCodePoints(value: string, count: number): string {
    return Array.from(value).slice(0, count).join("");
}

export function reserveUniqueName(requested: string, unavailableNames: Iterable<string>): Result<string> {
    const normalized = requested.trim();
    if (normalized.length === 0 || INVALID_NAME_CHARACTER.test(normalized)) {
        return err("INVALID_NAME", "名称不能为空，也不能包含控制字符或 §。");
    }
    if (codePointLength(normalized) > MAX_NAME_LENGTH) {
        return err("INVALID_NAME", `名称最多 ${MAX_NAME_LENGTH} 个字符。`);
    }

    const unavailable = new Set(Array.from(unavailableNames, (name) => name.toLowerCase()));
    if (!unavailable.has(normalized.toLowerCase())) {
        return ok(normalized);
    }

    for (let suffix = 1; suffix < 10_000; suffix += 1) {
        const suffixText = String(suffix);
        const candidate = `${takeCodePoints(normalized, MAX_NAME_LENGTH - codePointLength(suffixText))}${suffixText}`;
        if (!unavailable.has(candidate.toLowerCase())) {
            return ok(candidate);
        }
    }
    return err("CONFLICT", "无法生成唯一名称。");
}

export function formatFakePlayerId(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new RangeError("sequence must be a positive safe integer");
    }
    return `fp${String(sequence).padStart(4, "0")}`;
}