export interface AccessPayload {
  remaining: number | null;
  label: string;
  plan: "free" | "plus" | "pro";
}

export interface SessionPayload {
  user: { firstName: string };
  access: AccessPayload;
  botUsername: string;
  payments: {
    plategaEnabled: boolean;
    packages: Array<{ id: "start" | "plus" | "pro"; title: string; credits: number; rubles: number }>;
    recent: Array<{
      transactionId: string;
      packageId: string;
      credits: number;
      amountRub: number;
      status: "pending" | "confirmed" | "canceled" | "chargebacked";
      createdAt: string;
    }>;
  };
  history: Array<{
    id: number;
    source: string;
    result: string;
    flow: string;
    createdAt: string;
  }>;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly botUsername?: string) {
    super(message);
  }
}

async function request<T>(path: string, initData: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "x-telegram-init-data": initData,
      ...init?.headers,
    },
  });
  const payload = await response.json() as T & { code?: string; message?: string; botUsername?: string };
  if (!response.ok) {
    throw new ApiError(payload.code || "REQUEST_FAILED", payload.message || "Ошибка запроса", payload.botUsername);
  }
  return payload;
}

export const miniAppApi = {
  session: (initData: string) => request<SessionPayload>("/api/mini-app/session", initData),
  ask: (initData: string, question: string) => request<{ result: string; access: AccessPayload }>(
    "/api/mini-app/ask",
    initData,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    },
  ),
  analyze: async (initData: string, file: File, question?: string) => {
    const form = new FormData();
    form.append("image", file);
    if (question) form.append("question", question);
    return request<{ result: string; conversationId: string; access: AccessPayload }>(
      "/api/mini-app/analyze",
      initData,
      { method: "POST", body: form },
    );
  },
  followUp: (initData: string, conversationId: string, question: string) => request<{
    result: string;
    access: AccessPayload;
  }>("/api/mini-app/follow-up", initData, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, question }),
  }),
  createPlategaPayment: (initData: string, packageId: string) => request<{
    transactionId: string;
    url: string;
    status: "pending";
  }>("/api/mini-app/payments/platega", initData, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageId }),
  }),
  plategaPayment: (initData: string, transactionId: string) => request<{
    status: "pending" | "confirmed" | "canceled" | "chargebacked";
    access: AccessPayload;
  }>(`/api/mini-app/payments/platega/${encodeURIComponent(transactionId)}`, initData),
};
