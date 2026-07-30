export type FakePlayerId = string;
export type PlayerPersistentId = string;
export type DimensionKey = string;

export interface Point {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

export interface Rotation {
    readonly x: number;
    readonly y: number;
}

export interface SavedLocation {
    readonly dimension: DimensionKey;
    readonly position: Point;
    readonly rotation: Rotation;
}

export type FakePlayerGameMode = "adventure" | "creative" | "spectator" | "survival";
export type RespawnMode = "death_location" | "manual" | "player_spawn";

export type PersonaArmSize = "Slim" | "Wide";
export type PersonaPieceType =
    | "Arms"
    | "Back"
    | "Body"
    | "Bottom"
    | "Capes"
    | "Dress"
    | "Eyes"
    | "FaceAccessory"
    | "FacialHair"
    | "Feet"
    | "Hair"
    | "Hands"
    | "Head"
    | "HighPants"
    | "Hood"
    | "LeftArm"
    | "LeftLeg"
    | "Legs"
    | "Mouth"
    | "Outerwear"
    | "RightArm"
    | "RightLeg"
    | "Skeleton"
    | "Skin"
    | "Top";

export interface PersonaSkinPiece {
    readonly id: string;
    readonly isDefaultPiece?: boolean;
    readonly packId: string;
    readonly productId: string;
    readonly type: PersonaPieceType;
}

export type FakePlayerSkin =
    | { readonly kind: "default" }
    | {
        readonly kind: "persona";
        readonly armSize?: PersonaArmSize;
        readonly personaPieces: readonly PersonaSkinPiece[];
        readonly skinColor?: { readonly red: number; readonly green: number; readonly blue: number };
    };

export const DEFAULT_FAKE_PLAYER_SKIN: FakePlayerSkin = { kind: "default" };

export interface BehaviorConfig {
    readonly follow: {
        readonly enabled: boolean;
        readonly targetPlayerId: PlayerPersistentId | null;
        readonly lastKnownName: string | null;
        readonly intervalTicks: number;
        readonly speed: number;
        readonly stopDistance: number;
    };
    readonly attack: {
        readonly enabled: boolean;
        readonly intervalTicks: number;
        readonly maxDistance: number;
        readonly targetFamilies: readonly string[];
        readonly targetTypeIds: readonly string[];
        readonly chase: boolean;
    };
    readonly mine: {
        readonly enabled: boolean;
        readonly intervalTicks: number;
        readonly direction: "down" | "front" | "up";
        readonly blockTypeId: string | null;
        readonly searchRadius: number;
        readonly approach: boolean;
    };
    readonly place: {
        readonly enabled: boolean;
        readonly intervalTicks: number;
        readonly mode: "front" | "position";
        readonly position: Point | null;
        readonly selectionMode: "item" | "slot";
        readonly slot: number;
        readonly itemTypeId: string | null;
    };
    readonly use: {
        readonly enabled: boolean;
        readonly intervalTicks: number;
        readonly slot: number;
    };
}

export interface LifecycleOperation {
    readonly id: string;
    readonly kind: "create" | "delete" | "online" | "offline" | "rename" | "respawn";
    readonly previous: "online" | "offline" | "missing" | null;
    readonly target: "online" | "offline" | null;
    readonly phase: string;
    readonly previousName?: string;
    readonly targetName?: string;
}

export type PendingLifecycleKind =
    | "deleting"
    | "provisioning"
    | "renaming"
    | "respawning"
    | "restoring"
    | "snapshotting";

export type LifecycleStatus =
    | { readonly kind: "online" | "offline" | "missing" }
    | { readonly kind: PendingLifecycleKind; readonly operation: LifecycleOperation }
    | { readonly kind: "error"; readonly message: string; readonly operation?: LifecycleOperation };

export interface FakePlayerRecord {
    readonly id: FakePlayerId;
    readonly name: string;
    readonly ownerId: PlayerPersistentId;
    readonly recordRevision: number;
    readonly lifecycle: LifecycleStatus;
    readonly expectedOnline: boolean;
    readonly location: SavedLocation;
    readonly gameMode: FakePlayerGameMode;
    readonly skin: FakePlayerSkin;
    readonly selectedSlot: number;
    readonly totalExperience: number;
    readonly respawnMode: RespawnMode;
    readonly respawnLocation: SavedLocation | null;
    readonly inventoryRevision: number | null;
    readonly lastCheckpointTick: number | null;
    readonly behavior: BehaviorConfig;
}

export interface WorldCatalog {
    readonly nextId: number;
    readonly records: Readonly<Record<FakePlayerId, FakePlayerRecord>>;
}

export interface PermissionGrant {
    readonly playerId: PlayerPersistentId;
    readonly lastKnownName: string;
    readonly canPlace: boolean;
    readonly canSet: boolean;
}

export interface PermissionTable {
    readonly grants: Readonly<Record<PlayerPersistentId, PermissionGrant>>;
}

export interface PendingOperations {
    readonly workspace: Readonly<Record<string, WorkspaceOperation>>;
    readonly inventoryTransfers: Readonly<Record<string, InventoryTransfer>>;
    readonly experienceTransfers: Readonly<Record<string, ExperienceTransfer>>;
}

export interface WorkspaceOperation {
    readonly id: string;
    readonly phase: "prepared" | "placed" | "snapshotted" | "restored";
    readonly dimension: DimensionKey;
    readonly origin: Point;
    readonly backupStructureId: string;
}

export interface InventoryTransfer {
    readonly id: string;
    readonly fakePlayerId: FakePlayerId;
    readonly playerId: PlayerPersistentId;
    readonly fakePlayerRevision: number;
    readonly fakeSnapshotId: string;
    readonly fakeAfterSnapshotId: string;
    readonly request: InventoryTransferRequest;
    readonly beforeStructureId: string;
    readonly afterStructureId: string;
    readonly phase: "prepared" | "staged" | "applying" | "committed" | "checkpointed";
}

export type InventoryTransferRequest =
    | { readonly kind: "recycle_all" }
    | { readonly kind: "swap_inventory" }
    | { readonly kind: "swap_equipment" }
    | { readonly kind: "swap"; readonly fakeSlot: number; readonly playerSlot: number }
    | { readonly kind: "take"; readonly fakeSlot: number; readonly playerSlot: number }
    | { readonly kind: "put"; readonly fakeSlot: number; readonly playerSlot: number }
    | { readonly kind: "swap_fake"; readonly firstSlot: number; readonly secondSlot: number };

export interface ExperienceTransfer {
    readonly id: string;
    readonly fakePlayerId: FakePlayerId;
    readonly playerId: PlayerPersistentId;
    readonly fakePlayerRevision: number;
    readonly kind: "fake_to_player";
    readonly fakePlayerBefore: number;
    readonly playerBefore: number;
    readonly amount: number;
    readonly phase: "prepared" | "applying" | "committed";
}