const MAX_INTERVAL_TICKS = 72_000;
export const EXCLUSIVE_ACTION_BEHAVIORS = ["attack", "mine", "place", "use"];
export function createDefaultBehaviorConfig() {
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
        place: createDefaultPlaceConfig(),
        use: {
            enabled: false,
            intervalTicks: 20,
            slot: 0,
        },
    };
}
export function decodeBehaviorConfig(payload) {
    const value = asObject(payload);
    if (value === undefined)
        return undefined;
    const follow = decodeFollow(value.follow);
    const attack = decodeAttack(value.attack);
    const mine = decodeMine(value.mine);
    const place = value.place === undefined ? createDefaultPlaceConfig() : decodePlace(value.place);
    const use = decodeUse(value.use);
    return follow === undefined || attack === undefined || mine === undefined
        || place === undefined || use === undefined
        ? undefined
        : { follow, attack, mine, place, use };
}
export function normalizeExclusiveActionBehaviors(config, preferredKind) {
    const enabledKind = preferredKind !== undefined && config[preferredKind].enabled
        ? preferredKind
        : EXCLUSIVE_ACTION_BEHAVIORS.find((kind) => config[kind].enabled);
    if (EXCLUSIVE_ACTION_BEHAVIORS.every((kind) => config[kind].enabled === (kind === enabledKind)))
        return config;
    return {
        ...config,
        attack: { ...config.attack, enabled: enabledKind === "attack" },
        mine: { ...config.mine, enabled: enabledKind === "mine" },
        place: { ...config.place, enabled: enabledKind === "place" },
        use: { ...config.use, enabled: enabledKind === "use" },
    };
}
function decodeFollow(payload) {
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
function decodeAttack(payload) {
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
function decodeMine(payload) {
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
function createDefaultPlaceConfig() {
    return {
        enabled: false,
        intervalTicks: 10,
        mode: "front",
        position: null,
        selectionMode: "slot",
        slot: 0,
        itemTypeId: null,
    };
}
function decodePlace(payload) {
    const value = asObject(payload);
    const position = value === undefined || value.position === null
        ? null
        : decodeBlockPosition(value.position);
    const selectionMode = value?.selectionMode ?? "slot";
    const itemTypeId = value?.itemTypeId ?? null;
    if (value === undefined
        || typeof value.enabled !== "boolean"
        || !isIntegerInRange(value.intervalTicks, 1, MAX_INTERVAL_TICKS)
        || !isOneOf(value.mode, ["front", "position"])
        || position === undefined
        || (value.enabled && value.mode === "position" && position === null)
        || !isOneOf(selectionMode, ["item", "slot"])
        || !isIntegerInRange(value.slot, 0, 35)
        || !isNullableNonEmptyString(itemTypeId)) {
        return undefined;
    }
    return {
        enabled: value.enabled,
        intervalTicks: value.intervalTicks,
        mode: value.mode,
        position,
        selectionMode,
        slot: value.slot,
        itemTypeId,
    };
}
function decodeBlockPosition(payload) {
    const value = asObject(payload);
    return value !== undefined
        && Number.isSafeInteger(value.x)
        && Number.isSafeInteger(value.y)
        && Number.isSafeInteger(value.z)
        ? { x: value.x, y: value.y, z: value.z }
        : undefined;
}
function decodeUse(payload) {
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
function asObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function isNullableNonEmptyString(value) {
    return value === null || (typeof value === "string" && value.length > 0);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}
function isIntegerInRange(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function isNumberInRange(value, minimum, maximum) {
    return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function isOneOf(value, values) {
    return values.some((candidate) => candidate === value);
}
//# sourceMappingURL=behavior.js.map