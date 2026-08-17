import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  TelegramWebAppAuthError,
  validateTelegramInitData,
} from "../src/telegram-webapp.js";

const token = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHI";
const now = 1_800_000_000;

function signedInitData(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    auth_date: String(now),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id: 1264985917, first_name: "Max", username: "max" }),
    ...overrides,
  };
  const check = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  values.hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams(values).toString();
}

test("valid Telegram Mini App initData returns the signed user", () => {
  const user = validateTelegramInitData(signedInitData(), token, 86_400, now);
  assert.equal(user.id, 1264985917);
  assert.equal(user.first_name, "Max");
});

test("Telegram Mini App initData rejects tampering and expired sessions", () => {
  const tampered = signedInitData().replace("Max", "Alex");
  assert.throws(
    () => validateTelegramInitData(tampered, token, 86_400, now),
    TelegramWebAppAuthError,
  );
  assert.throws(
    () => validateTelegramInitData(signedInitData({ auth_date: String(now - 90_000) }), token, 86_400, now),
    /устарела/,
  );
});
