import assert from "node:assert/strict";
import test from "node:test";
import { isBotPollingEnabled } from "../src/runtime-config.js";

test("runtime polling flag overrides the service default", () => {
  assert.equal(isBotPollingEnabled("false", "true"), true);
  assert.equal(isBotPollingEnabled("true", "false"), false);
  assert.equal(isBotPollingEnabled("false"), false);
  assert.equal(isBotPollingEnabled(undefined), true);
});
