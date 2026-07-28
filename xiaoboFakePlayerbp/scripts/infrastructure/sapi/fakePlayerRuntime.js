import { Direction, EntityComponentTypes, GameMode, world } from "@minecraft/server";
import { getPlayerSkin, PersonaArmSize, PersonaPieceType, SimulatedPlayer, spawnSimulatedPlayer, } from "@minecraft/server-gametest";
const TAG_PREFIX = "xiaobo_fp_";
const MAX_EXPERIENCE_CHANGE = 16_777_216;
export class SapiFakePlayerRuntime {
    handles = new Map();
    capturePlayerSkin(playerId) {
        const source = world.getAllPlayers().find((player) => player.playfabId === playerId);
        if (source === undefined)
            throw new Error(`skin ${playerId}: 未找到在线真人玩家。`);
        const skin = getPlayerSkin(source);
        if (skin.personaPieces === undefined || skin.personaPieces.length === 0)
            return undefined;
        return {
            kind: "persona",
            ...(skin.armSize === undefined ? {} : { armSize: skin.armSize }),
            personaPieces: skin.personaPieces.map((piece) => ({ ...piece })),
            ...(skin.skinColor === undefined ? {} : { skinColor: { ...skin.skinColor } }),
        };
    }
    spawn(request) {
        if (this.get(request.id) !== undefined) {
            throw new Error(`spawn ${request.id}: 已存在有效运行时实例。`);
        }
        const dimension = world.getDimension(request.dimension);
        const player = spawnSimulatedPlayer({ dimension, ...request.position }, request.name, toGameMode(request.gameMode));
        try {
            player.addTag(`${TAG_PREFIX}${request.id}`);
            if (request.skin.kind === "persona")
                player.setSkin(toPlayerSkinData(request.skin));
            player.setRotation(request.rotation);
            player.selectedSlotIndex = request.selectedSlot;
            addExperience(player, request.totalExperience);
        }
        catch (cause) {
            if (player.isValid)
                player.disconnect();
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`spawn ${request.id}: 初始化模拟玩家失败：${message}`);
        }
        this.handles.set(request.id, player);
        return toRuntimePlayer(request.id, player);
    }
    disconnect(id) {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid)
            return false;
        player.disconnect();
        this.handles.delete(id);
        return true;
    }
    respawn(id, location) {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid)
            return false;
        const health = player.getComponent(EntityComponentTypes.Health);
        if (health === undefined)
            throw new Error(`respawn ${id}: 缺少生命值组件。`);
        if (health.currentValue <= 0 && !player.respawn())
            return false;
        if (location !== undefined) {
            player.teleport(location.position, {
                dimension: world.getDimension(location.dimension),
                rotation: location.rotation,
            });
        }
        return true;
    }
    perform(id, action) {
        const player = this.getHandle(id);
        if (player === undefined)
            return { accepted: false };
        switch (action.kind) {
            case "attack_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid)
                    return { accepted: false };
                const accepted = player.attackEntity(target);
                return { accepted, inventoryChanged: accepted };
            }
            case "break_block": {
                const accepted = player.breakBlock(action.position, toDirection(action.face));
                return { accepted, inventoryChanged: accepted };
            }
            case "interact_block": {
                const accepted = player.interactWithBlock(action.position, toDirection(action.face));
                return { accepted, inventoryChanged: accepted };
            }
            case "interact_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid)
                    return { accepted: false };
                const accepted = player.interactWithEntity(target);
                return { accepted, inventoryChanged: accepted };
            }
            case "jump":
                return { accepted: player.jump() };
            case "look_at":
                player.lookAtLocation(action.position);
                return { accepted: true };
            case "look_at_entity": {
                const target = world.getEntity(action.targetId);
                if (target === undefined || !target.isValid)
                    return { accepted: false };
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
                if (target === undefined || !target.isValid)
                    return { accepted: false };
                const navigation = player.navigateToEntity(target, action.speed);
                return { accepted: true, fullPath: navigation.isFullPath };
            }
            case "rotate":
                player.rotateBody(action.angle);
                return { accepted: true };
            case "set_rotation":
                player.setBodyRotation(action.angle);
                return { accepted: true };
            case "set_sneaking":
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
            case "use_item_on_block": {
                const accepted = player.useItemInSlotOnBlock(action.slot, action.position, toDirection(action.face));
                return { accepted, inventoryChanged: accepted };
            }
        }
    }
    get(id) {
        const player = this.handles.get(id);
        if (player === undefined)
            return undefined;
        if (!player.isValid) {
            this.handles.delete(id);
            return undefined;
        }
        return toRuntimePlayer(id, player);
    }
    listTagged() {
        const rebound = new Map();
        for (const player of world.getAllPlayers()) {
            if (!(player instanceof SimulatedPlayer))
                continue;
            const ids = player.getTags()
                .filter((tag) => tag.startsWith(TAG_PREFIX))
                .map((tag) => tag.slice(TAG_PREFIX.length))
                .filter((id) => /^fp\d{4,}$/.test(id));
            if (ids.length === 0)
                continue;
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
    getHandle(id) {
        const player = this.handles.get(id);
        if (player === undefined || !player.isValid) {
            this.handles.delete(id);
            return undefined;
        }
        return player;
    }
}
function toRuntimePlayer(id, player) {
    return {
        id,
        name: player.name,
        dimension: player.dimension.id,
        position: player.location,
        rotation: player.getRotation(),
        gameMode: fromGameMode(player.getGameMode()),
        selectedSlot: player.selectedSlotIndex,
        totalExperience: player.getTotalXp(),
        alive: (player.getComponent(EntityComponentTypes.Health)?.currentValue ?? 0) > 0,
    };
}
function toGameMode(gameMode) {
    switch (gameMode) {
        case "adventure": return GameMode.Adventure;
        case "creative": return GameMode.Creative;
        case "spectator": return GameMode.Spectator;
        case "survival": return GameMode.Survival;
    }
}
function fromGameMode(gameMode) {
    switch (gameMode) {
        case GameMode.Adventure: return "adventure";
        case GameMode.Creative: return "creative";
        case GameMode.Spectator: return "spectator";
        case GameMode.Survival: return "survival";
    }
}
function toDirection(face) {
    switch (face) {
        case "down": return Direction.Down;
        case "east": return Direction.East;
        case "north": return Direction.North;
        case "south": return Direction.South;
        case "up": return Direction.Up;
        case "west": return Direction.West;
    }
}
function addExperience(player, totalExperience) {
    let remaining = totalExperience;
    while (remaining > 0) {
        const amount = Math.min(remaining, MAX_EXPERIENCE_CHANGE);
        player.addExperience(amount);
        remaining -= amount;
    }
}
function toPlayerSkinData(skin) {
    return {
        ...(skin.armSize === undefined ? {} : { armSize: PersonaArmSize[skin.armSize] }),
        personaPieces: skin.personaPieces.map((piece) => ({
            ...piece,
            type: PersonaPieceType[piece.type],
        })),
        ...(skin.skinColor === undefined ? {} : { skinColor: skin.skinColor }),
    };
}
