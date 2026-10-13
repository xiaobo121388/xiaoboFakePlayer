import type { ItemStack } from "@minecraft/server";

export type InventoryImage = readonly (ItemStack | undefined)[];

export function imagesEqual(left: InventoryImage, right: InventoryImage): boolean {
    return left.length === right.length && left.every((item, index) => itemStacksEqual(item, right[index]));
}

export function describeInventoryDifference(expected: InventoryImage, actual: InventoryImage): string {
    if (expected.length !== actual.length) return `image length ${expected.length} != ${actual.length}`;
    const slot = expected.findIndex((item, index) => !itemStacksEqual(item, actual[index]));
    if (slot < 0) return "";
    const before = expected[slot];
    const after = actual[slot];
    const describe = (item: ItemStack | undefined): string => item === undefined
        ? "empty"
        : `${item.typeId}x${item.amount} components=[`
            + item.getComponents().map((component) => component.typeId).sort().join(",") + "]";
    const beforeFingerprint = before === undefined ? undefined : itemStackFingerprint(before, 0);
    const afterFingerprint = after === undefined ? undefined : itemStackFingerprint(after, 0);
    let fields = "unobservable component or nested item";
    if (beforeFingerprint !== undefined && afterFingerprint !== undefined) {
        const left = JSON.parse(beforeFingerprint) as Record<string, unknown>;
        const right = JSON.parse(afterFingerprint) as Record<string, unknown>;
        fields = Object.keys(left)
            .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
            .join(",") || "native stacking comparison";
    }
    return ` slot=${slot}; expected=${describe(before)}; actual=${describe(after)}; differing=${fields}`;
}

export function itemStacksEqual(left: ItemStack | undefined, right: ItemStack | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.amount !== right.amount || left.typeId !== right.typeId) return false;
    if (left.isStackable && right.isStackable) return left.isStackableWith(right);

    const leftFingerprint = itemStackFingerprint(left, 0);
    const rightFingerprint = itemStackFingerprint(right, 0);
    return leftFingerprint !== undefined && leftFingerprint === rightFingerprint;
}

const MAX_NESTED_CONTAINER_DEPTH = 8;
const BLOCK_DYNAMIC_PROPERTIES_COMPONENT = "minecraft:block_actor_dynamic_properties";
const OBSERVABLE_ITEM_COMPONENTS = new Set([
    BLOCK_DYNAMIC_PROPERTIES_COMPONENT,
    "minecraft:book",
    "minecraft:compostable",
    "minecraft:cooldown",
    "minecraft:durability",
    "minecraft:dyeable",
    "minecraft:enchantable",
    "minecraft:food",
    "minecraft:inventory",
    "minecraft:potion",
]);

function itemStackFingerprint(itemStack: ItemStack, depth: number): string | undefined {
    const declaredComponentIds = itemStack.getComponents().map((component) => component.typeId).sort();
    if (declaredComponentIds.some((componentId) => !OBSERVABLE_ITEM_COMPONENTS.has(componentId))) return undefined;
    const blockProperties = itemStack.getComponent(BLOCK_DYNAMIC_PROPERTIES_COMPONENT);
    if (declaredComponentIds.includes(BLOCK_DYNAMIC_PROPERTIES_COMPONENT) && blockProperties === undefined) {
        return undefined;
    }
    // 26.52 exposes this component even on swords; nonempty data cannot be enumerated publicly.
    if (blockProperties !== undefined && blockProperties.totalByteCount() !== 0) return undefined;
    const componentIds = declaredComponentIds.filter(
        (componentId) => componentId !== BLOCK_DYNAMIC_PROPERTIES_COMPONENT,
    );

    const inventory = itemStack.getComponent("minecraft:inventory");
    if (inventory !== undefined && depth >= MAX_NESTED_CONTAINER_DEPTH) return undefined;
    const nestedItems: (string | null)[] = [];
    if (inventory !== undefined) {
        for (let slot = 0; slot < inventory.container.size; slot += 1) {
            const nestedItem = inventory.container.getItem(slot);
            if (nestedItem === undefined) {
                nestedItems.push(null);
                continue;
            }
            const fingerprint = itemStackFingerprint(nestedItem, depth + 1);
            if (fingerprint === undefined) return undefined;
            nestedItems.push(fingerprint);
        }
    }

    const book = itemStack.getComponent("minecraft:book");
    const durability = itemStack.getComponent("minecraft:durability");
    const dyeable = itemStack.getComponent("minecraft:dyeable");
    const enchantable = itemStack.getComponent("minecraft:enchantable");
    const potion = itemStack.getComponent("minecraft:potion");
    const dynamicProperties = itemStack.getDynamicPropertyIds().sort().map((propertyId) => [
        propertyId,
        itemStack.getDynamicProperty(propertyId),
    ]);
    const enchantments = enchantable?.getEnchantments().map((enchantment) => [
        enchantment.type.id,
        enchantment.level,
    ] as const).sort(([leftId, leftLevel], [rightId, rightLevel]) => (
        leftId === rightId ? leftLevel - rightLevel : leftId.localeCompare(rightId)
    )) ?? [];

    return JSON.stringify(canonicalizeItemValue({
        amount: itemStack.amount,
        book: book === undefined ? null : {
            author: book.author ?? null,
            contents: book.contents,
            isSigned: book.isSigned,
            rawContents: book.rawContents,
            title: book.title ?? null,
        },
        canDestroy: itemStack.getCanDestroy(),
        canPlaceOn: itemStack.getCanPlaceOn(),
        componentIds,
        durability: durability === undefined ? null : {
            damage: durability.damage,
            maxDurability: durability.maxDurability,
            unbreakable: durability.unbreakable,
        },
        dyeable: dyeable === undefined ? null : {
            color: dyeable.color ?? null,
            defaultColor: dyeable.defaultColor ?? null,
        },
        dynamicProperties,
        enchantments,
        inventory: inventory === undefined ? null : nestedItems,
        isStackable: itemStack.isStackable,
        keepOnDeath: itemStack.keepOnDeath,
        lockMode: itemStack.lockMode,
        nameTag: itemStack.nameTag ?? null,
        potion: potion === undefined ? null : {
            deliveryType: potion.potionDeliveryType,
            effectType: potion.potionEffectType,
        },
        rawLore: itemStack.getRawLore(),
        tags: itemStack.getTags().sort(),
        typeId: itemStack.typeId,
    }));
}

function canonicalizeItemValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeItemValue);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, canonicalizeItemValue(nestedValue)]));
}
