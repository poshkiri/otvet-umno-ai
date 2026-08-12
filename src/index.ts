import { AiService } from "./ai.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import { run } from "@grammyjs/runner";
import { reconcileStarTransactions } from "./reconciliation.js";

const config = loadConfig();
const database = new BotDatabase(config.DATABASE_PATH, config.FREE_REQUEST_LIMIT);
const recoveredRequests = database.recoverReservedRequests();
if (recoveredRequests) console.log(`Возвращено зависших резервов: ${recoveredRequests}`);
const ai = new AiService(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.OPENAI_TRANSCRIBE_MODEL);
const { bot, drainBackgroundTasks } = createBot(config, database, ai);

console.log("ОтветьУмно AI запускается…");
await bot.init();
await bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "menu", description: "Открыть главное меню" },
  { command: "balance", description: "Проверить лимиты" },
  { command: "paysupport", description: "Поддержка по оплате" },
  { command: "myid", description: "Показать мой Telegram ID" },
  { command: "help", description: "Как пользоваться" },
]);
await bot.api.setMyShortDescription(
  "Отправь фото или скриншот — я распознаю содержимое и объясню простыми словами.",
);
await bot.api.setMyDescription(
  [
    "ОтветьУмно AI помогает:",
    "",
    "• объяснить товар, этикетку или инструкцию;",
    "• разобрать скриншот, документ или ошибку;",
    "• решить учебную задачу по фотографии;",
    "• помочь с текстом или перепиской.",
    "",
    "Просто отправь фотографию — выбирать режим не нужно.",
  ].join("\n"),
);
try {
  const result = await reconcileStarTransactions(bot.api, database);
  if (result.credited || result.refunded) {
    console.log(`Stars reconciled: +${result.credited} payments, ${result.refunded} refunds`);
  }
} catch (error) {
  console.error("Stars reconciliation failed", error);
}

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
  await runner.stop();
  await drainBackgroundTasks();
  if (reconciliationTask) await reconciliationTask;
  database.close();
  console.log("Бот остановлен корректно");
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

console.log(`Бот @${bot.botInfo.username} запущен`);
await runner.task();
