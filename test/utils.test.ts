import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerationPrompt, buildRefinementPrompt, VISION_SYSTEM_PROMPT } from "../src/prompts.js";
import { cleanTelegramText, splitLongMessage } from "../src/utils.js";

test("splitLongMessage keeps every chunk under Telegram limit", () => {
  const text = Array.from({ length: 500 }, (_, index) => `Абзац ${index}: полезный ответ пользователю.`).join("\n");
  const chunks = splitLongMessage(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join("\n").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("generation prompt includes scenario, category and source", () => {
  const prompt = buildGenerationPrompt("complaint", "business", "Клиент недоволен сроком");
  assert.match(prompt, /Ответ на претензию/);
  assert.match(prompt, /Деловая переписка/);
  assert.match(prompt, /Клиент недоволен сроком/);
});

test("refinement prompt preserves source and previous result", () => {
  const prompt = buildRefinementPrompt("shorter", "Ситуация", "Старый ответ");
  assert.match(prompt, /короче/);
  assert.match(prompt, /Ситуация/);
  assert.match(prompt, /Старый ответ/);
});

test("vision prompt covers products, screenshots and uncertainty", () => {
  assert.match(VISION_SYSTEM_PROMPT, /Товар, упаковка или этикетка/);
  assert.match(VISION_SYSTEM_PROMPT, /Скриншот приложения/);
  assert.match(VISION_SYSTEM_PROMPT, /не выдумывай/);
});

test("cleanTelegramText removes visible markdown decoration", () => {
  assert.equal(
    cleanTelegramText("📷 **Что на фото**\nЭто __товар__ с `этикеткой`."),
    "📷 Что на фото\nЭто товар с этикеткой.",
  );
});
