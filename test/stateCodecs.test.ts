import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import type { StringPropertyBackend } from "../src/infrastructure/state/bankedJsonStore.js";
import { BankedWorldStateStore } from "../src/infrastructure/state/bankedWorldStateStore.js";
import { catalogCodec, operationsCodec, permissionCodec } from "../src/infrastructure/state/codecs.js";

class MemoryBackend implements StringPropertyBackend {
    private readonly values = new Map<string, string>();

    public get(key: string): string | undefined {
        return this.values.get(key);
    }

    public set(key: string, value: string): void {
        this.values.set(key, value);
    }
}

test("aggregate codecs provide valid schema-one initial values", () => {
    assert.deepEqual(catalogCodec.decode(1, catalogCodec.initialValue), { nextId: 1, records: {} });
    assert.deepEqual(permissionCodec.decode(1, permissionCodec.initialValue), { grants: {} });
    assert.deepEqual(operationsCodec.decode(1, operationsCodec.initialValue), {
        workspace: {},
        inventoryTransfers: {},
        experienceTransfers: {},
    });
});

test("aggregate codecs reject malformed and unknown-schema payloads", () => {
    assert.equal(catalogCodec.decode(6, catalogCodec.initialValue), undefined);
    assert.equal(catalogCodec.decode(1, { nextId: 0, records: {} }), undefined);
    assert.equal(permissionCodec.decode(1, {
        grants: { stable: { playerId: "different", lastKnownName: "Alex", canPlace: true, canSet: false } },
    }), undefined);
    assert.equal(operationsCodec.decode(1, {
        workspace: {},
        inventoryTransfers: { bad: { phase: "unknown" } },
        experienceTransfers: {},
    }), undefined);
});

test("operations codec preserves every recoverable inventory request", () => {
    const requests = [
        { kind: "recycle_all" },
        { kind: "swap_inventory" },
        { kind: "swap_equipment" },
        { kind: "swap", fakeSlot: 40, playerSlot: 40 },
        { kind: "take", fakeSlot: 40, playerSlot: 35 },
        { kind: "put", fakeSlot: 40, playerSlot: 35 },
        { kind: "swap_fake", firstSlot: 0, secondSlot: 40 },
    ] as const;
    for (const request of requests) {
        const transfer = {
            id: "fp0001:inventory:4",
            fakePlayerId: "fp0001",
            playerId: "owner",
            fakePlayerRevision: 4,
            fakeSnapshotId: "xiaobo:fp0001_inv_1",
            fakeFallbackSnapshotId: "xiaobo:fp0001_inv_0",
            fakeAfterSnapshotId: "xiaobo:fp0001_inv_2",
            request,
            beforeStructureId: "before",
            afterStructureId: "after",
            phase: "prepared",
        };
        const decoded = operationsCodec.decode(2, {
            workspace: {},
            inventoryTransfers: { [transfer.id]: transfer },
            experienceTransfers: {},
        });
        assert.deepEqual(decoded?.inventoryTransfers[transfer.id]?.request, request);
        assert.equal(
            decoded?.inventoryTransfers[transfer.id]?.fakeFallbackSnapshotId,
            transfer.fakeFallbackSnapshotId,
        );
    }
});

test("operations codec accepts legacy inventory transfers without fallback metadata", () => {
    const transfer = {
        id: "fp0001:inventory:4",
        fakePlayerId: "fp0001",
        playerId: "owner",
        fakePlayerRevision: 4,
        fakeSnapshotId: "xiaobo:fp0001_inv_1",
        fakeAfterSnapshotId: "xiaobo:fp0001_inv_2",
        request: { kind: "recycle_all" },
        beforeStructureId: "before",
        afterStructureId: "after",
        phase: "checkpointed",
    };

    const decoded = operationsCodec.decode(2, {
        workspace: {},
        inventoryTransfers: { [transfer.id]: transfer },
        experienceTransfers: {},
    });

    assert.equal(decoded?.inventoryTransfers[transfer.id]?.fakeFallbackSnapshotId, undefined);
});

test("world state aggregates commit with independent revisions", () => {
    const store = new BankedWorldStateStore(new MemoryBackend(), "test");

    assert.equal(store.commitCatalog(0, { nextId: 2, records: {} }).ok, true);
    assert.equal(store.commitPermissions(0, {
        grants: {
            stable: {
                playerId: "stable",
                lastKnownName: "Alex",
                canPlace: true,
                canSet: false,
            },
        },
    }).ok, true);

    const catalog = store.loadCatalog();
    const permissions = store.loadPermissions();
    const operations = store.loadOperations();
    assert.equal(catalog.ok && catalog.state.revision, 1);
    assert.equal(permissions.ok && permissions.state.revision, 1);
    assert.equal(operations.ok && operations.state.revision, 0);
});

test("catalog codec migrates legacy records while validating schema five", () => {
    const legacyRecord = {
        id: "fp0001",
        name: "Alex",
        ownerId: "owner",
        recordRevision: 1,
        lifecycle: { kind: "offline" },
        expectedOnline: false,
        location: {
            dimension: "minecraft:overworld",
            position: { x: 0, y: 64, z: 0 },
            rotation: { x: 0, y: 0 },
        },
        gameMode: "survival",
        selectedSlot: 0,
        totalExperience: 0,
        respawnMode: "manual",
        respawnLocation: null,
        inventoryRevision: null,
        lastCheckpointTick: null,
    };
    const migrated = catalogCodec.decode(1, { nextId: 2, records: { fp0001: legacyRecord } });
    assert.deepEqual(migrated?.records.fp0001?.behavior, createDefaultBehaviorConfig());
    assert.deepEqual(migrated?.records.fp0001?.skin, { kind: "default" });
    assert.equal(migrated?.records.fp0001?.keepSaturated, false);
    assert.equal(catalogCodec.decode(2, { nextId: 2, records: { fp0001: legacyRecord } }), undefined);
    const schemaTwo = catalogCodec.decode(2, {
        nextId: 2,
        records: { fp0001: { ...legacyRecord, behavior: createDefaultBehaviorConfig() } },
    });
    assert.deepEqual(schemaTwo?.records.fp0001?.skin, { kind: "default" });
    const { place: _legacyPlace, ...behaviorWithoutPlace } = createDefaultBehaviorConfig();
    const schemaThreeWithoutPlace = catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: behaviorWithoutPlace,
                skin: { kind: "default" },
            },
        },
    });
    assert.deepEqual(
        schemaThreeWithoutPlace?.records.fp0001?.behavior.place,
        createDefaultBehaviorConfig().place,
    );
    const currentBehavior = createDefaultBehaviorConfig();
    const legacyPlaceSelection = catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: {
                    ...currentBehavior,
                    place: {
                        enabled: false,
                        intervalTicks: 10,
                        mode: "front",
                        position: null,
                        slot: 4,
                    },
                },
                skin: { kind: "default" },
            },
        },
    });
    assert.deepEqual(legacyPlaceSelection?.records.fp0001?.behavior.place, {
        ...currentBehavior.place,
        slot: 4,
    });
    assert.equal(catalogCodec.decode(2, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: { ...createDefaultBehaviorConfig(), use: { enabled: true, intervalTicks: 0, slot: 0 } },
            },
        },
    }), undefined);
    assert.equal(catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: {
                    ...createDefaultBehaviorConfig(),
                    place: {
                        enabled: true,
                        intervalTicks: 10,
                        mode: "position",
                        position: null,
                        slot: 0,
                    },
                },
                skin: { kind: "default" },
            },
        },
    }), undefined);
    const multipleActionBehaviors = createDefaultBehaviorConfig();
    const normalizedActions = catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: {
                    ...multipleActionBehaviors,
                    attack: { ...multipleActionBehaviors.attack, enabled: true },
                    mine: { ...multipleActionBehaviors.mine, enabled: true },
                    use: { ...multipleActionBehaviors.use, enabled: true },
                },
                skin: { kind: "default" },
            },
        },
    });
    assert.equal(normalizedActions?.records.fp0001?.behavior.attack.enabled, true);
    assert.equal(normalizedActions?.records.fp0001?.behavior.mine.enabled, false);
    assert.equal(normalizedActions?.records.fp0001?.behavior.place.enabled, false);
    assert.equal(normalizedActions?.records.fp0001?.behavior.use.enabled, false);
    const persona = {
        kind: "persona",
        armSize: "Slim",
        personaPieces: [{
            id: "piece",
            packId: "pack",
            productId: "product",
            type: "Hair",
        }],
        skinColor: { red: 0.2, green: 0.4, blue: 0.6 },
    };
    const schemaThree = catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: { ...legacyRecord, behavior: createDefaultBehaviorConfig(), skin: persona },
        },
    });
    assert.deepEqual(schemaThree?.records.fp0001?.skin, persona);
    const schemaThreeWithInventory = catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { kind: "default" },
                inventoryRevision: 12,
            },
        },
    });
    assert.equal(schemaThreeWithInventory?.records.fp0001?.inventoryFallbackRevision, 11);
    const schemaFour = catalogCodec.decode(4, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { kind: "default" },
                inventoryFallbackRevision: null,
            },
        },
    });
    assert.equal(schemaFour?.records.fp0001?.inventoryFallbackRevision, null);
    assert.equal(schemaFour?.records.fp0001?.keepSaturated, false);
    const schemaFive = catalogCodec.decode(5, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { kind: "default" },
                keepSaturated: true,
                inventoryFallbackRevision: null,
            },
        },
    });
    assert.equal(schemaFive?.records.fp0001?.keepSaturated, true);
    const { projectileClaim: _legacyProjectileClaim, ...behaviorWithoutProjectileClaim } = createDefaultBehaviorConfig();
    const schemaFiveWithoutProjectileClaim = catalogCodec.decode(5, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: behaviorWithoutProjectileClaim,
                skin: { kind: "default" },
                keepSaturated: true,
                inventoryFallbackRevision: null,
            },
        },
    });
    assert.deepEqual(
        schemaFiveWithoutProjectileClaim?.records.fp0001?.behavior.projectileClaim,
        { enabled: false, radius: 20 },
    );
    assert.equal(catalogCodec.decode(5, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: {
                    ...createDefaultBehaviorConfig(),
                    projectileClaim: { enabled: true, radius: 0 },
                },
                skin: { kind: "default" },
                keepSaturated: true,
                inventoryFallbackRevision: null,
            },
        },
    }), undefined);
    assert.equal(catalogCodec.decode(5, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { kind: "default" },
                inventoryFallbackRevision: null,
            },
        },
    }), undefined);
    assert.equal(catalogCodec.decode(4, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { kind: "default" },
            },
        },
    }), undefined);
    assert.equal(catalogCodec.decode(3, {
        nextId: 2,
        records: {
            fp0001: {
                ...legacyRecord,
                behavior: createDefaultBehaviorConfig(),
                skin: { ...persona, skinColor: { red: 2, green: 0.4, blue: 0.6 } },
            },
        },
    }), undefined);
});