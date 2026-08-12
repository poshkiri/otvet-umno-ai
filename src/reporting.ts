import type { Api } from "grammy";
import type { ProductAnalytics } from "./analytics.js";
import type { AppConfig } from "./config.js";
import type { BotDatabase } from "./database.js";
import { CREDIT_PACKAGES, isCreditPackageId } from "./payments.js";
import type { AcquisitionStats, BusinessStats } from "./types.js";

const PERIOD_LABELS: Record<BusinessStats["periodDays"], string> = {
  0: "за всё время",
  1: "за последние 24 часа",
  7: "за 7 дней",
  30: "за 30 дней",
};

export function formatBusinessReport(stats: BusinessStats, starBalance?: number): string {
  const packageName = stats.popularPackage && isCreditPackageId(stats.popularPackage)
    ? CREDIT_PACKAGES[stats.popularPackage].title
    : stats.popularPackage === "plus_subscription" ? "Подписка Plus" : "пока нет";
  const netStars = stats.grossStars - stats.refundedStars;
  return [
    `📊 Пойми AI · ${PERIOD_LABELS[stats.periodDays]}`,
    "",
    "👥 Аудитория",
    `Всего пользователей: ${stats.users}`,
    `Новых: ${stats.newUsers}`,
    `Активных: ${stats.activeUsers}`,
    "",
    "🧠 Использование",
    `Готовых ответов: ${stats.generations}`,
    `Фото и скриншоты: ${stats.photoRequests}`,
    `Текст: ${stats.textRequests}`,
    `Голосовые: ${stats.voiceRequests}`,
    `Создано картинок: ${stats.createdImages}`,
    "",
    "⭐ Продажи",
    `Активных подписок Plus: ${stats.activeSubscriptions}`,
    `Покупок: ${stats.purchases}`,
    `Платящих пользователей: ${stats.payingUsers}`,
    `Конверсия активных в оплату: ${formatPercent(stats.conversionPercent)}`,
    `Начислено: ${stats.grossStars} Stars`,
    `Возвраты: ${stats.refunds} на ${stats.refundedStars} Stars`,
    `Чистыми: ${netStars} Stars`,
    `Популярный пакет: ${packageName}`,
    ...(starBalance === undefined ? [] : [`Баланс бота: ${starBalance} Stars`]),
  ].join("\n");
}

export function formatAcquisitionReport(items: AcquisitionStats[]): string {
  if (items.length === 0) {
    return "📣 Источники\n\nДанных пока нет. Используй ссылки вида:\nt.me/USERNAME?start=instagram";
  }
  return [
    "📣 Источники пользователей",
    "",
    ...items.map((item, index) => {
      const conversion = item.users > 0 ? (item.payingUsers / item.users) * 100 : 0;
      return `${index + 1}. ${item.source}\nПользователи: ${item.users} · Покупатели: ${item.payingUsers} · ${formatPercent(conversion)} · ${item.stars} Stars`;
    }),
  ].join("\n\n");
}

export async function getBotStarBalance(api: Api): Promise<number | undefined> {
  try {
    const balance = await api.getMyStarBalance();
    return balance.amount;
  } catch (error) {
    console.error("Star balance request failed", error);
    return undefined;
  }
}

export interface DailyReporter {
  stop: () => void;
  drain: () => Promise<void>;
}

export function startDailyReporter(
  api: Api,
  db: BotDatabase,
  config: AppConfig,
  analytics: ProductAnalytics,
): DailyReporter {
  let pending: Promise<void> | undefined;
  const run = (): void => {
    if (!config.ADMIN_TELEGRAM_ID || pending) return;
    const local = localDateAndHour(new Date(), config.REPORT_TIMEZONE);
    if (local.hour < config.DAILY_REPORT_HOUR || db.getState("daily_report_date") === local.date) return;
    pending = (async () => {
      const balance = await getBotStarBalance(api);
      await api.sendMessage(
        config.ADMIN_TELEGRAM_ID!,
        `☀️ Ежедневный отчёт\n\n${formatBusinessReport(db.businessStats(1), balance)}`,
      );
      db.setState("daily_report_date", local.date);
      analytics.capture(config.ADMIN_TELEGRAM_ID!, "daily_report_sent");
    })()
      .catch((error) => console.error("Daily report failed", error))
      .finally(() => {
        pending = undefined;
      });
  };

  run();
  const timer = setInterval(run, 15 * 60 * 1_000);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    drain: async () => {
      if (pending) await pending;
    },
  };
}

function localDateAndHour(date: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Number(read("hour")),
  };
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value)}%`;
}
