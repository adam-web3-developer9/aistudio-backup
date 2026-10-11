import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Authentication migrations run first. Domain migrations never touch channel data. */
export function openSystemDatabase(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  return db;
}

export function migrateSystemDatabase(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS system_accounts (
        user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
        disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
        ever_activated INTEGER NOT NULL DEFAULT 0 CHECK(ever_activated IN (0,1)),
        valid_until TEXT,
        sharing_eligible INTEGER NOT NULL DEFAULT 0 CHECK(sharing_eligible IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS system_administrators (
        user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('superadmin','operator','readonly')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS system_activation_codes (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL UNIQUE,
        validity_days INTEGER NOT NULL DEFAULT 365 CHECK(validity_days BETWEEN 1 AND 3650),
        redeem_before TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES user(id),
        note TEXT NOT NULL DEFAULT '',
        revoked_at TEXT,
        redeemed_at TEXT,
        redeemed_by TEXT REFERENCES user(id)
      );
      CREATE TABLE IF NOT EXISTS system_activation_receipts (
        id TEXT PRIMARY KEY,
        code_id TEXT NOT NULL UNIQUE REFERENCES system_activation_codes(id),
        user_id TEXT NOT NULL REFERENCES user(id),
        redeemed_at TEXT NOT NULL,
        valid_until TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS system_receipts_user ON system_activation_receipts(user_id);
      CREATE TABLE IF NOT EXISTS system_audit (
        id TEXT PRIMARY KEY,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS system_audit_created ON system_audit(created_at);
      INSERT OR IGNORE INTO system_accounts(user_id) SELECT id FROM user;
      CREATE TRIGGER IF NOT EXISTS system_create_account AFTER INSERT ON user
        BEGIN INSERT OR IGNORE INTO system_accounts(user_id) VALUES(NEW.id); END;
      INSERT OR IGNORE INTO system_schema_migrations(version,applied_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
  }).immediate();
}
