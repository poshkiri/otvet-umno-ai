import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminTelegramId, userTariffStatus } from "../src/bot.js";

test("account shows Plus allowance instead of stale free requests", () => {
  const text = userTariffStatus(1, 5, 0, "free", {
    active: true,
    used: 0,
    limit: 100,
    remaining: 100,
  });

  assert.equal(text, "Plus AI-баллы: 100 из 100\nРазовые запросы: 0");
  assert.doesNotMatch(text, /Бесплатных запросов/);
});

test("admin user search accepts a plain Telegram ID or an ID label", () => {
  assert.equal(parseAdminTelegramId("8247699735"), 8_247_699_735);
  assert.equal(parseAdminTelegramId(" ID: 8247699735 "), 8_247_699_735);
  assert.equal(parseAdminTelegramId("ID пользователя: 8247699735"), 8_247_699_735);
  assert.equal(parseAdminTelegramId("8247699735 test"), 8_247_699_735);
  assert.equal(parseAdminTelegramId("ID 8247699735 или 984368720"), undefined);
});
