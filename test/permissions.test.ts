import assert from "node:assert/strict";
import test from "node:test";

import { isAllowed } from "../src/domain/permissions.js";
import type { PermissionTable } from "../src/domain/model.js";

const permissions: PermissionTable = {
    grants: {
        placer: { playerId: "placer", lastKnownName: "Placer", canPlace: true, canSet: false },
        manager: { playerId: "manager", lastKnownName: "Manager", canPlace: false, canSet: true },
    },
};

test("operators always pass authorization", () => {
    const operator = { playerId: "operator", isOperator: true };
    assert.equal(isAllowed(operator, permissions, "create"), true);
    assert.equal(isAllowed(operator, permissions, "grant"), true);
});

test("canPlace and canSet retain their distinct NetEase semantics", () => {
    assert.equal(isAllowed({ playerId: "placer", isOperator: false }, permissions, "create"), true);
    assert.equal(isAllowed({ playerId: "placer", isOperator: false }, permissions, "manage"), false);
    assert.equal(isAllowed({ playerId: "manager", isOperator: false }, permissions, "create"), false);
    assert.equal(isAllowed({ playerId: "manager", isOperator: false }, permissions, "manage"), true);
    assert.equal(isAllowed({ playerId: "manager", isOperator: false }, permissions, "grant"), false);
});