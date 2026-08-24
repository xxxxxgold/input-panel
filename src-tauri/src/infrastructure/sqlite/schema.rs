use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::Connection;

use crate::contracts::{SubscriptionSwitchChainNode, SubscriptionSwitchThresholdMode};
use crate::infrastructure::datetime::normalize_storage_timestamp;

const STORAGE_TIMESTAMP_SCHEMA_VERSION: i64 = 1;
const USAGE_ROLLUP_SCHEMA_VERSION: i64 = 2;
const USAGE_USER_AGENT_FTS_SCHEMA_VERSION: i64 = 3;
const CURRENT_USER_VERSION: i64 = USAGE_USER_AGENT_FTS_SCHEMA_VERSION;
const USAGE_USER_AGENT_FTS_TABLE: &str = "account_usage_user_agent_fts";
const USAGE_USER_AGENT_FTS_TABLE_SQL: &str =
    "CREATE VIRTUAL TABLE IF NOT EXISTS account_usage_user_agent_fts USING fts5(
       user_agent,
       content='account_usage_row_cache',
       content_rowid='rowid'
     );";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnContract {
    name: String,
    sql_type: String,
    not_null: bool,
    default_value: Option<String>,
    primary_key_position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ForeignKeyContract {
    from: String,
    referenced_table: String,
    referenced_column: String,
    on_update: String,
    on_delete: String,
    match_name: String,
}

#[derive(Debug, Clone)]
struct TableContract {
    name: String,
    columns: Vec<ColumnContract>,
    foreign_keys: HashSet<ForeignKeyContract>,
}

pub fn apply(conn: &mut Connection) -> Result<()> {
    ensure_supported_user_version(conn)?;
    let usage_user_agent_fts_was_missing = !table_exists(conn, USAGE_USER_AGENT_FTS_TABLE)?;
    create_current_tables(conn)?;
    migrate_site_retry_count_semantics(conn)?;
    migrate_legacy_subscription_switch_rules(conn)?;
    ensure_subscription_switch_rule_chain_nodes(conn)?;
    let usage_cache_was_rebuilt = ensure_account_usage_row_cache_columns(conn)?;
    ensure_account_usage_history_state_columns(conn)?;
    ensure_schema_contract(conn)?;
    migrate_storage_timestamps(conn)?;
    // 触发器必须在所有可能重建用量表的迁移之后创建，否则会随旧表一起被 DROP。
    ensure_usage_rollup_triggers(conn)?;
    backfill_usage_daily_rollup(conn)?;
    backfill_usage_user_agent_fts(
        conn,
        usage_user_agent_fts_was_missing || usage_cache_was_rebuilt,
    )?;
    ensure_current_indexes(conn)?;
    super::schema_metadata::sync(conn)?;
    verify_current_indexes(conn)?;
    verify_usage_rollup_triggers(conn)?;
    verify_usage_user_agent_fts_table(conn)?;
    super::schema_metadata::verify(conn, false)?;
    conn.execute_batch("PRAGMA optimize")?;
    Ok(())
}

/// 现役建表 DDL 的唯一入口，同时用于空库初始化和运行时结构契约生成。
fn create_current_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS schema_table_metadata (
          table_name TEXT PRIMARY KEY,
          description_zh TEXT NOT NULL,
          schema_revision INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_column_metadata (
          table_name TEXT NOT NULL REFERENCES schema_table_metadata(table_name) ON DELETE CASCADE,
          column_name TEXT NOT NULL,
          description_zh TEXT NOT NULL,
          schema_revision INTEGER NOT NULL,
          PRIMARY KEY (table_name, column_name)
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          failover_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
          retry_count_per_address INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS site_fallback_base_urls (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
          base_url TEXT NOT NULL,
          PRIMARY KEY (site_id, position)
        );

        CREATE TABLE IF NOT EXISTS site_public_endpoint_cache (
          site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
          api_base_url TEXT NOT NULL,
          custom_endpoints_json TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS codex_radar_iq_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          source_updated_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS codex_radar_intelligence_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          source_updated_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS codex_radar_fast_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          source_updated_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS codex_radar_insights_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload_json TEXT NOT NULL,
          source_updated_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          last_error TEXT NULL
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

        CREATE TABLE IF NOT EXISTS account_alert_preferences (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          subscription_quota_alerts_enabled INTEGER NOT NULL DEFAULT 1
            CHECK (subscription_quota_alerts_enabled IN (0, 1)),
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

        CREATE TABLE IF NOT EXISTS account_key_subscription_switch_rules (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          key_id TEXT NOT NULL,
          source_group_id INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          candidate_group_ids_json TEXT NOT NULL,
          chain_nodes_json TEXT NOT NULL DEFAULT '[]',
          auto_restore INTEGER NOT NULL,
          strict_mode INTEGER NOT NULL DEFAULT 0,
          threshold_mode TEXT NOT NULL,
          threshold_value REAL NOT NULL,
          runtime_state TEXT NOT NULL,
          active_target_group_id INTEGER NULL,
          last_trigger_reason TEXT NULL,
          last_switched_at TEXT NULL,
          last_restored_at TEXT NULL,
          last_error TEXT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, key_id)
        );

        CREATE TABLE IF NOT EXISTS usage_notification_outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          id TEXT NOT NULL UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subscription_quota_alert_subjects (
          subject_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          subscription_key TEXT NOT NULL,
          identity_kind TEXT NOT NULL CHECK (identity_kind IN ('group', 'upstream', 'fallback')),
          group_id INTEGER NULL,
          upstream_subscription_id TEXT NULL,
          fallback_identity TEXT NULL,
          name_snapshot TEXT NOT NULL,
          platform_snapshot TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (account_id, subscription_key)
        );

        CREATE TABLE IF NOT EXISTS subscription_quota_alert_configs (
          subject_id TEXT PRIMARY KEY REFERENCES subscription_quota_alert_subjects(subject_id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          threshold_mode TEXT NOT NULL CHECK (threshold_mode IN ('amount_usd', 'usage_percent')),
          threshold_value REAL NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subscription_quota_alert_window_states (
          subject_id TEXT NOT NULL REFERENCES subscription_quota_alert_subjects(subject_id) ON DELETE CASCADE,
          window_kind TEXT NOT NULL CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
          config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
          period_key TEXT NULL,
          state TEXT NOT NULL CHECK (state IN ('armed', 'triggered')),
          trigger_sequence INTEGER NOT NULL DEFAULT 0 CHECK (trigger_sequence >= 0),
          last_current REAL NULL,
          last_limit REAL NULL,
          last_event_id TEXT NULL,
          last_evaluated_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (subject_id, window_kind)
        );

        CREATE TABLE IF NOT EXISTS subscription_quota_alert_events (
          id TEXT PRIMARY KEY,
          subject_id TEXT NOT NULL REFERENCES subscription_quota_alert_subjects(subject_id) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL UNIQUE,
          config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
          triggered_windows_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          business_status TEXT NOT NULL CHECK (business_status IN ('pending', 'delivering', 'sent', 'unsupported')),
          windows_status TEXT NOT NULL CHECK (windows_status IN ('pending', 'delivering', 'sent', 'unsupported')),
          business_attempts INTEGER NOT NULL DEFAULT 0 CHECK (business_attempts >= 0),
          windows_attempts INTEGER NOT NULL DEFAULT 0 CHECK (windows_attempts >= 0),
          business_next_attempt_at TEXT NULL,
          windows_next_attempt_at TEXT NULL,
          business_lease_id TEXT NULL,
          windows_lease_id TEXT NULL,
          business_lease_until TEXT NULL,
          windows_lease_until TEXT NULL,
          business_last_error TEXT NULL,
          windows_last_error TEXT NULL,
          created_at TEXT NOT NULL,
          business_sent_at TEXT NULL,
          windows_sent_at TEXT NULL,
          completed_at TEXT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_usage_history_states (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK (state IN ('pending', 'backfilling', 'needs_audit', 'converged', 'degraded')),
          earliest_date TEXT NULL,
          completed_through_date TEXT NULL,
          active_date TEXT NULL,
          audit_cursor_date TEXT NULL,
          recent_reconciled_at TEXT NULL,
          last_startup_recent_four_day_read_date TEXT NULL,
          heartbeat_at TEXT NULL,
          last_error TEXT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_usage_daily_rollup (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          usage_date TEXT NOT NULL,
          model TEXT NOT NULL,
          platform TEXT NOT NULL,
          requests INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          actual_cost REAL NOT NULL DEFAULT 0,
          duration_ms_sum INTEGER NOT NULL DEFAULT 0,
          duration_ms_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (account_id, usage_date, model, platform)
        );
        "#,
    )?;

    create_account_usage_row_cache_table(conn, "account_usage_row_cache", true)?;
    conn.execute_batch(USAGE_USER_AGENT_FTS_TABLE_SQL)?;
    Ok(())
}

struct IndexContract {
    name: &'static str,
    sql: &'static str,
}

const CURRENT_INDEXES: &[IndexContract] = &[
    IndexContract {
        name: "idx_site_fallback_base_urls_site_url",
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_site_fallback_base_urls_site_url
              ON site_fallback_base_urls(site_id, base_url)",
    },
    IndexContract {
        name: "idx_account_key_subscription_switch_rules_account_updated",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_key_subscription_switch_rules_account_updated
              ON account_key_subscription_switch_rules(account_id, updated_at DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_occurred",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_occurred
              ON account_usage_row_cache(account_id, occurred_at DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_key_occurred",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_occurred
              ON account_usage_row_cache(account_id, api_key_id, occurred_at DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_occurred_usage",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_occurred_usage
              ON account_usage_row_cache(account_id, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_updated",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_updated
              ON account_usage_row_cache(account_id, updated_at DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_key_occurred_usage",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_occurred_usage
              ON account_usage_row_cache(account_id, api_key_id, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_input_tokens",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_input_tokens
              ON account_usage_row_cache(account_id, input_tokens DESC, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_output_tokens",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_output_tokens
              ON account_usage_row_cache(account_id, output_tokens DESC, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_first_token_ms",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_first_token_ms
              ON account_usage_row_cache(account_id, first_token_ms DESC, occurred_at DESC, usage_id DESC)
              WHERE first_token_ms IS NOT NULL",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_key_input_tokens",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_input_tokens
              ON account_usage_row_cache(account_id, api_key_id, input_tokens DESC, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_key_output_tokens",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_output_tokens
              ON account_usage_row_cache(account_id, api_key_id, output_tokens DESC, occurred_at DESC, usage_id DESC)",
    },
    IndexContract {
        name: "idx_account_usage_row_cache_account_key_first_token_ms",
        sql: "CREATE INDEX IF NOT EXISTS idx_account_usage_row_cache_account_key_first_token_ms
              ON account_usage_row_cache(account_id, api_key_id, first_token_ms DESC, occurred_at DESC, usage_id DESC)
              WHERE first_token_ms IS NOT NULL",
    },
    IndexContract {
        name: "idx_usage_notification_outbox_sequence",
        sql: "CREATE INDEX IF NOT EXISTS idx_usage_notification_outbox_sequence
              ON usage_notification_outbox(sequence ASC)",
    },
    IndexContract {
        name: "idx_subscription_quota_alert_subjects_account_aliases",
        sql: "CREATE INDEX IF NOT EXISTS idx_subscription_quota_alert_subjects_account_aliases
              ON subscription_quota_alert_subjects(
                account_id, group_id, upstream_subscription_id, fallback_identity
              )",
    },
    IndexContract {
        name: "idx_subscription_quota_alert_events_delivery",
        sql: "CREATE INDEX IF NOT EXISTS idx_subscription_quota_alert_events_delivery
              ON subscription_quota_alert_events(
                completed_at, business_status, business_next_attempt_at,
                windows_status, windows_next_attempt_at, created_at
              )",
    },
];

fn ensure_current_indexes(conn: &Connection) -> Result<()> {
    for index in CURRENT_INDEXES {
        conn.execute(index.sql, [])?;
    }
    Ok(())
}

struct TriggerContract {
    name: &'static str,
    sql: &'static str,
}

/// 用量明细写路径统一经触发器维护每日汇总，任何 INSERT/UPDATE/DELETE 都无需应用层配合。
const CURRENT_TRIGGERS: &[TriggerContract] = &[
    TriggerContract {
        name: "trg_usage_rollup_insert",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_insert
              AFTER INSERT ON account_usage_row_cache
              BEGIN
                INSERT INTO account_usage_daily_rollup (
                  account_id, usage_date, model, platform,
                  requests, input_tokens, output_tokens,
                  cache_creation_tokens, cache_read_tokens,
                  total_cost, actual_cost, duration_ms_sum, duration_ms_count
                ) VALUES (
                  NEW.account_id,
                  substr(NEW.occurred_at, 1, 10),
                  COALESCE(NULLIF(NEW.model, ''), 'unknown'),
                  COALESCE(NULLIF(NEW.platform, ''), 'unknown'),
                  1,
                  NEW.input_tokens,
                  NEW.output_tokens,
                  COALESCE(NEW.cache_creation_tokens, 0),
                  COALESCE(NEW.cache_read_tokens, 0),
                  NEW.total_cost,
                  NEW.actual_cost,
                  COALESCE(NEW.duration_ms, 0),
                  CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END
                )
                ON CONFLICT(account_id, usage_date, model, platform) DO UPDATE SET
                  requests = requests + 1,
                  input_tokens = input_tokens + excluded.input_tokens,
                  output_tokens = output_tokens + excluded.output_tokens,
                  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
                  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                  total_cost = total_cost + excluded.total_cost,
                  actual_cost = actual_cost + excluded.actual_cost,
                  duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum,
                  duration_ms_count = duration_ms_count + excluded.duration_ms_count;
              END",
    },
    TriggerContract {
        name: "trg_usage_rollup_update",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_update
              AFTER UPDATE ON account_usage_row_cache
              BEGIN
                UPDATE account_usage_daily_rollup SET
                  requests = requests - 1,
                  input_tokens = input_tokens - OLD.input_tokens,
                  output_tokens = output_tokens - OLD.output_tokens,
                  cache_creation_tokens = cache_creation_tokens - COALESCE(OLD.cache_creation_tokens, 0),
                  cache_read_tokens = cache_read_tokens - COALESCE(OLD.cache_read_tokens, 0),
                  total_cost = total_cost - OLD.total_cost,
                  actual_cost = actual_cost - OLD.actual_cost,
                  duration_ms_sum = duration_ms_sum - COALESCE(OLD.duration_ms, 0),
                  duration_ms_count = duration_ms_count - CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END
                WHERE account_id = OLD.account_id
                  AND usage_date = substr(OLD.occurred_at, 1, 10)
                  AND model = COALESCE(NULLIF(OLD.model, ''), 'unknown')
                  AND platform = COALESCE(NULLIF(OLD.platform, ''), 'unknown');
                DELETE FROM account_usage_daily_rollup
                WHERE account_id = OLD.account_id
                  AND usage_date = substr(OLD.occurred_at, 1, 10)
                  AND model = COALESCE(NULLIF(OLD.model, ''), 'unknown')
                  AND platform = COALESCE(NULLIF(OLD.platform, ''), 'unknown')
                  AND requests <= 0;
                INSERT INTO account_usage_daily_rollup (
                  account_id, usage_date, model, platform,
                  requests, input_tokens, output_tokens,
                  cache_creation_tokens, cache_read_tokens,
                  total_cost, actual_cost, duration_ms_sum, duration_ms_count
                ) VALUES (
                  NEW.account_id,
                  substr(NEW.occurred_at, 1, 10),
                  COALESCE(NULLIF(NEW.model, ''), 'unknown'),
                  COALESCE(NULLIF(NEW.platform, ''), 'unknown'),
                  1,
                  NEW.input_tokens,
                  NEW.output_tokens,
                  COALESCE(NEW.cache_creation_tokens, 0),
                  COALESCE(NEW.cache_read_tokens, 0),
                  NEW.total_cost,
                  NEW.actual_cost,
                  COALESCE(NEW.duration_ms, 0),
                  CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END
                )
                ON CONFLICT(account_id, usage_date, model, platform) DO UPDATE SET
                  requests = requests + 1,
                  input_tokens = input_tokens + excluded.input_tokens,
                  output_tokens = output_tokens + excluded.output_tokens,
                  cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
                  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                  total_cost = total_cost + excluded.total_cost,
                  actual_cost = actual_cost + excluded.actual_cost,
                  duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum,
                  duration_ms_count = duration_ms_count + excluded.duration_ms_count;
              END",
    },
    TriggerContract {
        name: "trg_usage_rollup_delete",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_delete
              AFTER DELETE ON account_usage_row_cache
              BEGIN
                UPDATE account_usage_daily_rollup SET
                  requests = requests - 1,
                  input_tokens = input_tokens - OLD.input_tokens,
                  output_tokens = output_tokens - OLD.output_tokens,
                  cache_creation_tokens = cache_creation_tokens - COALESCE(OLD.cache_creation_tokens, 0),
                  cache_read_tokens = cache_read_tokens - COALESCE(OLD.cache_read_tokens, 0),
                  total_cost = total_cost - OLD.total_cost,
                  actual_cost = actual_cost - OLD.actual_cost,
                  duration_ms_sum = duration_ms_sum - COALESCE(OLD.duration_ms, 0),
                  duration_ms_count = duration_ms_count - CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END
                WHERE account_id = OLD.account_id
                  AND usage_date = substr(OLD.occurred_at, 1, 10)
                  AND model = COALESCE(NULLIF(OLD.model, ''), 'unknown')
                  AND platform = COALESCE(NULLIF(OLD.platform, ''), 'unknown');
                DELETE FROM account_usage_daily_rollup
                WHERE account_id = OLD.account_id
                  AND usage_date = substr(OLD.occurred_at, 1, 10)
                  AND model = COALESCE(NULLIF(OLD.model, ''), 'unknown')
                  AND platform = COALESCE(NULLIF(OLD.platform, ''), 'unknown')
                  AND requests <= 0;
              END",
    },
    TriggerContract {
        name: "trg_usage_user_agent_fts_insert",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_user_agent_fts_insert
              AFTER INSERT ON account_usage_row_cache
              BEGIN
                INSERT INTO account_usage_user_agent_fts(rowid, user_agent)
                VALUES (NEW.rowid, NEW.user_agent);
              END",
    },
    TriggerContract {
        name: "trg_usage_user_agent_fts_update",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_user_agent_fts_update
              AFTER UPDATE OF user_agent ON account_usage_row_cache
              BEGIN
                INSERT INTO account_usage_user_agent_fts(
                  account_usage_user_agent_fts, rowid, user_agent
                ) VALUES ('delete', OLD.rowid, OLD.user_agent);
                INSERT INTO account_usage_user_agent_fts(rowid, user_agent)
                VALUES (NEW.rowid, NEW.user_agent);
              END",
    },
    TriggerContract {
        name: "trg_usage_user_agent_fts_delete",
        sql: "CREATE TRIGGER IF NOT EXISTS trg_usage_user_agent_fts_delete
              AFTER DELETE ON account_usage_row_cache
              BEGIN
                INSERT INTO account_usage_user_agent_fts(
                  account_usage_user_agent_fts, rowid, user_agent
                ) VALUES ('delete', OLD.rowid, OLD.user_agent);
              END",
    },
];

fn ensure_usage_rollup_triggers(conn: &Connection) -> Result<()> {
    for trigger in CURRENT_TRIGGERS {
        conn.execute_batch(trigger.sql)?;
    }
    Ok(())
}

fn verify_usage_rollup_triggers(conn: &Connection) -> Result<()> {
    let actual = {
        let mut stmt = conn.prepare(
            "SELECT name, sql FROM sqlite_master
             WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let mut definitions = HashMap::new();
        for row in rows {
            let (name, sql) = row?;
            let sql = sql.with_context(|| format!("触发器 {name} 缺少可校验定义"))?;
            definitions.insert(name, sql);
        }
        definitions
    };
    let expected_names = CURRENT_TRIGGERS
        .iter()
        .map(|trigger| trigger.name.to_string())
        .collect::<HashSet<_>>();
    let actual_names = actual.keys().cloned().collect::<HashSet<_>>();
    if !expected_names.is_subset(&actual_names) {
        bail!(
            "数据库缺少现役触发器: 期望至少包含 {:?}, 实际 {:?}",
            expected_names,
            actual_names
        );
    }
    for expected in CURRENT_TRIGGERS {
        let actual_sql = actual
            .get(expected.name)
            .with_context(|| format!("数据库结构不完整：缺少触发器 {}", expected.name))?;
        if normalize_trigger_sql(actual_sql) != normalize_trigger_sql(expected.sql) {
            bail!("数据库触发器定义不一致：{}", expected.name);
        }
    }
    Ok(())
}

fn normalize_trigger_sql(sql: &str) -> String {
    sql.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(';')
        .to_ascii_lowercase()
        .replacen("create trigger if not exists ", "create trigger ", 1)
}

fn verify_usage_user_agent_fts_table(conn: &Connection) -> Result<()> {
    let table_type: String = conn
        .query_row(
            "SELECT type FROM pragma_table_list
             WHERE schema = 'main' AND name = ?1",
            [USAGE_USER_AGENT_FTS_TABLE],
            |row| row.get(0),
        )
        .context("数据库结构不完整：缺少 Usage User-Agent FTS5 虚拟表")?;

    if table_type != "virtual" {
        bail!("数据库结构不一致：Usage User-Agent FTS5 必须是虚拟表");
    }

    let actual_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [USAGE_USER_AGENT_FTS_TABLE],
            |row| row.get(0),
        )
        .context("数据库结构不完整：Usage User-Agent FTS5 缺少建表定义")?;

    if normalize_virtual_table_sql(&actual_sql)
        != normalize_virtual_table_sql(USAGE_USER_AGENT_FTS_TABLE_SQL)
    {
        bail!("数据库结构不一致：Usage User-Agent FTS5 建表定义不符合当前版本");
    }

    Ok(())
}

fn normalize_virtual_table_sql(sql: &str) -> String {
    sql.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(';')
        .to_ascii_lowercase()
        .replacen(
            "create virtual table if not exists ",
            "create virtual table ",
            1,
        )
}

/// 存量明细一次性重算每日汇总；user_version 达标后跳过，保证幂等。
fn backfill_usage_daily_rollup(conn: &mut Connection) -> Result<()> {
    let current_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version >= USAGE_ROLLUP_SCHEMA_VERSION {
        let has_detail_rows: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_usage_row_cache)",
            [],
            |row| row.get(0),
        )?;
        let has_rollup_rows: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_usage_daily_rollup)",
            [],
            |row| row.get(0),
        )?;
        // 回填事务会与 user_version=2 一起提交，已完成的库不应每次启动再扫描全部历史明细。
        if !needs_usage_rollup_backfill(current_version, has_detail_rows, has_rollup_rows) {
            return Ok(());
        }
    }

    let tx = conn.transaction().context("无法开始用量汇总回填事务")?;
    tx.execute("DELETE FROM account_usage_daily_rollup", [])?;
    tx.execute(
        "INSERT INTO account_usage_daily_rollup (
            account_id, usage_date, model, platform,
            requests, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens,
            total_cost, actual_cost, duration_ms_sum, duration_ms_count
         )
         SELECT
            account_id,
            substr(occurred_at, 1, 10),
            COALESCE(NULLIF(model, ''), 'unknown'),
            COALESCE(NULLIF(platform, ''), 'unknown'),
            COUNT(*),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0),
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0),
            COALESCE(SUM(total_cost), 0),
            COALESCE(SUM(actual_cost), 0),
            COALESCE(SUM(COALESCE(duration_ms, 0)), 0),
            COALESCE(SUM(CASE WHEN duration_ms IS NULL THEN 0 ELSE 1 END), 0)
         FROM account_usage_row_cache
         GROUP BY
            account_id,
            substr(occurred_at, 1, 10),
            COALESCE(NULLIF(model, ''), 'unknown'),
            COALESCE(NULLIF(platform, ''), 'unknown')",
        [],
    )?;
    tx.pragma_update(
        None,
        "user_version",
        current_version.max(USAGE_ROLLUP_SCHEMA_VERSION),
    )?;
    tx.commit().context("无法提交用量汇总回填事务")?;
    Ok(())
}

fn needs_usage_rollup_backfill(
    current_version: i64,
    has_detail_rows: bool,
    has_rollup_rows: bool,
) -> bool {
    current_version < USAGE_ROLLUP_SCHEMA_VERSION || (has_detail_rows && !has_rollup_rows)
}

/// 旧库只在升级到版本 3 时重建一次 FTS，避免每次启动扫描全部历史用量。
fn backfill_usage_user_agent_fts(conn: &mut Connection, force_rebuild: bool) -> Result<()> {
    let current_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version >= USAGE_USER_AGENT_FTS_SCHEMA_VERSION && !force_rebuild {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .context("无法开始 Usage User-Agent FTS 回填事务")?;
    tx.execute(
        "INSERT INTO account_usage_user_agent_fts(account_usage_user_agent_fts)
         VALUES ('rebuild')",
        [],
    )?;
    tx.pragma_update(
        None,
        "user_version",
        current_version.max(USAGE_USER_AGENT_FTS_SCHEMA_VERSION),
    )?;
    tx.commit()
        .context("无法提交 Usage User-Agent FTS 回填事务")?;
    Ok(())
}

fn verify_current_indexes(conn: &Connection) -> Result<()> {
    let actual = {
        let mut stmt = conn.prepare(
            "SELECT name, sql FROM sqlite_master
             WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let mut definitions = HashMap::new();
        for row in rows {
            let (name, sql) = row?;
            let sql = sql.with_context(|| format!("索引 {name} 缺少可校验定义"))?;
            definitions.insert(name, sql);
        }
        definitions
    };
    let expected_names = CURRENT_INDEXES
        .iter()
        .map(|index| index.name.to_string())
        .collect::<HashSet<_>>();
    let actual_names = actual.keys().cloned().collect::<HashSet<_>>();
    if actual_names != expected_names {
        bail!(
            "数据库索引集合不一致: 期望 {:?}, 实际 {:?}",
            expected_names,
            actual_names
        );
    }
    for expected in CURRENT_INDEXES {
        let actual_sql = actual
            .get(expected.name)
            .with_context(|| format!("数据库结构不完整：缺少索引 {}", expected.name))?;
        if normalize_index_sql(actual_sql) != normalize_index_sql(expected.sql) {
            bail!("数据库索引定义不一致：{}", expected.name);
        }
    }
    Ok(())
}

fn normalize_index_sql(sql: &str) -> String {
    let normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(';')
        .to_ascii_lowercase();
    normalized
        .replacen(
            "create unique index if not exists ",
            "create unique index ",
            1,
        )
        .replacen("create index if not exists ", "create index ", 1)
}

/// 校验现役表字段与外键，安全的新增字段使用 canonical DDL 自动追加。
fn ensure_schema_contract(conn: &Connection) -> Result<()> {
    for table in build_canonical_schema_contract()? {
        ensure_table_matches_contract(conn, &table)?;
    }
    Ok(())
}

fn build_canonical_schema_contract() -> Result<Vec<TableContract>> {
    let canonical = Connection::open_in_memory().context("无法创建 SQLite schema 校验内存库")?;
    create_current_tables(&canonical)?;

    let mut stmt = canonical.prepare(
        "SELECT name FROM pragma_table_list
         WHERE schema = 'main'
           AND type IN ('table', 'virtual')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )?;
    let table_rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut table_names = Vec::new();
    for row in table_rows {
        table_names.push(row?);
    }
    drop(stmt);

    table_names
        .into_iter()
        .map(|name| {
            Ok(TableContract {
                columns: load_table_column_contracts(&canonical, &name)?,
                foreign_keys: load_foreign_key_contracts(&canonical, &name)?,
                name,
            })
        })
        .collect()
}

fn ensure_table_matches_contract(conn: &Connection, expected: &TableContract) -> Result<()> {
    if !table_exists(conn, &expected.name)? {
        bail!("数据库结构不完整：缺少数据表 {}", expected.name);
    }

    let foreign_key_columns = expected
        .foreign_keys
        .iter()
        .map(|foreign_key| foreign_key.from.as_str())
        .collect::<HashSet<_>>();
    let actual_columns = load_table_column_contracts(conn, &expected.name)?;
    let actual_by_name = actual_columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<HashMap<_, _>>();

    for expected_column in &expected.columns {
        if actual_by_name.contains_key(expected_column.name.as_str()) {
            continue;
        }

        if !can_safely_add_column(expected_column, &foreign_key_columns) {
            bail!(
                "数据库结构不完整：表 {} 缺少关键字段 {}，无法在不修改既有数据的前提下自动补齐",
                expected.name,
                expected_column.name
            );
        }
        add_missing_column(conn, &expected.name, expected_column)?;
    }

    let actual_columns = load_table_column_contracts(conn, &expected.name)?;
    let actual_by_name = actual_columns
        .iter()
        .map(|column| (column.name.as_str(), column))
        .collect::<HashMap<_, _>>();
    for expected_column in &expected.columns {
        let actual_column = actual_by_name
            .get(expected_column.name.as_str())
            .ok_or_else(|| {
                anyhow!(
                    "数据库结构不完整：表 {} 缺少字段 {}",
                    expected.name,
                    expected_column.name
                )
            })?;
        ensure_column_matches_contract(&expected.name, expected_column, actual_column)?;
    }

    let actual_foreign_keys = load_foreign_key_contracts(conn, &expected.name)?;
    if actual_foreign_keys != expected.foreign_keys {
        bail!(
            "数据库结构不一致：表 {} 的外键约束不符合当前版本，无法自动修复",
            expected.name
        );
    }
    Ok(())
}

fn can_safely_add_column(column: &ColumnContract, foreign_key_columns: &HashSet<&str>) -> bool {
    let has_non_null_default = column
        .default_value
        .as_deref()
        .is_some_and(|value| !value.trim().eq_ignore_ascii_case("NULL"));
    column.primary_key_position == 0
        && !foreign_key_columns.contains(column.name.as_str())
        && (!column.not_null || has_non_null_default)
}

fn add_missing_column(conn: &Connection, table_name: &str, column: &ColumnContract) -> Result<()> {
    let mut definition = format!("{} {}", quote_identifier(&column.name), column.sql_type);
    if column.not_null {
        definition.push_str(" NOT NULL");
    }
    if let Some(default_value) = &column.default_value {
        definition.push_str(" DEFAULT ");
        definition.push_str(default_value);
    }
    let sql = format!(
        "ALTER TABLE {} ADD COLUMN {}",
        quote_identifier(table_name),
        definition
    );
    conn.execute(&sql, [])
        .with_context(|| format!("无法自动补齐表 {} 的字段 {}", table_name, column.name))?;
    Ok(())
}

fn ensure_column_matches_contract(
    table_name: &str,
    expected: &ColumnContract,
    actual: &ColumnContract,
) -> Result<()> {
    if normalize_sql_type(&actual.sql_type) != normalize_sql_type(&expected.sql_type)
        || actual.not_null != expected.not_null
        || normalize_default_value(&actual.default_value)
            != normalize_default_value(&expected.default_value)
        || actual.primary_key_position != expected.primary_key_position
    {
        bail!(
            "数据库结构不一致：表 {} 的字段 {} 定义不符合当前版本（期望 {}，实际 {}），无法自动修复",
            table_name,
            expected.name,
            format_column_contract(expected),
            format_column_contract(actual)
        );
    }
    Ok(())
}

fn load_table_column_contracts(conn: &Connection, table_name: &str) -> Result<Vec<ColumnContract>> {
    let mut stmt = conn.prepare(&format!(
        "PRAGMA table_info({})",
        quote_identifier(table_name)
    ))?;
    let rows = stmt.query_map([], |row| {
        Ok(ColumnContract {
            name: row.get(1)?,
            sql_type: row.get(2)?,
            not_null: row.get::<_, i64>(3)? != 0,
            default_value: row.get(4)?,
            primary_key_position: row.get(5)?,
        })
    })?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row?);
    }
    Ok(columns)
}

fn load_foreign_key_contracts(
    conn: &Connection,
    table_name: &str,
) -> Result<HashSet<ForeignKeyContract>> {
    let mut stmt = conn.prepare(&format!(
        "PRAGMA foreign_key_list({})",
        quote_identifier(table_name)
    ))?;
    let rows = stmt.query_map([], |row| {
        Ok(ForeignKeyContract {
            referenced_table: row.get(2)?,
            from: row.get(3)?,
            referenced_column: row
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| "<PRIMARY KEY>".to_string()),
            on_update: row.get(5)?,
            on_delete: row.get(6)?,
            match_name: row.get(7)?,
        })
    })?;
    let mut foreign_keys = HashSet::new();
    for row in rows {
        foreign_keys.insert(row?);
    }
    Ok(foreign_keys)
}

fn normalize_sql_type(sql_type: &str) -> String {
    sql_type.trim().to_ascii_uppercase()
}

fn normalize_default_value(default_value: &Option<String>) -> Option<String> {
    default_value
        .as_deref()
        .map(|value| value.trim().to_string())
}

fn format_column_contract(column: &ColumnContract) -> String {
    format!(
        "type={}, not_null={}, default={}, primary_key={}",
        normalize_sql_type(&column.sql_type),
        column.not_null,
        column.default_value.as_deref().unwrap_or("<none>"),
        column.primary_key_position
    )
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// 执行 SQLite 文件页完整性检查；损坏文件不得被启动流程静默重建。
pub fn verify_integrity(conn: &Connection) -> Result<()> {
    let result: String = conn
        .query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))
        .context("无法执行 SQLite integrity_check")?;
    if result.eq_ignore_ascii_case("ok") {
        return Ok(());
    }
    bail!("SQLite integrity_check 失败: {result}")
}

/// 检查所有外键引用，迁移目标存在孤立行时不得激活。
pub fn verify_foreign_keys(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        let row_id: Option<i64> = row.get(1)?;
        let parent: String = row.get(2)?;
        bail!(
            "SQLite foreign_key_check 失败: 表 {table}, 行 {:?}, 引用表 {parent}",
            row_id
        );
    }
    Ok(())
}

/// 校验中文结构元数据；strict=true 时拒绝任何非现役业务表。
pub fn verify_schema_documentation(conn: &Connection, strict: bool) -> Result<()> {
    verify_current_indexes(conn)?;
    verify_usage_rollup_triggers(conn)?;
    verify_usage_user_agent_fts_table(conn)?;
    super::schema_metadata::verify(conn, strict)
}

const TIMESTAMP_COLUMNS: &[(&str, &str)] = &[
    ("sites", "created_at"),
    ("sites", "updated_at"),
    ("site_public_endpoint_cache", "fetched_at"),
    ("codex_radar_iq_cache", "fetched_at"),
    ("codex_radar_intelligence_cache", "fetched_at"),
    ("codex_radar_fast_cache", "fetched_at"),
    ("codex_radar_insights_cache", "fetched_at"),
    ("accounts", "last_login_at"),
    ("accounts", "created_at"),
    ("accounts", "updated_at"),
    ("credentials", "saved_at"),
    ("sessions", "saved_at"),
    ("account_key_subscription_switch_rules", "last_switched_at"),
    ("account_key_subscription_switch_rules", "last_restored_at"),
    ("account_key_subscription_switch_rules", "updated_at"),
    ("usage_notification_outbox", "created_at"),
    ("subscription_quota_alert_subjects", "created_at"),
    ("subscription_quota_alert_subjects", "updated_at"),
    ("subscription_quota_alert_configs", "created_at"),
    ("subscription_quota_alert_configs", "updated_at"),
    (
        "subscription_quota_alert_window_states",
        "last_evaluated_at",
    ),
    ("subscription_quota_alert_window_states", "updated_at"),
    (
        "subscription_quota_alert_events",
        "business_next_attempt_at",
    ),
    ("subscription_quota_alert_events", "windows_next_attempt_at"),
    ("subscription_quota_alert_events", "business_lease_until"),
    ("subscription_quota_alert_events", "windows_lease_until"),
    ("subscription_quota_alert_events", "created_at"),
    ("subscription_quota_alert_events", "business_sent_at"),
    ("subscription_quota_alert_events", "windows_sent_at"),
    ("subscription_quota_alert_events", "completed_at"),
    ("subscription_quota_alert_events", "updated_at"),
    ("account_usage_history_states", "recent_reconciled_at"),
    ("account_usage_history_states", "heartbeat_at"),
    ("account_usage_history_states", "updated_at"),
];

const USAGE_TIMESTAMP_COLUMNS: &[&str] =
    &["occurred_at", "updated_at", "first_seen_at", "last_seen_at"];

fn ensure_supported_user_version(conn: &Connection) -> Result<()> {
    let current_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version > CURRENT_USER_VERSION {
        bail!("数据库结构版本高于当前程序支持范围。");
    }
    Ok(())
}

fn migrate_storage_timestamps(conn: &mut Connection) -> Result<()> {
    let current_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version >= STORAGE_TIMESTAMP_SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = conn.transaction().context("无法开始数据库时间迁移事务")?;
    for (table, column) in TIMESTAMP_COLUMNS {
        normalize_timestamp_column(&transaction, table, column)?;
    }
    migrate_usage_timestamp_columns(&transaction)?;
    transaction.pragma_update(None, "user_version", STORAGE_TIMESTAMP_SCHEMA_VERSION)?;
    transaction.commit().context("无法提交数据库时间迁移事务")?;
    Ok(())
}

fn normalize_timestamp_column(conn: &Connection, table: &str, column: &str) -> Result<()> {
    let sql = format!(
        "SELECT rowid, {} FROM {} WHERE {} IS NOT NULL",
        quote_identifier(column),
        quote_identifier(table),
        quote_identifier(column)
    );
    let rows = {
        let mut stmt = conn.prepare(&sql)?;
        let mapped = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut values = Vec::new();
        for row in mapped {
            values.push(row?);
        }
        values
    };
    let update = format!(
        "UPDATE {} SET {} = ?1 WHERE rowid = ?2",
        quote_identifier(table),
        quote_identifier(column)
    );
    for (row_id, value) in rows {
        let normalized = normalize_storage_timestamp(&value)
            .with_context(|| format!("无法迁移时间字段 {table}.{column}，rowid={row_id}"))?;
        if normalized != value {
            conn.execute(&update, rusqlite::params![normalized, row_id])?;
        }
    }
    Ok(())
}

fn migrate_usage_timestamp_columns(conn: &Connection) -> Result<()> {
    let columns = load_table_column_contracts(conn, "account_usage_row_cache")?
        .into_iter()
        .map(|column| column.name)
        .collect::<Vec<_>>();
    let select_sql = format!(
        "SELECT rowid, account_id, usage_id, {} FROM account_usage_row_cache",
        USAGE_TIMESTAMP_COLUMNS
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let rows = {
        let mut stmt = conn.prepare(&select_sql)?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut values = Vec::new();
        for row in mapped {
            values.push(row?);
        }
        values
    };

    let mut normalized_keys = HashSet::new();
    let mut normalized_rows = Vec::with_capacity(rows.len());
    for (row_id, account_id, usage_id, occurred_at, updated_at, first_seen_at, last_seen_at) in rows
    {
        let normalized_occurred_at =
            normalize_storage_timestamp(&occurred_at).with_context(|| {
                format!("无法迁移 account_usage_row_cache.occurred_at，rowid={row_id}")
            })?;
        if !normalized_keys.insert((
            account_id.clone(),
            usage_id.clone(),
            normalized_occurred_at.clone(),
        )) {
            bail!("用量时间降为秒精度后产生复合主键冲突，数据库时间迁移已回滚。");
        }
        normalized_rows.push((
            row_id,
            normalized_occurred_at,
            normalize_storage_timestamp(&updated_at).with_context(|| {
                format!("无法迁移 account_usage_row_cache.updated_at，rowid={row_id}")
            })?,
            normalize_storage_timestamp(&first_seen_at).with_context(|| {
                format!("无法迁移 account_usage_row_cache.first_seen_at，rowid={row_id}")
            })?,
            normalize_storage_timestamp(&last_seen_at).with_context(|| {
                format!("无法迁移 account_usage_row_cache.last_seen_at，rowid={row_id}")
            })?,
        ));
    }

    for (row_id, occurred_at, updated_at, first_seen_at, last_seen_at) in normalized_rows {
        conn.execute(
            "UPDATE account_usage_row_cache
             SET occurred_at = ?1, updated_at = ?2, first_seen_at = ?3, last_seen_at = ?4
             WHERE rowid = ?5",
            rusqlite::params![occurred_at, updated_at, first_seen_at, last_seen_at, row_id],
        )?;
    }

    conn.execute_batch(
        "ALTER TABLE account_usage_row_cache
           RENAME TO account_usage_row_cache_timestamp_source;",
    )?;
    create_account_usage_row_cache_table(conn, "account_usage_row_cache", true)?;
    let column_list = columns
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "INSERT INTO account_usage_row_cache ({column_list})
             SELECT {column_list} FROM account_usage_row_cache_timestamp_source"
        ),
        [],
    )?;
    let source_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM account_usage_row_cache_timestamp_source",
        [],
        |row| row.get(0),
    )?;
    let target_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM account_usage_row_cache", [], |row| {
            row.get(0)
        })?;
    if source_count != target_count {
        bail!("用量时间迁移前后行数不一致。");
    }
    conn.execute("DROP TABLE account_usage_row_cache_timestamp_source", [])?;
    Ok(())
}

/// 为旧规则补齐节点化链和严格模式列。旧列继续保留给旧二进制读取。
fn ensure_subscription_switch_rule_chain_nodes(conn: &Connection) -> Result<()> {
    let existing_columns = load_table_columns(conn, "account_key_subscription_switch_rules")?;
    if !existing_columns.contains("chain_nodes_json") {
        conn.execute(
            "ALTER TABLE account_key_subscription_switch_rules
             ADD COLUMN chain_nodes_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !existing_columns.contains("strict_mode") {
        conn.execute(
            "ALTER TABLE account_key_subscription_switch_rules
             ADD COLUMN strict_mode INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    let legacy_rows = {
        let mut stmt = conn.prepare(
            "SELECT account_id, key_id, source_group_id, candidate_group_ids_json, threshold_mode,
                    threshold_value, chain_nodes_json
             FROM account_key_subscription_switch_rules",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        records
    };

    for (
        account_id,
        key_id,
        source_group_id,
        candidate_group_ids_json,
        threshold_mode,
        threshold_value,
        chain_nodes_json,
    ) in legacy_rows
    {
        let has_valid_chain =
            serde_json::from_str::<Vec<SubscriptionSwitchChainNode>>(&chain_nodes_json)
                .map(|nodes| !nodes.is_empty())
                .unwrap_or(false);
        if has_valid_chain {
            continue;
        }

        let mode = match threshold_mode.as_str() {
            "amount_usd" => SubscriptionSwitchThresholdMode::AmountUsd,
            _ => SubscriptionSwitchThresholdMode::UsagePercent,
        };
        let candidate_group_ids =
            serde_json::from_str::<Vec<i64>>(&candidate_group_ids_json).unwrap_or_default();
        let chain_nodes = std::iter::once(SubscriptionSwitchChainNode {
            group_id: source_group_id,
            threshold_mode: mode.clone(),
            threshold_value,
        })
        .chain(
            candidate_group_ids
                .into_iter()
                .map(|group_id| SubscriptionSwitchChainNode {
                    group_id,
                    threshold_mode: mode.clone(),
                    threshold_value,
                }),
        )
        .collect::<Vec<_>>();
        conn.execute(
            "UPDATE account_key_subscription_switch_rules
             SET chain_nodes_json = ?1
             WHERE account_id = ?2 AND key_id = ?3",
            rusqlite::params![serde_json::to_string(&chain_nodes)?, account_id, key_id],
        )?;
    }
    Ok(())
}

fn migrate_legacy_subscription_switch_rules(conn: &mut Connection) -> Result<()> {
    if !table_exists(conn, "account_subscription_switch_rules")? {
        return Ok(());
    }

    let tx = conn.transaction()?;
    let legacy_rows = {
        let mut stmt = tx.prepare(
            "SELECT account_id, source_group_id, enabled, selected_key_ids_json, candidate_group_ids_json,
                    auto_restore, runtime_state, active_target_group_id, last_trigger_reason, last_switched_at,
                    last_restored_at, last_error, updated_at
             FROM account_subscription_switch_rules",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, String>(12)?,
            ))
        })?;

        let mut legacy_rows = Vec::new();
        for row in rows {
            legacy_rows.push(row?);
        }
        legacy_rows
    };

    if legacy_rows.is_empty() {
        tx.execute("DROP TABLE account_subscription_switch_rules", [])?;
        tx.commit()?;
        return Ok(());
    }

    for (
        account_id,
        source_group_id,
        enabled,
        selected_key_ids_json,
        candidate_group_ids_json,
        auto_restore,
        runtime_state,
        active_target_group_id,
        last_trigger_reason,
        last_switched_at,
        last_restored_at,
        last_error,
        updated_at,
    ) in legacy_rows
    {
        let selected_key_ids: Vec<String> =
            serde_json::from_str(&selected_key_ids_json).unwrap_or_default();
        for key_id in selected_key_ids {
            tx.execute(
                "INSERT INTO account_key_subscription_switch_rules (
                    account_id, key_id, source_group_id, enabled, candidate_group_ids_json, auto_restore,
                    threshold_mode, threshold_value, runtime_state, active_target_group_id, last_trigger_reason,
                    last_switched_at, last_restored_at, last_error, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'usage_percent', 100, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    account_id,
                    key_id,
                    source_group_id,
                    enabled,
                    candidate_group_ids_json,
                    auto_restore,
                    runtime_state,
                    active_target_group_id,
                    last_trigger_reason,
                    last_switched_at,
                    last_restored_at,
                    last_error,
                    updated_at,
                ],
            )?;
        }
    }
    tx.execute("DROP TABLE account_subscription_switch_rules", [])?;
    tx.commit()?;
    Ok(())
}

struct UsageCacheColumnSpec {
    name: &'static str,
    sql_type: &'static str,
    json_path: &'static str,
    fallback_sql: Option<&'static str>,
}

const ACCOUNT_USAGE_ROW_CACHE_COLUMN_SPECS: &[UsageCacheColumnSpec] = &[
    UsageCacheColumnSpec {
        name: "api_key_id",
        sql_type: "INTEGER NULL",
        json_path: "apiKeyId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "upstream_user_id",
        sql_type: "INTEGER NULL",
        json_path: "upstreamUserId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "upstream_account_id",
        sql_type: "INTEGER NULL",
        json_path: "upstreamAccountId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "request_id",
        sql_type: "TEXT NULL",
        json_path: "requestId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "model",
        sql_type: "TEXT NULL",
        json_path: "model",
        fallback_sql: Some("'unknown'"),
    },
    UsageCacheColumnSpec {
        name: "reasoning_effort",
        sql_type: "TEXT NULL",
        json_path: "reasoningEffort",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "endpoint",
        sql_type: "TEXT NULL",
        json_path: "endpoint",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "upstream_endpoint",
        sql_type: "TEXT NULL",
        json_path: "upstreamEndpoint",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "group_id",
        sql_type: "INTEGER NULL",
        json_path: "groupId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "subscription_id",
        sql_type: "INTEGER NULL",
        json_path: "subscriptionId",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "input_tokens",
        sql_type: "INTEGER NULL",
        json_path: "inputTokens",
        fallback_sql: Some("0"),
    },
    UsageCacheColumnSpec {
        name: "output_tokens",
        sql_type: "INTEGER NULL",
        json_path: "outputTokens",
        fallback_sql: Some("0"),
    },
    UsageCacheColumnSpec {
        name: "cache_creation_tokens",
        sql_type: "INTEGER NULL",
        json_path: "cacheCreationTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_read_tokens",
        sql_type: "INTEGER NULL",
        json_path: "cacheReadTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_creation_5m_tokens",
        sql_type: "INTEGER NULL",
        json_path: "cacheCreation5mTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_creation_1h_tokens",
        sql_type: "INTEGER NULL",
        json_path: "cacheCreation1hTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "input_cost",
        sql_type: "REAL NULL",
        json_path: "inputCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "output_cost",
        sql_type: "REAL NULL",
        json_path: "outputCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_creation_cost",
        sql_type: "REAL NULL",
        json_path: "cacheCreationCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_read_cost",
        sql_type: "REAL NULL",
        json_path: "cacheReadCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "total_cost",
        sql_type: "REAL NULL",
        json_path: "totalCost",
        fallback_sql: Some("0"),
    },
    UsageCacheColumnSpec {
        name: "actual_cost",
        sql_type: "REAL NULL",
        json_path: "actualCost",
        fallback_sql: Some("0"),
    },
    UsageCacheColumnSpec {
        name: "rate_multiplier",
        sql_type: "REAL NULL",
        json_path: "rateMultiplier",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "billing_type",
        sql_type: "INTEGER NULL",
        json_path: "billingType",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "service_tier",
        sql_type: "TEXT NULL",
        json_path: "serviceTier",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "long_context_billing_applied",
        sql_type: "INTEGER NULL",
        json_path: "longContextBillingApplied",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "request_type",
        sql_type: "TEXT NULL",
        json_path: "requestType",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "stream",
        sql_type: "INTEGER NULL",
        json_path: "stream",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "openai_ws_mode",
        sql_type: "INTEGER NULL",
        json_path: "openaiWsMode",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "duration_ms",
        sql_type: "INTEGER NULL",
        json_path: "durationMs",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "first_token_ms",
        sql_type: "INTEGER NULL",
        json_path: "firstTokenMs",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_count",
        sql_type: "INTEGER NULL",
        json_path: "imageCount",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_input_tokens",
        sql_type: "INTEGER NULL",
        json_path: "imageInputTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_size",
        sql_type: "TEXT NULL",
        json_path: "imageSize",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_input_size",
        sql_type: "TEXT NULL",
        json_path: "imageInputSize",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_output_size",
        sql_type: "TEXT NULL",
        json_path: "imageOutputSize",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_output_tokens",
        sql_type: "INTEGER NULL",
        json_path: "imageOutputTokens",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_input_cost",
        sql_type: "REAL NULL",
        json_path: "imageInputCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_output_cost",
        sql_type: "REAL NULL",
        json_path: "imageOutputCost",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_size_source",
        sql_type: "TEXT NULL",
        json_path: "imageSizeSource",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "image_size_breakdown",
        sql_type: "TEXT NULL",
        json_path: "imageSizeBreakdown",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "media_type",
        sql_type: "TEXT NULL",
        json_path: "mediaType",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "user_agent",
        sql_type: "TEXT NULL",
        json_path: "userAgent",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "ip_address",
        sql_type: "TEXT NULL",
        json_path: "ipAddress",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "cache_ttl_overridden",
        sql_type: "INTEGER NULL",
        json_path: "cacheTtlOverridden",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "billing_mode",
        sql_type: "TEXT NULL",
        json_path: "billingMode",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "platform",
        sql_type: "TEXT NULL",
        json_path: "platform",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "api_key_name",
        sql_type: "TEXT NULL",
        json_path: "apiKeyName",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "group_name",
        sql_type: "TEXT NULL",
        json_path: "groupName",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "subscription_name",
        sql_type: "TEXT NULL",
        json_path: "subscriptionName",
        fallback_sql: None,
    },
    UsageCacheColumnSpec {
        name: "subscription_type",
        sql_type: "TEXT NULL",
        json_path: "subscriptionType",
        fallback_sql: None,
    },
];

fn create_account_usage_row_cache_table(
    conn: &Connection,
    table_name: &str,
    if_not_exists: bool,
) -> Result<()> {
    let if_not_exists_clause = if if_not_exists { "IF NOT EXISTS " } else { "" };
    conn.execute_batch(&format!(
        r#"
        CREATE TABLE {if_not_exists_clause}{table_name} (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          usage_id TEXT NOT NULL,
          api_key_id INTEGER NULL,
          upstream_user_id INTEGER NULL,
          upstream_account_id INTEGER NULL,
          request_id TEXT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT NULL,
          endpoint TEXT NULL,
          upstream_endpoint TEXT NULL,
          group_id INTEGER NULL,
          subscription_id INTEGER NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER NULL,
          cache_read_tokens INTEGER NULL,
          cache_creation_5m_tokens INTEGER NULL,
          cache_creation_1h_tokens INTEGER NULL,
          input_cost REAL NULL,
          output_cost REAL NULL,
          cache_creation_cost REAL NULL,
          cache_read_cost REAL NULL,
          total_cost REAL NOT NULL,
          actual_cost REAL NOT NULL,
          rate_multiplier REAL NULL,
          billing_type INTEGER NULL,
          service_tier TEXT NULL,
          long_context_billing_applied INTEGER NULL,
          request_type TEXT NULL,
          stream INTEGER NULL,
          openai_ws_mode INTEGER NULL,
          duration_ms INTEGER NULL,
          first_token_ms INTEGER NULL,
          image_count INTEGER NULL,
          image_input_tokens INTEGER NULL,
          image_size TEXT NULL,
          image_input_size TEXT NULL,
          image_output_size TEXT NULL,
          image_output_tokens INTEGER NULL,
          image_input_cost REAL NULL,
          image_output_cost REAL NULL,
          image_size_source TEXT NULL,
          image_size_breakdown TEXT NULL,
          media_type TEXT NULL,
          user_agent TEXT NULL,
          ip_address TEXT NULL,
          cache_ttl_overridden INTEGER NULL,
          billing_mode TEXT NULL,
          platform TEXT NULL,
          api_key_name TEXT NULL,
          group_name TEXT NULL,
          subscription_name TEXT NULL,
          subscription_type TEXT NULL,
          occurred_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY (account_id, usage_id, occurred_at)
        );
        "#
    ))?;
    Ok(())
}

fn ensure_account_usage_row_cache_columns(conn: &mut Connection) -> Result<bool> {
    let existing_columns = load_table_columns(conn, "account_usage_row_cache")?;
    let has_row_json = existing_columns.contains("row_json");

    for spec in ACCOUNT_USAGE_ROW_CACHE_COLUMN_SPECS {
        if existing_columns.contains(spec.name) {
            continue;
        }
        conn.execute(
            &format!(
                "ALTER TABLE account_usage_row_cache ADD COLUMN {} {}",
                spec.name, spec.sql_type
            ),
            [],
        )?;
    }

    if has_row_json {
        rebuild_account_usage_row_cache_without_row_json(conn)?;
    }
    Ok(has_row_json)
}

fn ensure_account_usage_history_state_columns(conn: &Connection) -> Result<()> {
    let existing_columns = load_table_columns(conn, "account_usage_history_states")?;
    if existing_columns.contains("last_startup_recent_four_day_read_date") {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE account_usage_history_states
         ADD COLUMN last_startup_recent_four_day_read_date TEXT NULL",
        [],
    )?;
    Ok(())
}

fn load_table_columns(conn: &Connection, table_name: &str) -> Result<HashSet<String>> {
    Ok(load_table_column_contracts(conn, table_name)?
        .into_iter()
        .map(|column| column.name)
        .collect())
}

/// 将旧的“总访问次数”列等价迁移为“不含首次请求的重试次数”。
fn migrate_site_retry_count_semantics(conn: &mut Connection) -> Result<()> {
    let columns = load_table_columns(conn, "sites")?;
    let has_legacy_column = columns.contains("max_attempts_per_address");
    let has_retry_column = columns.contains("retry_count_per_address");

    match (has_legacy_column, has_retry_column) {
        (false, false) | (false, true) => Ok(()),
        (true, true) => bail!(
            "数据库结构冲突：sites 同时存在 max_attempts_per_address 和 retry_count_per_address"
        ),
        (true, false) => {
            let transaction = conn.transaction()?;
            transaction.execute(
                "ALTER TABLE sites
                 ADD COLUMN retry_count_per_address INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            transaction.execute(
                "UPDATE sites
                 SET retry_count_per_address = CASE
                   WHEN max_attempts_per_address > 0 THEN max_attempts_per_address - 1
                   ELSE 0
                 END",
                [],
            )?;
            transaction.execute("ALTER TABLE sites DROP COLUMN max_attempts_per_address", [])?;
            transaction.commit()?;
            Ok(())
        }
    }
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

fn rebuild_account_usage_row_cache_without_row_json(conn: &mut Connection) -> Result<()> {
    let temp_table = "account_usage_row_cache_next";
    let tx = conn.transaction()?;
    tx.execute(&format!("DROP TABLE IF EXISTS {temp_table}"), [])?;
    create_account_usage_row_cache_table(&tx, temp_table, false)?;

    let source_row_count: i64 =
        tx.query_row("SELECT COUNT(*) FROM account_usage_row_cache", [], |row| {
            row.get(0)
        })?;

    let projected_columns = ACCOUNT_USAGE_ROW_CACHE_COLUMN_SPECS
        .iter()
        .map(|spec| spec.name)
        .collect::<Vec<_>>()
        .join(", ");
    let select_expressions = ACCOUNT_USAGE_ROW_CACHE_COLUMN_SPECS
        .iter()
        .map(build_usage_cache_select_expression)
        .collect::<Vec<_>>()
        .join(",\n                ");
    let copy_sql = format!(
        "INSERT INTO {temp_table} (
            account_id, usage_id, {projected_columns}, occurred_at, updated_at, first_seen_at, last_seen_at
         )
         SELECT
            account_id,
            usage_id,
            {select_expressions},
            occurred_at,
            updated_at,
            first_seen_at,
            last_seen_at
         FROM account_usage_row_cache"
    );
    tx.execute(&copy_sql, [])?;
    let target_row_count: i64 =
        tx.query_row(&format!("SELECT COUNT(*) FROM {temp_table}"), [], |row| {
            row.get(0)
        })?;
    if target_row_count != source_row_count {
        bail!(
            "用量缓存结构迁移行数不一致：源表 {source_row_count} 行，目标表 {target_row_count} 行。"
        );
    }
    tx.execute("DROP TABLE account_usage_row_cache", [])?;
    tx.execute(
        &format!("ALTER TABLE {temp_table} RENAME TO account_usage_row_cache"),
        [],
    )?;
    tx.commit()?;
    Ok(())
}

fn build_usage_cache_select_expression(spec: &UsageCacheColumnSpec) -> String {
    let from_json = format!(
        "json_extract(CASE WHEN json_valid(row_json) THEN row_json ELSE NULL END, '$.{path}')",
        path = spec.json_path
    );
    match spec.fallback_sql {
        Some(fallback_sql) => format!(
            "COALESCE({name}, {from_json}, {fallback_sql})",
            name = spec.name
        ),
        None => format!("COALESCE({name}, {from_json})", name = spec.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_timestamp_migration_account(conn: &Connection, account_id: &str) {
        conn.execute(
            "INSERT INTO sites (id, name, base_url, created_at, updated_at)
             VALUES ('timestamp-site', 'site', 'https://example.test',
                     '2026-07-26 00:00:00', '2026-07-26 00:00:00')",
            [],
        )
        .expect("seed timestamp site");
        conn.execute(
            "INSERT INTO accounts (
               id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at
             ) VALUES (?1, 'timestamp-site', 'account', 'account@example.test', 0, NULL,
                       '2026-07-26 00:00:00', '2026-07-26 00:00:00')",
            [account_id],
        )
        .expect("seed timestamp account");
    }

    fn seed_usage_timestamp(
        conn: &Connection,
        account_id: &str,
        usage_id: &str,
        occurred_at: &str,
    ) {
        conn.execute(
            "INSERT INTO account_usage_row_cache (
               account_id, usage_id, model, input_tokens, output_tokens, total_cost, actual_cost,
               occurred_at, updated_at, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, 'gpt-test', 1, 1, 0.01, 0.01, ?3, ?3, ?3, ?3)",
            rusqlite::params![account_id, usage_id, occurred_at],
        )
        .expect("seed usage timestamp");
    }

    type UsageRollupSnapshot = (
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        f64,
        f64,
        i64,
        i64,
    );

    fn read_usage_rollup_snapshot(conn: &Connection) -> Vec<UsageRollupSnapshot> {
        conn.prepare(
            "SELECT
                usage_date, model, platform,
                requests, input_tokens, output_tokens,
                cache_creation_tokens, cache_read_tokens,
                total_cost, actual_cost, duration_ms_sum, duration_ms_count
             FROM account_usage_daily_rollup
             ORDER BY usage_date, model, platform",
        )
        .expect("prepare usage rollup snapshot")
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
            ))
        })
        .expect("query usage rollup snapshot")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect usage rollup snapshot")
    }

    #[test]
    fn completed_rollup_only_recovers_when_detail_exists_but_rollup_is_empty() {
        assert!(needs_usage_rollup_backfill(1, false, false));
        assert!(needs_usage_rollup_backfill(2, true, false));
        assert!(!needs_usage_rollup_backfill(2, false, false));
        assert!(!needs_usage_rollup_backfill(2, true, true));
    }

    #[test]
    fn rollup_backfill_recovers_missing_rows_after_version_two_upgrade() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("initialize current schema");
        seed_timestamp_migration_account(&conn, "rollup-recovery-account");
        seed_usage_timestamp(
            &conn,
            "rollup-recovery-account",
            "rollup-recovery-usage",
            "2026-07-26 08:00:00",
        );
        conn.execute("DELETE FROM account_usage_daily_rollup", [])
            .expect("simulate missing rollup data");
        conn.pragma_update(None, "user_version", USAGE_ROLLUP_SCHEMA_VERSION)
            .expect("keep upgraded version");

        apply(&mut conn).expect("recover rollup data");

        let requests: i64 = conn
            .query_row(
                "SELECT requests FROM account_usage_daily_rollup
                 WHERE account_id = 'rollup-recovery-account'",
                [],
                |row| row.get(0),
            )
            .expect("read recovered rollup row");
        assert_eq!(requests, 1);
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version");
        assert_eq!(version, CURRENT_USER_VERSION);
    }

    #[test]
    fn apply_rejects_future_schema_version_before_running_migrations() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.pragma_update(None, "user_version", CURRENT_USER_VERSION + 1)
            .expect("mark future version");

        let error = apply(&mut conn).expect_err("future schema must fail fast");
        assert!(error.to_string().contains("高于当前程序支持范围"));
        assert!(
            !table_exists(&conn, "sites").expect("check no schema was created"),
            "fail-fast check must happen before DDL"
        );
    }

    #[test]
    fn apply_adds_usage_billing_columns_to_flattened_cache_idempotently() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("initialize current schema");
        seed_timestamp_migration_account(&conn, "legacy-usage-account");
        conn.execute("DROP TABLE account_usage_row_cache", [])
            .expect("drop current usage cache");
        create_account_usage_row_cache_table(&conn, "account_usage_row_cache", false)
            .expect("create flattened usage cache");
        for column in [
            "service_tier",
            "long_context_billing_applied",
            "image_input_tokens",
            "image_input_cost",
        ] {
            conn.execute(
                &format!("ALTER TABLE account_usage_row_cache DROP COLUMN {column}"),
                [],
            )
            .expect("remove new billing column from legacy fixture");
        }
        seed_usage_timestamp(
            &conn,
            "legacy-usage-account",
            "legacy-usage-row",
            "2026-07-26 08:00:00",
        );

        apply(&mut conn).expect("upgrade flattened usage cache");
        let columns = load_table_columns(&conn, "account_usage_row_cache")
            .expect("read upgraded usage columns");
        for column in [
            "service_tier",
            "long_context_billing_applied",
            "image_input_tokens",
            "image_input_cost",
        ] {
            assert!(columns.contains(column), "missing upgraded column {column}");
        }

        let migrated = conn
            .query_row(
                "SELECT COUNT(*), model, input_tokens, output_tokens,
                        service_tier, image_input_tokens, image_input_cost,
                        long_context_billing_applied
                 FROM account_usage_row_cache
                 WHERE account_id = 'legacy-usage-account' AND usage_id = 'legacy-usage-row'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<f64>>(6)?,
                        row.get::<_, Option<bool>>(7)?,
                    ))
                },
            )
            .expect("read upgraded usage row");
        assert_eq!(
            migrated,
            (1, "gpt-test".into(), 1, 1, None, None, None, None)
        );

        apply(&mut conn).expect("repeat flattened usage cache upgrade");
        let repeated = conn
            .query_row(
                "SELECT COUNT(*), model, input_tokens, output_tokens,
                        service_tier, image_input_tokens, image_input_cost,
                        long_context_billing_applied
                 FROM account_usage_row_cache
                 WHERE account_id = 'legacy-usage-account' AND usage_id = 'legacy-usage-row'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<f64>>(6)?,
                        row.get::<_, Option<bool>>(7)?,
                    ))
                },
            )
            .expect("read usage row after repeated upgrade");
        assert_eq!(repeated, migrated);
    }

    #[test]
    fn storage_timestamp_migration_normalizes_offsets_keeps_dates_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        seed_timestamp_migration_account(&conn, "timestamp-account");
        conn.execute(
            "UPDATE sites
             SET created_at = '2026-07-25T16:00:01Z',
                 updated_at = '2026-07-26T08:30:45+08:00'
             WHERE id = 'timestamp-site'",
            [],
        )
        .expect("seed legacy site timestamps");
        seed_usage_timestamp(
            &conn,
            "timestamp-account",
            "usage-before-midnight",
            "2026-07-25T15:59:59.900Z",
        );
        seed_usage_timestamp(
            &conn,
            "timestamp-account",
            "usage-after-midnight",
            "2026-07-25T16:00:00.100Z",
        );
        conn.execute(
            "INSERT INTO account_usage_history_states (
               account_id, state, earliest_date, completed_through_date, active_date,
               audit_cursor_date, last_startup_recent_four_day_read_date, updated_at
             ) VALUES (
               'timestamp-account', 'pending', '2026-07-01', '2026-07-20', '2026-07-26',
               '2026-07-21', '2026-07-26', '2026-07-25T16:00:02Z'
             )",
            [],
        )
        .expect("seed business dates");
        conn.pragma_update(None, "user_version", 0)
            .expect("mark legacy timestamp version");

        apply(&mut conn).expect("migrate legacy timestamps");

        let site_timestamps: (String, String) = conn
            .query_row(
                "SELECT created_at, updated_at FROM sites WHERE id = 'timestamp-site'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated site timestamps");
        assert_eq!(
            site_timestamps,
            (
                "2026-07-26 00:00:01".to_string(),
                "2026-07-26 08:30:45".to_string()
            )
        );

        let usage_timestamps = {
            let mut stmt = conn
                .prepare(
                    "SELECT occurred_at FROM account_usage_row_cache
                     WHERE account_id = 'timestamp-account' ORDER BY occurred_at",
                )
                .expect("prepare migrated usage query");
            stmt.query_map([], |row| row.get::<_, String>(0))
                .expect("query migrated usage timestamps")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect migrated usage timestamps")
        };
        assert_eq!(
            usage_timestamps,
            vec![
                "2026-07-25 23:59:59".to_string(),
                "2026-07-26 00:00:00".to_string()
            ]
        );
        let range_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM account_usage_row_cache
                 WHERE occurred_at BETWEEN '2026-07-26 00:00:00' AND '2026-07-26 23:59:59'",
                [],
                |row| row.get(0),
            )
            .expect("count Shanghai calendar range");
        assert_eq!(range_count, 1);

        let business_dates: (String, String, String, String, String) = conn
            .query_row(
                "SELECT earliest_date, completed_through_date, active_date, audit_cursor_date,
                        last_startup_recent_four_day_read_date
                 FROM account_usage_history_states WHERE account_id = 'timestamp-account'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read preserved business dates");
        assert_eq!(
            business_dates,
            (
                "2026-07-01".to_string(),
                "2026-07-20".to_string(),
                "2026-07-26".to_string(),
                "2026-07-21".to_string(),
                "2026-07-26".to_string()
            )
        );
        let schema_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read migrated timestamp version");
        assert_eq!(schema_version, CURRENT_USER_VERSION);

        apply(&mut conn).expect("repeat timestamp migration");
        let timestamps_after_restart: Vec<String> = conn
            .prepare(
                "SELECT occurred_at FROM account_usage_row_cache
                 WHERE account_id = 'timestamp-account' ORDER BY occurred_at",
            )
            .expect("prepare repeated timestamp query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query repeated timestamps")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect repeated timestamps");
        assert_eq!(timestamps_after_restart, usage_timestamps);
    }

    #[test]
    fn usage_rollup_backfill_recovers_missing_rows_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        seed_timestamp_migration_account(&conn, "rollup-account");
        conn.execute_batch(
            "INSERT INTO account_usage_row_cache (
                account_id, usage_id, model, platform,
                input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                total_cost, actual_cost, duration_ms,
                occurred_at, updated_at, first_seen_at, last_seen_at
             ) VALUES
                ('rollup-account', 'rollup-a', 'gpt-4.1', 'openai',
                 10, 20, 3, 4, 1.5, 1.25, 100,
                 '2026-07-26 09:00:00', '2026-07-26 09:00:00', '2026-07-26 09:00:00', '2026-07-26 09:00:00'),
                ('rollup-account', 'rollup-b', '', NULL,
                 5, 6, NULL, NULL, 0.75, 0.5, NULL,
                 '2026-07-26 10:00:00', '2026-07-26 10:00:00', '2026-07-26 10:00:00', '2026-07-26 10:00:00'),
                ('rollup-account', 'rollup-c', 'gpt-4.1', 'openai',
                 11, 12, 0, 7, 0.6, 0.4, 150,
                 '2026-07-27 09:00:00', '2026-07-27 09:00:00', '2026-07-27 09:00:00', '2026-07-27 09:00:00');",
        )
        .expect("seed detailed usage rows");
        conn.execute("DELETE FROM account_usage_daily_rollup", [])
            .expect("remove stale rollup rows");
        conn.pragma_update(None, "user_version", STORAGE_TIMESTAMP_SCHEMA_VERSION)
            .expect("mark database as pre-rollup");

        apply(&mut conn).expect("backfill usage rollup");
        let expected = vec![
            (
                "2026-07-26".to_string(),
                "gpt-4.1".to_string(),
                "openai".to_string(),
                1,
                10,
                20,
                3,
                4,
                1.5,
                1.25,
                100,
                1,
            ),
            (
                "2026-07-26".to_string(),
                "unknown".to_string(),
                "unknown".to_string(),
                1,
                5,
                6,
                0,
                0,
                0.75,
                0.5,
                0,
                0,
            ),
            (
                "2026-07-27".to_string(),
                "gpt-4.1".to_string(),
                "openai".to_string(),
                1,
                11,
                12,
                0,
                7,
                0.6,
                0.4,
                150,
                1,
            ),
        ];
        assert_eq!(read_usage_rollup_snapshot(&conn), expected);
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read rollup schema version");
        assert_eq!(version, CURRENT_USER_VERSION);

        apply(&mut conn).expect("repeat rollup migration");
        assert_eq!(read_usage_rollup_snapshot(&conn), expected);

        conn.execute("DELETE FROM account_usage_daily_rollup", [])
            .expect("simulate incomplete rollup after a failed external write");
        apply(&mut conn).expect("repair stale rollup with current version");
        assert_eq!(read_usage_rollup_snapshot(&conn), expected);
    }

    #[test]
    fn usage_user_agent_fts_rebuild_and_triggers_stay_consistent() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        create_current_tables(&conn).expect("create pre-FTS schema fixture");
        conn.execute("DROP TABLE account_usage_user_agent_fts", [])
            .expect("remove FTS table from version two fixture");
        seed_timestamp_migration_account(&conn, "fts-account");
        conn.execute(
            "INSERT INTO account_usage_row_cache (
               account_id, usage_id, model, input_tokens, output_tokens, total_cost, actual_cost,
               user_agent, occurred_at, updated_at, first_seen_at, last_seen_at
             ) VALUES (
               'fts-account', 'fts-existing', 'gpt-test', 1, 1, 0.01, 0.01,
               'Mozilla CodexClient', '2026-08-11 08:00:00', '2026-08-11 08:00:00',
               '2026-08-11 08:00:00', '2026-08-11 08:00:00'
             )",
            [],
        )
        .expect("seed existing user agent before FTS upgrade");
        conn.pragma_update(None, "user_version", USAGE_ROLLUP_SCHEMA_VERSION)
            .expect("mark version two fixture");

        apply(&mut conn).expect("upgrade and rebuild FTS");

        assert_eq!(count_user_agent_matches(&conn, "mozilla"), 1);
        assert_eq!(count_user_agent_matches(&conn, "codex*"), 1);
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read FTS schema version");
        assert_eq!(version, USAGE_USER_AGENT_FTS_SCHEMA_VERSION);

        conn.execute(
            "INSERT INTO account_usage_row_cache (
               account_id, usage_id, model, input_tokens, output_tokens, total_cost, actual_cost,
               user_agent, occurred_at, updated_at, first_seen_at, last_seen_at
             ) VALUES (
               'fts-account', 'fts-inserted', 'gpt-test', 1, 1, 0.01, 0.01,
               'Chrome Desktop', '2026-08-11 09:00:00', '2026-08-11 09:00:00',
               '2026-08-11 09:00:00', '2026-08-11 09:00:00'
             )",
            [],
        )
        .expect("insert row after FTS upgrade");
        assert_eq!(count_user_agent_matches(&conn, "chrome"), 1);

        conn.execute(
            "UPDATE account_usage_row_cache
             SET user_agent = 'Firefox Runtime'
             WHERE account_id = 'fts-account' AND usage_id = 'fts-existing'",
            [],
        )
        .expect("update indexed user agent");
        assert_eq!(count_user_agent_matches(&conn, "mozilla"), 0);
        assert_eq!(count_user_agent_matches(&conn, "firefox"), 1);

        conn.execute(
            "DELETE FROM account_usage_row_cache
             WHERE account_id = 'fts-account' AND usage_id = 'fts-inserted'",
            [],
        )
        .expect("delete indexed user agent");
        assert_eq!(count_user_agent_matches(&conn, "chrome"), 0);

        conn.execute("DROP TABLE account_usage_user_agent_fts", [])
            .expect("simulate missing FTS table at current version");
        apply(&mut conn).expect("recover missing FTS table without changing user version");
        assert_eq!(count_user_agent_matches(&conn, "firefox"), 1);
        let recovered_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read recovered FTS schema version");
        assert_eq!(recovered_version, USAGE_USER_AGENT_FTS_SCHEMA_VERSION);
    }

    #[test]
    fn usage_cache_rebuild_at_current_version_rebuilds_external_content_fts() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        seed_timestamp_migration_account(&conn, "fts-rebuild-account");
        conn.execute_batch(
            "INSERT INTO account_usage_row_cache (
               account_id, usage_id, model, input_tokens, output_tokens, total_cost, actual_cost,
               user_agent, occurred_at, updated_at, first_seen_at, last_seen_at
             ) VALUES
               ('fts-rebuild-account', 'fts-row-1', 'gpt-test', 1, 1, 0.01, 0.01,
                'Chrome Runtime', '2026-08-11 08:00:00', '2026-08-11 08:00:00',
                '2026-08-11 08:00:00', '2026-08-11 08:00:00'),
               ('fts-rebuild-account', 'fts-row-2', 'gpt-test', 1, 1, 0.01, 0.01,
                'Safari Runtime', '2026-08-11 09:00:00', '2026-08-11 09:00:00',
                '2026-08-11 09:00:00', '2026-08-11 09:00:00'),
               ('fts-rebuild-account', 'fts-row-3', 'gpt-test', 1, 1, 0.01, 0.01,
                'Firefox Runtime', '2026-08-11 10:00:00', '2026-08-11 10:00:00',
                '2026-08-11 10:00:00', '2026-08-11 10:00:00');
             DELETE FROM account_usage_row_cache
             WHERE account_id = 'fts-rebuild-account' AND usage_id = 'fts-row-2';
             ALTER TABLE account_usage_row_cache ADD COLUMN row_json TEXT NULL;",
        )
        .expect("seed current-version legacy row_json fixture with a rowid gap");
        assert_eq!(count_user_agent_matches(&conn, "firefox"), 1);

        apply(&mut conn).expect("rebuild usage cache and its external-content FTS index");

        assert_eq!(count_user_agent_matches(&conn, "firefox"), 1);
        let columns = load_table_columns(&conn, "account_usage_row_cache")
            .expect("read rebuilt usage columns");
        assert!(!columns.contains("row_json"));
    }

    #[test]
    fn strict_schema_verification_includes_fts_table_but_excludes_shadow_tables() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");

        verify_schema_documentation(&conn, true)
            .expect("FTS shadow tables must not fail strict verification");
        let fts_table_type: String = conn
            .query_row(
                "SELECT type FROM pragma_table_list
                 WHERE schema = 'main' AND name = 'account_usage_user_agent_fts'",
                [],
                |row| row.get(0),
            )
            .expect("read FTS virtual table type");
        assert_eq!(fts_table_type, "virtual");
        let shadow_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_list
                 WHERE schema = 'main'
                   AND name LIKE 'account_usage_user_agent_fts_%'
                   AND type = 'shadow'",
                [],
                |row| row.get(0),
            )
            .expect("count FTS shadow tables");
        assert!(shadow_count > 0);
    }

    #[test]
    fn schema_verification_rejects_plain_table_named_as_usage_user_agent_fts() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        conn.execute_batch(
            "DROP TABLE account_usage_user_agent_fts;
             CREATE TABLE account_usage_user_agent_fts (user_agent TEXT);",
        )
        .expect("replace FTS virtual table with a plain table");

        let error = verify_schema_documentation(&conn, true)
            .expect_err("plain table must not satisfy the FTS schema contract");

        assert!(error.to_string().contains("FTS5"));
        assert!(error.to_string().contains("虚拟表"));
    }

    fn count_user_agent_matches(conn: &Connection, query: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM account_usage_user_agent_fts
             WHERE account_usage_user_agent_fts MATCH ?1",
            [query],
            |row| row.get(0),
        )
        .expect("query user agent FTS")
    }

    #[test]
    fn storage_timestamp_conflict_rolls_back_without_exposing_business_ids() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        seed_timestamp_migration_account(&conn, "account-sensitive");
        conn.execute(
            "UPDATE sites SET created_at = '2026-07-25T16:00:01Z'
             WHERE id = 'timestamp-site'",
            [],
        )
        .expect("seed timestamp that must roll back");
        seed_usage_timestamp(
            &conn,
            "account-sensitive",
            "usage-sensitive",
            "2026-07-25T16:00:02.100Z",
        );
        seed_usage_timestamp(
            &conn,
            "account-sensitive",
            "usage-sensitive",
            "2026-07-25T16:00:02.900Z",
        );
        conn.pragma_update(None, "user_version", 0)
            .expect("mark legacy timestamp version");

        let error = apply(&mut conn).expect_err("second-level key collision should roll back");
        let message = error.to_string();
        assert!(message.contains("复合主键冲突"));
        assert!(!message.contains("account-sensitive"));
        assert!(!message.contains("usage-sensitive"));

        let site_created_at: String = conn
            .query_row(
                "SELECT created_at FROM sites WHERE id = 'timestamp-site'",
                [],
                |row| row.get(0),
            )
            .expect("read rolled-back site timestamp");
        assert_eq!(site_created_at, "2026-07-25T16:00:01Z");
        let usage_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM account_usage_row_cache
                 WHERE account_id = 'account-sensitive' AND usage_id = 'usage-sensitive'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved conflict rows");
        assert_eq!(usage_count, 2);
        let schema_version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read rolled-back timestamp version");
        assert_eq!(schema_version, 0);
        assert!(
            !table_exists(&conn, "account_usage_row_cache_timestamp_source")
                .expect("check temporary migration table")
        );

        conn.execute(
            "DELETE FROM account_usage_row_cache
             WHERE account_id = 'account-sensitive'
               AND usage_id = 'usage-sensitive'
               AND occurred_at = '2026-07-25T16:00:02.900Z'",
            [],
        )
        .expect("remove conflicting legacy row");
        apply(&mut conn).expect("retry timestamp migration after conflict is resolved");
        apply(&mut conn).expect("repeat successful retry");
        let migrated_timestamp: String = conn
            .query_row(
                "SELECT occurred_at FROM account_usage_row_cache
                 WHERE account_id = 'account-sensitive' AND usage_id = 'usage-sensitive'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated timestamp after retry");
        assert_eq!(migrated_timestamp, "2026-07-26 00:00:02");
    }

    #[test]
    fn migrates_existing_subscription_rule_to_node_chain() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE accounts (
              id TEXT PRIMARY KEY,
              site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
              label TEXT NOT NULL,
              email TEXT NOT NULL,
              balance_warning REAL NOT NULL,
              last_login_at TEXT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO sites (id, name, base_url, created_at, updated_at)
            VALUES ('site-1', 'site', 'https://example.test', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');
            INSERT INTO accounts (
              id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at
            ) VALUES (
              'account-1', 'site-1', 'account', 'account@example.test', 0, NULL,
              '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'
            );
            CREATE TABLE account_key_subscription_switch_rules (
              account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
              key_id TEXT NOT NULL,
              source_group_id INTEGER NOT NULL,
              enabled INTEGER NOT NULL,
              candidate_group_ids_json TEXT NOT NULL,
              auto_restore INTEGER NOT NULL,
              threshold_mode TEXT NOT NULL,
              threshold_value REAL NOT NULL,
              runtime_state TEXT NOT NULL,
              active_target_group_id INTEGER NULL,
              last_trigger_reason TEXT NULL,
              last_switched_at TEXT NULL,
              last_restored_at TEXT NULL,
              last_error TEXT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (account_id, key_id)
            );
            INSERT INTO account_key_subscription_switch_rules (
              account_id, key_id, source_group_id, enabled, candidate_group_ids_json,
              auto_restore, threshold_mode, threshold_value, runtime_state, active_target_group_id,
              last_trigger_reason, last_switched_at, last_restored_at, last_error, updated_at
            ) VALUES (
              'account-1', 'key-1', 10, 1, '[20,30]', 1, 'amount_usd', 45.5,
              'idle', NULL, NULL, NULL, NULL, NULL, '2026-07-25T00:00:00Z'
            );
            "#,
        )
        .expect("seed legacy rule");

        apply(&mut conn).expect("apply migration");
        apply(&mut conn).expect("apply migration twice");

        let (chain_nodes_json, strict_mode): (String, i64) = conn
            .query_row(
                "SELECT chain_nodes_json, strict_mode FROM account_key_subscription_switch_rules
                 WHERE account_id = 'account-1' AND key_id = 'key-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated rule");
        let chain_nodes: Vec<SubscriptionSwitchChainNode> =
            serde_json::from_str(&chain_nodes_json).expect("decode chain nodes");

        assert_eq!(
            chain_nodes
                .iter()
                .map(|node| node.group_id)
                .collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
        assert!(chain_nodes.iter().all(|node| {
            matches!(
                node.threshold_mode,
                SubscriptionSwitchThresholdMode::AmountUsd
            ) && (node.threshold_value - 45.5).abs() < f64::EPSILON
        }));
        assert_eq!(strict_mode, 0, "旧规则升级后严格模式必须默认关闭");
    }

    #[test]
    fn apply_recreates_a_missing_current_table() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        conn.execute("DROP TABLE site_public_endpoint_cache", [])
            .expect("drop current table");

        apply(&mut conn).expect("recreate missing table");

        assert!(table_exists(&conn, "site_public_endpoint_cache").expect("check recreated table"));
    }

    #[test]
    fn apply_adds_a_safe_missing_column_from_the_canonical_schema() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE site_public_endpoint_cache (
              site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
              api_base_url TEXT NOT NULL,
              custom_endpoints_json TEXT NOT NULL,
              fetched_at TEXT NOT NULL
            );
            INSERT INTO sites (id, name, base_url, created_at, updated_at)
            VALUES (
              'legacy-site', 'Legacy', 'https://legacy.test',
              '2026-08-10 00:00:00', '2026-08-10 00:00:00'
            );
            "#,
        )
        .expect("seed schema without safe field");

        apply(&mut conn).expect("repair safe missing field");

        let columns = load_table_columns(&conn, "site_public_endpoint_cache")
            .expect("read repaired table columns");
        assert!(columns.contains("last_error"));
        let site_columns = load_table_columns(&conn, "sites").expect("read repaired site columns");
        assert!(site_columns.contains("failover_cooldown_seconds"));
        assert!(site_columns.contains("retry_count_per_address"));
        assert!(!site_columns.contains("max_attempts_per_address"));
        assert!(table_exists(&conn, "site_fallback_base_urls").expect("check fallback table"));

        let defaults: (i64, i64) = conn
            .query_row(
                "SELECT failover_cooldown_seconds, retry_count_per_address FROM sites LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated site defaults");
        assert_eq!(defaults, (60, 0));
    }

    #[test]
    fn apply_migrates_legacy_site_attempt_budget_once() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              failover_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
              max_attempts_per_address INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO sites (
              id, name, base_url, max_attempts_per_address, created_at, updated_at
            ) VALUES
              ('zero', 'Zero', 'https://zero.test', 0, '2026-08-19 00:00:00', '2026-08-19 00:00:00'),
              ('one', 'One', 'https://one.test', 1, '2026-08-19 00:00:00', '2026-08-19 00:00:00'),
              ('three', 'Three', 'https://three.test', 3, '2026-08-19 00:00:00', '2026-08-19 00:00:00');
            "#,
        )
        .expect("seed legacy site attempt budget");

        apply(&mut conn).expect("migrate legacy site attempt budget");
        apply(&mut conn).expect("repeat site retry migration idempotently");

        let columns = load_table_column_contracts(&conn, "sites").expect("read site columns");
        assert!(!columns
            .iter()
            .any(|column| column.name == "max_attempts_per_address"));
        let retry_column = columns
            .iter()
            .find(|column| column.name == "retry_count_per_address")
            .expect("retry count column");
        assert_eq!(retry_column.default_value.as_deref(), Some("0"));

        let values = ["zero", "one", "three"]
            .into_iter()
            .map(|id| {
                conn.query_row(
                    "SELECT retry_count_per_address FROM sites WHERE id = ?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("read migrated retry count")
            })
            .collect::<Vec<_>>();
        assert_eq!(values, vec![0, 0, 2]);
    }

    #[test]
    fn apply_rejects_conflicting_site_retry_columns() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              failover_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
              max_attempts_per_address INTEGER NOT NULL DEFAULT 1,
              retry_count_per_address INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        )
        .expect("seed conflicting site columns");

        let error = apply(&mut conn).expect_err("conflicting retry columns must fail");
        assert!(error.to_string().contains("同时存在"));
        let columns =
            load_table_columns(&conn, "sites").expect("read preserved conflicting columns");
        assert!(columns.contains("max_attempts_per_address"));
        assert!(columns.contains("retry_count_per_address"));
    }

    #[test]
    fn apply_rejects_a_missing_critical_column_without_overwriting_data() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY);\
             INSERT INTO app_settings (key) VALUES ('preserve-me');",
        )
        .expect("seed incomplete settings table");

        let error = apply(&mut conn).expect_err("missing critical column should fail");

        assert!(error.to_string().contains("app_settings"));
        assert!(error.to_string().contains("value"));
        let key: String = conn
            .query_row("SELECT key FROM app_settings", [], |row| row.get(0))
            .expect("read preserved setting");
        assert_eq!(key, "preserve-me");
    }

    #[test]
    fn apply_rejects_an_unrepairable_foreign_key_drift() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE accounts (
              id TEXT PRIMARY KEY,
              site_id TEXT NOT NULL,
              label TEXT NOT NULL,
              email TEXT NOT NULL,
              balance_warning REAL NOT NULL,
              last_login_at TEXT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            "#,
        )
        .expect("seed accounts without foreign key");

        let error = apply(&mut conn).expect_err("foreign key drift should fail");

        assert!(error.to_string().contains("accounts"));
        assert!(error.to_string().contains("外键"));
    }

    #[test]
    fn index_contract_rejects_same_name_with_wrong_definition() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        conn.execute_batch(
            "DROP INDEX idx_account_usage_row_cache_account_occurred;
             CREATE INDEX idx_account_usage_row_cache_account_occurred
             ON account_usage_row_cache(account_id, usage_id);",
        )
        .expect("replace index with wrong definition");

        let error = verify_schema_documentation(&conn, true)
            .expect_err("same-name wrong index should fail verification");

        assert!(error.to_string().contains("索引定义不一致"));
    }

    #[test]
    fn legacy_subscription_rule_conflict_keeps_source_table() {
        let mut conn = Connection::open_in_memory().expect("open sqlite");
        apply(&mut conn).expect("create current schema");
        conn.execute_batch(
            r#"
            INSERT INTO sites (id, name, base_url, created_at, updated_at)
            VALUES ('site-1', 'site', 'https://example.test', '2026-07-26 08:00:00', '2026-07-26 08:00:00');
            INSERT INTO accounts (
              id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at
            ) VALUES (
              'account-1', 'site-1', 'account', 'account@example.test', 0, NULL,
              '2026-07-26 08:00:00', '2026-07-26 08:00:00'
            );
            INSERT INTO account_key_subscription_switch_rules (
              account_id, key_id, source_group_id, enabled, candidate_group_ids_json,
              chain_nodes_json, auto_restore, threshold_mode, threshold_value, runtime_state,
              active_target_group_id, last_trigger_reason, last_switched_at, last_restored_at,
              last_error, updated_at
            ) VALUES (
              'account-1', 'key-1', 10, 1, '[]', '[]', 1, 'usage_percent', 100,
              'idle', NULL, NULL, NULL, NULL, NULL, '2026-07-26 08:00:00'
            );
            CREATE TABLE account_subscription_switch_rules (
              account_id TEXT NOT NULL,
              source_group_id INTEGER NOT NULL,
              enabled INTEGER NOT NULL,
              selected_key_ids_json TEXT NOT NULL,
              candidate_group_ids_json TEXT NOT NULL,
              auto_restore INTEGER NOT NULL,
              runtime_state TEXT NOT NULL,
              active_target_group_id INTEGER NULL,
              last_trigger_reason TEXT NULL,
              last_switched_at TEXT NULL,
              last_restored_at TEXT NULL,
              last_error TEXT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO account_subscription_switch_rules (
              account_id, source_group_id, enabled, selected_key_ids_json,
              candidate_group_ids_json, auto_restore, runtime_state,
              active_target_group_id, last_trigger_reason, last_switched_at,
              last_restored_at, last_error, updated_at
            ) VALUES (
              'account-1', 20, 1, '["key-1"]', '[]', 1, 'idle',
              NULL, NULL, NULL, NULL, NULL, '2026-07-26 09:00:00'
            );
            "#,
        )
        .expect("seed conflicting legacy rule");

        migrate_legacy_subscription_switch_rules(&mut conn)
            .expect_err("conflicting legacy rule should fail without dropping source");

        assert!(table_exists(&conn, "account_subscription_switch_rules")
            .expect("check legacy source table"));
        let legacy_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM account_subscription_switch_rules",
                [],
                |row| row.get(0),
            )
            .expect("count preserved legacy rows");
        assert_eq!(legacy_count, 1);
    }

    #[test]
    fn integrity_check_accepts_a_healthy_database() {
        let conn = Connection::open_in_memory().expect("open sqlite");

        verify_integrity(&conn).expect("healthy database should pass integrity check");
    }
}
