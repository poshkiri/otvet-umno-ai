import assert from "node:assert/strict";
import test from "node:test";
import { mainMenu, tariffsMenu, visualResultMenu } from "../src/keyboards.js";

test("main menu exposes history and balance while keeping purchase separate", () => {
  assert.deepEqual(mainMenu().inline_keyboard, [
    [{ text: "🎨 Создать картинку", callback_data: "image:create" }],
    [
      { text: "🕘 История", callback_data: "menu:history" },
      { text: "⚡ Лимиты", callback_data: "menu:balance" },
    ],
    [{ text: "⭐ Plus и запросы", callback_data: "menu:tariffs" }],
  ]);
});

test("tariffs return directly to the main menu", () => {
  assert.deepEqual(tariffsMenu().inline_keyboard[1], [
    { text: "❓ Как купить Stars", callback_data: "stars:help" },
  ]);
  assert.deepEqual(tariffsMenu().inline_keyboard.at(-1), [
    { text: "← В меню", callback_data: "menu:main" },
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
