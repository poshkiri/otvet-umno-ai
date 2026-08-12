import assert from "node:assert/strict";
import test from "node:test";
import { formatAcquisitionReport, formatBusinessReport } from "../src/reporting.js";

test("business report exposes the key product and payment metrics", () => {
  const report = formatBusinessReport({
    periodDays: 7,
    users: 120,
    newUsers: 20,
    activeUsers: 40,
    generations: 90,
    photoRequests: 50,
    textRequests: 30,
    voiceRequests: 10,
    purchases: 4,
    payingUsers: 3,
    grossStars: 696,
    refunds: 1,
    refundedStars: 99,
    conversionPercent: 7.5,
    popularPackage: "plus",
  }, 550);

  assert.match(report, /Активных: 40/);
  assert.match(report, /Конверсия активных в оплату: 7,5%/);
  assert.match(report, /Чистыми: 597 Stars/);
  assert.match(report, /Популярный пакет: Плюс/);
  assert.match(report, /Баланс бота: 550 Stars/);
});

test("acquisition report shows source conversion", () => {
  const report = formatAcquisitionReport([
    { source: "instagram", users: 20, payingUsers: 2, stars: 198 },
  ]);
  assert.match(report, /instagram/);
  assert.match(report, /10%/);
  assert.match(report, /198 Stars/);
});
