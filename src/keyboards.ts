import { InlineKeyboard } from "grammy";
import type { CategoryId, FlowId } from "./types.js";
import { CREDIT_PACKAGES } from "./payments.js";

export const SUPPORT_TELEGRAM_URL = "https://t.me/PoymiAI_support";

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Спросить", "menu:chat")
    .text("📷 Разобрать", "menu:analyze").row()
    .text("🎨 Картинки", "menu:images")
    .text("👤 Аккаунт", "menu:profile");
}

export function imagesMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✨ Создать картинку", "image:create").row()
    .text("🪄 Изменить фото", "image:edit-new").row()
    .text("🏠 Главное меню", "menu:main");
}

export function paywallMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⭐ Подключить Plus", "subscribe:plus").row()
    .text("📦 Купить запросы", "menu:credit-packs");
}

export function creditPacksMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `${CREDIT_PACKAGES.start.credits} запросов · ${CREDIT_PACKAGES.start.stars} ⭐`,
      "buy:start",
    ).row()
    .text(
      `${CREDIT_PACKAGES.plus.credits} запросов · ${CREDIT_PACKAGES.plus.stars} ⭐`,
      "buy:plus",
    ).row()
    .text(
      `${CREDIT_PACKAGES.pro.credits} запросов · ${CREDIT_PACKAGES.pro.stars} ⭐`,
      "buy:pro",
    ).row()
    .text("← К тарифам", "menu:tariffs");
}

export function categoryMenu(flow: FlowId): InlineKeyboard {
  return new InlineKeyboard()
    .text("💼 Деловая", `category:${flow}:business`)
    .text("📈 Продажи", `category:${flow}:sales`).row()
    .text("👔 Работа / HR", `category:${flow}:work`)
    .text("🛍 Маркетплейс", `category:${flow}:marketplace`).row()
    .text("💬 Личная", `category:${flow}:personal`).row()
    .text("← В меню", "menu:main");
}

export function resultMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🌿 Мягче", "refine:softer")
    .text("💪 Увереннее", "refine:confident")
    .text("⚙️ Ещё", "menu:refinements").row()
    .text("⭐ Сохранить", "action:favorite")
    .text("🏠 Меню", "menu:main");
}

export function visualResultMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🪄 Изменить это фото", "image:edit-current");
}

export function refinementsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✂️ Короче", "refine:shorter")
    .text("🧊 Без эмоций", "refine:neutral")
    .row()
    .text("🛡 С границами", "refine:boundaries")
    .text("💎 Статуснее", "refine:premium")
    .row()
    .text("5 вариантов", "refine:more")
    .text("🇬🇧 На английский", "refine:english").row()
    .text("← Назад", "menu:result");
}

export function profileMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⭐ Plus и запросы", "menu:tariffs").row()
    .text("🕘 История", "menu:history")
    .text("🧾 Покупки", "menu:payments").row()
    .url("💬 Поддержка", SUPPORT_TELEGRAM_URL).row()
    .text("🏠 Главное меню", "menu:main");
}

export function tariffsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⭐ Plus · 299 Stars", "subscribe:plus").row()
    .text("📦 Разовые запросы", "menu:credit-packs").row()
    .text("🧾 Покупки", "menu:payments")
    .text("← Назад", "menu:profile");
}

export function imageResultMenu(): InlineKeyboard {
  return new InlineKeyboard().text("🎨 Создать ещё", "image:again");
}

export function imageEditResultMenu(): InlineKeyboard {
  return new InlineKeyboard().text("🎨 Изменить ещё", "image:edit-again");
}

const QUICK_CATEGORIES: Partial<Record<FlowId, CategoryId>> = {
  analyze: "auto",
  compose: "auto",
  review: "auto",
  client: "sales",
  hr: "work",
  marketplace: "marketplace",
  complaint: "business",
};

export function quickCategory(flow: FlowId): CategoryId | undefined {
  return QUICK_CATEGORIES[flow];
}
