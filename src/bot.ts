import { Bot, Context, InlineKeyboard, InputFile, session, type SessionFlavor } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { AppConfig } from "./config.js";
import { AiService } from "./ai.js";
import { BotDatabase } from "./database.js";
import {
  categoryMenu,
  creditPacksMenu,
  documentsMenu,
  mainMenu,
  imageResultMenu,
  imageEditResultMenu,
  imagesMenu,
  profileMenu,
  plusPlansMenu,
  paywallMenu,
  quickCategory,
  refinementsMenu,
  resultMenu,
  SUPPORT_TELEGRAM_URL,
  visualResultMenu,
  tariffsMenu,
} from "./keyboards.js";
import {
  CREDIT_PACKAGES,
  PLUS_PLANS,
  PLUS_SUBSCRIPTION_PERIOD_SECONDS,
  createPaymentPayload,
  createSubscriptionPayload,
  isCreditPackageId,
  isPlusPlanId,
  parsePaymentPayload,
  parseSubscriptionPayload,
  validateSubscriptionCheckout,
} from "./payments.js";
import {
  CATEGORY_LABELS,
  FLOW_LABELS,
  categoryIds,
  flowIds,
  refinementIds,
  type BotSession,
  type CategoryId,
  type FlowId,
  type ImageAllowance,
  type RefinementId,
  type SubscriptionRequestAllowance,
} from "./types.js";
import { cleanTelegramText, displayName, escapeTelegramHtml, splitLongMessage } from "./utils.js";
import { Semaphore } from "./semaphore.js";
import { ProductAnalytics, type AnalyticsProperties } from "./analytics.js";
import {
  formatAcquisitionReport,
  formatBusinessReport,
  getBotStarBalance,
} from "./reporting.js";
import type { AnalyticsPeriodDays } from "./types.js";

type BotContext = Context & SessionFlavor<BotSession>;

interface VisualMessageItem {
  fileId: string;
  fileSize: number | undefined;
  mimeType: string;
  caption: string | undefined;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_ALBUM_IMAGES = 6;
const MAX_ALBUM_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

interface PendingAlbum {
  ctx: BotContext;
  items: VisualMessageItem[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

type TrackEvent = (
  telegramId: number,
  event: string,
  detail?: string,
  properties?: AnalyticsProperties,
) => void;

export interface BotRuntime {
  bot: Bot<BotContext>;
  drainBackgroundTasks: () => Promise<void>;
}

const INPUT_HINTS: Record<FlowId, string> = {
  analyze: "Пришли переписку текстом, скриншотом или голосом и коротко скажи, чего хочешь добиться.",
  compose: "Опиши ситуацию: кому отвечаем, что произошло и какой результат нужен.",
  review: "Пришли свой черновик ответа вместе с контекстом.",
  client: "Пришли сообщение клиента и, если важно, цену или условия.",
  hr: "Пришли сообщение HR и напиши, чего хочешь: отклик, перенос, зарплата или отказ.",
  marketplace: "Пришли вопрос или отзыв покупателя и данные о товаре.",
  complaint: "Пришли претензию и реальные варианты решения, которые можешь предложить.",
};

function isFlowId(value: string): value is FlowId {
  return (flowIds as readonly string[]).includes(value);
}

function isCategoryId(value: string): value is CategoryId {
  return (categoryIds as readonly string[]).includes(value);
}

function isRefinementId(value: string): value is RefinementId {
  return (refinementIds as readonly string[]).includes(value);
}

export function createBot(
  config: AppConfig,
  db: BotDatabase,
  ai: AiService,
  analytics: ProductAnalytics,
): BotRuntime {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const pendingAlbums = new Map<string, PendingAlbum>();
  const backgroundTasks = new Set<Promise<void>>();
  const resourceLimiter = new Semaphore(2);
  const imageLimits = {
    plus: config.PLUS_IMAGE_LIMIT,
    pro: config.PRO_IMAGE_LIMIT,
    global: config.GLOBAL_IMAGE_LIMIT,
    windowSeconds: config.IMAGE_WINDOW_HOURS * 60 * 60,
  };
  let lastAdminErrorAt = 0;

  const track = (
    telegramId: number,
    event: string,
    detail?: string,
    properties: AnalyticsProperties = {},
  ): void => {
    db.recordEvent(telegramId, event, detail);
    analytics.capture(telegramId, event, properties);
    if (
      [
        "generation_text",
        "generation_photo",
        "generation_voice",
        "generation_document",
        "image_created",
        "image_edited",
      ]
        .includes(event)
      && db.claimAction(telegramId, "analytics-first-result", 100 * 365 * 24 * 60 * 60)
    ) {
      db.recordEvent(telegramId, "first_result", event);
      analytics.capture(telegramId, "first_result", {
        result_type: event,
        ...properties,
      });
    }
  };

  const notifyAdminError = async (label: string, error: unknown): Promise<void> => {
    if (!config.ADMIN_TELEGRAM_ID || Date.now() - lastAdminErrorAt < 5 * 60 * 1_000) return;
    lastAdminErrorAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    try {
      await bot.api.sendMessage(
        config.ADMIN_TELEGRAM_ID,
        `🚨 Ошибка бота\n\n${label}\n${message.slice(0, 700)}`,
      );
    } catch (notificationError) {
      console.error("Admin error notification failed", notificationError);
    }
  };

  const trackBackgroundTask = (task: Promise<void>): void => {
    const guarded = task.catch((error) => console.error("Background album error", error));
    backgroundTasks.add(guarded);
    void guarded.then(() => backgroundTasks.delete(guarded));
  };

  bot.use(async (ctx, next) => {
    if (ctx.preCheckoutQuery) {
      const query = ctx.preCheckoutQuery;
      const parsed = parsePaymentPayload(query.invoice_payload);
      const subscription = parseSubscriptionPayload(query.invoice_payload);
      const selected = parsed ? CREDIT_PACKAGES[parsed.packageId] : undefined;
      const selectedPlan = subscription ? PLUS_PLANS[subscription.productId] : undefined;
      const hasActiveSubscription = subscription
        ? db.getSubscriptionAccess(query.from.id).active
        : false;
      const validCredits = Boolean(
        parsed
        && selected
        && parsed.telegramId === query.from.id
        && query.currency === "XTR"
        && query.total_amount === selected.stars,
      );
      const validSubscription = validateSubscriptionCheckout(
        query.invoice_payload,
        query.from.id,
        query.currency,
        query.total_amount,
        hasActiveSubscription,
      );
      const valid = validCredits || validSubscription;
      if (valid) {
        db.ensureUser(query.from.id, query.from.username, query.from.first_name);
        track(query.from.id, "checkout_confirmed", subscription ? "plus_subscription" : selected?.id, {
          package_id: subscription ? "plus_subscription" : selected?.id,
          stars: selectedPlan?.stars ?? selected?.stars,
        });
      }
      await ctx.answerPreCheckoutQuery(
        valid,
        valid ? undefined : {
          error_message: hasActiveSubscription
            ? "Plus уже активен. Дождись окончания тарифа или управляй им в аккаунте."
            : "Счёт устарел или повреждён. Вернись в тарифы и создай новый.",
        },
      );
      return;
    }

    const payment = ctx.message?.successful_payment;
    if (!payment || !ctx.from) {
      await next();
      return;
    }
    db.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    const subscription = parseSubscriptionPayload(payment.invoice_payload);
    const selectedPlan = subscription ? PLUS_PLANS[subscription.productId] : undefined;
    if (
      subscription
      && selectedPlan
      && subscription.telegramId === ctx.from.id
      && payment.currency === "XTR"
      && payment.total_amount === selectedPlan.stars
    ) {
      const periodStart = Math.floor(Date.now() / 1000);
      const periodEnd = payment.subscription_expiration_date
        ?? periodStart + selectedPlan.months * PLUS_SUBSCRIPTION_PERIOD_SECONDS;
      const activated = db.recordSubscriptionPayment(
        ctx.from.id,
        selectedPlan.stars,
        payment.invoice_payload,
        payment.telegram_payment_charge_id,
        periodEnd,
        selectedPlan.recurring ? payment.is_first_recurring === true : true,
        {
          periodStart: selectedPlan.recurring
            ? periodEnd - PLUS_SUBSCRIPTION_PERIOD_SECONDS
            : periodStart,
          requestLimit: selectedPlan.requestLimit,
          imageLimit: selectedPlan.imageLimit,
          durationMonths: selectedPlan.months,
          recurring: selectedPlan.recurring,
        },
      );
      if (!activated) {
        await ctx.reply("Этот платёж уже обработан. Подписка Plus остаётся активной.");
        return;
      }
      track(ctx.from.id, "subscription_started", "plus", {
        stars: selectedPlan.stars,
        duration_months: selectedPlan.months,
        period_end: periodEnd,
      });
      await ctx.reply(
        [
          "<b>Plus активирован ✅</b>",
          "",
          `Доступно <b>${selectedPlan.requestLimit} AI-баллов</b> и до <b>${selectedPlan.imageLimit} картинок</b>.`,
          selectedPlan.recurring
            ? `Подписка действует до ${formatUnixDate(periodEnd)} и продлевается автоматически.`
            : `Доступ оплачен до ${formatUnixDate(periodEnd)}. Автосписания нет.`,
          "",
          "Отправь фото, голос, вопрос или описание картинки — можно начинать.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      if (config.ADMIN_TELEGRAM_ID) {
        void ctx.api.sendMessage(
          config.ADMIN_TELEGRAM_ID,
          `💰 Новый Plus на ${selectedPlan.title}\nПолучено: ${selectedPlan.stars} Stars\nПользователь: ${ctx.from.id}`,
        ).catch((error) => console.error("Subscription notification failed", error));
      }
      return;
    }
    const parsed = parsePaymentPayload(payment.invoice_payload);
    const selected = parsed ? CREDIT_PACKAGES[parsed.packageId] : undefined;
    if (
      !parsed
      || !selected
      || parsed.telegramId !== ctx.from.id
      || payment.currency !== "XTR"
      || payment.total_amount !== selected.stars
    ) {
      console.error("Invalid successful payment", {
        telegramId: ctx.from.id,
        payload: payment.invoice_payload,
        amount: payment.total_amount,
      });
      await ctx.reply(
        "Платёж получен, но пакет не удалось определить. Напиши /paysupport — мы проверим вручную.",
      );
      return;
    }
    const credited = db.recordPayment(
      ctx.from.id,
      parsed.packageId,
      selected.credits,
      selected.stars,
      payment.invoice_payload,
      payment.telegram_payment_charge_id,
    );
    if (!credited) {
      await ctx.reply("Этот платёж уже был обработан. Повторно запросы не начислялись.");
      return;
    }
    track(ctx.from.id, "purchase_completed", selected.id, {
      package_id: selected.id,
      credits: selected.credits,
      stars: selected.stars,
    });
    const access = db.getAccess(ctx.from.id);
    await ctx.reply(
      [
        "<b>Оплата прошла ✅</b>",
        "",
        `Начислено: <b>${selected.credits} запросов</b>`,
        `Теперь доступно: <b>${access.credits}</b>`,
        "",
        "Баллы подходят для вопросов, голоса, разбора фото и картинок.",
        "Новая картинка — 2 балла, изменение фото — 3 балла.",
        "",
        "Отправь следующую задачу — можно начинать.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    if (config.ADMIN_TELEGRAM_ID) {
      void ctx.api.sendMessage(
        config.ADMIN_TELEGRAM_ID,
        `💰 Новая оплата\nПакет: ${selected.title}\nПолучено: ${selected.stars} Stars\nНачислено: ${selected.credits} запросов\nПользователь: ${ctx.from.id}`,
      ).catch((error) => console.error("Payment notification failed", error));
    }
  });

  bot.use(sequentialize((ctx) => {
    return ctx.from ? `user:${ctx.from.id}` : ctx.chat ? `chat:${ctx.chat.id}` : undefined;
  }));

  bot.use(session({ initial: (): BotSession => ({ awaitingInput: false }) }));

  bot.use(async (ctx, next) => {
    if (!db.claimUpdate(ctx.update.update_id)) return;
    await next();
  });

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      db.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
      if (db.claimAction(ctx.from.id, "analytics-active", 60 * 60)) {
        db.recordEvent(ctx.from.id, "user_active");
      }
      if (
        ctx.from.id === config.ADMIN_TELEGRAM_ID
        || config.UNLIMITED_TELEGRAM_IDS.includes(ctx.from.id)
      ) db.setPlan(ctx.from.id, "pro");
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    if (!db.claimAction(ctx.from.id, "start", 30)) {
      try {
        await ctx.deleteMessage();
      } catch (error) {
        console.warn("Could not delete duplicate /start", error);
      }
      return;
    }
    const source = sanitizeStartSource(ctx.match);
    db.recordAcquisition(ctx.from.id, source);
    track(ctx.from.id, "bot_started", source, { source });
    ctx.session = { awaitingInput: false };
    const access = db.getAccess(ctx.from.id);
    const freeRemaining = Math.max(0, access.freeLimit - access.freeUsed);
    const accessLine = access.plan === "pro"
      ? "У тебя <b>безлимитный доступ</b>."
      : freeRemaining > 0
        ? `Доступно <b>${freeRemaining} бесплатных запросов</b>.`
        : access.credits > 0
          ? `Доступно <b>${access.credits} купленных запросов</b>.`
          : "Бесплатные запросы закончились — продолжение доступно в разделе «Тарифы».";
    await ctx.replyWithPhoto(new InputFile("./assets/welcome-cover.png"), {
      caption: [
        `Привет, ${escapeTelegramHtml(displayName(ctx.from?.first_name))} 👋`,
        "",
        "<b>Покажи или спроси</b>",
        "",
        "Напиши вопрос, отправь голосовое, фото, скриншот или PDF — я сам пойму задачу.",
        "",
        "Для создания и изменения изображений открой раздел «Картинки».",
        "",
        accessLine,
      ].join("\n"),
      parse_mode: "HTML",
      reply_markup: mainMenu(),
    });
    if (source === "miniapp_plus") {
      await ctx.reply("Выбери Plus или разовый пакет запросов:", {
        reply_markup: tariffsMenu(),
      });
    }
  });

  bot.command("menu", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.reply(
      [
        "<b>Что хочешь сделать?</b>",
        "",
        "Можно выбрать действие или сразу отправить вопрос, фото, голосовое либо PDF.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainMenu() },
    );
  });

  bot.callbackQuery("menu:capabilities", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearCallbackKeyboard(ctx);
    await ctx.reply([
      "🤖 Что умеет Пойми AI",
      "",
      "📸 Объясняет фото, товары и скриншоты",
      "🎙 Понимает голосовые сообщения",
      "🎓 Помогает с учёбой и задачами",
      "✍️ Пишет и переводит тексты",
      "🎨 Создаёт и изменяет изображения",
      "",
      "Просто напиши или отправь файл — режим выбирать не нужно.",
    ].join("\n"));
  });

  bot.command("image", async (ctx) => {
    ctx.session.awaitingImagePrompt = true;
    await ctx.reply("Опиши картинку, которую хочешь получить. Например: «Космический Иркутск ночью, реалистичное фото».", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Что можно поручить Пойми AI</b>",
        "",
        "📸 <b>Фото:</b> «Что это?», «Как использовать?», «Что написано на этикетке?»",
        "🎓 <b>Учёба:</b> «Реши по шагам», «Объясни как новичку», «Проверь ответ»",
        "✍️ <b>Текст:</b> «Напиши вежливее», «Сократи», «Переведи», «Исправь ошибки»",
        "🎙 <b>Голос:</b> задай вопрос как человеку — я распознаю и отвечу",
        "🎨 <b>Картинки:</b> «Нарисуй уютное кафе у озера» или отправь фото и напиши, что изменить",
        "",
        "<b>Ничего выбирать не нужно.</b> Просто отправь задачу удобным способом.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainMenu() },
    );
  });

  bot.command("balance", async (ctx) => {
    if (!ctx.from) return;
    const access = db.getAccess(ctx.from.id);
    const subscriptionRequests = db.getSubscriptionRequestAllowance(
      ctx.from.id,
      config.PLUS_REQUEST_LIMIT,
    );
    await ctx.reply(balanceText(
      access.freeUsed,
      access.freeLimit,
      access.credits,
      access.plan,
      subscriptionRequests,
    ));
  });

  bot.command("paysupport", async (ctx) => {
    await ctx.reply(
      "Поддержка доступна всем пользователям, подписка не нужна. Нажми кнопку ниже и напиши нам напрямую.",
      { reply_markup: new InlineKeyboard().url("Открыть @PoymiAI_support", SUPPORT_TELEGRAM_URL) },
    );
  });

  bot.command("documents", async (ctx) => {
    await ctx.reply(
      "<b>📄 Документы Пойми AI</b>\n\nВсе документы доступны без подписки и авторизации.",
      { parse_mode: "HTML", reply_markup: documentsMenu() },
    );
  });

  bot.command("myid", async (ctx) => {
    if (!ctx.from) return;
    const role = ctx.from.id === config.ADMIN_TELEGRAM_ID
      || config.UNLIMITED_TELEGRAM_IDS.includes(ctx.from.id)
      ? "команда · расширенный доступ"
      : "пользователь";
    await ctx.reply(`Твой Telegram ID: ${ctx.from.id}\nСтатус: ${role}`);
  });

  bot.command("grant", async (ctx) => {
    if (!ctx.from || ctx.from.id !== config.ADMIN_TELEGRAM_ID) return;
    const [, rawId, rawAmount] = ctx.message?.text?.trim().split(/\s+/) ?? [];
    const targetId = Number(rawId);
    const amount = Number(rawAmount);
    if (!Number.isSafeInteger(targetId) || !Number.isInteger(amount) || amount <= 0) {
      await ctx.reply("Формат: /grant TELEGRAM_ID КОЛИЧЕСТВО");
      return;
    }
    if (!db.adminGrantCredits(ctx.from.id, targetId, amount)) {
      await ctx.reply("Пользователь не найден. Попроси его сначала открыть бота и отправить /myid.");
      return;
    }
    await ctx.reply(`Готово: пользователю ${targetId} начислено ${amount} запросов.`);
  });

  bot.command("refund", async (ctx) => {
    if (!ctx.from || ctx.from.id !== config.ADMIN_TELEGRAM_ID) return;
    const [, chargeId] = ctx.message?.text?.trim().split(/\s+/) ?? [];
    if (!chargeId) {
      await ctx.reply("Формат: /refund ID_ПЛАТЕЖА");
      return;
    }
    const payment = db.getPayment(chargeId);
    const subscriptionPayment = db.getSubscriptionPayment(chargeId);
    if (!payment && !subscriptionPayment) {
      await ctx.reply("Платёж с таким ID не найден.");
      return;
    }
    const target = payment ?? subscriptionPayment!;
    if (target.status === "refunded") {
      await ctx.reply("Этот платёж уже возвращён.");
      return;
    }
    try {
      await ctx.api.refundStarPayment(target.telegramId, chargeId);
      if (payment) db.markPaymentRefunded(chargeId);
      else db.markSubscriptionPaymentRefunded(chargeId);
      track(target.telegramId, "payment_refunded", payment?.packageId ?? "plus_subscription", {
        package_id: payment?.packageId ?? "plus_subscription",
        stars: target.stars,
      });
      await ctx.reply(`Возврат ${target.stars} Stars выполнен пользователю ${target.telegramId}.`);
    } catch (error) {
      console.error("Refund error", error);
      await ctx.reply("Telegram не выполнил возврат. Проверь ID платежа и баланс бота.");
    }
  });

  const showAdminReport = async (ctx: BotContext, periodDays: AnalyticsPeriodDays): Promise<void> => {
    const balance = await getBotStarBalance(ctx.api);
    await ctx.reply(formatBusinessReport(db.businessStats(periodDays), balance), {
      reply_markup: adminKeyboard(periodDays),
    });
  };

  bot.command(["admin", "stats"], async (ctx) => {
    if (!ctx.from || ctx.from.id !== config.ADMIN_TELEGRAM_ID) return;
    await showAdminReport(ctx, 1);
  });

  bot.callbackQuery(/^admin:period:(0|1|7|30)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    await ctx.answerCallbackQuery("Обновляю…");
    const periodDays = Number(ctx.match[1]) as AnalyticsPeriodDays;
    const balance = await getBotStarBalance(ctx.api);
    await ctx.editMessageText(formatBusinessReport(db.businessStats(periodDays), balance), {
      reply_markup: adminKeyboard(periodDays),
    });
  });

  bot.callbackQuery("admin:sources", async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatAcquisitionReport(db.acquisitionStats()), {
      reply_markup: new InlineKeyboard().text("← К отчёту", "admin:period:30"),
    });
  });

  bot.callbackQuery("admin:user-search", async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    ctx.session.adminAwaitingUserId = true;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Отправь Telegram ID пользователя одним числом. Пользователь найдёт его командой /myid.",
      { reply_markup: new InlineKeyboard().text("Отмена", "admin:cancel-search") },
    );
  });

  bot.callbackQuery("admin:cancel-search", async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    ctx.session.adminAwaitingUserId = false;
    await ctx.answerCallbackQuery("Отменено");
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery("admin:payments", async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatAdminPaymentFeed(db), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("← В админку", "admin:period:1"),
    });
  });

  bot.callbackQuery(/^admin:user:(\d+)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    if (!Number.isSafeInteger(telegramId)) return ctx.answerCallbackQuery("Некорректный ID");
    const card = formatAdminUserCard(db, telegramId, config.PLUS_REQUEST_LIMIT);
    if (!card) return ctx.answerCallbackQuery({ text: "Пользователь не найден", show_alert: true });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(card, {
      parse_mode: "HTML",
      reply_markup: adminUserKeyboard(telegramId),
    });
  });

  bot.callbackQuery(/^admin:user-payments:(\d+)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    if (!Number.isSafeInteger(telegramId)) return ctx.answerCallbackQuery("Некорректный ID");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(formatAdminUserPayments(db, telegramId), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("← К пользователю", `admin:user:${telegramId}`),
    });
  });

  bot.callbackQuery(/^admin:grant-(plus|credits):(\d+)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const kind = ctx.match[1];
    const telegramId = Number(ctx.match[2]);
    if (!db.getAdminUser(telegramId)) return ctx.answerCallbackQuery("Пользователь не найден");
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    if (kind === "plus") {
      for (const plan of Object.values(PLUS_PLANS)) {
        keyboard.text(plan.title, `admin:prepare-plus:${telegramId}:${plan.id}`).row();
      }
    } else {
      for (const amount of [50, 200, 500]) {
        keyboard.text(`${amount} запросов`, `admin:prepare-credits:${telegramId}:${amount}`).row();
      }
    }
    keyboard.text("← К пользователю", `admin:user:${telegramId}`);
    await ctx.editMessageText(
      kind === "plus" ? "На какой срок выдать Plus?" : "Сколько запросов начислить?",
      { reply_markup: keyboard },
    );
  });

  bot.callbackQuery(/^admin:prepare-plus:(\d+):(1m|3m|6m|12m)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    const planId = ctx.match[2];
    if (!planId || !isPlusPlanId(planId) || !db.getAdminUser(telegramId)) {
      return ctx.answerCallbackQuery("Данные не найдены");
    }
    const plan = PLUS_PLANS[planId];
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        "<b>Подтверди ручную выдачу</b>",
        "",
        `Пользователь: <code>${telegramId}</code>`,
        `Plus: <b>${plan.title}</b>`,
        `${plan.requestLimit} AI-баллов · до ${plan.imageLimit} картинок`,
        "",
        "Деньги эта операция не списывает. Действие попадёт в журнал.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ Выдать", `admin:confirm-plus:${telegramId}:${planId}`).row()
          .text("Отмена", `admin:user:${telegramId}`),
      },
    );
  });

  bot.callbackQuery(/^admin:prepare-credits:(\d+):(50|200|500)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    const amount = Number(ctx.match[2]);
    if (!db.getAdminUser(telegramId)) return ctx.answerCallbackQuery("Пользователь не найден");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        "<b>Подтверди начисление</b>",
        "",
        `Пользователь: <code>${telegramId}</code>`,
        `Запросы: <b>${amount}</b>`,
        "",
        "Деньги эта операция не списывает. Действие попадёт в журнал.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ Начислить", `admin:confirm-credits:${telegramId}:${amount}`).row()
          .text("Отмена", `admin:user:${telegramId}`),
      },
    );
  });

  bot.callbackQuery(/^admin:confirm-plus:(\d+):(1m|3m|6m|12m)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    const planId = ctx.match[2];
    if (!planId || !isPlusPlanId(planId)) return ctx.answerCallbackQuery("Неизвестный тариф");
    const plan = PLUS_PLANS[planId];
    const periodEnd = db.adminGrantPlus(ctx.from.id, telegramId, plan);
    if (!periodEnd) return ctx.answerCallbackQuery({ text: "Пользователь не найден", show_alert: true });
    await ctx.answerCallbackQuery("Plus выдан ✅");
    await ctx.editMessageText(formatAdminUserCard(db, telegramId, config.PLUS_REQUEST_LIMIT)!, {
      parse_mode: "HTML",
      reply_markup: adminUserKeyboard(telegramId),
    });
    await ctx.api.sendMessage(
      telegramId,
      `Поддержка начислила Plus на ${plan.title} ✅\nДоступ активен до ${formatUnixDate(periodEnd)}.`,
    ).catch(() => undefined);
  });

  bot.callbackQuery(/^admin:confirm-credits:(\d+):(50|200|500)$/, async (ctx) => {
    if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) return ctx.answerCallbackQuery("Нет доступа");
    const telegramId = Number(ctx.match[1]);
    const amount = Number(ctx.match[2]);
    if (!db.adminGrantCredits(ctx.from.id, telegramId, amount)) {
      return ctx.answerCallbackQuery({ text: "Пользователь не найден", show_alert: true });
    }
    await ctx.answerCallbackQuery("Запросы начислены ✅");
    await ctx.editMessageText(formatAdminUserCard(db, telegramId, config.PLUS_REQUEST_LIMIT)!, {
      parse_mode: "HTML",
      reply_markup: adminUserKeyboard(telegramId),
    });
    await ctx.api.sendMessage(
      telegramId,
      `Поддержка начислила ${amount} запросов ✅\nОни уже доступны в твоём аккаунте.`,
    ).catch(() => undefined);
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      [
        "<b>Что хочешь сделать?</b>",
        "",
        "Можно выбрать действие или сразу отправить вопрос, фото, голосовое либо PDF.",
      ].join("\n"),
      mainMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:chat", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.answerCallbackQuery({
      text: "Напиши вопрос или отправь голосовое",
      show_alert: false,
    });
  });

  bot.callbackQuery("menu:analyze", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.answerCallbackQuery({
      text: "Отправь фото, скриншот или PDF",
      show_alert: false,
    });
  });

  bot.callbackQuery("menu:images", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      "<b>🎨 Картинки</b>\n\nЧто сделать?",
      imagesMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:examples", async (ctx) => {
    await ctx.answerCallbackQuery("Нажми на скрытый текст ✨");
    await editOrReplyMenu(
      ctx,
      [
        "<b>✨ Что можно отправить</b>",
        "",
        "📸 <b>Фото товара</b>",
        "<tg-spoiler>Сфотографируй упаковку и спроси: «Что это и как использовать?»</tg-spoiler>",
        "",
        "🎓 <b>Задачу</b>",
        "<tg-spoiler>Отправь фото примера и напиши: «Реши по шагам».</tg-spoiler>",
        "",
        "🎙 <b>Голосовой вопрос</b>",
        "<tg-spoiler>Запиши вопрос обычными словами — бот распознает и ответит.</tg-spoiler>",
        "",
        "🎨 <b>Идею для картинки</b>",
        "<tg-spoiler>Напиши: «Нарисуй уютное кафе у озера вечером».</tg-spoiler>",
        "",
        "<b>Ничего выбирать не нужно — просто отправь задачу.</b>",
      ].join("\n"),
      new InlineKeyboard().text("← Назад", "menu:main"),
      "HTML",
    );
  });

  bot.callbackQuery("menu:tariffs", async (ctx) => {
    track(ctx.from.id, "pricing_viewed");
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    const subscription = db.getSubscriptionAccess(ctx.from.id);
    const subscriptionRequests = db.getSubscriptionRequestAllowance(
      ctx.from.id,
      config.PLUS_REQUEST_LIMIT,
    );
    await editOrReplyMenu(
      ctx,
      [
        "<b>⭐ Plus и запросы</b>",
        "",
        subscription.active
          ? `Активен до <b>${formatUnixDate(subscription.periodEnd!)}</b>`
          : "Выбери срок: <b>1, 3, 6 или 12 месяцев</b>.",
        subscription.active
          ? `<b>${subscription.requestLimit ?? config.PLUS_REQUEST_LIMIT} AI-баллов</b> · до <b>${subscription.imageLimit ?? config.PLUS_IMAGE_LIMIT} картинок</b>`
          : "Чем дольше срок, тем больше AI-баллов и выгоднее цена.",
        ...(subscriptionRequests.active
          ? [`Осталось: <b>${subscriptionRequests.remaining}</b> из ${subscriptionRequests.limit} AI-баллов.`]
          : []),
        "",
        "Ответ, фото, PDF, голос — 1 балл",
        "Новая картинка — 2 · изменение фото — 3",
        "",
        ...(subscription.active
          ? [`Разовые запросы: ${access.credits}`]
          : [userTariffStatus(access.freeUsed, access.freeLimit, access.credits, access.plan)]),
        ...(subscription.active
          ? [subscription.recurring
              ? `Автопродление: ${subscription.autoRenew ? "включено" : "выключено"}.`
              : "Предоплаченный период без автосписания."]
          : ["Автопродление есть только у тарифа на 1 месяц."]),
      ].join("\n"),
      subscription.active
        ? subscriptionMenu(subscription.autoRenew, subscription.recurring)
        : tariffsMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:plus-plans", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      [
        "<b>⭐ Выбери срок Plus</b>",
        "",
        formatPlusPlanLine(PLUS_PLANS["1m"]),
        formatPlusPlanLine(PLUS_PLANS["3m"], "выгоднее"),
        formatPlusPlanLine(PLUS_PLANS["6m"], "популярный"),
        formatPlusPlanLine(PLUS_PLANS["12m"], "максимум выгоды"),
        "",
        "AI-баллы расходуются на ответы, фото, голос и картинки.",
        "Картинка — 2 балла · изменение фото — 3 балла.",
        "",
        "1 месяц продлевается автоматически. Остальные сроки оплачиваются один раз.",
      ].join("\n"),
      plusPlansMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:credit-packs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      [
        "<b>📦 Разовые запросы</b>",
        "",
        "Подписка не нужна, AI-баллы не сгорают.",
        "Их можно тратить на вопросы, голос, разбор фото и картинки.",
        "",
        "Ответ, фото или голос — 1 балл",
        "Новая картинка — 2 · изменение фото — 3",
      ].join("\n"),
      creditPacksMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:paywall", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearCallbackKeyboard(ctx);
    await replyPaywall(ctx);
  });

  bot.callbackQuery("subscribe:plus", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(ctx, "<b>⭐ Выбери срок Plus</b>", plusPlansMenu(), "HTML");
  });

  bot.callbackQuery(/^subscribe:(1m|3m|6m|12m)$/, async (ctx) => {
    const productId = ctx.match[1];
    if (!productId || !isPlusPlanId(productId)) {
      await ctx.answerCallbackQuery("Неизвестный тариф");
      return;
    }
    if (db.getSubscriptionAccess(ctx.from.id).active) {
      await ctx.answerCallbackQuery({
        text: "Plus уже активен. Управлять им можно в аккаунте.",
        show_alert: true,
      });
      return;
    }
    const plan = PLUS_PLANS[productId];
    await ctx.answerCallbackQuery();
    await dismissCallbackMessage(ctx);
    track(ctx.from.id, "subscription_invoice_created", productId, {
      stars: plan.stars,
      duration_months: plan.months,
    });
    const invoiceUrl = await ctx.api.raw.createInvoiceLink({
      title: `Пойми AI Plus · ${plan.title}`,
      description: `${plan.requestLimit} AI-баллов и до ${plan.imageLimit} картинок на ${plan.title}.`,
      payload: createSubscriptionPayload(ctx.from.id, productId),
      currency: "XTR",
      prices: [{ label: `Plus · ${plan.title}`, amount: plan.stars }],
      ...(plan.recurring ? { subscription_period: PLUS_SUBSCRIPTION_PERIOD_SECONDS } : {}),
    });
    await ctx.reply(
      [
        `<b>Plus · ${plan.title}</b>`,
        "",
        `<b>${plan.stars} Stars</b>`,
        `${plan.requestLimit} AI-баллов · до ${plan.imageLimit} картинок`,
        plan.recurring
          ? "Автопродление каждые 30 дней можно отключить в аккаунте."
          : "Один платёж. Автосписания нет.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .url(`Оплатить ${plan.stars} ⭐`, invoiceUrl).row()
          .text("← Выбрать другой срок", "menu:plus-plans"),
      },
    );
  });

  bot.callbackQuery("stars:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    track(ctx.from.id, "stars_help_viewed");
    await editOrReplyMenu(
      ctx,
      [
        "⭐ Как купить Telegram Stars",
        "",
        "Без App Store:",
        "1. Открой Telegram Desktop, Telegram Web или прямую Android-версию.",
        "2. Нажми кнопку «Открыть @PremiumBot» ниже.",
        "3. Выбери Telegram Stars и нужное количество.",
        "4. После оплаты вернись в Пойми AI.",
        "5. Открой «Тарифы» и выбери «Plus» или разовый пакет.",
        "",
        "Используй только официальный бот Telegram — @PremiumBot.",
      ].join("\n"),
      new InlineKeyboard()
        .url("⭐ Открыть @PremiumBot", "https://t.me/PremiumBot").row()
        .text("← К тарифам", "menu:tariffs"),
    );
  });

  bot.callbackQuery(/^subscription:(cancel|resume)$/, async (ctx) => {
    const subscription = db.getSubscriptionAccess(ctx.from.id);
    if (!subscription.active || !subscription.latestChargeId || !subscription.recurring) {
      await ctx.answerCallbackQuery("Активная подписка не найдена");
      return;
    }
    const cancel = ctx.match[1] === "cancel";
    await ctx.api.editUserStarSubscription(ctx.from.id, subscription.latestChargeId, cancel);
    db.setSubscriptionAutoRenew(ctx.from.id, !cancel);
    await ctx.answerCallbackQuery(cancel ? "Автопродление выключено" : "Автопродление включено");
    await ctx.editMessageReplyMarkup({ reply_markup: subscriptionMenu(!cancel, true) });
  });

  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    const packageId = ctx.match[1];
    if (!packageId || !isCreditPackageId(packageId)) {
      await ctx.answerCallbackQuery("Неизвестный пакет");
      return;
    }
    const selected = CREDIT_PACKAGES[packageId];
    track(ctx.from.id, "invoice_created", selected.id, {
      package_id: selected.id,
      stars: selected.stars,
    });
    await ctx.answerCallbackQuery();
    await dismissCallbackMessage(ctx);
    await ctx.replyWithInvoice(
      `Пакет «${selected.title}»`,
      `${selected.credits} AI-баллов для ответов, фото, голоса и картинок. Баллы не сгорают.`,
      createPaymentPayload(packageId, ctx.from.id),
      "XTR",
      [{ label: `${selected.credits} запросов`, amount: selected.stars }],
      {
        reply_markup: new InlineKeyboard()
          .pay(`Оплатить ${selected.stars} ⭐`).row()
          .text("← Тарифы", "menu:tariffs"),
      },
    );
  });

  bot.callbackQuery("menu:payments", async (ctx) => {
    await ctx.answerCallbackQuery();
    const payments = db.recentPayments(ctx.from.id, 10);
    const subscriptions = db.recentSubscriptionPayments(ctx.from.id, 10);
    const sections: string[] = [];
    if (subscriptions.length) sections.push(`Plus:\n${subscriptions.map((payment, index) => [
      `${index + 1}. Plus · ${payment.stars} ⭐`,
      payment.status === "paid" ? `Доступ до: ${formatUnixDate(payment.periodEnd)}` : "Статус: возврат выполнен",
      `ID: ${payment.chargeId}`,
      `Дата: ${formatPaymentDate(payment.createdAt)}`,
    ].join("\n")).join("\n\n")}`);
    if (payments.length) sections.push(`Разовые запросы:\n${payments.map((payment, index) => [
        `${index + 1}. ${payment.credits} запросов · ${payment.stars} ⭐`,
        payment.status === "paid" ? "Статус: оплачено" : "Статус: возврат выполнен",
        `ID: ${payment.chargeId}`,
        `Дата: ${formatPaymentDate(payment.createdAt)}`,
      ].join("\n")).join("\n\n")}`);
    const text = sections.length ? `🧾 Мои покупки\n\n${sections.join("\n\n")}` : "Покупок пока нет.";
    await editOrReplyMenu(
      ctx,
      text,
      new InlineKeyboard().text("← В кабинет", "menu:profile"),
    );
  });

  bot.callbackQuery("menu:profile", async (ctx) => {
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    const subscription = db.getSubscriptionAccess(ctx.from.id);
    const subscriptionRequests = db.getSubscriptionRequestAllowance(
      ctx.from.id,
      config.PLUS_REQUEST_LIMIT,
    );
    await editOrReplyMenu(
      ctx,
      [
        "<b>👤 Аккаунт</b>",
        "",
        userTariffStatus(
          access.freeUsed,
          access.freeLimit,
          access.credits,
          access.plan,
          subscriptionRequests,
        ),
        ...(subscription.active ? [`Plus активен до ${formatUnixDate(subscription.periodEnd!)}`] : []),
      ].join("\n"),
      profileMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:documents", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      "<b>📄 Документы Пойми AI</b>\n\nВсе документы доступны без подписки и авторизации.",
      documentsMenu(),
      "HTML",
    );
  });

  bot.callbackQuery("menu:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const referralUrl = `https://t.me/${ctx.me.username}?start=ref_${ctx.from.id}`;
    const shareText = [
      "Нашёл удобного AI-помощника — Пойми AI ✨",
      "",
      "📸 Объясняет фото, товары и скриншоты",
      "🎙 Понимает голосовые вопросы",
      "🎓 Помогает с учёбой и сложными темами",
      "✍️ Пишет и переводит тексты",
      "🎨 Создаёт картинки",
      "",
      "Попробуй — первые запросы бесплатные.",
    ].join("\n");
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralUrl)}&text=${encodeURIComponent(shareText)}`;
    track(ctx.from.id, "referral_share_opened");
    await editOrReplyMenu(
      ctx,
      [
        "👥 Пригласить друга",
        "",
        "Отправь другу готовое сообщение о Пойми AI. В нём будет твоя персональная ссылка.",
        "",
        "Когда человек запустит бот по ссылке, приглашение сохранится в статистике.",
        "",
        `Твоя ссылка:\n${referralUrl}`,
      ].join("\n"),
      new InlineKeyboard()
        .url("📤 Отправить другу", shareUrl).row()
        .text("← В кабинет", "menu:profile"),
    );
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    const images = db.getImageAllowance(ctx.from.id, imageLimits);
    const subscription = db.getSubscriptionAccess(ctx.from.id);
    const subscriptionRequests = db.getSubscriptionRequestAllowance(
      ctx.from.id,
      config.PLUS_REQUEST_LIMIT,
    );
    await editOrReplyMenu(
      ctx,
      [
        balanceText(
          access.freeUsed,
          access.freeLimit,
          access.credits,
          access.plan,
          subscriptionRequests,
        ),
        "",
        imageAllowanceText(images),
        ...(subscription.active ? [
          `Plus до: ${formatUnixDate(subscription.periodEnd!)}`,
          `Автопродление: ${subscription.autoRenew ? "включено" : "выключено"}`,
        ] : []),
      ].join("\n"),
      new InlineKeyboard()
        .text("⭐ Купить запросы", "menu:tariffs").row()
        .text("← В кабинет", "menu:profile"),
    );
  });

  bot.callbackQuery("menu:refinements", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: refinementsMenu() });
  });

  bot.callbackQuery("menu:result", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: resultMenu() });
  });

  bot.callbackQuery("menu:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    const items = db.recentGenerations(ctx.from.id, 5);
    const text = items.length
      ? `🕘 Последние ответы\n\n${items.map((item, index) => `${index + 1}. ${FLOW_LABELS[item.flow]}\n${item.result.slice(0, 450)}`).join("\n\n")}`
      : "История пока пустая.";
    await editOrReplyMenu(
      ctx,
      text,
      new InlineKeyboard().text("← В кабинет", "menu:profile"),
    );
  });

  bot.callbackQuery("menu:favorites", async (ctx) => {
    await ctx.answerCallbackQuery();
    const items = db.listFavorites(ctx.from.id);
    const text = items.length
      ? `⭐ Твои шаблоны\n\n${items.map((item, index) => `${index + 1}. ${item.title}\n${item.content}`).join("\n\n")}`
      : "Сохранённых шаблонов пока нет. После генерации нажми «⭐ Сохранить».";
    if (text.length <= 4_000) {
      await editOrReplyMenu(
        ctx,
        text,
        new InlineKeyboard().text("← В кабинет", "menu:profile"),
      );
      return;
    }
    await replyChunks(ctx, text);
    await ctx.reply("Вернуться к личным разделам:", {
      reply_markup: new InlineKeyboard().text("← В кабинет", "menu:profile"),
    });
  });

  bot.callbackQuery(/^flow:(.+)$/, async (ctx) => {
    const flow = ctx.match[1];
    if (!flow || !isFlowId(flow)) return ctx.answerCallbackQuery("Неизвестный сценарий");
    ctx.session.flow = flow;
    const category = quickCategory(flow);
    if (category) {
      await beginInput(ctx, flow, category);
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Выбрано: ${FLOW_LABELS[flow]}\nГде идёт переписка?`, {
      reply_markup: categoryMenu(flow),
    });
  });

  bot.callbackQuery(/^category:([^:]+):([^:]+)$/, async (ctx) => {
    const flow = ctx.match[1];
    const category = ctx.match[2];
    if (!flow || !category || !isFlowId(flow) || !isCategoryId(category)) {
      return ctx.answerCallbackQuery("Неизвестный режим");
    }
    await beginInput(ctx, flow, category);
  });

  bot.callbackQuery(/^refine:(.+)$/, async (ctx) => {
    const refinement = ctx.match[1];
    if (!refinement || !isRefinementId(refinement)) return ctx.answerCallbackQuery("Неизвестная команда");
    if (!ctx.session.lastSource || !ctx.session.lastResult || !ctx.session.flow || !ctx.session.category) {
      await ctx.answerCallbackQuery("Сначала создай ответ");
      return;
    }
    const reservation = db.reserveRequest(ctx.from.id);
    if (!reservation) {
      track(ctx.from.id, "paywall_shown", "refinement");
      await ctx.answerCallbackQuery("Лимит закончился");
      await replyPaywall(ctx);
      return;
    }
    await ctx.answerCallbackQuery("Переделываю…");
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");
      const result = await ai.refine(refinement, ctx.session.lastSource, ctx.session.lastResult);
      db.saveGeneration(ctx.from.id, ctx.session.flow, ctx.session.category, ctx.session.lastSource, result);
      db.commitRequest(reservation.id);
      track(ctx.from.id, "generation_refined", refinement, { refinement });
      ctx.session.lastResult = result;
      await replyResult(ctx, result);
    } catch (error) {
      db.releaseRequest(reservation.id);
      await handleError(ctx, error);
    }
  });

  bot.callbackQuery("action:favorite", async (ctx) => {
    if (!ctx.session.lastResult) return ctx.answerCallbackQuery("Сначала создай ответ");
    db.addFavorite(ctx.from.id, ctx.session.lastResult);
    await ctx.answerCallbackQuery("Сохранено в шаблоны ⭐");
  });

  bot.callbackQuery("visual:new-photo", async (ctx) => {
    delete ctx.session.visualResponseId;
    delete ctx.session.lastSource;
    delete ctx.session.lastResult;
    delete ctx.session.visualSources;
    delete ctx.session.pendingImageEditPrompt;
    ctx.session.awaitingInput = false;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await ctx.reply("Отправь новую фотографию через камеру или скрепку возле поля сообщения.");
  });

  bot.callbackQuery(["image:create", "image:again"], async (ctx) => {
    ctx.session.awaitingImagePrompt = true;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.answerCallbackQuery();
    await ctx.reply("Что нарисовать? Опиши сюжет, стиль и важные детали одним сообщением.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.callbackQuery("image:edit-new", async (ctx) => {
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = true;
    delete ctx.session.pendingImageEditPrompt;
    delete ctx.session.visualResponseId;
    delete ctx.session.visualSources;
    await ctx.answerCallbackQuery();
    await ctx.reply("Отправь фотографию, которую хочешь изменить.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.callbackQuery("image:edit-current", async (ctx) => {
    if (!ctx.session.visualSources?.length) {
      await ctx.answerCallbackQuery("Сначала отправь фото");
      return;
    }
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEditSource = false;
    ctx.session.awaitingImageEdit = true;
    delete ctx.session.pendingImageEditPrompt;
    await ctx.answerCallbackQuery();
    await ctx.reply("Что изменить на этой фотографии? Напиши одним сообщением.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.callbackQuery("image:edit-again", async (ctx) => {
    if (!ctx.session.visualSources?.length) {
      await ctx.answerCallbackQuery("Сначала отправь фото");
      return;
    }
    ctx.session.awaitingImageEdit = true;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    await ctx.answerCallbackQuery();
    await ctx.reply("Что ещё изменить на этой картинке? Напиши одним сообщением.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.callbackQuery("image:cancel", async (ctx) => {
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    ctx.session.awaitingImageEditSource = false;
    delete ctx.session.pendingImageEditPrompt;
    await ctx.answerCallbackQuery("Отменено");
    await editOrReplyMenu(ctx, "Выбери раздел или просто напиши вопрос.", mainMenu());
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (ctx.from.id === config.ADMIN_TELEGRAM_ID && ctx.session.adminAwaitingUserId) {
      const telegramId = parseAdminTelegramId(ctx.message.text);
      if (!telegramId) {
        await ctx.reply("Не похоже на Telegram ID. Пришли цифры или текст вида: ID: 1264985917.");
        return;
      }
      const card = formatAdminUserCard(db, telegramId, config.PLUS_REQUEST_LIMIT);
      if (!card) {
        await ctx.reply("Пользователь с таким ID ещё не запускал бота. Можешь сразу прислать другой ID.", {
          reply_markup: new InlineKeyboard().text("Отмена", "admin:cancel-search"),
        });
        return;
      }
      ctx.session.adminAwaitingUserId = false;
      await ctx.reply(card, {
        parse_mode: "HTML",
        reply_markup: adminUserKeyboard(telegramId),
      });
      return;
    }
    if (ctx.session.awaitingImageEdit && !ctx.session.visualSources?.length) {
      ctx.session.awaitingImageEdit = false;
      ctx.session.awaitingImageEditSource = true;
      await ctx.reply("Сначала отправь фотографию, которую нужно изменить.", {
        reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
      });
      return;
    }
    const editPrompt = ctx.session.awaitingImageEdit
      ? ctx.message.text.trim()
      : undefined;
    if (editPrompt && ctx.session.visualSources?.length) {
      ctx.session.awaitingImageEdit = false;
      await editImageForUser(
        ctx, config, db, ai, ctx.session.visualSources, editPrompt,
        imageLimits, resourceLimiter, track,
      );
      return;
    }
    const imagePrompt = extractImagePrompt(ctx.message.text, ctx.session.awaitingImagePrompt);
    if (imagePrompt !== undefined) {
      ctx.session.awaitingImagePrompt = false;
      if (!imagePrompt) {
        await ctx.reply("Добавь описание: что именно нарисовать, в каком стиле и с какими деталями.");
        return;
      }
      await generateImageForUser(ctx, db, ai, imagePrompt, imageLimits, track);
      return;
    }
    const directEditPrompt = extractImageEditPrompt(ctx.message.text);
    if (directEditPrompt && ctx.session.visualSources?.length) {
      delete ctx.session.visualResponseId;
      await editImageForUser(
        ctx, config, db, ai, ctx.session.visualSources, directEditPrompt,
        imageLimits, resourceLimiter, track,
      );
      return;
    }
    if (directEditPrompt) {
      ctx.session.awaitingImageEditSource = true;
      ctx.session.pendingImageEditPrompt = directEditPrompt;
      await ctx.reply(
        [
          "Похоже, ты хочешь изменить фотографию.",
          "",
          "Пришли исходное фото, и я применю эту правку:",
          directEditPrompt,
        ].join("\n"),
        { reply_markup: new InlineKeyboard().text("Отмена", "image:cancel") },
      );
      return;
    }
    if (ctx.session.visualResponseId) {
      await continueVisualConversation(ctx, db, ai, ctx.message.text, track);
      return;
    }
    if (readyForInput(ctx)) await generateForUser(ctx, db, ai, ctx.message.text, track);
    else await answerGeneralForUser(ctx, db, ai, ctx.message.text, track, "text");
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) {
      await ctx.reply("Не получилось получить фотографию. Попробуй отправить её ещё раз.");
      return;
    }
    const item: VisualMessageItem = {
      fileId: photo.file_id,
      fileSize: photo.file_size,
      mimeType: "image/jpeg",
      caption: ctx.message.caption,
    };
    const mediaGroupId = ctx.message.media_group_id;
    if (!mediaGroupId) {
      await processVisualItems(ctx, [item], config, db, ai, resourceLimiter, track);
      return;
    }

    const key = `${ctx.chat.id}:${mediaGroupId}`;
    const album = pendingAlbums.get(key) ?? { ctx, items: [], timer: undefined };
    if (album.items.length >= MAX_ALBUM_IMAGES) {
      await ctx.reply(`За один раз можно отправить не больше ${MAX_ALBUM_IMAGES} изображений.`);
      return;
    }
    album.items.push(item);
    if (album.timer) clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      const readyAlbum = pendingAlbums.get(key);
      if (!readyAlbum) return;
      pendingAlbums.delete(key);
      trackBackgroundTask(
        processVisualItems(readyAlbum.ctx, readyAlbum.items, config, db, ai, resourceLimiter, track),
      );
    }, 900);
    pendingAlbums.set(key, album);
  });

  bot.on("message:document", async (ctx) => {
    const mimeType = ctx.message.document.mime_type;
    if (mimeType === "application/pdf") {
      if ((ctx.message.document.file_size ?? 0) > MAX_PDF_BYTES) {
        await ctx.reply("PDF слишком большой. Максимальный размер — 8 МБ.");
        return;
      }
      await processPdfDocument(ctx, config, db, ai, resourceLimiter, track);
      return;
    }
    if (!mimeType?.startsWith("image/")) {
      await ctx.reply(
        "Сейчас я разбираю PDF, фотографии и скриншоты. Другой документ сохрани как PDF или отправь нужную страницу фотографией.",
      );
      return;
    }
    if ((ctx.message.document.file_size ?? 0) > MAX_IMAGE_BYTES) {
      await ctx.reply("Изображение слишком большое. Максимальный размер — 8 МБ.");
      return;
    }
    await processVisualItems(ctx, [{
      fileId: ctx.message.document.file_id,
      fileSize: ctx.message.document.file_size,
      mimeType,
      caption: ctx.message.caption,
    }], config, db, ai, resourceLimiter, track);
  });

  bot.on("message:voice", async (ctx) => {
    if (ctx.message.voice.duration > config.MAX_VOICE_SECONDS) {
      await ctx.reply(`Голосовое слишком длинное. Максимум — ${Math.floor(config.MAX_VOICE_SECONDS / 60)} мин.`);
      return;
    }
    if ((ctx.message.voice.file_size ?? 0) > MAX_VOICE_BYTES) {
      await ctx.reply("Голосовое сообщение слишком большое. Максимальный размер — 10 МБ.");
      return;
    }
    const reservation = await reserveForUser(ctx, db, track);
    if (!reservation) return;
    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const transcript = await resourceLimiter.run(async () => {
        const audio = await downloadTelegramFile(
          ctx, config.BOT_TOKEN, ctx.message.voice.file_id, MAX_VOICE_BYTES,
        );
        const transcript = await ai.transcribe(audio, "voice.ogg");
        if (!transcript) throw new Error("Не удалось распознать голос");
        return transcript;
      });
      const editPrompt = ctx.session.awaitingImageEdit ? transcript.trim() : undefined;
      if (editPrompt && ctx.session.visualSources?.length) {
        ctx.session.awaitingImageEdit = false;
        db.releaseRequest(reservation);
        await ctx.reply(`🎙 Распознано: ${transcript.slice(0, 800)}`);
        await editImageForUser(
          ctx, config, db, ai, ctx.session.visualSources, editPrompt,
          imageLimits, resourceLimiter, track,
        );
        return;
      }
      let result: string;
      try {
        result = await ai.answerGeneralWithHistory(transcript, ctx.session.generalHistory);
      } catch (error) {
        db.releaseRequest(reservation);
        throw error;
      }
      ctx.session.flow = "analyze";
      ctx.session.category = "auto";
      finishGeneration(ctx, db, transcript, result, reservation);
      rememberGeneralTurn(ctx, transcript, result);
      await ctx.reply(`🎙 Распознано: ${transcript.slice(0, 800)}`);
      await replyResult(ctx, result);
      track(ctx.from.id, "generation_voice", "voice", { input_type: "voice" });
      await notifyLastFreeRequest(ctx, db);
    } catch (error) {
      db.releaseRequest(reservation);
      await handleError(ctx, error);
    }
  });

  bot.catch(async (error) => {
    console.error("Bot error", error.error);
    await notifyAdminError("Необработанная ошибка", error.error);
    try {
      await error.ctx.reply("Что-то сломалось на моей стороне. Попробуй ещё раз через минуту.");
    } catch {
      // Telegram may be unavailable too.
    }
  });

  const drainBackgroundTasks = async (): Promise<void> => {
    for (const [key, album] of pendingAlbums) {
      if (album.timer) clearTimeout(album.timer);
      pendingAlbums.delete(key);
      trackBackgroundTask(
        processVisualItems(album.ctx, album.items, config, db, ai, resourceLimiter, track),
      );
    }
    while (backgroundTasks.size > 0) {
      await Promise.allSettled([...backgroundTasks]);
    }
  };

  return { bot, drainBackgroundTasks };
}

async function beginInput(ctx: BotContext, flow: FlowId, category: CategoryId): Promise<void> {
  ctx.session.flow = flow;
  ctx.session.category = category;
  ctx.session.awaitingInput = true;
  delete ctx.session.visualResponseId;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `${FLOW_LABELS[flow]} · ${CATEGORY_LABELS[category]}\n\n${INPUT_HINTS[flow]}\n\nНе отправляй пароли, данные карт и другие секреты.`,
  );
}

function readyForInput(ctx: BotContext): boolean {
  return Boolean(ctx.session.awaitingInput && ctx.session.flow && ctx.session.category);
}

async function reserveForUser(
  ctx: BotContext,
  db: BotDatabase,
  track?: TrackEvent,
): Promise<string | undefined> {
  const reservation = db.reserveRequest(ctx.from!.id);
  if (reservation) return reservation.id;
  track?.(ctx.from!.id, "paywall_shown");
  await replyPaywall(ctx);
  return undefined;
}

async function generateForUser(
  ctx: BotContext,
  db: BotDatabase,
  ai: AiService,
  source: string,
  track: TrackEvent,
): Promise<void> {
  const reservation = await reserveForUser(ctx, db, track);
  if (!reservation) return;
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    const result = await ai.generate(ctx.session.flow!, ctx.session.category!, source);
    finishGeneration(ctx, db, source, result, reservation);
    await replyResult(ctx, result);
    track(ctx.from!.id, "generation_text", ctx.session.flow, {
      input_type: "text",
      flow: ctx.session.flow,
      category: ctx.session.category,
    });
    await notifyLastFreeRequest(ctx, db);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function answerGeneralForUser(
  ctx: BotContext,
  db: BotDatabase,
  ai: AiService,
  source: string,
  track: TrackEvent,
  inputType: "text" | "voice",
): Promise<void> {
  const reservation = await reserveForUser(ctx, db, track);
  if (!reservation) return;
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    const result = cleanTelegramText(await ai.answerGeneralWithHistory(source, ctx.session.generalHistory));
    ctx.session.flow = "analyze";
    ctx.session.category = "auto";
    finishGeneration(ctx, db, source, result, reservation);
    rememberGeneralTurn(ctx, source, result);
    await replyResult(ctx, result);
    track(ctx.from!.id, `generation_${inputType}`, "general", { input_type: inputType });
    await notifyLastFreeRequest(ctx, db);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function processPdfDocument(
  ctx: BotContext,
  config: AppConfig,
  db: BotDatabase,
  ai: AiService,
  resourceLimiter: Semaphore,
  track: TrackEvent,
): Promise<void> {
  const document = ctx.message?.document;
  if (!document) return;
  const reservation = await reserveForUser(ctx, db, track);
  if (!reservation) return;
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    const filename = document.file_name?.trim() || "document.pdf";
    const result = await resourceLimiter.run(async () => {
      const data = await downloadTelegramFile(
        ctx,
        config.BOT_TOKEN,
        document.file_id,
        MAX_PDF_BYTES,
      );
      return ai.analyzePdf(data, filename, ctx.message?.caption);
    });
    const cleanResult = cleanTelegramText(result);
    ctx.session.flow = "analyze";
    ctx.session.category = "auto";
    const source = ctx.message?.caption?.trim()
      ? `PDF «${filename}». Вопрос: ${ctx.message.caption.trim()}`
      : `PDF «${filename}»`;
    finishGeneration(ctx, db, source, cleanResult, reservation);
    delete ctx.session.visualSources;
    await replyResult(ctx, cleanResult);
    track(ctx.from!.id, "generation_document", "pdf", { input_type: "pdf" });
    await notifyLastFreeRequest(ctx, db);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function generateImageForUser(
  ctx: BotContext,
  db: BotDatabase,
  ai: AiService,
  prompt: string,
  limits: { plus: number; pro: number; global: number; windowSeconds: number },
  track: TrackEvent,
): Promise<void> {
  const reservation = db.reserveImageGeneration(ctx.from!.id, limits);
  if (!("id" in reservation)) {
    track(ctx.from!.id, "image_limit_shown", reservation.reason);
    await ctx.reply(imageLimitMessage(reservation), {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть Plus", "menu:tariffs"),
    });
    return;
  }
  const aiReservations = reserveImageUnits(db, ctx.from!.id, reservation.allowance.tier, 2);
  if (!aiReservations) {
    db.releaseImageGeneration(reservation.id);
    await ctx.reply("Недостаточно AI-баллов для картинки. Нужно 2 балла.", {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть баланс", "menu:tariffs"),
    });
    return;
  }
  let stopProgress: (() => Promise<void>) | undefined;
  try {
    stopProgress = await startImageProgress(ctx, "Создаю изображение");
    const image = await ai.generateImage(prompt, ctx.from!.id);
    db.completeImageGeneration(reservation.id);
    commitReservations(db, aiReservations);
    const sent = await ctx.replyWithPhoto(new InputFile(image, "otvet-umno.png"), {
      caption: `Готово 🎨\n\n${prompt.slice(0, 700)}\n\n${imageAllowanceText(reservation.allowance)}`,
      reply_markup: imageResultMenu(),
    });
    track(ctx.from!.id, "image_created", reservation.allowance.tier, {
      tier: reservation.allowance.tier,
    });
    const photo = sent.photo.at(-1);
    if (photo) ctx.session.visualSources = [{ fileId: photo.file_id, mimeType: "image/jpeg" }];
  } catch (error) {
    db.releaseImageGeneration(reservation.id);
    releaseReservations(db, aiReservations);
    await handleError(ctx, error, "image_generation");
  } finally {
    await stopProgress?.();
  }
}

async function editImageForUser(
  ctx: BotContext,
  config: AppConfig,
  db: BotDatabase,
  ai: AiService,
  sources: Array<{ fileId: string; mimeType: string }>,
  prompt: string,
  limits: { plus: number; pro: number; global: number; windowSeconds: number },
  resourceLimiter: Semaphore,
  track: TrackEvent,
): Promise<void> {
  const reservation = db.reserveImageGeneration(ctx.from!.id, limits);
  if (!("id" in reservation)) {
    track(ctx.from!.id, "image_limit_shown", reservation.reason);
    await ctx.reply(imageLimitMessage(reservation), {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть Plus", "menu:tariffs"),
    });
    return;
  }
  const aiReservations = reserveImageUnits(db, ctx.from!.id, reservation.allowance.tier, 3);
  if (!aiReservations) {
    db.releaseImageGeneration(reservation.id);
    await ctx.reply("Недостаточно AI-баллов для изменения фото. Нужно 3 балла.", {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть баланс", "menu:tariffs"),
    });
    return;
  }
  let stopProgress: (() => Promise<void>) | undefined;
  try {
    stopProgress = await startImageProgress(ctx, "Изменяю исходное фото");
    const output = await resourceLimiter.run(async () => {
      const images = await Promise.all(sources.slice(0, 4).map(async (source) => ({
        data: await downloadTelegramFile(ctx, config.BOT_TOKEN, source.fileId, MAX_IMAGE_BYTES),
        mimeType: source.mimeType,
      })));
      return ai.editImage(images, prompt, ctx.from!.id);
    });
    db.completeImageGeneration(reservation.id);
    commitReservations(db, aiReservations);
    const sent = await ctx.replyWithPhoto(new InputFile(output, "otvet-umno-edit.png"), {
      caption: `Готово, изменил исходное фото 🎨\n\n${prompt.slice(0, 700)}\n\n${imageAllowanceText(reservation.allowance)}`,
      reply_markup: imageEditResultMenu(),
    });
    track(ctx.from!.id, "image_edited", reservation.allowance.tier, {
      tier: reservation.allowance.tier,
      source_count: sources.length,
    });
    const photo = sent.photo.at(-1);
    if (photo) ctx.session.visualSources = [{ fileId: photo.file_id, mimeType: "image/jpeg" }];
    delete ctx.session.visualResponseId;
  } catch (error) {
    db.releaseImageGeneration(reservation.id);
    releaseReservations(db, aiReservations);
    await handleError(ctx, error, "image_edit");
  } finally {
    await stopProgress?.();
  }
}

async function startImageProgress(
  ctx: BotContext,
  label: string,
): Promise<() => Promise<void>> {
  const chatId = ctx.chat!.id;
  await ctx.api.sendChatAction(chatId, "upload_photo");
  const status = await ctx.reply(
    `⏳ ${label}…\n\nОбычно это занимает 30–90 секунд. Запрос уже принят — повторно отправлять его не нужно.`,
  );
  let stopped = false;
  const activityTimer = setInterval(() => {
    if (stopped) return;
    void ctx.api.sendChatAction(chatId, "upload_photo").catch(() => undefined);
  }, 4_000);

  return async () => {
    stopped = true;
    clearInterval(activityTimer);
    await ctx.api.deleteMessage(chatId, status.message_id).catch(() => undefined);
  };
}

function finishGeneration(
  ctx: BotContext,
  db: BotDatabase,
  source: string,
  result: string,
  reservationId: string,
): void {
  db.saveGeneration(ctx.from!.id, ctx.session.flow!, ctx.session.category!, source, result);
  db.commitRequest(reservationId);
  ctx.session.lastSource = source;
  ctx.session.lastResult = result;
  ctx.session.awaitingInput = false;
  delete ctx.session.visualResponseId;
}

async function processVisualItems(
  ctx: BotContext,
  items: VisualMessageItem[],
  config: AppConfig,
  db: BotDatabase,
  ai: AiService,
  resourceLimiter: Semaphore,
  track: TrackEvent,
): Promise<void> {
  if (items.length > MAX_ALBUM_IMAGES) {
    await ctx.reply(`За один раз можно отправить не больше ${MAX_ALBUM_IMAGES} изображений.`);
    return;
  }
  if (items.some((item) => (item.fileSize ?? 0) > MAX_IMAGE_BYTES)) {
    await ctx.reply("Одно из изображений больше 8 МБ. Уменьши размер и попробуй снова.");
    return;
  }
  const caption = items.find((item) => item.caption?.trim())?.caption;
  const captionEditPrompt = caption ? extractImageEditPrompt(caption) : undefined;
  if (ctx.session.awaitingImageEditSource) {
    ctx.session.awaitingImageEditSource = false;
    const pendingEditPrompt = ctx.session.pendingImageEditPrompt?.trim();
    delete ctx.session.pendingImageEditPrompt;
    ctx.session.visualSources = items.map((item) => ({
      fileId: item.fileId,
      mimeType: item.mimeType,
    }));
    const editPrompt = caption?.trim() || pendingEditPrompt;
    if (editPrompt) {
      await editImageForUser(
        ctx,
        config,
        db,
        ai,
        ctx.session.visualSources,
        editPrompt,
        {
          plus: config.PLUS_IMAGE_LIMIT,
          pro: config.PRO_IMAGE_LIMIT,
          global: config.GLOBAL_IMAGE_LIMIT,
          windowSeconds: config.IMAGE_WINDOW_HOURS * 60 * 60,
        },
        resourceLimiter,
        track,
      );
      return;
    }
    ctx.session.awaitingImageEdit = true;
    await ctx.reply("Фото получил. Теперь напиши, что именно изменить.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
    return;
  }
  if (captionEditPrompt) {
    ctx.session.visualSources = items.map((item) => ({
      fileId: item.fileId,
      mimeType: item.mimeType,
    }));
    await editImageForUser(
      ctx,
      config,
      db,
      ai,
      ctx.session.visualSources,
      captionEditPrompt,
      {
        plus: config.PLUS_IMAGE_LIMIT,
        pro: config.PRO_IMAGE_LIMIT,
        global: config.GLOBAL_IMAGE_LIMIT,
        windowSeconds: config.IMAGE_WINDOW_HOURS * 60 * 60,
      },
      resourceLimiter,
      track,
    );
    return;
  }
  const reservation = await reserveForUser(ctx, db, track);
  if (!reservation) return;
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    const visual = await resourceLimiter.run(async () => {
      const images: Array<{ data: Uint8Array; mimeType: string }> = [];
      let totalBytes = 0;
      for (const item of items) {
        const data = await downloadTelegramFile(
          ctx, config.BOT_TOKEN, item.fileId, MAX_IMAGE_BYTES,
        );
        totalBytes += data.byteLength;
        if (totalBytes > MAX_ALBUM_BYTES) {
          throw new Error("Суммарный размер изображений превышает 16 МБ");
        }
        images.push({ data, mimeType: item.mimeType });
      }
      return ai.generateFromImages(images, caption);
    });
    const cleanResult = cleanTelegramText(visual.text);
    ctx.session.flow = "analyze";
    ctx.session.category = "auto";
    const source = caption || (items.length > 1
      ? `Альбом из ${items.length} изображений`
      : "Фотография или скриншот пользователя");
    finishGeneration(ctx, db, source, cleanResult, reservation);
    const inputType = items.length > 1 ? "album" : "photo";
    ctx.session.visualResponseId = visual.responseId;
    ctx.session.visualSources = items.map((item) => ({
      fileId: item.fileId,
      mimeType: item.mimeType,
    }));
    await replyVisualResult(ctx, cleanResult);
    track(ctx.from!.id, "generation_photo", inputType, {
      input_type: inputType,
      image_count: items.length,
    });
    await notifyLastFreeRequest(ctx, db);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function continueVisualConversation(
  ctx: BotContext,
  db: BotDatabase,
  ai: AiService,
  question: string,
  track: TrackEvent,
): Promise<void> {
  if (!ctx.session.visualResponseId) return;
  const reservation = await reserveForUser(ctx, db, track);
  if (!reservation) return;
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    const visual = await ai.continueVisual(ctx.session.visualResponseId, question);
    const cleanResult = cleanTelegramText(visual.text);
    db.saveGeneration(ctx.from!.id, "analyze", "auto", question, cleanResult);
    db.commitRequest(reservation);
    ctx.session.lastSource = question;
    ctx.session.lastResult = cleanResult;
    ctx.session.visualResponseId = visual.responseId;
    await replyVisualResult(ctx, cleanResult);
    track(ctx.from!.id, "generation_text", "visual_followup", {
      input_type: "visual_followup",
    });
    await notifyLastFreeRequest(ctx, db);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function replyResult(ctx: BotContext, result: string): Promise<void> {
  const chunks = splitLongMessage(cleanTelegramText(result));
  for (const chunk of chunks) await ctx.reply(chunk);
}

async function replyVisualResult(ctx: BotContext, result: string): Promise<void> {
  const chunks = splitLongMessage(result);
  for (let index = 0; index < chunks.length; index += 1) {
    await ctx.reply(
      chunks[index]!,
      index === chunks.length - 1 ? { reply_markup: visualResultMenu() } : {},
    );
  }
}

async function replyChunks(ctx: BotContext, text: string): Promise<void> {
  const chunks = splitLongMessage(text);
  for (const chunk of chunks) await ctx.reply(chunk);
  await ctx.reply("Что дальше?", { reply_markup: mainMenu() });
}

async function downloadTelegramFile(
  ctx: BotContext,
  token: string,
  fileId: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не вернул путь к файлу");
  if ((file.file_size ?? 0) > maxBytes) throw new Error("Файл превышает допустимый размер");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Не удалось скачать файл: ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new Error("Файл превышает допустимый размер");
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new Error("Файл превышает допустимый размер");
  return data;
}

async function handleError(
  ctx: BotContext,
  error: unknown,
  area: "general" | "image_generation" | "image_edit" = "general",
): Promise<void> {
  console.error("Generation error", error);
  const message = area === "image_edit"
    ? "Редактор фото сейчас не отвечает. Запрос не списан — попробуй ещё раз чуть позже или напиши в поддержку."
    : area === "image_generation"
      ? "Создание картинки сейчас временно недоступно. Запрос не списан — попробуй ещё раз чуть позже или напиши в поддержку."
      : "Сервис временно недоступен. Запрос не списан — попробуй ещё раз чуть позже или напиши в поддержку.";
  await ctx.reply(
    message,
    { reply_markup: new InlineKeyboard().url("Связаться с поддержкой", SUPPORT_TELEGRAM_URL) },
  );
}

function balanceText(
  freeUsed: number,
  freeLimit: number,
  credits: number,
  plan: string,
  subscription?: SubscriptionRequestAllowance,
): string {
  if (plan === "pro") return "Тариф: безлимит";
  if (subscription?.active) {
    return [
      `Plus AI-баллы: ${subscription.remaining} из ${subscription.limit}`,
      `Разовые запросы: ${credits}`,
    ].join("\n");
  }
  return `Бесплатно осталось: ${Math.max(0, freeLimit - freeUsed)}\nКупленных запросов: ${credits}`;
}

export function userTariffStatus(
  freeUsed: number,
  freeLimit: number,
  credits: number,
  plan: string,
  subscription?: SubscriptionRequestAllowance,
): string {
  if (plan === "pro") return "Ваш доступ: команда бота, без ограничений.";
  if (subscription?.active) {
    return [
      `Plus AI-баллы: ${subscription.remaining} из ${subscription.limit}`,
      `Разовые запросы: ${credits}`,
    ].join("\n");
  }
  return [
    `Бесплатных запросов: ${Math.max(0, freeLimit - freeUsed)}`,
    `Купленных запросов: ${credits}`,
  ].join("\n");
}

export function parseAdminTelegramId(value: string): number | undefined {
  const matches = value.match(/\d+/g);
  if (matches?.length !== 1) return undefined;
  const telegramId = Number(matches[0]);
  return Number.isSafeInteger(telegramId) && telegramId > 0 ? telegramId : undefined;
}

async function editOrReplyMenu(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
  parseMode?: "HTML",
): Promise<void> {
  if (ctx.callbackQuery?.message) {
    const message = ctx.callbackQuery.message;
    if (!("caption" in message)) {
      try {
        await ctx.editMessageText(text, {
          ...(parseMode ? { parse_mode: parseMode } : {}),
          reply_markup: keyboard,
        });
        return;
      } catch (error) {
        if (error instanceof Error && error.message.includes("message is not modified")) return;
      }
    }
    await dismissCallbackMessage(ctx);
  }
  await ctx.reply(text, {
    ...(parseMode ? { parse_mode: parseMode } : {}),
    reply_markup: keyboard,
  });
}

async function dismissCallbackMessage(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery?.message) return;
  try {
    await ctx.deleteMessage();
  } catch {
    await clearCallbackKeyboard(ctx);
  }
}

async function clearCallbackKeyboard(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery?.message) return;
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // The source message may already have no keyboard.
  }
}

async function replyPaywall(
  ctx: BotContext,
): Promise<void> {
  await ctx.reply(
    [
      "<b>Бесплатные запросы закончились</b>",
      "",
      "Выбери удобный способ продолжить:",
      "",
      `⭐ <b>Plus · ${PLUS_PLANS["1m"].stars} Stars</b> — ответы и картинки на 30 дней`,
      `📦 <b>${CREDIT_PACKAGES.start.credits} запросов · ${CREDIT_PACKAGES.start.stars} Stars</b> — без подписки, не сгорают`,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: paywallMenu() },
  );
}

async function notifyLastFreeRequest(ctx: BotContext, db: BotDatabase): Promise<void> {
  if (!ctx.from) return;
  const access = db.getAccess(ctx.from.id);
  if (
    access.plan !== "pro"
    && access.credits === 0
    && access.freeLimit - access.freeUsed === 1
    && !db.getSubscriptionAccess(ctx.from.id).active
  ) {
    await ctx.reply("Остался 1 бесплатный запрос.");
  }
}

function imageAllowanceText(allowance: ImageAllowance): string {
  if (allowance.tier === "free") {
    return `Картинки: ${allowance.remaining > 0 ? "1 пробная доступна" : "пробная использована"}`;
  }
  const tier = allowance.tier === "pro"
    ? "команда"
    : allowance.tier === "credits" ? "разовый пакет" : "Plus";
  return `Картинки (${tier}): осталось ${allowance.remaining} из ${allowance.limit}`;
}

function imageLimitMessage(allowance: ImageAllowance): string {
  if (allowance.reason === "trial_used") {
    return "Пробная картинка уже создана. Продолжить можно с Plus или разовым пакетом AI-баллов.";
  }
  const wait = allowance.resetAt ? formatWait(allowance.resetAt) : "чуть позже";
  if (allowance.reason === "global_limit") {
    return `Общий защитный лимит картинок временно исчерпан. Новый слот появится ${wait}. Твои личные попытки не списались.`;
  }
  return `Лимит картинок на текущие 30 дней закончился. Следующая попытка появится ${wait}. Подписка продолжает действовать.`;
}

function extractImagePrompt(text: string, awaiting: boolean | undefined): string | undefined {
  if (awaiting) return text.trim();
  const match = text.trim().match(/^(?:пожалуйста[, ]+)?(?:нарисуй|создай\s+(?:мне\s+)?(?:картин(?:у|ку)|изображение)|сгенерируй\s+(?:мне\s+)?(?:картин(?:у|ку)|изображение))\s*[:,-]?\s*(.*)$/iu);
  return match?.[1]?.trim();
}

export function extractImageEditPrompt(text: string): string | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const directEditIntent = /^(?:пожалуйста[, ]+)?(?:преврати|превратить|измени|изменить|обработай|обработать|отретушируй|отретушировать|стилизуй|стилизовать|перерисуй|перерисовать|улучши|улучшить|исправь|исправить|замени|заменить|убери|убрать|удали|удалить|добавь|добавить|дорисуй|дорисовать|поставь|поставить|размести|разместить|перемести|переместить|наложи|наложить|вставь|вставить)(?:\s|$)/iu;
  const styleIntent = /^(?:сделай\s+)?(?:меня|его|её|фото|фотографию|картинку|изображение|это)?\s*(?:в\s+стиле\s+)?(?:аниме|мультфильм|мультик|комикс|пиксар|киберпанк|акварель|масло)(?:\s|$)/iu;
  const carefulMakeIntent = /^(?:пожалуйста[, ]+)?сдела(?:й|ть)\s+(?:(?:это|эту|данное|мо[её]|исходн(?:ое|ую))\s+)?(?:фото|фотографи(?:ю|и)|картин(?:ку|ка)|изображение|фон|лицо|меня|его|её|ее|нас|предмет|товар|объект)(?:\s|$)/iu;
  const politeEditIntent = /^(?:а\s+)?(?:можно|можешь|можете|надо|нужно|хочу|сделай(?:те)?|попробуй|попробуйте)(?:\s|,|$).*?(?:убрать|удалить|заменить|изменить|добавить|дорисовать|поставить|разместить|переместить|наложить|вставить|поменять|исправить|улучшить|осветлить|затемнить|размыть|почистить|ретушировать)/iu;
  const objectChangeIntent = /(?:фон|рук[ауи]?|лицо|глаза|волос[ыа]?|человек|людей|предмет|объект|текст|надпись|логотип|стол|небо|одежд[ау]|цвет).*?(?:убрать|удалить|заменить|изменить|добавить|дорисовать|сделать|поменять|исправить|улучшить|белым|черным|прозрачным|ярче|темнее)/iu;
  const absenceIntent = /(?:чтобы|что\s*бы).*?(?:не\s+было|исчез(?:ла|ло|ли)?|без)/iu;
  return directEditIntent.test(value)
    || styleIntent.test(value)
    || carefulMakeIntent.test(value)
    || politeEditIntent.test(value)
    || objectChangeIntent.test(value)
    || absenceIntent.test(value)
    ? value
    : undefined;
}

function rememberGeneralTurn(ctx: BotContext, userText: string, assistantText: string): void {
  const next = [
    ...(ctx.session.generalHistory ?? []),
    { role: "user" as const, text: userText.trim() },
    { role: "assistant" as const, text: assistantText.trim() },
  ].filter((item) => item.text);
  ctx.session.generalHistory = next.slice(-8);
}

function formatWait(resetAt: number): string {
  const seconds = Math.max(0, resetAt - Math.floor(Date.now() / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(1, Math.ceil((seconds % 3600) / 60));
  if (hours === 0) return `примерно через ${minutes} мин.`;
  return `примерно через ${hours} ч ${minutes} мин.`;
}

function formatUnixDate(timestamp: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Irkutsk",
  }).format(new Date(timestamp * 1000));
}

function subscriptionMenu(autoRenew: boolean, recurring = true): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (recurring) {
    keyboard.text(
      autoRenew ? "Отключить автопродление" : "Включить автопродление",
      autoRenew ? "subscription:cancel" : "subscription:resume",
    ).row();
  }
  return keyboard
    .text("❓ Как купить Stars", "stars:help").row()
    .text("➕ Купить разовые запросы", "menu:credit-packs").row()
    .text("🧾 Мои покупки", "menu:payments").row()
    .text("← В кабинет", "menu:profile");
}

function formatPlusPlanLine(
  plan: (typeof PLUS_PLANS)[keyof typeof PLUS_PLANS],
  badge?: string,
): string {
  return [
    `<b>${plan.title} · ${plan.stars} Stars</b>${badge ? ` · ${badge}` : ""}`,
    `${plan.requestLimit} баллов · до ${plan.imageLimit} картинок`,
  ].join("\n");
}

function reserveImageUnits(
  db: BotDatabase,
  telegramId: number,
  tier: ImageAllowance["tier"],
  units: number,
): string[] | undefined {
  if (tier === "free" || tier === "pro") return [];
  if (tier === "plus") {
    const subscription = db.reserveSubscriptionUnits(telegramId, units);
    if (subscription) return [subscription.id];
  }
  const reservations: string[] = [];
  for (let index = 0; index < units; index += 1) {
    const reservation = db.reserveRequest(telegramId);
    if (!reservation) {
      releaseReservations(db, reservations);
      return undefined;
    }
    reservations.push(reservation.id);
  }
  return reservations;
}

function commitReservations(db: BotDatabase, reservationIds: string[]): void {
  for (const id of reservationIds) db.commitRequest(id);
}

function releaseReservations(db: BotDatabase, reservationIds: string[]): void {
  for (const id of reservationIds) db.releaseRequest(id);
}

function formatPaymentDate(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Irkutsk",
  }).format(date);
}

function adminKeyboard(activePeriod: AnalyticsPeriodDays): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const periods: Array<{ days: AnalyticsPeriodDays; label: string }> = [
    { days: 1, label: "Сегодня" },
    { days: 7, label: "7 дней" },
    { days: 30, label: "30 дней" },
    { days: 0, label: "Всё время" },
  ];
  for (const period of periods) {
    const marker = period.days === activePeriod ? "✓ " : "";
    keyboard.text(`${marker}${period.label}`, `admin:period:${period.days}`);
    if (period.days === 7) keyboard.row();
  }
  return keyboard
    .row().text("🔎 Пользователь", "admin:user-search")
    .text("🧾 Платежи", "admin:payments")
    .row().text("📣 Источники", "admin:sources");
}

function adminUserKeyboard(telegramId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎁 Выдать Plus", `admin:grant-plus:${telegramId}`).row()
    .text("➕ Начислить запросы", `admin:grant-credits:${telegramId}`).row()
    .text("🧾 Оплаты и выдачи", `admin:user-payments:${telegramId}`).row()
    .text("🔎 Другой пользователь", "admin:user-search")
    .text("← В админку", "admin:period:1");
}

function formatAdminUserCard(
  db: BotDatabase,
  telegramId: number,
  subscriptionLimit: number,
): string | undefined {
  const user = db.getAdminUser(telegramId);
  if (!user) return undefined;
  const access = db.getAccess(telegramId);
  const subscription = db.getSubscriptionAccess(telegramId);
  const allowance = db.getSubscriptionRequestAllowance(telegramId, subscriptionLimit);
  const actions = db.recentAdminActions(telegramId, 3);
  const identity = [
    user.firstName ? escapeTelegramHtml(user.firstName) : undefined,
    user.username ? `@${escapeTelegramHtml(user.username)}` : undefined,
  ].filter(Boolean).join(" · ") || "имя не сохранено";
  const actionLines = actions.map((action) => {
    const label = action.action === "grant_plus"
      ? `Plus на ${action.amount} мес.`
      : `${action.amount} запросов`;
    return `• ${label} · ${formatPaymentDate(action.createdAt)}`;
  });
  return [
    "<b>👤 Пользователь</b>",
    "",
    identity,
    `ID: <code>${user.telegramId}</code>`,
    `Первый вход: ${formatPaymentDate(user.createdAt)}`,
    "",
    `<b>Доступ</b>`,
    `План: ${access.plan === "pro" ? "команда · безлимит" : subscription.active ? "Plus" : "обычный"}`,
    `Бесплатных использовано: ${access.freeUsed} из ${access.freeLimit}`,
    `Купленных запросов: ${access.credits}`,
    ...(subscription.active ? [
      `Plus до: <b>${formatUnixDate(subscription.periodEnd!)}</b>`,
      `AI-баллы: ${allowance.remaining} из ${allowance.limit}`,
      `Картинки: до ${subscription.imageLimit ?? 0}`,
      `Автопродление: ${subscription.recurring && subscription.autoRenew ? "включено" : "нет"}`,
    ] : ["Plus: не активен"]),
    ...(actionLines.length ? ["", "<b>Последние ручные выдачи</b>", ...actionLines] : []),
  ].join("\n");
}

function formatAdminPaymentFeed(db: BotDatabase): string {
  const payments = db.recentAdminPayments(10);
  if (!payments.length) return "<b>🧾 Последние платежи</b>\n\nПлатежей пока нет.";
  return [
    "<b>🧾 Последние платежи</b>",
    "",
    ...payments.flatMap((payment, index) => [
      `<b>${index + 1}. ${escapeTelegramHtml(payment.product)}</b> · ${payment.amount} ${payment.currency}`,
      `ID пользователя: <code>${payment.telegramId}</code>`,
      `Статус: ${escapeTelegramHtml(payment.status)} · ${formatPaymentDate(payment.createdAt)}`,
      `ID платежа: <code>${escapeTelegramHtml(payment.referenceId)}</code>`,
      "",
    ]),
  ].join("\n");
}

function formatAdminUserPayments(db: BotDatabase, telegramId: number): string {
  const stars = [
    ...db.recentSubscriptionPayments(telegramId, 10).map((payment) => ({
      label: "Plus",
      amount: `${payment.stars} Stars`,
      status: payment.status,
      referenceId: payment.chargeId,
      createdAt: payment.createdAt,
    })),
    ...db.recentPayments(telegramId, 10).map((payment) => ({
      label: payment.packageId,
      amount: `${payment.stars} Stars`,
      status: payment.status,
      referenceId: payment.chargeId,
      createdAt: payment.createdAt,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  const external = db.recentExternalPayments(telegramId, 10).map((payment) => ({
    label: payment.packageId,
    amount: `${payment.amountRub} RUB`,
    status: payment.status,
    referenceId: payment.transactionId,
    createdAt: payment.createdAt,
  }));
  const actions = db.recentAdminActions(telegramId, 6);
  if (!stars.length && !external.length && !actions.length) {
    return `<b>🧾 Оплаты пользователя</b>\n\nID: <code>${telegramId}</code>\nПлатежей и ручных выдач пока нет.`;
  }
  const paymentLines = [...stars, ...external]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .flatMap((payment) => [
      `<b>${escapeTelegramHtml(payment.label)}</b> · ${payment.amount}`,
      `${escapeTelegramHtml(payment.status)} · ${formatPaymentDate(payment.createdAt)}`,
      `<code>${escapeTelegramHtml(payment.referenceId)}</code>`,
      "",
    ]);
  const actionLines = actions.map((action) => [
    action.action === "grant_plus"
      ? `Plus на ${action.amount} мес.`
      : `${action.amount} запросов`,
    `Администратор: <code>${action.adminTelegramId}</code> · ${formatPaymentDate(action.createdAt)}`,
  ].join("\n"));
  return [
    "<b>🧾 Оплаты и ручные выдачи</b>",
    `Пользователь: <code>${telegramId}</code>`,
    "",
    ...(paymentLines.length ? ["<b>Платежи</b>", ...paymentLines] : []),
    ...(actionLines.length ? ["<b>Ручные выдачи</b>", ...actionLines] : []),
  ].join("\n");
}

function sanitizeStartSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "direct";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
  return normalized || "direct";
}
