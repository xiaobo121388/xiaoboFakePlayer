import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { err, ok } from "../../domain/results.js";
import { actorIdentity } from "../playerContext.js";
import { formBoundary, ready, sendError, t } from "./formSupport.js";
export async function openInventoryForm(player, services, record, onBack) {
    await formBoundary(player, `inventory:${record.id}`, async () => {
        if (!ready(player, services))
            return;
        const current = loadCurrentRecord(player, services, record.id);
        if (!current.ok)
            return sendError(player, current.error.message);
        const currentRecord = current.value;
        const result = services.inventory.getOverview(actorIdentity(player), currentRecord.id, currentRecord.recordRevision);
        if (!result.ok)
            return sendError(player, result.error.message);
        const overview = result.value;
        const actions = [];
        const form = new ActionFormData()
            .title({ translate: "xiaobo.fp.form.inventory.title", with: [currentRecord.name] })
            .body({
            translate: "xiaobo.fp.form.inventory.body",
            with: [
                String(overview.selectedSlot),
                String(overview.totalExperience),
                overview.lastCheckpointTick === null ? "-" : String(overview.lastCheckpointTick),
            ],
        });
        form.button(t("xiaobo.fp.form.inventory.swap_mainhand"));
        actions.push(() => runTransfer(player, services, currentRecord, {
            kind: "swap",
            fakeSlot: overview.selectedSlot,
            playerSlot: player.selectedSlotIndex,
        }, onBack));
        form.button(t("xiaobo.fp.form.inventory.swap_offhand"));
        actions.push(() => runTransfer(player, services, currentRecord, {
            kind: "swap",
            fakeSlot: 40,
            playerSlot: 40,
        }, onBack));
        form.button(t("xiaobo.fp.form.inventory.swap_inventory"));
        actions.push(() => runTransfer(player, services, currentRecord, {
            kind: "swap_inventory",
        }, onBack));
        form.button(t("xiaobo.fp.form.inventory.swap_equipment"));
        actions.push(() => runTransfer(player, services, currentRecord, {
            kind: "swap_equipment",
        }, onBack));
        form.button(t("xiaobo.fp.form.inventory.internal_swap"));
        actions.push(() => openInternalSwapForm(player, services, currentRecord, onBack));
        form.button(t("xiaobo.fp.form.inventory.experience"));
        actions.push(() => openExperienceForm(player, services, currentRecord, overview, onBack));
        form.button(t("xiaobo.fp.form.inventory.recycle_all"));
        actions.push(() => confirmRecycleAll(player, services, currentRecord, onBack));
        form.button(t("xiaobo.fp.form.inventory.recycle_contents"));
        actions.push(() => confirmRecycleContents(player, services, currentRecord, onBack));
        for (const slot of overview.slots) {
            form.button(slotButtonLabel(slot, overview.selectedSlot));
            actions.push(() => openSlotForm(player, services, currentRecord, overview, slot, onBack));
        }
        form.button(t("xiaobo.fp.form.back"));
        actions.push(() => onBack(currentRecord));
        const response = await form.show(player);
        const action = response.selection === undefined ? undefined : actions[response.selection];
        if (!response.canceled && action !== undefined && player.isValid && ready(player, services)) {
            await action();
        }
    });
}
async function openSlotForm(player, services, record, overview, slot, onBack) {
    const actions = [];
    const form = new ActionFormData()
        .title(slotDisplayName(slot.slot))
        .body(itemDetails(slot.item));
    form.button(t("xiaobo.fp.form.inventory.swap_current"));
    actions.push(() => runTransfer(player, services, record, {
        kind: "swap",
        fakeSlot: slot.slot,
        playerSlot: player.selectedSlotIndex,
    }, onBack));
    if (slot.item !== null) {
        form.button(t("xiaobo.fp.form.inventory.take_current"));
        actions.push(() => runTransfer(player, services, record, {
            kind: "take",
            fakeSlot: slot.slot,
            playerSlot: player.selectedSlotIndex,
        }, onBack));
    }
    form.button(t("xiaobo.fp.form.inventory.put_current"));
    actions.push(() => runTransfer(player, services, record, {
        kind: "put",
        fakeSlot: slot.slot,
        playerSlot: player.selectedSlotIndex,
    }, onBack));
    form.button(t("xiaobo.fp.form.back"));
    actions.push(() => openInventoryForm(player, services, record, onBack));
    const response = await form.show(player);
    const action = response.selection === undefined ? undefined : actions[response.selection];
    if (!response.canceled && action !== undefined && player.isValid && ready(player, services)) {
        await action();
    }
}
async function openInternalSwapForm(player, services, record, onBack) {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.inventory.internal_swap"))
        .textField(t("xiaobo.fp.form.inventory.first_slot"), "0-40", { defaultValue: "0" })
        .textField(t("xiaobo.fp.form.inventory.second_slot"), "0-40", { defaultValue: "1" })
        .submitButton(t("xiaobo.fp.form.inventory.confirm"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const firstSlot = Number(response.formValues[0]);
    const secondSlot = Number(response.formValues[1]);
    await runTransfer(player, services, record, {
        kind: "swap_fake",
        firstSlot,
        secondSlot,
    }, onBack);
}
async function openExperienceForm(player, services, record, overview, onBack) {
    const response = await new ModalFormData()
        .title(t("xiaobo.fp.form.inventory.experience"))
        .textField(t("xiaobo.fp.form.inventory.experience_amount"), "1", {
        defaultValue: String(overview.totalExperience),
    })
        .submitButton(t("xiaobo.fp.form.inventory.confirm"))
        .show(player);
    if (response.canceled || response.formValues === undefined || !ready(player, services))
        return;
    const amount = Number(response.formValues[0]);
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok)
        return sendError(player, current.error.message);
    const result = services.inventory.transferExperience(actorIdentity(player), current.value.id, current.value.recordRevision, amount);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.inventory_saved", with: [result.value.name] });
    await openInventoryForm(player, services, result.value, onBack);
}
async function confirmRecycleAll(player, services, record, onBack) {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.inventory.recycle_all"))
        .body(t("xiaobo.fp.form.inventory.recycle_all_body"))
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.inventory.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services))
        return;
    await runTransfer(player, services, record, { kind: "recycle_all" }, onBack);
}
async function confirmRecycleContents(player, services, record, onBack) {
    const response = await new MessageFormData()
        .title(t("xiaobo.fp.form.inventory.recycle_contents"))
        .body(t("xiaobo.fp.form.inventory.recycle_contents_body"))
        .button1(t("xiaobo.fp.form.cancel"))
        .button2(t("xiaobo.fp.form.inventory.confirm"))
        .show(player);
    if (response.canceled || response.selection !== 1 || !ready(player, services))
        return;
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok)
        return sendError(player, current.error.message);
    const result = services.inventory.recycleContents(actorIdentity(player), current.value.id, current.value.recordRevision);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.inventory_recycled", with: [result.value.name] });
    await openInventoryForm(player, services, result.value, onBack);
}
async function runTransfer(player, services, record, request, onBack) {
    if (!ready(player, services))
        return;
    const current = loadCurrentRecord(player, services, record.id);
    if (!current.ok)
        return sendError(player, current.error.message);
    const result = services.inventory.transferItems(actorIdentity(player), current.value.id, current.value.recordRevision, request);
    if (!result.ok)
        return sendError(player, result.error.message);
    player.sendMessage({ translate: "xiaobo.fp.message.inventory_saved", with: [result.value.name] });
    await openInventoryForm(player, services, result.value, onBack);
}
function loadCurrentRecord(player, services, id) {
    const listed = services.lifecycle.list(actorIdentity(player));
    if (!listed.ok)
        return listed;
    const record = listed.value.find((candidate) => candidate.id === id);
    return record === undefined ? err("NOT_FOUND", `未找到假人 ${id}。`) : ok(record);
}
function slotButtonLabel(slot, selectedSlot) {
    const rawtext = [];
    if (slot.slot === selectedSlot)
        rawtext.push({ text: "* " });
    rawtext.push(slotDisplayName(slot.slot), { text: "\n" });
    const item = slot.item;
    rawtext.push(item === null
        ? t("xiaobo.fp.form.inventory.empty")
        : {
            translate: "xiaobo.fp.form.inventory.item_amount",
            with: [item.nameTag ?? item.typeId, String(item.amount)],
        });
    return { rawtext };
}
function slotDisplayName(slot) {
    const equipmentKeys = ["head", "chest", "legs", "feet", "offhand"];
    const category = slot < 9
        ? "hotbar"
        : slot < 36
            ? "inventory"
            : equipmentKeys[slot - 36] ?? "equipment";
    return {
        rawtext: [
            { text: `#${slot} · ` },
            t(`xiaobo.fp.form.inventory.slot.${category}`),
        ],
    };
}
function itemDetails(item) {
    if (item === null)
        return t("xiaobo.fp.form.inventory.empty");
    const rawtext = [{
            translate: "xiaobo.fp.form.inventory.item_amount",
            with: [item.typeId, String(item.amount)],
        }];
    if (item.nameTag !== null)
        rawtext.push({ text: `\n${item.nameTag}` });
    for (const line of item.lore)
        rawtext.push({ text: `\n${line}` });
    if (item.durability !== null) {
        const current = item.durability.maxDurability - item.durability.damage;
        rawtext.push({ text: "\n" }, {
            translate: "xiaobo.fp.form.inventory.durability",
            with: [String(current), String(item.durability.maxDurability)],
        });
        if (item.durability.unbreakable) {
            rawtext.push({ text: " · " }, t("xiaobo.fp.form.inventory.unbreakable"));
        }
    }
    if (item.enchantments.length > 0) {
        rawtext.push({
            text: `\n${item.enchantments
                .map((enchantment) => `${enchantment.typeId} ${enchantment.level}`)
                .join(", ")}`,
        });
    }
    return { rawtext };
}
//# sourceMappingURL=inventory.js.map