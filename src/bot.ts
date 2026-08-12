import { Bot, Context, InlineKeyboard, InputFile, session, type SessionFlavor } from "grammy";
import type { AppConfig } from "./config.js";
import { AiService } from "./ai.js";
import { BotDatabase } from "./database.js";
import {
  categoryMenu,
  mainMenu,
  profileMenu,
  quickCategory,
  refinementsMenu,
  resultMenu,
  visualResultMenu,
  tariffsMenu,
} from "./keyboards.js";
import {
  CREDIT_PACKAGES,
  createPaymentPayload,
  isCreditPackageId,
  parsePaymentPayload,
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
  type RefinementId,
} from "./types.js";
import { cleanTelegramText, displayName, splitLongMessage } from "./utils.js";

type BotContext = Context & SessionFlavor<BotSession>;

interface VisualMessageItem {
  fileId: string;
  mimeType: string;
  caption: string | undefined;
}

interface PendingAlbum {
  ctx: BotContext;
  items: VisualMessageItem[];
  timer: ReturnType<typeof setTimeout> | undefined;
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

export function createBot(config: AppConfig, db: BotDatabase, ai: AiService): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);
  const pendingAlbums = new Map<string, PendingAlbum>();

  bot.use(session({ initial: (): BotSession => ({ awaitingInput: false }) }));

  bot.use(async (ctx, next) => {
    if (!db.claimUpdate(ctx.update.update_id)) return;
    await next();
  });

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      db.ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
      if (ctx.from.id === config.ADMIN_TELEGRAM_ID) db.setPlan(ctx.from.id, "pro");
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from || !db.claimAction(ctx.from.id, "start", 8)) return;
    ctx.session = { awaitingInput: false };
    await ctx.replyWithPhoto(new InputFile("./assets/welcome-cover.png"), {
      caption: [
        `Привет, ${displayName(ctx.from?.first_name)}!`,
        "",
        "📷 Отправь фотографию или скриншот — я сам определю, что на нём, и всё объясню.",
        "",
        "Товар • этикетка • инструкция",
        "Скриншот • документ • учебная задача",
        "",
        "Нажми значок камеры или скрепки возле поля сообщения.",
        `На старте доступно ${config.FREE_REQUEST_LIMIT} бесплатных запросов.`,
      ].join("\n"),
    });
  });

  bot.command("menu", async (ctx) => {
    ctx.session.awaitingInput = false;
    await ctx.reply(
      "Отправь фото или скриншот прямо в чат. Здесь можно открыть историю и проверить лимит:",
      { reply_markup: mainMenu() },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Просто отправь фотографию или скриншот — бот сам определит содержимое и объяснит его. Для работы с перепиской и текстом используй /menu.",
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
    const role = ctx.from.id === config.ADMIN_TELEGRAM_ID ? "владелец · безлимит" : "пользователь";
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
    if (!payment) {
      await ctx.reply("Платёж с таким ID не найден.");
      return;
    }
    if (payment.status === "refunded") {
      await ctx.reply("Этот платёж уже возвращён.");
      return;
    }
    try {
      await ctx.api.refundStarPayment(payment.telegramId, chargeId);
      db.markPaymentRefunded(chargeId);
      await ctx.reply(`Возврат ${payment.stars} Stars выполнен пользователю ${payment.telegramId}.`);
    } catch (error) {
      console.error("Refund error", error);
      await ctx.reply("Telegram не выполнил возврат. Проверь ID платежа и баланс бота.");
    }
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || ctx.from.id !== config.ADMIN_TELEGRAM_ID) return;
    const stats = db.stats();
    await ctx.reply(
      `Пользователей: ${stats.users}\nГенераций: ${stats.generations}\nШаблонов: ${stats.favorites}\nПокупок: ${stats.payments}\nStars получено: ${stats.stars}`,
    );
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    ctx.session.awaitingInput = false;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Отправь фото или скриншот прямо в чат.", { reply_markup: mainMenu() });
  });

  bot.callbackQuery("menu:tariffs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    await ctx.editMessageText(
      [
        "⭐ Пакеты запросов",
        "",
        `Старт — ${CREDIT_PACKAGES.start.credits} запросов за ${CREDIT_PACKAGES.start.stars} Stars`,
        `Плюс — ${CREDIT_PACKAGES.plus.credits} запросов за ${CREDIT_PACKAGES.plus.stars} Stars`,
        `Про — ${CREDIT_PACKAGES.pro.credits} запросов за ${CREDIT_PACKAGES.pro.stars} Stars`,
        "",
        balanceText(access.freeUsed, access.freeLimit, access.credits, access.plan),
        "",
        "Запросы не сгорают. Оплата проходит внутри Telegram.",
      ].join("\n"),
      { reply_markup: tariffsMenu() },
    );
  });

  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    const packageId = ctx.match[1];
    if (!packageId || !isCreditPackageId(packageId)) {
      await ctx.answerCallbackQuery("Неизвестный пакет");
      return;
    }
    const selected = CREDIT_PACKAGES[packageId];
    await ctx.answerCallbackQuery();
    await ctx.replyWithInvoice(
      `Пакет «${selected.title}»`,
      `${selected.credits} запросов к ОтветьУмно AI. Запросы не сгорают.`,
      createPaymentPayload(packageId, ctx.from.id),
      "XTR",
      [{ label: `${selected.credits} запросов`, amount: selected.stars }],
      { reply_markup: new InlineKeyboard().pay(`Оплатить ${selected.stars} ⭐`) },
    );
  });

  bot.callbackQuery("menu:payments", async (ctx) => {
    await ctx.answerCallbackQuery();
    const payments = db.recentPayments(ctx.from.id, 10);
    const text = payments.length
      ? `🧾 Мои покупки\n\n${payments.map((payment, index) => [
        `${index + 1}. ${payment.credits} запросов · ${payment.stars} ⭐`,
        payment.status === "paid" ? "Статус: оплачено" : "Статус: возврат выполнен",
        `ID: ${payment.chargeId}`,
        `Дата: ${formatPaymentDate(payment.createdAt)}`,
      ].join("\n")).join("\n\n")}`
      : "Покупок пока нет.";
    await ctx.editMessageText(text, {
      reply_markup: new InlineKeyboard().text("← К тарифам", "menu:tariffs"),
    });
  });

  bot.on("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const parsed = parsePaymentPayload(query.invoice_payload);
    const selected = parsed ? CREDIT_PACKAGES[parsed.packageId] : undefined;
    const valid = Boolean(
      parsed
      && selected
      && parsed.telegramId === query.from.id
      && query.currency === "XTR"
      && query.total_amount === selected.stars,
    );
    await ctx.answerPreCheckoutQuery(
      valid,
      valid ? undefined : { error_message: "Счёт устарел или повреждён. Вернись в тарифы и создай новый." },
    );
  });

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
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
      await ctx.reply("Платёж получен, но пакет не удалось определить. Напиши /paysupport — мы проверим вручную.");
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
      await ctx.reply("Этот платёж уже был обработан. Повторно запросы не списывались и не начислялись.");
      return;
    }
    const access = db.getAccess(ctx.from.id);
    await ctx.reply(
      `Оплата прошла ✅\n\nНачислено: ${selected.credits} запросов\nТеперь доступно: ${access.credits} купленных запросов\n\nСпасибо! Можешь сразу отправлять фото или скриншот.`,
      { reply_markup: mainMenu() },
    );
  });

  bot.callbackQuery("menu:profile", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Твои ответы, лимит и тариф:", { reply_markup: profileMenu() });
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const access = db.getAccess(ctx.from.id);
    await ctx.editMessageText(
      balanceText(access.freeUsed, access.freeLimit, access.credits, access.plan),
      { reply_markup: profileMenu() },
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
    await replyChunks(ctx, text);
  });

  bot.callbackQuery("menu:favorites", async (ctx) => {
    await ctx.answerCallbackQuery();
    const items = db.listFavorites(ctx.from.id);
    const text = items.length
      ? `⭐ Твои шаблоны\n\n${items.map((item, index) => `${index + 1}. ${item.title}\n${item.content}`).join("\n\n")}`
      : "Сохранённых шаблонов пока нет. После генерации нажми «⭐ Сохранить».";
    await replyChunks(ctx, text);
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
    const access = db.getAccess(ctx.from.id);
    if (!access.allowed) {
      await ctx.answerCallbackQuery("Лимит закончился");
      await ctx.reply("Бесплатные запросы закончились. Открой тарифы.", { reply_markup: mainMenu() });
      return;
    }
    await ctx.answerCallbackQuery("Переделываю…");
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
    try {
      const result = await ai.refine(refinement, ctx.session.lastSource, ctx.session.lastResult);
      db.consumeRequest(ctx.from.id);
      db.saveGeneration(ctx.from.id, ctx.session.flow, ctx.session.category, ctx.session.lastSource, result);
      ctx.session.lastResult = result;
      await replyResult(ctx, result);
    } catch (error) {
      await handleError(ctx, error);
    }
  });

  bot.callbackQuery("action:favorite", async (ctx) => {
    if (!ctx.session.lastResult) return ctx.answerCallbackQuery("Сначала создай ответ");
    db.addFavorite(ctx.from.id, ctx.session.lastResult);
    await ctx.answerCallbackQuery("Сохранено в шаблоны ⭐");
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (ctx.session.visualResponseId) {
      await continueVisualConversation(ctx, db, ai, ctx.message.text);
      return;
    }
    if (!readyForInput(ctx)) {
      await ctx.reply("Отправь фотографию или скриншот, и я всё объясню.", { reply_markup: mainMenu() });
      return;
    }
    await generateForUser(ctx, db, ai, ctx.message.text);
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) {
      await ctx.reply("Не получилось получить фотографию. Попробуй отправить её ещё раз.");
      return;
    }
    const item: VisualMessageItem = {
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      caption: ctx.message.caption,
    };
    const mediaGroupId = ctx.message.media_group_id;
    if (!mediaGroupId) {
      await processVisualItems(ctx, [item], config, db, ai);
      return;
    }

    const key = `${ctx.chat.id}:${mediaGroupId}`;
    const album = pendingAlbums.get(key) ?? { ctx, items: [], timer: undefined };
    album.items.push(item);
    if (album.timer) clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      const readyAlbum = pendingAlbums.get(key);
      if (!readyAlbum) return;
      pendingAlbums.delete(key);
      void processVisualItems(readyAlbum.ctx, readyAlbum.items, config, db, ai);
    }, 900);
    pendingAlbums.set(key, album);
  });

  bot.on("message:document", async (ctx, next) => {
    const mimeType = ctx.message.document.mime_type;
    if (!mimeType?.startsWith("image/")) {
      await next();
      return;
    }
    await processVisualItems(ctx, [{
      fileId: ctx.message.document.file_id,
      mimeType,
      caption: ctx.message.caption,
    }], config, db, ai);
  });

  bot.on("message:voice", async (ctx) => {
    if (!readyForInput(ctx)) {
      await ctx.reply("Сначала выбери задачу в меню.", { reply_markup: mainMenu() });
      return;
    }
    if (!checkAccess(ctx, db)) return;
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    try {
      const audio = await downloadTelegramFile(ctx, config.BOT_TOKEN, ctx.message.voice.file_id);
      const transcript = await ai.transcribe(audio, "voice.ogg");
      if (!transcript) throw new Error("Не удалось распознать голос");
      const result = await ai.generate(ctx.session.flow!, ctx.session.category!, transcript);
      finishGeneration(ctx, db, transcript, result);
      await ctx.reply(`🎙 Распознано: ${transcript.slice(0, 800)}`);
      await replyResult(ctx, result);
    } catch (error) {
      await handleError(ctx, error);
    }
  });

  bot.catch(async (error) => {
    console.error("Bot error", error.error);
    try {
      await error.ctx.reply("Что-то сломалось на моей стороне. Попробуй ещё раз через минуту.");
    } catch {
      // Telegram may be unavailable too.
    }
  });

  return bot;
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

function checkAccess(ctx: BotContext, db: BotDatabase): boolean {
  const access = db.getAccess(ctx.from!.id);
  if (access.allowed) return true;
  void ctx.reply("Бесплатные запросы закончились. Открой тарифы или напиши владельцу бота.", {
    reply_markup: mainMenu(),
  });
  return false;
}

async function generateForUser(ctx: BotContext, db: BotDatabase, ai: AiService, source: string): Promise<void> {
  if (!checkAccess(ctx, db)) return;
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  try {
    const result = await ai.generate(ctx.session.flow!, ctx.session.category!, source);
    finishGeneration(ctx, db, source, result);
    await replyResult(ctx, result);
  } catch (error) {
    await handleError(ctx, error);
  }
}

function finishGeneration(ctx: BotContext, db: BotDatabase, source: string, result: string): void {
  db.consumeRequest(ctx.from!.id);
  db.saveGeneration(ctx.from!.id, ctx.session.flow!, ctx.session.category!, source, result);
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
): Promise<void> {
  if (!checkAccess(ctx, db)) return;
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  try {
    const images = await Promise.all(items.map(async (item) => ({
      data: await downloadTelegramFile(ctx, config.BOT_TOKEN, item.fileId),
      mimeType: item.mimeType,
    })));
    const caption = items.find((item) => item.caption?.trim())?.caption;
    const visual = await ai.generateFromImages(images, caption);
    const cleanResult = cleanTelegramText(visual.text);
    ctx.session.flow = "analyze";
    ctx.session.category = "auto";
    const source = caption || (items.length > 1
      ? `Альбом из ${items.length} изображений`
      : "Фотография или скриншот пользователя");
    finishGeneration(ctx, db, source, cleanResult);
    ctx.session.visualResponseId = visual.responseId;
    await replyVisualResult(ctx, cleanResult);
  } catch (error) {
    await handleError(ctx, error);
  }
}

async function continueVisualConversation(
  ctx: BotContext,
  db: BotDatabase,
  ai: AiService,
  question: string,
): Promise<void> {
  if (!checkAccess(ctx, db) || !ctx.session.visualResponseId) return;
  await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  try {
    const visual = await ai.continueVisual(ctx.session.visualResponseId, question);
    const cleanResult = cleanTelegramText(visual.text);
    db.consumeRequest(ctx.from!.id);
    db.saveGeneration(ctx.from!.id, "analyze", "auto", question, cleanResult);
    ctx.session.lastSource = question;
    ctx.session.lastResult = cleanResult;
    ctx.session.visualResponseId = visual.responseId;
    await replyVisualResult(ctx, cleanResult);
  } catch (error) {
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

async function downloadTelegramFile(ctx: BotContext, token: string, fileId: string): Promise<Uint8Array> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не вернул путь к файлу");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Не удалось скачать файл: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
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
