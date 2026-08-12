import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesMenu,
  mainMenu,
  profileMenu,
  tariffsMenu,
  visualResultMenu,
} from "../src/keyboards.js";

test("main menu keeps the primary actions simple", () => {
  assert.deepEqual(mainMenu().inline_keyboard, [
    [{ text: "🎨 Создать картинку", callback_data: "image:create" }],
    [
      { text: "✨ Возможности", callback_data: "menu:capabilities" },
      { text: "👤 Мой кабинет", callback_data: "menu:profile" },
    ],
  ]);
});

test("capabilities menu leads to creation, account and main menu", () => {
  assert.deepEqual(capabilitiesMenu().inline_keyboard, [
    [{ text: "🎨 Создать картинку", callback_data: "image:create" }],
    [{ text: "👤 Мой кабинет", callback_data: "menu:profile" }],
    [{ text: "← В меню", callback_data: "menu:main" }],
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
