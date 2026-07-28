import { world } from "@minecraft/server";
import { TOTAL_SLOT_COUNT } from "../../domain/inventory.js";
import { err, ok } from "../../domain/results.js";
import { imagesEqual, itemStacksEqual, readPlayerImage, writePlayerImage, } from "./structureInventorySnapshotStore.js";
const PLAYER_INVENTORY_SLOT_COUNT = 36;
const MAX_EXPERIENCE_CHANGE = 16_777_216;
export class SapiInventoryAccess {
    snapshots;
    constructor(snapshots) {
        this.snapshots = snapshots;
    }
    readSnapshotOverview(structureId, playerId) {
        const player = this.findPlayer(playerId);
        if (!player.ok)
            return player;
        const image = this.snapshots.loadImage(structureId, player.value.dimension, player.value.location);
        return image.ok
            ? ok(image.value.map((item, slot) => ({
                slot,
                item: item === undefined ? null : itemOverview(item),
            })))
            : image;
    }
    prepareTransfer(transfer) {
        const player = this.findPlayer(transfer.playerId);
        if (!player.ok)
            return player;
        const fakeBefore = this.snapshots.loadImage(transfer.fakeSnapshotId, player.value.dimension, player.value.location);
        if (!fakeBefore.ok)
            return fakeBefore;
        const playerBefore = readPlayerImage(player.value);
        if (!playerBefore.ok)
            return playerBefore;
        const after = buildAfterImages(fakeBefore.value, playerBefore.value, transfer);
        if (!after.ok)
            return after;
        const savedPlayerBefore = this.snapshots.saveImage(transfer.beforeStructureId, player.value.dimension, player.value.location, playerBefore.value);
        if (!savedPlayerBefore.ok)
            return savedPlayerBefore;
        const savedFakeAfter = this.snapshots.saveImage(transfer.fakeAfterSnapshotId, player.value.dimension, player.value.location, after.value.fake);
        if (!savedFakeAfter.ok)
            return this.cleanupPrepareFailure(transfer, savedFakeAfter);
        const savedPlayerAfter = this.snapshots.saveImage(transfer.afterStructureId, player.value.dimension, player.value.location, after.value.player);
        return savedPlayerAfter.ok ? ok(undefined) : this.cleanupPrepareFailure(transfer, savedPlayerAfter);
    }
    compareWithImages(transfer) {
        const context = this.loadPlayerImages(transfer);
        if (!context.ok)
            return context;
        const current = readPlayerImage(context.value.player);
        return current.ok
            ? ok(classifyImage(current.value, context.value.before, context.value.after))
            : current;
    }
    applyBeforeImage(transfer) {
        return this.applyImage(transfer, "before");
    }
    applyAfterImage(transfer) {
        return this.applyImage(transfer, "after");
    }
    removeTransferImages(transfer) {
        const before = this.snapshots.remove(transfer.beforeStructureId);
        if (!before.ok)
            return before;
        return this.snapshots.remove(transfer.afterStructureId);
    }
    getPlayerExperience(playerId) {
        const player = this.findPlayer(playerId);
        return player.ok ? ok(player.value.getTotalXp()) : player;
    }
    setPlayerExperience(playerId, totalExperience) {
        if (!Number.isSafeInteger(totalExperience) || totalExperience < 0) {
            return err("INVALID_STATE", "玩家总经验必须是非负安全整数。");
        }
        const player = this.findPlayer(playerId);
        if (!player.ok)
            return player;
        player.value.resetLevel();
        let remaining = totalExperience;
        while (remaining > 0) {
            const amount = Math.min(remaining, MAX_EXPERIENCE_CHANGE);
            player.value.addExperience(amount);
            remaining -= amount;
        }
        return player.value.getTotalXp() === totalExperience
            ? ok(undefined)
            : err("CONFLICT", `玩家 ${playerId} 的经验回读校验失败。`);
    }
    compareExperience(transfer) {
        const current = this.getPlayerExperience(transfer.playerId);
        if (!current.ok)
            return current;
        const after = transfer.playerBefore + transfer.amount;
        if (current.value === transfer.playerBefore)
            return ok("before");
        if (current.value === after)
            return ok("after");
        return ok("conflict");
    }
    applyImage(transfer, target) {
        const context = this.loadPlayerImages(transfer);
        if (!context.ok)
            return context;
        const current = readPlayerImage(context.value.player);
        if (!current.ok)
            return current;
        const state = classifyImage(current.value, context.value.before, context.value.after);
        if (state === target)
            return ok(undefined);
        const expectedSource = target === "after" ? "before" : "after";
        if (state !== expectedSource) {
            return err("CONFLICT", `库存事务 ${transfer.id} 当前为 ${state}，禁止覆盖外部改动。`);
        }
        const image = target === "after" ? context.value.after : context.value.before;
        const written = writePlayerImage(context.value.player, image);
        if (!written.ok)
            return written;
        const verified = readPlayerImage(context.value.player);
        return verified.ok && imagesEqual(verified.value, image)
            ? ok(undefined)
            : err("CONFLICT", `库存事务 ${transfer.id} 写入 ${target} image 后回读失败。`);
    }
    loadPlayerImages(transfer) {
        const player = this.findPlayer(transfer.playerId);
        if (!player.ok)
            return player;
        const before = this.snapshots.loadImage(transfer.beforeStructureId, player.value.dimension, player.value.location);
        if (!before.ok)
            return before;
        const after = this.snapshots.loadImage(transfer.afterStructureId, player.value.dimension, player.value.location);
        return after.ok ? ok({ player: player.value, before: before.value, after: after.value }) : after;
    }
    cleanupPrepareFailure(transfer, failure) {
        if (failure.ok)
            return ok(undefined);
        const ids = [transfer.beforeStructureId, transfer.afterStructureId, transfer.fakeAfterSnapshotId];
        for (const id of ids) {
            const removed = this.snapshots.remove(id);
            if (!removed.ok) {
                return err("CONFLICT", `${failure.error.message}；且无法清理 ${id}：${removed.error.message}`);
            }
        }
        return failure;
    }
    findPlayer(playerId) {
        const player = world.getAllPlayers().find((candidate) => candidate.playfabId === playerId);
        return player === undefined
            ? err("INVALID_STATE", `玩家 ${playerId} 当前不在线。`)
            : ok(player);
    }
}
function itemOverview(item) {
    const durability = item.getComponent("minecraft:durability");
    const enchantments = item.getComponent("minecraft:enchantable")?.getEnchantments()
        .map((enchantment) => ({
        typeId: enchantment.type.id,
        level: enchantment.level,
    }))
        .sort((left, right) => left.typeId.localeCompare(right.typeId) || left.level - right.level) ?? [];
    return {
        typeId: item.typeId,
        amount: item.amount,
        nameTag: item.nameTag ?? null,
        lore: item.getLore(),
        durability: durability === undefined ? null : {
            damage: durability.damage,
            maxDurability: durability.maxDurability,
            unbreakable: durability.unbreakable,
        },
        enchantments,
    };
}
function buildAfterImages(fakeBefore, playerBefore, transfer) {
    const fake = cloneImage(fakeBefore);
    const player = cloneImage(playerBefore);
    const request = transfer.request;
    switch (request.kind) {
        case "recycle_all":
            for (let slot = 0; slot < fake.length; slot += 1) {
                const item = fake[slot];
                if (item === undefined)
                    continue;
                const inserted = insertWholeStack(player, item);
                if (!inserted.ok)
                    return inserted;
                fake[slot] = undefined;
            }
            break;
        case "swap":
            [fake[request.fakeSlot], player[request.playerSlot]] = [
                player[request.playerSlot],
                fake[request.fakeSlot],
            ];
            break;
        case "take": {
            const moved = moveWholeStack(fake, request.fakeSlot, player, request.playerSlot);
            if (!moved.ok)
                return moved;
            break;
        }
        case "put": {
            const moved = moveWholeStack(player, request.playerSlot, fake, request.fakeSlot);
            if (!moved.ok)
                return moved;
            break;
        }
        case "swap_fake":
            [fake[request.firstSlot], fake[request.secondSlot]] = [
                fake[request.secondSlot],
                fake[request.firstSlot],
            ];
            break;
    }
    return ok({ fake, player });
}
function cloneImage(image) {
    if (image.length !== TOTAL_SLOT_COUNT)
        throw new RangeError(`库存 image 必须包含 ${TOTAL_SLOT_COUNT} 个槽位。`);
    return image.map((item) => item?.clone());
}
function insertWholeStack(target, source) {
    let remainingAmount = source.amount;
    for (let slot = 0; slot < PLAYER_INVENTORY_SLOT_COUNT && remainingAmount > 0; slot += 1) {
        const existing = target[slot];
        if (existing === undefined || !existing.isStackableWith(source) || existing.amount >= existing.maxAmount) {
            continue;
        }
        const moved = Math.min(remainingAmount, existing.maxAmount - existing.amount);
        const next = existing.clone();
        next.amount += moved;
        target[slot] = next;
        remainingAmount -= moved;
    }
    while (remainingAmount > 0) {
        const emptySlot = target.slice(0, PLAYER_INVENTORY_SLOT_COUNT).findIndex((item) => item === undefined);
        if (emptySlot < 0)
            return err("DATA_CAPACITY", "玩家背包没有足够空间接收全部物品。");
        const moved = Math.min(remainingAmount, source.maxAmount);
        const next = source.clone();
        next.amount = moved;
        target[emptySlot] = next;
        remainingAmount -= moved;
    }
    return ok(undefined);
}
function moveWholeStack(source, sourceSlot, target, targetSlot) {
    const item = source[sourceSlot];
    if (item === undefined)
        return ok(undefined);
    const existing = target[targetSlot];
    if (existing === undefined) {
        target[targetSlot] = item;
        source[sourceSlot] = undefined;
        return ok(undefined);
    }
    if (!existing.isStackableWith(item) || existing.amount + item.amount > existing.maxAmount) {
        return err("DATA_CAPACITY", "目标槽位无法完整接收该物品堆。");
    }
    const merged = existing.clone();
    merged.amount += item.amount;
    target[targetSlot] = merged;
    source[sourceSlot] = undefined;
    return ok(undefined);
}
function classifyImage(current, before, after) {
    let hasBeforeOnly = false;
    let hasAfterOnly = false;
    for (let slot = 0; slot < TOTAL_SLOT_COUNT; slot += 1) {
        const matchesBefore = itemStacksEqual(current[slot], before[slot]);
        const matchesAfter = itemStacksEqual(current[slot], after[slot]);
        if (!matchesBefore && !matchesAfter)
            return "conflict";
        if (matchesBefore && !matchesAfter)
            hasBeforeOnly = true;
        if (matchesAfter && !matchesBefore)
            hasAfterOnly = true;
    }
    if (hasBeforeOnly && hasAfterOnly)
        return "mixed";
    return hasAfterOnly || !hasBeforeOnly ? "after" : "before";
}
