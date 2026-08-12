import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const telegramIds = z.preprocess((value) => {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((item) => Number(item.trim()));
}, z.array(z.number().int().positive()));

const schema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN не задан"),
  OPENAI_API_KEY: z.string().min(20, "OPENAI_API_KEY не задан"),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1-mini"),
  FREE_REQUEST_LIMIT: z.coerce.number().int().min(0).default(5),
  DATABASE_PATH: z.string().default("./data/bot.db"),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive().optional(),
  UNLIMITED_TELEGRAM_IDS: telegramIds.default([]),
  PLUS_SUBSCRIPTION_STARS: z.coerce.number().int().positive().default(299),
  PLUS_IMAGE_LIMIT: z.coerce.number().int().positive().default(5),
  PRO_IMAGE_LIMIT: z.coerce.number().int().positive().default(20),
  GLOBAL_IMAGE_LIMIT: z.coerce.number().int().positive().default(30),
  IMAGE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  POSTHOG_API_KEY: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(10).optional(),
  ),
  POSTHOG_HOST: z.string().url().default("https://eu.i.posthog.com"),
  REPORT_TIMEZONE: z.string().default("Asia/Irkutsk"),
  DAILY_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(10),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Ошибка конфигурации: ${message}`);
  }
  return parsed.data;
}
