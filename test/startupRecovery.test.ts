import assert from "node:assert/strict";
import test from "node:test";

import { startRecovery, type StartupRecoveryStatus } from "../src/application/startupRecovery.js";
import { err, ok } from "../src/domain/results.js";

const summary = {
    recoveredRecords: 1,
    recoveredTransfers: 0,
    reboundEntities: 1,
    diagnostics: [],
};

test("startup recovery retries while the world is loading and then becomes ready", () => {
    const statuses: StartupRecoveryStatus[] = [];
    let attempts = 0;
    let ready = false;

    startRecovery({
        run: () => {
            attempts += 1;
            return attempts === 1
                ? err("WORLD_NOT_READY", "structure workspace is not loaded")
                : ok(summary);
        },
    }, {
        scheduleRetry: (retry) => retry(),
        updateStatus: (status) => statuses.push(status),
        onReady: () => { ready = true; },
        onBlocked: () => assert.fail("transient world loading must not block recovery"),
    });

    assert.equal(attempts, 2);
    assert.equal(ready, true);
    assert.deepEqual(statuses, [
        { state: "recovering", message: "structure workspace is not loaded" },
        { state: "ready" },
    ]);
});

test("startup recovery blocks without retrying on persistent failures", () => {
    const statuses: StartupRecoveryStatus[] = [];
    let retries = 0;
    let blockedMessage: string | undefined;

    startRecovery({
        run: () => err("CONFLICT", "catalog is corrupt"),
    }, {
        scheduleRetry: () => { retries += 1; },
        updateStatus: (status) => statuses.push(status),
        onReady: () => assert.fail("persistent failure must not become ready"),
        onBlocked: (message) => { blockedMessage = message; },
    });

    assert.equal(retries, 0);
    assert.equal(blockedMessage, "catalog is corrupt");
    assert.deepEqual(statuses, [{ state: "blocked", message: "catalog is corrupt" }]);
});

test("startup recovery blocks when recovery throws", () => {
    let status: StartupRecoveryStatus | undefined;
    let blockedMessage: string | undefined;

    startRecovery({
        run: () => { throw new Error("engine failure"); },
    }, {
        scheduleRetry: () => assert.fail("engine failures must not retry"),
        updateStatus: (nextStatus) => { status = nextStatus; },
        onReady: () => assert.fail("engine failures must not become ready"),
        onBlocked: (message) => { blockedMessage = message; },
    });

    assert.deepEqual(status, { state: "blocked", message: "engine failure" });
    assert.equal(blockedMessage, "engine failure");
});