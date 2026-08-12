import { Bot, Context, InlineKeyboard, InputFile, session, type SessionFlavor } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { AppConfig } from "./config.js";
import { AiService } from "./ai.js";
import { BotDatabase } from "./database.js";
import {
  capabilitiesMenu,
  categoryMenu,
  mainMenu,
  imageResultMenu,
  imageEditResultMenu,
  profileMenu,
  quickCategory,
  refinementsMenu,
  resultMenu,
  visualResultMenu,
  tariffsMenu,
} from "./keyboards.js";
import {
  CREDIT_PACKAGES,
  PLUS_SUBSCRIPTION_PERIOD_SECONDS,
  createPaymentPayload,
  createSubscriptionPayload,
  isCreditPackageId,
  parsePaymentPayload,
  parseSubscriptionPayload,
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
} from "./types.js";
import { cleanTelegramText, displayName, splitLongMessage } from "./utils.js";
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
      const validCredits = Boolean(
        parsed
        && selected
        && parsed.telegramId === query.from.id
        && query.currency === "XTR"
        && query.total_amount === selected.stars,
      );
      const validSubscription = Boolean(
        subscription
        && subscription.telegramId === query.from.id
        && query.currency === "XTR"
        && query.total_amount === config.PLUS_SUBSCRIPTION_STARS,
      );
      const valid = validCredits || validSubscription;
      if (valid) {
        db.ensureUser(query.from.id, query.from.username, query.from.first_name);
        track(query.from.id, "checkout_confirmed", subscription ? "plus_subscription" : selected?.id, {
          package_id: subscription ? "plus_subscription" : selected?.id,
          stars: subscription ? config.PLUS_SUBSCRIPTION_STARS : selected?.stars,
        });
      }
      await ctx.answerPreCheckoutQuery(
        valid,
        valid ? undefined : {
          error_message: "Счёт устарел или повреждён. Вернись в тарифы и создай новый.",
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
    if (
      subscription
      && subscription.telegramId === ctx.from.id
      && payment.currency === "XTR"
      && payment.total_amount === config.PLUS_SUBSCRIPTION_STARS
    ) {
      const periodEnd = payment.subscription_expiration_date
        ?? Math.floor(Date.now() / 1000) + PLUS_SUBSCRIPTION_PERIOD_SECONDS;
      const activated = db.recordSubscriptionPayment(
        ctx.from.id,
        config.PLUS_SUBSCRIPTION_STARS,
        payment.invoice_payload,
        payment.telegram_payment_charge_id,
        periodEnd,
        payment.is_first_recurring === true,
      );
      if (!activated) {
        await ctx.reply("Этот платёж уже обработан. Подписка Plus остаётся активной.");
        return;
      }
      track(ctx.from.id, "subscription_started", "plus", {
        stars: config.PLUS_SUBSCRIPTION_STARS,
        period_end: periodEnd,
      });
      await ctx.reply(
        [
          "Plus активирован ✅",
          "",
          `Доступно ${config.PLUS_REQUEST_LIMIT} AI-баллов и до ${config.PLUS_IMAGE_LIMIT} картинок на 30 дней.`,
          `Подписка действует до ${formatUnixDate(periodEnd)} и продлевается автоматически.`,
          "",
          "Теперь можно:",
          "• задавать любые вопросы текстом или голосом;",
          "• отправлять фото, скриншоты и документы на разбор;",
          "• решать учебные задачи и разбираться в сложных темах;",
          "• писать, проверять и переводить тексты;",
          "• создавать картинки и изменять свои фотографии.",
          "",
          "Просто отправь сообщение, голосовое или файл — бот сам поймёт задачу.",
        ].join("\n"),
        { reply_markup: mainMenu() },
      );
      if (config.ADMIN_TELEGRAM_ID) {
        void ctx.api.sendMessage(
          config.ADMIN_TELEGRAM_ID,
          `💰 Новая подписка Plus\nПолучено: ${config.PLUS_SUBSCRIPTION_STARS} Stars\nПользователь: ${ctx.from.id}`,
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
        "Оплата прошла ✅",
        "",
        `Начислено: ${selected.credits} запросов`,
        `Доступно: ${access.credits} купленных запросов`,
        "",
        "Что можно сделать:",
        "• написать вопрос на любую тему;",
        "• отправить фото, скриншот или документ;",
        "• записать голосовой вопрос;",
        "• решить задачу по математике или другому предмету;",
        "• попросить написать, проверить или перевести текст;",
        "• получить понятное объяснение сложной темы.",
        "",
        "Просто отправь сообщение — бот сам выберет подходящий режим.",
        "Для создания и изменения картинок действует отдельный лимит: одна пробная картинка, затем Plus.",
      ].join("\n"),
      { reply_markup: mainMenu() },
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
    await ctx.replyWithPhoto(new InputFile("./assets/welcome-cover.png"), {
      caption: [
        `Привет, ${displayName(ctx.from?.first_name)}!`,
        "",
        "Я универсальный AI-помощник. Просто напиши или отправь файл — я сам пойму задачу.",
        "",
        "Могу объяснить тему, ответить на вопрос, решить задачу, помочь с текстом или переводом.",
        "Понимаю фотографии, скриншоты, документы и голосовые сообщения.",
        "Создаю картинки и могу изменить присланную фотографию.",
        "",
        "Напиши вопрос или нажми значок камеры, микрофона или скрепки.",
        `На старте доступно ${config.FREE_REQUEST_LIMIT} бесплатных запросов.`,
      ].join("\n"),
      reply_markup: mainMenu(),
    });
  });

  bot.command("menu", async (ctx) => {
    ctx.session.awaitingInput = false;
    await ctx.reply(
      "Напиши вопрос, отправь фото, документ или голосовое. Чтобы создать картинку, нажми кнопку ниже.",
      { reply_markup: mainMenu() },
    );
  });

  bot.callbackQuery("menu:capabilities", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      [
        "✨ Что умеет Пойми AI",
        "",
        "📸 Фото и скриншоты",
        "Распознаю товары, этикетки, документы, ошибки и учебные задания.",
        "",
        "💬 Текст и голос",
        "Отвечаю на вопросы, объясняю сложное, пишу и перевожу тексты.",
        "",
        "🎓 Учёба",
        "Решаю математику и другие задачи по шагам.",
        "",
        "🎨 Картинки",
        "Создаю изображения по описанию и изменяю присланные фотографии.",
        "",
        "Просто отправь сообщение или файл — режим выбирать не нужно.",
      ].join("\n"),
      capabilitiesMenu(),
    );
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
        "Как пользоваться Пойми AI",
        "",
        "Можно просто написать вопрос или отправить голосовое.",
        "Фото и скриншоты бот распознает и объяснит.",
        "Документы, инструкции и учебные задачи разберёт простыми словами.",
        "С текстами поможет написать, проверить, сократить или перевести.",
        "Для картинки напиши, например: «Нарисуй уютное кафе у озера».",
        "Для изменения фото сначала отправь его, затем напиши, что изменить.",
      ].join("\n"),
      { reply_markup: mainMenu() },
    );
  });

  bot.command("balance", async (ctx) => {
    if (!ctx.from) return;
    const access = db.getAccess(ctx.from.id);
    await ctx.reply(balanceText(access.freeUsed, access.freeLimit, access.credits, access.plan));
  });

  bot.command("paysupport", async (ctx) => {
    await ctx.reply(
      "Поддержка по оплате\n\nЕсли пакет не начислился или нужен возврат, отправь сюда ID платежа и опиши проблему. ID находится в разделе «Мои покупки». Владелец бота проверит операцию.",
      { reply_markup: new InlineKeyboard().text("🧾 Мои покупки", "menu:payments") },
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
    db.ensureUser(targetId);
    db.addCredits(targetId, amount);
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

  bot.callbackQuery("menu:main", async (ctx) => {
    ctx.session.awaitingInput = false;
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    await ctx.answerCallbackQuery();
    await editOrReplyMenu(
      ctx,
      "Напиши вопрос, отправь фото, документ или голосовое. Чтобы создать картинку, нажми кнопку ниже.",
      mainMenu(),
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
        "⭐ Тариф Plus",
        "",
        subscription.active
          ? `Активен до ${formatUnixDate(subscription.periodEnd!)}`
          : `${config.PLUS_SUBSCRIPTION_STARS} ⭐ на 30 дней`,
        `Включено: ${config.PLUS_REQUEST_LIMIT} AI-баллов и до ${config.PLUS_IMAGE_LIMIT} картинок.`,
        ...(subscriptionRequests.active
          ? [`Осталось: ${subscriptionRequests.remaining} из ${subscriptionRequests.limit} AI-баллов.`]
          : []),
        "",
        "Как списываются баллы:",
        "Вопрос, разбор фото или голос — 1",
        "Создание картинки — 2",
        "Изменение фотографии — 3",
        "",
        "Дополнительные запросы без срока действия:",
        `${CREDIT_PACKAGES.start.credits} запросов — ${CREDIT_PACKAGES.start.stars} ⭐`,
        `${CREDIT_PACKAGES.plus.credits} запросов — ${CREDIT_PACKAGES.plus.stars} ⭐`,
        `${CREDIT_PACKAGES.pro.credits} запросов — ${CREDIT_PACKAGES.pro.stars} ⭐`,
        "",
        userTariffStatus(access.freeUsed, access.freeLimit, access.credits, access.plan),
        ...(subscription.active
          ? [`Автопродление: ${subscription.autoRenew ? "включено" : "выключено"}.`]
          : ["Подписка продлевается автоматически. Её можно отключить здесь."]),
      ].join("\n"),
      subscription.active
        ? subscriptionMenu(subscription.autoRenew)
        : tariffsMenu(),
    );
  });

  bot.callbackQuery("subscribe:plus", async (ctx) => {
    await ctx.answerCallbackQuery();
    track(ctx.from.id, "subscription_invoice_created", "plus", {
      stars: config.PLUS_SUBSCRIPTION_STARS,
    });
    const invoiceUrl = await ctx.api.raw.createInvoiceLink({
      title: "Пойми AI Plus",
      description: `${config.PLUS_REQUEST_LIMIT} AI-единиц, включая до ${config.PLUS_IMAGE_LIMIT} AI-картинок на 30 дней.`,
      payload: createSubscriptionPayload(ctx.from.id),
      currency: "XTR",
      prices: [{ label: "Plus на 30 дней", amount: config.PLUS_SUBSCRIPTION_STARS }],
      subscription_period: PLUS_SUBSCRIPTION_PERIOD_SECONDS,
    });
    await ctx.reply(
      `Plus на 30 дней · ${config.PLUS_SUBSCRIPTION_STARS} Stars\n${config.PLUS_REQUEST_LIMIT} AI-единиц, включая до ${config.PLUS_IMAGE_LIMIT} картинок. Автопродление можно отключить в любой момент.`,
      { reply_markup: new InlineKeyboard().url("Открыть оплату", invoiceUrl) },
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
        "5. Открой «Plus и запросы» и нажми «Оформить Plus».",
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
    if (!subscription.active || !subscription.latestChargeId) {
      await ctx.answerCallbackQuery("Активная подписка не найдена");
      return;
    }
    const cancel = ctx.match[1] === "cancel";
    await ctx.api.editUserStarSubscription(ctx.from.id, subscription.latestChargeId, cancel);
    db.setSubscriptionAutoRenew(ctx.from.id, !cancel);
    await ctx.answerCallbackQuery(cancel ? "Автопродление выключено" : "Автопродление включено");
    await ctx.editMessageReplyMarkup({ reply_markup: subscriptionMenu(!cancel) });
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
    await ctx.replyWithInvoice(
      `Пакет «${selected.title}»`,
      `${selected.credits} запросов к Пойми AI. Запросы не сгорают.`,
      createPaymentPayload(packageId, ctx.from.id),
      "XTR",
      [{ label: `${selected.credits} запросов`, amount: selected.stars }],
      { reply_markup: new InlineKeyboard().pay(`Оплатить ${selected.stars} ⭐`) },
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
    await editOrReplyMenu(
      ctx,
      [
        "👤 Мой кабинет",
        "",
        userTariffStatus(access.freeUsed, access.freeLimit, access.credits, access.plan),
        ...(subscription.active ? [`Plus активен до ${formatUnixDate(subscription.periodEnd!)}`] : []),
        "",
        "Здесь находятся лимиты, подписка, история и покупки.",
      ].join("\n"),
      profileMenu(),
    );
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    const images = db.getImageAllowance(ctx.from.id, imageLimits);
    const subscription = db.getSubscriptionAccess(ctx.from.id);
    await editOrReplyMenu(
      ctx,
      [
        balanceText(access.freeUsed, access.freeLimit, access.credits, access.plan),
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
      await ctx.reply(
        "Бесплатные запросы закончились. В тарифах можно подключить Plus или купить дополнительные запросы.",
        { reply_markup: mainMenu() },
      );
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
    ctx.session.awaitingInput = false;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await ctx.reply("Отправь новую фотографию через камеру или скрепку возле поля сообщения.");
  });

  bot.callbackQuery(["image:create", "image:again"], async (ctx) => {
    ctx.session.awaitingImagePrompt = true;
    ctx.session.awaitingImageEdit = false;
    delete ctx.session.visualResponseId;
    await ctx.answerCallbackQuery();
    await ctx.reply("Что нарисовать? Опиши сюжет, стиль и важные детали одним сообщением.", {
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
    await ctx.answerCallbackQuery();
    await ctx.reply("Что ещё изменить на этой картинке? Напиши одним сообщением.", {
      reply_markup: new InlineKeyboard().text("Отмена", "image:cancel"),
    });
  });

  bot.callbackQuery("image:cancel", async (ctx) => {
    ctx.session.awaitingImagePrompt = false;
    ctx.session.awaitingImageEdit = false;
    await ctx.answerCallbackQuery("Отменено");
    await ctx.editMessageText("Напиши вопрос, отправь фото, документ или голосовое.", {
      reply_markup: mainMenu(),
    });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const editPrompt = ctx.session.awaitingImageEdit
      ? ctx.message.text.trim()
      : extractImageEditPrompt(ctx.message.text);
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

  bot.on("message:document", async (ctx, next) => {
    const mimeType = ctx.message.document.mime_type;
    if (!mimeType?.startsWith("image/")) {
      await next();
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
      const editPrompt = extractImageEditPrompt(transcript);
      if (editPrompt && ctx.session.visualSources?.length) {
        db.commitRequest(reservation);
        await ctx.reply(`🎙 Распознано: ${transcript.slice(0, 800)}`);
        await editImageForUser(
          ctx, config, db, ai, ctx.session.visualSources, editPrompt,
          imageLimits, resourceLimiter, track,
        );
        return;
      }
      let result: string;
      try {
        result = await ai.answerGeneral(transcript);
      } catch (error) {
        db.releaseRequest(reservation);
        throw error;
      }
      ctx.session.flow = "analyze";
      ctx.session.category = "auto";
      finishGeneration(ctx, db, transcript, result, reservation);
      track(ctx.from.id, "generation_voice", "voice", { input_type: "voice" });
      await ctx.reply(`🎙 Распознано: ${transcript.slice(0, 800)}`);
      await replyResult(ctx, result);
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
  await ctx.reply("Бесплатные запросы закончились. Подключи Plus или купи дополнительные запросы.", {
    reply_markup: mainMenu(),
  });
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
    track(ctx.from!.id, "generation_text", ctx.session.flow, {
      input_type: "text",
      flow: ctx.session.flow,
      category: ctx.session.category,
    });
    await replyResult(ctx, result);
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
    const result = cleanTelegramText(await ai.answerGeneral(source));
    ctx.session.flow = "analyze";
    ctx.session.category = "auto";
    finishGeneration(ctx, db, source, result, reservation);
    track(ctx.from!.id, `generation_${inputType}`, "general", { input_type: inputType });
    await replyResult(ctx, result);
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
  const allowance = db.getImageAllowance(ctx.from!.id, limits);
  const aiReservation = allowance.tier === "plus"
    ? db.reserveSubscriptionUnits(ctx.from!.id, 2)
    : undefined;
  if (allowance.tier === "plus" && !aiReservation) {
    await ctx.reply("Месячный AI-баланс Plus закончился. Новые единицы появятся после обновления периода подписки.", {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть баланс", "menu:tariffs"),
    });
    return;
  }
  const reservation = db.reserveImageGeneration(ctx.from!.id, limits);
  if (!("id" in reservation)) {
    if (aiReservation) db.releaseRequest(aiReservation.id);
    track(ctx.from!.id, "image_limit_shown", reservation.reason);
    await ctx.reply(imageLimitMessage(reservation), {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть Plus", "menu:tariffs"),
    });
    return;
  }
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
    const image = await ai.generateImage(prompt, ctx.from!.id);
    db.completeImageGeneration(reservation.id);
    if (aiReservation) db.commitRequest(aiReservation.id);
    track(ctx.from!.id, "image_created", reservation.allowance.tier, {
      tier: reservation.allowance.tier,
    });
    const sent = await ctx.replyWithPhoto(new InputFile(image, "otvet-umno.png"), {
      caption: `Готово 🎨\n\n${prompt.slice(0, 700)}\n\n${imageAllowanceText(reservation.allowance)}`,
      reply_markup: imageResultMenu(),
    });
    const photo = sent.photo.at(-1);
    if (photo) ctx.session.visualSources = [{ fileId: photo.file_id, mimeType: "image/jpeg" }];
  } catch (error) {
    db.releaseImageGeneration(reservation.id);
    if (aiReservation) db.releaseRequest(aiReservation.id);
    await handleError(ctx, error);
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
  const allowance = db.getImageAllowance(ctx.from!.id, limits);
  const aiReservation = allowance.tier === "plus"
    ? db.reserveSubscriptionUnits(ctx.from!.id, 3)
    : undefined;
  if (allowance.tier === "plus" && !aiReservation) {
    await ctx.reply("Месячный AI-баланс Plus закончился. Новые единицы появятся после обновления периода подписки.", {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть баланс", "menu:tariffs"),
    });
    return;
  }
  const reservation = db.reserveImageGeneration(ctx.from!.id, limits);
  if (!("id" in reservation)) {
    if (aiReservation) db.releaseRequest(aiReservation.id);
    track(ctx.from!.id, "image_limit_shown", reservation.reason);
    await ctx.reply(imageLimitMessage(reservation), {
      reply_markup: new InlineKeyboard().text("⭐ Посмотреть Plus", "menu:tariffs"),
    });
    return;
  }
  try {
    await ctx.api.sendChatAction(ctx.chat!.id, "upload_photo");
    const output = await resourceLimiter.run(async () => {
      const images = await Promise.all(sources.slice(0, 4).map(async (source) => ({
        data: await downloadTelegramFile(ctx, config.BOT_TOKEN, source.fileId, MAX_IMAGE_BYTES),
        mimeType: source.mimeType,
      })));
      return ai.editImage(images, prompt, ctx.from!.id);
    });
    db.completeImageGeneration(reservation.id);
    if (aiReservation) db.commitRequest(aiReservation.id);
    track(ctx.from!.id, "image_edited", reservation.allowance.tier, {
      tier: reservation.allowance.tier,
      source_count: sources.length,
    });
    const sent = await ctx.replyWithPhoto(new InputFile(output, "otvet-umno-edit.png"), {
      caption: `Готово, изменил исходное фото 🎨\n\n${prompt.slice(0, 700)}\n\n${imageAllowanceText(reservation.allowance)}`,
      reply_markup: imageEditResultMenu(),
    });
    const photo = sent.photo.at(-1);
    if (photo) ctx.session.visualSources = [{ fileId: photo.file_id, mimeType: "image/jpeg" }];
    delete ctx.session.visualResponseId;
  } catch (error) {
    db.releaseImageGeneration(reservation.id);
    if (aiReservation) db.releaseRequest(aiReservation.id);
    await handleError(ctx, error);
  }
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
  const editPrompt = caption ? extractImageEditPrompt(caption) : undefined;
  if (editPrompt) {
    await editImageForUser(
      ctx, config, db, ai,
      items.map((item) => ({ fileId: item.fileId, mimeType: item.mimeType })),
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
    track(ctx.from!.id, "generation_photo", inputType, {
      input_type: inputType,
      image_count: items.length,
    });
    ctx.session.visualResponseId = visual.responseId;
    ctx.session.visualSources = items.map((item) => ({
      fileId: item.fileId,
      mimeType: item.mimeType,
    }));
    await replyVisualResult(ctx, cleanResult);
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
    track(ctx.from!.id, "generation_text", "visual_followup", {
      input_type: "visual_followup",
    });
    await replyVisualResult(ctx, cleanResult);
  } catch (error) {
    db.releaseRequest(reservation);
    await handleError(ctx, error);
  }
}

async function replyResult(ctx: BotContext, result: string): Promise<void> {
  const chunks = splitLongMessage(result);
  for (let index = 0; index < chunks.length; index += 1) {
    await ctx.reply(chunks[index]!, index === chunks.length - 1 ? { reply_markup: resultMenu() } : {});
  }
}

async function replyVisualResult(ctx: BotContext, result: string): Promise<void> {
  const text = `${result}\n\nМожешь задать вопрос по этой фотографии или отправить новую.`;
  const chunks = splitLongMessage(text);
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

async function handleError(ctx: BotContext, error: unknown): Promise<void> {
  console.error("Generation error", error);
  const message = error instanceof Error && error.message.includes("429")
    ? "AI временно перегружен или закончился баланс API. Попробуй чуть позже."
    : "Не получилось обработать запрос. Проверь ключ API и попробуй ещё раз.";
  await ctx.reply(message, { reply_markup: mainMenu() });
}

function balanceText(freeUsed: number, freeLimit: number, credits: number, plan: string): string {
  if (plan === "pro") return "Тариф: безлимит";
  return `Бесплатно осталось: ${Math.max(0, freeLimit - freeUsed)}\nКупленных запросов: ${credits}`;
}

function userTariffStatus(freeUsed: number, freeLimit: number, credits: number, plan: string): string {
  if (plan === "pro") return "Ваш доступ: команда бота, без ограничений.";
  return [
    `Бесплатных запросов: ${Math.max(0, freeLimit - freeUsed)}`,
    `Купленных запросов: ${credits}`,
  ].join("\n");
}

async function editOrReplyMenu(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  const message = ctx.callbackQuery?.message;
  if (message && "text" in message) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

function imageAllowanceText(allowance: ImageAllowance): string {
  if (allowance.tier === "free") {
    return `Картинки: ${allowance.remaining > 0 ? "1 пробная доступна" : "пробная использована"}`;
  }
  const tier = allowance.tier === "pro" ? "команда" : "Plus";
  return `Картинки (${tier}): осталось ${allowance.remaining} из ${allowance.limit}`;
}

function imageLimitMessage(allowance: ImageAllowance): string {
  if (allowance.reason === "trial_used") {
    return "Пробная картинка уже создана. С Plus доступно 20 генераций на 30 дней.";
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
  const editIntent = /^(?:пожалуйста[, ]+)?(?:сделай|преврати|измени|обработай|стилизуй|перерисуй|замени|убери|удали|добавь)(?:\s|$)/iu;
  const styleIntent = /^(?:сделай\s+)?(?:меня|его|её|фото|фотографию|картинку|изображение|это)?\s*(?:в\s+стиле\s+)?(?:аниме|мультфильм|мультик|комикс|пиксар|киберпанк|акварель|масло)(?:\s|$)/iu;
  return editIntent.test(value) || styleIntent.test(value) ? value : undefined;
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

function subscriptionMenu(autoRenew: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      autoRenew ? "Отключить автопродление" : "Включить автопродление",
      autoRenew ? "subscription:cancel" : "subscription:resume",
    ).row()
    .text("❓ Как купить Stars", "stars:help").row()
    .text("➕ Купить разовые запросы", "buy:start").row()
    .text("🧾 Мои покупки", "menu:payments").row()
    .text("← В кабинет", "menu:profile");
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
  return keyboard.row().text("📣 Источники", "admin:sources");
}

function sanitizeStartSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "direct";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
  return normalized || "direct";
}
