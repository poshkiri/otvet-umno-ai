import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDIT_PACKAGES,
  createPaymentPayload,
  createSubscriptionPayload,
  parsePaymentPayload,
  parseSubscriptionPayload,
} from "../src/payments.js";

test("payment payload binds a package to a Telegram user", () => {
  const payload = createPaymentPayload("plus", 123456);
  assert.deepEqual(parsePaymentPayload(payload), { packageId: "plus", telegramId: 123456 });
  assert.equal(CREDIT_PACKAGES.start.stars, 149);
  assert.equal(CREDIT_PACKAGES.plus.stars, 549);
  assert.equal(CREDIT_PACKAGES.pro.stars, 1299);
});

test("subscription payload binds Plus to one Telegram user", () => {
  const payload = createSubscriptionPayload(12345);
  assert.deepEqual(parseSubscriptionPayload(payload), { planId: "plus", telegramId: 12345 });
  assert.equal(parseSubscriptionPayload("subscription-v1:plus:0"), undefined);
  assert.equal(parseSubscriptionPayload("subscription-v1:pro:12345"), undefined);
});

test("payment payload rejects unknown or malformed data", () => {
  assert.equal(parsePaymentPayload("credits-v1:unknown:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:not-a-number"), undefined);
  assert.equal(parsePaymentPayload("other:start:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:123:extra"), undefined);
});
