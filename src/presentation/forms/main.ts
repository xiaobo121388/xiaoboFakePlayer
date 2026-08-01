import { Player, world, type RawMessage } from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";

import type { FakePlayerAction } from "../../application/behaviorService.js";
import type { RuntimeFakePlayer } from "../../application/ports.js";
import { isCapabilityEnabled } from "../../domain/capabilities.js";
import type { FakePlayerGameMode, FakePlayerRecord, PermissionGrant, RespawnMode } from "../../domain/model.js";
import { err, ok, type Result } from "../../domain/results.js";
import { withMinecraftNamespace } from "../../domain/validation.js";
import type { CommandServices } from "../commands.js";
import { actorIdentity, isRealPlayer, playerLocation } from "../playerContext.js";
import { openBehaviorForm } from "./behaviors.js";
import { formBoundary, ready, sendError, t } from "./formSupport.js";
import { openInventoryForm } from "./inventory.js";

const GAME_MODES: readonly FakePlayerGameMode[] = ["survival", "creative", "adventure", "spectator"];
const RESPAWN_MODES: readonly RespawnMode[] = ["manual", "death_location", "player_spawn"];
const SKIN_MODES = ["default", "copy_actor"] as const;

export async function openMainForm(player: Player, services: CommandServices): Promise<void> {
    await formBoundary(player, "main", async () => {
        if (services.getStartupStatus().state === "blocked") {
            await showRecoveryForm(player, services);
            return;
        }
        if (!ready(player, services)) return;
        const actor = actorIdentity(player);
        const capabilities = services.permissions.capabilities(actor);
        if (!capabilities.ok) return sendError(player, capabilities.error.message);

        const actions: (() => Promise<void>)[] = [];
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.main.title"))
            .body(t("xiaobo.fp.form.main.body"));
        if (capabilities.value.canPlace) {
            form.button(t("xiaobo.fp.form.main.create"));
            actions.push(() => openCreateForm(player, services));
        }
        if (capabilities.value.canSet) {
            const records = services.lifecycle.list(actor);
            if (!records.ok) return sendError(player, records.error.message);
            for (const record of sortRecords(records.value, player)) {
                form.button(`${record.name}\n${record.id} · ${record.lifecycle.kind}`);
                actions.push(() => openDetailForm(player, services, record));
            }
        }
        if (actor.isOperator) {
            form.button(t("xiaobo.fp.form.main.permissions"));
            actions.push(() => openPermissionsForm(player, services));
            form.button(t("xiaobo.fp.form.main.recovery"));
            actions.push(() => openRecoveryForm(player, services));
        }

        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid) await action();
    });
}

export async function openFakePlayerForm(
    player: Player,
    services: CommandServices,
    id: FakePlayerRecord["id"],
): Promise<void> {
    await formBoundary(player, `target:${id}`, async () => {
        if (!ready(player, services)) return;
        const record = loadCurrentRecord(player, services, id);
        if (!record.ok) return sendError(player, record.error.message);
        await openDetailForm(player, services, record.value);
    });
}

async function openCreateForm(player: Player, services: CommandServices): Promise<void> {
    await formBoundary(player, "create", async () => {
        const location = player.location;
        const response = await new ModalFormData()
            .title(t("xiaobo.fp.form.create.title"))
            .textField(t("xiaobo.fp.form.create.name"), "FakePlayer", { defaultValue: "假人" })
            .dropdown(t("xiaobo.fp.form.create.gamemode"), GAME_MODES.map((mode) => t(`xiaobo.fp.gamemode.${mode}`)))
            .dropdown(t("xiaobo.fp.form.create.skin"), SKIN_MODES.map((mode) => t(`xiaobo.fp.skin.${mode}`)))
            .textField("X", "0", { defaultValue: String(location.x) })
            .textField("Y", "64", { defaultValue: String(location.y) })
            .textField("Z", "0", { defaultValue: String(location.z) })
            .submitButton(t("xiaobo.fp.form.create.submit"))
            .show(player);
        if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
        const [name, gameModeIndex, skinModeIndex, x, y, z] = response.formValues;
        const gameMode = typeof gameModeIndex === "number" ? GAME_MODES[gameModeIndex] : undefined;
        const skinMode = typeof skinModeIndex === "number" ? SKIN_MODES[skinModeIndex] : undefined;
        if (typeof name !== "string" || gameMode === undefined || skinMode === undefined) {
            return sendError(player, "创建表单数据无效。");
        }
        const position = { x: Number(x), y: Number(y), z: Number(z) };
        if (!finitePoint(position)) return sendError(player, "创建坐标必须是有限数字。");
        const result = services.lifecycle.create(actorIdentity(player), {
            requestedName: name,
            location: {
                dimension: player.dimension.id,
                position,
                rotation: player.getRotation(),
            },
            gameMode,
            skinMode,
            unavailablePlayerNames: world.getAllPlayers().map((candidate) => candidate.name),
        });
        if (!result.ok) return sendError(player, result.error.message);
        player.sendMessage({ translate: "xiaobo.fp.message.created", with: [result.value.name, result.value.id] });
        if (skinMode === "copy_actor" && result.value.skin.kind === "default") {
            player.sendMessage({ translate: "xiaobo.fp.message.skin_fallback" });
        }
        await openDetailForm(player, services, result.value);
    });
}

async function openDetailForm(player: Player, services: CommandServices, record: FakePlayerRecord): Promise<void> {
    await formBoundary(player, `detail:${record.id}`, async () => {
        if (!ready(player, services)) return;
        const actions: (() => Promise<void>)[] = [];
        const position = record.location.position;
        const errorDetail = record.lifecycle.kind === "error" ? `\n${record.lifecycle.message}` : "";
        const form = new ActionFormData()
            .title(record.name)
            .body(`${record.id} · ${record.lifecycle.kind}\n${record.location.dimension}\n`
                + `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}\n`
            + `rev ${record.recordRevision} · inventory ${record.inventoryRevision ?? "-"}${errorDetail}`);

        if (record.lifecycle.kind === "online") {
            form.button(t("xiaobo.fp.form.detail.actions"));
            actions.push(() => openActionForm(player, services, record));
            form.button(t("xiaobo.fp.form.detail.offline"));
            actions.push(() => runRecordMutation(player, services, record.id, (current) => services.lifecycle.takeOffline(
                actorIdentity(player), current.id, current.recordRevision,
            )));
        } else if (record.lifecycle.kind === "offline" || record.lifecycle.kind === "missing") {
            form.button(t("xiaobo.fp.form.detail.online_saved"));
            actions.push(() => runRecordMutation(player, services, record.id, (current) => services.lifecycle.bringOnline(
                actorIdentity(player), current.id, current.recordRevision,
            )));
            form.button(t("xiaobo.fp.form.detail.online_here"));
            actions.push(() => runRecordMutation(player, services, record.id, (current) => services.lifecycle.bringOnline(
                actorIdentity(player), current.id, current.recordRevision, playerLocation(player),
            )));
        }
        if (record.lifecycle.kind === "online" || record.lifecycle.kind === "offline") {
            form.button(t("xiaobo.fp.form.detail.behavior"));
            actions.push(() => openBehaviorForm(
                player,
                services,
                record,
                (updated) => openDetailForm(player, services, updated),
            ));
            form.button(t("xiaobo.fp.form.detail.rename"));
            actions.push(() => openRenameForm(player, services, record));
            form.button(t("xiaobo.fp.form.detail.other_settings"));
            actions.push(() => openOtherSettingsForm(player, services, record));
            form.button(t("xiaobo.fp.form.detail.inventory"));
            actions.push(() => openInventoryForm(
                player,
                services,
                record,
                (updated) => openDetailForm(player, services, updated),
            ));
        }
        if (record.lifecycle.kind === "offline") {
            form.button(t("xiaobo.fp.form.detail.recycle_delete"));
            actions.push(() => confirmRecycleDelete(player, services, record));
        }
        if (record.lifecycle.kind === "offline"
            || (record.lifecycle.kind === "error" && actorIdentity(player).isOperator)) {
            form.button(t("xiaobo.fp.form.detail.purge"));
            actions.push(() => confirmPurge(player, services, record));
        }
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openMainForm(player, services));

        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid && ready(player, services)) await action();
    });
}

async function openActionForm(player: Player, services: CommandServices, record: FakePlayerRecord): Promise<void> {
    await formBoundary(player, `actions:${record.id}`, async () => {
        const entries: [RawMessage, FakePlayerAction | "look_at_coordinates"][] = [
            [t("xiaobo.fp.form.action.teleport"), { kind: "teleport", location: playerLocation(player) }],
            [t("xiaobo.fp.form.action.navigate"), {
                kind: "navigate",
                dimension: player.dimension.id,
                position: player.location,
            }],
            [t("xiaobo.fp.form.action.lookat"), {
                kind: "look_at_once",
                dimension: player.dimension.id,
                position: player.getHeadLocation(),
            }],
            [t("xiaobo.fp.form.action.lookat_coordinates"), "look_at_coordinates"],
            [t("xiaobo.fp.form.action.lookat_continuous"), { kind: "look_at_entity", targetId: player.id }],
            [t("xiaobo.fp.form.action.jump"), { kind: "jump" }],
            [t("xiaobo.fp.form.action.stop"), { kind: "stop" }],
        ];
        if (isCapabilityEnabled("sneaking")) {
            entries.splice(entries.length - 1, 0,
                [t("xiaobo.fp.form.action.sneak"), { kind: "set_sneaking", enabled: true }],
                [t("xiaobo.fp.form.action.stand"), { kind: "set_sneaking", enabled: false }]);
        }
        const form = new ActionFormData().title(t("xiaobo.fp.form.detail.actions"));
        entries.forEach(([label]) => form.button(label));
        form.button(t("xiaobo.fp.form.action.interact_entity"));
        const response = await form.show(player);
        if (response.canceled || response.selection === undefined || !ready(player, services)) return;
        if (response.selection === entries.length) {
            await openEntityInteractionForm(player, services, record);
            return;
        }
        const selected = entries[response.selection];
        if (selected === undefined) return;
        if (selected[1] === "look_at_coordinates") {
            await openLookAtCoordinatesForm(player, services, record);
            return;
        }
        const current = loadCurrentRecord(player, services, record.id);
        if (!current.ok) return sendError(player, current.error.message);
        const action = selected[1].kind === "look_at_once"
            ? { kind: "look_at_once" as const, dimension: player.dimension.id, position: player.getHeadLocation() }
            : selected[1];
        const result = services.behavior.perform(
            actorIdentity(player),
            current.value.id,
            current.value.recordRevision,
            action,
        );
        if (!result.ok) return sendError(player, result.error.message);
        player.sendMessage({ translate: "xiaobo.fp.message.action_ok", with: [current.value.name] });
    });
}

async function openLookAtCoordinatesForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    const target = player.getHeadLocation();
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.action.lookat_coordinates"))
        .textField(t("xiaobo.fp.form.behavior.place.x"), "0", { defaultValue: String(target.x) })
        .textField(t("xiaobo.fp.form.behavior.place.y"), "64", { defaultValue: String(target.y) })
        .textField(t("xiaobo.fp.form.behavior.place.z"), "0", { defaultValue: String(target.z) })
        .submitButton(t("xiaobo.fp.form.action.lookat_coordinates"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;
    const [x, y, z] = response.formValues;
    const position = { x: Number(x), y: Number(y), z: Number(z) };
    if (!finitePoint(position)) return sendError(player, "看向坐标必须是有限数字。");
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok) return sendError(player, current.error.message);
    const result = services.behavior.perform(
        actorIdentity(player),
        current.value.id,
        current.value.recordRevision,
        { kind: "look_at_once", dimension: player.dimension.id, position },
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.action_ok", with: [current.value.name] });
}

async function openEntityInteractionForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    await formBoundary(player, `interact-entity:${record.id}`, async () => {
        if (!ready(player, services)) return;
        if (!isCapabilityEnabled("nearby_entity_listing")) {
            await openEntityTypeInteractionForm(player, services, record);
            return;
        }
        const current = loadCurrentRecord(player, services, record.id);
        if (!current.ok) return sendError(player, current.error.message);
        const targets = services.behavior.listInteractionTargets(
            actorIdentity(player),
            current.value.id,
            current.value.recordRevision,
        );
        if (!targets.ok) return sendError(player, targets.error.message);

        const actions: (() => Promise<void>)[] = [];
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.action.interact_entity.title"))
            .body(targets.value.length === 0
                ? t("xiaobo.fp.form.action.interact_entity.empty")
                : t("xiaobo.fp.form.action.interact_entity.body"));
        targets.value.forEach((target) => {
            form.button({
                translate: "xiaobo.fp.form.action.interact_entity.target",
                with: [target.nameTag || target.typeId, target.typeId, target.distance.toFixed(1)],
            });
            actions.push(() => performEntityInteraction(player, services, record.id, target.id));
        });
        form.button(t("xiaobo.fp.form.action.interact_entity.by_id"));
        actions.push(() => openEntityTypeInteractionForm(player, services, record));
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openActionForm(player, services, record));

        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid && ready(player, services)) await action();
    });
}

async function openEntityTypeInteractionForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.action.interact_entity.by_id"))
        .textField(t("xiaobo.fp.form.action.interact_entity.type_id"), "minecraft:cow")
        .submitButton(t("xiaobo.fp.form.action.interact_entity.submit"))
        .show(player);
    if (response.canceled || !ready(player, services)) return;
    const typeId = response.formValues?.[0];
    if (typeof typeId !== "string") return sendError(player, "实体 ID 无效。");
    const normalizedTypeId = withMinecraftNamespace(typeId);
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok) return sendError(player, current.error.message);
    const targets = services.behavior.listInteractionTargets(
        actorIdentity(player),
        current.value.id,
        current.value.recordRevision,
        normalizedTypeId,
    );
    if (!targets.ok) return sendError(player, targets.error.message);
    const target = targets.value[0];
    if (target === undefined) {
        player.sendMessage({ translate: "xiaobo.fp.message.interact_entity_not_found", with: [normalizedTypeId] });
        return;
    }
    await performEntityInteraction(player, services, record.id, target.id);
}

async function performEntityInteraction(
    player: Player,
    services: CommandServices,
    id: FakePlayerRecord["id"],
    targetId: string,
): Promise<void> {
    const current = loadCurrentRecord(player, services, id);
    if (!current.ok) return sendError(player, current.error.message);
    const result = services.behavior.perform(
        actorIdentity(player),
        current.value.id,
        current.value.recordRevision,
        { kind: "interact_entity", targetId },
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.action_ok", with: [current.value.name] });
}

async function openRenameForm(player: Player, services: CommandServices, record: FakePlayerRecord): Promise<void> {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.rename.title"))
        .textField(t("xiaobo.fp.form.rename.name"), record.name, { defaultValue: record.name })
        .submitButton(t("xiaobo.fp.form.rename.submit"))
        .show(player);
    if (response.canceled || !ready(player, services)) return;
    const name = response.formValues?.[0];
    if (typeof name !== "string") return sendError(player, "新名称无效。");
    await runRecordMutation(player, services, record.id, (current) => services.lifecycle.rename(
        actorIdentity(player),
        current.id,
        current.recordRevision,
        { requestedName: name, unavailablePlayerNames: world.getAllPlayers().map((candidate) => candidate.name) },
    ));
}

async function openOtherSettingsForm(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.other_settings.title"))
        .dropdown(t("xiaobo.fp.form.other_settings.game_mode"), GAME_MODES.map((mode) =>
            t(`xiaobo.fp.gamemode.${mode}`)), {
            defaultValueIndex: Math.max(0, GAME_MODES.indexOf(record.gameMode)),
        })
        .dropdown(t("xiaobo.fp.form.other_settings.respawn_mode"), RESPAWN_MODES.map((mode) =>
            t(`xiaobo.fp.respawn.${mode}`)), {
            defaultValueIndex: Math.max(0, RESPAWN_MODES.indexOf(record.respawnMode)),
        })
        .toggle(t("xiaobo.fp.form.other_settings.keep_saturated"), { defaultValue: record.keepSaturated })
        .submitButton(t("xiaobo.fp.form.other_settings.submit"))
        .show(player);
    if (response.canceled || !ready(player, services)) return;
    const gameModeIndex = response.formValues?.[0];
    const respawnModeIndex = response.formValues?.[1];
    const keepSaturated = response.formValues?.[2];
    const gameMode = typeof gameModeIndex === "number" ? GAME_MODES[gameModeIndex] : undefined;
    const respawnMode = typeof respawnModeIndex === "number" ? RESPAWN_MODES[respawnModeIndex] : undefined;
    if (gameMode === undefined || respawnMode === undefined || typeof keepSaturated !== "boolean") {
        return sendError(player, "其他功能表单数据无效。");
    }
    await runRecordMutation(player, services, record.id, (current) => services.lifecycle.setOtherSettings(
        actorIdentity(player),
        current.id,
        current.recordRevision,
        {
            gameMode,
            keepSaturated,
            respawnMode,
            manualRespawnLocation: respawnMode === "manual" ? playerLocation(player) : undefined,
        },
    ));
}

async function confirmPurge(player: Player, services: CommandServices, record: FakePlayerRecord): Promise<void> {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.delete.title"))
        .body({ translate: "xiaobo.fp.form.delete.body", with: [record.name, record.id] })
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services)) return;
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok) return sendError(player, current.error.message);
    const result = services.lifecycle.purge(
        actorIdentity(player),
        current.value.id,
        current.value.recordRevision,
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.deleted", with: [result.value.name] });
    await openMainForm(player, services);
}

async function confirmRecycleDelete(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.recycle_delete.title"))
        .body({ translate: "xiaobo.fp.form.recycle_delete.body", with: [record.name, record.id] })
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.recycle_delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services)) return;
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok) return sendError(player, current.error.message);
    const result = services.lifecycle.recycle(
        actorIdentity(player),
        current.value.id,
        current.value.recordRevision,
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.recycled", with: [result.value.name] });
    await openMainForm(player, services);
}

async function openPermissionsForm(player: Player, services: CommandServices): Promise<void> {
    await formBoundary(player, "permissions", async () => {
        if (!ready(player, services)) return;
        const actor = actorIdentity(player);
        if (!actor.isOperator) return sendError(player, "只有 OP 可以修改权限。");
        const targets = world.getAllPlayers().filter(isRealPlayer);
        if (targets.length === 0) return sendError(player, "当前没有可管理的在线真人玩家。");

        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.permissions.title"))
            .body(t("xiaobo.fp.form.permissions.body"));
        targets.forEach((target) => form.button(target.name));
        const response = await form.show(player);
        if (response.canceled || response.selection === undefined || !ready(player, services)) return;
        const target = targets[response.selection];
        if (target === undefined || target.playfabId.length === 0) return sendError(player, "目标玩家无效。");
        await openPermissionEditor(player, services, target.playfabId, target.name);
    });
}

async function openPermissionEditor(
    player: Player,
    services: CommandServices,
    targetId: string,
    targetName: string,
): Promise<void> {
    const grants = services.permissions.list(actorIdentity(player));
    if (!grants.ok) return sendError(player, grants.error.message);
    const current = grantFor(grants.value, targetId);
    const response = await new ModalFormData()
        .title(targetName)
        .toggle(t("xiaobo.fp.form.permissions.place"), { defaultValue: current.canPlace })
        .toggle(t("xiaobo.fp.form.permissions.set"), { defaultValue: current.canSet })
        .submitButton(t("xiaobo.fp.form.permissions.submit"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services)) return;

    const latestActor = actorIdentity(player);
    if (!latestActor.isOperator) return sendError(player, "只有 OP 可以修改权限。");
    const target = world.getAllPlayers().filter(isRealPlayer)
        .find((candidate) => candidate.playfabId === targetId);
    if (target === undefined) return sendError(player, "目标玩家已离线，未修改权限。");
    const [canPlace, canSet] = response.formValues;
    if (typeof canPlace !== "boolean" || typeof canSet !== "boolean") {
        return sendError(player, "权限表单数据无效。");
    }
    const placeResult = services.permissions.setGrant(latestActor, {
        playerId: targetId,
        lastKnownName: target.name,
    }, "can_place", canPlace);
    if (!placeResult.ok) return sendError(player, placeResult.error.message);
    const setResult = services.permissions.setGrant(latestActor, {
        playerId: targetId,
        lastKnownName: target.name,
    }, "can_set", canSet);
    if (!setResult.ok) return sendError(player, setResult.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.permissions_ok", with: [target.name] });
    await openPermissionsForm(player, services);
}

export async function openRecoveryForm(player: Player, services: CommandServices): Promise<void> {
    await formBoundary(player, "recovery", () => showRecoveryForm(player, services));
}

async function showRecoveryForm(player: Player, services: CommandServices): Promise<void> {
    const startup = services.getStartupStatus();
    if (startup.state === "recovering") {
        ready(player, services);
        return;
    }
    const actor = actorIdentity(player);
    if (!actor.isOperator) return sendError(player, "只有 OP 可以使用恢复中心。");
    const records = services.lifecycle.listRepairCandidates(actor);
    const orphans = loadOrphanRepairCandidates(services, actor);
    const pending = services.inventory.listPendingTransfers(actor);
    const exceptional = records.ok ? records.value : [];
    const orphaned = orphans.ok ? orphans.value : [];
    const transfers = pending.ok ? pending.value : [];
    const body = [
        ...(startup.state === "blocked"
            ? [`§c假人系统处于只读隔离：${startup.message ?? "未知恢复错误"}§r`, ""]
            : []),
        records.ok
            ? exceptional.length === 0
                ? "没有需要人工重置的异常假人。"
                : exceptional.map((record) => `${record.id} ${record.name}: ${record.lifecycle.kind}`
                    + (record.lifecycle.kind === "error" ? `\n${record.lifecycle.message}` : "")).join("\n")
            : `§c无法读取异常假人：${records.error.message}§r`,
            orphans.ok
                ? orphaned.length === 0
                    ? "没有无记录的孤儿假人实体。"
                    : orphaned.map((orphan) => `${orphan.id} ${orphan.name}: 无 catalog 记录`).join("\n")
                : `§c无法读取孤儿假人实体：${orphans.error.message}§r`,
        pending.ok
            ? transfers.length === 0
                ? "没有待恢复的库存或经验事务。"
                : "存在待恢复事务，请先通过下方事务按钮完成恢复。"
            : `§c无法读取待恢复事务：${pending.error.message}§r`,
        "",
        "重置会永久放弃所选假人的物品、经验、快照和设置，且无法撤销。",
    ].join("\n");
    const actions: (() => Promise<void>)[] = [];
    const form = new ActionFormData()
        .title(t("xiaobo.fp.form.main.recovery"))
        .body(body);
    for (const transfer of transfers) {
        form.button(`${transfer.kind} · ${transfer.phase}\n${transfer.fakePlayerId} -> ${transfer.playerId}`);
        actions.push(async () => {
            const result = services.inventory.retryPendingTransfer(actorIdentity(player), transfer.id);
            if (!result.ok) return sendError(player, result.error.message);
            player.sendMessage({ translate: "xiaobo.fp.message.recovery_ok", with: [transfer.id] });
            await retryRecoveryAndOpenNext(player, services);
        });
    }
    if (pending.ok) {
        const pendingFakePlayerIds = new Set(transfers.map((transfer) => transfer.fakePlayerId));
        for (const record of exceptional) {
            if (pendingFakePlayerIds.has(record.id)) continue;
            form.button(`危险：放弃数据并删除 ${record.name}\n${record.id} · ${record.lifecycle.kind}`);
            actions.push(() => confirmRepairDiscard(player, services, record));
        }
        for (const orphan of orphaned) {
            if (pendingFakePlayerIds.has(orphan.id)) continue;
            form.button(`危险：删除孤儿实体 ${orphan.name}\n${orphan.id} · 无 catalog 记录`);
            actions.push(() => confirmOrphanDiscard(player, services, orphan));
        }
    }
    if (startup.state === "blocked") {
        form.button("重新尝试恢复");
        actions.push(() => retryRecoveryAndOpenNext(player, services));
        form.button(t("xiaobo.fp.form.cancel"));
        actions.push(async () => undefined);
    } else {
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openMainForm(player, services));
    }
    const response = await form.show(player);
    const action = response.selection === undefined ? undefined : actions[response.selection];
    if (!response.canceled && action !== undefined && player.isValid) await action();
}

async function confirmRepairDiscard(
    player: Player,
    services: CommandServices,
    record: FakePlayerRecord,
): Promise<void> {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.delete.title"))
        .body({ translate: "xiaobo.fp.form.delete.body", with: [record.name, record.id] })
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !player.isValid) return;
    const candidates = services.lifecycle.listRepairCandidates(actorIdentity(player));
    if (!candidates.ok) return sendError(player, candidates.error.message);
    const current = candidates.value.find((candidate) => candidate.id === record.id);
    if (current === undefined) return sendError(player, `假人 ${record.id} 已不再需要人工重置。`);
    const result = services.lifecycle.discardBroken(
        actorIdentity(player),
        current.id,
        current.recordRevision,
    );
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.deleted", with: [result.value.name] });
    await retryRecoveryAndOpenNext(player, services);
}

async function confirmOrphanDiscard(
    player: Player,
    services: CommandServices,
    orphan: RuntimeFakePlayer,
): Promise<void> {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.delete.title"))
        .body(`确定永久断开并删除孤儿假人实体 ${orphan.name}（${orphan.id}）吗？\n\n`
            + "该实体没有 catalog 记录，物品和经验无法恢复，此操作无法撤销。")
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !player.isValid) return;
    const candidates = loadOrphanRepairCandidates(services, actorIdentity(player));
    if (!candidates.ok) return sendError(player, candidates.error.message);
    const current = candidates.value.find((candidate) => candidate.id === orphan.id);
    if (current === undefined) return sendError(player, `孤儿假人实体 ${orphan.id} 已不再需要人工重置。`);
    const result = services.lifecycle.discardOrphan(actorIdentity(player), current.id);
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.deleted", with: [result.value.name] });
    await retryRecoveryAndOpenNext(player, services);
}

function loadOrphanRepairCandidates(
    services: CommandServices,
    actor: ReturnType<typeof actorIdentity>,
): Result<readonly RuntimeFakePlayer[]> {
    try {
        return services.lifecycle.listOrphanRepairCandidates(actor);
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[xiaobo-fake-player] recovery orphan scan failed: ${message}`);
        return err("CONFLICT", `无法扫描稳定标签实体：${message}`);
    }
}

async function retryRecoveryAndOpenNext(player: Player, services: CommandServices): Promise<void> {
    const status = services.retryStartupRecovery();
    if (!player.isValid) return;
    if (status.state === "ready") {
        await openMainForm(player, services);
        return;
    }
    if (status.state === "blocked") await openRecoveryForm(player, services);
    else ready(player, services);
}

async function runRecordMutation(
    player: Player,
    services: CommandServices,
    id: FakePlayerRecord["id"],
    mutation: (record: FakePlayerRecord) => Result<FakePlayerRecord>,
): Promise<void> {
    if (!ready(player, services)) return;
    const current = loadCurrentRecord(player, services, id);
    if (!current.ok) return sendError(player, current.error.message);
    const result = mutation(current.value);
    if (!result.ok) return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.saved", with: [result.value.name] });
    await openDetailForm(player, services, result.value);
}

function loadCurrentRecord(
    player: Player,
    services: CommandServices,
    id: FakePlayerRecord["id"],
): Result<FakePlayerRecord> {
    const listed = services.lifecycle.list(actorIdentity(player));
    if (!listed.ok) return listed;
    const record = listed.value.find((candidate) => candidate.id === id);
    return record === undefined ? err("NOT_FOUND", `未找到假人 ${id}。`) : ok(record);
}

function finitePoint(point: { readonly x: number; readonly y: number; readonly z: number }): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function sortRecords(records: readonly FakePlayerRecord[], player: Player): readonly FakePlayerRecord[] {
    return [...records].sort((left, right) => {
        const leftSameDimension = left.location.dimension === player.dimension.id;
        const rightSameDimension = right.location.dimension === player.dimension.id;
        if (leftSameDimension !== rightSameDimension) return leftSameDimension ? -1 : 1;
        if (leftSameDimension) return distanceSquared(left.location.position, player.location)
            - distanceSquared(right.location.position, player.location);
        return left.id.localeCompare(right.id);
    });
}

function distanceSquared(
    left: { readonly x: number; readonly y: number; readonly z: number },
    right: { readonly x: number; readonly y: number; readonly z: number },
): number {
    return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function grantFor(
    grants: readonly PermissionGrant[],
    playerId: string,
): Pick<PermissionGrant, "canPlace" | "canSet"> {
    return grants.find((grant) => grant.playerId === playerId) ?? { canPlace: false, canSet: false };
}