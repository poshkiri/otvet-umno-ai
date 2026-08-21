import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDIT_PACKAGES,
  PLUS_PLANS,
  createPaymentPayload,
  createSubscriptionPayload,
  parsePaymentPayload,
  parseSubscriptionPayload,
  validateSubscriptionCheckout,
} from "../src/payments.js";

test("payment payload binds a package to a Telegram user", () => {
  const payload = createPaymentPayload("plus", 123456);
  assert.deepEqual(parsePaymentPayload(payload), { packageId: "plus", telegramId: 123456 });
  assert.equal(CREDIT_PACKAGES.start.stars, 199);
  assert.equal(CREDIT_PACKAGES.start.title, "50 запросов");
  assert.equal(CREDIT_PACKAGES.plus.stars, 699);
  assert.equal(CREDIT_PACKAGES.plus.title, "200 запросов");
  assert.equal(CREDIT_PACKAGES.pro.stars, 1599);
  assert.equal(CREDIT_PACKAGES.pro.title, "500 запросов");
});

test("subscription payload binds Plus to one Telegram user", () => {
  const payload = createSubscriptionPayload(12345);
  assert.deepEqual(parseSubscriptionPayload(payload), {
    planId: "plus",
    productId: "1m",
    telegramId: 12345,
  });
  assert.deepEqual(parseSubscriptionPayload(createSubscriptionPayload(12345, "12m")), {
    planId: "plus",
    productId: "12m",
    telegramId: 12345,
  });
  assert.deepEqual(parseSubscriptionPayload("subscription-v1:plus:12345"), {
    planId: "plus",
    productId: "1m",
    telegramId: 12345,
  });
  assert.equal(PLUS_PLANS["1m"].stars, 399);
  assert.equal(PLUS_PLANS["3m"].requestLimit, 360);
  assert.equal(PLUS_PLANS["6m"].imageLimit, 165);
  assert.equal(PLUS_PLANS["12m"].stars, 2999);
  assert.equal(parseSubscriptionPayload("subscription-v1:plus:0"), undefined);
  assert.equal(parseSubscriptionPayload("subscription-v1:pro:12345"), undefined);
  assert.equal(parseSubscriptionPayload("subscription-v1:plus:24m:12345"), undefined);
});

test("payment payload rejects unknown or malformed data", () => {
  assert.equal(parsePaymentPayload("credits-v1:unknown:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:not-a-number"), undefined);
  assert.equal(parsePaymentPayload("other:start:123"), undefined);
  assert.equal(parsePaymentPayload("credits-v1:start:123:extra"), undefined);
});

test("subscription checkout rejects stale invoices while Plus is active", () => {
  const payload = createSubscriptionPayload(12345, "12m");
  assert.equal(validateSubscriptionCheckout(payload, 12345, "XTR", 2999, false), true);
  assert.equal(validateSubscriptionCheckout(payload, 12345, "XTR", 2999, true), false);
  assert.equal(validateSubscriptionCheckout(payload, 99999, "XTR", 2999, false), false);
  assert.equal(validateSubscriptionCheckout(payload, 12345, "XTR", 399, false), false);
});
