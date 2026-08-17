import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "./config.js";
import type { AiService } from "./ai.js";
import type { BotDatabase } from "./database.js";
import type { ProductAnalytics } from "./analytics.js";
import { cleanTelegramText } from "./utils.js";
import {
  TelegramWebAppAuthError,
  validateTelegramInitData,
  type TelegramWebAppUser,
} from "./telegram-webapp.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface FollowUpBody {
  conversationId?: string;
  question?: string;
}

interface AskBody {
  question?: string;
}

export function createAppServer(
  config: AppConfig,
  db: BotDatabase,
  ai: AiService,
  analytics: ProductAnalytics,
  botUsername: string,
) {
  const app = Fastify({ logger: true, bodyLimit: MAX_IMAGE_BYTES + 64 * 1024 });
  const webRoot = resolve(process.cwd(), "webapp", "dist");

  app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2 },
  });
  if (existsSync(webRoot)) {
    app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/app/",
      wildcard: false,
    });
    app.get("/app", async (_request, reply) => reply.redirect("/app/"));
    app.get("/app/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  const authenticate = (request: FastifyRequest): TelegramWebAppUser => {
    const header = request.headers["x-telegram-init-data"];
    if (typeof header !== "string") {
      throw new TelegramWebAppAuthError("Открой Mini App из Telegram");
    }
    const user = validateTelegramInitData(
      header,
      config.BOT_TOKEN,
      config.MINI_APP_AUTH_MAX_AGE_SECONDS,
    );
    db.ensureUser(user.id, user.username, user.first_name);
    if (
      user.id === config.ADMIN_TELEGRAM_ID
      || config.UNLIMITED_TELEGRAM_IDS.includes(user.id)
    ) db.setPlan(user.id, "pro");
    return user;
  };

  const accessPayload = (telegramId: number) => {
    const access = db.getAccess(telegramId);
    const subscription = db.getSubscriptionRequestAllowance(
      telegramId,
      config.PLUS_REQUEST_LIMIT,
    );
    if (access.plan === "pro") {
      return { remaining: null, label: "Безлимит", plan: "pro" };
    }
    const freeRemaining = Math.max(0, access.freeLimit - access.freeUsed);
    const remaining = freeRemaining + access.credits + subscription.remaining;
    return {
      remaining,
      label: `${remaining} ${requestWord(remaining)}`,
      plan: subscription.active ? "plus" : "free",
    };
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/mini-app/session", async (request) => {
    const user = authenticate(request);
    db.recordEvent(user.id, "mini_app_opened");
    analytics.capture(user.id, "mini_app_opened", { source: "mini_app" });
    return {
      user: { firstName: user.first_name },
      access: accessPayload(user.id),
      botUsername,
      history: db.recentGenerations(user.id, 5).map((item) => ({
        id: item.id,
        source: item.source,
        result: item.result,
        flow: item.flow,
        createdAt: item.createdAt,
      })),
    };
  });

  app.post<{ Body: AskBody }>("/api/mini-app/ask", async (request, reply) => {
    const user = authenticate(request);
    const question = request.body?.question?.trim();
    if (!question || question.length > 1_000) {
      return reply.code(400).send({ code: "BAD_QUESTION", message: "Напиши вопрос до 1000 символов" });
    }
    if (!db.claimAction(user.id, "mini-app-ask", 2)) {
      return reply.code(429).send({ code: "TOO_FAST", message: "Подожди пару секунд" });
    }
    const reservation = db.reserveRequest(user.id);
    if (!reservation) {
      return reply.code(402).send({
        code: "LIMIT_REACHED",
        message: "Бесплатные запросы закончились",
        botUsername,
      });
    }
    try {
      const result = cleanTelegramText(await ai.answerGeneral(question));
      db.saveGeneration(user.id, "analyze", "auto", question, result);
      db.commitRequest(reservation.id);
      db.recordEvent(user.id, "generation_text", "mini_app");
      analytics.capture(user.id, "generation_text", { input_type: "mini_app" });
      return { result, access: accessPayload(user.id) };
    } catch (error) {
      db.releaseRequest(reservation.id);
      throw error;
    }
  });

  app.post("/api/mini-app/analyze", async (request, reply) => {
    const user = authenticate(request);
    if (!db.claimAction(user.id, "mini-app-analyze", 2)) {
      return reply.code(429).send({ code: "TOO_FAST", message: "Подожди пару секунд" });
    }
    const part = await request.file();
    if (!part || !ALLOWED_IMAGE_TYPES.has(part.mimetype)) {
      return reply.code(400).send({ code: "BAD_IMAGE", message: "Нужна фотография JPG, PNG или WebP" });
    }
    const image = await part.toBuffer();
    const questionField = part.fields.question;
    const question = questionField && !Array.isArray(questionField) && questionField.type === "field"
      ? String(questionField.value).trim().slice(0, 1_000)
      : undefined;
    const reservation = db.reserveRequest(user.id);
    if (!reservation) {
      return reply.code(402).send({
        code: "LIMIT_REACHED",
        message: "Бесплатные запросы закончились",
        botUsername,
      });
    }
    try {
      const visual = await ai.generateFromImage(image, part.mimetype, question);
      const result = cleanTelegramText(visual.text);
      db.saveGeneration(user.id, "analyze", "auto", question || "Фото из Mini App", result);
      db.commitRequest(reservation.id);
      const conversationId = db.createMiniAppConversation(user.id, visual.responseId);
      db.recordEvent(user.id, "generation_photo", "mini_app");
      analytics.capture(user.id, "generation_photo", { input_type: "mini_app" });
      return {
        result,
        conversationId,
        access: accessPayload(user.id),
      };
    } catch (error) {
      db.releaseRequest(reservation.id);
      throw error;
    }
  });

  app.post<{ Body: FollowUpBody }>("/api/mini-app/follow-up", async (request, reply) => {
    const user = authenticate(request);
    const conversationId = request.body?.conversationId?.trim();
    const question = request.body?.question?.trim();
    if (!conversationId || !question || question.length > 1_000) {
      return reply.code(400).send({ code: "BAD_QUESTION", message: "Напиши короткий вопрос по фотографии" });
    }
    const previousResponseId = db.getMiniAppConversation(user.id, conversationId);
    if (!previousResponseId) {
      return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND", message: "Этот разбор уже недоступен" });
    }
    const reservation = db.reserveRequest(user.id);
    if (!reservation) {
      return reply.code(402).send({
        code: "LIMIT_REACHED",
        message: "Запросы закончились",
        botUsername,
      });
    }
    try {
      const visual = await ai.continueVisual(previousResponseId, question);
      const result = cleanTelegramText(visual.text);
      db.saveGeneration(user.id, "analyze", "auto", question, result);
      db.commitRequest(reservation.id);
      db.updateMiniAppConversation(user.id, conversationId, visual.responseId);
      db.recordEvent(user.id, "generation_text", "mini_app_followup");
      analytics.capture(user.id, "generation_text", { input_type: "mini_app_followup" });
      return { result, access: accessPayload(user.id) };
    } catch (error) {
      db.releaseRequest(reservation.id);
      throw error;
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TelegramWebAppAuthError) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: error.message });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ code: "IMAGE_TOO_LARGE", message: "Фото больше 8 МБ" });
    }
    app.log.error(error);
    return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Не получилось обработать фото. Попробуй ещё раз" });
  });

  return app;
}

function requestWord(value: number): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return "запросов";
  if (mod10 === 1) return "запрос";
  if (mod10 >= 2 && mod10 <= 4) return "запроса";
  return "запросов";
}
