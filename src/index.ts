import { AiService } from "./ai.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import { run } from "@grammyjs/runner";
import { reconcileStarTransactions } from "./reconciliation.js";
import { ProductAnalytics } from "./analytics.js";
import { startDailyReporter } from "./reporting.js";
import { createAppServer } from "./server.js";

const config = loadConfig();
if (config.MINI_APP_URL) process.env.MINI_APP_URL = config.MINI_APP_URL;
const database = new BotDatabase(
  config.DATABASE_PATH,
  config.FREE_REQUEST_LIMIT,
  config.PLUS_REQUEST_LIMIT,
);
const recoveredRequests = database.recoverReservedRequests();
if (recoveredRequests) console.log(`Возвращено зависших резервов: ${recoveredRequests}`);
const recoveredImages = database.recoverReservedImageGenerations();
if (recoveredImages) console.log(`Возвращено зависших генераций картинок: ${recoveredImages}`);
const ai = new AiService(
  config.OPENAI_API_KEY,
  config.OPENAI_MODEL,
  config.OPENAI_TRANSCRIBE_MODEL,
  config.OPENAI_IMAGE_MODEL,
  config.MAX_OUTPUT_TOKENS,
);
const analytics = new ProductAnalytics(config.POSTHOG_API_KEY, config.POSTHOG_HOST, config.BOT_TOKEN);
const { bot, drainBackgroundTasks } = createBot(config, database, ai, analytics);

console.log("Пойми AI запускается…");
await bot.init();
const configureProfile = async (label: string, update: () => Promise<unknown>): Promise<void> => {
  try {
    await update();
  } catch (error) {
    console.warn(`Не удалось обновить ${label}; бот продолжит работу`, error);
  }
};
await configureProfile("команды", () => bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "menu", description: "Открыть главное меню" },
  { command: "image", description: "Создать AI-картинку" },
  { command: "balance", description: "Проверить лимиты" },
  { command: "paysupport", description: "Поддержка по оплате" },
  { command: "myid", description: "Показать мой Telegram ID" },
  { command: "help", description: "Как пользоваться" },
]));
if (config.MINI_APP_URL) {
  await configureProfile("кнопку Mini App", () => bot.api.setChatMenuButton({
    menu_button: {
      type: "web_app",
      text: "📷 Открыть Пойми AI",
      web_app: { url: config.MINI_APP_URL! },
    },
  }));
}
await configureProfile("короткое описание", () => bot.api.setMyShortDescription(
  "✨ Фото, голос, учёба, тексты и изображения. Канал: @PoymiAI_news",
));
await configureProfile("полное описание", () => bot.api.setMyDescription(
  [
    "✨ Пойми AI — помощник на каждый день",
    "",
    "📸 Понимает фотографии и скриншоты",
    "🎙 Отвечает на голосовые вопросы",
    "🎓 Помогает с учёбой",
    "✍️ Работает с текстами",
    "🎨 Создаёт и изменяет изображения",
    "",
    "Канал: @PoymiAI_news",
  ].join("\n"),
));
const appServer = createAppServer(config, database, ai, analytics, bot.botInfo.username);
await appServer.listen({ host: "0.0.0.0", port: config.PORT });
console.log(`Mini App API запущен на порту ${config.PORT}`);
try {
  const result = await reconcileStarTransactions(bot.api, database, config.PLUS_SUBSCRIPTION_STARS);
  if (result.credited || result.refunded) {
    console.log(`Stars reconciled: +${result.credited} payments, ${result.refunded} refunds`);
  }
} catch (error) {
  console.error("Stars reconciliation failed", error);
}

const dailyReporter = startDailyReporter(bot.api, database, config, analytics);

const runner = run(bot, {
  sink: { concurrency: 25 },
  runner: { retryInterval: "exponential", maxRetryTime: 30_000 },
});
let reconciliationTask: Promise<void> | undefined;
const scheduleReconciliation = (): void => {
  if (reconciliationTask) return;
  reconciliationTask = reconcileStarTransactions(bot.api, database, config.PLUS_SUBSCRIPTION_STARS)
    .then((result) => {
      if (result.credited || result.refunded) {
        console.log(`Stars reconciled: +${result.credited} payments, ${result.refunded} refunds`);
      }
    })
    .catch((error) => console.error("Stars reconciliation failed", error))
    .finally(() => {
      reconciliationTask = undefined;
    });
};
const reconciliationTimer = setInterval(() => {
  scheduleReconciliation();
}, 5 * 60 * 1000);
reconciliationTimer.unref();

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`Получен ${signal}, жду завершения активных задач…`);
  clearInterval(reconciliationTimer);
  dailyReporter.stop();
  await appServer.close();
  await runner.stop();
  await drainBackgroundTasks();
  await dailyReporter.drain();
  if (reconciliationTask) await reconciliationTask;
  await analytics.shutdown();
  database.close();
  console.log("Бот остановлен корректно");
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

console.log(`Бот @${bot.botInfo.username} запущен`);
await runner.task();
