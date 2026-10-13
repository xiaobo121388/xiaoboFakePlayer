import assert from "node:assert/strict";
import test from "node:test";

import type { ItemStack } from "@minecraft/server";

import { describeInventoryDifference, imagesEqual, itemStacksEqual } from "../src/infrastructure/sapi/itemStackComparison.js";

interface TestItem {
    readonly typeId?: string;
    readonly amount?: number;
    readonly isStackable?: boolean;
    readonly nameTag?: string;
    readonly components?: Readonly<Record<string, object>>;
    readonly dynamicProperties?: Readonly<Record<string, unknown>>;
    readonly stackableWith?: boolean;
    readonly lore?: readonly unknown[];
}

function item(options: TestItem = {}): ItemStack {
    const components = options.components ?? {};
    const properties = options.dynamicProperties ?? {};
    return {
        typeId: options.typeId ?? "minecraft:diamond_pickaxe",
        amount: options.amount ?? 1,
        isStackable: options.isStackable ?? false,
        keepOnDeath: false,
        lockMode: "none",
        nameTag: options.nameTag,
        getComponents: () => Object.keys(components).map((typeId) => ({ typeId })),
        getComponent: (typeId: string) => components[typeId],
        getDynamicPropertyIds: () => Object.keys(properties),
        getDynamicProperty: (key: string) => properties[key],
        getCanDestroy: () => [],
        getCanPlaceOn: () => [],
        getRawLore: () => options.lore ?? [],
        getTags: () => [],
        isStackableWith: () => options.stackableWith ?? true,
    } as unknown as ItemStack;
}

test("inventory comparison preserves slots, amounts, item types, and native stacking checks", () => {
    assert.equal(itemStacksEqual(undefined, undefined), true);
    assert.equal(itemStacksEqual(item(), undefined), false);
    assert.equal(itemStacksEqual(item(), item({ amount: 2 })), false);
    assert.equal(itemStacksEqual(item(), item({ typeId: "minecraft:iron_pickaxe" })), false);
    assert.equal(imagesEqual([item(), undefined], [item(), undefined]), true);
    assert.equal(imagesEqual([item()], [item(), undefined]), false);
    assert.equal(itemStacksEqual(
        item({ isStackable: true, stackableWith: false }),
        item({ isStackable: true }),
    ), false);
});

test("nonstackable items compare durability, enchantments, names, lore, and dynamic properties", () => {
    const durability = { damage: 8, maxDurability: 1561, unbreakable: false };
    const components = { "minecraft:durability": durability };
    assert.equal(itemStacksEqual(item({ components }), item({ components })), true);
    assert.equal(itemStacksEqual(item({ components }), item({ components: {
        "minecraft:durability": { ...durability, damage: 9 },
    } })), false);
    assert.equal(itemStacksEqual(item(), item({ nameTag: "changed" })), false);
    assert.equal(itemStacksEqual(item(), item({ lore: [{ text: "changed" }] })), false);
    assert.equal(itemStacksEqual(item(), item({ dynamicProperties: { state: "changed" } })), false);
    const enchantable = (level: number) => ({ getEnchantments: () => [{ type: { id: "minecraft:sharpness" }, level }] });
    assert.equal(itemStacksEqual(
        item({ components: { "minecraft:enchantable": enchantable(2) } }),
        item({ components: { "minecraft:enchantable": enchantable(3) } }),
    ), false);
});

test("unknown item components remain fail-closed and diagnostics identify the first failing slot", () => {
    const unknown = item({ components: { "test:opaque": {} } });
    assert.equal(itemStacksEqual(unknown, unknown), false);
    assert.match(describeInventoryDifference([undefined, unknown], [undefined, unknown]), /slot=1.*test:opaque.*unobservable/);
    assert.match(describeInventoryDifference([item()], [item({ nameTag: "private-name" })]), /slot=0.*differing=nameTag/);
    assert.doesNotMatch(describeInventoryDifference([item()], [item({ nameTag: "private-name" })]), /private-name/);
    assert.equal(describeInventoryDifference([item()], [item()]), "");
});

test("26.52 empty block-actor properties on old weapons do not falsely block inventory recovery", () => {
    const durability = { damage: 24, maxDurability: 2031, unbreakable: false };
    const properties = { totalByteCount: () => 0 };
    const legacy = item({
        typeId: "minecraft:netherite_sword",
        components: { "minecraft:durability": durability },
    });
    const upgraded = item({
        typeId: "minecraft:netherite_sword",
        components: {
            "minecraft:durability": durability,
            "minecraft:block_actor_dynamic_properties": properties,
        },
    });
    assert.equal(itemStacksEqual(upgraded, upgraded), true);
    assert.equal(itemStacksEqual(legacy, upgraded), true);
    assert.equal(itemStacksEqual(upgraded, legacy), true);
    assert.equal(imagesEqual([upgraded], [upgraded]), true);
    assert.equal(describeInventoryDifference([upgraded], [upgraded]), "");
    assert.equal(itemStacksEqual(upgraded, item({
        typeId: "minecraft:netherite_sword",
        components: {
            "minecraft:durability": { ...durability, damage: 25 },
            "minecraft:block_actor_dynamic_properties": properties,
        },
    })), false);
});

test("nonempty, unreadable, or invalid block-actor properties never become equal by ignoring the component", () => {
    for (const totalByteCount of [1, 1024, -1, Number.NaN]) {
        const opaque = item({ components: {
            "minecraft:block_actor_dynamic_properties": { totalByteCount: () => totalByteCount },
        } });
        assert.equal(itemStacksEqual(opaque, opaque), false);
    }
    const unreadable = item({ components: {
        "minecraft:block_actor_dynamic_properties": { totalByteCount: () => { throw new Error("engine failure"); } },
    } });
    assert.throws(() => itemStacksEqual(unreadable, unreadable), /engine failure/);
});
