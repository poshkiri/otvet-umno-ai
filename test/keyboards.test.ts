import assert from "node:assert/strict";
import test from "node:test";
import {
  creditPacksMenu,
  mainMenu,
  paywallMenu,
  profileMenu,
  tariffsMenu,
  visualResultMenu,
} from "../src/keyboards.js";

test("main menu keeps the primary actions simple", () => {
  assert.deepEqual(mainMenu().inline_keyboard, [
    [{ text: "✨ Примеры", callback_data: "menu:examples" }],
    [
      { text: "👤 Аккаунт", callback_data: "menu:profile" },
      { text: "⭐ Тарифы", callback_data: "menu:tariffs" },
    ],
    [{ text: "💬 Поддержка", url: "https://t.me/PoymiAI_support" }],
  ]);
});

test("paywall offers only subscription or request packs", () => {
  assert.deepEqual(paywallMenu().inline_keyboard, [
    [{ text: "⭐ Подключить Plus", callback_data: "subscribe:plus" }],
    [{ text: "📦 Купить запросы", callback_data: "menu:credit-packs" }],
  ]);
});

test("credit packs stay on a separate screen", () => {
  assert.deepEqual(creditPacksMenu().inline_keyboard, [
    [{ text: "50 запросов · 149 ⭐", callback_data: "buy:start" }],
    [{ text: "200 запросов · 549 ⭐", callback_data: "buy:plus" }],
    [{ text: "500 запросов · 1299 ⭐", callback_data: "buy:pro" }],
    [{ text: "← К тарифам", callback_data: "menu:tariffs" }],
  ]);
});

test("profile avoids repeating the balance as a separate screen", () => {
  assert.deepEqual(profileMenu().inline_keyboard, [
    [{ text: "⭐ Тарифы", callback_data: "menu:tariffs" }],
    [
      { text: "🕘 История", callback_data: "menu:history" },
      { text: "🧾 Покупки", callback_data: "menu:payments" },
    ],
    [{ text: "💬 Поддержка", url: "https://t.me/PoymiAI_support" }],
    [{ text: "← Назад", callback_data: "menu:main" }],
  ]);
});

test("tariffs return to the account menu", () => {
  assert.deepEqual(tariffsMenu().inline_keyboard, [
    [{ text: "⭐ Plus · 299 Stars", callback_data: "subscribe:plus" }],
    [{ text: "📦 Разовые запросы", callback_data: "menu:credit-packs" }],
    [
      { text: "🧾 Покупки", callback_data: "menu:payments" },
      { text: "← Назад", callback_data: "menu:profile" },
    ],
  ]);
});

test("visual result keeps only the new photo action", () => {
  assert.deepEqual(visualResultMenu().inline_keyboard, [[{
    text: "📷 Новое фото",
    callback_data: "visual:new-photo",
  }]]);
});
