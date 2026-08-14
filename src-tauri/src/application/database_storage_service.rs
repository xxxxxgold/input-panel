use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use crate::contracts::{
    DatabaseStorageMigrationInput, DatabaseStorageMigrationResult, DatabaseStorageStatus,
};
use crate::infrastructure::files::DATABASE_FILE_NAME;

use super::AppContext;

/// 返回不依赖新数据库连接的存储状态，迁移冻结后仍可安全读取。
pub fn get_database_storage_status(ctx: &AppContext) -> Result<DatabaseStorageStatus> {
    let migration = ctx.db.migration_snapshot()?;
    let current_directory = ctx.paths.current_directory()?;
    let target_directory = migration
        .target_path
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or(current_directory);

    Ok(DatabaseStorageStatus {
        runtime_scope: ctx.paths.runtime_scope.as_str().to_string(),
        current_database_path: path_text(ctx.db.path()),
        current_directory: path_text(current_directory),
        user_directory: path_text(&ctx.paths.user_directory),
        program_directory: path_text(&ctx.paths.program_directory),
        target_directory: path_text(target_directory),
        override_active: ctx.paths.override_active,
        migration_supported: !ctx.paths.override_active,
        migration_phase: migration.phase.as_str().to_string(),
        restart_required: migration.phase
            == crate::infrastructure::sqlite::DatabaseMigrationPhase::RestartRequired,
        last_error: migration.last_error,
    })
}

/// 创建一致快照并切换外置引导配置；当前进程仅进入重启等待，不做热切换。
pub fn migrate_database_storage(
    ctx: &AppContext,
    input: DatabaseStorageMigrationInput,
) -> Result<DatabaseStorageMigrationResult> {
    let target_directory_text = input.target_directory.trim();
    if target_directory_text.is_empty() {
        return Err(anyhow!("数据库存储目录不能为空。"));
    }
    let target_directory = ctx
        .paths
        .validate_target_directory(&PathBuf::from(target_directory_text))?;
    let target_path = target_directory.join(DATABASE_FILE_NAME);
    let source_path = ctx.db.path().clone();

    ctx.db
        .prepare_live_migration(&target_path)
        .context("创建数据库一致迁移快照失败")?;
    if let Err(error) = ctx.paths.write_storage_directory(&target_directory) {
        let message = format!("原子更新数据库引导配置失败: {error:#}");
        ctx.db
            .cancel_live_migration(message.clone())
            .context("数据库引导配置失败后解除源库冻结失败")?;
        return Err(anyhow!(message));
    }
    ctx.db
        .mark_restart_required()
        .context("数据库已迁移但无法进入重启等待状态")?;

    Ok(DatabaseStorageMigrationResult {
        source_path: path_text(&source_path),
        target_path: path_text(&target_path),
        source_retained: source_path.exists(),
        bootstrap_updated: true,
        restart_required: true,
    })
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Arc;

    use tokio::sync::Mutex;

    use super::*;
    use crate::application::context::SyncTaskHandle;
    use crate::application::resource_coordinator::ResourceCoordinator;
    use crate::infrastructure::files::{
        AppPaths, RuntimeScope, RUNTIME_COORDINATION_DATABASE_FILE_NAME,
        STORAGE_BOOTSTRAP_FILE_NAME,
    };
    use crate::infrastructure::sqlite::{Database, DatabaseMigrationPhase};

    fn build_test_context(paths: AppPaths) -> AppContext {
        paths.ensure().expect("create source directories");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize source database");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: ResourceCoordinator::default(),
            native_notifications_enabled: false,
        }
    }

    fn build_web_test_context() -> (AppContext, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "input-panel-storage-service-{}",
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
            user_directory: config_dir,
            program_directory: base.join("program"),
            override_active: false,
            storage_configured: false,
        };
        (build_test_context(paths), base)
    }

    #[test]
    fn live_migration_preserves_wal_data_and_switches_bootstrap() {
        let (ctx, base) = build_web_test_context();
        let source_path = ctx.db.path().clone();
        // 用池外连接保留未 checkpoint WAL；池内借出连接必须在迁移冻结前归还。
        let source_connection =
            rusqlite::Connection::open(&source_path).expect("open live source connection");
        source_connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("enable source WAL");
        source_connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;")
            .expect("prepare uncheckpointed WAL fixture");
        source_connection
            .execute(
                "INSERT INTO sites (id, name, base_url, created_at, updated_at)
                 VALUES ('site-wal', 'WAL 站点', 'https://example.test',
                         '2026-07-26 10:00:00', '2026-07-26 10:00:00')",
                [],
            )
            .expect("write committed WAL row");
        let wal_path = source_path.with_extension("sqlite-wal");
        assert!(wal_path.exists(), "source WAL fixture should exist");
        assert!(
            fs::metadata(&wal_path)
                .expect("read source WAL metadata")
                .len()
                > 0,
            "source WAL fixture should contain the committed row"
        );
        let target_directory = base.join("migrated-data");

        let result = migrate_database_storage(
            &ctx,
            DatabaseStorageMigrationInput {
                target_directory: path_text(&target_directory),
            },
        )
        .expect("migrate live database");

        let canonical_target = fs::canonicalize(&target_directory).expect("canonical target");
        let target_path = canonical_target.join(DATABASE_FILE_NAME);
        assert_eq!(result.source_path, path_text(&source_path));
        assert_eq!(result.target_path, path_text(&target_path));
        assert!(result.source_retained);
        assert!(result.bootstrap_updated);
        assert!(result.restart_required);
        assert!(source_path.exists());
        assert!(target_path.exists());
        let target = rusqlite::Connection::open(&target_path).expect("open migrated target");
        let site_name: String = target
            .query_row("SELECT name FROM sites WHERE id = 'site-wal'", [], |row| {
                row.get(0)
            })
            .expect("read migrated WAL row");
        assert_eq!(site_name, "WAL 站点");

        let bootstrap: serde_json::Value = serde_json::from_slice(
            &fs::read(&ctx.paths.storage_config_path).expect("read storage bootstrap"),
        )
        .expect("decode storage bootstrap");
        assert_eq!(
            bootstrap["databaseDirectory"].as_str(),
            Some(path_text(&canonical_target).as_str())
        );
        let status = get_database_storage_status(&ctx).expect("read restart status");
        assert_eq!(status.migration_phase, "restart_required");
        assert!(status.restart_required);
        assert_eq!(status.target_directory, path_text(&canonical_target));
        assert!(ctx
            .db
            .connect()
            .expect_err("restart state must reject new connections")
            .to_string()
            .contains("请重启"));

        drop(target);
        drop(source_connection);
        drop(ctx);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn bootstrap_update_failure_unfreezes_source_and_keeps_pointer_unchanged() {
        let (mut ctx, base) = build_web_test_context();
        let source_path = ctx.db.path().clone();
        let blocked_parent = base.join("blocked-bootstrap-parent");
        fs::write(&blocked_parent, b"not-a-directory").expect("create bootstrap blocker");
        ctx.paths.storage_config_path = blocked_parent.join(STORAGE_BOOTSTRAP_FILE_NAME);
        let target_directory = base.join("failed-bootstrap-target");

        let error = migrate_database_storage(
            &ctx,
            DatabaseStorageMigrationInput {
                target_directory: path_text(&target_directory),
            },
        )
        .expect_err("bootstrap update should fail");

        assert!(format!("{error:#}").contains("原子更新数据库引导配置失败"));
        let migration = ctx.db.migration_snapshot().expect("read migration state");
        assert_eq!(migration.phase, DatabaseMigrationPhase::Idle);
        assert!(migration.target_path.is_none());
        assert!(migration
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("原子更新数据库引导配置失败")));
        assert_eq!(ctx.db.path(), &source_path);
        assert!(!ctx.paths.storage_config_path.exists());

        let source = ctx
            .db
            .connect()
            .expect("source database should be available again");
        source
            .execute(
                "INSERT INTO sites (id, name, base_url, created_at, updated_at)
                 VALUES ('site-after-rollback', '回滚后站点', 'https://example.test',
                         '2026-07-26 11:00:00', '2026-07-26 11:00:00')",
                [],
            )
            .expect("source database should accept writes after rollback");
        let inserted: i64 = source
            .query_row(
                "SELECT COUNT(*) FROM sites WHERE id = 'site-after-rollback'",
                [],
                |row| row.get(0),
            )
            .expect("read source row after rollback");
        assert_eq!(inserted, 1);

        drop(source);
        drop(ctx);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn isolated_override_reports_status_and_rejects_migration_before_freezing() {
        let base = std::env::temp_dir().join(format!(
            "input-panel-storage-override-{}",
            uuid::Uuid::new_v4()
        ));
        let ctx = build_test_context(AppPaths::from_root(base.clone()));
        let source_path = ctx.db.path().clone();
        let target_directory = base.join("rejected-target");

        let status = get_database_storage_status(&ctx).expect("read isolated storage status");
        assert_eq!(status.runtime_scope, "isolated");
        assert!(status.override_active);
        assert!(!status.migration_supported);

        let error = migrate_database_storage(
            &ctx,
            DatabaseStorageMigrationInput {
                target_directory: path_text(&target_directory),
            },
        )
        .expect_err("isolated override should reject migration");

        assert!(error
            .to_string()
            .contains("当前运行实例不允许修改数据库目录"));
        let migration = ctx.db.migration_snapshot().expect("read migration state");
        assert_eq!(migration.phase, DatabaseMigrationPhase::Idle);
        assert!(migration.target_path.is_none());
        assert_eq!(ctx.db.path(), &source_path);
        assert!(!target_directory.exists());
        assert!(!ctx.paths.storage_config_path.exists());

        drop(ctx);
        let _ = fs::remove_dir_all(base);
    }
}
