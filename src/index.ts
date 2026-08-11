import { AiService } from "./ai.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./database.js";

const config = loadConfig();
const database = new BotDatabase(config.DATABASE_PATH, config.FREE_REQUEST_LIMIT);
const ai = new AiService(config.OPENAI_API_KEY, config.OPENAI_MODEL, config.OPENAI_TRANSCRIBE_MODEL);
const bot = createBot(config, database, ai);

const stop = async (signal: string): Promise<void> => {
  console.log(`Получен ${signal}, останавливаю бота…`);
  await bot.stop();
  database.close();
  process.exit(0);
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

console.log("ОтветьУмно AI запускается…");
await bot.api.setMyCommands([
  { command: "start", description: "Запустить бота" },
  { command: "menu", description: "Открыть главное меню" },
  { command: "balance", description: "Проверить лимиты" },
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
await bot.start({
  onStart: (info) => console.log(`Бот @${info.username} запущен`),
});
