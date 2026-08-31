import assert from "node:assert/strict";
import test from "node:test";
import { extractImageEditPrompt, extractReplyPhotoSource, isImageUnderstandingQuestion } from "../src/bot.js";

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
  assert.equal(extractImageEditPrompt("сделай реалистичнее"), "сделай реалистичнее");
  assert.equal(extractImageEditPrompt("изменить на реалистическую"), "изменить на реалистическую");
  assert.equal(extractImageEditPrompt("фон белый"), "фон белый");
  assert.equal(extractImageEditPrompt("сделай фотореалистично"), "сделай фотореалистично");
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

test("image understanding questions do not become edit requests", () => {
  assert.equal(isImageUnderstandingQuestion("что это и как использовать?"), true);
  assert.equal(isImageUnderstandingQuestion("разбери это фото"), true);
  assert.equal(isImageUnderstandingQuestion("что написано на этикетке?"), true);
  assert.equal(isImageUnderstandingQuestion("добавь на стол деньги"), false);
  assert.equal(isImageUnderstandingQuestion("фон белый"), false);
});

test("reply photo can be reused as an image edit source", () => {
  const source = extractReplyPhotoSource({
    message: {
      reply_to_message: {
        photo: [
          { file_id: "small" },
          { file_id: "large" },
        ],
      },
    },
  } as never);
  assert.deepEqual(source, { fileId: "large", mimeType: "image/jpeg" });
});

test("reply image document can be reused as an image edit source", () => {
  const source = extractReplyPhotoSource({
    message: {
      reply_to_message: {
        document: {
          file_id: "doc-image",
          mime_type: "image/png",
        },
      },
    },
  } as never);
  assert.deepEqual(source, { fileId: "doc-image", mimeType: "image/png" });
});
