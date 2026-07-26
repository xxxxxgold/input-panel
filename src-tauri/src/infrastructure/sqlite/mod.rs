pub mod migration;
pub mod repositories;
pub mod schema;
mod schema_metadata;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::Connection;

const SQLITE_BUSY_TIMEOUT_MS: u64 = 15_000;
const SQLITE_CACHE_SIZE_KIB: i64 = -4_096;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseMigrationPhase {
    Idle,
    ValidatingTarget,
    FreezingWrites,
    BackingUp,
    ValidatingSnapshot,
    SwitchingPointer,
    RestartRequired,
}

impl DatabaseMigrationPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::ValidatingTarget => "validating_target",
            Self::FreezingWrites => "freezing_writes",
            Self::BackingUp => "backing_up",
            Self::ValidatingSnapshot => "validating_snapshot",
            Self::SwitchingPointer => "switching_pointer",
            Self::RestartRequired => "restart_required",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DatabaseMigrationSnapshot {
    pub phase: DatabaseMigrationPhase,
    pub target_path: Option<PathBuf>,
    pub last_error: Option<String>,
}

struct DatabaseMigrationState {
    phase: DatabaseMigrationPhase,
    target_path: Option<PathBuf>,
    last_error: Option<String>,
    frozen_connection: Option<Connection>,
}

impl Default for DatabaseMigrationState {
    fn default() -> Self {
        Self {
            phase: DatabaseMigrationPhase::Idle,
            target_path: None,
            last_error: None,
            frozen_connection: None,
        }
    }
}

#[derive(Clone)]
pub struct Database {
    db_path: PathBuf,
    initialized: Arc<Mutex<bool>>,
    migration: Arc<Mutex<DatabaseMigrationState>>,
}

impl fmt::Debug for Database {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Database")
            .field("db_path", &self.db_path)
            .finish_non_exhaustive()
    }
}

impl Database {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            initialized: Arc::new(Mutex::new(false)),
            migration: Arc::new(Mutex::new(DatabaseMigrationState::default())),
        }
    }

    pub fn connect(&self) -> Result<Connection> {
        self.ensure_requests_available()?;
        let mut conn = Connection::open(&self.db_path)?;
        configure_connection(&conn)?;
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| anyhow!("database init mutex poisoned"))?;
        if !*initialized {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(
                None,
                "wal_autocheckpoint",
                SQLITE_WAL_AUTOCHECKPOINT_PAGES,
            )?;
            schema::apply(&mut conn)
                .with_context(|| format!("无法初始化数据库结构 {}", self.db_path.display()))?;
            schema::verify_integrity(&conn)
                .with_context(|| format!("数据库完整性检查失败 {}", self.db_path.display()))?;
            schema::verify_foreign_keys(&conn)
                .with_context(|| format!("数据库外键检查失败 {}", self.db_path.display()))?;
            *initialized = true;
        }
        Ok(conn)
    }

    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }

    pub fn migration_phase(&self) -> Result<DatabaseMigrationPhase> {
        let state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        Ok(state.phase)
    }

    /// 一次加锁读取迁移状态，避免状态接口拼出跨 phase 的字段组合。
    pub fn migration_snapshot(&self) -> Result<DatabaseMigrationSnapshot> {
        let state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        Ok(DatabaseMigrationSnapshot {
            phase: state.phase,
            target_path: state.target_path.clone(),
            last_error: state.last_error.clone(),
        })
    }

    pub fn migration_target_path(&self) -> Result<Option<PathBuf>> {
        let state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        Ok(state.target_path.clone())
    }

    pub fn migration_last_error(&self) -> Result<Option<String>> {
        let state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        Ok(state.last_error.clone())
    }

    pub fn restart_required(&self) -> Result<bool> {
        Ok(self.migration_phase()? == DatabaseMigrationPhase::RestartRequired)
    }

    /// 在创建后台任务或连接前统一执行迁移状态门禁。
    pub fn ensure_requests_available(&self) -> Result<()> {
        let phase = self.migration_phase()?;
        if phase != DatabaseMigrationPhase::Idle {
            bail_for_migration_phase(phase)?;
        }
        Ok(())
    }

    /// 创建经过完整校验的目标数据库，并保持源库写冻结等待 bootstrap 切换。
    pub fn prepare_live_migration(&self, target_path: &Path) -> Result<()> {
        migration::prepare_live_migration(self, target_path)
    }

    /// bootstrap 已切换后保持源库冻结，直到当前进程退出。
    pub fn mark_restart_required(&self) -> Result<()> {
        let mut state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        if state.phase != DatabaseMigrationPhase::SwitchingPointer
            || state.frozen_connection.is_none()
        {
            bail!("数据库迁移尚未完成目标切换，不能进入重启等待状态。");
        }
        state.phase = DatabaseMigrationPhase::RestartRequired;
        Ok(())
    }

    /// bootstrap 更新失败时解除源库冻结，当前进程继续使用源库。
    pub fn cancel_live_migration(&self, reason: impl Into<String>) -> Result<()> {
        let reason = reason.into();
        let mut state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        if let Some(connection) = state.frozen_connection.take() {
            connection
                .execute_batch("ROLLBACK")
                .context("解除数据库迁移写冻结失败")?;
        }
        state.phase = DatabaseMigrationPhase::Idle;
        state.target_path = None;
        state.last_error = Some(reason);
        Ok(())
    }

    pub(crate) fn set_migration_phase(
        &self,
        phase: DatabaseMigrationPhase,
        target_path: Option<PathBuf>,
    ) -> Result<()> {
        let mut state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        if phase == DatabaseMigrationPhase::ValidatingTarget
            && state.phase != DatabaseMigrationPhase::Idle
        {
            bail!("数据库迁移正在进行，请勿重复提交。");
        }
        state.phase = phase;
        if target_path.is_some() {
            state.target_path = target_path;
        }
        state.last_error = None;
        Ok(())
    }

    pub(crate) fn retain_frozen_connection(&self, connection: Connection) -> Result<()> {
        let mut state = self
            .migration
            .lock()
            .map_err(|_| anyhow!("database migration mutex poisoned"))?;
        state.frozen_connection = Some(connection);
        state.phase = DatabaseMigrationPhase::SwitchingPointer;
        Ok(())
    }
}

fn configure_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // WAL 模式下 NORMAL 即可保证进程崩溃不丢已提交事务；FULL 每次提交强制 fsync，
    // 对高频后台同步写放大明显。
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", SQLITE_CACHE_SIZE_KIB)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(
        None,
        "wal_autocheckpoint",
        SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    )?;
    Ok(())
}

fn bail_for_migration_phase(phase: DatabaseMigrationPhase) -> Result<()> {
    if phase == DatabaseMigrationPhase::RestartRequired {
        bail!("数据库已迁移完成，请重启应用或 Rust 后端后继续操作。");
    }
    bail!("数据库正在迁移，当前暂不接受新的数据库请求。");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

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
        let synchronous: i64 = conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .expect("read synchronous");
        let cache_size: i64 = conn
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .expect("read cache_size");
        let temp_store: i64 = conn
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .expect("read temp_store");
        let wal_autocheckpoint: i64 = conn
            .pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))
            .expect("read wal_autocheckpoint");

        assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT_MS as i64);
        assert_eq!(journal_mode.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 1);
        assert_eq!(cache_size, SQLITE_CACHE_SIZE_KIB);
        assert_eq!(temp_store, 2);
        assert_eq!(wal_autocheckpoint, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
    }

    #[test]
    fn connect_does_not_create_task_runs_table() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-no-task-runs-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let conn = db.connect().expect("connect sqlite db");
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_runs'",
                [],
                |row| row.get(0),
            )
            .expect("query task_runs table count");

        assert_eq!(table_count, 0);
    }

    #[test]
    fn connect_is_idempotent_after_schema_initialization() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-idempotent-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);

        let first = db.connect().expect("first sqlite connect");
        drop(first);
        let second = db.connect().expect("second sqlite connect");
        let table_count: i64 = second
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sites'",
                [],
                |row| row.get(0),
            )
            .expect("query sites table count");

        assert_eq!(table_count, 1);
    }

    #[test]
    fn connect_rejects_corrupted_database_without_replacing_the_file() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-corrupted-{}.db",
            uuid::Uuid::new_v4()
        ));
        let original = b"not a sqlite database";
        fs::write(&db_path, original).expect("seed corrupted database file");

        let error = Database::new(db_path.clone())
            .connect()
            .expect_err("corrupted database should fail startup");

        assert!(
            error.to_string().contains("database") || error.to_string().contains("SQLite"),
            "unexpected database error: {error}"
        );
        assert_eq!(
            fs::read(&db_path).expect("read original corrupted database"),
            original
        );
    }

    #[test]
    fn connect_returns_error_when_init_mutex_is_poisoned() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-poisoned-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let poisoned = Arc::new(Mutex::new(false));
        let poisoned_for_thread = Arc::clone(&poisoned);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned_for_thread.lock().expect("lock poison setup");
            panic!("poison init mutex");
        })
        .join();
        let db = Database {
            db_path: db.path().clone(),
            initialized: poisoned,
            migration: db.migration.clone(),
        };

        let error = db.connect().expect_err("poisoned init mutex should return error");

        assert!(error.to_string().contains("database init mutex poisoned"));
    }
}
