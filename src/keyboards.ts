import { InlineKeyboard } from "grammy";
import type { CategoryId, FlowId } from "./types.js";
import { CREDIT_PACKAGES } from "./payments.js";

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎨 Создать картинку", "image:create").row()
    .text("✨ Возможности", "menu:capabilities")
    .text("👤 Мой кабинет", "menu:profile");
}

export function capabilitiesMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎨 Создать картинку", "image:create").row()
    .text("👤 Мой кабинет", "menu:profile").row()
    .text("← В меню", "menu:main");
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
    .text("📷 Новое фото", "visual:new-photo");
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
    .text("⚡ Мои лимиты", "menu:balance")
    .text("⭐ Plus и запросы", "menu:tariffs").row()
    .text("🕘 История", "menu:history")
    .text("🔖 Сохранённое", "menu:favorites").row()
    .text("🧾 Мои покупки", "menu:payments").row()
    .text("← В меню", "menu:main");
}

export function tariffsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⭐ Оформить Plus", "subscribe:plus").row()
    .text("❓ Как купить Stars", "stars:help").row()
    .text(`${CREDIT_PACKAGES.start.credits} запросов · ${CREDIT_PACKAGES.start.stars} ⭐`, "buy:start").row()
    .text(`${CREDIT_PACKAGES.plus.credits} запросов · ${CREDIT_PACKAGES.plus.stars} ⭐`, "buy:plus").row()
    .text(`${CREDIT_PACKAGES.pro.credits} запросов · ${CREDIT_PACKAGES.pro.stars} ⭐`, "buy:pro").row()
    .text("🧾 Мои покупки", "menu:payments").row()
    .text("← В кабинет", "menu:profile");
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
