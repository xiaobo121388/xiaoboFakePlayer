import {
    createDefaultBehaviorConfig,
    decodeBehaviorConfig,
    normalizeExclusiveActionBehaviors,
} from "../../domain/behavior.js";
import type {
    ExperienceTransfer,
    FakePlayerGameMode,
    FakePlayerRecord,
    FakePlayerSkin,
    InventoryTransfer,
    LifecycleOperation,
    LifecycleStatus,
    PendingOperations,
    PermissionGrant,
    PermissionTable,
    Point,
    Rotation,
    SavedLocation,
    WorkspaceOperation,
    WorldCatalog,
} from "../../domain/model.js";
import { DEFAULT_FAKE_PLAYER_SKIN } from "../../domain/model.js";
import type { StateCodec } from "./bankedJsonStore.js";

type JsonObject = Record<string, unknown>;

const GAME_MODES = new Set<FakePlayerGameMode>(["adventure", "creative", "spectator", "survival"]);
const RESPAWN_MODES = new Set(["death_location", "manual", "player_spawn"]);
const LIFECYCLE_KINDS = new Set(["online", "offline", "missing"]);
const PENDING_LIFECYCLE_KINDS = new Set([
    "deleting",
    "provisioning",
    "renaming",
    "respawning",
    "restoring",
    "snapshotting",
]);
const PERSONA_ARM_SIZES = new Set(["Slim", "Wide"]);
const PERSONA_PIECE_TYPES = new Set([
    "Arms", "Back", "Body", "Bottom", "Capes", "Dress", "Eyes", "FaceAccessory", "FacialHair",
    "Feet", "Hair", "Hands", "Head", "HighPants", "Hood", "LeftArm", "LeftLeg", "Legs", "Mouth",
    "Outerwear", "RightArm", "RightLeg", "Skeleton", "Skin", "Top",
]);

export const catalogCodec: StateCodec<WorldCatalog> = {
    schemaVersion: 5,
    initialValue: { nextId: 1, records: {} },
    decode(schemaVersion, payload) {
        if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3
            && schemaVersion !== 4 && schemaVersion !== 5) {
            return undefined;
        }
        const value = asObject(payload);
        const records = value === undefined
            ? undefined
            : decodeRecord(value.records, (record) => decodeFakePlayerRecord(record, schemaVersion));
        if (value === undefined || !isPositiveInteger(value.nextId) || records === undefined) return undefined;
        return { nextId: value.nextId, records };
    },
};

export const permissionCodec: StateCodec<PermissionTable> = {
    schemaVersion: 1,
    initialValue: { grants: {} },
    decode(schemaVersion, payload) {
        if (schemaVersion !== 1) return undefined;
        const value = asObject(payload);
        const grants = value === undefined ? undefined : decodeRecord(value.grants, decodePermissionGrant);
        if (grants === undefined) return undefined;
        for (const [playerId, grant] of Object.entries(grants)) {
            if (grant.playerId !== playerId) return undefined;
        }
        return { grants };
    },
};

export const operationsCodec: StateCodec<PendingOperations> = {
    schemaVersion: 2,
    initialValue: { workspace: {}, inventoryTransfers: {}, experienceTransfers: {} },
    decode(schemaVersion, payload) {
        if (schemaVersion !== 1 && schemaVersion !== 2) return undefined;
        const value = asObject(payload);
        if (value === undefined) return undefined;
        const workspace = decodeRecord(value.workspace, decodeWorkspaceOperation);
        const inventoryTransfers = schemaVersion === 1
            ? decodeEmptyRecord(value.inventoryTransfers)
            : decodeRecord(value.inventoryTransfers, decodeInventoryTransfer);
        const experienceTransfers = schemaVersion === 1
            ? decodeEmptyRecord(value.experienceTransfers)
            : decodeRecord(value.experienceTransfers, decodeExperienceTransfer);
        if (workspace === undefined || inventoryTransfers === undefined || experienceTransfers === undefined) {
            return undefined;
        }
        return { workspace, inventoryTransfers, experienceTransfers };
    },
};

function decodeFakePlayerRecord(payload: unknown, schemaVersion: number): FakePlayerRecord | undefined {
    const value = asObject(payload);
    const keepSaturated = value === undefined
        ? undefined
        : schemaVersion < 5 && value.keepSaturated === undefined
            ? false
            : typeof value.keepSaturated === "boolean"
                ? value.keepSaturated
                : undefined;
    if (value === undefined
        || !isString(value.id)
        || !isString(value.name)
        || !isString(value.ownerId)
        || !isNonNegativeInteger(value.recordRevision)
        || typeof value.expectedOnline !== "boolean"
        || !isGameMode(value.gameMode)
        || keepSaturated === undefined
        || !isIntegerInRange(value.selectedSlot, 0, 8)
        || !isNonNegativeInteger(value.totalExperience)
        || !isRespawnMode(value.respawnMode)
        || !isNullableNonNegativeInteger(value.inventoryRevision)
        || (schemaVersion === 4
            ? !isNullableNonNegativeInteger(value.inventoryFallbackRevision)
            : value.inventoryFallbackRevision !== undefined
                && !isNullableNonNegativeInteger(value.inventoryFallbackRevision))
        || !isNullableNonNegativeInteger(value.lastCheckpointTick)) {
        return undefined;
    }
    const inventoryFallbackRevision = decodeInventoryFallbackRevision(
        schemaVersion,
        value.inventoryRevision,
        value.inventoryFallbackRevision,
    );
    if (inventoryFallbackRevision === undefined) return undefined;
    if (inventoryFallbackRevision !== null
        && (value.inventoryRevision === null || inventoryFallbackRevision >= value.inventoryRevision)) {
        return undefined;
    }
    const lifecycle = decodeLifecycleStatus(value.lifecycle);
    const location = decodeSavedLocation(value.location);
    const decodedBehavior = schemaVersion === 1 && value.behavior === undefined
        ? createDefaultBehaviorConfig()
        : decodeBehaviorConfig(value.behavior);
    const behavior = decodedBehavior === undefined
        ? undefined
        : normalizeExclusiveActionBehaviors(decodedBehavior);
    const skin = schemaVersion < 3 && value.skin === undefined
        ? DEFAULT_FAKE_PLAYER_SKIN
        : decodeFakePlayerSkin(value.skin);
    const respawnLocation = value.respawnLocation === undefined || value.respawnLocation === null
        ? null
        : decodeSavedLocation(value.respawnLocation);
    if (lifecycle === undefined || location === undefined || respawnLocation === undefined
        || behavior === undefined || skin === undefined) {
        return undefined;
    }
    return {
        id: value.id,
        name: value.name,
        ownerId: value.ownerId,
        recordRevision: value.recordRevision,
        lifecycle,
        expectedOnline: value.expectedOnline,
        location,
        gameMode: value.gameMode,
        keepSaturated,
        skin,
        selectedSlot: value.selectedSlot,
        totalExperience: value.totalExperience,
        respawnMode: value.respawnMode,
        respawnLocation,
        inventoryRevision: value.inventoryRevision,
        inventoryFallbackRevision,
        lastCheckpointTick: value.lastCheckpointTick,
        behavior,
    };
}

function decodeInventoryFallbackRevision(
    schemaVersion: number,
    inventoryRevision: number | null,
    payload: unknown,
): number | null | undefined {
    if (payload === undefined) {
        if (schemaVersion >= 4) return undefined;
        return inventoryRevision !== null && inventoryRevision > 1 ? inventoryRevision - 1 : null;
    }
    return isNullableNonNegativeInteger(payload) ? payload : undefined;
}

function decodeLifecycleStatus(payload: unknown): LifecycleStatus | undefined {
    const value = asObject(payload);
    if (value === undefined || !isString(value.kind)) return undefined;
    if (LIFECYCLE_KINDS.has(value.kind)) return { kind: value.kind as "online" | "offline" | "missing" };
    if (PENDING_LIFECYCLE_KINDS.has(value.kind)) {
        const operation = decodeLifecycleOperation(value.operation);
        return operation === undefined
            ? undefined
            : {
                kind: value.kind as "deleting" | "provisioning" | "renaming" | "respawning" | "restoring" | "snapshotting",
                operation,
            };
    }
    if (value.kind === "error" && isString(value.message)) {
        if (value.operation === undefined) return { kind: "error", message: value.message };
        const operation = decodeLifecycleOperation(value.operation);
        return operation === undefined ? undefined : { kind: "error", message: value.message, operation };
    }
    return undefined;
}

function decodeLifecycleOperation(payload: unknown): LifecycleOperation | undefined {
    const value = asObject(payload);
    if (value === undefined
        || !isString(value.id)
            || !isOneOf(value.kind, ["create", "delete", "online", "offline", "rename", "respawn"])
        || !isOneOf(value.previous, ["online", "offline", "missing", null])
        || !isOneOf(value.target, ["online", "offline", null])
            || !isString(value.phase)
            || (value.previousName !== undefined && !isString(value.previousName))
            || (value.targetName !== undefined && !isString(value.targetName))) {
        return undefined;
    }
    return {
        id: value.id,
        kind: value.kind,
        previous: value.previous,
        target: value.target,
        phase: value.phase,
            ...(value.previousName === undefined ? {} : { previousName: value.previousName }),
            ...(value.targetName === undefined ? {} : { targetName: value.targetName }),
    };
}

function decodeSavedLocation(payload: unknown): SavedLocation | undefined {
    const value = asObject(payload);
    if (value === undefined || !isString(value.dimension)) return undefined;
    const position = decodePoint(value.position);
    const rotation = decodeRotation(value.rotation);
    return position === undefined || rotation === undefined
        ? undefined
        : { dimension: value.dimension, position, rotation };
}

function decodePoint(payload: unknown): Point | undefined {
    const value = asObject(payload);
    return value !== undefined && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
        ? { x: value.x, y: value.y, z: value.z }
        : undefined;
}

function decodeRotation(payload: unknown): Rotation | undefined {
    const value = asObject(payload);
    return value !== undefined && isFiniteNumber(value.x) && isFiniteNumber(value.y)
        ? { x: value.x, y: value.y }
        : undefined;
}

function decodePermissionGrant(payload: unknown): PermissionGrant | undefined {
    const value = asObject(payload);
    return value !== undefined
        && isString(value.playerId)
        && isString(value.lastKnownName)
        && typeof value.canPlace === "boolean"
        && typeof value.canSet === "boolean"
        ? {
            playerId: value.playerId,
            lastKnownName: value.lastKnownName,
            canPlace: value.canPlace,
            canSet: value.canSet,
        }
        : undefined;
}

function decodeWorkspaceOperation(payload: unknown): WorkspaceOperation | undefined {
    const value = asObject(payload);
    if (value === undefined
        || !isString(value.id)
        || !isOneOf(value.phase, ["prepared", "placed", "snapshotted", "restored"])
        || !isString(value.dimension)
        || !isString(value.backupStructureId)) {
        return undefined;
    }
    const origin = decodePoint(value.origin);
    return origin === undefined
        ? undefined
        : { id: value.id, phase: value.phase, dimension: value.dimension, origin, backupStructureId: value.backupStructureId };
}

function decodeInventoryTransfer(payload: unknown): InventoryTransfer | undefined {
    const value = asObject(payload);
    const request = value === undefined ? undefined : decodeInventoryTransferRequest(value.request);
    return value !== undefined
        && isString(value.id)
        && isString(value.fakePlayerId)
        && isString(value.playerId)
        && isNonNegativeInteger(value.fakePlayerRevision)
        && isString(value.fakeSnapshotId)
        && (value.fakeFallbackSnapshotId === undefined || isString(value.fakeFallbackSnapshotId))
        && isString(value.fakeAfterSnapshotId)
        && request !== undefined
        && isString(value.beforeStructureId)
        && isString(value.afterStructureId)
        && isOneOf(value.phase, ["prepared", "staged", "applying", "committed", "checkpointed"])
        ? {
            id: value.id,
            fakePlayerId: value.fakePlayerId,
            playerId: value.playerId,
            fakePlayerRevision: value.fakePlayerRevision,
            fakeSnapshotId: value.fakeSnapshotId,
            ...(value.fakeFallbackSnapshotId === undefined
                ? {}
                : { fakeFallbackSnapshotId: value.fakeFallbackSnapshotId }),
            fakeAfterSnapshotId: value.fakeAfterSnapshotId,
            request,
            beforeStructureId: value.beforeStructureId,
            afterStructureId: value.afterStructureId,
            phase: value.phase,
        }
        : undefined;
}

function decodeExperienceTransfer(payload: unknown): ExperienceTransfer | undefined {
    const value = asObject(payload);
    return value !== undefined
        && isString(value.id)
        && isString(value.fakePlayerId)
        && isString(value.playerId)
        && isNonNegativeInteger(value.fakePlayerRevision)
        && value.kind === "fake_to_player"
        && isNonNegativeInteger(value.fakePlayerBefore)
        && isNonNegativeInteger(value.playerBefore)
        && isNonNegativeInteger(value.amount)
        && isOneOf(value.phase, ["prepared", "applying", "committed"])
        ? {
            id: value.id,
            fakePlayerId: value.fakePlayerId,
            playerId: value.playerId,
            fakePlayerRevision: value.fakePlayerRevision,
            kind: value.kind,
            fakePlayerBefore: value.fakePlayerBefore,
            playerBefore: value.playerBefore,
            amount: value.amount,
            phase: value.phase,
        }
        : undefined;
}

function decodeInventoryTransferRequest(payload: unknown): InventoryTransfer["request"] | undefined {
    const value = asObject(payload);
    if (value === undefined || !isString(value.kind)) return undefined;
    if (value.kind === "recycle_all" || value.kind === "swap_inventory" || value.kind === "swap_equipment") {
        return { kind: value.kind };
    }
    if (value.kind === "swap") {
        return isIntegerInRange(value.fakeSlot, 0, 40) && isIntegerInRange(value.playerSlot, 0, 40)
            ? { kind: value.kind, fakeSlot: value.fakeSlot, playerSlot: value.playerSlot }
            : undefined;
    }
    if (value.kind === "take" || value.kind === "put") {
        return isIntegerInRange(value.fakeSlot, 0, 40) && isIntegerInRange(value.playerSlot, 0, 35)
            ? { kind: value.kind, fakeSlot: value.fakeSlot, playerSlot: value.playerSlot }
            : undefined;
    }
    if (value.kind === "swap_fake") {
        return isIntegerInRange(value.firstSlot, 0, 40) && isIntegerInRange(value.secondSlot, 0, 40)
            ? { kind: value.kind, firstSlot: value.firstSlot, secondSlot: value.secondSlot }
            : undefined;
    }
    return undefined;
}

function decodeRecord<T>(payload: unknown, decodeValue: (value: unknown) => T | undefined): Record<string, T> | undefined {
    const value = asObject(payload);
    if (value === undefined) return undefined;
    const decoded: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
        const decodedEntry = decodeValue(entry);
        if (decodedEntry === undefined) return undefined;
        decoded[key] = decodedEntry;
    }
    return decoded;
}

function asObject(value: unknown): JsonObject | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as JsonObject
        : undefined;
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
    return value === null || isNonNegativeInteger(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
    return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isGameMode(value: unknown): value is FakePlayerGameMode {
    return typeof value === "string" && GAME_MODES.has(value as FakePlayerGameMode);
}

function isRespawnMode(value: unknown): value is "death_location" | "manual" | "player_spawn" {
    return typeof value === "string" && RESPAWN_MODES.has(value);
}

function isOneOf<T extends string | null>(value: unknown, values: readonly T[]): value is T {
    return values.some((candidate) => candidate === value);
}

function decodeEmptyRecord(payload: unknown): Record<string, never> | undefined {
    const value = asObject(payload);
    return value !== undefined && Object.keys(value).length === 0 ? {} : undefined;
}

function decodeFakePlayerSkin(payload: unknown): FakePlayerSkin | undefined {
    const value = asObject(payload);
    if (value?.kind === "default") return DEFAULT_FAKE_PLAYER_SKIN;
    if (value?.kind !== "persona" || !Array.isArray(value.personaPieces)
        || value.personaPieces.length === 0 || value.personaPieces.length > 64) {
        return undefined;
    }
    const personaPieces = value.personaPieces.map(decodePersonaSkinPiece);
    if (personaPieces.some((piece) => piece === undefined)) return undefined;
    const armSize = value.armSize === undefined
        ? undefined
        : typeof value.armSize === "string" && PERSONA_ARM_SIZES.has(value.armSize)
            ? value.armSize as "Slim" | "Wide"
            : null;
    const skinColor = value.skinColor === undefined ? undefined : decodeSkinColor(value.skinColor);
    if (armSize === null || (value.skinColor !== undefined && skinColor === undefined)) return undefined;
    return {
        kind: "persona",
        ...(armSize === undefined ? {} : { armSize }),
        personaPieces: personaPieces as FakePlayerSkin extends { kind: "persona" }
            ? FakePlayerSkin["personaPieces"]
            : never,
        ...(skinColor === undefined ? {} : { skinColor }),
    };
}

function decodePersonaSkinPiece(payload: unknown) {
    const value = asObject(payload);
    return value !== undefined
        && isString(value.id)
        && isString(value.packId)
        && isString(value.productId)
        && typeof value.type === "string"
        && PERSONA_PIECE_TYPES.has(value.type)
        && (value.isDefaultPiece === undefined || typeof value.isDefaultPiece === "boolean")
        ? {
            id: value.id,
            packId: value.packId,
            productId: value.productId,
            type: value.type as import("../../domain/model.js").PersonaPieceType,
            ...(value.isDefaultPiece === undefined ? {} : { isDefaultPiece: value.isDefaultPiece }),
        }
        : undefined;
}

function decodeSkinColor(payload: unknown) {
    const value = asObject(payload);
    return value !== undefined
        && isUnitNumber(value.red)
        && isUnitNumber(value.green)
        && isUnitNumber(value.blue)
        ? { red: value.red, green: value.green, blue: value.blue }
        : undefined;
}

function isUnitNumber(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0 && value <= 1;
}