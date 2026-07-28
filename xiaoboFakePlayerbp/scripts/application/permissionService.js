import { isAllowed } from "../domain/permissions.js";
import { err, ok } from "../domain/results.js";
export class PermissionService {
    stateStore;
    constructor(stateStore) {
        this.stateStore = stateStore;
    }
    capabilities(actor) {
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        return ok({
            canPlace: isAllowed(actor, loaded.state.value, "create"),
            canSet: isAllowed(actor, loaded.state.value, "manage"),
        });
    }
    setGrant(actor, target, kind, enabled) {
        if (!actor.isOperator)
            return err("PERMISSION_DENIED", "只有 OP 可以修改假人权限。");
        if (target.playerId.length === 0)
            return err("INVALID_STATE", "目标玩家没有可用的 PlayFab 稳定 ID。");
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        const previous = loaded.state.value.grants[target.playerId];
        const grant = {
            playerId: target.playerId,
            lastKnownName: target.lastKnownName,
            canPlace: kind === "can_place" ? enabled : previous?.canPlace ?? false,
            canSet: kind === "can_set" ? enabled : previous?.canSet ?? false,
        };
        const committed = this.stateStore.commitPermissions(loaded.state.revision, {
            grants: { ...loaded.state.value.grants, [target.playerId]: grant },
        });
        return committed.ok ? ok(grant) : committed;
    }
    list(actor) {
        if (!actor.isOperator)
            return err("PERMISSION_DENIED", "只有 OP 可以查看权限列表。");
        const loaded = this.stateStore.loadPermissions();
        if (!loaded.ok)
            return err("CONFLICT", loaded.diagnostics.join("; "));
        return ok(Object.values(loaded.state.value.grants)
            .sort((left, right) => left.lastKnownName.localeCompare(right.lastKnownName)));
    }
}
