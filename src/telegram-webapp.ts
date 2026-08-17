import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export class TelegramWebAppAuthError extends Error {}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now = Math.floor(Date.now() / 1000),
): TelegramWebAppUser {
  if (!initData) throw new TelegramWebAppAuthError("Telegram initData отсутствует");

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new TelegramWebAppAuthError("Некорректная подпись Telegram");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, "hex");
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw new TelegramWebAppAuthError("Подпись Telegram не совпала");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > maxAgeSeconds) {
    throw new TelegramWebAppAuthError("Сессия Telegram устарела");
  }

  const encodedUser = params.get("user");
  if (!encodedUser) throw new TelegramWebAppAuthError("Telegram не передал пользователя");
  let user: unknown;
  try {
    user = JSON.parse(encodedUser);
  } catch {
    throw new TelegramWebAppAuthError("Некорректные данные пользователя Telegram");
  }
  if (
    !user
    || typeof user !== "object"
    || !Number.isSafeInteger((user as TelegramWebAppUser).id)
    || typeof (user as TelegramWebAppUser).first_name !== "string"
  ) {
    throw new TelegramWebAppAuthError("Некорректный пользователь Telegram");
  }
  return user as TelegramWebAppUser;
}
