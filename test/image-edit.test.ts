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
  assert.equal(extractImageEditPrompt("сделай фото ярче"), "сделай фото ярче");
  assert.equal(extractImageEditPrompt("аниме"), "аниме");
  assert.equal(extractImageEditPrompt("а можно фон сделать белым?"), "а можно фон сделать белым?");
  assert.equal(
    extractImageEditPrompt("хочу чтобы руки здесь не было"),
    "хочу чтобы руки здесь не было",
  );
  assert.equal(
    extractImageEditPrompt("можешь убрать лишний текст на фото"),
    "можешь убрать лишний текст на фото",
  );
  assert.equal(extractImageEditPrompt("что находится на фотографии?"), undefined);
  assert.equal(extractImageEditPrompt("какой фон на фото?"), undefined);
  assert.equal(extractImageEditPrompt("сделай план ухода за кожей"), undefined);
  assert.equal(extractImageEditPrompt("сделай краткое описание товара"), undefined);
});
