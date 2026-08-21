export const PAYMENT_PAYLOAD_VERSION = "credits-v1";
export const SUBSCRIPTION_PAYLOAD_VERSION = "subscription-v1";
export const PLUS_SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;

export const PLUS_PLANS = {
  "1m": { id: "1m", title: "1 месяц", months: 1, stars: 399, requestLimit: 100, imageLimit: 20, recurring: true },
  "3m": { id: "3m", title: "3 месяца", months: 3, stars: 999, requestLimit: 360, imageLimit: 75, recurring: false },
  "6m": { id: "6m", title: "6 месяцев", months: 6, stars: 1_799, requestLimit: 780, imageLimit: 165, recurring: false },
  "12m": { id: "12m", title: "12 месяцев", months: 12, stars: 2_999, requestLimit: 1_800, imageLimit: 360, recurring: false },
} as const;

export const CREDIT_PACKAGES = {
  start: { id: "start", title: "50 запросов", credits: 50, stars: 199 },
  plus: { id: "plus", title: "200 запросов", credits: 200, stars: 699 },
  pro: { id: "pro", title: "500 запросов", credits: 500, stars: 1_599 },
} as const;

export const RUB_CREDIT_PACKAGES = {
  start: { id: "start", title: "50 запросов", credits: 50, rubles: 199 },
  plus: { id: "plus", title: "200 запросов", credits: 200, rubles: 649 },
  pro: { id: "pro", title: "500 запросов", credits: 500, rubles: 1_490 },
} as const;

export type CreditPackageId = keyof typeof CREDIT_PACKAGES;
export type CreditPackage = (typeof CREDIT_PACKAGES)[CreditPackageId];
export type PlusPlanId = keyof typeof PLUS_PLANS;
export type PlusPlan = (typeof PLUS_PLANS)[PlusPlanId];

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

export function isPlusPlanId(value: string): value is PlusPlanId {
  return value in PLUS_PLANS;
}

export function createSubscriptionPayload(telegramId: number, productId: PlusPlanId = "1m"): string {
  return `${SUBSCRIPTION_PAYLOAD_VERSION}:plus:${productId}:${telegramId}`;
}

export function parseSubscriptionPayload(payload: string): {
  planId: "plus";
  productId: PlusPlanId;
  telegramId: number;
} | undefined {
  const parts = payload.split(":");
  const legacy = parts.length === 3;
  const [version, planId] = parts;
  const productId = legacy ? "1m" : parts[2];
  const rawTelegramId = legacy ? parts[2] : parts[3];
  const extra = legacy ? undefined : parts[4];
  const telegramId = Number(rawTelegramId);
  if (
    version !== SUBSCRIPTION_PAYLOAD_VERSION
    || planId !== "plus"
    || !productId
    || !isPlusPlanId(productId)
    || !Number.isSafeInteger(telegramId)
    || telegramId <= 0
    || extra !== undefined
  ) return undefined;
  return { planId, productId, telegramId };
}
