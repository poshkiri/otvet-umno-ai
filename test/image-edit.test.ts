import assert from "node:assert/strict";
import test from "node:test";
import { extractImageEditPrompt } from "../src/bot.js";

test("image edit intent recognizes natural Russian requests", () => {
  assert.equal(extractImageEditPrompt("Сделай меня в стиле аниме"), "Сделай меня в стиле аниме");
  assert.equal(extractImageEditPrompt("замени фон на ночной Токио"), "замени фон на ночной Токио");
  assert.equal(
    extractImageEditPrompt("Добавить на столе кучу денег"),
    "Добавить на столе кучу денег",
  );
  assert.equal(extractImageEditPrompt("убрать человека справа"), "убрать человека справа");
  assert.equal(extractImageEditPrompt("дорисовать на небе радугу"), "дорисовать на небе радугу");
  assert.equal(extractImageEditPrompt("аниме"), "аниме");
  assert.equal(extractImageEditPrompt("что находится на фотографии?"), undefined);
});
