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
    [
      { text: "🤖 Что умеет бот", callback_data: "menu:capabilities" },
      { text: "👤 Мой кабинет", callback_data: "menu:profile" },
    ],
  ]);
});

test("main menu promotes the Mini App with one primary button", () => {
  assert.deepEqual(mainMenu("https://example.com/app/").inline_keyboard, [
    [{ text: "📷 Открыть сканер", web_app: { url: "https://example.com/app/" } }],
    [
      { text: "🤖 Что умеет бот", callback_data: "menu:capabilities" },
      { text: "👤 Мой кабинет", callback_data: "menu:profile" },
    ],
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
    [{ text: "← Назад", callback_data: "menu:paywall" }],
  ]);
});

test("profile groups limits, purchases and personal content", () => {
  assert.deepEqual(profileMenu().inline_keyboard, [
    [
      { text: "⚡ Мои лимиты", callback_data: "menu:balance" },
      { text: "⭐ Plus и запросы", callback_data: "menu:tariffs" },
    ],
    [
      { text: "🕘 История", callback_data: "menu:history" },
      { text: "🔖 Сохранённое", callback_data: "menu:favorites" },
    ],
    [{ text: "👥 Пригласить друга", callback_data: "menu:invite" }],
    [{ text: "🧾 Мои покупки", callback_data: "menu:payments" }],
    [{ text: "← В меню", callback_data: "menu:main" }],
  ]);
});

test("tariffs return to the account menu", () => {
  assert.deepEqual(tariffsMenu().inline_keyboard[1], [
    { text: "❓ Как купить Stars", callback_data: "stars:help" },
  ]);
  assert.deepEqual(tariffsMenu().inline_keyboard.at(-1), [
    { text: "← В кабинет", callback_data: "menu:profile" },
  ]);
  assert.deepEqual(tariffsMenu().inline_keyboard[2], [
    { text: "50 запросов · 149 ⭐", callback_data: "buy:start" },
  ]);
});

test("visual result keeps only the new photo action", () => {
  assert.deepEqual(visualResultMenu().inline_keyboard, [[{
    text: "📷 Новое фото",
    callback_data: "visual:new-photo",
  }]]);
});
