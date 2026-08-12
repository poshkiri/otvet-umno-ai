import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CategoryId, FlowId, GenerationRecord, PaymentRecord, UserAccess } from "./types.js";

export class BotDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly freeLimit: number) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        free_used INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        flow TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS payments (
        telegram_payment_charge_id TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        package_id TEXT NOT NULL,
        credits INTEGER NOT NULL,
        remaining_credits INTEGER NOT NULL,
        stars INTEGER NOT NULL,
        invoice_payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        refunded_at TEXT,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS action_locks (
        telegram_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        handled_at INTEGER NOT NULL,
        PRIMARY KEY (telegram_id, action)
      );

      CREATE INDEX IF NOT EXISTS generations_user_date
      ON generations(telegram_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS payments_user_date
      ON payments(telegram_id, created_at DESC);
    `);
  }

  ensureUser(telegramId: number, username?: string, firstName?: string): void {
    this.db.prepare(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        updated_at = CURRENT_TIMESTAMP
    `).run(telegramId, username ?? null, firstName ?? null);
  }

  claimUpdate(updateId: number): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)",
    ).run(updateId);
    if (result.changes === 0) return false;
    if (updateId % 100 === 0) {
      this.db.prepare("DELETE FROM processed_updates WHERE update_id < ?").run(updateId - 10_000);
    }
    return true;
  }

  claimAction(telegramId: number, action: string, cooldownSeconds: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      INSERT INTO action_locks (telegram_id, action, handled_at)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id, action) DO UPDATE SET handled_at = excluded.handled_at
      WHERE action_locks.handled_at <= excluded.handled_at - ?
    `).run(telegramId, action, now, cooldownSeconds);
    return result.changes > 0;
  }

  getAccess(telegramId: number): UserAccess {
    const row = this.db.prepare(
      "SELECT free_used, credits, plan FROM users WHERE telegram_id = ?",
    ).get(telegramId) as { free_used: number; credits: number; plan: string } | undefined;

    const freeUsed = row?.free_used ?? 0;
    const credits = row?.credits ?? 0;
    const plan = row?.plan ?? "free";
    return {
      freeUsed,
      freeLimit: this.freeLimit,
      credits,
      plan,
      allowed: plan === "pro" || freeUsed < this.freeLimit || credits > 0,
    };
  }

  consumeRequest(telegramId: number): UserAccess {
    const access = this.getAccess(telegramId);
    if (!access.allowed) return access;

    if (access.plan !== "pro") {
      if (access.freeUsed < access.freeLimit) {
        this.db.prepare(
          "UPDATE users SET free_used = free_used + 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        ).run(telegramId);
      } else {
        this.db.prepare(
          "UPDATE users SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        ).run(telegramId);
        this.db.prepare(`
          UPDATE payments SET remaining_credits = remaining_credits - 1
          WHERE telegram_payment_charge_id = (
            SELECT telegram_payment_charge_id FROM payments
            WHERE telegram_id = ? AND status = 'paid' AND remaining_credits > 0
            ORDER BY created_at, rowid LIMIT 1
          )
        `).run(telegramId);
      }
    }
    return this.getAccess(telegramId);
  }

  addCredits(telegramId: number, amount: number): void {
    this.db.prepare(
      "UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
    ).run(amount, telegramId);
  }

  recordPayment(
    telegramId: number,
    packageId: string,
    credits: number,
    stars: number,
    invoicePayload: string,
    chargeId: string,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO payments (
          telegram_payment_charge_id, telegram_id, package_id, credits, remaining_credits,
          stars, invoice_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(chargeId, telegramId, packageId, credits, credits, stars, invoicePayload);
      if (result.changes === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(
        "UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
      ).run(credits, telegramId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recentPayments(telegramId: number, limit = 10): PaymentRecord[] {
    const rows = this.db.prepare(`
      SELECT telegram_payment_charge_id, package_id, credits, remaining_credits, stars,
             status, created_at, refunded_at
      FROM payments WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(telegramId, limit) as Array<{
      telegram_payment_charge_id: string;
      package_id: string;
      credits: number;
      remaining_credits: number;
      stars: number;
      status: "paid" | "refunded";
      created_at: string;
      refunded_at: string | null;
    }>;
    return rows.map((row) => ({
      chargeId: row.telegram_payment_charge_id,
      packageId: row.package_id,
      credits: row.credits,
      remainingCredits: row.remaining_credits,
      stars: row.stars,
      status: row.status,
      createdAt: row.created_at,
      refundedAt: row.refunded_at ?? undefined,
    }));
  }

  getPayment(chargeId: string): (PaymentRecord & { telegramId: number }) | undefined {
    const row = this.db.prepare(`
      SELECT telegram_payment_charge_id, telegram_id, package_id, credits, remaining_credits, stars,
             status, created_at, refunded_at
      FROM payments WHERE telegram_payment_charge_id = ?
    `).get(chargeId) as {
      telegram_payment_charge_id: string;
      telegram_id: number;
      package_id: string;
      credits: number;
      remaining_credits: number;
      stars: number;
      status: "paid" | "refunded";
      created_at: string;
      refunded_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      chargeId: row.telegram_payment_charge_id,
      telegramId: row.telegram_id,
      packageId: row.package_id,
      credits: row.credits,
      remainingCredits: row.remaining_credits,
      stars: row.stars,
      status: row.status,
      createdAt: row.created_at,
      refundedAt: row.refunded_at ?? undefined,
    };
  }

  markPaymentRefunded(chargeId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const payment = this.getPayment(chargeId);
      if (!payment || payment.status !== "paid") {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        UPDATE payments SET status = 'refunded', remaining_credits = 0,
                            refunded_at = CURRENT_TIMESTAMP
        WHERE telegram_payment_charge_id = ? AND status = 'paid'
      `).run(chargeId);
      this.db.prepare(`
        UPDATE users SET credits = MAX(0, credits - ?), updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?
      `).run(payment.remainingCredits, payment.telegramId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setPlan(telegramId: number, plan: "free" | "pro"): void {
    this.db.prepare(
      "UPDATE users SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
    ).run(plan, telegramId);
  }

  saveGeneration(
    telegramId: number,
    flow: FlowId,
    category: CategoryId,
    source: string,
    result: string,
  ): void {
    this.db.prepare(`
      INSERT INTO generations (telegram_id, flow, category, source, result)
      VALUES (?, ?, ?, ?, ?)
    `).run(telegramId, flow, category, source, result);
  }

  recentGenerations(telegramId: number, limit = 5): GenerationRecord[] {
    const rows = this.db.prepare(`
      SELECT id, flow, category, source, result, created_at
      FROM generations WHERE telegram_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(telegramId, limit) as Array<{
      id: number;
      flow: FlowId;
      category: CategoryId;
      source: string;
      result: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      flow: row.flow,
      category: row.category,
      source: row.source,
      result: row.result,
      createdAt: row.created_at,
    }));
  }

  addFavorite(telegramId: number, content: string): void {
    const title = content.replace(/\s+/g, " ").slice(0, 60);
    this.db.prepare(
      "INSERT INTO favorites (telegram_id, title, content) VALUES (?, ?, ?)",
    ).run(telegramId, title, content);
  }

  listFavorites(telegramId: number, limit = 10): Array<{ title: string; content: string }> {
    return this.db.prepare(`
      SELECT title, content FROM favorites
      WHERE telegram_id = ? ORDER BY id DESC LIMIT ?
    `).all(telegramId, limit) as Array<{ title: string; content: string }>;
  }

  stats(): { users: number; generations: number; favorites: number; payments: number; stars: number } {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return row.count;
    };
    const stars = this.db.prepare(
      "SELECT COALESCE(SUM(stars), 0) AS total FROM payments WHERE status = 'paid'",
    ).get() as { total: number };
    return {
      users: count("users"), generations: count("generations"), favorites: count("favorites"),
      payments: count("payments"), stars: stars.total,
    };
  }

  close(): void {
    this.db.close();
  }
}
