use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};

use crate::infrastructure::files::{ensure_no_database_artifact_conflicts, AppPaths};

use super::{schema, Database, DatabaseMigrationPhase, SQLITE_BUSY_TIMEOUT_MS};

/// 将默认目录中的旧 config.db 一致升级为 config.sqlite，源文件始终保留。
pub fn upgrade_legacy_database_if_needed(paths: &AppPaths) -> Result<bool> {
    if paths.db_path.exists() {
        return Ok(false);
    }
    let Some(legacy_path) = paths.legacy_db_path() else {
        return Ok(false);
    };
    if !legacy_path.exists() {
        return Ok(false);
    }

    let staging = staging_path(&paths.db_path);
    let result = (|| -> Result<()> {
        backup_database(&legacy_path, &staging)?;
        validate_snapshot(&staging, false)?;
        if paths.db_path.exists() {
            bail!("升级期间目标 config.sqlite 已被其他进程创建。");
        }
        fs::rename(&staging, &paths.db_path)
            .with_context(|| format!("无法将旧数据库升级为 {}", paths.db_path.display()))?;
        Ok(())
    })();
    if result.is_err() && staging.exists() {
        let _ = fs::remove_file(&staging);
    }
    result?;
    Ok(true)
}

pub(super) fn prepare_live_migration(database: &Database, target_path: &Path) -> Result<()> {
    database.set_migration_phase(
        DatabaseMigrationPhase::ValidatingTarget,
        Some(target_path.to_path_buf()),
    )?;
    let target_directory = target_path.parent().context("目标数据库路径缺少父目录")?;
    if let Err(error) = ensure_no_database_artifact_conflicts(target_directory, None) {
        database.cancel_live_migration(error.to_string())?;
        return Err(error);
    }

    database.set_migration_phase(DatabaseMigrationPhase::FreezingWrites, None)?;
    let freeze_connection = match Connection::open(database.path()) {
        Ok(connection) => connection,
        Err(error) => {
            database.cancel_live_migration(error.to_string())?;
            return Err(error.into());
        }
    };
    if let Err(error) =
        freeze_connection.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
    {
        database.cancel_live_migration(error.to_string())?;
        return Err(error).context("无法配置数据库迁移等待时间");
    }
    if let Err(error) = freeze_connection.execute_batch("BEGIN IMMEDIATE") {
        database.cancel_live_migration(error.to_string())?;
        return Err(error).context("无法等待现有数据库写事务结束");
    }

    let staging = staging_path(target_path);
    let migration_result = (|| -> Result<()> {
        database.set_migration_phase(DatabaseMigrationPhase::BackingUp, None)?;
        backup_database(database.path(), &staging)?;
        database.set_migration_phase(DatabaseMigrationPhase::ValidatingSnapshot, None)?;
        validate_snapshot(&staging, true)?;
        database.set_migration_phase(DatabaseMigrationPhase::SwitchingPointer, None)?;
        ensure_no_database_artifact_conflicts(target_directory, Some(&staging))?;
        fs::rename(&staging, target_path)
            .with_context(|| format!("无法激活目标数据库 {}", target_path.display()))?;
        Ok(())
    })();

    if let Err(error) = migration_result {
        if staging.exists() {
            let _ = fs::remove_file(&staging);
        }
        let _ = freeze_connection.execute_batch("ROLLBACK");
        database.cancel_live_migration(error.to_string())?;
        return Err(error);
    }

    database.retain_frozen_connection(freeze_connection)?;
    Ok(())
}

fn backup_database(source_path: &Path, destination_path: &Path) -> Result<()> {
    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("无法创建数据库迁移目录 {}", parent.display()))?;
    }
    let source = Connection::open_with_flags(
        source_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("无法打开源数据库 {}", source_path.display()))?;
    source.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    let mut destination = Connection::open(destination_path)
        .with_context(|| format!("无法创建迁移快照 {}", destination_path.display()))?;
    {
        let backup =
            Backup::new(&source, &mut destination).context("无法启动 SQLite online backup")?;
        backup
            .run_to_completion(128, Duration::from_millis(10), None)
            .context("SQLite online backup 失败")?;
    }
    drop(destination);
    drop(source);
    Ok(())
}

fn validate_snapshot(path: &Path, strict: bool) -> Result<()> {
    let mut connection =
        Connection::open(path).with_context(|| format!("无法打开迁移快照 {}", path.display()))?;
    connection.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    schema::apply(&mut connection).context("迁移快照结构升级失败")?;
    schema::verify_integrity(&connection).context("迁移快照完整性检查失败")?;
    schema::verify_foreign_keys(&connection).context("迁移快照外键检查失败")?;
    schema::verify_schema_documentation(&connection, strict)
        .context("迁移快照结构元数据检查失败")?;
    connection.execute_batch("PRAGMA optimize")?;
    Ok(())
}

fn staging_path(target_path: &Path) -> PathBuf {
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config.sqlite");
    target_path.with_file_name(format!("{file_name}.migrating-{}", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::files::{
        RuntimeScope, DATABASE_FILE_NAME, LEGACY_DATABASE_FILE_NAME,
        RUNTIME_COORDINATION_DATABASE_FILE_NAME, STORAGE_BOOTSTRAP_FILE_NAME,
    };

    #[test]
    fn strict_snapshot_validation_rejects_unknown_tables() {
        let path = std::env::temp_dir().join(format!(
            "input-panel-strict-snapshot-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let mut connection = Connection::open(&path).expect("open snapshot fixture");
        schema::apply(&mut connection).expect("create current schema");
        connection
            .execute(
                "CREATE TABLE unexpected_runtime_table (id TEXT PRIMARY KEY)",
                [],
            )
            .expect("create unexpected table");
        drop(connection);

        let error = validate_snapshot(&path, true)
            .expect_err("strict snapshot should reject unknown tables");

        assert!(format!("{error:#}").contains("现役表集合"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_wal_database_upgrades_consistently_and_keeps_source() {
        let base = std::env::temp_dir().join(format!(
            "input-panel-legacy-wal-upgrade-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("input_panel");
        let config_dir = root.join("web");
        let coordination_root = root.join("coordination");
        let paths = AppPaths {
            root,
            coordination_db_path: coordination_root.join(RUNTIME_COORDINATION_DATABASE_FILE_NAME),
            coordination_root,
            config_dir: config_dir.clone(),
            db_path: config_dir.join(DATABASE_FILE_NAME),
            storage_config_path: config_dir.join(STORAGE_BOOTSTRAP_FILE_NAME),
            runtime_scope: RuntimeScope::Web,
            user_directory: config_dir.clone(),
            program_directory: base.join("program"),
            override_active: false,
            storage_configured: false,
        };
        paths.ensure().expect("create legacy database directory");
        let legacy_path = config_dir.join(LEGACY_DATABASE_FILE_NAME);
        let mut legacy = Connection::open(&legacy_path).expect("open legacy database");
        legacy
            .pragma_update(None, "journal_mode", "WAL")
            .expect("enable legacy WAL");
        schema::apply(&mut legacy).expect("initialize legacy schema");
        legacy
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;")
            .expect("prepare an uncheckpointed WAL fixture");
        legacy
            .execute(
                "INSERT INTO sites (id, name, base_url, created_at, updated_at)
                 VALUES ('legacy-wal-site', '旧 WAL 站点', 'https://legacy.example.test',
                         '2026-07-26 09:00:00', '2026-07-26 09:00:00')",
                [],
            )
            .expect("write committed legacy WAL row");
        let legacy_wal_path = legacy_path.with_extension("db-wal");
        assert!(legacy_wal_path.exists());
        assert!(
            fs::metadata(&legacy_wal_path)
                .expect("read legacy WAL metadata")
                .len()
                > 0
        );

        assert!(upgrade_legacy_database_if_needed(&paths).expect("upgrade legacy WAL database"));
        assert!(legacy_path.exists());
        assert!(paths.db_path.exists());
        let upgraded = Connection::open(&paths.db_path).expect("open upgraded database");
        let upgraded_name: String = upgraded
            .query_row(
                "SELECT name FROM sites WHERE id = 'legacy-wal-site'",
                [],
                |row| row.get(0),
            )
            .expect("read legacy WAL row from upgraded database");
        assert_eq!(upgraded_name, "旧 WAL 站点");
        assert!(!upgrade_legacy_database_if_needed(&paths).expect("repeat legacy upgrade"));

        let restarted = Database::new(paths.db_path.clone());
        let restarted_connection = restarted.connect().expect("start from config.sqlite");
        let restarted_count: i64 = restarted_connection
            .query_row(
                "SELECT COUNT(*) FROM sites WHERE id = 'legacy-wal-site'",
                [],
                |row| row.get(0),
            )
            .expect("read upgraded row after restart");
        assert_eq!(restarted_count, 1);

        drop(restarted_connection);
        drop(upgraded);
        drop(legacy);
        let _ = fs::remove_dir_all(base);
    }
}
