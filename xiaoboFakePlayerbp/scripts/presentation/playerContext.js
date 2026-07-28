import { Player, PlayerPermissionLevel } from "@minecraft/server";
const FAKE_PLAYER_TAG_PREFIX = "xiaobo_fp_";
export function isRealPlayer(value) {
    return value instanceof Player
        && value.isValid
        && !value.getTags().some((tag) => tag.startsWith(FAKE_PLAYER_TAG_PREFIX));
}
export function actorIdentity(player) {
    if (player.playfabId.length === 0)
        throw new Error("当前玩家没有可用的 PlayFab 稳定 ID。");
    return {
        playerId: player.playfabId,
        isOperator: player.playerPermissionLevel === PlayerPermissionLevel.Operator,
    };
}
export function playerLocation(player) {
    return {
        dimension: player.dimension.id,
        position: player.location,
        rotation: player.getRotation(),
    };
}
