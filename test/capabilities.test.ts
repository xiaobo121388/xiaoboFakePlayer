import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_MATRIX, isCapabilityEnabled } from "../src/domain/capabilities.js";

test("capability matrix is versioned, unique, and keeps unverified controls hidden", () => {
    assert.equal(CAPABILITY_MATRIX.gameVersion, "1.26.33");
    const ids = CAPABILITY_MATRIX.capabilities.map((capability) => capability.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(isCapabilityEnabled("persona_skin_copy"), true);
    assert.equal(isCapabilityEnabled("entity_interaction_form"), true);
    assert.equal(isCapabilityEnabled("nearby_mob_listing"), true);
    assert.equal(isCapabilityEnabled("sneaking"), true);
    assert.equal(isCapabilityEnabled("hunger_saturation_write"), false);
    assert.equal(isCapabilityEnabled("persistent_saturation_effect"), true);
    assert.equal(isCapabilityEnabled("automatic_fishing"), false);
    assert.equal(isCapabilityEnabled("classic_skin_texture_copy"), false);
});