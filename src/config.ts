import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const schema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN не задан"),
  OPENAI_API_KEY: z.string().min(20, "OPENAI_API_KEY не задан"),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  FREE_REQUEST_LIMIT: z.coerce.number().int().min(0).default(5),
  DATABASE_PATH: z.string().default("./data/bot.db"),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive().optional(),
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
