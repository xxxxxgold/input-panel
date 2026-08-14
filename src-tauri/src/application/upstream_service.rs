use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::{UpstreamFailure, UpstreamFailureCategory};

use super::site_failover_service::SiteFailoverReadClient;
use super::{account_service, auth_service, site_failover_service, AppContext};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamRequestPolicy {
    ReadOnly,
    RecoverableSyncOrWrite,
}

struct RecoveredAccountSession {
    session: crate::contracts::StoredSession,
    relogged: bool,
}

#[derive(Debug)]
struct AccountAuthRecoveryError(String);

impl std::fmt::Display for AccountAuthRecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AccountAuthRecoveryError {}

pub(crate) async fn prepare_usage_read_client(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SiteFailoverReadClient> {
    let (_, site) = account_service::load_account_site(ctx, account_id)?;
    let session = repositories::load_session(&ctx.db, account_id)?;
    let Some(session) = session.filter(|session| {
        session
            .access_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
    }) else {
        return recover_usage_read_client(ctx, account_id).await;
    };

    Ok(SiteFailoverReadClient::new(ctx, site, session))
}

pub(crate) async fn recover_usage_read_client(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SiteFailoverReadClient> {
    let recovered = recover_account_client(ctx, account_id).await?;
    let (_, site) = account_service::load_account_site(ctx, account_id)?;
    Ok(SiteFailoverReadClient::new(ctx, site, recovered.session))
}

pub async fn account_upstream_request(
    ctx: &AppContext,
    account_id: &str,
    path: &str,
    method: &str,
    payload: Option<Value>,
    policy: UpstreamRequestPolicy,
) -> Result<Value> {
    account_upstream_request_with_observer(ctx, account_id, path, method, payload, policy).await
}

pub(crate) async fn account_upstream_request_with_observer(
    ctx: &AppContext,
    account_id: &str,
    path: &str,
    method: &str,
    payload: Option<Value>,
    policy: UpstreamRequestPolicy,
) -> Result<Value> {
    if !path.starts_with("/api/v1/") {
        return Err(anyhow!("仅允许代理用户中心 API 路径。"));
    }
    let (_, site) = account_service::load_account_site(ctx, account_id)?;
    let session = repositories::load_session(&ctx.db, account_id)?;
    let request_payload = payload.clone();

    if session
        .as_ref()
        .and_then(|session| session.access_token.as_deref())
        .is_some_and(|token| !token.trim().is_empty())
    {
        match site_failover_service::request_api(ctx, &site, session, path, method, payload).await {
            Ok(result) => {
                repositories::save_session(&ctx.db, account_id, &result.session)?;
                return Ok(result.value);
            }
            Err(error) if auth_service::is_auth_expired_error(&error) => {}
            Err(error) => return Err(error),
        }
    }

    let recovered = recover_account_client(ctx, account_id)
        .await
        .map_err(mark_account_auth_recovery_error)?;
    if policy == UpstreamRequestPolicy::RecoverableSyncOrWrite {
        maybe_schedule_full_sync_after_relogin(ctx, account_id, recovered.relogged);
    }
    let result = site_failover_service::request_api(
        ctx,
        &site,
        Some(recovered.session),
        path,
        method,
        request_payload,
    )
    .await
    .map_err(normalize_account_auth_error)?;

    repositories::save_session(&ctx.db, account_id, &result.session)?;
    Ok(result.value)
}

pub(crate) fn is_rate_limited_error(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<UpstreamFailure>()
        .is_some_and(|failure| failure.category == UpstreamFailureCategory::RateLimited)
}

async fn recover_account_client(
    ctx: &AppContext,
    account_id: &str,
) -> Result<RecoveredAccountSession> {
    let _recovery_gate = ctx
        .live_resources
        .acquire_auth_recovery_account_gate(account_id)
        .await;
    let (account, site) = account_service::load_account_site(ctx, account_id)?;
    let current_session = repositories::load_session(&ctx.db, account_id)?;

    if let Some(session) = current_session.as_ref().filter(|session| {
        session
            .access_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
    }) {
        match site_failover_service::request_api(
            ctx,
            &site,
            Some(session.clone()),
            "/api/v1/user/profile",
            "GET",
            None,
        )
        .await
        {
            Ok(result) => {
                repositories::save_session(&ctx.db, account_id, &result.session)?;
                return Ok(RecoveredAccountSession {
                    session: result.session,
                    relogged: false,
                });
            }
            Err(error) if auth_service::is_auth_expired_error(&error) => {}
            Err(error) => return Err(error),
        }
    }

    if let Some(session) = current_session.filter(|session| {
        session
            .refresh_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
    }) {
        match site_failover_service::refresh_session(ctx, &site, session).await {
            Ok(refreshed) => {
                match site_failover_service::request_api(
                    ctx,
                    &site,
                    Some(refreshed.session.clone()),
                    "/api/v1/user/profile",
                    "GET",
                    None,
                )
                .await
                {
                    Ok(result) => {
                        repositories::save_session(&ctx.db, account_id, &result.session)?;
                        return Ok(RecoveredAccountSession {
                            session: result.session,
                            relogged: false,
                        });
                    }
                    Err(error) if auth_service::is_auth_expired_error(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            Err(error) if auth_service::is_auth_expired_error(&error) => {}
            Err(error) => return Err(error),
        }
    }

    let session = auth_service::relogin_with_saved_credential(ctx, &account, &site).await?;
    Ok(RecoveredAccountSession {
        session,
        relogged: true,
    })
}

fn normalize_account_auth_error(error: anyhow::Error) -> anyhow::Error {
    if auth_service::is_auth_expired_error(&error) {
        anyhow!("认证已失效，请重新登录。")
    } else {
        error
    }
}

fn mark_account_auth_recovery_error(error: anyhow::Error) -> anyhow::Error {
    anyhow::Error::new(AccountAuthRecoveryError(error.to_string()))
}

/// 判断错误是否来自账号认证恢复阶段，供可选接口避免吞掉重新登录提示。
pub(crate) fn is_account_auth_recovery_error(error: &anyhow::Error) -> bool {
    error.downcast_ref::<AccountAuthRecoveryError>().is_some()
        || auth_service::is_auth_expired_error(error)
}

fn maybe_schedule_full_sync_after_relogin(ctx: &AppContext, account_id: &str, relogged: bool) {
    if !relogged {
        return;
    }

    let ctx = ctx.clone();
    let account_id = account_id.to_string();
    tokio::spawn(async move {
        if super::data_center_service::has_running_full_sync(&ctx, &account_id).await {
            return;
        }
        let _ = super::data_center_service::sync_account_data(
            &ctx,
            &account_id,
            crate::contracts::SyncAccountDataInput {
                scope: crate::contracts::DataSyncScope::Full,
                trigger_source: crate::contracts::DataSyncTrigger::PostWrite,
            },
        )
        .await;
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::{
        http::{header, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use tokio::sync::Mutex;

    use super::{account_upstream_request, prepare_usage_read_client, UpstreamRequestPolicy};
    use crate::application::{
        context::SyncTaskHandle,
        site_failover_service::{SiteFailoverError, SiteFailoverErrorCode},
        AppContext,
    };
    use crate::contracts::{AccountRecord, SiteRecord, StoredCredential, StoredSession};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::{repositories, Database};
    use crate::test_support::TestAxumServer;

    #[tokio::test]
    async fn read_only_request_refreshes_retries_and_persists_on_401() {
        let profile_hits = Arc::new(AtomicUsize::new(0));
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let login_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let profile_hits = Arc::clone(&profile_hits);
            let refresh_hits = Arc::clone(&refresh_hits);
            let login_hits = Arc::clone(&login_hits);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(move |headers: HeaderMap| {
                        let profile_hits = Arc::clone(&profile_hits);
                        async move {
                            profile_hits.fetch_add(1, Ordering::SeqCst);
                            if headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok())
                                == Some("Bearer refreshed-access")
                            {
                                Json(serde_json::json!({
                                    "code": 0,
                                    "data": { "id": "profile-1" }
                                }))
                                .into_response()
                            } else {
                                StatusCode::UNAUTHORIZED.into_response()
                            }
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/refresh",
                    post(move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            Json(serde_json::json!({
                                "code": 0,
                                "data": {
                                    "access_token": "refreshed-access",
                                    "refresh_token": "refreshed-refresh"
                                }
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/login",
                    post(move || {
                        let login_hits = Arc::clone(&login_hits);
                        async move {
                            login_hits.fetch_add(1, Ordering::SeqCst);
                            StatusCode::INTERNAL_SERVER_ERROR
                        }
                    }),
                )
        };
        let server = TestAxumServer::start(move |_| app).await;

        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            Some(StoredSession {
                saved_at: "2026-07-11T00:00:00Z".into(),
                access_token: Some("expired-access".into()),
                refresh_token: Some("refresh-token".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
        );
        let result = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect("read-only request recovers auth");

        server.shutdown().await;

        assert_eq!(result["id"], "profile-1");
        assert_eq!(profile_hits.load(Ordering::SeqCst), 4);
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 1);
        assert_eq!(login_hits.load(Ordering::SeqCst), 0);
        let after = repositories::load_session(&ctx.db, "account-read-only")
            .expect("load final session")
            .expect("session is persisted");
        assert_eq!(after.access_token.as_deref(), Some("refreshed-access"));
        assert_eq!(after.refresh_token.as_deref(), Some("refreshed-refresh"));
    }

    #[tokio::test]
    async fn read_only_request_without_session_returns_auth_error_without_network_request() {
        let ctx = build_test_context();
        seed_account(&ctx, "http://127.0.0.1:9", None);

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("missing session must fail before network request");

        assert_eq!(
            error.to_string(),
            "账号 只读账号 尚未保存可恢复凭据，请重新登录。"
        );
        assert!(repositories::load_session(&ctx.db, "account-read-only")
            .expect("load absent session")
            .is_none());
    }

    #[tokio::test]
    async fn read_only_request_falls_back_to_saved_credential_after_refresh_failure() {
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let login_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let refresh_hits = Arc::clone(&refresh_hits);
            let login_hits = Arc::clone(&login_hits);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|headers: HeaderMap| async move {
                        if headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            == Some("Bearer relogged-access")
                        {
                            Json(serde_json::json!({
                                "code": 0,
                                "data": { "id": "profile-after-login" }
                            }))
                            .into_response()
                        } else {
                            StatusCode::UNAUTHORIZED.into_response()
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/refresh",
                    post(move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            StatusCode::UNAUTHORIZED
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/login",
                    post(move || {
                        let login_hits = Arc::clone(&login_hits);
                        async move {
                            login_hits.fetch_add(1, Ordering::SeqCst);
                            Json(serde_json::json!({
                                "code": 0,
                                "data": {
                                    "access_token": "relogged-access",
                                    "refresh_token": "relogged-refresh"
                                }
                            }))
                        }
                    }),
                )
        };
        let server = TestAxumServer::start(move |_| app).await;

        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            Some(StoredSession {
                saved_at: "2026-07-11T00:00:00Z".into(),
                access_token: Some("expired-access".into()),
                refresh_token: Some("expired-refresh".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
        );
        save_test_credential(&ctx);

        let result = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect("saved credential relogin recovers auth");

        assert_eq!(result["id"], "profile-after-login");
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 1);
        assert_eq!(login_hits.load(Ordering::SeqCst), 1);
        let session = repositories::load_session(&ctx.db, "account-read-only")
            .expect("load final session")
            .expect("session is persisted");
        assert_eq!(session.access_token.as_deref(), Some("relogged-access"));
        assert_eq!(session.refresh_token.as_deref(), Some("relogged-refresh"));
        server.shutdown().await;
    }

    #[tokio::test]
    async fn read_only_request_stops_when_saved_credential_login_requires_2fa() {
        let profile_hits = Arc::new(AtomicUsize::new(0));
        let login_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let profile_hits = Arc::clone(&profile_hits);
            let login_hits = Arc::clone(&login_hits);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(move || {
                        let profile_hits = Arc::clone(&profile_hits);
                        async move {
                            profile_hits.fetch_add(1, Ordering::SeqCst);
                            StatusCode::UNAUTHORIZED
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/login",
                    post(move || {
                        let login_hits = Arc::clone(&login_hits);
                        async move {
                            login_hits.fetch_add(1, Ordering::SeqCst);
                            Json(serde_json::json!({
                                "code": 0,
                                "data": {
                                    "temp_token": "temp-2fa",
                                    "user_email_masked": "read***@example.com"
                                }
                            }))
                        }
                    }),
                )
        };
        let server = TestAxumServer::start(move |_| app).await;

        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            Some(StoredSession {
                saved_at: "2026-07-11T00:00:00Z".into(),
                access_token: Some("expired-access".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
        );
        save_test_credential(&ctx);

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("2FA must remain an interactive recovery boundary");

        assert_eq!(
            error.to_string(),
            "账号需要 2FA 验证，请手动重新登录一次。",
            "unexpected 2FA recovery error: {error:#}"
        );
        assert_eq!(profile_hits.load(Ordering::SeqCst), 2);
        assert_eq!(login_hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_read_only_401_requests_share_one_refresh() {
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let refresh_hits = Arc::clone(&refresh_hits);
            Router::new()
                .route(
                    "/api/v1/user/profile",
                    get(|headers: HeaderMap| async move {
                        if headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            == Some("Bearer shared-access")
                        {
                            Json(serde_json::json!({
                                "code": 0,
                                "data": { "id": "shared-profile" }
                            }))
                            .into_response()
                        } else {
                            StatusCode::UNAUTHORIZED.into_response()
                        }
                    }),
                )
                .route(
                    "/api/v1/auth/refresh",
                    post(move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                            Json(serde_json::json!({
                                "code": 0,
                                "data": {
                                    "access_token": "shared-access",
                                    "refresh_token": "shared-refresh"
                                }
                            }))
                        }
                    }),
                )
        };
        let server = TestAxumServer::start(move |_| app).await;

        let ctx = build_test_context();
        seed_account(
            &ctx,
            server.base_url(),
            Some(StoredSession {
                saved_at: "2026-07-11T00:00:00Z".into(),
                access_token: Some("expired-access".into()),
                refresh_token: Some("shared-refresh".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
        );

        let (first, second) = tokio::join!(
            account_upstream_request(
                &ctx,
                "account-read-only",
                "/api/v1/user/profile",
                "GET",
                None,
                UpstreamRequestPolicy::ReadOnly,
            ),
            account_upstream_request(
                &ctx,
                "account-read-only",
                "/api/v1/user/profile",
                "GET",
                None,
                UpstreamRequestPolicy::ReadOnly,
            ),
        );

        assert_eq!(first.expect("first request")["id"], "shared-profile");
        assert_eq!(second.expect("second request")["id"], "shared-profile");
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn usage_read_workers_share_one_serial_auth_preparation() {
        let login_hits = Arc::new(AtomicUsize::new(0));
        let usage_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let login_hits = Arc::clone(&login_hits);
            let usage_hits = Arc::clone(&usage_hits);
            Router::new()
                .route(
                    "/api/v1/auth/login",
                    post(move || {
                        let login_hits = Arc::clone(&login_hits);
                        async move {
                            login_hits.fetch_add(1, Ordering::SeqCst);
                            axum::Json(serde_json::json!({
                                "code": 0,
                                "data": { "access_token": "prepared-token" }
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage",
                    get(move || {
                        let usage_hits = Arc::clone(&usage_hits);
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            axum::Json(serde_json::json!({ "items": [] }))
                        }
                    }),
                )
        };
        let server = TestAxumServer::start(move |_| app).await;

        let ctx = build_test_context();
        seed_account(&ctx, server.base_url(), None);
        save_test_credential(&ctx);

        let reader = prepare_usage_read_client(&ctx, "account-read-only")
            .await
            .expect("prepare usage reader");
        let first = reader.clone();
        let second = reader.clone();
        let (first_result, second_result) = tokio::join!(
            first.get_api("/api/v1/usage?page=1"),
            second.get_api("/api/v1/usage?page=2"),
        );

        first_result.expect("first worker request");
        second_result.expect("second worker request");
        assert_eq!(login_hits.load(Ordering::SeqCst), 1);
        assert_eq!(usage_hits.load(Ordering::SeqCst), 2);
        assert_eq!(
            repositories::load_session(&ctx.db, "account-read-only")
                .expect("load prepared session")
                .expect("session exists")
                .access_token
                .as_deref(),
            Some("prepared-token")
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn confirmed_get_returns_structured_rate_limit_without_local_wait() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/user/profile",
            get({
                let hits = Arc::clone(&hits);
                move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            [(header::RETRY_AFTER, "1")],
                            "slow down",
                        )
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        seed_account(&ctx, server.base_url(), Some(test_session("access")));

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("single-address 429 must return without local waiting");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured site failover error");
        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesRateLimited);
        assert!(failure.retry_after_ms.is_some_and(|delay| delay > 0));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn confirmed_get_uses_default_single_address_budget_for_rate_limits() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/user/profile",
            get({
                let hits = Arc::clone(&hits);
                move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            [(header::RETRY_AFTER, "0")],
                            "slow down",
                        )
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        seed_account(&ctx, server.base_url(), Some(test_session("access")));

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("single-address 429 must exhaust the configured budget");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured site failover error");
        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesRateLimited);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn non_idempotent_post_429_does_not_repeat_the_single_address() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/keys",
            post({
                let hits = Arc::clone(&hits);
                move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            [(header::RETRY_AFTER, "0")],
                            "slow down",
                        )
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        seed_account(&ctx, server.base_url(), Some(test_session("access")));

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/keys",
            "POST",
            Some(serde_json::json!({ "name": "test" })),
            UpstreamRequestPolicy::RecoverableSyncOrWrite,
        )
        .await
        .expect_err("write 429 must be returned");
        assert_eq!(
            error
                .downcast_ref::<SiteFailoverError>()
                .expect("structured site failover error")
                .code,
            SiteFailoverErrorCode::AllAddressesRateLimited
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    #[tokio::test]
    async fn confirmed_get_does_not_multiply_the_default_address_budget() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/api/v1/user/profile",
            get({
                let hits = Arc::clone(&hits);
                move || {
                    let hits = Arc::clone(&hits);
                    async move {
                        match hits.fetch_add(1, Ordering::SeqCst) {
                            0 => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                            1 => (
                                [(header::RETRY_AFTER, "0")],
                                Json(serde_json::json!({
                                    "code": 42901,
                                    "message": "rate limit exceeded"
                                })),
                            )
                                .into_response(),
                            _ => Json(serde_json::json!({
                                "code": 0,
                                "data": { "id": "profile-after-retries" }
                            }))
                            .into_response(),
                        }
                    }
                }
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let ctx = build_test_context();
        seed_account(&ctx, server.base_url(), Some(test_session("access")));

        let error = account_upstream_request(
            &ctx,
            "account-read-only",
            "/api/v1/user/profile",
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await
        .expect_err("default address budget must stop after the first switchable failure");
        assert_eq!(
            error
                .downcast_ref::<SiteFailoverError>()
                .expect("structured site failover error")
                .code,
            SiteFailoverErrorCode::AllAddressesCooling
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        server.shutdown().await;
    }

    fn build_test_context() -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "api-token-upstream-service-tests-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init sqlite");
        AppContext {
            runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                .expect("initialize test runtime coordination"),
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
            live_resources: crate::application::resource_coordinator::ResourceCoordinator::default(
            ),
            native_notifications_enabled: false,
        }
    }

    fn seed_account(ctx: &AppContext, base_url: &str, session: Option<StoredSession>) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-read-only".into(),
                name: "Test Site".into(),
                base_url: base_url.into(),
                created_at: "2026-07-11T00:00:00Z".into(),
                updated_at: "2026-07-11T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "account-read-only".into(),
                site_id: "site-read-only".into(),
                label: "只读账号".into(),
                email: "read-only@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-11T00:00:00Z".into(),
                updated_at: "2026-07-11T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        if let Some(session) = session {
            repositories::save_session(&ctx.db, "account-read-only", &session)
                .expect("save test session");
        }
    }

    fn save_test_credential(ctx: &AppContext) {
        repositories::save_credential(
            &ctx.db,
            &StoredCredential {
                account_id: "account-read-only".into(),
                email: "read-only@example.com".into(),
                password: "test-password".into(),
                saved_at: "2026-07-20T00:00:00Z".into(),
            },
        )
        .expect("save credential");
    }

    fn test_session(access_token: &str) -> StoredSession {
        StoredSession {
            saved_at: "2026-08-08 00:00:00".into(),
            access_token: Some(access_token.into()),
            refresh_token: None,
            token_type: Some("bearer".into()),
            cookie_jar_json: None,
        }
    }
}
