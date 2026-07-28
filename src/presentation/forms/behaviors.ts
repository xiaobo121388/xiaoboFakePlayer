import { Player, world, type RawMessage } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

import type { BehaviorConfig, FakePlayerRecord } from "../../domain/model.js";
import type { CommandServices } from "../commands.js";
import { actorIdentity, isRealPlayer } from "../playerContext.js";
import { formBoundary, ready, sendError, t } from "./formSupport.js";

const MINE_DIRECTIONS: readonly BehaviorConfig["mine"]["direction"][] = ["front", "down", "up"];

type DetailNavigation = (record: FakePlayerRecord) => Promise<void>;

export async function openBehaviorForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    openDetail: DetailNavigation,
): Promise<void> {
    await formBoundary(player, `behavior:${record.id}`, async () => {
        if (!ready(player, services)) return;
        const actions: (() => Promise<void>)[] = [];
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.behavior.title"))
            .body({ translate: "xiaobo.fp.form.behavior.body", with: [record.name] });
        addBehaviorButton(form, actions, "follow", record.behavior.follow.enabled, () => openFollowForm(
            player, services, record, openDetail,
        ));
        addBehaviorButton(form, actions, "attack", record.behavior.attack.enabled, () => openAttackForm(
            player, services, record, openDetail,
        ));
        addBehaviorButton(form, actions, "mine", record.behavior.mine.enabled, () => openMineForm(
            player, services, record, openDetail,
        ));
        addBehaviorButton(form, actions, "use", record.behavior.use.enabled, () => openUseForm(
            player, services, record, openDetail,
        ));
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openDetail(record));

        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid) await action();
    });
}

async function openFollowForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    openDetail: DetailNavigation,
): Promise<void> {
    const targets = followTargets(record);
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.follow"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: record.behavior.follow.enabled })
        .dropdown(t("xiaobo.fp.form.behavior.follow.target"), targets.map((target) => target.label), {
            defaultValueIndex: Math.max(0, targets.findIndex(
                (target) => target.playerId === record.behavior.follow.targetPlayerId,
            )),
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
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
    const [enabled, targetIndex, intervalTicks, speed, stopDistance] = response.formValues;
    const target = typeof targetIndex === "number" ? targets[targetIndex] : undefined;
    if (typeof enabled !== "boolean" || target === undefined || typeof speed !== "number"
        || typeof stopDistance !== "number") return sendError(player, "跟随行为表单数据无效。");
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

async function openAttackForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    openDetail: DetailNavigation,
): Promise<void> {
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
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
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

async function openMineForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    openDetail: DetailNavigation,
): Promise<void> {
    const config = record.behavior.mine;
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.mine"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "10", { defaultValue: String(config.intervalTicks) })
        .dropdown(t("xiaobo.fp.form.behavior.mine.direction"), MINE_DIRECTIONS.map(
            (direction) => t(`xiaobo.fp.form.behavior.mine.${direction}`),
        ), { defaultValueIndex: Math.max(0, MINE_DIRECTIONS.indexOf(config.direction)) })
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
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
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

async function openUseForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    openDetail: DetailNavigation,
): Promise<void> {
    const config = record.behavior.use;
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.behavior.use"))
        .toggle(t("xiaobo.fp.form.behavior.enabled"), { defaultValue: config.enabled })
        .textField(t("xiaobo.fp.form.behavior.interval"), "20", { defaultValue: String(config.intervalTicks) })
        .slider(t("xiaobo.fp.form.behavior.use.slot"), 0, 35, { defaultValue: config.slot, valueStep: 1 })
        .submitButton(t("xiaobo.fp.form.behavior.save"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
    const [enabled, intervalTicks, slot] = response.formValues;
    if (typeof enabled !== "boolean" || typeof slot !== "number") {
        return sendError(player, "定时使用行为表单数据无效。");
    }
    await saveBehavior(player, services, record, {
        ...record.behavior,
        use: { enabled, intervalTicks: Number(intervalTicks), slot },
    }, openDetail);
}

async function saveBehavior(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
    config: BehaviorConfig,
    openDetail: DetailNavigation,
): Promise<void> {
    const result = services.behavior.updateBehaviorConfig(
        actorIdentity(player),
        record.id,
        record.recordRevision,
        config,
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.saved", with: [result.value.name] });
    await openDetail(result.value);
}

function addBehaviorButton(
    form: ActionFormData,
    actions: (() => Promise<void>)[],
    kind: "attack" | "follow" | "mine" | "use",
    enabled: boolean,
    action: () => Promise<void>,
): void {
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

function followTargets(record: FakePlayerRecord): readonly {
    readonly playerId: string | null;
    readonly name: string | null;
    readonly label: RawMessage | string;
}[] {
    const targets: {
        playerId: string | null;
        name: string | null;
        label: RawMessage | string;
    }[] = [{ playerId: null, name: null, label: t("xiaobo.fp.form.behavior.follow.none") }];
    if (record.behavior.follow.targetPlayerId !== null && record.behavior.follow.lastKnownName !== null) {
        targets.push({
            playerId: record.behavior.follow.targetPlayerId,
            name: record.behavior.follow.lastKnownName,
            label: record.behavior.follow.lastKnownName,
        });
    }
    for (const target of world.getAllPlayers().filter(isRealPlayer)) {
        if (target.playfabId.length === 0) continue;
        const existing = targets.find((candidate) => candidate.playerId === target.playfabId);
        if (existing === undefined) targets.push({ playerId: target.playfabId, name: target.name, label: target.name });
        else {
            existing.name = target.name;
            existing.label = target.name;
        }
    }
    return targets;
}

function parseIdList(value: string): readonly string[] {
    return [...new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}