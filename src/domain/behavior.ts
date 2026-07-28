import type { BehaviorConfig } from "./model.js";

const MAX_INTERVAL_TICKS = 72_000;

export function createDefaultBehaviorConfig(): BehaviorConfig {
    return {
        follow: {
            enabled: false,
            targetPlayerId: null,
            lastKnownName: null,
            intervalTicks: 10,
            speed: 1,
            stopDistance: 2,
        },
        attack: {
            enabled: false,
            intervalTicks: 10,
            maxDistance: 6,
            targetFamilies: ["monster"],
            targetTypeIds: [],
            chase: false,
        },
        mine: {
            enabled: false,
            intervalTicks: 10,
            direction: "front",
            blockTypeId: null,
            searchRadius: 0,
            approach: false,
        },
        use: {
            enabled: false,
            intervalTicks: 20,
            slot: 0,
        },
    };
}

export function decodeBehaviorConfig(payload: unknown): BehaviorConfig | undefined {
    const value = asObject(payload);
    if (value === undefined) return undefined;
    const follow = decodeFollow(value.follow);
    const attack = decodeAttack(value.attack);
    const mine = decodeMine(value.mine);
    const use = decodeUse(value.use);
    return follow === undefined || attack === undefined || mine === undefined || use === undefined
        ? undefined
        : { follow, attack, mine, use };
}

function decodeFollow(payload: unknown): BehaviorConfig["follow"] | undefined {
    const value = asObject(payload);
    if (value === undefined
        || typeof value.enabled !== "boolean"
        || !isNullableNonEmptyString(value.targetPlayerId)
        || !isNullableNonEmptyString(value.lastKnownName)
        || (value.targetPlayerId === null) !== (value.lastKnownName === null)
        || (value.enabled && value.targetPlayerId === null)
        || !isIntegerInRange(value.intervalTicks, 1, MAX_INTERVAL_TICKS)
        || !isNumberInRange(value.speed, 0, 1)
        || !isNumberInRange(value.stopDistance, 0, 32)) {
        return undefined;
    }
    return {
        enabled: value.enabled,
        targetPlayerId: value.targetPlayerId,
        lastKnownName: value.lastKnownName,
        intervalTicks: value.intervalTicks,
        speed: value.speed,
        stopDistance: value.stopDistance,
    };
}

function decodeAttack(payload: unknown): BehaviorConfig["attack"] | undefined {
    const value = asObject(payload);
    if (value === undefined
        || typeof value.enabled !== "boolean"
        || !isIntegerInRange(value.intervalTicks, 2, MAX_INTERVAL_TICKS)
        || !isNumberInRange(value.maxDistance, 1, 32)
        || !isStringArray(value.targetFamilies)
        || !isStringArray(value.targetTypeIds)
        || typeof value.chase !== "boolean") {
        return undefined;
    }
    return {
        enabled: value.enabled,
        intervalTicks: value.intervalTicks,
        maxDistance: value.maxDistance,
        targetFamilies: value.targetFamilies,
        targetTypeIds: value.targetTypeIds,
        chase: value.chase,
    };
}

function decodeMine(payload: unknown): BehaviorConfig["mine"] | undefined {
    const value = asObject(payload);
    if (value === undefined
        || typeof value.enabled !== "boolean"
        || !isIntegerInRange(value.intervalTicks, 1, MAX_INTERVAL_TICKS)
        || !isOneOf(value.direction, ["up", "down", "front"])
        || !isNullableNonEmptyString(value.blockTypeId)
        || !isIntegerInRange(value.searchRadius, 0, 10)
        || typeof value.approach !== "boolean") {
        return undefined;
    }
    return {
        enabled: value.enabled,
        intervalTicks: value.intervalTicks,
        direction: value.direction,
        blockTypeId: value.blockTypeId,
        searchRadius: value.searchRadius,
        approach: value.approach,
    };
}

function decodeUse(payload: unknown): BehaviorConfig["use"] | undefined {
    const value = asObject(payload);
    return value !== undefined
        && typeof value.enabled === "boolean"
        && isIntegerInRange(value.intervalTicks, 1, MAX_INTERVAL_TICKS)
        && isIntegerInRange(value.slot, 0, 35)
        ? {
            enabled: value.enabled,
            intervalTicks: value.intervalTicks,
            slot: value.slot,
        }
        : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && value.length > 0);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
    return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
    return values.some((candidate) => candidate === value);
}