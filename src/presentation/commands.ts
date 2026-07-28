import {
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus,
    Entity,
    Player,
    system,
    world,
    type CustomCommandOrigin,
    type CustomCommandRegistry,
} from "@minecraft/server";

import type { BehaviorService, FakePlayerAction } from "../application/behaviorService.js";
import type { InventoryService } from "../application/inventoryService.js";
import type { LifecycleService } from "../application/lifecycleService.js";
import type { GrantKind, PermissionService } from "../application/permissionService.js";
import { CAPABILITY_MATRIX, isCapabilityEnabled } from "../domain/capabilities.js";
import type { FakePlayerGameMode, FakePlayerRecord, RespawnMode } from "../domain/model.js";
import type { ActorIdentity } from "../domain/permissions.js";
import type { BlockFace } from "../application/ports.js";
import { openMainForm, openRecoveryForm } from "./forms/main.js";
import { actorIdentity, isRealPlayer, playerLocation } from "./playerContext.js";

export interface StartupStatus {
    readonly state: "recovering" | "ready" | "blocked";
    readonly message?: string;
}

export interface CommandServices {
    readonly behavior: BehaviorService;
    readonly inventory: InventoryService;
    readonly lifecycle: LifecycleService;
    readonly permissions: PermissionService;
    getStartupStatus(): StartupStatus;
}

type PlayerCommand = (player: Player, actor: ActorIdentity, args: readonly unknown[]) => void;

export function registerCommands(registry: CustomCommandRegistry, services: CommandServices): void {
    registry.registerEnum("xiaobo:fake_player_game_mode", ["survival", "creative", "adventure", "spectator"]);
    registry.registerEnum("xiaobo:fake_player_skin_mode", ["default", "copy_actor"]);
    registry.registerEnum("xiaobo:fake_player_online_location", ["saved", "here"]);
    registry.registerEnum("xiaobo:fake_player_permission_kind", ["can_place", "can_set"]);
    registry.registerEnum("xiaobo:fake_player_toggle", ["on", "off"]);
    registry.registerEnum("xiaobo:fake_player_delete_mode", ["recycle", "purge"]);
    registry.registerEnum("xiaobo:fake_player_respawn_mode", ["death_location", "manual", "player_spawn"]);
    registry.registerEnum("xiaobo:fake_player_block_face", ["down", "east", "north", "south", "up", "west"]);

    registry.registerCommand({
        name: "xiaobo:fpset",
        description: "打开挂机假人管理界面",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    }, schedulePlayerCommand(services, (player) => {
        void openMainForm(player, services);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_spawn",
        description: "创建挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: [
            { name: "name", type: CustomCommandParamType.String },
            { name: "gameMode", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_game_mode" },
            { name: "skin", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_skin_mode" },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const requestedName = typeof args[0] === "string" ? args[0] : "假人";
        const gameMode = parseGameMode(args[1]);
        const skinMode = parseSkinMode(args[2]);
        if (gameMode === undefined || skinMode === undefined) {
            player.sendMessage("§c无效参数。游戏模式使用 survival|creative|adventure|spectator，皮肤使用 default|copy_actor。§r");
            return;
        }
        const result = services.lifecycle.create(actor, {
            requestedName,
            location: playerLocation(player),
            gameMode,
            skinMode,
            unavailablePlayerNames: world.getAllPlayers().map((candidate) => candidate.name),
        });
        player.sendMessage(result.ok
            ? `§a已创建假人 ${result.value.name}（${result.value.id}）。§r`
            : `§c创建失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_list",
        description: "列出挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    }, schedulePlayerCommand(services, (player, actor) => {
        const result = services.lifecycle.list(actor);
        if (!result.ok) {
            player.sendMessage(`§c读取失败：${result.error.message}§r`);
            return;
        }
        if (result.value.length === 0) {
            player.sendMessage("当前没有挂机假人。");
            return;
        }
        player.sendMessage(result.value.map(formatRecord).join("\n"));
    }));

    registry.registerCommand({
        name: "xiaobo:fp_recovery",
        description: "打开挂机假人恢复中心",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    }, schedulePlayerCommand(services, (player, actor) => {
        if (!actor.isOperator) {
            player.sendMessage("§c只有 OP 可以使用恢复中心。§r");
            return;
        }
        void openRecoveryForm(player, services);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_diagnose",
        description: "只读输出挂机假人恢复与能力状态",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        if (!actor.isOperator) {
            player.sendMessage("§c只有 OP 可以读取假人系统诊断。§r");
            return;
        }
        const startup = services.getStartupStatus();
        const lines = [
            `§b小波挂机假人诊断§r 26.34 / ${CAPABILITY_MATRIX.serverVersion}`,
            `startup=${startup.state}${startup.message === undefined ? "" : ` (${startup.message})`}`,
        ];
        const listed = services.lifecycle.list(actor);
        if (!listed.ok) {
            lines.push(`catalog=unavailable (${listed.error.message})`);
        } else {
            const reference = typeof args[0] === "string" ? args[0].trim().toLowerCase() : undefined;
            const records = reference === undefined || reference.length === 0
                ? listed.value
                : listed.value.filter((record) => record.id.toLowerCase() === reference
                    || record.name.toLowerCase() === reference);
            lines.push(`records=${listed.value.length}`);
            records.forEach((record) => lines.push(
                `${record.id} ${record.name}: lifecycle=${record.lifecycle.kind}, record=${record.recordRevision}, `
                + `inventory=${record.inventoryRevision ?? "-"}, skin=${record.skin.kind}`,
            ));
            if (reference !== undefined && reference.length > 0 && records.length === 0) {
                lines.push(`record=${args[0]} not-found`);
            }
        }
        const pending = services.inventory.listPendingTransfers(actor);
        if (!pending.ok) {
            lines.push(`operations=unavailable (${pending.error.message})`);
        } else {
            lines.push(`pending=${pending.value.length}`);
            pending.value.forEach((operation) => lines.push(
                `${operation.id}: ${operation.kind}/${operation.phase} fake=${operation.fakePlayerId} player=${operation.playerId}`,
            ));
        }
        lines.push("capabilities:");
        CAPABILITY_MATRIX.capabilities.forEach((capability) => lines.push(
            `${capability.id}=${capability.availability}/${capability.verification}`,
        ));
        player.sendMessage(lines.join("\n"));
    }, true));

    registry.registerCommand({
        name: "xiaobo:fp_offline",
        description: "安全下线挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        if (typeof record === "string") {
            player.sendMessage(`§c${record}§r`);
            return;
        }
        const result = services.lifecycle.takeOffline(actor, record.id, record.recordRevision);
        player.sendMessage(result.ok
            ? `§a假人 ${result.value.name} 已完成快照并下线。§r`
            : `§c下线失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_online",
        description: "上线挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
        optionalParameters: [{
            name: "location",
            type: CustomCommandParamType.Enum,
            enumName: "xiaobo:fake_player_online_location",
        }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        if (typeof record === "string") {
            player.sendMessage(`§c${record}§r`);
            return;
        }
        const locationMode = args[1] === undefined ? "saved" : args[1];
        if (locationMode !== "saved" && locationMode !== "here") {
            player.sendMessage("§c无效位置模式。请选择 saved 或 here。§r");
            return;
        }
        const result = services.lifecycle.bringOnline(
            actor,
            record.id,
            record.recordRevision,
            locationMode === "here" ? playerLocation(player) : undefined,
        );
        player.sendMessage(result.ok
            ? `§a假人 ${result.value.name} 已上线。§r`
            : `§c上线失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_permission",
        description: "设置玩家的假人权限",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "player", type: CustomCommandParamType.PlayerSelector },
            { name: "permission", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_permission_kind" },
            { name: "enabled", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_toggle" },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const targets = Array.isArray(args[0]) ? args[0].filter(isRealPlayer) : [];
        const permission = args[1];
        const enabled = args[2];
        if (targets.length !== 1 || (permission !== "can_place" && permission !== "can_set")
            || (enabled !== "on" && enabled !== "off")) {
            player.sendMessage("§c请恰好选择一名在线真人，并提供 can_place|can_set 与 on|off。§r");
            return;
        }
        const target = targets[0];
        if (target === undefined || target.playfabId.length === 0) {
            player.sendMessage("§c目标必须是拥有 PlayFab ID 的真人玩家。§r");
            return;
        }
        const result = services.permissions.setGrant(actor, {
            playerId: target.playfabId,
            lastKnownName: target.name,
        }, permission as GrantKind, enabled === "on");
        player.sendMessage(result.ok
            ? `§a${target.name} 的 ${permission} 已设为 ${enabled}。§r`
            : `§c权限修改失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_rename",
        description: "重命名并安全重载挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "newName", type: CustomCommandParamType.String },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        if (typeof record === "string" || typeof args[1] !== "string") {
            player.sendMessage(`§c${typeof record === "string" ? record : "必须提供新名称。"}§r`);
            return;
        }
        const result = services.lifecycle.rename(actor, record.id, record.recordRevision, {
            requestedName: args[1],
            unavailablePlayerNames: world.getAllPlayers().map((candidate) => candidate.name),
        });
        player.sendMessage(result.ok
            ? `§a假人已重命名为 ${result.value.name}。§r`
            : `§c重命名失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_delete",
        description: "删除已下线挂机假人，默认回收物品和经验",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
        optionalParameters: [
            { name: "mode", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_delete_mode" },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        const mode = args[1] ?? "recycle";
        if (typeof record === "string" || (mode !== "recycle" && mode !== "purge")) {
            player.sendMessage(`§c${typeof record === "string" ? record : "删除模式必须是 recycle 或 purge。"}§r`);
            return;
        }
        const result = mode === "purge"
            ? services.lifecycle.purge(actor, record.id, record.recordRevision)
            : services.lifecycle.recycle(actor, record.id, record.recordRevision);
        player.sendMessage(result.ok
            ? mode === "purge"
                ? `§a已彻底删除假人 ${result.value.name}（${result.value.id}）及其快照。§r`
                : `§a已回收假人 ${result.value.name} 的物品和经验并删除记录。§r`
            : `§c删除失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_respawn",
        description: "手动复活挂机假人",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        if (typeof record === "string") {
            player.sendMessage(`§c${record}§r`);
            return;
        }
        const result = services.lifecycle.respawn(actor, record.id, record.recordRevision);
        player.sendMessage(result.ok
            ? `§a假人 ${result.value.name} 已复活并建立新库存快照。§r`
            : `§c复活失败：${result.error.message}§r`);
    }));

    registry.registerCommand({
        name: "xiaobo:fp_respawnrule",
        description: "设置挂机假人的复活规则",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "mode", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_respawn_mode" },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const record = findRecord(services.lifecycle, actor, args[0]);
        const mode = parseRespawnMode(args[1]);
        if (typeof record === "string" || mode === undefined) {
            player.sendMessage(`§c${typeof record === "string" ? record : "无效复活规则。"}§r`);
            return;
        }
        const result = services.lifecycle.setRespawnRule(
            actor,
            record.id,
            record.recordRevision,
            mode,
            mode === "manual" ? playerLocation(player) : undefined,
        );
        player.sendMessage(result.ok
            ? `§a假人 ${result.value.name} 的复活规则已设为 ${mode}。§r`
            : `§c设置失败：${result.error.message}§r`);
    }));

    registerBehaviorCommands(registry, services);
}

function registerBehaviorCommands(registry: CustomCommandRegistry, services: CommandServices): void {
    registerCoordinateAction(registry, services, "fp_lookat", "让挂机假人看向坐标", "look_at");
    registerCoordinateAction(registry, services, "fp_navigate", "让挂机假人导航到坐标", "navigate", true);
    registerCoordinateAction(registry, services, "fp_move", "让挂机假人直线移动到坐标", "move_to", true);

    registry.registerCommand({
        name: "xiaobo:fp_rotate",
        description: "让挂机假人相对旋转",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "angle", type: CustomCommandParamType.Float },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        performForRecord(services, player, actor, args[0], { kind: "rotate", angle: numberArgument(args[1]) });
    }));

    registry.registerCommand({
        name: "xiaobo:fp_setrotation",
        description: "设置挂机假人的绝对身体朝向",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "angle", type: CustomCommandParamType.Float },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        performForRecord(services, player, actor, args[0], { kind: "set_rotation", angle: numberArgument(args[1]) });
    }));

    registry.registerCommand({
        name: "xiaobo:fp_tp_here",
        description: "将挂机假人传送到执行者位置",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        performForRecord(services, player, actor, args[0], { kind: "teleport", location: playerLocation(player) });
    }));

    registerSimpleAction(registry, services, "fp_jump", "让挂机假人跳跃", { kind: "jump" });
    registerSimpleAction(registry, services, "fp_stop", "停止挂机假人当前动作", { kind: "stop" });

    if (isCapabilityEnabled("sneaking")) {
        registry.registerCommand({
            name: "xiaobo:fp_sneak",
            description: "切换挂机假人潜行状态",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [
                { name: "idOrName", type: CustomCommandParamType.String },
                { name: "enabled", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_toggle" },
            ],
        }, schedulePlayerCommand(services, (player, actor, args) => {
            if (args[1] !== "on" && args[1] !== "off") {
                player.sendMessage("§c潜行状态必须是 on 或 off。§r");
                return;
            }
            performForRecord(services, player, actor, args[0], {
                kind: "set_sneaking",
                enabled: args[1] === "on",
            });
        }));
    }

    registry.registerCommand({
        name: "xiaobo:fp_useitem",
        description: "使用挂机假人真实库存槽位中的物品",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "slot", type: CustomCommandParamType.Integer },
        ],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        performForRecord(services, player, actor, args[0], { kind: "use_item", slot: numberArgument(args[1]) });
    }));

    registerBlockAction(registry, services, "fp_break", "让挂机假人挖掘方块", "break_block", false);
    registerBlockAction(registry, services, "fp_interactblock", "让挂机假人与方块交互", "interact_block", false);
    registerBlockAction(registry, services, "fp_useitemonblock", "使用真实库存槽位作用于方块", "use_item_on_block", true);
    registerEntityAction(registry, services, "fp_attack", "让挂机假人攻击实体", "attack_entity");
    registerEntityAction(registry, services, "fp_interactentity", "让挂机假人与实体交互", "interact_entity");
    registerEntityAction(registry, services, "fp_lookatentity", "让挂机假人看向实体", "look_at_entity");
    registerEntityAction(registry, services, "fp_follow", "让挂机假人导航跟随实体", "navigate_entity", true);
}

function registerCoordinateAction(
    registry: CustomCommandRegistry,
    services: CommandServices,
    name: string,
    description: string,
    kind: "look_at" | "move_to" | "navigate",
    withSpeed = false,
): void {
    registry.registerCommand({
        name: `xiaobo:${name}`,
        description,
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "location", type: CustomCommandParamType.Location },
        ],
        optionalParameters: withSpeed ? [{ name: "speed", type: CustomCommandParamType.Float }] : undefined,
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const position = pointArgument(args[1]);
        const speed = withSpeed && args[2] !== undefined ? numberArgument(args[2]) : undefined;
        const action = kind === "look_at"
            ? { kind, dimension: player.dimension.id, position } as const
            : { kind, dimension: player.dimension.id, position, speed } as const;
        performForRecord(services, player, actor, args[0], action);
    }));
}

function registerSimpleAction(
    registry: CustomCommandRegistry,
    services: CommandServices,
    name: string,
    description: string,
    action: FakePlayerAction,
): void {
    registry.registerCommand({
        name: `xiaobo:${name}`,
        description,
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "idOrName", type: CustomCommandParamType.String }],
    }, schedulePlayerCommand(services, (player, actor, args) => {
        performForRecord(services, player, actor, args[0], action);
    }));
}

function registerBlockAction(
    registry: CustomCommandRegistry,
    services: CommandServices,
    name: string,
    description: string,
    kind: "break_block" | "interact_block" | "use_item_on_block",
    withSlot: boolean,
): void {
    const mandatoryParameters = [
        { name: "idOrName", type: CustomCommandParamType.String },
        ...(withSlot ? [{ name: "slot", type: CustomCommandParamType.Integer }] : []),
        { name: "location", type: CustomCommandParamType.Location },
        { name: "face", type: CustomCommandParamType.Enum, enumName: "xiaobo:fake_player_block_face" },
    ];
    registry.registerCommand({
        name: `xiaobo:${name}`,
        description,
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters,
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const locationIndex = withSlot ? 2 : 1;
        const faceIndex = withSlot ? 3 : 2;
        const face = blockFaceArgument(args[faceIndex]);
        const position = pointArgument(args[locationIndex]);
        const action: FakePlayerAction = kind === "use_item_on_block"
            ? { kind, slot: numberArgument(args[1]), dimension: player.dimension.id, position, face }
            : kind === "break_block"
                ? { kind, dimension: player.dimension.id, position, face }
                : { kind, dimension: player.dimension.id, position, face };
        performForRecord(services, player, actor, args[0], action);
    }));
}

function registerEntityAction(
    registry: CustomCommandRegistry,
    services: CommandServices,
    name: string,
    description: string,
    kind: "attack_entity" | "interact_entity" | "look_at_entity" | "navigate_entity",
    withSpeed = false,
): void {
    registry.registerCommand({
        name: `xiaobo:${name}`,
        description,
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        mandatoryParameters: [
            { name: "idOrName", type: CustomCommandParamType.String },
            { name: "target", type: CustomCommandParamType.EntitySelector },
        ],
        optionalParameters: withSpeed ? [{ name: "speed", type: CustomCommandParamType.Float }] : undefined,
    }, schedulePlayerCommand(services, (player, actor, args) => {
        const target = entityArgument(args[1]);
        if (target instanceof Error) {
            player.sendMessage(`§c${target.message}§r`);
            return;
        }
        const action: FakePlayerAction = kind === "navigate_entity"
            ? { kind, targetId: target.id, speed: args[2] === undefined ? undefined : numberArgument(args[2]) }
            : { kind, targetId: target.id };
        performForRecord(services, player, actor, args[0], action);
    }));
}

function performForRecord(
    services: CommandServices,
    player: Player,
    actor: ActorIdentity,
    reference: unknown,
    action: FakePlayerAction,
): void {
    const record = findRecord(services.lifecycle, actor, reference);
    if (typeof record === "string") {
        player.sendMessage(`§c${record}§r`);
        return;
    }
    const result = services.behavior.perform(actor, record.id, record.recordRevision, action);
    if (!result.ok) {
        player.sendMessage(`§c动作失败：${result.error.message}§r`);
        return;
    }
    const pathMessage = result.value.fullPath === false ? "，但未找到完整路径" : "";
    player.sendMessage(`§a假人 ${record.name} 已接受 ${action.kind} 动作${pathMessage}。§r`);
}

function schedulePlayerCommand(
    services: CommandServices,
    command: PlayerCommand,
    allowWhenNotReady = false,
): (origin: CustomCommandOrigin, ...args: unknown[]) => { status: CustomCommandStatus; message?: string } {
    return (origin, ...args) => {
        const source = origin.sourceEntity;
        if (!isRealPlayer(source)) {
            return { status: CustomCommandStatus.Failure, message: "该命令只能由真人玩家执行。" };
        }
        system.run(() => {
            if (!source.isValid) return;
            const startup = services.getStartupStatus();
            if (!allowWhenNotReady && startup.state !== "ready") {
                source.sendMessage(startup.state === "blocked"
                    ? `§c假人系统处于只读隔离：${startup.message ?? "未知恢复错误"}§r`
                    : "§e假人系统正在恢复，请稍后重试。§r");
                return;
            }
            try {
                command(source, actorIdentity(source), args);
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                console.error(`[xiaobo-fake-player] command failed: ${message}`);
                source.sendMessage(`§c假人操作发生引擎错误：${message}§r`);
            }
        });
        return { status: CustomCommandStatus.Success, message: "假人操作已排队。" };
    };
}

function parseGameMode(value: unknown): FakePlayerGameMode | undefined {
    return value === undefined
        ? "survival"
        : value === "survival" || value === "creative" || value === "adventure" || value === "spectator"
            ? value
            : undefined;
}

function findRecord(
    service: LifecycleService,
    actor: ActorIdentity,
    reference: unknown,
): FakePlayerRecord | string {
    if (typeof reference !== "string" || reference.trim().length === 0) return "必须提供假人 ID 或名称。";
    const listed = service.list(actor);
    if (!listed.ok) return listed.error.message;
    const normalized = reference.trim().toLowerCase();
    return listed.value.find((record) => record.id.toLowerCase() === normalized || record.name.toLowerCase() === normalized)
        ?? `未找到假人 ${reference}。`;
}

function formatRecord(record: FakePlayerRecord): string {
    const position = record.location.position;
    return `§b${record.id}§r ${record.name} [${record.lifecycle.kind}] ${record.location.dimension} `
        + `(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
}

function parseRespawnMode(value: unknown): RespawnMode | undefined {
    return value === "death_location" || value === "manual" || value === "player_spawn"
        ? value
        : undefined;
}

function numberArgument(value: unknown): number {
    return typeof value === "number" ? value : Number.NaN;
}

function pointArgument(value: unknown): { readonly x: number; readonly y: number; readonly z: number } {
    if (typeof value !== "object" || value === null) {
        return { x: Number.NaN, y: Number.NaN, z: Number.NaN };
    }
    const point = value as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
    return {
        x: numberArgument(point.x),
        y: numberArgument(point.y),
        z: numberArgument(point.z),
    };
}

function blockFaceArgument(value: unknown): BlockFace {
    return value === "down" || value === "east" || value === "north"
        || value === "south" || value === "up" || value === "west"
        ? value
        : "up";
}

function entityArgument(value: unknown): Entity | Error {
    const targets = Array.isArray(value)
        ? value.filter((target): target is Entity => target instanceof Entity && target.isValid)
        : [];
    return targets.length === 1 && targets[0] !== undefined
        ? targets[0]
        : new Error("目标选择器必须恰好匹配一个有效实体。");
}

function parseSkinMode(value: unknown): "copy_actor" | "default" | undefined {
    return value === undefined ? "default" : value === "copy_actor" || value === "default" ? value : undefined;
}