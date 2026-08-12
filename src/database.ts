import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcquisitionStats,
  AnalyticsPeriodDays,
  BusinessStats,
  CategoryId,
  FlowId,
  GenerationRecord,
  PaymentRecord,
  RequestReservation,
  UserAccess,
} from "./types.js";

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

      CREATE TABLE IF NOT EXISTS request_reservations (
        id TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('pro', 'free', 'credits')),
        payment_charge_id TEXT,
        status TEXT NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved', 'consumed', 'released')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
        FOREIGN KEY (payment_charge_id) REFERENCES payments(telegram_payment_charge_id)
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS product_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_acquisition (
        telegram_id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS generations_user_date
      ON generations(telegram_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS payments_user_date
      ON payments(telegram_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS product_events_date
      ON product_events(created_at DESC, event);

      CREATE INDEX IF NOT EXISTS product_events_user_date
      ON product_events(telegram_id, created_at DESC);

      INSERT OR IGNORE INTO user_acquisition (telegram_id, source)
      SELECT telegram_id, 'legacy' FROM users;
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

  getStateInt(key: string, fallback = 0): number {
    const value = Number(this.getState(key));
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  setStateInt(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("State value must be non-negative");
    this.setState(key, String(value));
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as {
      value: string;
    } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  }

  recordEvent(telegramId: number, event: string, detail?: string): void {
    this.db.prepare(`
      INSERT INTO product_events (telegram_id, event, detail) VALUES (?, ?, ?)
    `).run(telegramId, event, detail ?? null);
  }

  recordAcquisition(telegramId: number, source: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO user_acquisition (telegram_id, source) VALUES (?, ?)
    `).run(telegramId, source);
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
    const reservation = this.reserveRequest(telegramId);
    if (reservation) this.commitRequest(reservation.id);
    return this.getAccess(telegramId);
  }

  reserveRequest(telegramId: number): RequestReservation | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT free_used, credits, plan FROM users WHERE telegram_id = ?",
      ).get(telegramId) as { free_used: number; credits: number; plan: string } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return undefined;
      }

      let source: "pro" | "free" | "credits";
      let paymentChargeId: string | null = null;
      if (row.plan === "pro") {
        source = "pro";
      } else if (row.free_used < this.freeLimit) {
        source = "free";
        this.db.prepare(
          "UPDATE users SET free_used = free_used + 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        ).run(telegramId);
      } else if (row.credits > 0) {
        source = "credits";
        const payment = this.db.prepare(`
          SELECT telegram_payment_charge_id FROM payments
          WHERE telegram_id = ? AND status = 'paid' AND remaining_credits > 0
          ORDER BY created_at, rowid LIMIT 1
        `).get(telegramId) as { telegram_payment_charge_id: string } | undefined;
        paymentChargeId = payment?.telegram_payment_charge_id ?? null;
        this.db.prepare(
          "UPDATE users SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ? AND credits > 0",
        ).run(telegramId);
        if (paymentChargeId) {
          this.db.prepare(`
            UPDATE payments SET remaining_credits = remaining_credits - 1
            WHERE telegram_payment_charge_id = ? AND remaining_credits > 0
          `).run(paymentChargeId);
        }
      } else {
        this.db.exec("ROLLBACK");
        return undefined;
      }

      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO request_reservations (id, telegram_id, source, payment_charge_id)
        VALUES (?, ?, ?, ?)
      `).run(id, telegramId, source, paymentChargeId);
      this.db.exec("COMMIT");
      return { id };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitRequest(reservationId: string): boolean {
    const result = this.db.prepare(`
      UPDATE request_reservations SET status = 'consumed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'reserved'
    `).run(reservationId);
    return result.changes > 0;
  }

  releaseRequest(reservationId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reservation = this.db.prepare(`
        SELECT telegram_id, source, payment_charge_id FROM request_reservations
        WHERE id = ? AND status = 'reserved'
      `).get(reservationId) as {
        telegram_id: number;
        source: "pro" | "free" | "credits";
        payment_charge_id: string | null;
      } | undefined;
      if (!reservation) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        UPDATE request_reservations SET status = 'released', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'reserved'
      `).run(reservationId);
      if (reservation.source === "free") {
        this.db.prepare(`
          UPDATE users SET free_used = MAX(0, free_used - 1), updated_at = CURRENT_TIMESTAMP
          WHERE telegram_id = ?
        `).run(reservation.telegram_id);
      } else if (reservation.source === "credits") {
        let restoreCredit = true;
        if (reservation.payment_charge_id) {
          const result = this.db.prepare(`
            UPDATE payments SET remaining_credits = remaining_credits + 1
            WHERE telegram_payment_charge_id = ? AND status = 'paid'
          `).run(reservation.payment_charge_id);
          restoreCredit = result.changes > 0;
        }
        if (restoreCredit) {
          this.db.prepare(`
            UPDATE users SET credits = credits + 1, updated_at = CURRENT_TIMESTAMP
            WHERE telegram_id = ?
          `).run(reservation.telegram_id);
        }
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverReservedRequests(): number {
    const rows = this.db.prepare(
      "SELECT id FROM request_reservations WHERE status = 'reserved'",
    ).all() as Array<{ id: string }>;
    let recovered = 0;
    for (const row of rows) {
      if (this.releaseRequest(row.id)) recovered += 1;
    }
    return recovered;
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

  businessStats(periodDays: AnalyticsPeriodDays): BusinessStats {
    const filter = periodDays === 0 ? "" : " AND created_at >= datetime('now', ?)";
    const customerFilter = " AND telegram_id NOT IN (SELECT telegram_id FROM users WHERE plan = 'pro')";
    const period = `-${periodDays} days`;
    const scalar = (sql: string, usePeriod = true): number => {
      const row = this.db.prepare(sql).get(...(usePeriod && periodDays !== 0 ? [period] : [])) as {
        value: number;
      };
      return row.value;
    };
    const eventCountForPeriod = (event: string): number => {
      const params: Array<string> = [event];
      if (periodDays !== 0) params.push(period);
      const row = this.db.prepare(
        `SELECT COUNT(*) AS value FROM product_events WHERE event = ?${customerFilter}${filter}`,
      ).get(...params) as { value: number };
      return row.value;
    };

    const users = scalar("SELECT COUNT(*) AS value FROM users WHERE plan != 'pro'", false);
    const newUsers = scalar(`SELECT COUNT(*) AS value FROM users WHERE plan != 'pro'${filter}`);
    const activeUsers = scalar(
      `SELECT COUNT(DISTINCT telegram_id) AS value FROM product_events WHERE 1 = 1${customerFilter}${filter}`,
    );
    const generations = scalar(`SELECT COUNT(*) AS value FROM generations WHERE 1 = 1${customerFilter}${filter}`);
    const purchases = scalar(`SELECT COUNT(*) AS value FROM payments WHERE 1 = 1${customerFilter}${filter}`);
    const payingUsers = scalar(
      `SELECT COUNT(DISTINCT telegram_id) AS value FROM payments WHERE 1 = 1${customerFilter}${filter}`,
    );
    const grossStars = scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM payments WHERE 1 = 1${customerFilter}${filter}`,
    );
    const refundFilter = periodDays === 0 ? "" : " AND refunded_at >= datetime('now', ?)";
    const refunds = scalar(
      `SELECT COUNT(*) AS value FROM payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    );
    const refundedStars = scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    );
    const packageParams = periodDays === 0 ? [] : [period];
    const popularPackage = this.db.prepare(`
      SELECT package_id FROM payments WHERE 1 = 1${customerFilter}${filter}
      GROUP BY package_id ORDER BY COUNT(*) DESC, package_id LIMIT 1
    `).get(...packageParams) as { package_id: string } | undefined;

    return {
      periodDays,
      users,
      newUsers,
      activeUsers,
      generations,
      photoRequests: eventCountForPeriod("generation_photo"),
      textRequests: eventCountForPeriod("generation_text"),
      voiceRequests: eventCountForPeriod("generation_voice"),
      purchases,
      payingUsers,
      grossStars,
      refunds,
      refundedStars,
      conversionPercent: activeUsers > 0 ? Math.round((payingUsers / activeUsers) * 1_000) / 10 : 0,
      popularPackage: popularPackage?.package_id,
    };
  }

  acquisitionStats(limit = 8): AcquisitionStats[] {
    const rows = this.db.prepare(`
      SELECT a.source,
             COUNT(*) AS users,
             SUM(CASE WHEN p.telegram_id IS NOT NULL THEN 1 ELSE 0 END) AS paying_users,
             COALESCE(SUM(p.stars), 0) AS stars
      FROM user_acquisition a
      LEFT JOIN (
        SELECT telegram_id, SUM(CASE WHEN status = 'paid' THEN stars ELSE 0 END) AS stars
        FROM payments GROUP BY telegram_id
      ) p ON p.telegram_id = a.telegram_id
      WHERE a.telegram_id NOT IN (SELECT telegram_id FROM users WHERE plan = 'pro')
      GROUP BY a.source
      ORDER BY users DESC, stars DESC
      LIMIT ?
    `).all(limit) as Array<{
        source: string;
        users: number;
        paying_users: number;
        stars: number;
      }>;
    return rows.map((row) => ({
      source: row.source,
      users: row.users,
      payingUsers: row.paying_users,
      stars: row.stars,
    }));
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
