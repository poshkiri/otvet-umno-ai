import { InlineKeyboard } from "grammy";
import type { CategoryId, FlowId } from "./types.js";

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 История, лимит и тариф", "menu:profile");
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
    .text("⭐ Сохранить", "action:favorite")
    .text("👤 Моё", "menu:profile");
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
    .text("🕘 История", "menu:history")
    .text("⭐ Шаблоны", "menu:favorites").row()
    .text("💳 Тариф", "menu:tariffs")
    .text("⚡ Лимит", "menu:balance").row()
    .text("← В меню", "menu:main");
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
