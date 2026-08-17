export interface AccessPayload {
  remaining: number | null;
  label: string;
  plan: "free" | "plus" | "pro";
}

export interface SessionPayload {
  user: { firstName: string };
  access: AccessPayload;
  botUsername: string;
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
};
