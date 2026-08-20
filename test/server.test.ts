import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiService } from "../src/ai.js";
import type { ProductAnalytics } from "../src/analytics.js";
import type { AppConfig } from "../src/config.js";
import { BotDatabase } from "../src/database.js";
import { createAppServer } from "../src/server.js";
import type { PlategaGateway, PlategaStatus } from "../src/platega.js";

const token = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI";

function initData(userId: number): string {
  const values: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "mini-app-test",
    user: JSON.stringify({ id: userId, first_name: "Max" }),
  };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  values.hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams(values).toString();
}

function config(): AppConfig {
  return {
    BOT_TOKEN: token,
    OPENAI_API_KEY: "sk-test-abcdefghijklmnopqrstuvwxyz",
    OPENAI_MODEL: "test-model",
    OPENAI_TRANSCRIBE_MODEL: "test-transcribe",
    OPENAI_IMAGE_MODEL: "test-image",
    OPENAI_IMAGE_EDIT_MODEL: "test-image-edit",
    FREE_REQUEST_LIMIT: 5,
    DATABASE_PATH: ":memory:",
    UNLIMITED_TELEGRAM_IDS: [],
    PLUS_SUBSCRIPTION_STARS: 299,
    PLUS_REQUEST_LIMIT: 50,
    PLUS_IMAGE_LIMIT: 20,
    PRO_IMAGE_LIMIT: 2_000,
    GLOBAL_IMAGE_LIMIT: 2_000,
    IMAGE_WINDOW_HOURS: 720,
    MAX_OUTPUT_TOKENS: 1_000,
    MAX_VOICE_SECONDS: 180,
    POSTHOG_HOST: "https://eu.i.posthog.com",
    REPORT_TIMEZONE: "Asia/Irkutsk",
    DAILY_REPORT_HOUR: 10,
    PORT: 3_000,
    MINI_APP_AUTH_MAX_AGE_SECONDS: 86_400,
    PLATEGA_API_URL: "https://app.platega.io",
    PLATEGA_CHECKOUT_ENABLED: false,
  };
}

test("Mini App API requires Telegram auth and isolates follow-up conversations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-api-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  const ai = {
    continueVisual: async () => ({ text: "Проверенный ответ", responseId: "response-next" }),
  } as unknown as AiService;
  const analytics = { capture: () => undefined } as unknown as ProductAnalytics;
  const app = createAppServer(config(), db, ai, analytics, "OtvetUmnoAI_bot");

  const unauthorized = await app.inject({ method: "GET", url: "/api/mini-app/session" });
  assert.equal(unauthorized.statusCode, 401);

  const firstUser = 7001;
  db.ensureUser(firstUser);
  const conversation = db.createMiniAppConversation(firstUser, "response-first");
  const successful = await app.inject({
    method: "POST",
    url: "/api/mini-app/follow-up",
    headers: { "x-telegram-init-data": initData(firstUser) },
    payload: { conversationId: conversation, question: "Что это?" },
  });
  assert.equal(successful.statusCode, 200);
  assert.equal(successful.json().result, "Проверенный ответ");

  const secondUser = 7002;
  const isolated = await app.inject({
    method: "POST",
    url: "/api/mini-app/follow-up",
    headers: { "x-telegram-init-data": initData(secondUser) },
    payload: { conversationId: conversation, question: "Чужой вопрос" },
  });
  assert.equal(isolated.statusCode, 404);
  await app.close();
  db.close();
});

test("Mini App text questions consume one request and appear in history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-api-text-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  const ai = {
    answerGeneral: async (question: string) => `Ответ на: ${question}`,
  } as unknown as AiService;
  const analytics = { capture: () => undefined } as unknown as ProductAnalytics;
  const app = createAppServer(config(), db, ai, analytics, "OtvetUmnoAI_bot");
  const telegramId = 7101;

  const answer = await app.inject({
    method: "POST",
    url: "/api/mini-app/ask",
    headers: { "x-telegram-init-data": initData(telegramId) },
    payload: { question: "Что такое инфляция?" },
  });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.json().result, "Ответ на: Что такое инфляция?");
  assert.equal(answer.json().access.remaining, 4);

  const session = await app.inject({
    method: "GET",
    url: "/api/mini-app/session",
    headers: { "x-telegram-init-data": initData(telegramId) },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().history[0].source, "Что такое инфляция?");
  await app.close();
  db.close();
});

test("Platega checkout stays closed until production access is approved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-api-checkout-closed-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  const gateway: PlategaGateway = {
    enabled: true,
    createPayment: async () => { throw new Error("must not be called"); },
    getTransaction: async () => { throw new Error("must not be called"); },
    verifyCallbackHeaders: () => true,
  };
  const app = createAppServer(
    { ...config(), RENDER_EXTERNAL_URL: "https://poymi-ai.onrender.com" },
    db,
    {} as AiService,
    { capture: () => undefined } as unknown as ProductAnalytics,
    "OtvetUmnoAI_bot",
    gateway,
  );
  const telegramId = 7151;

  const session = await app.inject({
    method: "GET",
    url: "/api/mini-app/session",
    headers: { "x-telegram-init-data": initData(telegramId) },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().payments.plategaEnabled, false);

  const payment = await app.inject({
    method: "POST",
    url: "/api/mini-app/payments/platega",
    headers: { "x-telegram-init-data": initData(telegramId) },
    payload: { packageId: "start" },
  });
  assert.equal(payment.statusCode, 503);
  await app.close();
  db.close();
});

test("Platega callback verifies credentials and credits a payment exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-api-platega-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  const ai = {} as AiService;
  const analytics = { capture: () => undefined } as unknown as ProductAnalytics;
  let remoteStatus: PlategaStatus = "PENDING";
  const transactionId = "11111111-1111-4111-8111-111111111111";
  const gateway: PlategaGateway = {
    enabled: true,
    createPayment: async () => ({
      transactionId,
      status: "PENDING",
      url: "https://pay.platega.io/test",
    }),
    getTransaction: async () => ({
      id: transactionId,
      status: remoteStatus,
      paymentDetails: { amount: 199, currency: "RUB" },
    }),
    verifyCallbackHeaders: (merchantId, secret) => merchantId === "merchant" && secret === "secret",
  };
  const appConfig = {
    ...config(),
    RENDER_EXTERNAL_URL: "https://poymi-ai.onrender.com",
    PLATEGA_CHECKOUT_ENABLED: true,
  };
  const app = createAppServer(appConfig, db, ai, analytics, "OtvetUmnoAI_bot", gateway);
  const telegramId = 7201;

  const created = await app.inject({
    method: "POST",
    url: "/api/mini-app/payments/platega",
    headers: { "x-telegram-init-data": initData(telegramId) },
    payload: { packageId: "start" },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().transactionId, transactionId);

  remoteStatus = "CONFIRMED";
  const rejected = await app.inject({
    method: "POST",
    url: "/api/payments/platega/callback",
    headers: { "x-merchantid": "wrong", "x-secret": "wrong" },
    payload: { id: transactionId, status: "CONFIRMED", amount: 199, currency: "RUB" },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(db.getAccess(telegramId).credits, 0);

  for (let index = 0; index < 2; index += 1) {
    const callback = await app.inject({
      method: "POST",
      url: "/api/payments/platega/callback",
      headers: { "x-merchantid": "merchant", "x-secret": "secret" },
      payload: { id: transactionId, status: "CONFIRMED", amount: 199, currency: "RUB" },
    });
    assert.equal(callback.statusCode, 200);
  }
  assert.equal(db.getAccess(telegramId).credits, 50);

  const foreignStatus = await app.inject({
    method: "GET",
    url: `/api/mini-app/payments/platega/${transactionId}`,
    headers: { "x-telegram-init-data": initData(7202) },
  });
  assert.equal(foreignStatus.statusCode, 404);
  await app.close();
  db.close();
});
