export const PAYMENT_PAYLOAD_VERSION = "credits-v1";
export const SUBSCRIPTION_PAYLOAD_VERSION = "subscription-v1";
export const PLUS_SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;

export const CREDIT_PACKAGES = {
  start: { id: "start", title: "Старт", credits: 50, stars: 99 },
  plus: { id: "plus", title: "Плюс", credits: 200, stars: 299 },
  pro: { id: "pro", title: "Про", credits: 500, stars: 599 },
} as const;

export type CreditPackageId = keyof typeof CREDIT_PACKAGES;
export type CreditPackage = (typeof CREDIT_PACKAGES)[CreditPackageId];

export function isCreditPackageId(value: string): value is CreditPackageId {
  return value in CREDIT_PACKAGES;
}

export function createPaymentPayload(packageId: CreditPackageId, telegramId: number): string {
  return `${PAYMENT_PAYLOAD_VERSION}:${packageId}:${telegramId}`;
}

export function parsePaymentPayload(payload: string): {
  packageId: CreditPackageId;
  telegramId: number;
} | undefined {
  const [version, packageId, rawTelegramId, extra] = payload.split(":");
  const telegramId = Number(rawTelegramId);
  if (
    version !== PAYMENT_PAYLOAD_VERSION
    || !packageId
    || !isCreditPackageId(packageId)
    || !Number.isSafeInteger(telegramId)
    || telegramId <= 0
    || extra !== undefined
  ) return undefined;
  return { packageId, telegramId };
}

export function createSubscriptionPayload(telegramId: number): string {
  return `${SUBSCRIPTION_PAYLOAD_VERSION}:plus:${telegramId}`;
}

export function parseSubscriptionPayload(payload: string): {
  planId: "plus";
  telegramId: number;
} | undefined {
  const [version, planId, rawTelegramId, extra] = payload.split(":");
  const telegramId = Number(rawTelegramId);
  if (
    version !== SUBSCRIPTION_PAYLOAD_VERSION
    || planId !== "plus"
    || !Number.isSafeInteger(telegramId)
    || telegramId <= 0
    || extra !== undefined
  ) return undefined;
  return { planId, telegramId };
}
