export const CAPABILITY_MATRIX = {
    gameVersion: "1.26.33",
    serverVersion: "2.9.0-beta.1.26.33-stable",
    serverUiVersion: "2.2.0-beta.1.26.33-stable",
    gameTestVersion: "1.0.0-beta.1.26.33-stable",
    capabilities: [
        {
            id: "simulated_player",
            availability: "enabled",
            verification: "bedrock_26_33_required",
            detail: "spawnSimulatedPlayer 生命周期与稳定标签重绑定已实现。",
        },
        {
            id: "automatic_block_placement",
            availability: "enabled",
            verification: "bedrock_26_33_required",
            detail: "模拟玩家可按视线命中面或指定目标坐标，使用真实库存槽自动放置方块。",
        },
        {
            id: "entity_interaction_form",
            availability: "enabled",
            verification: "bedrock_26_33_required",
            detail: "空手与假人实体交互可直接打开该假人的设置界面。",
        },
        {
            id: "structure_inventory_snapshot",
            availability: "enabled",
            verification: "bedrock_26_33_required",
            detail: "41 槽两木桶结构快照和崩溃恢复已实现。",
        },
        {
            id: "persona_skin_copy",
            availability: "enabled",
            verification: "bedrock_26_33_required",
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
            verification: "bedrock_26_33_required",
            detail: "精确类型可写，但发布入口等待正式版 1.26.33 实机验证。",
        },
        {
            id: "hunger_saturation_write",
            availability: "hidden_pending_game_validation",
            verification: "bedrock_26_33_required",
            detail: "公开组件存在，但写入语义尚未通过正式版 1.26.33 实机验证。",
        },
        {
            id: "automatic_fishing",
            availability: "hidden_pending_game_validation",
            verification: "bedrock_26_33_required",
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
export function isCapabilityEnabled(id) {
    return CAPABILITY_MATRIX.capabilities.some((capability) => capability.id === id && capability.availability === "enabled");
}
//# sourceMappingURL=capabilities.js.map