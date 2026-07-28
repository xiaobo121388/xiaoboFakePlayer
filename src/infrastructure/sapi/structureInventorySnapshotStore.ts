import {
    BlockComponentTypes,
    EntityComponentTypes,
    EquipmentSlot,
    StructureSaveMode,
    world,
    type BlockInventoryComponent,
    type Container,
    type Dimension,
    type EntityEquippableComponent,
    type EntityInventoryComponent,
    type ItemStack,
    type Player,
    type Vector3,
} from "@minecraft/server";

import { snapshotId } from "../../application/inventoryService.js";
import type { InventorySnapshotStore, WorldStateStore } from "../../application/ports.js";
import { EQUIPMENT_SLOT, TOTAL_SLOT_COUNT, toStructureSlot } from "../../domain/inventory.js";
import type { FakePlayerId, WorkspaceOperation } from "../../domain/model.js";
import { err, ok, type Result } from "../../domain/results.js";
import { SapiFakePlayerRuntime } from "./fakePlayerRuntime.js";

interface WorkspaceContext {
    readonly operation: WorkspaceOperation;
    readonly dimension: Dimension;
}

interface BarrelPair {
    readonly A: Container;
    readonly B: Container;
}

export type InventoryImage = readonly (ItemStack | undefined)[];

const EQUIPMENT_BY_LOGICAL_SLOT: Readonly<Record<number, EquipmentSlot>> = {
    [EQUIPMENT_SLOT.head]: EquipmentSlot.Head,
    [EQUIPMENT_SLOT.chest]: EquipmentSlot.Chest,
    [EQUIPMENT_SLOT.legs]: EquipmentSlot.Legs,
    [EQUIPMENT_SLOT.feet]: EquipmentSlot.Feet,
    [EQUIPMENT_SLOT.offhand]: EquipmentSlot.Offhand,
};

export class StructureInventorySnapshotStore implements InventorySnapshotStore {
    public constructor(
        private readonly stateStore: WorldStateStore,
        private readonly runtime: SapiFakePlayerRuntime,
    ) {}

    public save(fakePlayerId: FakePlayerId, revision: number): Result<string> {
        const player = this.runtime.getHandle(fakePlayerId);
        if (player === undefined) return err("INVALID_STATE", `假人 ${fakePlayerId} 没有在线运行时实例。`);
        const image = readPlayerImage(player);
        if (!image.ok) return image;
        const structureId = snapshotId(fakePlayerId, revision);
        const operationId = `${fakePlayerId}:snapshot:${revision}`;
        return this.withWorkspace(operationId, player.dimension, player.location, (workspace) => {
            const barrels = placeEmptyBarrels(workspace.dimension, workspace.operation.origin);
            if (!barrels.ok) return barrels;
            const placed = this.updateWorkspacePhase(workspace.operation.id, "placed");
            if (!placed.ok) return placed;
            writeBarrelImage(barrels.value, image.value);

            const existing = world.structureManager.get(structureId);
            if (existing !== undefined) world.structureManager.delete(existing);
            world.structureManager.createFromWorld(
                structureId,
                workspace.dimension,
                workspace.operation.origin,
                offset(workspace.operation.origin, 1, 0, 0),
                { includeBlocks: true, includeEntities: false, saveMode: StructureSaveMode.World },
            );

            clearBarrels(barrels.value);
            world.structureManager.place(structureId, workspace.dimension, workspace.operation.origin, {
                includeBlocks: true,
                includeEntities: false,
            });
            const verifiedBarrels = getBarrels(workspace.dimension, workspace.operation.origin);
            if (!verifiedBarrels.ok || !imagesEqual(image.value, readBarrelImage(verifiedBarrels.value))) {
                world.structureManager.delete(structureId);
                return err("CONFLICT", `快照 ${structureId} 回读校验失败。`);
            }
            const snapshotted = this.updateWorkspacePhase(workspace.operation.id, "snapshotted");
            return snapshotted.ok ? ok(structureId) : snapshotted;
        });
    }

    public restore(fakePlayerId: FakePlayerId, structureId: string): Result<void> {
        const player = this.runtime.getHandle(fakePlayerId);
        if (player === undefined) return err("INVALID_STATE", `假人 ${fakePlayerId} 没有在线运行时实例。`);
        if (!this.has(structureId)) return err("NOT_FOUND", `库存快照 ${structureId} 不存在。`);
        return this.withWorkspace(`${fakePlayerId}:restore:${structureId}`, player.dimension, player.location, (workspace) => {
            world.structureManager.place(structureId, workspace.dimension, workspace.operation.origin, {
                includeBlocks: true,
                includeEntities: false,
            });
            const barrels = getBarrels(workspace.dimension, workspace.operation.origin);
            if (!barrels.ok) return barrels;
            const placed = this.updateWorkspacePhase(workspace.operation.id, "placed");
            if (!placed.ok) return placed;
            const snapshot = readBarrelImage(barrels.value);
            const current = readPlayerImage(player);
            if (!current.ok) return current;
            if (!imageIsEmpty(current.value) && !imagesEqual(current.value, snapshot)) {
                return err("CONFLICT", `假人 ${fakePlayerId} 的背包既非空也不等于快照，已隔离恢复。`);
            }
            if (imageIsEmpty(current.value)) {
                const written = writePlayerImage(player, snapshot);
                if (!written.ok) return written;
                const verified = readPlayerImage(player);
                if (!verified.ok || !imagesEqual(verified.value, snapshot)) {
                    return err("CONFLICT", `假人 ${fakePlayerId} 的背包恢复回读失败。`);
                }
            }
            const restored = this.updateWorkspacePhase(workspace.operation.id, "snapshotted");
            return restored.ok ? ok(undefined) : restored;
        });
    }

    public remove(structureId: string): Result<void> {
        const structure = world.structureManager.get(structureId);
        if (structure !== undefined && !world.structureManager.delete(structure)) {
            return err("CONFLICT", `无法删除库存快照 ${structureId}。`);
        }
        return ok(undefined);
    }

    public has(structureId: string): boolean {
        return world.structureManager.get(structureId) !== undefined;
    }

    public saveImage(
        structureId: string,
        dimension: Dimension,
        near: Vector3,
        image: InventoryImage,
    ): Result<void> {
        if (image.length !== TOTAL_SLOT_COUNT) {
            return err("INVALID_STATE", `结构 image 必须包含 ${TOTAL_SLOT_COUNT} 个逻辑槽位。`);
        }
        return this.withWorkspace(`image:save:${structureId}`, dimension, near, (workspace) => {
            const barrels = placeEmptyBarrels(workspace.dimension, workspace.operation.origin);
            if (!barrels.ok) return barrels;
            const placed = this.updateWorkspacePhase(workspace.operation.id, "placed");
            if (!placed.ok) return placed;
            writeBarrelImage(barrels.value, image);

            const existing = world.structureManager.get(structureId);
            if (existing !== undefined) world.structureManager.delete(existing);
            world.structureManager.createFromWorld(
                structureId,
                workspace.dimension,
                workspace.operation.origin,
                offset(workspace.operation.origin, 1, 0, 0),
                { includeBlocks: true, includeEntities: false, saveMode: StructureSaveMode.World },
            );
            clearBarrels(barrels.value);
            world.structureManager.place(structureId, workspace.dimension, workspace.operation.origin, {
                includeBlocks: true,
                includeEntities: false,
            });
            const verified = getBarrels(workspace.dimension, workspace.operation.origin);
            if (!verified.ok || !imagesEqual(image, readBarrelImage(verified.value))) {
                world.structureManager.delete(structureId);
                return err("CONFLICT", `结构 image ${structureId} 回读校验失败。`);
            }
            return this.updateWorkspacePhase(workspace.operation.id, "snapshotted");
        });
    }

    public loadImage(
        structureId: string,
        dimension: Dimension,
        near: Vector3,
    ): Result<InventoryImage> {
        if (!this.has(structureId)) return err("NOT_FOUND", `结构 image ${structureId} 不存在。`);
        return this.withWorkspace(`image:load:${structureId}`, dimension, near, (workspace) => {
            world.structureManager.place(structureId, workspace.dimension, workspace.operation.origin, {
                includeBlocks: true,
                includeEntities: false,
            });
            const barrels = getBarrels(workspace.dimension, workspace.operation.origin);
            if (!barrels.ok) return barrels;
            const placed = this.updateWorkspacePhase(workspace.operation.id, "placed");
            return placed.ok ? ok(readBarrelImage(barrels.value)) : placed;
        });
    }

    public recoverWorkspaces(): Result<void> {
        const loaded = this.stateStore.loadOperations();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        for (const operation of Object.values(loaded.state.value.workspace).sort((left, right) => left.id.localeCompare(right.id))) {
            const recovered = this.restoreWorkspace(operation);
            if (!recovered.ok) return recovered;
        }
        return ok(undefined);
    }

    private withWorkspace<T>(
        operationId: string,
        dimension: Dimension,
        near: Vector3,
        work: (workspace: WorkspaceContext) => Result<T>,
    ): Result<T> {
        const prepared = this.prepareWorkspace(operationId, dimension, near);
        if (!prepared.ok) return prepared;
        let result: Result<T>;
        try {
            result = work(prepared.value);
        } catch (cause) {
            const cleanup = this.restoreWorkspace(prepared.value.operation);
            if (!cleanup.ok) throw new Error(`${operationId}: 操作失败且工作区恢复失败：${cleanup.error.message}`, { cause });
            throw new Error(`${operationId}: 结构库存操作失败。`, { cause });
        }
        const cleanup = this.restoreWorkspace(prepared.value.operation);
        return cleanup.ok ? result : cleanup;
    }

    private prepareWorkspace(operationId: string, dimension: Dimension, near: Vector3): Result<WorkspaceContext> {
        const operations = this.stateStore.loadOperations();
        if (!operations.ok) return err("CONFLICT", operations.diagnostics.join("; "));
        if (Object.keys(operations.state.value.workspace).length !== 0) {
            return err("CONFLICT", "存在未恢复的结构工作区，暂不能执行库存操作。");
        }
        const origin = workspaceOrigin(dimension, near);
        if (dimension.getBlock(origin) === undefined || dimension.getBlock(offset(origin, 1, 0, 0)) === undefined) {
            return err("INVALID_STATE", "假人所在区块的结构工作区未加载。");
        }
        const backupStructureId = `xiaobo:workspace_${safeId(operationId)}`;
        const existing = world.structureManager.get(backupStructureId);
        if (existing !== undefined) world.structureManager.delete(existing);
        world.structureManager.createFromWorld(
            backupStructureId,
            dimension,
            origin,
            offset(origin, 1, 0, 0),
            { includeBlocks: true, includeEntities: false, saveMode: StructureSaveMode.World },
        );
        const operation: WorkspaceOperation = {
            id: operationId,
            phase: "prepared",
            dimension: dimension.id,
            origin,
            backupStructureId,
        };
        const committed = this.stateStore.commitOperations(operations.state.revision, {
            ...operations.state.value,
            workspace: { ...operations.state.value.workspace, [operation.id]: operation },
        });
        if (!committed.ok) {
            world.structureManager.delete(backupStructureId);
            return committed;
        }
        return ok({ operation, dimension });
    }

    private updateWorkspacePhase(id: string, phase: WorkspaceOperation["phase"]): Result<void> {
        const loaded = this.stateStore.loadOperations();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        const operation = loaded.state.value.workspace[id];
        if (operation === undefined) return err("NOT_FOUND", `未找到结构工作区 ${id}。`);
        const committed = this.stateStore.commitOperations(loaded.state.revision, {
            ...loaded.state.value,
            workspace: {
                ...loaded.state.value.workspace,
                [id]: { ...operation, phase },
            },
        });
        return committed.ok ? ok(undefined) : committed;
    }

    private restoreWorkspace(operation: WorkspaceOperation): Result<void> {
        const backup = world.structureManager.get(operation.backupStructureId);
        if (backup === undefined && operation.phase !== "restored") {
            return err("NOT_FOUND", `工作区 ${operation.id} 的原方块备份不存在。`);
        }
        if (backup !== undefined) {
            const dimension = world.getDimension(operation.dimension);
            clearBarrelsIfPresent(dimension, operation.origin);
            world.structureManager.place(backup, dimension, operation.origin, {
                includeBlocks: true,
                includeEntities: false,
            });
            const marked = this.updateWorkspacePhase(operation.id, "restored");
            if (!marked.ok) return marked;
            world.structureManager.delete(backup);
        }
        const loaded = this.stateStore.loadOperations();
        if (!loaded.ok) return err("CONFLICT", loaded.diagnostics.join("; "));
        if (loaded.state.value.workspace[operation.id] === undefined) return ok(undefined);
        const workspace = { ...loaded.state.value.workspace };
        delete workspace[operation.id];
        const committed = this.stateStore.commitOperations(loaded.state.revision, {
            ...loaded.state.value,
            workspace,
        });
        return committed.ok ? ok(undefined) : committed;
    }
}

export function readPlayerImage(
    player: Player,
): Result<InventoryImage> {
    const inventory = player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
    const equipment = player.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
    if (inventory === undefined || equipment === undefined) {
        return err("INVALID_STATE", `假人 ${player.name} 缺少库存或装备组件。`);
    }
    const image: (ItemStack | undefined)[] = [];
    for (let slot = 0; slot < TOTAL_SLOT_COUNT; slot += 1) {
        image.push(slot < 36
            ? inventory.container.getItem(slot)
            : equipment.getEquipment(equipmentSlotFor(slot)));
    }
    return ok(image);
}

export function writePlayerImage(
    player: Player,
    image: InventoryImage,
): Result<void> {
    const inventory = player.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
    const equipment = player.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
    if (inventory === undefined || equipment === undefined) {
        return err("INVALID_STATE", `假人 ${player.name} 缺少库存或装备组件。`);
    }
    for (let slot = 0; slot < TOTAL_SLOT_COUNT; slot += 1) {
        if (slot < 36) inventory.container.setItem(slot, image[slot]);
        else equipment.setEquipment(equipmentSlotFor(slot), image[slot]);
    }
    return ok(undefined);
}

function placeEmptyBarrels(dimension: Dimension, origin: Vector3): Result<BarrelPair> {
    dimension.getBlock(origin)?.setType("minecraft:barrel");
    dimension.getBlock(offset(origin, 1, 0, 0))?.setType("minecraft:barrel");
    const barrels = getBarrels(dimension, origin);
    if (barrels.ok) clearBarrels(barrels.value);
    return barrels;
}

function getBarrels(dimension: Dimension, origin: Vector3): Result<BarrelPair> {
    const first = dimension.getBlock(origin);
    const second = dimension.getBlock(offset(origin, 1, 0, 0));
    const firstInventory = first?.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined;
    const secondInventory = second?.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined;
    if (first?.typeId !== "minecraft:barrel"
        || second?.typeId !== "minecraft:barrel"
        || firstInventory?.container === undefined
        || secondInventory?.container === undefined) {
        return err("INVALID_STATE", "无法创建两木桶结构工作区。");
    }
    return ok({ A: firstInventory.container, B: secondInventory.container });
}

function readBarrelImage(barrels: BarrelPair): readonly (ItemStack | undefined)[] {
    const image: (ItemStack | undefined)[] = [];
    for (let logicalSlot = 0; logicalSlot < TOTAL_SLOT_COUNT; logicalSlot += 1) {
        const mapped = toStructureSlot(logicalSlot);
        if (!mapped.ok) throw new RangeError(mapped.error.message);
        image.push(barrels[mapped.value.barrel].getItem(mapped.value.slot));
    }
    return image;
}

function writeBarrelImage(barrels: BarrelPair, image: readonly (ItemStack | undefined)[]): void {
    for (let logicalSlot = 0; logicalSlot < TOTAL_SLOT_COUNT; logicalSlot += 1) {
        const mapped = toStructureSlot(logicalSlot);
        if (!mapped.ok) throw new RangeError(mapped.error.message);
        barrels[mapped.value.barrel].setItem(mapped.value.slot, image[logicalSlot]);
    }
}

function clearBarrels(barrels: BarrelPair): void {
    barrels.A.clearAll();
    barrels.B.clearAll();
}

function clearBarrelsIfPresent(dimension: Dimension, origin: Vector3): void {
    for (const location of [origin, offset(origin, 1, 0, 0)]) {
        const block = dimension.getBlock(location);
        if (block?.typeId !== "minecraft:barrel") continue;
        const inventory = block.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined;
        inventory?.container?.clearAll();
    }
}

function imageIsEmpty(image: readonly (ItemStack | undefined)[]): boolean {
    return image.every((item) => item === undefined);
}

export function imagesEqual(left: InventoryImage, right: InventoryImage): boolean {
    return left.length === right.length && left.every((item, index) => itemStacksEqual(item, right[index]));
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
const OBSERVABLE_ITEM_COMPONENTS = new Set([
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
    const componentIds = itemStack.getComponents().map((component) => component.typeId).sort();
    if (componentIds.some((componentId) => !OBSERVABLE_ITEM_COMPONENTS.has(componentId))) return undefined;

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

function equipmentSlotFor(logicalSlot: number): EquipmentSlot {
    const equipmentSlot = EQUIPMENT_BY_LOGICAL_SLOT[logicalSlot];
    if (equipmentSlot === undefined) throw new RangeError(`无效装备逻辑槽位：${logicalSlot}。`);
    return equipmentSlot;
}

function workspaceOrigin(dimension: Dimension, near: Vector3): Vector3 {
    const chunkX = Math.floor(Math.floor(near.x) / 16) * 16;
    const chunkZ = Math.floor(Math.floor(near.z) / 16) * 16;
    return { x: chunkX + 7, y: dimension.heightRange.max - 1, z: chunkZ + 7 };
}

function offset(origin: Vector3, x: number, y: number, z: number): Vector3 {
    return { x: origin.x + x, y: origin.y + y, z: origin.z + z };
}

function safeId(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}