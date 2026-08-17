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
