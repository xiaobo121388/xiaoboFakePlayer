import assert from "node:assert/strict";
import test from "node:test";

import {
    selectBestWeaponSlot,
    selectReplacementToolSlot,
    toolKind,
    type SelectableInventoryItem,
} from "../src/domain/inventorySelection.js";

function item(
    slot: number,
    typeId: string,
    remainingDurability: number | null = 100,
    sharpnessLevel = 0,
): SelectableInventoryItem {
    return { slot, typeId, remainingDurability, sharpnessLevel };
}

test("best weapon selection scans all inventory slots and includes sharpness damage", () => {
    assert.equal(selectBestWeaponSlot([
        item(0, "minecraft:diamond_sword", 100, 0),
        item(17, "minecraft:netherite_axe", 100, 2),
        item(35, "minecraft:trident"),
        item(8, "minecraft:netherite_sword", 0, 5),
        item(6, "minecraft:diamond_pickaxe"),
    ], 0), 17);
});

test("best weapon selection keeps the selected slot on a tie and otherwise uses the lowest slot", () => {
    const weapons = [
        item(12, "minecraft:trident"),
        item(3, "minecraft:netherite_sword"),
    ];
    assert.equal(selectBestWeaponSlot(weapons, 12), 12);
    assert.equal(selectBestWeaponSlot(weapons, 5), 3);
    assert.equal(selectBestWeaponSlot([item(0, "minecraft:diamond_pickaxe")], 0), undefined);
});

test("Bedrock sharpness damage is rounded down before comparing weapons", () => {
    assert.equal(selectBestWeaponSlot([
        item(4, "minecraft:trident"),
        item(20, "minecraft:diamond_sword", 100, 1),
    ], 4), 4);
});

test("tool replacement only selects a usable tool of the remembered kind", () => {
    assert.equal(toolKind("minecraft:copper_pickaxe"), "pickaxe");
    assert.equal(toolKind("minecraft:shears"), "shears");
    assert.equal(toolKind("minecraft:diamond_sword"), undefined);
    assert.equal(selectReplacementToolSlot([
        item(0, "minecraft:iron_pickaxe", 0),
        item(4, "minecraft:netherite_shovel", 1000),
        item(23, "minecraft:stone_pickaxe", 20),
        item(31, "minecraft:diamond_pickaxe", 800),
        item(35, "minecraft:netherite_pickaxe", 800),
    ], "pickaxe", 0), 31);
});