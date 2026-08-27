import assert from "node:assert/strict";
import test from "node:test";
import {
  creditPacksMenu,
  documentsMenu,
  imageResultMenu,
  imagesMenu,
  mainMenu,
  paywallMenu,
  plusPlansMenu,
  profileMenu,
  tariffsMenu,
  visualResultMenu,
} from "../src/keyboards.js";

test("main menu keeps the primary actions simple", () => {
  assert.deepEqual(mainMenu().inline_keyboard, [
    [
      { text: "💬 Спросить", callback_data: "menu:chat" },
      { text: "📷 Разобрать", callback_data: "menu:analyze" },
    ],
    [
      { text: "🎨 Картинки", callback_data: "menu:images" },
      { text: "👤 Аккаунт", callback_data: "menu:profile" },
    ],
  ]);
});

test("images menu separates creation from editing", () => {
  assert.deepEqual(imagesMenu().inline_keyboard, [
    [{ text: "✨ Создать картинку", callback_data: "image:create" }],
    [{ text: "🪄 Изменить фото", callback_data: "image:edit-new" }],
    [{ text: "🏠 Главное меню", callback_data: "menu:main" }],
  ]);
});

test("paywall offers only subscription or request packs", () => {
  assert.deepEqual(paywallMenu().inline_keyboard, [
    [{ text: "⭐ Выбрать Plus", callback_data: "menu:plus-plans" }],
    [{ text: "📦 Купить запросы", callback_data: "menu:credit-packs" }],
  ]);
});

test("credit packs stay on a separate screen", () => {
  assert.deepEqual(creditPacksMenu().inline_keyboard, [
    [{ text: "50 запросов · 199 ⭐", callback_data: "buy:start" }],
    [{ text: "200 запросов · 699 ⭐", callback_data: "buy:plus" }],
    [{ text: "500 запросов · 1599 ⭐", callback_data: "buy:pro" }],
    [{ text: "← К тарифам", callback_data: "menu:tariffs" }],
  ]);
});

test("profile avoids repeating the balance as a separate screen", () => {
  assert.deepEqual(profileMenu().inline_keyboard, [
    [{ text: "⭐ Plus и запросы", callback_data: "menu:tariffs" }],
    [
      { text: "🕘 История", callback_data: "menu:history" },
      { text: "🧾 Покупки", callback_data: "menu:payments" },
    ],
    [{ text: "📄 Документы", callback_data: "menu:documents" }],
    [{ text: "💬 Поддержка", url: "https://t.me/PoymiAI_support" }],
    [{ text: "🏠 Главное меню", callback_data: "menu:main" }],
  ]);
});

test("documents stay permanently accessible from the account", () => {
  assert.deepEqual(documentsMenu().inline_keyboard, [
    [{ text: "🔒 Политика конфиденциальности", url: "https://poymi-ai.onrender.com/app/privacy" }],
    [{ text: "📋 Пользовательское соглашение", url: "https://poymi-ai.onrender.com/app/terms" }],
    [{ text: "⭐ Тарифы и цены", url: "https://poymi-ai.onrender.com/app/tariffs" }],
    [{ text: "💬 Поддержка", url: "https://t.me/PoymiAI_support" }],
    [{ text: "← В аккаунт", callback_data: "menu:profile" }],
  ]);
});

test("tariffs return to the account menu", () => {
  assert.deepEqual(tariffsMenu().inline_keyboard, [
    [{ text: "⭐ Выбрать Plus", callback_data: "menu:plus-plans" }],
    [{ text: "📦 Разовые запросы", callback_data: "menu:credit-packs" }],
    [
      { text: "🧾 Покупки", callback_data: "menu:payments" },
      { text: "← Назад", callback_data: "menu:profile" },
    ],
  ]);
});

test("Plus plans expose every supported duration", () => {
  assert.deepEqual(plusPlansMenu().inline_keyboard, [
    [{ text: "1 месяц · 399 ⭐", callback_data: "subscribe:1m" }],
    [{ text: "3 месяца · 999 ⭐", callback_data: "subscribe:3m" }],
    [{ text: "6 месяцев · 1799 ⭐", callback_data: "subscribe:6m" }],
    [{ text: "12 месяцев · 2999 ⭐", callback_data: "subscribe:12m" }],
    [{ text: "← К тарифам", callback_data: "menu:tariffs" }],
  ]);
});

test("visual result offers one relevant photo action", () => {
  assert.deepEqual(visualResultMenu().inline_keyboard, [[{
    text: "🪄 Изменить это фото",
    callback_data: "image:edit-current",
  }]]);
});

test("created image result can be regenerated or edited", () => {
  assert.deepEqual(imageResultMenu().inline_keyboard, [
    [{ text: "🎨 Создать ещё", callback_data: "image:again" }],
    [{ text: "🪄 Изменить это фото", callback_data: "image:edit-current" }],
  ]);
});
