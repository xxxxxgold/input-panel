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

        CREATE TABLE IF NOT EXISTS task_runs (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          scope TEXT NOT NULL DEFAULT 'full',
          primary_trigger_source TEXT NOT NULL,
          status TEXT NOT NULL,
          join_count INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NULL,
          error_message TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS account_profile_cache (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_platform_quota_cache (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_subscription_cache (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          subscription_id TEXT NOT NULL,
          row_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, subscription_id)
        );

        CREATE TABLE IF NOT EXISTS account_subscription_summary_cache (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_group_cache (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          group_id INTEGER NOT NULL,
          row_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, group_id)
        );

        CREATE TABLE IF NOT EXISTS account_key_cache (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          key_id TEXT NOT NULL,
          row_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (account_id, key_id)
        );

        CREATE TABLE IF NOT EXISTS account_usage_row_cache (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          usage_id TEXT NOT NULL,
          api_key_id INTEGER NULL,
          occurred_at TEXT NOT NULL,
          row_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (account_id, usage_id, occurred_at)
        );

        CREATE TABLE IF NOT EXISTS account_sync_status (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          state TEXT NOT NULL,
          last_attempt_at TEXT NULL,
          last_success_at TEXT NULL,
          last_error TEXT NULL,
          item_count INTEGER NOT NULL,
          PRIMARY KEY (account_id, scope)
        );

        CREATE INDEX IF NOT EXISTS idx_account_subscription_cache_account_updated
          ON account_subscription_cache(account_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_group_cache_account_updated
          ON account_group_cache(account_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_key_cache_account_updated
          ON account_key_cache(account_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_occurred
          ON account_usage_row_cache(account_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_account_sync_status_account_scope
          ON account_sync_status(account_id, scope);
        "#,
    )?;

    ensure_task_runs_scope_column(conn)?;
    ensure_account_usage_row_cache_api_key_id_column(conn)?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_occurred
         ON account_usage_row_cache(account_id, api_key_id, occurred_at DESC)",
        [],
    )?;

    Ok(())
}

fn ensure_task_runs_scope_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(task_runs)")?;
    let has_scope = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|value| value.ok())
        .any(|name| name == "scope");
    if has_scope {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE task_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'",
        [],
    )?;
    Ok(())
}

fn ensure_account_usage_row_cache_api_key_id_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(account_usage_row_cache)")?;
    let has_column = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|value| value.ok())
        .any(|name| name == "api_key_id");
    if has_column {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE account_usage_row_cache ADD COLUMN api_key_id INTEGER NULL",
        [],
    )?;
    conn.execute(
        "UPDATE account_usage_row_cache
         SET api_key_id = json_extract(row_json, '$.apiKeyId')
         WHERE api_key_id IS NULL",
        [],
    )?;
    Ok(())
}
