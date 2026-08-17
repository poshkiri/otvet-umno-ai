import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { importDatabaseIfPresent, selectDatabasePath } from "../src/database-import.js";

test("runtime database path overrides a malformed configured path", () => {
  assert.equal(
    selectDatabasePath("./data/bot.db/opt/render/project/src/data/bot.db", "  ./data/poymi.db  "),
    "./data/poymi.db",
  );
  assert.equal(selectDatabasePath("./data/bot.db", "  "), "./data/bot.db");
});

function createDatabase(path: string, telegramId: number): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE users (telegram_id INTEGER PRIMARY KEY);
    CREATE TABLE payments (telegram_payment_charge_id TEXT PRIMARY KEY);
    CREATE TABLE processed_updates (update_id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES (${telegramId});
  `);
  db.close();
}

test("database import verifies and atomically replaces SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-import-"));
  const target = join(directory, "bot.db");
  const incoming = join(directory, "incoming.db");
  createDatabase(target, 1);
  createDatabase(incoming, 2);

  const result = importDatabaseIfPresent(target, incoming);
  assert.equal(result.imported, true);
  assert.equal(result.users, 1);
  assert.ok(result.backupPath);
  assert.equal(existsSync(incoming), false);

  const imported = new DatabaseSync(target, { readOnly: true });
  const importedUser = imported.prepare("SELECT telegram_id FROM users").get() as {
    telegram_id: number;
  };
  assert.equal(importedUser.telegram_id, 2);
  imported.close();

  const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
  const backupUser = backup.prepare("SELECT telegram_id FROM users").get() as {
    telegram_id: number;
  };
  assert.equal(backupUser.telegram_id, 1);
  backup.close();
});

test("database import rejects a corrupt file without touching the current database", () => {
  const directory = mkdtempSync(join(tmpdir(), "poymi-import-invalid-"));
  const target = join(directory, "bot.db");
  const incoming = join(directory, "incoming.db");
  createDatabase(target, 1);
  writeFileSync(incoming, "not sqlite");

  assert.throws(() => importDatabaseIfPresent(target, incoming));
  const current = new DatabaseSync(target, { readOnly: true });
  const currentUser = current.prepare("SELECT telegram_id FROM users").get() as {
    telegram_id: number;
  };
  assert.equal(currentUser.telegram_id, 1);
  current.close();
});
