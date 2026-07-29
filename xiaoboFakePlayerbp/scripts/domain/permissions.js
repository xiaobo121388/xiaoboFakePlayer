export function isAllowed(actor, table, action) {
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
//# sourceMappingURL=permissions.js.map