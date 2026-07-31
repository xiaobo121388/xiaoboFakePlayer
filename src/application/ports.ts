import type {
    DimensionKey,
    FakePlayerGameMode,
    FakePlayerId,
    FakePlayerSkin,
    ExperienceTransfer,
    InventoryTransfer,
    PendingOperations,
    PermissionTable,
    Point,
    Rotation,
    SavedLocation,
    WorldCatalog,
} from "../domain/model.js";
import type { Result } from "../domain/results.js";

export interface VersionedState<T> {
    readonly value: T;
    readonly revision: number;
    readonly recovered: boolean;
    readonly diagnostics: readonly string[];
}

export type LoadedState<T> =
    | { readonly ok: true; readonly state: VersionedState<T> }
    | { readonly ok: false; readonly readOnly: true; readonly diagnostics: readonly string[] };

export interface WorldStateStore {
    loadCatalog(): LoadedState<WorldCatalog>;
    loadPermissions(): LoadedState<PermissionTable>;
    loadOperations(): LoadedState<PendingOperations>;
    commitCatalog(expectedRevision: number, value: WorldCatalog): Result<VersionedState<WorldCatalog>>;
    commitPermissions(expectedRevision: number, value: PermissionTable): Result<VersionedState<PermissionTable>>;
    commitOperations(expectedRevision: number, value: PendingOperations): Result<VersionedState<PendingOperations>>;
}

export interface SpawnFakePlayerRequest {
    readonly id: FakePlayerId;
    readonly name: string;
    readonly dimension: DimensionKey;
    readonly position: Point;
    readonly rotation: Rotation;
    readonly gameMode: FakePlayerGameMode;
    readonly skin: FakePlayerSkin;
    readonly selectedSlot: number;
    readonly totalExperience: number;
}

export interface RuntimeFakePlayer {
    readonly id: FakePlayerId;
    readonly name: string;
    readonly dimension: DimensionKey;
    readonly position: Point;
    readonly headPosition: Point;
    readonly rotation: Rotation;
    readonly gameMode: FakePlayerGameMode;
    readonly isSneaking: boolean;
    readonly selectedSlot: number;
    readonly totalExperience: number;
    readonly alive: boolean;
}

export type RuntimeInventorySelection =
    | { readonly mode: "item"; readonly itemTypeId: string | null }
    | { readonly mode: "slot"; readonly slot: number };

export interface RuntimeInventorySlot {
    readonly slot: number;
    readonly itemTypeId: string | null;
    readonly placeableBlock: boolean;
}

export type BlockFace = "down" | "east" | "north" | "south" | "up" | "west";

export type RuntimeBlockInteractionSelection =
    | { readonly mode: "item"; readonly slot: number; readonly emptyHand: boolean }
    | { readonly mode: "slot"; readonly slot: number };

export type RuntimeFakePlayerAction =
    | { readonly kind: "attack_entity"; readonly targetId: string }
    | { readonly kind: "break_block"; readonly position: Point; readonly face: BlockFace }
    | {
        readonly kind: "build_block";
        readonly position: Point;
        readonly face: BlockFace;
        readonly preserveView?: boolean;
        readonly target: Point;
        readonly selection: RuntimeBlockInteractionSelection;
    }
    | {
        readonly kind: "interact_block";
        readonly position: Point;
        readonly face: BlockFace;
        readonly preserveView?: boolean;
        readonly selection?: RuntimeBlockInteractionSelection;
    }
    | { readonly kind: "interact_entity"; readonly targetId: string }
    | { readonly kind: "jump" }
    | { readonly kind: "look_at"; readonly position: Point }
    | { readonly kind: "look_at_once"; readonly rotation: Rotation }
    | { readonly kind: "look_at_entity"; readonly targetId: string }
    | { readonly kind: "move_to"; readonly position: Point; readonly speed: number }
    | { readonly kind: "navigate"; readonly position: Point; readonly speed: number }
    | { readonly kind: "navigate_entity"; readonly targetId: string; readonly speed: number }
    | { readonly kind: "rotate"; readonly angle: number }
    | { readonly kind: "set_rotation"; readonly angle: number }
    | { readonly kind: "set_sneaking"; readonly enabled: boolean }
    | { readonly kind: "stop" }
    | { readonly kind: "stop_moving" }
    | { readonly kind: "teleport"; readonly location: SavedLocation }
    | { readonly kind: "use_item"; readonly slot: number }
    | { readonly kind: "place_block_direct"; readonly slot: number; readonly position: Point }
    | {
        readonly kind: "use_item_on_block";
        readonly slot: number;
        readonly position: Point;
        readonly face: BlockFace;
        readonly faceLocation: Point;
    };

export interface RuntimeActionReceipt {
    readonly accepted: boolean;
    readonly fullPath?: boolean;
    readonly inventoryChanged?: boolean;
}

export interface FakePlayerRuntime {
    capturePlayerSkin(playerId: string): FakePlayerSkin | undefined;
    spawn(request: SpawnFakePlayerRequest): RuntimeFakePlayer;
    disconnect(id: FakePlayerId): boolean;
    respawn(id: FakePlayerId, location?: SavedLocation): boolean;
    resolveInventorySlot(id: FakePlayerId, selection: RuntimeInventorySelection): RuntimeInventorySlot | undefined;
    perform(id: FakePlayerId, action: RuntimeFakePlayerAction): RuntimeActionReceipt;
    get(id: FakePlayerId): RuntimeFakePlayer | undefined;
    listTagged(): readonly RuntimeFakePlayer[];
}

export interface InventorySnapshotStore {
    save(fakePlayerId: FakePlayerId, revision: number): Result<string>;
    restore(fakePlayerId: FakePlayerId, structureId: string): Result<void>;
    remove(structureId: string): Result<void>;
    has(structureId: string): boolean;
    recoverWorkspaces(): Result<void>;
}

export type InventoryImageState = "after" | "before" | "conflict" | "mixed";

export interface InventoryEnchantmentOverview {
    readonly typeId: string;
    readonly level: number;
}

export interface InventoryItemOverview {
    readonly typeId: string;
    readonly amount: number;
    readonly nameTag: string | null;
    readonly lore: readonly string[];
    readonly durability: {
        readonly damage: number;
        readonly maxDurability: number;
        readonly unbreakable: boolean;
    } | null;
    readonly enchantments: readonly InventoryEnchantmentOverview[];
}

export interface InventorySlotOverview {
    readonly slot: number;
    readonly item: InventoryItemOverview | null;
}

export interface InventoryAccess {
    readLiveOverview(fakePlayerId: FakePlayerId): Result<readonly InventorySlotOverview[]>;
    readSnapshotOverview(
        structureId: string,
        playerId: string,
    ): Result<readonly InventorySlotOverview[]>;
    getPlayerMainhandItemTypeId(playerId: string): Result<string | null>;
    prepareTransfer(transfer: InventoryTransfer): Result<void>;
    compareWithImages(transfer: InventoryTransfer): Result<InventoryImageState>;
    compareFakeWithImages(transfer: InventoryTransfer): Result<InventoryImageState>;
    applyBeforeImage(transfer: InventoryTransfer): Result<void>;
    applyAfterImage(transfer: InventoryTransfer): Result<void>;
    applyFakeAfterImage(transfer: InventoryTransfer): Result<void>;
    removeTransferImages(transfer: InventoryTransfer): Result<void>;
    getPlayerExperience(playerId: string): Result<number>;
    setPlayerExperience(playerId: string, totalExperience: number): Result<void>;
    getFakePlayerExperience(fakePlayerId: FakePlayerId): Result<number>;
    setFakePlayerExperience(fakePlayerId: FakePlayerId, totalExperience: number): Result<void>;
    compareExperience(transfer: ExperienceTransfer): Result<InventoryImageState>;
}

export interface RuntimeEntityTarget {
    readonly id: string;
    readonly dimension: DimensionKey;
    readonly position: Point;
}

export interface AttackTargetQuery {
    readonly maxDistance: number;
    readonly families: readonly string[];
    readonly typeIds: readonly string[];
    readonly limit: number;
}

export interface RuntimeBlockInfo {
    readonly typeId: string;
    readonly solid: boolean;
}

export interface RuntimeBlockHit {
    readonly position: Point;
    readonly face: BlockFace;
    readonly faceLocation: Point;
    readonly distance: number;
}

export interface WorldQueries {
    isChunkLoaded(dimension: DimensionKey, position: Point): boolean;
    isSolidBlock(dimension: DimensionKey, position: Point): boolean;
    getBlockFromViewDirection(fakePlayerId: FakePlayerId, maxDistance: number): RuntimeBlockHit | undefined;
    hasBlockLineOfSight(
        fakePlayerId: FakePlayerId,
        dimension: DimensionKey,
        position: Point,
        maxDistance: number,
    ): boolean;
    hasLineOfSight(fakePlayerId: FakePlayerId, targetId: string): boolean;
    distanceSquared(fakePlayerId: FakePlayerId, targetId: string): number | undefined;
    findOnlinePlayer(playerId: string): RuntimeEntityTarget | undefined;
    findAttackTargets(fakePlayerId: FakePlayerId, query: AttackTargetQuery): readonly RuntimeEntityTarget[];
    getBlockInfo(dimension: DimensionKey, position: Point): RuntimeBlockInfo | undefined;
}