use anyhow::Result;
use rusqlite::Connection;

pub fn apply(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          email TEXT NOT NULL,
          balance_warning REAL NOT NULL,
          last_login_at TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS credentials (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          password TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          access_token TEXT NULL,
          refresh_token TEXT NULL,
          token_type TEXT NULL,
          cookie_jar_json TEXT NULL,
          saved_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_snapshots (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL,
          snapshot_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_history (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          usage_id TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          is_latest INTEGER NOT NULL,
          row_json TEXT NOT NULL,
          PRIMARY KEY (account_id, usage_id, first_seen_at)
        );
        "#,
    )?;

    Ok(())
}
