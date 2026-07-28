import { Player, type RawMessage } from "@minecraft/server";

import type { CommandServices } from "../commands.js";

export async function formBoundary(
    player: Player,
    operation: string,
    work: () => Promise<void>,
): Promise<void> {
    try {
        await work();
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[xiaobo-fake-player] form ${operation} failed: ${message}`);
        if (player.isValid) player.sendMessage(`§c表单操作失败：${message}§r`);
    }
}

export function ready(player: Player, services: CommandServices): boolean {
    if (!player.isValid) return false;
    const status = services.getStartupStatus();
    if (status.state === "ready") return true;
    player.sendMessage(status.state === "blocked"
        ? `§c假人系统处于只读隔离：${status.message ?? "未知恢复错误"}§r`
        : "§e假人系统正在恢复，请稍后重试。§r");
    return false;
}

export function sendError(player: Player, message: string): void {
    player.sendMessage(`§c${message}§r`);
}

export function t(key: string): RawMessage {
    return { translate: key };
}