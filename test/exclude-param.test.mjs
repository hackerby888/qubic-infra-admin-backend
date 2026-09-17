import assert from "node:assert/strict";
import { parseExcludeParam, MAX_EXCLUDE_PEERS } from "../dist/utils/common.js";

assert.deepEqual(parseExcludeParam(undefined), []);
assert.deepEqual(parseExcludeParam(""), []);
assert.deepEqual(parseExcludeParam("1.2.3.4, 5.6.7.8"), ["1.2.3.4", "5.6.7.8"]);
assert.deepEqual(parseExcludeParam("1.2.3.4,1.2.3.4"), ["1.2.3.4"]);
assert.deepEqual(parseExcludeParam("garbage,::1,example.com,1.2.3.4"), ["1.2.3.4"]);
// express gives an array for repeated ?exclude=
assert.deepEqual(parseExcludeParam(["1.2.3.4", "5.6.7.8"]), ["1.2.3.4", "5.6.7.8"]);

const many = Array.from({ length: 100 }, (_, i) => `10.0.0.${i + 1}`).join(",");
assert.equal(parseExcludeParam(many).length, MAX_EXCLUDE_PEERS);
