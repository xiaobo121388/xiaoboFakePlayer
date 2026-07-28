import { world } from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { isCapabilityEnabled } from "../../domain/capabilities.js";
import { actorIdentity, isRealPlayer, playerLocation } from "../playerContext.js";
import { openBehaviorForm } from "./behaviors.js";
import { formBoundary, ready, sendError, t } from "./formSupport.js";
import { openInventoryForm } from "./inventory.js";
const GAME_MODES = ["survival", "creative", "adventure", "spectator"];
const RESPAWN_MODES = ["manual", "death_location", "player_spawn"];
const SKIN_MODES = ["default", "copy_actor"];
export async function openMainForm(player, services) {
    await formBoundary(player, "main", async () => {
        if (!ready(player, services))
            return;
        const actor = actorIdentity(player);
        const capabilities = services.permissions.capabilities(actor);
        if (!capabilities.ok)
            return sendError(player, capabilities.error.message);
        const actions = [];
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.main.title"))
            .body(t("xiaobo.fp.form.main.body"));
        if (capabilities.value.canPlace) {
            form.button(t("xiaobo.fp.form.main.create"));
            actions.push(() => openCreateForm(player, services));
        }
        if (capabilities.value.canSet) {
            const records = services.lifecycle.list(actor);
            if (!records.ok)
                return sendError(player, records.error.message);
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
        if (!response.canceled && action !== undefined && player.isValid)
            await action();
    });
}
async function openCreateForm(player, services) {
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
        if (response.canceled || response.formValues === undefined || !ready(player, services))
            return;
        const [name, gameModeIndex, skinModeIndex, x, y, z] = response.formValues;
        const gameMode = typeof gameModeIndex === "number" ? GAME_MODES[gameModeIndex] : undefined;
        const skinMode = typeof skinModeIndex === "number" ? SKIN_MODES[skinModeIndex] : undefined;
        if (typeof name !== "string" || gameMode === undefined || skinMode === undefined) {
            return sendError(player, "创建表单数据无效。");
        }
        const position = { x: Number(x), y: Number(y), z: Number(z) };
        if (!finitePoint(position))
            return sendError(player, "创建坐标必须是有限数字。");
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
        if (!result.ok)
            return sendError(player, result.error.message);
        player.sendMessage({ translate: "xiaobo.fp.message.created", with: [result.value.name, result.value.id] });
        if (skinMode === "copy_actor" && result.value.skin.kind === "default") {
            player.sendMessage({ translate: "xiaobo.fp.message.skin_fallback" });
        }
        await openDetailForm(player, services, result.value);
    });
}
async function openDetailForm(player, services, record) {
    await formBoundary(player, `detail:${record.id}`, async () => {
        if (!ready(player, services))
            return;
        const actions = [];
        const position = record.location.position;
        const form = new ActionFormData()
            .title(record.name)
            .body(`${record.id} · ${record.lifecycle.kind}\n${record.location.dimension}\n`
            + `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}\n`
            + `rev ${record.recordRevision} · inventory ${record.inventoryRevision ?? "-"}`);
        if (record.lifecycle.kind === "online") {
            form.button(t("xiaobo.fp.form.detail.actions"));
            actions.push(() => openActionForm(player, services, record));
            form.button(t("xiaobo.fp.form.detail.offline"));
            actions.push(() => runRecordMutation(player, services, () => services.lifecycle.takeOffline(actorIdentity(player), record.id, record.recordRevision)));
        }
        else if (record.lifecycle.kind === "offline" || record.lifecycle.kind === "missing") {
            form.button(t("xiaobo.fp.form.detail.online_saved"));
            actions.push(() => runRecordMutation(player, services, () => services.lifecycle.bringOnline(actorIdentity(player), record.id, record.recordRevision)));
            form.button(t("xiaobo.fp.form.detail.online_here"));
            actions.push(() => runRecordMutation(player, services, () => services.lifecycle.bringOnline(actorIdentity(player), record.id, record.recordRevision, playerLocation(player))));
        }
        if (record.lifecycle.kind === "online" || record.lifecycle.kind === "offline") {
            form.button(t("xiaobo.fp.form.detail.behavior"));
            actions.push(() => openBehaviorForm(player, services, record, (updated) => openDetailForm(player, services, updated)));
            form.button(t("xiaobo.fp.form.detail.rename"));
            actions.push(() => openRenameForm(player, services, record));
            form.button(t("xiaobo.fp.form.detail.respawn"));
            actions.push(() => openRespawnRuleForm(player, services, record));
        }
        if (record.lifecycle.kind === "offline") {
            form.button(t("xiaobo.fp.form.detail.inventory"));
            actions.push(() => openInventoryForm(player, services, record, (updated) => openDetailForm(player, services, updated)));
            form.button(t("xiaobo.fp.form.detail.recycle_delete"));
            actions.push(() => confirmRecycleDelete(player, services, record));
            form.button(t("xiaobo.fp.form.detail.purge"));
            actions.push(() => confirmPurge(player, services, record));
        }
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => openMainForm(player, services));
        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid && ready(player, services))
            await action();
    });
}
async function openActionForm(player, services, record) {
    await formBoundary(player, `actions:${record.id}`, async () => {
        const entries = [
            [t("xiaobo.fp.form.action.teleport"), { kind: "teleport", location: playerLocation(player) }],
            [t("xiaobo.fp.form.action.navigate"), {
                    kind: "navigate",
                    dimension: player.dimension.id,
                    position: player.location,
                }],
            [t("xiaobo.fp.form.action.lookat"), { kind: "look_at_entity", targetId: player.id }],
            [t("xiaobo.fp.form.action.jump"), { kind: "jump" }],
            [t("xiaobo.fp.form.action.stop"), { kind: "stop" }],
        ];
        if (isCapabilityEnabled("sneaking")) {
            entries.splice(entries.length - 1, 0, [t("xiaobo.fp.form.action.sneak"), { kind: "set_sneaking", enabled: true }], [t("xiaobo.fp.form.action.stand"), { kind: "set_sneaking", enabled: false }]);
        }
        const form = new ActionFormData().title(t("xiaobo.fp.form.detail.actions"));
        entries.forEach(([label]) => form.button(label));
        const response = await form.show(player);
        if (response.canceled || response.selection === undefined || !ready(player, services))
            return;
        const selected = entries[response.selection];
        if (selected === undefined)
            return;
        const result = services.behavior.perform(actorIdentity(player), record.id, record.recordRevision, selected[1]);
        if (!result.ok)
            return sendError(player, result.error.message);
        player.sendMessage({ translate: "xiaobo.fp.message.action_ok", with: [record.name] });
    });
}
async function openRenameForm(player, services, record) {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.rename.title"))
        .textField(t("xiaobo.fp.form.rename.name"), record.name, { defaultValue: record.name })
        .submitButton(t("xiaobo.fp.form.rename.submit"))
        .show(player);
    if (response.canceled || !ready(player, services))
        return;
    const name = response.formValues?.[0];
    if (typeof name !== "string")
        return sendError(player, "新名称无效。");
    await runRecordMutation(player, services, () => services.lifecycle.rename(actorIdentity(player), record.id, record.recordRevision, { requestedName: name, unavailablePlayerNames: world.getAllPlayers().map((candidate) => candidate.name) }));
}
async function openRespawnRuleForm(player, services, record) {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.respawn.title"))
        .dropdown(t("xiaobo.fp.form.respawn.mode"), RESPAWN_MODES.map((mode) => t(`xiaobo.fp.respawn.${mode}`)), {
        defaultValueIndex: Math.max(0, RESPAWN_MODES.indexOf(record.respawnMode)),
    })
        .submitButton(t("xiaobo.fp.form.respawn.submit"))
        .show(player);
    if (response.canceled || !ready(player, services))
        return;
    const index = response.formValues?.[0];
    const mode = typeof index === "number" ? RESPAWN_MODES[index] : undefined;
    if (mode === undefined)
        return sendError(player, "复活规则无效。");
    await runRecordMutation(player, services, () => services.lifecycle.setRespawnRule(actorIdentity(player), record.id, record.recordRevision, mode, mode === "manual" ? playerLocation(player) : undefined));
}
async function confirmPurge(player, services, record) {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.delete.title"))
        .body({ translate: "xiaobo.fp.form.delete.body", with: [record.name, record.id] })
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services))
        return;
    const result = services.lifecycle.purge(actorIdentity(player), record.id, record.recordRevision);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.deleted", with: [result.value.name] });
    await openMainForm(player, services);
}
async function confirmRecycleDelete(player, services, record) {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.recycle_delete.title"))
        .body({ translate: "xiaobo.fp.form.recycle_delete.body", with: [record.name, record.id] })
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.recycle_delete.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services))
        return;
    const result = services.lifecycle.recycle(actorIdentity(player), record.id, record.recordRevision);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.recycled", with: [result.value.name] });
    await openMainForm(player, services);
}
async function openPermissionsForm(player, services) {
    await formBoundary(player, "permissions", async () => {
        if (!ready(player, services))
            return;
        const actor = actorIdentity(player);
        if (!actor.isOperator)
            return sendError(player, "只有 OP 可以修改权限。");
        const targets = world.getAllPlayers().filter(isRealPlayer);
        if (targets.length === 0)
            return sendError(player, "当前没有可管理的在线真人玩家。");
        const form = new ActionFormData()
            .title(t("xiaobo.fp.form.permissions.title"))
            .body(t("xiaobo.fp.form.permissions.body"));
        targets.forEach((target) => form.button(target.name));
        const response = await form.show(player);
        if (response.canceled || response.selection === undefined || !ready(player, services))
            return;
        const target = targets[response.selection];
        if (target === undefined || target.playfabId.length === 0)
            return sendError(player, "目标玩家无效。");
        await openPermissionEditor(player, services, target.playfabId, target.name);
    });
}
async function openPermissionEditor(player, services, targetId, targetName) {
    const grants = services.permissions.list(actorIdentity(player));
    if (!grants.ok)
        return sendError(player, grants.error.message);
    const current = grantFor(grants.value, targetId);
    const response = await new ModalFormData()
        .title(targetName)
        .toggle(t("xiaobo.fp.form.permissions.place"), { defaultValue: current.canPlace })
        .toggle(t("xiaobo.fp.form.permissions.set"), { defaultValue: current.canSet })
        .submitButton(t("xiaobo.fp.form.permissions.submit"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const latestActor = actorIdentity(player);
    if (!latestActor.isOperator)
        return sendError(player, "只有 OP 可以修改权限。");
    const target = world.getAllPlayers().filter(isRealPlayer)
        .find((candidate) => candidate.playfabId === targetId);
    if (target === undefined)
        return sendError(player, "目标玩家已离线，未修改权限。");
    const [canPlace, canSet] = response.formValues;
    if (typeof canPlace !== "boolean" || typeof canSet !== "boolean") {
        return sendError(player, "权限表单数据无效。");
    }
    const placeResult = services.permissions.setGrant(latestActor, {
        playerId: targetId,
        lastKnownName: target.name,
    }, "can_place", canPlace);
    if (!placeResult.ok)
        return sendError(player, placeResult.error.message);
    const setResult = services.permissions.setGrant(latestActor, {
        playerId: targetId,
        lastKnownName: target.name,
    }, "can_set", canSet);
    if (!setResult.ok)
        return sendError(player, setResult.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.permissions_ok", with: [target.name] });
    await openPermissionsForm(player, services);
}
export async function openRecoveryForm(player, services) {
    await formBoundary(player, "recovery", () => showRecoveryForm(player, services));
}
async function showRecoveryForm(player, services) {
    if (!ready(player, services))
        return;
    const actor = actorIdentity(player);
    if (!actor.isOperator)
        return sendError(player, "只有 OP 可以使用恢复中心。");
    const records = services.lifecycle.list(actorIdentity(player));
    if (!records.ok)
        return sendError(player, records.error.message);
    const pending = services.inventory.listPendingTransfers(actor);
    if (!pending.ok)
        return sendError(player, pending.error.message);
    const exceptional = records.value.filter((record) => record.lifecycle.kind !== "online"
        && record.lifecycle.kind !== "offline");
    const lifecycleBody = exceptional.length === 0
        ? t("xiaobo.fp.form.recovery.no_lifecycle")
        : exceptional.map((record) => `${record.id} ${record.name}: ${record.lifecycle.kind}`).join("\n");
    const lifecycleMessage = typeof lifecycleBody === "string"
        ? { text: lifecycleBody }
        : lifecycleBody;
    const body = pending.value.length === 0
        ? { rawtext: [lifecycleMessage, { text: "\n" }, t("xiaobo.fp.form.recovery.no_pending")] }
        : lifecycleBody;
    const actions = [];
    const form = new ActionFormData()
        .title(t("xiaobo.fp.form.main.recovery"))
        .body(body);
    for (const transfer of pending.value) {
        form.button(`${transfer.kind} · ${transfer.phase}\n${transfer.fakePlayerId} -> ${transfer.playerId}`);
        actions.push(async () => {
            const result = services.inventory.retryPendingTransfer(actorIdentity(player), transfer.id);
            if (!result.ok)
                return sendError(player, result.error.message);
            player.sendMessage({ translate: "xiaobo.fp.message.recovery_ok", with: [transfer.id] });
            await openRecoveryForm(player, services);
        });
    }
    form.button(t("xiaobo.fp.form.back"));
    actions.push(() => openMainForm(player, services));
    const response = await form.show(player);
    const action = response.selection === undefined ? undefined : actions[response.selection];
    if (!response.canceled && action !== undefined && player.isValid && ready(player, services))
        await action();
}
async function runRecordMutation(player, services, mutation) {
    if (!ready(player, services))
        return;
    const result = mutation();
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.saved", with: [result.value.name] });
    await openDetailForm(player, services, result.value);
}
function finitePoint(point) {
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}
function sortRecords(records, player) {
    return [...records].sort((left, right) => {
        const leftSameDimension = left.location.dimension === player.dimension.id;
        const rightSameDimension = right.location.dimension === player.dimension.id;
        if (leftSameDimension !== rightSameDimension)
            return leftSameDimension ? -1 : 1;
        if (leftSameDimension)
            return distanceSquared(left.location.position, player.location)
                - distanceSquared(right.location.position, player.location);
        return left.id.localeCompare(right.id);
    });
}
function distanceSquared(left, right) {
    return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}
function grantFor(grants, playerId) {
    return grants.find((grant) => grant.playerId === playerId) ?? { canPlace: false, canSet: false };
}
