use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

use crate::infrastructure::sqlite::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageHistoryState {
    Pending,
    Backfilling,
    NeedsAudit,
    Converged,
    Degraded,
}

impl UsageHistoryState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Backfilling => "backfilling",
            Self::NeedsAudit => "needs_audit",
            Self::Converged => "converged",
            Self::Degraded => "degraded",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "backfilling" => Ok(Self::Backfilling),
            "needs_audit" => Ok(Self::NeedsAudit),
            "converged" => Ok(Self::Converged),
            "degraded" => Ok(Self::Degraded),
            _ => Err(anyhow!("unknown usage history state")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUsageHistoryStateRecord {
    pub account_id: String,
    pub state: UsageHistoryState,
    pub earliest_date: Option<String>,
    pub completed_through_date: Option<String>,
    pub active_date: Option<String>,
    pub audit_cursor_date: Option<String>,
    pub recent_reconciled_at: Option<String>,
    pub last_startup_recent_four_day_read_date: Option<String>,
    pub heartbeat_at: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug)]
struct RawUsageHistoryStateRecord {
    account_id: String,
    state: String,
    earliest_date: Option<String>,
    completed_through_date: Option<String>,
    active_date: Option<String>,
    audit_cursor_date: Option<String>,
    recent_reconciled_at: Option<String>,
    last_startup_recent_four_day_read_date: Option<String>,
    heartbeat_at: Option<String>,
    last_error: Option<String>,
    updated_at: String,
}

pub fn load_usage_history_state(
    db: &Database,
    account_id: &str,
) -> Result<Option<AccountUsageHistoryStateRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT account_id, state, earliest_date, completed_through_date, active_date,
                    audit_cursor_date, recent_reconciled_at, last_startup_recent_four_day_read_date,
                    heartbeat_at, last_error, updated_at
             FROM account_usage_history_states
             WHERE account_id = ?1",
            params![account_id],
            |row| {
                Ok(RawUsageHistoryStateRecord {
                    account_id: row.get(0)?,
                    state: row.get(1)?,
                    earliest_date: row.get(2)?,
                    completed_through_date: row.get(3)?,
                    active_date: row.get(4)?,
                    audit_cursor_date: row.get(5)?,
                    recent_reconciled_at: row.get(6)?,
                    last_startup_recent_four_day_read_date: row.get(7)?,
                    heartbeat_at: row.get(8)?,
                    last_error: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()?;

    record.map(parse_usage_history_state_record).transpose()
}

pub fn ensure_usage_history_state(
    db: &Database,
    account_id: &str,
    updated_at: &str,
) -> Result<AccountUsageHistoryStateRecord> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT OR IGNORE INTO account_usage_history_states (account_id, state, updated_at)
         VALUES (?1, 'pending', ?2)",
        params![account_id, updated_at],
    )?;
    drop(conn);

    load_usage_history_state(db, account_id)?
        .ok_or_else(|| anyhow!("usage history state was not created"))
}

pub fn mark_usage_history_active(
    db: &Database,
    account_id: &str,
    active_date: &str,
    heartbeat_at: &str,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET state = 'backfilling', active_date = ?2, heartbeat_at = ?3,
             last_error = NULL, updated_at = ?4
         WHERE account_id = ?1",
        params![account_id, active_date, heartbeat_at, updated_at],
    )?;
    Ok(())
}

pub fn advance_usage_history_completed_through_date(
    db: &Database,
    account_id: &str,
    earliest_date: Option<&str>,
    completed_through_date: &str,
    audit_cursor_date: Option<&str>,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET state = 'needs_audit', earliest_date = CASE
                WHEN ?2 IS NULL THEN earliest_date
                WHEN earliest_date IS NULL OR ?2 < earliest_date THEN ?2
                ELSE earliest_date
             END,
             completed_through_date = ?3, active_date = NULL, heartbeat_at = NULL,
             audit_cursor_date = COALESCE(?4, audit_cursor_date), last_error = NULL, updated_at = ?5
         WHERE account_id = ?1",
        params![
            account_id,
            earliest_date,
            completed_through_date,
            audit_cursor_date,
            updated_at,
        ],
    )?;
    Ok(())
}

pub fn record_usage_history_recent_reconciliation(
    db: &Database,
    account_id: &str,
    reconciled_at: &str,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET state = 'converged', active_date = NULL, heartbeat_at = NULL,
             recent_reconciled_at = ?2, last_error = NULL, updated_at = ?3
         WHERE account_id = ?1",
        params![account_id, reconciled_at, updated_at],
    )?;
    Ok(())
}

pub fn advance_usage_history_audit_cursor(
    db: &Database,
    account_id: &str,
    audit_cursor_date: Option<&str>,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET state = 'converged', active_date = NULL, heartbeat_at = NULL,
             audit_cursor_date = ?2, last_error = NULL, updated_at = ?3
         WHERE account_id = ?1",
        params![account_id, audit_cursor_date, updated_at],
    )?;
    Ok(())
}

pub fn should_run_startup_recent_four_day_usage_read(
    db: &Database,
    account_id: &str,
    today: &str,
) -> Result<bool> {
    Ok(load_usage_history_state(db, account_id)?
        .and_then(|state| state.last_startup_recent_four_day_read_date)
        .as_deref()
        != Some(today))
}

pub fn mark_startup_recent_four_day_usage_read_completed(
    db: &Database,
    account_id: &str,
    today: &str,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET last_startup_recent_four_day_read_date = ?2, recent_reconciled_at = ?3,
             updated_at = ?3
         WHERE account_id = ?1",
        params![account_id, today, updated_at],
    )?;
    Ok(())
}

pub fn mark_usage_history_issue(
    db: &Database,
    account_id: &str,
    state: UsageHistoryState,
    error: &str,
    updated_at: &str,
) -> Result<()> {
    ensure_usage_history_state(db, account_id, updated_at)?;
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_usage_history_states
         SET state = ?2, heartbeat_at = NULL, last_error = ?3, updated_at = ?4
         WHERE account_id = ?1",
        params![
            account_id,
            state.as_str(),
            sanitize_usage_history_error(error),
            updated_at,
        ],
    )?;
    Ok(())
}

pub fn sanitize_usage_history_error(error: &str) -> String {
    let mut value = error.replace(['\r', '\n'], " ");
    let lower = value.to_ascii_lowercase();
    for marker in [
        "bearer ",
        "access_token=",
        "refresh_token=",
        "cookie_jar_json=",
        "token=",
    ] {
        if let Some(position) = lower.find(marker) {
            value.truncate(position + marker.len());
            value.push_str("[redacted]");
            break;
        }
    }
    value.chars().take(512).collect()
}

fn parse_usage_history_state_record(
    record: RawUsageHistoryStateRecord,
) -> Result<AccountUsageHistoryStateRecord> {
    Ok(AccountUsageHistoryStateRecord {
        account_id: record.account_id,
        state: UsageHistoryState::parse(&record.state)?,
        earliest_date: record.earliest_date,
        completed_through_date: record.completed_through_date,
        active_date: record.active_date,
        audit_cursor_date: record.audit_cursor_date,
        recent_reconciled_at: record.recent_reconciled_at,
        last_startup_recent_four_day_read_date: record.last_startup_recent_four_day_read_date,
        heartbeat_at: record.heartbeat_at,
        last_error: record.last_error,
        updated_at: record.updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::sqlite::repositories;

    fn build_test_db() -> Database {
        let path = std::env::temp_dir().join(format!(
            "api-token-usage-history-state-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(path);
        let _ = db.connect().expect("initialize test database");
        repositories::insert_site(
            &db,
            &SiteRecord {
                id: "site-1".into(),
                name: "test-site".into(),
                base_url: "https://example.test".into(),
                created_at: "2026-07-20T00:00:00Z".into(),
                updated_at: "2026-07-20T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "test-account".into(),
                email: "account@example.test".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-20T00:00:00Z".into(),
                updated_at: "2026-07-20T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        db
    }

    #[test]
    fn initializes_pending_state_and_tracks_recovery_boundaries() {
        let db = build_test_db();

        let initial = ensure_usage_history_state(&db, "account-1", "2026-07-20T00:00:00Z")
            .expect("create state");
        assert_eq!(initial.state, UsageHistoryState::Pending);
        assert!(initial.active_date.is_none());

        mark_usage_history_active(
            &db,
            "account-1",
            "2026-05-06",
            "2026-07-20T00:01:00Z",
            "2026-07-20T00:01:00Z",
        )
        .expect("mark active date");
        advance_usage_history_completed_through_date(
            &db,
            "account-1",
            Some("2026-05-06"),
            "2026-05-07",
            Some("2026-05-06"),
            "2026-07-20T00:02:00Z",
        )
        .expect("advance complete date");

        let checkpoint = load_usage_history_state(&db, "account-1")
            .expect("load state")
            .expect("state exists");
        assert_eq!(checkpoint.state, UsageHistoryState::NeedsAudit);
        assert_eq!(checkpoint.earliest_date.as_deref(), Some("2026-05-06"));
        assert_eq!(
            checkpoint.completed_through_date.as_deref(),
            Some("2026-05-07")
        );
        assert_eq!(checkpoint.active_date, None);
        assert_eq!(checkpoint.audit_cursor_date.as_deref(), Some("2026-05-06"));
    }

    #[test]
    fn failed_audit_retains_cursor_and_redacts_sensitive_error_content() {
        let db = build_test_db();
        advance_usage_history_audit_cursor(
            &db,
            "account-1",
            Some("2026-05-06"),
            "2026-07-20T00:00:00Z",
        )
        .expect("set audit cursor");
        mark_usage_history_issue(
            &db,
            "account-1",
            UsageHistoryState::NeedsAudit,
            "upstream returned 500 Authorization: Bearer secret-token",
            "2026-07-20T00:01:00Z",
        )
        .expect("record audit failure");

        let checkpoint = load_usage_history_state(&db, "account-1")
            .expect("load state")
            .expect("state exists");
        assert_eq!(checkpoint.audit_cursor_date.as_deref(), Some("2026-05-06"));
        assert_eq!(checkpoint.state, UsageHistoryState::NeedsAudit);
        assert!(checkpoint
            .last_error
            .as_deref()
            .expect("error summary")
            .contains("[redacted]"));
        assert!(!checkpoint
            .last_error
            .as_deref()
            .expect("error summary")
            .contains("secret-token"));
    }

    #[test]
    fn startup_recent_four_day_completion_is_throttled_per_day() {
        let db = build_test_db();

        assert!(
            should_run_startup_recent_four_day_usage_read(&db, "account-1", "2026-07-21")
                .expect("initial startup read should be due")
        );

        mark_usage_history_active(
            &db,
            "account-1",
            "2026-06-11",
            "2026-07-21T00:00:00Z",
            "2026-07-21T00:00:00Z",
        )
        .expect("seed initial history checkpoint");

        mark_startup_recent_four_day_usage_read_completed(
            &db,
            "account-1",
            "2026-07-21",
            "2026-07-21T00:00:00Z",
        )
        .expect("mark startup read complete");

        assert!(
            !should_run_startup_recent_four_day_usage_read(&db, "account-1", "2026-07-21")
                .expect("same-day startup read should be skipped")
        );
        assert!(
            should_run_startup_recent_four_day_usage_read(&db, "account-1", "2026-07-22")
                .expect("next-day startup read should be due")
        );

        let state = load_usage_history_state(&db, "account-1")
            .expect("load startup read state")
            .expect("startup read state exists");
        assert_eq!(state.state, UsageHistoryState::Backfilling);
        assert_eq!(state.active_date.as_deref(), Some("2026-06-11"));
        assert_eq!(
            state.recent_reconciled_at.as_deref(),
            Some("2026-07-21T00:00:00Z")
        );
    }

    #[test]
    fn account_delete_cascades_usage_history_state() {
        let db = build_test_db();
        ensure_usage_history_state(&db, "account-1", "2026-07-20T00:00:00Z").expect("create state");

        repositories::delete_account(&db, "account-1").expect("delete account");

        assert!(load_usage_history_state(&db, "account-1")
            .expect("load state after account delete")
            .is_none());
    }

    #[test]
    fn existing_database_is_upgraded_with_usage_history_state_table() {
        let path = std::env::temp_dir().join(format!(
            "api-token-usage-history-state-upgrade-{}.db",
            uuid::Uuid::new_v4()
        ));
        let legacy = rusqlite::Connection::open(&path).expect("open legacy database");
        legacy
            .execute_batch(
                "CREATE TABLE sites (
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
                 CREATE TABLE account_usage_history_states (
                    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                    state TEXT NOT NULL,
                    earliest_date TEXT NULL,
                    completed_through_date TEXT NULL,
                    active_date TEXT NULL,
                    audit_cursor_date TEXT NULL,
                    recent_reconciled_at TEXT NULL,
                    heartbeat_at TEXT NULL,
                    last_error TEXT NULL,
                    updated_at TEXT NOT NULL
                 );
                 INSERT INTO sites VALUES ('site-1', 'legacy', 'https://example.test', '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');
                 INSERT INTO accounts VALUES ('account-1', 'site-1', 'legacy', 'legacy@example.test', -1, NULL, '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z');",
            )
            .expect("seed legacy schema");
        drop(legacy);

        let db = Database::new(path);
        let conn = db.connect().expect("upgrade database");
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'account_usage_history_states'",
                [],
                |row| row.get(0),
            )
            .expect("query history state table");
        assert_eq!(table_count, 1);
        let mut columns = conn
            .prepare("PRAGMA table_info(account_usage_history_states)")
            .expect("prepare history state columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query history state columns")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("collect history state columns");
        columns.sort();
        assert!(columns
            .iter()
            .any(|column| { column == "last_startup_recent_four_day_read_date" }));
        drop(conn);

        let state = ensure_usage_history_state(&db, "account-1", "2026-07-20T00:01:00Z")
            .expect("initialize upgraded history state");
        assert_eq!(state.state, UsageHistoryState::Pending);
    }
}
