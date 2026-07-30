import { err, ok, type Result } from "./results.js";

export const INVENTORY_SLOT_COUNT = 36;
export const HOTBAR_SLOT_COUNT = 9;
export const TOTAL_SLOT_COUNT = 41;

export const EQUIPMENT_SLOT = {
    head: 36,
    chest: 37,
    legs: 38,
    feet: 39,
    offhand: 40,
} as const;

export interface StructureSlot {
    readonly barrel: "A" | "B";
    readonly slot: number;
}

export function toStructureSlot(logicalSlot: number): Result<StructureSlot> {
    if (!Number.isInteger(logicalSlot) || logicalSlot < 0 || logicalSlot >= TOTAL_SLOT_COUNT) {
        return err("INVALID_SLOT", `无效假人槽位：${logicalSlot}。`);
    }
    if (logicalSlot <= 26) {
        return ok({ barrel: "A", slot: logicalSlot });
    }
    if (logicalSlot <= 35) {
        return ok({ barrel: "B", slot: logicalSlot - 27 });
    }
    return ok({ barrel: "B", slot: logicalSlot - 27 });
}

export function fromStructureSlot(structureSlot: StructureSlot): Result<number> {
    const { barrel, slot } = structureSlot;
    if (!Number.isInteger(slot) || slot < 0 || slot > 26) {
        return err("INVALID_SLOT", `无效结构槽位：${barrel}${slot}。`);
    }
    if (barrel === "A") {
        return slot <= 26 ? ok(slot) : err("INVALID_SLOT", `无效结构槽位：${barrel}${slot}。`);
    }
    if (slot <= 13) {
        return ok(slot + 27);
    }
    return err("INVALID_SLOT", `结构槽位 ${barrel}${slot} 未用于假人快照。`);
}