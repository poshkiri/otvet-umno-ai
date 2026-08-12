import assert from "node:assert/strict";
import test from "node:test";
import { visualResultMenu } from "../src/keyboards.js";

test("visual result keeps only the new photo action", () => {
  assert.deepEqual(visualResultMenu().inline_keyboard, [[{
    text: "📷 Новое фото",
    callback_data: "visual:new-photo",
  }]]);
});
