use crate::contracts::{
    AccountRuntime, LoginFlowResult, SiteRecord, StoredCredential, StoredSession,
};
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories;
use anyhow::{anyhow, Context, Result};

use super::{account_service, data_center_service, site_failover_service, AppContext};

pub async fn login_account(
    ctx: &AppContext,
    account_id: &str,
    password: &str,
) -> Result<LoginFlowResult> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let result = site_failover_service::login(ctx, &site, &account.email, password).await?;
    let challenge = result.challenge;
    if challenge.requires2fa {
        repositories::save_credential(
            &ctx.db,
            &StoredCredential {
                account_id: account.id.clone(),
                email: account.email.clone(),
                password: password.to_string(),
                saved_at: now_storage_timestamp(),
            },
        )?;
        return Ok(LoginFlowResult::TwoFa {
            temp_token: challenge.temp_token.unwrap_or_default(),
            origin_base_url: result.active_base_url,
            email_masked: challenge
                .email_masked
                .or_else(|| Some(mask_email(&account.email))),
            message: Some("当前站点要求 2FA 验证，请继续输入验证码。".into()),
        });
    }

    repositories::save_session(&ctx.db, &account.id, &result.session)?;
    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: password.to_string(),
            saved_at: now_storage_timestamp(),
        },
    )?;

    let mut updated = account.clone();
    let now = now_storage_timestamp();
    updated.last_login_at = Some(now.clone());
    updated.updated_at = now;
    repositories::update_account(&ctx.db, &updated)?;

    let runtime = finish_authenticated_login(ctx, updated)?;
    Ok(LoginFlowResult::Success { account: runtime })
}

pub fn persist_account_credential(
    ctx: &AppContext,
    account_id: &str,
    password: &str,
) -> Result<bool> {
    let account = repositories::find_account(&ctx.db, account_id)?.context("账号不存在。")?;
    if password.trim().is_empty() {
        return Err(anyhow!("密码不能为空。"));
    }

    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: password.to_string(),
            saved_at: now_storage_timestamp(),
        },
    )?;
    Ok(true)
}

pub async fn login_account_2fa(
    ctx: &AppContext,
    account_id: &str,
    temp_token: &str,
    code: &str,
    origin_base_url: Option<&str>,
) -> Result<AccountRuntime> {
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let result =
        site_failover_service::complete_2fa(ctx, &site, temp_token, code, origin_base_url).await?;
    repositories::save_session(&ctx.db, &account.id, &result.session)?;

    let mut updated = account.clone();
    let now = now_storage_timestamp();
    updated.last_login_at = Some(now.clone());
    updated.updated_at = now;
    repositories::update_account(&ctx.db, &updated)?;

    finish_authenticated_login(ctx, updated)
}

fn finish_authenticated_login(
    ctx: &AppContext,
    account: crate::contracts::AccountRecord,
) -> Result<AccountRuntime> {
    let runtime = account_service::wrap_runtime(ctx, account.clone(), None, None)?;
    data_center_service::schedule_bootstrap_sync(ctx, account.id);
    Ok(runtime)
}

pub async fn relogin_with_saved_credential(
    ctx: &AppContext,
    account: &crate::contracts::AccountRecord,
    site: &SiteRecord,
) -> Result<StoredSession> {
    let credential = repositories::load_credential(&ctx.db, &account.id)?.context(format!(
        "账号 {} 尚未保存可恢复凭据，请重新登录。",
        account.label
    ))?;
    let result =
        site_failover_service::login(ctx, site, &account.email, &credential.password).await?;
    if result.challenge.requires2fa {
        return Err(anyhow!("账号需要 2FA 验证，请手动重新登录一次。"));
    }
    repositories::save_credential(
        &ctx.db,
        &StoredCredential {
            account_id: account.id.clone(),
            email: account.email.clone(),
            password: credential.password,
            saved_at: now_storage_timestamp(),
        },
    )?;
    repositories::save_session(&ctx.db, &account.id, &result.session)?;
    let mut updated = account.clone();
    let now = now_storage_timestamp();
    updated.last_login_at = Some(now.clone());
    updated.updated_at = now;
    repositories::update_account(&ctx.db, &updated)?;
    Ok(result.session)
}

pub fn is_auth_expired_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<crate::infrastructure::sub2api::client::UpstreamFailure>()
            .is_some_and(|failure| {
                failure.category
                    == crate::infrastructure::sub2api::client::UpstreamFailureCategory::Unauthorized
            })
    }) || error.to_string().contains("认证已失效")
}

pub fn mask_email(email: &str) -> String {
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty() || domain.is_empty() {
        return email.to_string();
    }
    if local.len() <= 3 {
        return format!("{}***@{}", local.chars().next().unwrap_or('*'), domain);
    }
    format!("{}***@{}", &local[..3], domain)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;
    use tokio::sync::{watch, Mutex};

    use super::{login_account, login_account_2fa};
    use crate::application::{context::SyncTaskHandle, AppContext};
    use crate::contracts::{AccountRecord, LoginFlowResult, SiteRecord};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::{repositories, Database};
    use crate::test_support::TestAxumServer;

    // 这里验证的是不等待 5 秒的 bootstrap 请求，并为 HTTP、SQLite 与线程调度保留余量。
    const NON_BLOCKING_LOGIN_TIMEOUT: Duration = Duration::from_secs(2);
    // 后台 Full sync 受并发调度和本机负载影响，单独保留测试清理的安全上限。
    const BOOTSTRAP_SYNC_TIMEOUT: Duration = Duration::from_secs(10);

    /// 持有阻塞用量 mock 的释放信号与服务任务，避免后台同步跨测试遗留。
    struct BlockedUsageTestContext {
        ctx: AppContext,
        base_url: String,
        usage_started: watch::Receiver<bool>,
        release_usage: watch::Sender<bool>,
        server: Option<TestAxumServer>,
    }

    impl BlockedUsageTestContext {
        /// 等待 Full bootstrap 确实进入阻塞用量请求，避免只观察到任务登记状态。
        async fn wait_for_usage_request(&self) {
            let mut usage_started = self.usage_started.clone();
            tokio::time::timeout(BOOTSTRAP_SYNC_TIMEOUT, async {
                while !*usage_started.borrow() {
                    usage_started
                        .changed()
                        .await
                        .expect("usage request signal remains available");
                }
            })
            .await
            .expect("bootstrap sync must enter the blocked usage request");
        }

        async fn finish(mut self) {
            self.release_usage.send_replace(true);
            wait_for_bootstrap_sync_completion(&self.ctx).await;
            if let Some(server) = self.server.take() {
                server.shutdown().await;
            }
        }
    }

    impl Drop for BlockedUsageTestContext {
        fn drop(&mut self) {
            self.release_usage.send_replace(true);
            drop(self.server.take());
        }
    }

    #[tokio::test]
    async fn login_returns_before_bootstrap_sync_finishes() {
        let fixture = build_test_context_with_blocked_usage(false).await;

        let result = tokio::time::timeout(
            NON_BLOCKING_LOGIN_TIMEOUT,
            login_account(&fixture.ctx, "account-1", "secret"),
        )
        .await
        .expect("login must not wait for bootstrap sync")
        .expect("login succeeds");

        assert_successful_login(&fixture.ctx, result);
        wait_for_bootstrap_sync(&fixture.ctx).await;
        fixture.wait_for_usage_request().await;
        assert!(fixture.base_url.starts_with("http://127.0.0.1:"));
        fixture.finish().await;
    }

    #[tokio::test]
    async fn two_factor_login_returns_before_bootstrap_sync_finishes() {
        let fixture = build_test_context_with_blocked_usage(true).await;

        let result = tokio::time::timeout(
            NON_BLOCKING_LOGIN_TIMEOUT,
            login_account_2fa(
                &fixture.ctx,
                "account-1",
                "temp-1",
                "123456",
                Some(fixture.base_url.as_str()),
            ),
        )
        .await
        .expect("2FA login must not wait for bootstrap sync")
        .expect("2FA login succeeds");

        assert_eq!(result.account.id, "account-1");
        assert_eq!(result.session_state, "ready");
        assert!(repositories::load_session(&fixture.ctx.db, "account-1")
            .expect("load session")
            .is_some());
        wait_for_bootstrap_sync(&fixture.ctx).await;
        fixture.wait_for_usage_request().await;
        fixture.finish().await;
    }

    async fn build_test_context_with_blocked_usage(two_factor: bool) -> BlockedUsageTestContext {
        let login_response = if two_factor {
            json!({ "code": 0, "data": { "temp_token": "temp-1" } })
        } else {
            json!({
                "code": 0,
                "data": { "access_token": "access-1", "refresh_token": "refresh-1" }
            })
        };
        let (usage_started, usage_started_rx) = watch::channel(false);
        let (release_usage, usage_release) = watch::channel(false);
        let app = Router::new()
            .route(
                "/api/v1/auth/login",
                post(move || {
                    let login_response = login_response.clone();
                    async move { Json(login_response) }
                }),
            )
            .route(
                "/api/v1/auth/login/2fa",
                post(|| async {
                    Json(json!({
                        "code": 0,
                        "data": { "access_token": "access-2", "refresh_token": "refresh-2" }
                    }))
                }),
            )
            .route(
                "/api/v1/usage",
                get({
                    let usage_started = usage_started.clone();
                    let usage_release = usage_release.clone();
                    move || {
                        let usage_started = usage_started.clone();
                        let mut usage_release = usage_release.clone();
                        async move {
                            usage_started.send_replace(true);
                            while !*usage_release.borrow() {
                                usage_release
                                    .changed()
                                    .await
                                    .expect("usage release signal remains available");
                            }
                            Json(json!({
                                "items": [],
                                "page": 1,
                                "page_size": 1_000,
                                "total": 0,
                                "pages": 1
                            }))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/user/profile",
                get(|| async { Json(json!({ "balance": 0.0, "email": "demo@example.com" })) }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get(|| async { Json(json!({ "platform_quotas": [] })) }),
            )
            .route(
                "/api/v1/subscriptions",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get(|| async {
                    Json(json!({
                        "active_count": 0,
                        "total_used_usd": 0.0,
                        "subscriptions": []
                    }))
                }),
            )
            .route(
                "/api/v1/groups/available",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/keys",
                get(|| async { Json(json!({ "items": [] })) }),
            );
        let server = TestAxumServer::start(move |_| app).await;

        let root =
            std::env::temp_dir().join(format!("input-panel-auth-tests-{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init sqlite");
        let ctx = AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(
            ),
            native_notifications_enabled: false,
        };
        let base_url = server.base_url().to_string();
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-1".into(),
                name: "Test Site".into(),
                base_url: base_url.clone(),
                created_at: "2026-07-16T00:00:00Z".into(),
                updated_at: "2026-07-16T00:00:00Z".into(),
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
                email: "demo@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-16T00:00:00Z".into(),
                updated_at: "2026-07-16T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        BlockedUsageTestContext {
            ctx,
            base_url,
            usage_started: usage_started_rx,
            release_usage,
            server: Some(server),
        }
    }

    fn assert_successful_login(ctx: &AppContext, result: LoginFlowResult) {
        let LoginFlowResult::Success { account } = result else {
            panic!("expected normal login success");
        };
        assert_eq!(account.account.id, "account-1");
        assert_eq!(account.session_state, "ready");
        assert!(repositories::load_session(&ctx.db, "account-1")
            .expect("load session")
            .is_some());
        assert!(repositories::load_credential(&ctx.db, "account-1")
            .expect("load credential")
            .is_some());
        assert!(repositories::find_account(&ctx.db, "account-1")
            .expect("find account")
            .expect("account exists")
            .last_login_at
            .is_some());
    }

    async fn wait_for_bootstrap_sync(ctx: &AppContext) {
        tokio::time::timeout(NON_BLOCKING_LOGIN_TIMEOUT, async {
            loop {
                if crate::application::data_center_service::has_running_full_sync(ctx, "account-1")
                    .await
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("bootstrap sync must start");

        let status =
            crate::application::data_center_service::get_account_sync_status(ctx, "account-1")
                .await
                .expect("read bootstrap sync status");
        assert_eq!(status.statuses.len(), 1);
        assert_eq!(
            status.statuses[0].scope,
            crate::contracts::DataSyncScope::Full
        );
        assert_eq!(
            status.statuses[0].state,
            crate::contracts::AccountSyncState::Running
        );
    }

    async fn wait_for_bootstrap_sync_completion(ctx: &AppContext) {
        let task_handle = {
            let tasks = ctx.sync_tasks.lock().await;
            tasks
                .get("account-1:full")
                .cloned()
                .expect("bootstrap sync task remains registered")
        };
        tokio::time::timeout(BOOTSTRAP_SYNC_TIMEOUT, async {
            loop {
                let notified = task_handle.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let completed = task_handle.state.lock().await.completed;
                if completed {
                    break;
                }
                notified.await;
            }
        })
        .await
        .expect("bootstrap sync must finish after usage release");

        let status =
            crate::application::data_center_service::get_account_sync_status(ctx, "account-1")
                .await
                .expect("read completed bootstrap sync status");
        assert_eq!(status.statuses.len(), 1);
        assert_ne!(
            status.statuses[0].state,
            crate::contracts::AccountSyncState::Running
        );
    }
}
