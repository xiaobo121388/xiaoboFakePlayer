import { Player, PlayerPermissionLevel } from "@minecraft/server";

import type { SavedLocation } from "../domain/model.js";
import type { ActorIdentity } from "../domain/permissions.js";

const FAKE_PLAYER_TAG_PREFIX = "xiaobo_fp_";

export function getPlayerStableId(player: Player): string {
    const candidate = player.persistentId ?? (player as unknown as { playfabId?: string }).playfabId;
    return typeof candidate === "string" ? candidate : "";
}

export function matchesPlayerId(player: Player, playerId: string): boolean {
    if (playerId.length === 0) return false;
    const currentStable = getPlayerStableId(player);
    if (currentStable.length > 0 && currentStable === playerId) return true;
    const legacyPlayfab = (player as unknown as { playfabId?: string }).playfabId;
    return legacyPlayfab === playerId;
}

export function isRealPlayer(value: unknown): value is Player {
    return value instanceof Player
        && value.isValid
        && !value.getTags().some((tag) => tag.startsWith(FAKE_PLAYER_TAG_PREFIX));
}

export function actorIdentity(player: Player): ActorIdentity {
    const id = getPlayerStableId(player);
    if (id.length === 0) throw new Error("当前玩家没有可用的持久稳定 ID。");
    return {
        playerId: id,
        isOperator: player.playerPermissionLevel === PlayerPermissionLevel.Operator,
    };
}

export function playerLocation(player: Player): SavedLocation {
    return {
        dimension: player.dimension.id,
        position: player.location,
        rotation: player.getRotation(),
    };
}