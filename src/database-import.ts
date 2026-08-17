import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_TABLES = ["users", "payments", "processed_updates"] as const;

export interface DatabaseImportResult {
  backupPath?: string;
  imported: boolean;
  payments: number;
  users: number;
}

function databaseStats(path: string): Pick<DatabaseImportResult, "payments" | "users"> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`Проверка SQLite не пройдена: ${String(integrity?.integrity_check)}`);
    }
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`В импортируемой базе нет таблиц: ${missing.join(", ")}`);
    const users = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    const payments = db.prepare("SELECT COUNT(*) AS count FROM payments").get() as { count: number };
    return { users: Number(users.count), payments: Number(payments.count) };
  } finally {
    db.close();
  }
}

export function importDatabaseIfPresent(
  targetPath: string,
  importPath?: string,
): DatabaseImportResult {
  if (!importPath?.trim()) return { imported: false, users: 0, payments: 0 };

  const target = resolve(targetPath);
  const incoming = resolve(importPath);
  if (target === incoming) throw new Error("DATABASE_IMPORT_PATH совпадает с DATABASE_PATH");
  if (!existsSync(incoming)) return { imported: false, users: 0, payments: 0 };

  const stats = databaseStats(incoming);
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.importing`;
  if (existsSync(staging)) unlinkSync(staging);
  copyFileSync(incoming, staging);
  databaseStats(staging);

  let backupPath: string | undefined;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const movedFiles: Array<{ backup: string; original: string }> = [];
  const consumedImport = `${incoming}.imported-${stamp}`;
  let importWasConsumed = false;

  try {
    renameSync(incoming, consumedImport);
    importWasConsumed = true;

    if (existsSync(target)) {
      backupPath = `${target}.backup-${stamp}`;
      renameSync(target, backupPath);
      movedFiles.push({ backup: backupPath, original: target });

      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${target}${suffix}`;
        if (existsSync(sidecar)) {
          const backupSidecar = `${backupPath}${suffix}`;
          renameSync(sidecar, backupSidecar);
          movedFiles.push({ backup: backupSidecar, original: sidecar });
        }
      }
    }

    renameSync(staging, target);
  } catch (error) {
    if (existsSync(staging)) unlinkSync(staging);
    for (const file of movedFiles.reverse()) {
      if (existsSync(file.backup) && !existsSync(file.original)) {
        renameSync(file.backup, file.original);
      }
    }
    if (importWasConsumed && existsSync(consumedImport) && !existsSync(incoming)) {
      renameSync(consumedImport, incoming);
    }
    throw error;
  }

  try {
    unlinkSync(consumedImport);
  } catch (error) {
    console.warn(`Не удалось удалить использованный файл импорта ${consumedImport}`, error);
  }

  return backupPath
    ? { ...stats, backupPath, imported: true }
    : { ...stats, imported: true };
}
