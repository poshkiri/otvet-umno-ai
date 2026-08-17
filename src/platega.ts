import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";

export type PlategaStatus = "PENDING" | "CANCELED" | "CONFIRMED" | "CHARGEBACKED";

export interface PlategaTransaction {
  id: string;
  status: PlategaStatus;
  paymentDetails?: { amount?: number; currency?: string };
  payload?: string;
}

export interface PlategaGateway {
  readonly enabled: boolean;
  createPayment(input: {
    amount: number;
    description: string;
    returnUrl: string;
    failedUrl: string;
    payload: string;
    telegramId: number;
    username?: string;
  }): Promise<{ transactionId: string; status: PlategaStatus; url: string }>;
  getTransaction(id: string): Promise<PlategaTransaction>;
  verifyCallbackHeaders(merchantId: string | undefined, secret: string | undefined): boolean;
}

export class PlategaClient implements PlategaGateway {
  readonly enabled: boolean;
  private readonly baseUrl: string;

  constructor(private readonly config: AppConfig) {
    this.enabled = Boolean(config.PLATEGA_MERCHANT_ID && config.PLATEGA_SECRET);
    this.baseUrl = config.PLATEGA_API_URL.replace(/\/$/, "");
  }

  async createPayment(input: Parameters<PlategaGateway["createPayment"]>[0]) {
    return this.request<{ transactionId: string; status: PlategaStatus; url: string }>(
      "/v2/transaction/process",
      {
        method: "POST",
        body: JSON.stringify({
          paymentDetails: { amount: input.amount, currency: "RUB" },
          description: input.description,
          return: input.returnUrl,
          failedUrl: input.failedUrl,
          payload: input.payload,
          metadata: {
            userId: String(input.telegramId),
            ...(input.username ? { userName: `@${input.username.replace(/^@/, "")}` } : {}),
          },
        }),
      },
    );
  }

  getTransaction(id: string): Promise<PlategaTransaction> {
    return this.request(`/transaction/${encodeURIComponent(id)}`);
  }

  verifyCallbackHeaders(merchantId: string | undefined, secret: string | undefined): boolean {
    return safeEqual(merchantId, this.config.PLATEGA_MERCHANT_ID)
      && safeEqual(secret, this.config.PLATEGA_SECRET);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.enabled) throw new Error("Platega is not configured");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "X-MerchantId": this.config.PLATEGA_MERCHANT_ID!,
        "X-Secret": this.config.PLATEGA_SECRET!,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Platega API error: ${response.status}`);
    return await response.json() as T;
  }
}

function safeEqual(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
