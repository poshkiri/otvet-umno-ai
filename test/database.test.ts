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

test("payment is idempotent and credits are granted once", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const id = 1001;
  db.ensureUser(id);

  assert.equal(db.recordPayment(id, "start", 50, 99, "credits-v1:start:1001", "charge-1"), true);
  assert.equal(db.recordPayment(id, "start", 50, 99, "credits-v1:start:1001", "charge-1"), false);
  assert.equal(db.getAccess(id).credits, 50);
  assert.equal(db.recentPayments(id).length, 1);
  db.close();
});

test("refund removes only unused credits from the refunded package", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const id = 1002;
  db.ensureUser(id);
  db.recordPayment(id, "start", 2, 99, "credits-v1:start:1002", "charge-a");
  db.recordPayment(id, "plus", 3, 299, "credits-v1:plus:1002", "charge-b");
  db.consumeRequest(id);

  assert.equal(db.markPaymentRefunded("charge-a"), true);
  assert.equal(db.getAccess(id).credits, 3);
  assert.equal(db.getPayment("charge-a")?.status, "refunded");
  assert.equal(db.markPaymentRefunded("charge-a"), false);
  db.close();
});

test("database rejects a duplicate Telegram update", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);

  assert.equal(db.claimUpdate(100), true);
  assert.equal(db.claimUpdate(100), false);
  assert.equal(db.claimUpdate(101), true);
  db.close();
});

test("action cooldown suppresses repeated start events for the full start protection window", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);

  assert.equal(db.claimAction(777, "start", 30), true);
  assert.equal(db.claimAction(777, "start", 30), false);
  assert.equal(db.claimAction(777, "another-action", 30), true);
  db.close();
});

test("request reservation atomically prevents overspending and can be released", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const id = 2001;
  db.ensureUser(id);
  db.addCredits(id, 1);

  const first = db.reserveRequest(id);
  assert.ok(first);
  assert.equal(db.reserveRequest(id), undefined);
  assert.equal(db.getAccess(id).credits, 0);
  assert.equal(db.releaseRequest(first.id), true);
  assert.equal(db.releaseRequest(first.id), false);
  assert.equal(db.getAccess(id).credits, 1);
  db.close();
});

test("startup recovery returns unfinished reservations", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const path = join(directory, "test.db");
  const id = 2002;
  const firstProcess = new BotDatabase(path, 1);
  firstProcess.ensureUser(id);
  assert.ok(firstProcess.reserveRequest(id));
  assert.equal(firstProcess.getAccess(id).freeUsed, 1);
  firstProcess.close();

  const restartedProcess = new BotDatabase(path, 1);
  assert.equal(restartedProcess.recoverReservedRequests(), 1);
  assert.equal(restartedProcess.getAccess(id).freeUsed, 0);
  restartedProcess.close();
});

test("business analytics counts activity, revenue, refunds and conversion", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  db.ensureUser(3001);
  db.ensureUser(3002);
  db.ensureUser(3999);
  db.setPlan(3999, "pro");
  db.recordEvent(3999, "generation_photo", "owner-test");
  db.saveGeneration(3999, "analyze", "auto", "Проверка владельца", "Ответ");
  db.recordEvent(3001, "bot_started", "instagram");
  db.recordEvent(3001, "generation_photo", "photo");
  db.recordEvent(3001, "generation_text", "visual_followup");
  db.recordEvent(3002, "generation_voice", "voice");
  db.saveGeneration(3001, "analyze", "auto", "Фото", "Ответ");
  db.saveGeneration(3002, "analyze", "auto", "Голос", "Ответ");
  db.recordPayment(3001, "start", 50, 99, "payload-1", "analytics-charge-1");
  db.recordPayment(3002, "plus", 200, 299, "payload-2", "analytics-charge-2");
  db.markPaymentRefunded("analytics-charge-2");

  const stats = db.businessStats(0);
  assert.equal(stats.users, 2);
  assert.equal(stats.activeUsers, 2);
  assert.equal(stats.generations, 2);
  assert.equal(stats.photoRequests, 1);
  assert.equal(stats.textRequests, 1);
  assert.equal(stats.voiceRequests, 1);
  assert.equal(stats.purchases, 2);
  assert.equal(stats.payingUsers, 2);
  assert.equal(stats.grossStars, 398);
  assert.equal(stats.refunds, 1);
  assert.equal(stats.refundedStars, 299);
  assert.equal(stats.conversionPercent, 100);
  db.close();
});

test("acquisition keeps the first source and does not multiply users with repeat purchases", () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 5);
  db.ensureUser(4001);
  db.ensureUser(4002);
  assert.equal(db.recordAcquisition(4001, "instagram"), true);
  assert.equal(db.recordAcquisition(4001, "tiktok"), false);
  db.recordAcquisition(4002, "instagram");
  db.recordPayment(4001, "start", 50, 99, "payload-1", "source-charge-1");
  db.recordPayment(4001, "plus", 200, 299, "payload-2", "source-charge-2");

  assert.deepEqual(db.acquisitionStats(), [{
    source: "instagram",
    users: 2,
    payingUsers: 1,
    stars: 398,
  }]);
  db.close();
});
