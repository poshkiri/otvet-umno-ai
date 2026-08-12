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
  ImageAllowance,
  ImageReservation,
  ImageTier,
  PaymentRecord,
  RequestReservation,
  SubscriptionAccess,
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
        free_image_used INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS subscriptions (
        telegram_id INTEGER PRIMARY KEY,
        plan_id TEXT NOT NULL CHECK (plan_id = 'plus'),
        latest_charge_id TEXT NOT NULL,
        period_end INTEGER NOT NULL,
        auto_renew INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS subscription_payments (
        telegram_payment_charge_id TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        plan_id TEXT NOT NULL CHECK (plan_id = 'plus'),
        stars INTEGER NOT NULL,
        invoice_payload TEXT NOT NULL,
        period_end INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'refunded')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        refunded_at TEXT,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS image_generations (
        id TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('free', 'plus', 'pro')),
        status TEXT NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved', 'completed', 'released')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
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

      CREATE INDEX IF NOT EXISTS subscription_payments_user_date
      ON subscription_payments(telegram_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS image_generations_user_date
      ON image_generations(telegram_id, created_at DESC);

      INSERT OR IGNORE INTO user_acquisition (telegram_id, source)
      SELECT telegram_id, 'legacy' FROM users;
    `);

    const userColumns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!userColumns.some((column) => column.name === "free_image_used")) {
      this.db.exec("ALTER TABLE users ADD COLUMN free_image_used INTEGER NOT NULL DEFAULT 0");
    }
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

  getSubscriptionAccess(telegramId: number, now = Math.floor(Date.now() / 1000)): SubscriptionAccess {
    const row = this.db.prepare(`
      SELECT plan_id, latest_charge_id, period_end, auto_renew
      FROM subscriptions WHERE telegram_id = ?
    `).get(telegramId) as {
      plan_id: "plus";
      latest_charge_id: string;
      period_end: number;
      auto_renew: number;
    } | undefined;
    if (!row || row.period_end <= now) return { active: false, autoRenew: false };
    return {
      active: true,
      planId: row.plan_id,
      periodEnd: row.period_end,
      autoRenew: row.auto_renew === 1,
      latestChargeId: row.latest_charge_id,
    };
  }

  recordSubscriptionPayment(
    telegramId: number,
    stars: number,
    invoicePayload: string,
    chargeId: string,
    periodEnd: number,
    startsNewSubscription = false,
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO subscription_payments (
          telegram_payment_charge_id, telegram_id, plan_id, stars, invoice_payload, period_end
        ) VALUES (?, ?, 'plus', ?, ?, ?)
      `).run(chargeId, telegramId, stars, invoicePayload, periodEnd);
      if (result.changes === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        INSERT INTO subscriptions (telegram_id, plan_id, latest_charge_id, period_end, auto_renew)
        VALUES (?, 'plus', ?, ?, 1)
        ON CONFLICT(telegram_id) DO UPDATE SET
          plan_id = 'plus',
          latest_charge_id = CASE WHEN ? = 1
            THEN excluded.latest_charge_id ELSE subscriptions.latest_charge_id END,
          period_end = MAX(subscriptions.period_end, excluded.period_end), auto_renew = 1,
          updated_at = CURRENT_TIMESTAMP
      `).run(telegramId, chargeId, periodEnd, startsNewSubscription ? 1 : 0);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setSubscriptionAutoRenew(telegramId: number, autoRenew: boolean): boolean {
    const result = this.db.prepare(`
      UPDATE subscriptions SET auto_renew = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `).run(autoRenew ? 1 : 0, telegramId);
    return result.changes > 0;
  }

  recentSubscriptionPayments(telegramId: number, limit = 10): Array<{
    chargeId: string;
    stars: number;
    periodEnd: number;
    status: "paid" | "refunded";
    createdAt: string;
  }> {
    const rows = this.db.prepare(`
      SELECT telegram_payment_charge_id, stars, period_end, status, created_at
      FROM subscription_payments WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(telegramId, limit) as Array<{
      telegram_payment_charge_id: string;
      stars: number;
      period_end: number;
      status: "paid" | "refunded";
      created_at: string;
    }>;
    return rows.map((row) => ({
      chargeId: row.telegram_payment_charge_id,
      stars: row.stars,
      periodEnd: row.period_end,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  getSubscriptionPayment(chargeId: string): {
    chargeId: string;
    telegramId: number;
    stars: number;
    status: "paid" | "refunded";
  } | undefined {
    const row = this.db.prepare(`
      SELECT telegram_payment_charge_id, telegram_id, stars, status
      FROM subscription_payments WHERE telegram_payment_charge_id = ?
    `).get(chargeId) as {
      telegram_payment_charge_id: string;
      telegram_id: number;
      stars: number;
      status: "paid" | "refunded";
    } | undefined;
    return row ? {
      chargeId: row.telegram_payment_charge_id,
      telegramId: row.telegram_id,
      stars: row.stars,
      status: row.status,
    } : undefined;
  }

  markSubscriptionPaymentRefunded(chargeId: string, now = Math.floor(Date.now() / 1000)): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const payment = this.db.prepare(`
        SELECT telegram_id, status FROM subscription_payments
        WHERE telegram_payment_charge_id = ?
      `).get(chargeId) as { telegram_id: number; status: "paid" | "refunded" } | undefined;
      if (!payment || payment.status !== "paid") {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        UPDATE subscription_payments SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP
        WHERE telegram_payment_charge_id = ? AND status = 'paid'
      `).run(chargeId);
      this.db.prepare(`
        UPDATE subscriptions SET period_end = MIN(period_end, ?), auto_renew = 0,
                                 updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ? AND latest_charge_id = ?
      `).run(now, payment.telegram_id, chargeId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getImageAllowance(
    telegramId: number,
    limits: { plus: number; pro: number; global: number; windowSeconds: number },
    now = Math.floor(Date.now() / 1000),
  ): ImageAllowance {
    return this.calculateImageAllowance(telegramId, limits, now);
  }

  reserveImageGeneration(
    telegramId: number,
    limits: { plus: number; pro: number; global: number; windowSeconds: number },
    now = Math.floor(Date.now() / 1000),
  ): ImageReservation | ImageAllowance {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const allowance = this.calculateImageAllowance(telegramId, limits, now);
      if (!allowance.allowed) {
        this.db.exec("ROLLBACK");
        return allowance;
      }
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO image_generations (id, telegram_id, tier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, telegramId, allowance.tier, now, now);
      if (allowance.tier === "free") {
        this.db.prepare(`
          UPDATE users SET free_image_used = 1, updated_at = CURRENT_TIMESTAMP
          WHERE telegram_id = ?
        `).run(telegramId);
      }
      this.db.exec("COMMIT");
      return {
        id,
        allowance: {
          ...allowance,
          used: allowance.used + 1,
          remaining: Math.max(0, allowance.remaining - 1),
        },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeImageGeneration(reservationId: string, now = Math.floor(Date.now() / 1000)): boolean {
    const result = this.db.prepare(`
      UPDATE image_generations SET status = 'completed', updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(now, reservationId);
    return result.changes > 0;
  }

  releaseImageGeneration(reservationId: string, now = Math.floor(Date.now() / 1000)): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT telegram_id, tier FROM image_generations WHERE id = ? AND status = 'reserved'
      `).get(reservationId) as { telegram_id: number; tier: ImageTier } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        UPDATE image_generations SET status = 'released', updated_at = ? WHERE id = ?
      `).run(now, reservationId);
      if (row.tier === "free") {
        this.db.prepare(`
          UPDATE users SET free_image_used = 0, updated_at = CURRENT_TIMESTAMP
          WHERE telegram_id = ?
        `).run(row.telegram_id);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverReservedImageGenerations(): number {
    const rows = this.db.prepare(
      "SELECT id FROM image_generations WHERE status = 'reserved'",
    ).all() as Array<{ id: string }>;
    let recovered = 0;
    for (const row of rows) {
      if (this.releaseImageGeneration(row.id)) recovered += 1;
    }
    return recovered;
  }

  private calculateImageAllowance(
    telegramId: number,
    limits: { plus: number; pro: number; global: number; windowSeconds: number },
    now: number,
  ): ImageAllowance {
    const user = this.db.prepare(`
      SELECT free_image_used, plan FROM users WHERE telegram_id = ?
    `).get(telegramId) as { free_image_used: number; plan: string } | undefined;
    const subscription = this.getSubscriptionAccess(telegramId, now);
    const tier: ImageTier = user?.plan === "pro" ? "pro" : subscription.active ? "plus" : "free";
    const limit = tier === "pro" ? limits.pro : tier === "plus" ? limits.plus : 1;
    const cutoff = now - limits.windowSeconds;
    const global = this.db.prepare(`
      SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM image_generations
      WHERE status IN ('reserved', 'completed') AND created_at > ?
    `).get(cutoff) as { used: number; oldest: number | null };
    if (global.used >= limits.global) {
      return {
        allowed: false, tier, used: 0, limit, remaining: 0,
        resetAt: (global.oldest ?? now) + limits.windowSeconds,
        subscriptionEndsAt: subscription.periodEnd,
        reason: "global_limit",
      };
    }
    if (tier === "free") {
      const used = user?.free_image_used ?? 0;
      return {
        allowed: used === 0, tier, used, limit, remaining: used === 0 ? 1 : 0,
        subscriptionEndsAt: subscription.periodEnd,
        reason: used === 0 ? undefined : "trial_used",
      };
    }
    const usage = this.db.prepare(`
      SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM image_generations
      WHERE telegram_id = ? AND status IN ('reserved', 'completed') AND created_at > ?
    `).get(telegramId, cutoff) as { used: number; oldest: number | null };
    return {
      allowed: usage.used < limit,
      tier,
      used: usage.used,
      limit,
      remaining: Math.max(0, limit - usage.used),
      resetAt: usage.used >= limit ? (usage.oldest ?? now) + limits.windowSeconds : undefined,
      subscriptionEndsAt: subscription.periodEnd,
      reason: usage.used >= limit ? "user_limit" : undefined,
    };
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
    const creditPurchases = scalar(`SELECT COUNT(*) AS value FROM payments WHERE 1 = 1${customerFilter}${filter}`);
    const subscriptionPurchases = scalar(`SELECT COUNT(*) AS value FROM subscription_payments WHERE 1 = 1${customerFilter}${filter}`);
    const purchases = creditPurchases + subscriptionPurchases;
    const payingParams = periodDays === 0 ? [] : [period, period];
    const payingUsers = (this.db.prepare(`
      SELECT COUNT(DISTINCT telegram_id) AS value FROM (
        SELECT telegram_id FROM payments WHERE 1 = 1${customerFilter}${filter}
        UNION ALL
        SELECT telegram_id FROM subscription_payments WHERE 1 = 1${customerFilter}${filter}
      )
    `).get(...payingParams) as { value: number }).value;
    const grossStars = scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM payments WHERE 1 = 1${customerFilter}${filter}`,
    ) + scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM subscription_payments WHERE 1 = 1${customerFilter}${filter}`,
    );
    const refundFilter = periodDays === 0 ? "" : " AND refunded_at >= datetime('now', ?)";
    const refunds = scalar(
      `SELECT COUNT(*) AS value FROM payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    ) + scalar(
      `SELECT COUNT(*) AS value FROM subscription_payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    );
    const refundedStars = scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    ) + scalar(
      `SELECT COALESCE(SUM(stars), 0) AS value FROM subscription_payments WHERE status = 'refunded'${customerFilter}${refundFilter}`,
    );
    const packageParams = periodDays === 0 ? [] : [period, period];
    const popularPackage = this.db.prepare(`
      SELECT package_id FROM (
        SELECT package_id FROM payments WHERE 1 = 1${customerFilter}${filter}
        UNION ALL
        SELECT 'plus_subscription' AS package_id FROM subscription_payments
        WHERE 1 = 1${customerFilter}${filter}
      )
      GROUP BY package_id ORDER BY COUNT(*) DESC, package_id LIMIT 1
    `).get(...packageParams) as { package_id: string } | undefined;
    const activeSubscriptions = scalar(`
      SELECT COUNT(*) AS value FROM subscriptions
      WHERE period_end > unixepoch()${customerFilter}
    `, false);

    return {
      periodDays,
      users,
      newUsers,
      activeUsers,
      generations,
      photoRequests: eventCountForPeriod("generation_photo"),
      textRequests: eventCountForPeriod("generation_text"),
      voiceRequests: eventCountForPeriod("generation_voice"),
      createdImages: eventCountForPeriod("image_created"),
      activeSubscriptions,
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
        SELECT telegram_id, SUM(stars) AS stars FROM (
          SELECT telegram_id, CASE WHEN status = 'paid' THEN stars ELSE 0 END AS stars
          FROM payments
          UNION ALL
          SELECT telegram_id, CASE WHEN status = 'paid' THEN stars ELSE 0 END AS stars
          FROM subscription_payments
        ) GROUP BY telegram_id
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
