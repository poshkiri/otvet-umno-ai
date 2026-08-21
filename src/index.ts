import { AiService } from "./ai.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import { run } from "@grammyjs/runner";
import { reconcileStarTransactions } from "./reconciliation.js";
import { ProductAnalytics } from "./analytics.js";
import { startDailyReporter } from "./reporting.js";
import { createAppServer } from "./server.js";
import { importDatabaseIfPresent, selectDatabasePath } from "./database-import.js";
import { isBotPollingEnabled } from "./runtime-config.js";

const config = loadConfig();
const botPollingEnabled = isBotPollingEnabled(
  process.env.BOT_POLLING_ENABLED,
  process.env.BOT_POLLING_RUNTIME_ENABLED,
);
const databasePath = selectDatabasePath(config.DATABASE_PATH, process.env.DATABASE_RUNTIME_PATH);
if (config.MINI_APP_URL) process.env.MINI_APP_URL = config.MINI_APP_URL;
const databaseImport = importDatabaseIfPresent(
  databasePath,
  process.env.DATABASE_IMPORT_PATH,
);
if (databaseImport.imported) {
  console.log(
    `База импортирована: ${databaseImport.users} пользователей, ${databaseImport.payments} платежей`,
  );
  if (databaseImport.backupPath) console.log(`Предыдущая база сохранена: ${databaseImport.backupPath}`);
}
const database = new BotDatabase(
  databasePath,
  config.FREE_REQUEST_LIMIT,
  config.PLUS_REQUEST_LIMIT,
  config.PLUS_IMAGE_LIMIT,
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
  config.OPENAI_IMAGE_EDIT_MODEL,
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
const desiredBotName = "Пойми AI | Фото и задачи";
await configureProfile("имя", async () => {
  const current = await bot.api.getMyName();
  if (current.name !== desiredBotName) await bot.api.setMyName(desiredBotName);
});
await configureProfile("команды", () => bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "menu", description: "Открыть главное меню" },
  { command: "balance", description: "Мои запросы и лимиты" },
  { command: "documents", description: "Документы и правила" },
  { command: "paysupport", description: "Написать в поддержку" },
]));
await configureProfile("кнопку меню", () => bot.api.setChatMenuButton({
  menu_button: { type: "commands" },
}));
await configureProfile("короткое описание", () => bot.api.setMyShortDescription(
  `Отправь фото, голос или вопрос — получи простое объяснение. ${config.FREE_REQUEST_LIMIT} запросов бесплатно.`,
));
await configureProfile("полное описание", () => bot.api.setMyDescription(
  [
    "✨ Покажи или спроси — Пойми AI разберётся",
    "",
    "📸 Объясняет товары, фото документов и скриншоты",
    "🎙 Понимает голосовые вопросы",
    "🎓 Решает задачи по шагам",
    "✍️ Пишет, проверяет и переводит тексты",
    "🎨 Создаёт картинки и изменяет фотографии",
    "",
    `Первые ${config.FREE_REQUEST_LIMIT} запросов бесплатно.`,
    "Примеры работы и обновления: @PoymiAI_news",
  ].join("\n"),
));
const appServer = createAppServer(config, database, ai, analytics, bot.botInfo.username);
await appServer.listen({ host: "0.0.0.0", port: config.PORT });
console.log(`Mini App API запущен на порту ${config.PORT}`);

if (!botPollingEnabled) {
  console.log("Режим Mini App: получение Telegram-сообщений отключено");
  let stoppingWebServer = false;
  const stopWebServer = async (signal: string): Promise<void> => {
    if (stoppingWebServer) return;
    stoppingWebServer = true;
    console.log(`Получен ${signal}, останавливаю Mini App API…`);
    await appServer.close();
    await drainBackgroundTasks();
    await analytics.shutdown();
    database.close();
    console.log("Mini App API остановлен корректно");
  };

  process.once("SIGINT", () => void stopWebServer("SIGINT"));
  process.once("SIGTERM", () => void stopWebServer("SIGTERM"));
  await new Promise<void>(() => undefined);
}

try {
  const result = await reconcileStarTransactions(bot.api, database);
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
  reconciliationTask = reconcileStarTransactions(bot.api, database)
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
