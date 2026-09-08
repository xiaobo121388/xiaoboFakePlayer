import { Player, PlayerPermissionLevel } from "@minecraft/server";
const FAKE_PLAYER_TAG_PREFIX = "xiaobo_fp_";
export function getPlayerStableId(player) {
    const candidate = player.persistentId ?? player.playfabId;
    return typeof candidate === "string" ? candidate : "";
}
export function matchesPlayerId(player, playerId) {
    if (playerId.length === 0)
        return false;
    const currentStable = getPlayerStableId(player);
    if (currentStable.length > 0 && currentStable === playerId)
        return true;
    const legacyPlayfab = player.playfabId;
    return legacyPlayfab === playerId;
}
export function isRealPlayer(value) {
    return value instanceof Player
        && value.isValid
        && !value.getTags().some((tag) => tag.startsWith(FAKE_PLAYER_TAG_PREFIX));
}
export function actorIdentity(player) {
    const id = getPlayerStableId(player);
    if (id.length === 0)
        throw new Error("当前玩家没有可用的持久稳定 ID。");
    return {
        playerId: id,
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
//# sourceMappingURL=playerContext.js.map