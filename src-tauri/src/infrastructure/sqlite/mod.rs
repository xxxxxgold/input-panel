pub mod migration;
pub mod repositories;
pub mod schema;
mod schema_metadata;

use std::fmt;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::Connection;

const SQLITE_BUSY_TIMEOUT_MS: u64 = 15_000;
const SQLITE_CACHE_SIZE_KIB: i64 = -4_096;
const SQLITE_MMAP_SIZE_BYTES: i64 = 268_435_456;
const SQLITE_WAL_AUTOCHECKPOINT_PAGES: i64 = 1_000;
const CONNECTION_POOL_MAX_IDLE: usize = 4;

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

struct ConnectionPool {
    idle: Vec<Connection>,
    generation: u64,
    checked_out: usize,
    frozen: bool,
}

impl Default for ConnectionPool {
    fn default() -> Self {
        Self {
            idle: Vec::new(),
            generation: 0,
            checked_out: 0,
            frozen: false,
        }
    }
}

struct SharedConnectionPool {
    state: Mutex<ConnectionPool>,
    all_returned: Condvar,
}

impl Default for SharedConnectionPool {
    fn default() -> Self {
        Self {
            state: Mutex::new(ConnectionPool::default()),
            all_returned: Condvar::new(),
        }
    }
}

/// 复用底层连接的守卫；Drop 时归还池中，保证页缓存跨调用存活。
pub struct PooledConnection {
    conn: Option<Connection>,
    generation: u64,
    pool: Arc<SharedConnectionPool>,
}

impl fmt::Debug for PooledConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PooledConnection")
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl Deref for PooledConnection {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("pooled connection already taken")
    }
}

impl DerefMut for PooledConnection {
    fn deref_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("pooled connection already taken")
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        let conn = self.conn.take();
        if let Ok(mut pool) = self.pool.state.lock() {
            pool.checked_out = pool.checked_out.saturating_sub(1);
            if let Some(conn) = conn {
                // 残留未提交事务的连接不可复用；迁移期间代际已推进的连接直接关闭。
                if conn.is_autocommit()
                    && pool.generation == self.generation
                    && pool.idle.len() < CONNECTION_POOL_MAX_IDLE
                {
                    pool.idle.push(conn);
                }
            }
            if pool.checked_out == 0 {
                self.pool.all_returned.notify_all();
            }
        }
    }
}

#[derive(Clone)]
pub struct Database {
    db_path: PathBuf,
    initialized: Arc<Mutex<bool>>,
    migration: Arc<Mutex<DatabaseMigrationState>>,
    pool: Arc<SharedConnectionPool>,
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
            pool: Arc::new(SharedConnectionPool::default()),
        }
    }

    pub fn connect(&self) -> Result<PooledConnection> {
        self.ensure_requests_available()?;
        let (conn, generation) = {
            let mut pool = self
                .pool
                .state
                .lock()
                .map_err(|_| anyhow!("database pool mutex poisoned"))?;
            if pool.frozen {
                bail!("数据库正在迁移，当前暂不接受新的数据库请求。");
            }
            let conn = match pool.idle.pop() {
                Some(conn) => conn,
                None => {
                    let conn = Connection::open(&self.db_path)?;
                    configure_connection(&conn)?;
                    conn
                }
            };
            let generation = pool.generation;
            pool.checked_out += 1;
            (conn, generation)
        };
        let mut pooled_conn = PooledConnection {
            conn: Some(conn),
            generation,
            pool: Arc::clone(&self.pool),
        };
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| anyhow!("database init mutex poisoned"))?;
        if !*initialized {
            pooled_conn.pragma_update(None, "journal_mode", "WAL")?;
            pooled_conn.pragma_update(
                None,
                "wal_autocheckpoint",
                SQLITE_WAL_AUTOCHECKPOINT_PAGES,
            )?;
            schema::apply(&mut pooled_conn)
                .with_context(|| format!("无法初始化数据库结构 {}", self.db_path.display()))?;
            *initialized = true;
        }
        drop(initialized);
        Ok(pooled_conn)
    }

    /// 作废空闲连接；已借出连接归还时按代际丢弃。
    fn invalidate_pool(&self) -> Result<()> {
        let mut pool = self
            .pool
            .state
            .lock()
            .map_err(|_| anyhow!("database pool mutex poisoned"))?;
        pool.generation = pool.generation.wrapping_add(1);
        pool.idle.clear();
        pool.frozen = false;
        self.pool.all_returned.notify_all();
        Ok(())
    }

    /// 迁移写冻结前等待所有已借出连接归还，防止旧连接越过迁移门禁继续执行 SQL。
    fn freeze_pool(&self) -> Result<()> {
        let mut pool = self
            .pool
            .state
            .lock()
            .map_err(|_| anyhow!("database pool mutex poisoned"))?;
        pool.generation = pool.generation.wrapping_add(1);
        pool.idle.clear();
        pool.frozen = true;
        let deadline = Instant::now() + Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS);
        while pool.checked_out > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                pool.frozen = false;
                self.pool.all_returned.notify_all();
                bail!("等待现有数据库请求结束超时，请稍后重试迁移。");
            }
            let (next_pool, wait_result) = self
                .pool
                .all_returned
                .wait_timeout(pool, remaining)
                .map_err(|_| anyhow!("database pool mutex poisoned"))?;
            pool = next_pool;
            if wait_result.timed_out() && pool.checked_out > 0 {
                pool.frozen = false;
                self.pool.all_returned.notify_all();
                bail!("等待现有数据库请求结束超时，请稍后重试迁移。");
            }
        }
        Ok(())
    }

    pub fn checkpoint_wal_truncate(&self) -> Result<bool> {
        let conn = self.connect()?;
        let (busy, _, _) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        Ok(busy == 0)
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
        self.invalidate_pool()?;
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
        if phase == DatabaseMigrationPhase::ValidatingTarget {
            if state.phase != DatabaseMigrationPhase::Idle {
                bail!("数据库迁移正在进行，请勿重复提交。");
            }
            // 迁移开始后先封池并等待已借出连接归还，再允许写冻结进入 SQLite。
            drop(state);
            self.freeze_pool()?;
            state = self
                .migration
                .lock()
                .map_err(|_| anyhow!("database migration mutex poisoned"))?;
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
    // 迁移与普通写入共用可靠性基线，避免系统崩溃时丢失已提交事务。
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "cache_size", SQLITE_CACHE_SIZE_KIB)?;
    conn.pragma_update(None, "mmap_size", SQLITE_MMAP_SIZE_BYTES)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "wal_autocheckpoint", SQLITE_WAL_AUTOCHECKPOINT_PAGES)?;
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
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::Mutex;

    #[test]
    fn connect_enables_busy_timeout_and_wal() {
        let db_path =
            std::env::temp_dir().join(format!("api-token-sqlite-{}.db", uuid::Uuid::new_v4()));
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
        let mmap_size: i64 = conn
            .pragma_query_value(None, "mmap_size", |row| row.get(0))
            .expect("read mmap_size");

        assert_eq!(busy_timeout, SQLITE_BUSY_TIMEOUT_MS as i64);
        assert_eq!(journal_mode.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 2);
        assert_eq!(cache_size, SQLITE_CACHE_SIZE_KIB);
        assert_eq!(temp_store, 2);
        assert_eq!(wal_autocheckpoint, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
        assert_eq!(mmap_size, SQLITE_MMAP_SIZE_BYTES);
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
    fn runtime_connect_skips_full_integrity_scan_but_explicit_check_detects_corruption() {
        let db_path = std::env::temp_dir().join(format!(
            "input-panel-runtime-integrity-boundary-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path.clone());
        let conn = db.connect().expect("initialize sqlite db");
        conn.execute(
            "CREATE TABLE runtime_integrity_probe (id INTEGER PRIMARY KEY, payload TEXT)",
            [],
        )
        .expect("create integrity probe table");
        conn.execute(
            "INSERT INTO runtime_integrity_probe (payload) VALUES ('probe')",
            [],
        )
        .expect("seed integrity probe table");
        let page_size: u64 = conn
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .expect("read sqlite page size");
        let root_page: u64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name = 'runtime_integrity_probe'",
                [],
                |row| row.get(0),
            )
            .expect("read integrity probe root page");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint integrity probe fixture");
        drop(conn);
        drop(db);

        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&db_path)
            .expect("open integrity probe database");
        file.seek(SeekFrom::Start((root_page - 1) * page_size))
            .expect("seek integrity probe root page");
        file.write_all(&[0])
            .expect("corrupt integrity probe root page");
        file.sync_all().expect("flush integrity probe corruption");
        drop(file);

        let db = Database::new(db_path);
        let conn = db
            .connect()
            .expect("runtime initialization should not scan unrelated data pages");
        let error = schema::verify_integrity(&conn)
            .expect_err("explicit integrity validation should detect the corrupted data page");

        assert!(error.to_string().contains("integrity_check"));
    }

    #[test]
    fn connect_reuses_pooled_connection_after_drop() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-pool-reuse-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);

        let first = db.connect().expect("first sqlite connect");
        drop(first);
        {
            let pool = db.pool.state.lock().expect("lock pool");
            assert_eq!(pool.idle.len(), 1, "dropped connection should be pooled");
        }
        let second = db.connect().expect("second sqlite connect");
        {
            let pool = db.pool.state.lock().expect("lock pool");
            assert!(pool.idle.is_empty(), "pooled connection should be borrowed");
        }
        drop(second);
        let pool = db.pool.state.lock().expect("lock pool");
        assert_eq!(pool.idle.len(), 1);
    }

    #[test]
    fn connect_discards_connection_with_open_transaction() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-pool-dirty-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);

        let conn = db.connect().expect("connect sqlite db");
        conn.execute_batch("BEGIN IMMEDIATE")
            .expect("open transaction");
        drop(conn);

        let pool = db.pool.state.lock().expect("lock pool");
        assert!(
            pool.idle.is_empty(),
            "connection with open transaction must not be pooled"
        );
    }

    #[test]
    fn pool_invalidation_discards_idle_and_borrowed_connections() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-pool-invalidate-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);

        let seed = db.connect().expect("seed pool");
        drop(seed);
        let borrowed = db.connect().expect("borrow pooled connection");
        db.invalidate_pool().expect("invalidate pool");
        drop(borrowed);

        let pool = db.pool.state.lock().expect("lock pool");
        assert!(
            pool.idle.is_empty(),
            "stale-generation connection must be discarded on return"
        );
    }

    #[test]
    fn pool_freeze_waits_until_borrowed_connection_returns() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-sqlite-pool-freeze-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let borrowed = db.connect().expect("borrow sqlite connection");
        let db_for_freeze = db.clone();
        let freeze_task = std::thread::spawn(move || {
            db_for_freeze
                .set_migration_phase(DatabaseMigrationPhase::ValidatingTarget, None)
                .map(|_| db_for_freeze)
        });

        let became_frozen = (0..1_000).any(|_| {
            let frozen = db.pool.state.lock().expect("lock pool").frozen;
            if !frozen {
                std::thread::sleep(Duration::from_millis(1));
            }
            frozen
        });
        let waited_for_borrowed_connection = !freeze_task.is_finished();
        drop(borrowed);
        let frozen_db = freeze_task
            .join()
            .expect("join pool freeze task")
            .expect("freeze pool after borrowed connection returns");

        assert!(became_frozen, "migration should close the pool gate");
        assert!(
            waited_for_borrowed_connection,
            "migration must wait for already borrowed connections"
        );
        frozen_db
            .cancel_live_migration("test cleanup")
            .expect("unfreeze pool after test");
        frozen_db
            .connect()
            .expect("pool should accept requests again");
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
            pool: db.pool.clone(),
        };

        let error = db
            .connect()
            .expect_err("poisoned init mutex should return error");

        assert!(error.to_string().contains("database init mutex poisoned"));
    }
}
