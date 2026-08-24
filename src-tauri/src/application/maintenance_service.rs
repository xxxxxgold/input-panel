use anyhow::Result;

use crate::infrastructure::sqlite::repositories;

use super::AppContext;

/// 清理事务期间阻止额度提醒投递，避免清理后的事件继续外发。
pub async fn clear_runtime_data(ctx: &AppContext, remove_sites_and_accounts: bool) -> Result<bool> {
    let _delivery_guard = ctx
        .live_resources
        .acquire_subscription_quota_alert_delivery_write_gate()
        .await;
    repositories::clear_runtime_data(&ctx.db, remove_sites_and_accounts)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::Mutex;

    use super::*;
    use crate::application::context::SyncTaskHandle;
    use crate::application::resource_coordinator::ResourceCoordinator;
    use crate::application::runtime_coordination_service::RuntimeCoordinationService;
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::repositories;
    use crate::infrastructure::sqlite::Database;

    struct TestContext {
        ctx: AppContext,
        root: std::path::PathBuf,
    }

    impl Drop for TestContext {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn build_context() -> TestContext {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tmp")
            .join(format!("maintenance-service-{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("ensure test paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize sqlite");
        TestContext {
            ctx: AppContext {
                runtime_coordination: RuntimeCoordinationService::from_paths_for_test(&paths)
                    .expect("initialize test runtime coordination"),
                paths,
                db,
                sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
                live_resources: ResourceCoordinator::default(),
                native_notifications_enabled: false,
            },
            root,
        }
    }

    fn seed_site_and_account(ctx: &AppContext) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-1".into(),
                name: "测试站点".into(),
                base_url: "https://example.test".into(),
                created_at: "2026-08-20 00:00:00".into(),
                updated_at: "2026-08-20 00:00:00".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "测试账号".into(),
                email: "quota@example.test".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-08-20 00:00:00".into(),
                updated_at: "2026-08-20 00:00:00".into(),
            },
        )
        .expect("insert account");
    }

    #[tokio::test]
    async fn clearing_runtime_data_waits_for_active_quota_alert_delivery() {
        let fixture = build_context();
        seed_site_and_account(&fixture.ctx);

        let dispatch_guard = fixture
            .ctx
            .live_resources
            .acquire_subscription_quota_alert_delivery_read_gate()
            .await;
        let clear_ctx = fixture.ctx.clone();
        let mut clear_task =
            tokio::spawn(async move { clear_runtime_data(&clear_ctx, true).await });

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut clear_task)
                .await
                .is_err()
        );
        assert!(repositories::find_site(&fixture.ctx.db, "site-1")
            .expect("find site while dispatch is active")
            .is_some());
        assert!(repositories::find_account(&fixture.ctx.db, "account-1")
            .expect("find account while dispatch is active")
            .is_some());

        drop(dispatch_guard);
        assert!(clear_task
            .await
            .expect("clear task should join")
            .expect("clear runtime data"));
        assert!(repositories::find_site(&fixture.ctx.db, "site-1")
            .expect("find removed site")
            .is_none());
        assert!(repositories::find_account(&fixture.ctx.db, "account-1")
            .expect("find removed account")
            .is_none());
    }
}
