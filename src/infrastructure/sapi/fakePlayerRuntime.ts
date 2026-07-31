import {
    BlockTypes,
    Direction,
    EntityComponentTypes,
    GameMode,
    world,
    type Block,
    type BlockPermutation,
    type EntityInventoryComponent,
} from "@minecraft/server";
import {
    getPlayerSkin,
    LookDuration,
    PersonaArmSize,
    PersonaPieceType,
    SimulatedPlayer,
    spawnSimulatedPlayer,
    type PlayerSkinData,
} from "@minecraft/server-gametest";

import type {
    BlockFace,
    FakePlayerRuntime,
    RuntimeActionReceipt,
    RuntimeFakePlayer,
    RuntimeFakePlayerAction,
    RuntimeInventorySelection,
    RuntimeInventorySlot,
    SpawnFakePlayerRequest,
} from "../../application/ports.js";
import { HOTBAR_SLOT_COUNT, INVENTORY_SLOT_COUNT } from "../../domain/inventory.js";
import type { FakePlayerGameMode, FakePlayerId, FakePlayerSkin, Point, SavedLocation } from "../../domain/model.js";

const TAG_PREFIX = "xiaobo_fp_";
const MAX_EXPERIENCE_CHANGE = 16_777_216;
const SATURATION_EFFECT = "minecraft:saturation";
const SATURATION_DURATION_TICKS = 120;
const CLAIMABLE_PROJECTILE_TYPE_IDS = new Set(["minecraft:arrow", "minecraft:thrown_trident"]);

export class SapiFakePlayerRuntime implements FakePlayerRuntime {
    private readonly handles = new Map<FakePlayerId, SimulatedPlayer>();

    public capturePlayerSkin(playerId: string): FakePlayerSkin | undefined {
        const source = world.getAllPlayers().find((player) => player.playfabId === playerId);
        if (source === undefined) throw new Error(`skin ${playerId}: 未找到在线真人玩家。`);
        const skin = getPlayerSkin(source);
        if (skin.personaPieces === undefined || skin.personaPieces.length === 0) return undefined;
        return {
            kind: "persona",
            ...(skin.armSize === undefined ? {} : { armSize: skin.armSize }),
            personaPieces: skin.personaPieces.map((piece) => ({ ...piece })),
            ...(skin.skinColor === undefined ? {} : { skinColor: { ...skin.skinColor } }),
        };
    }

    public spawn(request: SpawnFakePlayerRequest): RuntimeFakePlayer {
        if (this.get(request.id) !== undefined) {
            throw new Error(`spawn ${request.id}: 已存在有效运行时实例。`);
        }
        const dimension = world.getDimension(request.dimension);
        const player = spawnSimulatedPlayer(
            { dimension, ...request.position },
            request.name,
            toGameMode(request.gameMode),
        );
        try {
            player.addTag(`${TAG_PREFIX}${request.id}`);
            if (request.skin.kind === "persona") player.setSkin(toPlayerSkinData(request.skin));
            player.setRotation(request.rotation);
            player.selectedSlotIndex = request.selectedSlot;
            addExperience(player, request.totalExperience);
            if (request.keepSaturated) {
                player.addEffect(SATURATION_EFFECT, SATURATION_DURATION_TICKS, {
                    amplifier: 5,
                    showParticles: false,
                });
            }
        } catch (cause) {
            if (player.isValid) player.disconnect();
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`spawn ${request.id}: 初始化模拟玩家失败：${message}`);
        }
        this.handles.set(request.id, player);
        return toRuntimePlayer(request.id, player);
    }

    public disconnect(id: FakePlayerId): boolean {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid) return false;
        player.disconnect();
        this.handles.delete(id);
        return true;
    }

    public respawn(id: FakePlayerId, location?: SavedLocation): boolean {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid) return false;
        const health = player.getComponent(EntityComponentTypes.Health);
        if (health === undefined) throw new Error(`respawn ${id}: 缺少生命值组件。`);
        if (health.currentValue <= 0 && !player.respawn()) return false;
        if (location !== undefined) {
            player.teleport(location.position, {
                dimension: world.getDimension(location.dimension),
                rotation: location.rotation,
            });
        }
        return true;
    }

    public claimProjectiles(id: FakePlayerId, radius: number): number {
        if (!Number.isFinite(radius) || radius <= 0) {
            throw new RangeError(`claim projectiles ${id}: 搜索半径必须是正数。`);
        }
        const player = this.getHandle(id);
        if (player === undefined) return 0;
        let claimed = 0;
        for (const type of CLAIMABLE_PROJECTILE_TYPE_IDS) {
            for (const entity of player.dimension.getEntities({
                location: player.location,
                maxDistance: radius,
                type,
            })) {
                if (!entity.isValid) continue;
                const projectile = entity.getComponent(EntityComponentTypes.Projectile);
                if (projectile === undefined || projectile.owner === player) continue;
                projectile.owner = player;
                claimed += 1;
            }
        }
        return claimed;
    }

    public resolveInventorySlot(
        id: FakePlayerId,
        selection: RuntimeInventorySelection,
    ): RuntimeInventorySlot | undefined {
        const player = this.getHandle(id);
        if (player === undefined) return undefined;
        const inventory = player.getComponent(
            EntityComponentTypes.Inventory,
        ) as EntityInventoryComponent | undefined;
        const container = inventory?.container;
        if (container === undefined) throw new Error(`inventory ${id}: 缺少库存容器。`);
        const slot = selection.mode === "slot"
            ? selection.slot
            : selection.itemTypeId === null
                ? player.selectedSlotIndex
                : findInventorySlot(container, selection.itemTypeId);
        if (slot === undefined) return undefined;
        const item = selection.mode === "item" && selection.itemTypeId === null
            ? undefined
            : container.getItem(slot);
        return {
            slot,
            itemTypeId: item?.typeId ?? null,
            placeableBlock: item !== undefined && BlockTypes.get(item.typeId) !== undefined,
        };
    }

    public perform(id: FakePlayerId, action: RuntimeFakePlayerAction): RuntimeActionReceipt {
        const player = this.getHandle(id);
        if (player === undefined) return { accepted: false };
        switch (action.kind) {
            case "attack_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid) return { accepted: false };
                const accepted = player.attackEntity(target);
                return { accepted, inventoryChanged: accepted };
            }
            case "break_block": {
                const accepted = player.breakBlock(action.position, toDirection(action.face));
                const message = `[xiaobo-fake-player] mine ${id} start accepted=${accepted}; `
                    + `dimension=${player.dimension.id}; target=${formatPoint(action.position)}; `
                    + `face=${action.face}; mode=${player.getGameMode()}; slot=${player.selectedSlotIndex}`;
                if (accepted) console.info(message);
                else console.warn(message);
                return { accepted };
            }
            case "build_block":
            case "interact_block": {
                const selection = action.selection;
                if (selection?.mode === "slot") {
                    if (selection.slot < 0 || selection.slot >= HOTBAR_SLOT_COUNT) {
                        throw new RangeError(`interact ${id}: 快捷栏槽位必须是 0 到 ${HOTBAR_SLOT_COUNT - 1}。`);
                    }
                    player.selectedSlotIndex = selection.slot;
                }
                const inventory = action.kind === "build_block" || selection?.mode === "item"
                    ? player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined
                    : undefined;
                const container = inventory?.container;
                const selectedSlot = player.selectedSlotIndex;
                const selectedItem = selection?.mode === "item" && selection.emptyHand
                    ? container?.getItem(selectedSlot)
                    : undefined;
                if (selection?.mode === "item" && container === undefined) {
                    throw new Error(`interact ${id}: 缺少库存容器，无法准备交互物品。`);
                }
                if (action.kind === "build_block" && container === undefined) {
                    throw new Error(`place ${id}: 缺少库存容器，无法准备建造物品。`);
                }
                const swapsItem = selection?.mode === "item"
                    && !selection.emptyHand
                    && selection.slot !== selectedSlot;
                let accepted: boolean;
                try {
                    if (selection?.mode === "item") {
                        if (selection.emptyHand) container?.setItem(selectedSlot);
                        else if (swapsItem) container?.swapItems(selection.slot, selectedSlot, container);
                    }
                    if (action.kind === "build_block") {
                        const rotation = action.preserveView ? undefined : player.getRotation();
                        try {
                            if (!action.preserveView) {
                                player.lookAtLocation(
                                    blockFaceCenter(action.position, action.face),
                                    LookDuration.Instant,
                                );
                            }
                            const target = player.dimension.getBlock(action.target);
                            if (target === undefined || !target.isAir) {
                                accepted = false;
                            } else {
                                player.stopBreakingBlock();
                                const swapsBuildSlot = selectedSlot !== 0;
                                if (swapsBuildSlot) container!.swapItems(selectedSlot, 0, container!);
                                try {
                                    player.startBuild();
                                    player.stopBuild();
                                    accepted = true;
                                } finally {
                                    if (swapsBuildSlot && player.isValid) {
                                        container!.swapItems(selectedSlot, 0, container!);
                                    }
                                }
                            }
                        } finally {
                            if (rotation !== undefined && player.isValid) player.setRotation(rotation);
                        }
                    } else {
                        if (!action.preserveView) {
                            player.lookAtBlock(action.position, LookDuration.Instant);
                        }
                        accepted = player.interact();
                    }
                } finally {
                    if (selection?.mode === "item" && player.isValid) {
                        if (selection.emptyHand) container?.setItem(selectedSlot, selectedItem);
                        else if (swapsItem) container?.swapItems(selection.slot, selectedSlot, container);
                    }
                }
                return { accepted, inventoryChanged: accepted };
            }
            case "interact_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid) return { accepted: false };
                const accepted = player.interactWithEntity(target);
                return { accepted, inventoryChanged: accepted };
            }
            case "jump":
                return { accepted: player.jump() };
            case "look_at":
                player.lookAtLocation(action.position);
                return { accepted: true };
            case "look_at_once":
                player.lookAtLocation(action.position);
                return { accepted: true };
            case "look_at_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid) return { accepted: false };
                player.lookAtEntity(target);
                return { accepted: true };
            }
            case "move_to":
                player.moveToLocation(action.position, { faceTarget: true, speed: action.speed });
                return { accepted: true };
            case "navigate": {
                const navigation = player.navigateToLocation(action.position, action.speed);
                return { accepted: true, fullPath: navigation.isFullPath };
            }
            case "navigate_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid) return { accepted: false };
                const navigation = player.navigateToEntity(target, action.speed);
                return { accepted: true, fullPath: navigation.isFullPath };
            }
            case "rotate":
                player.rotateBody(action.angle);
                return { accepted: true };
            case "set_game_mode":
                player.setGameMode(toGameMode(action.gameMode));
                return { accepted: true };
            case "set_rotation":
                player.setBodyRotation(action.angle);
                return { accepted: true };
            case "set_saturation":
                if (action.enabled) {
                    player.addEffect(SATURATION_EFFECT, SATURATION_DURATION_TICKS, {
                        amplifier: 5,
                        showParticles: false,
                    });
                } else {
                    player.removeEffect(SATURATION_EFFECT);
                }
                return { accepted: true };
            case "set_sneaking":
                player.stopInteracting();
                player.isSneaking = action.enabled;
                return { accepted: true };
            case "stop":
                player.stopBreakingBlock();
                player.stopInteracting();
                player.stopMoving();
                player.stopUsingItem();
                return { accepted: true };
            case "stop_moving":
                player.stopMoving();
                return { accepted: true };
            case "teleport":
                player.teleport(action.location.position, {
                    dimension: world.getDimension(action.location.dimension),
                    rotation: action.location.rotation,
                });
                return { accepted: true };
            case "use_item": {
                const accepted = player.useItemInSlot(action.slot);
                return { accepted, inventoryChanged: accepted };
            }
            case "place_block_direct": {
                let target: Block | undefined;
                let previousPermutation: BlockPermutation | undefined;
                let placed = false;
                let itemTypeId = "empty";
                try {
                    const inventory = player.getComponent(
                        EntityComponentTypes.Inventory,
                    ) as EntityInventoryComponent | undefined;
                    const container = inventory?.container;
                    const item = container?.getItem(action.slot);
                    itemTypeId = item?.typeId ?? "empty";
                    const blockType = item === undefined ? undefined : BlockTypes.get(item.typeId);
                    target = player.dimension.getBlock(action.position);
                    if (container === undefined || item === undefined || blockType === undefined
                        || target === undefined || !target.isAir) {
                        return { accepted: false };
                    }
                    const gameMode = player.getGameMode();
                    const consumesItem = gameMode !== GameMode.Creative;
                    previousPermutation = target.permutation;
                    target.setType(blockType);
                    placed = true;
                    if (consumesItem) {
                        if (item.amount === 1) {
                            container.setItem(action.slot);
                        } else {
                            const remaining = item.clone();
                            remaining.amount -= 1;
                            container.setItem(action.slot, remaining);
                        }
                    }
                    console.info(
                        `[xiaobo-fake-player] place ${id} direct accepted=true; `
                        + `dimension=${player.dimension.id}; target=${formatPoint(action.position)}; `
                        + `slot=${action.slot}; item=${item.typeId}x${item.amount}; `
                        + `mode=${gameMode}; consumed=${consumesItem}`,
                    );
                    return { accepted: true, inventoryChanged: consumesItem };
                } catch (cause) {
                    let rollback = "";
                    if (placed && target !== undefined && previousPermutation !== undefined) {
                        try {
                            target.setPermutation(previousPermutation);
                        } catch (rollbackCause) {
                            const rollbackMessage = rollbackCause instanceof Error
                                ? rollbackCause.message
                                : String(rollbackCause);
                            rollback = `；回滚目标失败：${rollbackMessage}`;
                        }
                    }
                    const message = cause instanceof Error ? cause.message : String(cause);
                    throw new Error(
                        `place ${id}: 直接放置槽位 ${action.slot} 的 ${itemTypeId} `
                        + `到 ${formatPoint(action.position)} 失败：${message}${rollback}`,
                        { cause },
                    );
                }
            }
            case "use_item_on_block": {
                const inventory = player.getComponent(
                    EntityComponentTypes.Inventory,
                ) as EntityInventoryComponent | undefined;
                const item = inventory?.container.getItem(action.slot);
                let accepted: boolean;
                let sneaking: boolean;
                try {
                    player.stopInteracting();
                    sneaking = player.isSneaking;
                    accepted = player.useItemInSlotOnBlock(
                        action.slot,
                        action.position,
                        toDirection(action.face),
                        action.faceLocation,
                    );
                } catch (cause) {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    throw new Error(
                        `place ${id}: 使用槽位 ${action.slot} 点击 ${formatPoint(action.position)} `
                        + `${action.face}@${formatPoint(action.faceLocation)} 失败：${message}`,
                    );
                }
                const message = `[xiaobo-fake-player] place ${id} accepted=${accepted}; `
                    + `dimension=${player.dimension.id}; support=${formatPoint(action.position)}; `
                    + `face=${action.face}; faceLocation=${formatPoint(action.faceLocation)}; `
                    + `slot=${action.slot}; item=${item === undefined ? "empty" : `${item.typeId}x${item.amount}`}; `
                    + `mode=${player.getGameMode()}; selectedSlot=${player.selectedSlotIndex}; `
                    + `sneaking=${sneaking}`;
                if (accepted) console.info(message);
                else console.warn(message);
                return { accepted, inventoryChanged: accepted };
            }
        }
    }

    public get(id: FakePlayerId): RuntimeFakePlayer | undefined {
        const player = this.handles.get(id);
        if (player === undefined) return undefined;
        if (!player.isValid) {
            this.handles.delete(id);
            return undefined;
        }
        return toRuntimePlayer(id, player);
    }

    public listTagged(): readonly RuntimeFakePlayer[] {
        const rebound = new Map<FakePlayerId, SimulatedPlayer>();
        for (const player of world.getAllPlayers()) {
            if (!(player instanceof SimulatedPlayer)) continue;
            const ids = player.getTags()
                .filter((tag) => tag.startsWith(TAG_PREFIX))
                .map((tag) => tag.slice(TAG_PREFIX.length))
                .filter((id) => /^fp\d{4,}$/.test(id));
            if (ids.length === 0) continue;
            const id = ids[0];
            if (ids.length !== 1 || id === undefined || rebound.has(id)) {
                throw new Error(`rebind ${player.name}: 稳定 ID 标签缺失或重复。`);
            }
            rebound.set(id, player);
        }
        this.handles.clear();
        rebound.forEach((player, id) => this.handles.set(id, player));
        return Array.from(this.handles, ([id, player]) => toRuntimePlayer(id, player));
    }

    public getHandle(id: FakePlayerId): SimulatedPlayer | undefined {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid) {
            this.handles.delete(id);
            return undefined;
        }
        return player;
    }
}

function toRuntimePlayer(id: FakePlayerId, player: SimulatedPlayer): RuntimeFakePlayer {
    return {
        id,
        name: player.name,
        dimension: player.dimension.id,
        position: player.location,
        headPosition: player.getHeadLocation(),
        rotation: player.getRotation(),
        gameMode: fromGameMode(player.getGameMode()),
        isSneaking: player.isSneaking,
        selectedSlot: player.selectedSlotIndex,
        totalExperience: player.getTotalXp(),
        alive: (player.getComponent(EntityComponentTypes.Health)?.currentValue ?? 0) > 0,
    };
}

function toGameMode(gameMode: FakePlayerGameMode): GameMode {
    switch (gameMode) {
        case "adventure": return GameMode.Adventure;
        case "creative": return GameMode.Creative;
        case "spectator": return GameMode.Spectator;
        case "survival": return GameMode.Survival;
    }
}

function fromGameMode(gameMode: GameMode): FakePlayerGameMode {
    switch (gameMode) {
        case GameMode.Adventure: return "adventure";
        case GameMode.Creative: return "creative";
        case GameMode.Spectator: return "spectator";
        case GameMode.Survival: return "survival";
    }
}

function toDirection(face: BlockFace): Direction {
    switch (face) {
        case "down": return Direction.Down;
        case "east": return Direction.East;
        case "north": return Direction.North;
        case "south": return Direction.South;
        case "up": return Direction.Up;
        case "west": return Direction.West;
    }
}

function addExperience(player: SimulatedPlayer, totalExperience: number): void {
    let remaining = totalExperience;
    while (remaining > 0) {
        const amount = Math.min(remaining, MAX_EXPERIENCE_CHANGE);
        player.addExperience(amount);
        remaining -= amount;
    }
}

function formatPoint(point: { readonly x: number; readonly y: number; readonly z: number }): string {
    return `${point.x},${point.y},${point.z}`;
}

function findInventorySlot(
    container: EntityInventoryComponent["container"],
    itemTypeId: string | null,
): number | undefined {
    for (let slot = 0; slot < INVENTORY_SLOT_COUNT; slot += 1) {
        const item = container.getItem(slot);
        if (itemTypeId === null ? item === undefined : item?.typeId === itemTypeId) return slot;
    }
    return undefined;
}

function toPlayerSkinData(skin: Extract<FakePlayerSkin, { kind: "persona" }>): PlayerSkinData {
    return {
        ...(skin.armSize === undefined ? {} : { armSize: PersonaArmSize[skin.armSize] }),
        personaPieces: skin.personaPieces.map((piece) => ({
            ...piece,
            type: PersonaPieceType[piece.type],
        })),
        ...(skin.skinColor === undefined ? {} : { skinColor: skin.skinColor }),
    };
}

function blockFaceCenter(position: Point, face: BlockFace): Point {
    switch (face) {
        case "down": return { x: position.x + 0.5, y: position.y, z: position.z + 0.5 };
        case "east": return { x: position.x + 1, y: position.y + 0.5, z: position.z + 0.5 };
        case "north": return { x: position.x + 0.5, y: position.y + 0.5, z: position.z };
        case "south": return { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 1 };
        case "up": return { x: position.x + 0.5, y: position.y + 1, z: position.z + 0.5 };
        case "west": return { x: position.x, y: position.y + 0.5, z: position.z + 0.5 };
    }
}