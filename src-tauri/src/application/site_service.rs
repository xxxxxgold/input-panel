use std::collections::HashSet;

use crate::contracts::{SiteInput, SitePatchInput, SiteRecord};
use crate::domain::site_url::canonicalize_site_base_url;
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories;
use anyhow::Result;

use super::AppContext;

pub fn create_site(ctx: &AppContext, payload: SiteInput) -> Result<SiteRecord> {
    let now = now_storage_timestamp();
    let site = validate_site(SiteRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: payload.name,
        base_url: payload.base_url,
        fallback_base_urls: payload.fallback_base_urls,
        failover_cooldown_seconds: payload.failover_cooldown_seconds,
        retry_count_per_address: payload.retry_count_per_address,
        created_at: now.clone(),
        updated_at: now,
    })?;
    repositories::insert_site(&ctx.db, &site)?;
    Ok(site)
}

pub fn update_site(ctx: &AppContext, site_id: &str, payload: SitePatchInput) -> Result<SiteRecord> {
    let mut site = repositories::find_site(&ctx.db, site_id)?
        .ok_or_else(|| anyhow::anyhow!("站点不存在。"))?;
    if let Some(name) = payload.name {
        site.name = name;
    }
    if let Some(base_url) = payload.base_url {
        site.base_url = base_url;
    }
    if let Some(fallback_base_urls) = payload.fallback_base_urls {
        site.fallback_base_urls = fallback_base_urls;
    }
    if let Some(failover_cooldown_seconds) = payload.failover_cooldown_seconds {
        site.failover_cooldown_seconds = failover_cooldown_seconds;
    }
    if let Some(retry_count_per_address) = payload.retry_count_per_address {
        site.retry_count_per_address = retry_count_per_address;
    }
    site.updated_at = now_storage_timestamp();
    let site = validate_site(site)?;
    repositories::update_site(&ctx.db, &site)?;
    Ok(site)
}

/// 删除站点前排空额度提醒投递，避免级联删除后继续外发已认领事件。
pub async fn remove_site(ctx: &AppContext, site_id: &str) -> Result<bool> {
    let _delivery_guard = ctx
        .live_resources
        .acquire_subscription_quota_alert_delivery_write_gate()
        .await;
    repositories::delete_site(&ctx.db, site_id)?;
    Ok(true)
}

fn validate_site(mut site: SiteRecord) -> Result<SiteRecord> {
    site.name = site.name.trim().to_string();
    if site.name.is_empty() {
        anyhow::bail!("站点名称不能为空。");
    }
    if site.fallback_base_urls.len() > 10 {
        anyhow::bail!("每个站点最多只能配置 10 个备用地址。");
    }
    if site.failover_cooldown_seconds == 0 {
        anyhow::bail!("冷却时长必须大于 0 秒。");
    }
    site.base_url = canonicalize_site_base_url(&site.base_url)?;
    let mut seen = HashSet::with_capacity(site.fallback_base_urls.len() + 1);
    seen.insert(site.base_url.clone());
    let mut fallbacks = Vec::with_capacity(site.fallback_base_urls.len());
    for fallback in site.fallback_base_urls {
        let fallback = canonicalize_site_base_url(&fallback)?;
        if !seen.insert(fallback.clone()) {
            anyhow::bail!("主地址和备用地址不能重复。");
        }
        fallbacks.push(fallback);
    }
    site.fallback_base_urls = fallbacks;
    Ok(site)
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
            .join(format!("site-service-{}", uuid::Uuid::new_v4()));
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

    fn seed_site(ctx: &AppContext) {
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
    }

    fn valid_site() -> SiteRecord {
        SiteRecord {
            name: " Test Site ".to_string(),
            base_url: "HTTPS://Example.Test:443/api/".to_string(),
            fallback_base_urls: vec![" https://Fallback.Test/ ".to_string()],
            failover_cooldown_seconds: 60,
            retry_count_per_address: 0,
            ..SiteRecord::default()
        }
    }

    #[test]
    fn validation_canonicalizes_site_configuration() {
        let site = validate_site(valid_site()).expect("validate site");
        assert_eq!(site.name, "Test Site");
        assert_eq!(site.base_url, "https://example.test/api");
        assert_eq!(site.fallback_base_urls, vec!["https://fallback.test"]);
    }

    #[test]
    fn validation_rejects_duplicate_and_excess_fallbacks() {
        let mut duplicate = valid_site();
        duplicate.fallback_base_urls = vec!["https://example.test/api/".to_string()];
        assert!(validate_site(duplicate).is_err());

        let mut excessive = valid_site();
        excessive.fallback_base_urls = (0..11)
            .map(|index| format!("https://fallback-{index}.test"))
            .collect();
        assert!(validate_site(excessive).is_err());
    }

    #[test]
    fn validation_requires_positive_cooldown_and_allows_zero_retries() {
        let mut zero_cooldown = valid_site();
        zero_cooldown.failover_cooldown_seconds = 0;
        assert!(validate_site(zero_cooldown).is_err());

        let mut zero_retries = valid_site();
        zero_retries.retry_count_per_address = 0;
        assert!(validate_site(zero_retries).is_ok());
    }

    #[tokio::test]
    async fn removing_a_site_waits_for_active_quota_alert_delivery() {
        let fixture = build_context();
        seed_site(&fixture.ctx);

        let dispatch_guard = fixture
            .ctx
            .live_resources
            .acquire_subscription_quota_alert_delivery_read_gate()
            .await;
        let remove_ctx = fixture.ctx.clone();
        let mut remove_task = tokio::spawn(async move { remove_site(&remove_ctx, "site-1").await });

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut remove_task)
                .await
                .is_err()
        );
        assert!(repositories::find_site(&fixture.ctx.db, "site-1")
            .expect("find site while dispatch is active")
            .is_some());

        drop(dispatch_guard);
        assert!(remove_task
            .await
            .expect("remove task should join")
            .expect("remove site"));
        assert!(repositories::find_site(&fixture.ctx.db, "site-1")
            .expect("find removed site")
            .is_none());
    }
}
