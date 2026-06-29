pub mod repositories;
pub mod schema;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use rusqlite::Connection;

const SQLITE_BUSY_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone)]
pub struct Database {
    db_path: PathBuf,
    initialized: Arc<Mutex<bool>>,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            initialized: Arc::new(Mutex::new(false)),
        }
    }

    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut initialized = self
            .initialized
            .lock()
            .expect("database init mutex poisoned");
        if !*initialized {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            schema::apply(&conn)?;
            *initialized = true;
        }
        Ok(conn)
    }

    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn connect_enables_busy_timeout_and_wal() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let conn = db.connect().expect("connect sqlite db");

        let busy_timeout: i64 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .expect("read busy_timeout");
        let journal_mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .expect("read journal_mode");
        let foreign_keys: i64 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("read foreign_keys");

        assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT_MS as i64);
        assert_eq!(journal_mode.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn connect_migrates_legacy_task_runs_scope_column() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-legacy-task-runs-{}.db",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&db_path).expect("open raw sqlite db");
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;
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
            CREATE TABLE task_runs (
              id TEXT PRIMARY KEY,
              account_id TEXT NOT NULL,
              primary_trigger_source TEXT NOT NULL,
              status TEXT NOT NULL,
              join_count INTEGER NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT NULL,
              error_message TEXT NULL
            );
            "#,
        )
        .expect("seed legacy schema");
        drop(conn);

        let db = Database::new(db_path);
        let conn = db.connect().expect("connect migrated sqlite db");
        let mut stmt = conn
            .prepare("PRAGMA table_info(task_runs)")
            .expect("prepare table info");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect column names");

        assert!(columns.iter().any(|name| name == "scope"));
    }
}
