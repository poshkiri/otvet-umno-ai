import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDatabase } from "../src/database.js";

test("database enforces free limit and then consumes credits", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 2);
  const id = 123;
  db.ensureUser(id, "test", "Тест");

  assert.equal(db.getAccess(id).allowed, true);
  db.consumeRequest(id);
  db.consumeRequest(id);
  assert.equal(db.getAccess(id).allowed, false);

  db.addCredits(id, 2);
  assert.equal(db.getAccess(id).allowed, true);
  db.consumeRequest(id);
  assert.equal(db.getAccess(id).credits, 1);
  db.close();
});

test("database stores history and favorite replies", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  const id = 456;
  db.ensureUser(id);
  db.saveGeneration(id, "client", "sales", "Вопрос", "Готовый ответ");
  db.addFavorite(id, "Готовый ответ");

  assert.equal(db.recentGenerations(id)[0]?.result, "Готовый ответ");
  assert.equal(db.listFavorites(id)[0]?.content, "Готовый ответ");
  db.close();
});

test("pro plan has unlimited access and does not consume credits", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const id = 789;
  db.ensureUser(id);
  db.setPlan(id, "pro");

  assert.equal(db.getAccess(id).allowed, true);
  db.consumeRequest(id);
  assert.equal(db.getAccess(id).plan, "pro");
  assert.equal(db.getAccess(id).credits, 0);
  db.close();
});
