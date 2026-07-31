import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultBehaviorConfig } from "../src/domain/behavior.js";
import { behaviorChangeMessage } from "../src/presentation/forms/behaviorChangeMessage.js";

test("behavior change message reports automatic enabling and disabling", () => {
    const defaults = createDefaultBehaviorConfig();
    const previous = {
        ...defaults,
        mine: { ...defaults.mine, enabled: true },
    };
    const current = {
        ...previous,
        attack: { ...previous.attack, enabled: true },
        mine: { ...previous.mine, enabled: false },
    };

    assert.deepEqual(behaviorChangeMessage("Alex", previous, current), {
        rawtext: [
            { translate: "xiaobo.fp.message.behavior_changed", with: ["Alex"] },
            { text: "\n- " },
            {
                translate: "xiaobo.fp.message.behavior_enabled",
                with: { rawtext: [{ translate: "xiaobo.fp.form.behavior.attack" }] },
            },
            { text: "\n- " },
            {
                translate: "xiaobo.fp.message.behavior_disabled",
                with: { rawtext: [{ translate: "xiaobo.fp.form.behavior.mine" }] },
            },
        ],
    });
});

test("behavior change message distinguishes setting updates and no-op saves", () => {
    const previous = createDefaultBehaviorConfig();
    const current = {
        ...previous,
        use: { ...previous.use, intervalTicks: 40 },
    };

    assert.deepEqual(behaviorChangeMessage("Alex", previous, current), {
        rawtext: [
            { translate: "xiaobo.fp.message.behavior_changed", with: ["Alex"] },
            { text: "\n- " },
            {
                translate: "xiaobo.fp.message.behavior_updated",
                with: { rawtext: [{ translate: "xiaobo.fp.form.behavior.use" }] },
            },
        ],
    });
    assert.equal(behaviorChangeMessage("Alex", previous, previous), undefined);
});

test("behavior change message reports projectile claim changes", () => {
    const previous = createDefaultBehaviorConfig();
    const current = {
        ...previous,
        projectileClaim: { enabled: true, radius: 24 },
    };

    assert.deepEqual(behaviorChangeMessage("Alex", previous, current), {
        rawtext: [
            { translate: "xiaobo.fp.message.behavior_changed", with: ["Alex"] },
            { text: "\n- " },
            {
                translate: "xiaobo.fp.message.behavior_enabled",
                with: { rawtext: [{ translate: "xiaobo.fp.form.behavior.projectile_claim" }] },
            },
        ],
    });
});