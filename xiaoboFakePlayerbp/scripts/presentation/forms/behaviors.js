import { world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { actorIdentity, isRealPlayer } from "../playerContext.js";
import { behaviorChangeMessage } from "./behaviorChangeMessage.js";
import { formBoundary, ready, sendError, t } from "./formSupport.js";
const MINE_DIRECTIONS = ["front", "down", "up"];
const PLACE_MODES = ["front", "position"];
export async function openBehaviorForm(player, services, record, openDetail) {
    await formBoundary(player, `behavior:${record.id}`, async () => {
        if (!ready(player, services))
            return;
        const actions = [];
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.behavior.title"))
            .body({ translate: "xiaobo.fp.form.behavior.body", with: [record.name] });
        addBehaviorButton(form, actions, "follow", record.behavior.follow.enabled, () => openFollowForm(player, services, record, openDetail));
        addBehaviorButton(form, actions, "attack", record.behavior.attack.enabled, () => openAttackForm(player, services, record, openDetail));
        addBehaviorButton(form, actions, "mine", record.behavior.mine.enabled, () => openMineForm(player, services, record, openDetail));
        addBehaviorButton(form, actions, "place", record.behavior.place.enabled, () => openPlaceForm(player, services, record, openDetail));
        addBehaviorButton(form, actions, "use", record.behavior.use.enabled, () => openUseForm(player, services, record, openDetail));
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openDetail(record));
        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid)
            await action();
    });
}
async function openFollowForm(player, services, record, openDetail) {
    const targets = followTargets(record);
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.follow"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: record.behavior.follow.enabled })
        .dropdown(t("xiaobo.fp.form.behavior.follow.target"), targets.map((target) => target.label), {
        defaultValueIndex: Math.max(0, targets.findIndex((target) => target.playerId === record.behavior.follow.targetPlayerId)),
    })
        .textField(t("xiaobo.fp.form.behavior.interval"), "10", {
        defaultValue: String(record.behavior.follow.intervalTicks),
    })
        .slider(t("xiaobo.fp.form.behavior.follow.speed"), 0, 1, {
        defaultValue: record.behavior.follow.speed,
        valueStep: 0.05,
    })
        .slider(t("xiaobo.fp.form.behavior.follow.distance"), 0, 32, {
        defaultValue: record.behavior.follow.stopDistance,
        valueStep: 0.5,
    })
        .submitButton(t("xiaobo.fp.form.behavior.save"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const [enabled, targetIndex, intervalTicks, speed, stopDistance] = response.formValues;
    const target = typeof targetIndex === "number" ? targets[targetIndex] : undefined;
    if (typeof enabled !== "boolean" || target === undefined || typeof speed !== "number"
        || typeof stopDistance !== "number")
        return sendError(player, "跟随行为表单数据无效。");
    await saveBehavior(player, services, record, {
        ...record.behavior,
        follow: {
            enabled,
            targetPlayerId: target.playerId,
            lastKnownName: target.name,
            intervalTicks: Number(intervalTicks),
            speed,
            stopDistance,
        },
    }, openDetail);
}
async function openAttackForm(player, services, record, openDetail) {
    const config = record.behavior.attack;
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.attack"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "10", { defaultValue: String(config.intervalTicks) })
        .slider(t("xiaobo.fp.form.behavior.attack.distance"), 1, 32, {
        defaultValue: config.maxDistance,
        valueStep: 0.5,
    })
        .textField(t("xiaobo.fp.form.behavior.attack.families"), "monster, animal", {
        defaultValue: config.targetFamilies.join(", "),
    })
        .textField(t("xiaobo.fp.form.behavior.attack.types"), "minecraft:zombie", {
        defaultValue: config.targetTypeIds.join(", "),
    })
        .toggle(t("xiaobo.fp.form.behavior.attack.chase"), { defaultValue: config.chase })
        .submitButton(t("xiaobo.fp.form.behavior.save"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const [enabled, intervalTicks, maxDistance, families, typeIds, chase] = response.formValues;
    if (typeof enabled !== "boolean" || typeof maxDistance !== "number" || typeof families !== "string"
        || typeof typeIds !== "string" || typeof chase !== "boolean") {
        return sendError(player, "攻击行为表单数据无效。");
    }
    await saveBehavior(player, services, record, {
        ...record.behavior,
        attack: {
            enabled,
            intervalTicks: Number(intervalTicks),
            maxDistance,
            targetFamilies: parseIdList(families),
            targetTypeIds: parseIdList(typeIds),
            chase,
        },
    }, openDetail);
}
async function openMineForm(player, services, record, openDetail) {
    const config = record.behavior.mine;
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.mine"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "10", { defaultValue: String(config.intervalTicks) })
        .dropdown(t("xiaobo.fp.form.behavior.mine.direction"), MINE_DIRECTIONS.map((direction) => t(`xiaobo.fp.form.behavior.mine.${direction}`)), { defaultValueIndex: Math.max(0, MINE_DIRECTIONS.indexOf(config.direction)) })
        .textField(t("xiaobo.fp.form.behavior.mine.block"), "minecraft:stone", {
        defaultValue: config.blockTypeId ?? "",
    })
        .slider(t("xiaobo.fp.form.behavior.mine.radius"), 0, 10, {
        defaultValue: config.searchRadius,
        valueStep: 1,
    })
        .toggle(t("xiaobo.fp.form.behavior.mine.approach"), { defaultValue: config.approach })
        .submitButton(t("xiaobo.fp.form.behavior.save"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const [enabled, intervalTicks, directionIndex, blockTypeId, searchRadius, approach] = response.formValues;
    const direction = typeof directionIndex === "number" ? MINE_DIRECTIONS[directionIndex] : undefined;
    if (typeof enabled !== "boolean" || direction === undefined || typeof blockTypeId !== "string"
        || typeof searchRadius !== "number" || typeof approach !== "boolean") {
        return sendError(player, "挖掘行为表单数据无效。");
    }
    await saveBehavior(player, services, record, {
        ...record.behavior,
        mine: {
            enabled,
            intervalTicks: Number(intervalTicks),
            direction,
            blockTypeId: blockTypeId.trim() || null,
            searchRadius,
            approach,
        },
    }, openDetail);
}
async function openUseForm(player, services, record, openDetail) {
    const config = record.behavior.use;
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.use"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "20", { defaultValue: String(config.intervalTicks) })
        .slider(t("xiaobo.fp.form.behavior.use.slot"), 0, 35, { defaultValue: config.slot, valueStep: 1 })
        .submitButton(t("xiaobo.fp.form.behavior.save"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const [enabled, intervalTicks, slot] = response.formValues;
    if (typeof enabled !== "boolean" || typeof slot !== "number") {
        return sendError(player, "定时使用行为表单数据无效。");
    }
    await saveBehavior(player, services, record, {
        ...record.behavior,
        use: { enabled, intervalTicks: Number(intervalTicks), slot },
    }, openDetail);
}
async function openPlaceForm(player, services, record, openDetail) {
    const config = record.behavior.place;
    const currentSource = config.selectionMode === "slot"
        ? { translate: "xiaobo.fp.form.behavior.place.current_slot", with: [String(config.slot)] }
        : config.itemTypeId === null
            ? t("xiaobo.fp.form.behavior.place.current_empty")
            : { translate: "xiaobo.fp.form.behavior.place.current_item", with: [config.itemTypeId] };
    const actions = [];
    const form = new ActionFormData()
        .title(t("xiaobo.fp.form.behavior.place"))
        .body({
        rawtext: [
            t("xiaobo.fp.form.behavior.place.body"),
            { text: "\n" },
            currentSource,
        ],
    });
    form.button(t("xiaobo.fp.form.behavior.place.by_slot"));
    actions.push(() => openPlaceSettingsForm(player, services, record, openDetail, "slot"));
    form.button(t("xiaobo.fp.form.behavior.place.by_item"));
    actions.push(() => openPlaceSettingsForm(player, services, record, openDetail, "item"));
    form.button(t("xiaobo.fp.form.back"));
    actions.push(() => openBehaviorForm(player, services, record, openDetail));
    const response = await form.show(player);
    const action = response.selection === undefined ? undefined : actions[response.selection];
    if (!response.canceled && action !== undefined && player.isValid)
        await action();
}
async function openPlaceSettingsForm(player, services, record, openDetail, selectionMode) {
    const config = record.behavior.place;
    const form = new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.place"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "10", { defaultValue: String(config.intervalTicks) })
        .dropdown(t("xiaobo.fp.form.behavior.place.mode"), PLACE_MODES.map((mode) => t(`xiaobo.fp.form.behavior.place.${mode}`)), { defaultValueIndex: Math.max(0, PLACE_MODES.indexOf(config.mode)) })
        .textField(t("xiaobo.fp.form.behavior.place.x"), "0", {
        defaultValue: config.position === null ? "" : String(config.position.x),
    })
        .textField(t("xiaobo.fp.form.behavior.place.y"), "64", {
        defaultValue: config.position === null ? "" : String(config.position.y),
    })
        .textField(t("xiaobo.fp.form.behavior.place.z"), "0", {
        defaultValue: config.position === null ? "" : String(config.position.z),
    });
    if (selectionMode === "slot") {
        form.slider(t("xiaobo.fp.form.behavior.place.slot"), 0, 35, {
            defaultValue: config.slot,
            valueStep: 1,
        });
    }
    else {
        form.textField(t("xiaobo.fp.form.behavior.place.item"), "minecraft:oak_planks", {
            defaultValue: config.itemTypeId ?? "",
        });
        form.toggle(t("xiaobo.fp.form.behavior.place.use_mainhand"), { defaultValue: false });
    }
    const response = await form.submitButton(t("xiaobo.fp.form.behavior.save")).show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const [enabled, intervalTicks, modeIndex, x, y, z, selection, usePlayerMainhand] = response.formValues;
    const mode = typeof modeIndex === "number" ? PLACE_MODES[modeIndex] : undefined;
    if (typeof enabled !== "boolean" || mode === undefined || typeof x !== "string"
        || typeof y !== "string" || typeof z !== "string") {
        return sendError(player, "自动交互（放置）表单数据无效。");
    }
    const position = parseOptionalBlockPosition(x, y, z);
    if (position === undefined || (mode === "position" && position === null)) {
        return sendError(player, "指定坐标模式需要完整的整数 X、Y、Z 坐标。");
    }
    let slot = config.slot;
    let itemTypeId = config.itemTypeId;
    if (selectionMode === "slot") {
        if (typeof selection !== "number")
            return sendError(player, "自动交互（放置）表单数据无效。");
        slot = selection;
    }
    else {
        if (typeof selection !== "string" || typeof usePlayerMainhand !== "boolean") {
            return sendError(player, "自动交互（放置）表单数据无效。");
        }
        if (usePlayerMainhand) {
            const mainhandItemTypeId = services.inventory.getPlayerMainhandItemTypeId(actorIdentity(player));
            if (!mainhandItemTypeId.ok)
                return sendError(player, mainhandItemTypeId.error.message);
            itemTypeId = mainhandItemTypeId.value;
        }
        else {
            itemTypeId = selection.trim() || null;
        }
    }
    await saveBehavior(player, services, record, {
        ...record.behavior,
        place: {
            enabled,
            intervalTicks: Number(intervalTicks),
            mode,
            position,
            selectionMode,
            slot,
            itemTypeId,
        },
    }, openDetail);
}
async function saveBehavior(player, services, record, config, openDetail) {
    const result = services.behavior.updateBehaviorConfig(actorIdentity(player), record.id, record.recordRevision, record.behavior, config);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage(behaviorChangeMessage(result.value.name, record.behavior, result.value.behavior)
        ?? { translate: "xiaobo.fp.message.saved", with: [result.value.name] });
    await openDetail(result.value);
}
function addBehaviorButton(form, actions, kind, enabled, action) {
    form.button({
        rawtext: [
            t(`xiaobo.fp.form.behavior.${kind}`),
            { text: `\n${enabled ? "§a" : "§7"}` },
            t(enabled ? "xiaobo.fp.form.behavior.on" : "xiaobo.fp.form.behavior.off"),
            { text: "§r" },
        ],
    });
    actions.push(action);
}
function followTargets(record) {
    const targets = [{ playerId: null, name: null, label: t("xiaobo.fp.form.behavior.follow.none") }];
    if (record.behavior.follow.targetPlayerId !== null && record.behavior.follow.lastKnownName !== null) {
        targets.push({
            playerId: record.behavior.follow.targetPlayerId,
            name: record.behavior.follow.lastKnownName,
            label: record.behavior.follow.lastKnownName,
        });
    }
    for (const target of world.getAllPlayers().filter(isRealPlayer)) {
        if (target.playfabId.length === 0)
            continue;
        const existing = targets.find((candidate) => candidate.playerId === target.playfabId);
        if (existing === undefined)
            targets.push({ playerId: target.playfabId, name: target.name, label: target.name });
        else {
            existing.name = target.name;
            existing.label = target.name;
        }
    }
    return targets;
}
function parseIdList(value) {
    return [...new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}
function parseOptionalBlockPosition(x, y, z) {
    const normalizedX = x.trim();
    const normalizedY = y.trim();
    const normalizedZ = z.trim();
    if (normalizedX.length === 0 && normalizedY.length === 0 && normalizedZ.length === 0)
        return null;
    if (normalizedX.length === 0 || normalizedY.length === 0 || normalizedZ.length === 0)
        return undefined;
    const parsedX = Number(normalizedX);
    const parsedY = Number(normalizedY);
    const parsedZ = Number(normalizedZ);
    return Number.isSafeInteger(parsedX) && Number.isSafeInteger(parsedY) && Number.isSafeInteger(parsedZ)
        ? { x: parsedX, y: parsedY, z: parsedZ }
        : undefined;
}
//# sourceMappingURL=behaviors.js.map