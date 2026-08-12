import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api } from "grammy";
import { BotDatabase } from "../src/database.js";
import { reconcileStarTransactions } from "../src/reconciliation.js";

test("Stars reconciliation restores a missed payment idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const transaction = {
    id: "telegram-charge-1",
    amount: 99,
    date: 1,
    source: {
      type: "user",
      transaction_type: "invoice_payment",
      invoice_payload: "credits-v1:start:3001",
      user: { id: 3001, is_bot: false, first_name: "Test" },
    },
  };
  const api = {
    getStarTransactions: async ({ offset = 0 }: { offset?: number }) => ({
      transactions: offset === 0 ? [transaction] : [],
    }),
  } as unknown as Api;

  assert.deepEqual(await reconcileStarTransactions(api, db), { credited: 1, refunded: 0 });
  assert.equal(db.getAccess(3001).credits, 50);
  assert.deepEqual(await reconcileStarTransactions(api, db), { credited: 0, refunded: 0 });
  assert.equal(db.getAccess(3001).credits, 50);
  db.close();
});

test("Stars reconciliation records a refund completed before a crash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  db.ensureUser(3002);
  db.recordPayment(3002, "start", 50, 99, "credits-v1:start:3002", "telegram-charge-2");
  const api = {
    getStarTransactions: async ({ offset = 0 }: { offset?: number }) => ({
      transactions: [{
        id: "telegram-charge-2",
        amount: -99,
        date: 2,
        receiver: {
          type: "user",
          transaction_type: "invoice_payment",
          user: { id: 3002, is_bot: false, first_name: "Test" },
        },
      }].slice(offset),
    }),
  } as unknown as Api;

  assert.deepEqual(await reconcileStarTransactions(api, db), { credited: 0, refunded: 1 });
  assert.equal(db.getAccess(3002).credits, 0);
  assert.equal(db.getPayment("telegram-charge-2")?.status, "refunded");
  db.close();
});

test("Stars reconciliation paginates beyond 100 transactions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "otvet-umno-"));
  const db = new BotDatabase(join(directory, "test.db"), 0);
  const transactions = Array.from({ length: 101 }, (_, index) => ({
    id: `charge-${index}`,
    amount: 99,
    date: index + 1,
    source: {
      type: "user" as const,
      transaction_type: "invoice_payment" as const,
      invoice_payload: "credits-v1:start:4001",
      user: { id: 4001, is_bot: false, first_name: "Test" },
    },
  }));
  const offsets: number[] = [];
  const api = {
    getStarTransactions: async ({ offset = 0, limit = 100 }: {
      offset?: number;
      limit?: number;
    }) => {
      offsets.push(offset);
      return { transactions: transactions.slice(offset, offset + limit) };
    },
  } as unknown as Api;

  assert.deepEqual(await reconcileStarTransactions(api, db), { credited: 101, refunded: 0 });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(db.getStateInt("star_transactions_offset"), 101);
  assert.equal(db.getAccess(4001).credits, 5050);
  db.close();
});
