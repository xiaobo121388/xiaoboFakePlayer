import type { PermissionTable, PlayerPersistentId } from "./model.js";

export type PermissionAction = "create" | "grant" | "manage" | "view";

export interface ActorIdentity {
    readonly playerId: PlayerPersistentId;
    readonly isOperator: boolean;
}

export function isAllowed(actor: ActorIdentity, table: PermissionTable, action: PermissionAction): boolean {
    if (actor.isOperator) {
        return true;
    }
    const grant = table.grants[actor.playerId];
    if (grant === undefined || action === "grant") {
        return false;
    }
    if (action === "create") {
        return grant.canPlace;
    }
    return grant.canSet;
}