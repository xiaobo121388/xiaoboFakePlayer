import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_MATRIX, isCapabilityEnabled } from "../src/domain/capabilities.js";

test("capability matrix is versioned, unique, and keeps unverified controls hidden", () => {
    assert.equal(CAPABILITY_MATRIX.gameVersion, "1.26.52");
    assert.equal(CAPABILITY_MATRIX.serverVersion, "2.11.0-beta.1.26.52-stable");
    assert.equal(CAPABILITY_MATRIX.serverUiVersion, "2.3.0-beta.1.26.52-stable");
    assert.equal(CAPABILITY_MATRIX.gameTestVersion, "1.0.0-beta.1.26.52-stable");
    const ids = CAPABILITY_MATRIX.capabilities.map((capability) => capability.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(isCapabilityEnabled("persona_skin_copy"), true);
    assert.equal(isCapabilityEnabled("entity_interaction_form"), true);
    assert.equal(isCapabilityEnabled("nearby_entity_listing"), true);
    assert.equal(isCapabilityEnabled("automatic_inventory_selection"), true);
    assert.equal(isCapabilityEnabled("automatic_projectile_claim"), true);
    assert.equal(isCapabilityEnabled("sneaking"), true);
    assert.equal(isCapabilityEnabled("hunger_saturation_write"), false);
    assert.equal(isCapabilityEnabled("persistent_saturation_effect"), true);
    assert.equal(isCapabilityEnabled("automatic_fishing"), false);
    assert.equal(isCapabilityEnabled("classic_skin_texture_copy"), false);
});

test("engine-dependent capabilities retain the 26.52 real-game verification gate", () => {
    for (const capability of CAPABILITY_MATRIX.capabilities) {
        assert.equal(
            capability.verification,
            capability.availability === "unsupported" ? "not_applicable" : "bedrock_26_52_required",
            capability.id,
        );
    }
});
