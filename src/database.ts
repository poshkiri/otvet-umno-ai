import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CategoryId, FlowId, GenerationRecord, UserAccess } from "./types.js";

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

      CREATE INDEX IF NOT EXISTS generations_user_date
      ON generations(telegram_id, created_at DESC);
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
      }
    }
    return this.getAccess(telegramId);
  }

  addCredits(telegramId: number, amount: number): void {
    this.db.prepare(
      "UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
    ).run(amount, telegramId);
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

  stats(): { users: number; generations: number; favorites: number } {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return row.count;
    };
    return { users: count("users"), generations: count("generations"), favorites: count("favorites") };
  }

  close(): void {
    this.db.close();
  }
}
