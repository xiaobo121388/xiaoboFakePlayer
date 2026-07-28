export type CapabilityAvailability = "enabled" | "hidden_pending_game_validation" | "unsupported";

export interface CapabilityEntry {
    readonly id: string;
    readonly availability: CapabilityAvailability;
    readonly verification: "automated" | "bedrock_26_34_required" | "not_applicable";
    readonly detail: string;
}

export interface CapabilityMatrix {
    readonly gameVersion: "26.34";
    readonly serverVersion: "2.9.0-beta.1.26.34-stable";
    readonly serverUiVersion: "2.2.0-beta.1.26.34-stable";
    readonly gameTestVersion: "1.0.0-beta.1.26.34-stable";
    readonly capabilities: readonly CapabilityEntry[];
}

export const CAPABILITY_MATRIX: CapabilityMatrix = {
    gameVersion: "26.34",
    serverVersion: "2.9.0-beta.1.26.34-stable",
    serverUiVersion: "2.2.0-beta.1.26.34-stable",
    gameTestVersion: "1.0.0-beta.1.26.34-stable",
    capabilities: [
        {
            id: "simulated_player",
            availability: "enabled",
            verification: "bedrock_26_34_required",
            detail: "spawnSimulatedPlayer 生命周期与稳定标签重绑定已实现。",
        },
        {
            id: "structure_inventory_snapshot",
            availability: "enabled",
            verification: "bedrock_26_34_required",
            detail: "41 槽两木桶结构快照和崩溃恢复已实现。",
        },
        {
            id: "persona_skin_copy",
            availability: "enabled",
            verification: "bedrock_26_34_required",
            detail: "公开 Persona 部件、手臂尺寸和肤色可保存并恢复。",
        },
        {
            id: "classic_skin_texture_copy",
            availability: "unsupported",
            verification: "not_applicable",
            detail: "PlayerSkinData 不公开经典皮肤纹理，复制请求回退默认皮肤。",
        },
        {
            id: "sneaking",
            availability: "hidden_pending_game_validation",
            verification: "bedrock_26_34_required",
            detail: "精确类型可写，但发布入口等待正式版 26.34 实机验证。",
        },
        {
            id: "hunger_saturation_write",
            availability: "hidden_pending_game_validation",
            verification: "bedrock_26_34_required",
            detail: "公开组件存在，但写入语义尚未通过正式版 26.34 实机验证。",
        },
        {
            id: "automatic_fishing",
            availability: "hidden_pending_game_validation",
            verification: "bedrock_26_34_required",
            detail: "尚未证明可可靠关联钓鱼钩和收杆时机，不提供固定延时假实现。",
        },
        {
            id: "player_list_visibility",
            availability: "unsupported",
            verification: "not_applicable",
            detail: "公开 Script API 没有网易玩家列表隐藏开关的等价能力。",
        },
        {
            id: "netease_private_attributes",
            availability: "unsupported",
            verification: "not_applicable",
            detail: "不伪造最大属性、私有 NBT、横扫伤害或跨 Mod Python OpenAPI。",
        },
    ],
};

export function isCapabilityEnabled(id: string): boolean {
    return CAPABILITY_MATRIX.capabilities.some(
        (capability) => capability.id === id && capability.availability === "enabled",
    );
}