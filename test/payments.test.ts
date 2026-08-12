import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDIT_PACKAGES,
  createPaymentPayload,
  parsePaymentPayload,
} from "../src/payments.js";

test("payment payload binds a package to a Telegram user", () => {
  const payload = createPaymentPayload("plus", 123456);
  assert.deepEqual(parsePaymentPayload(payload), { packageId: "plus", telegramId: 123456 });
  assert.equal(CREDIT_PACKAGES.plus.stars, 299);
});

test("payment payload rejects unknown or malformed data", () => {
  assert.equal(parsePaymentPayload("credits-v1:unknown:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:not-a-number"), undefined);
  assert.equal(parsePaymentPayload("other:start:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:123:extra"), undefined);
});
