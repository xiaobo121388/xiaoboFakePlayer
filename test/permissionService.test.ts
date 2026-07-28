import assert from "node:assert/strict";
import test from "node:test";

import { PermissionService } from "../src/application/permissionService.js";
import type { StringPropertyBackend } from "../src/infrastructure/state/bankedJsonStore.js";
import { BankedWorldStateStore } from "../src/infrastructure/state/bankedWorldStateStore.js";

class MemoryBackend implements StringPropertyBackend {
    private readonly values = new Map<string, string>();

    public get(key: string): string | undefined {
        return this.values.get(key);
    }

    public set(key: string, value: string): void {
        this.values.set(key, value);
    }
}

test("only operators can persist canPlace and canSet grants by stable player id", () => {
    const service = new PermissionService(new BankedWorldStateStore(new MemoryBackend(), "test"));
    const member = { playerId: "member", isOperator: false };
    const operator = { playerId: "operator", isOperator: true };
    const target = { playerId: "playfab-target", lastKnownName: "Alex" };

    assert.equal(service.setGrant(member, target, "can_place", true).ok, false);
    assert.deepEqual(service.setGrant(operator, target, "can_place", true), {
        ok: true,
        value: {
            playerId: "playfab-target",
            lastKnownName: "Alex",
            canPlace: true,
            canSet: false,
        },
    });
    assert.deepEqual(service.setGrant(operator, { ...target, lastKnownName: "AlexRenamed" }, "can_set", true), {
        ok: true,
        value: {
            playerId: "playfab-target",
            lastKnownName: "AlexRenamed",
            canPlace: true,
            canSet: true,
        },
    });
});