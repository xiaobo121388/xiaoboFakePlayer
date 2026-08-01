const BASE_MELEE_DAMAGE = {
    "minecraft:wooden_sword": 5,
    "minecraft:golden_sword": 5,
    "minecraft:stone_sword": 6,
    "minecraft:copper_sword": 6,
    "minecraft:iron_sword": 7,
    "minecraft:diamond_sword": 8,
    "minecraft:netherite_sword": 9,
    "minecraft:wooden_axe": 4,
    "minecraft:golden_axe": 4,
    "minecraft:stone_axe": 5,
    "minecraft:copper_axe": 5,
    "minecraft:iron_axe": 6,
    "minecraft:diamond_axe": 7,
    "minecraft:netherite_axe": 8,
    "minecraft:wooden_spear": 2,
    "minecraft:golden_spear": 2,
    "minecraft:stone_spear": 3,
    "minecraft:copper_spear": 3,
    "minecraft:iron_spear": 4,
    "minecraft:diamond_spear": 5,
    "minecraft:netherite_spear": 6,
    "minecraft:mace": 6,
    "minecraft:trident": 9,
};
export function selectBestWeaponSlot(items, selectedSlot) {
    let best;
    let bestDamage = -1;
    for (const item of items) {
        const baseDamage = BASE_MELEE_DAMAGE[item.typeId];
        if (baseDamage === undefined || exhausted(item))
            continue;
        const damage = baseDamage + Math.floor(Math.max(0, item.sharpnessLevel) * 1.25);
        if (best === undefined
            || damage > bestDamage
            || (damage === bestDamage && item.slot === selectedSlot && best.slot !== selectedSlot)
            || (damage === bestDamage && best.slot !== selectedSlot && item.slot < best.slot)) {
            best = item;
            bestDamage = damage;
        }
    }
    return best?.slot;
}
export function toolKind(typeId) {
    if (typeId === "minecraft:shears")
        return "shears";
    if (typeId.endsWith("_pickaxe"))
        return "pickaxe";
    if (typeId.endsWith("_shovel"))
        return "shovel";
    if (typeId.endsWith("_axe"))
        return "axe";
    if (typeId.endsWith("_hoe"))
        return "hoe";
    return undefined;
}
export function selectReplacementToolSlot(items, kind, selectedSlot) {
    let best;
    for (const item of items) {
        if (item.slot === selectedSlot || toolKind(item.typeId) !== kind || exhausted(item))
            continue;
        if (best === undefined
            || durabilityRank(item) > durabilityRank(best)
            || (durabilityRank(item) === durabilityRank(best) && item.slot < best.slot)) {
            best = item;
        }
    }
    return best?.slot;
}
function exhausted(item) {
    return item.remainingDurability !== null && item.remainingDurability <= 0;
}
function durabilityRank(item) {
    return item.remainingDurability ?? Number.POSITIVE_INFINITY;
}
//# sourceMappingURL=inventorySelection.js.map