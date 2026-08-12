export const PAYMENT_PAYLOAD_VERSION = "credits-v1";

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

