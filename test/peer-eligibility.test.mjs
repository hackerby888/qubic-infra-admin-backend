import assert from "node:assert/strict";
import { isPeerEligible } from "../dist/utils/common.js";

const now = Date.now();

assert.equal(isPeerEligible(now, 200, 200), true);
assert.equal(isPeerEligible(now, 190, 200), false);
assert.equal(isPeerEligible(now, 201, 200), false);
assert.equal(isPeerEligible(now, 0, 0), false);
assert.equal(isPeerEligible(now - 3 * 60 * 1000, 200, 200), false);
