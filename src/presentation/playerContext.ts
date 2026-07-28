import { Player, PlayerPermissionLevel } from "@minecraft/server";

import type { SavedLocation } from "../domain/model.js";
import type { ActorIdentity } from "../domain/permissions.js";

const FAKE_PLAYER_TAG_PREFIX = "xiaobo_fp_";

export function isRealPlayer(value: unknown): value is Player {
    return value instanceof Player
        && value.isValid
        && !value.getTags().some((tag) => tag.startsWith(FAKE_PLAYER_TAG_PREFIX));
}

export function actorIdentity(player: Player): ActorIdentity {
    if (player.playfabId.length === 0) throw new Error("当前玩家没有可用的 PlayFab 稳定 ID。");
    return {
        playerId: player.playfabId,
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