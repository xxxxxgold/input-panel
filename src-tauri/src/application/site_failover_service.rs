use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use tokio::sync::{watch, OwnedSemaphorePermit};
use tokio::task::{JoinHandle, JoinSet};

use crate::contracts::{
    LoginChallenge, SiteCooldownClearInput, SiteEndpointTestInput, SiteEndpointTestResult,
    SiteFailoverAddressKind, SiteFailoverAddressStatus, SiteFailoverAddressStatusKind,
    SiteFailoverStatusPayload, SiteFailoverTransitionBatch, SiteFailoverTransitionEvent,
    SiteFailoverTransitionKind, SiteRecord, StoredSession, TransportErrorPayload,
};
use crate::infrastructure::runtime_coordination::{
    unix_time_ms, CoordinationDecision, CoordinationKey, SiteFailoverFailureCategory,
    SiteFailoverLease, SiteFailoverSnapshot, SiteFailoverTransitionKind as RuntimeTransitionKind,
    SiteFailoverWinner,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::client::{
    Sub2ApiClient, UpstreamFailure, UpstreamFailureCategory,
};

use super::runtime_coordination_service::{RuntimeCoordinationService, SiteFailoverIdentity};
use super::AppContext;

const FAILOVER_LEASE_WAIT_LIMIT: Duration = Duration::from_secs(25);
const FAILOVER_LEASE_POLL_MAX: Duration = Duration::from_millis(200);
const FAILOVER_LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const ADDRESS_RETRY_WAIT_LIMIT_MS: u64 = 30_000;
const ADDRESS_RETRY_BACKOFF_BASE_MS: u64 = 500;
const ADDRESS_RETRY_BACKOFF_CAP_MS: u64 = 4_000;
const ADDRESS_RETRY_JITTER_MAX_MS: u64 = 250;
const TRANSITION_SCAN_MAX_PAGES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteFailoverErrorCode {
    AllAddressesCooling,
    AllAddressesRateLimited,
    NoReachableAddress,
    UnsafeWriteNotReplayed,
}

impl SiteFailoverErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllAddressesCooling => "all_site_addresses_cooling",
            Self::AllAddressesRateLimited => "all_site_addresses_rate_limited",
            Self::NoReachableAddress => "no_reachable_site_address",
            Self::UnsafeWriteNotReplayed => "unsafe_write_not_replayed",
        }
    }
}

#[derive(Debug)]
pub struct SiteFailoverError {
    pub code: SiteFailoverErrorCode,
    pub retry_at_ms: Option<i64>,
    pub retry_after_ms: Option<u64>,
    message: &'static str,
    source: Option<UpstreamFailure>,
}

impl SiteFailoverError {
    fn all_cooling(snapshot: &SiteFailoverSnapshot, now_ms: i64) -> Self {
        let retry_at_ms = snapshot.earliest_cooldown_until_ms(now_ms);
        Self {
            code: SiteFailoverErrorCode::AllAddressesCooling,
            retry_at_ms,
            retry_after_ms: retry_at_ms
                .map(|retry_at| u64::try_from(retry_at.saturating_sub(now_ms)).unwrap_or(u64::MAX)),
            message: "所有站点地址都在冷却中。",
            source: None,
        }
    }

    fn exhausted(snapshot: &SiteFailoverSnapshot) -> Self {
        let now_ms = unix_time_ms();
        let all_cooling = all_addresses_cooling(snapshot, now_ms);
        let all_rate_limited = all_cooling
            && snapshot.addresses.iter().all(|address| {
                address.cooldown_until_ms > now_ms
                    && address.last_failure_category.as_deref() == Some("rate_limited")
            });
        let retry_at_ms = snapshot.earliest_cooldown_until_ms(now_ms);
        Self {
            code: if all_rate_limited {
                SiteFailoverErrorCode::AllAddressesRateLimited
            } else if all_cooling {
                SiteFailoverErrorCode::AllAddressesCooling
            } else {
                SiteFailoverErrorCode::NoReachableAddress
            },
            retry_at_ms,
            retry_after_ms: retry_at_ms
                .map(|retry_at| u64::try_from(retry_at.saturating_sub(now_ms)).unwrap_or(u64::MAX)),
            message: if all_rate_limited {
                "所有站点地址都已被限流。"
            } else if all_cooling {
                "所有站点地址都在冷却中。"
            } else {
                "没有可访问的站点地址。"
            },
            source: None,
        }
    }

    pub fn unsafe_write(source: Option<UpstreamFailure>) -> Self {
        Self {
            code: SiteFailoverErrorCode::UnsafeWriteNotReplayed,
            retry_at_ms: None,
            retry_after_ms: None,
            message: "写请求结果不确定，未向备用地址重放。",
            source,
        }
    }

    /// 构造跨 adapter 契约测试所需的确定性故障转移错误。
    #[cfg(test)]
    pub(crate) fn for_test(
        code: SiteFailoverErrorCode,
        retry_at_ms: Option<i64>,
        retry_after_ms: Option<u64>,
    ) -> Self {
        let message = match code {
            SiteFailoverErrorCode::AllAddressesCooling => "所有站点地址都在冷却中。",
            SiteFailoverErrorCode::AllAddressesRateLimited => "所有站点地址都已被限流。",
            SiteFailoverErrorCode::NoReachableAddress => "没有可访问的站点地址。",
            SiteFailoverErrorCode::UnsafeWriteNotReplayed => "写请求结果不确定，未向备用地址重放。",
        };
        Self {
            code,
            retry_at_ms,
            retry_after_ms,
            message,
            source: None,
        }
    }
}

impl std::fmt::Display for SiteFailoverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for SiteFailoverError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

/// 将故障转移错误转换为浏览器与 Tauri 共用的结构化载荷。
pub fn transport_error_payload(error: &anyhow::Error) -> Option<(u16, TransportErrorPayload)> {
    let failover = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<SiteFailoverError>())?;
    let (http_status, code) = match failover.code {
        SiteFailoverErrorCode::AllAddressesCooling => (503, failover.code.as_str()),
        SiteFailoverErrorCode::AllAddressesRateLimited => (429, failover.code.as_str()),
        SiteFailoverErrorCode::NoReachableAddress => (502, failover.code.as_str()),
        SiteFailoverErrorCode::UnsafeWriteNotReplayed => (502, failover.code.as_str()),
    };
    let upstream_status = error.chain().find_map(|cause| {
        cause
            .downcast_ref::<UpstreamFailure>()
            .and_then(|failure| failure.http_status)
    });
    Some((
        http_status,
        TransportErrorPayload {
            error: failover.to_string(),
            code: code.to_string(),
            http_status: upstream_status.or(Some(http_status)),
            retry_at: failover.retry_at_ms.map(format_unix_timestamp),
            retry_after_ms: failover.retry_after_ms,
        },
    ))
}

pub struct SiteFailoverRequestResult {
    pub value: Value,
    pub session: StoredSession,
    pub active_base_url: String,
    usage_page_slot: Option<OwnedSemaphorePermit>,
}

pub struct SiteFailoverLoginResult {
    pub challenge: LoginChallenge,
    pub session: StoredSession,
    pub active_base_url: String,
}

pub struct SiteFailoverSessionResult {
    pub session: StoredSession,
    pub active_base_url: String,
}

pub(crate) struct SiteFailoverUsageReadResult {
    pub value: Value,
    pub page_slot: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub(crate) struct SiteFailoverReadClient {
    ctx: AppContext,
    site: SiteRecord,
    session: StoredSession,
}

impl SiteFailoverReadClient {
    pub fn new(ctx: &AppContext, site: SiteRecord, session: StoredSession) -> Self {
        Self {
            ctx: ctx.clone(),
            site,
            session,
        }
    }

    #[cfg(test)]
    pub async fn get_api(&self, path: &str) -> Result<Value> {
        request_confirmed_operation(
            &self.ctx,
            &self.site,
            Some(self.session.clone()),
            SiteRequestOperation::Api {
                path: path.to_string(),
                method: "GET".to_string(),
                payload: None,
            },
            PhysicalRequestSlot::None,
        )
        .await
        .and_then(AddressAttemptSuccess::into_json_result)
        .map(|result| result.value)
    }

    /// 读取一个 Usage 页面，并让每个真实地址请求独立占用全局页面槽位。
    pub async fn get_usage_api(&self, path: &str) -> Result<SiteFailoverUsageReadResult> {
        let result = request_confirmed_operation(
            &self.ctx,
            &self.site,
            Some(self.session.clone()),
            SiteRequestOperation::Api {
                path: path.to_string(),
                method: "GET".to_string(),
                payload: None,
            },
            PhysicalRequestSlot::UsagePage,
        )
        .await?
        .into_json_result()?;
        let page_slot = result
            .usage_page_slot
            .context("Usage 故障转移请求缺少页面并发槽位。")?;
        Ok(SiteFailoverUsageReadResult {
            value: result.value,
            page_slot,
        })
    }
}

/// 读取站点主备地址的共享运行状态，供 Web 与桌面编辑弹窗复用。
pub async fn get_site_failover_status(
    ctx: &AppContext,
    site_id: &str,
) -> Result<SiteFailoverStatusPayload> {
    let site = repositories::find_site(&ctx.db, site_id)?.ok_or_else(|| anyhow!("站点不存在。"))?;
    let identity = ctx
        .runtime_coordination
        .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
    let snapshot = ctx
        .runtime_coordination
        .load_site_failover(&identity)
        .await?;
    build_site_failover_status(&site, &identity, &snapshot, unix_time_ms())
}

/// 对单个已保存地址执行一次真实只读 public-settings 请求，不改变故障转移状态。
pub async fn test_site_endpoint(
    ctx: &AppContext,
    site_id: &str,
    input: SiteEndpointTestInput,
) -> Result<SiteEndpointTestResult> {
    let site = repositories::find_site(&ctx.db, site_id)?.ok_or_else(|| anyhow!("站点不存在。"))?;
    let identity = ctx
        .runtime_coordination
        .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
    let address_key = identity.address_key_for_base_url(&input.base_url)?;
    let base_url = identity
        .base_url_for_key(&address_key)
        .context("站点测试地址不属于当前拓扑。")?
        .to_string();
    let started = Instant::now();
    let checked_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let coordination = ctx
        .runtime_coordination
        .site_request_coordination(&base_url)?;
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    let result = Sub2ApiClient::new(&base_url, None, coordination, use_system_proxy)?
        .request_api_once(
            "/api/v1/settings/public?timezone=Asia%2FShanghai",
            "GET",
            None,
        )
        .await;
    let latency_ms = Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX));
    match result {
        Ok(_) => Ok(SiteEndpointTestResult {
            base_url,
            ok: true,
            latency_ms,
            checked_at,
            message: None,
        }),
        Err(error) => Ok(SiteEndpointTestResult {
            base_url,
            ok: false,
            latency_ms,
            checked_at,
            message: Some(error.to_string()),
        }),
    }
}

/// 只解除指定地址的冷却，并返回解除后的待检测状态。
pub async fn clear_site_failover_cooldown(
    ctx: &AppContext,
    site_id: &str,
    input: SiteCooldownClearInput,
) -> Result<SiteFailoverStatusPayload> {
    let site = repositories::find_site(&ctx.db, site_id)?.ok_or_else(|| anyhow!("站点不存在。"))?;
    let identity = ctx
        .runtime_coordination
        .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
    let address_key = identity.address_key_for_base_url(&input.base_url)?;
    let snapshot = ctx
        .runtime_coordination
        .clear_site_failover_cooldown(&identity, address_key)
        .await?;
    build_site_failover_status(&site, &identity, &snapshot, unix_time_ms())
}

/// 将共享协调库中的哈希 transition 映射为当前站点可读事件。
pub async fn list_site_failover_transitions(
    ctx: &AppContext,
    after_revision: i64,
) -> Result<SiteFailoverTransitionBatch> {
    let mut site_identities = Vec::new();
    for site in repositories::list_sites(&ctx.db)? {
        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
        site_identities.push((site, identity));
    }

    let requested_revision = after_revision.max(0);
    let mut scan_revision = requested_revision;
    let mut safe_latest_revision = requested_revision;
    let mut events = Vec::new();

    // 共享表包含 Web/Desktop 各自无法映射的 topology，必须跨原始分页扫描后再推进 cursor。
    for _ in 0..TRANSITION_SCAN_MAX_PAGES {
        let page = ctx
            .runtime_coordination
            .list_site_failover_transitions(scan_revision)
            .await?;
        if page.reset_required || scan_revision > page.latest_revision {
            return Ok(SiteFailoverTransitionBatch {
                latest_revision: page.latest_revision,
                reset_required: true,
                events: Vec::new(),
            });
        }

        let page_end_revision = page
            .events
            .last()
            .map(|event| event.revision)
            .unwrap_or(page.latest_revision);
        for event in page.events {
            for (site, identity) in &site_identities {
                if identity.topology().site_key != event.site_key
                    || identity.topology().topology_key != event.topology_key
                {
                    continue;
                }
                let Some(from_base_url) = identity.base_url_for_key(&event.from_address_key) else {
                    break;
                };
                let Some(to_base_url) = identity.base_url_for_key(&event.to_address_key) else {
                    break;
                };
                let kind = match event.kind {
                    RuntimeTransitionKind::SwitchedToFallback => {
                        SiteFailoverTransitionKind::SwitchedToFallback
                    }
                    RuntimeTransitionKind::PrimaryRestored => {
                        SiteFailoverTransitionKind::PrimaryRestored
                    }
                };
                events.push(SiteFailoverTransitionEvent {
                    revision: event.revision,
                    site_id: site.id.clone(),
                    site_name: site.name.clone(),
                    from_base_url: from_base_url.to_string(),
                    to_base_url: to_base_url.to_string(),
                    kind,
                    occurred_at: format_unix_timestamp(event.occurred_at_ms),
                });
                break;
            }
        }

        safe_latest_revision = page_end_revision;
        if page_end_revision >= page.latest_revision {
            safe_latest_revision = page.latest_revision;
            break;
        }
        scan_revision = page_end_revision;
    }

    events.sort_by_key(|event| event.revision);
    Ok(SiteFailoverTransitionBatch {
        latest_revision: safe_latest_revision,
        reset_required: false,
        events,
    })
}

fn build_site_failover_status(
    site: &SiteRecord,
    identity: &SiteFailoverIdentity,
    snapshot: &SiteFailoverSnapshot,
    now_ms: i64,
) -> Result<SiteFailoverStatusPayload> {
    let mut addresses = Vec::with_capacity(identity.canonical_addresses().len());
    for (index, (base_url, address_key)) in identity
        .canonical_addresses()
        .iter()
        .zip(identity.topology().address_keys.iter())
        .enumerate()
    {
        let state = snapshot
            .address(address_key)
            .with_context(|| format!("共享协调状态缺少站点地址 {index}。"))?;
        let cooling = state.cooldown_until_ms > now_ms;
        let status = if cooling {
            SiteFailoverAddressStatusKind::Cooling
        } else if state.probe_required {
            SiteFailoverAddressStatusKind::Pending
        } else if snapshot.active_address_key == *address_key {
            SiteFailoverAddressStatusKind::Active
        } else {
            SiteFailoverAddressStatusKind::Pending
        };
        let cooldown_until = cooling.then(|| format_unix_timestamp(state.cooldown_until_ms));
        let cooldown_remaining_seconds = cooling.then(|| {
            u64::try_from(state.cooldown_until_ms.saturating_sub(now_ms))
                .unwrap_or(u64::MAX)
                .saturating_add(999)
                / 1_000
        });
        addresses.push(SiteFailoverAddressStatus {
            base_url: base_url.clone(),
            kind: if index == 0 {
                SiteFailoverAddressKind::Primary
            } else {
                SiteFailoverAddressKind::Fallback
            },
            status,
            cooldown_until,
            cooldown_remaining_seconds,
        });
    }
    Ok(SiteFailoverStatusPayload {
        site_id: site.id.clone(),
        active_base_url: identity
            .base_url_for_key(&snapshot.active_address_key)
            .map(str::to_string),
        evaluation_revision: snapshot.evaluation_revision,
        transition_revision: snapshot.transition_revision,
        server_now: format_unix_timestamp(now_ms),
        addresses,
    })
}

fn format_unix_timestamp(timestamp_ms: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub async fn request_api(
    ctx: &AppContext,
    site: &SiteRecord,
    session: Option<StoredSession>,
    path: &str,
    method: &str,
    payload: Option<Value>,
) -> Result<SiteFailoverRequestResult> {
    if !path.starts_with("/api/v1/") {
        return Err(anyhow!("仅允许代理用户中心 API 路径。"));
    }
    let operation = SiteRequestOperation::Api {
        path: path.to_string(),
        method: method.to_string(),
        payload,
    };
    let success = if method.eq_ignore_ascii_case("GET") {
        if operation.has_payload() {
            return Err(anyhow!("GET 请求不能携带写入 payload。"));
        }
        request_confirmed_operation(ctx, site, session, operation, PhysicalRequestSlot::None)
            .await?
    } else {
        Box::pin(request_non_idempotent_operation(
            ctx, site, session, operation, None,
        ))
        .await?
    };
    success.into_json_result()
}

pub async fn login(
    ctx: &AppContext,
    site: &SiteRecord,
    email: &str,
    password: &str,
) -> Result<SiteFailoverLoginResult> {
    Box::pin(request_non_idempotent_operation(
        ctx,
        site,
        None,
        SiteRequestOperation::Login {
            email: email.to_string(),
            password: password.to_string(),
        },
        None,
    ))
    .await?
    .into_login_result()
}

pub async fn complete_2fa(
    ctx: &AppContext,
    site: &SiteRecord,
    temp_token: &str,
    code: &str,
    origin_base_url: Option<&str>,
) -> Result<SiteFailoverSessionResult> {
    Box::pin(request_non_idempotent_operation(
        ctx,
        site,
        None,
        SiteRequestOperation::Complete2fa {
            temp_token: temp_token.to_string(),
            code: code.to_string(),
        },
        origin_base_url,
    ))
    .await?
    .into_session_result()
}

pub async fn refresh_session(
    ctx: &AppContext,
    site: &SiteRecord,
    session: StoredSession,
) -> Result<SiteFailoverSessionResult> {
    Box::pin(request_non_idempotent_operation(
        ctx,
        site,
        Some(session),
        SiteRequestOperation::Refresh,
        None,
    ))
    .await?
    .into_session_result()
}

pub async fn request_api_key_usage(
    ctx: &AppContext,
    site: &SiteRecord,
    path: &str,
    api_key: &str,
) -> Result<Value> {
    if !path.starts_with("/v1/usage") {
        return Err(anyhow!("仅允许代理密钥用量 API 路径。"));
    }
    let token = api_key.trim();
    if token.is_empty() {
        return Err(anyhow!("当前密钥为空，无法读取完整用量。"));
    }
    request_confirmed_operation(
        ctx,
        site,
        None,
        SiteRequestOperation::KeyUsage {
            path: path.to_string(),
            api_key: token.to_string(),
        },
        PhysicalRequestSlot::None,
    )
    .await?
    .into_json_result()
    .map(|result| result.value)
}

async fn request_confirmed_operation(
    ctx: &AppContext,
    site: &SiteRecord,
    session: Option<StoredSession>,
    operation: SiteRequestOperation,
    request_slot: PhysicalRequestSlot,
) -> Result<AddressAttemptSuccess> {
    let identity = ctx
        .runtime_coordination
        .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
    let started = Instant::now();
    let mut already_failed = HashSet::new();
    let mut priority_error = None;

    loop {
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await?;
        let now_ms = unix_time_ms();
        if all_addresses_cooling(&snapshot, now_ms) {
            return Err(anyhow::Error::new(SiteFailoverError::all_cooling(
                &snapshot, now_ms,
            )));
        }
        let active_index = address_index(&identity, &snapshot.active_address_key)?;
        let active_state = snapshot
            .address(&snapshot.active_address_key)
            .context("共享协调状态缺少活动地址。")?;
        let primary_state = snapshot
            .address(&snapshot.primary_address_key)
            .context("共享协调状态缺少主地址。")?;
        let primary_recovery_due = snapshot.active_address_key != snapshot.primary_address_key
            && primary_state.cooldown_until_ms <= now_ms
            && primary_state.probe_required;

        if primary_recovery_due && !already_failed.contains(&snapshot.primary_address_key) {
            let observed_revision = snapshot.evaluation_revision;
            let Some(lease) =
                acquire_evaluation_lease(ctx, &identity, observed_revision, started).await?
            else {
                continue;
            };
            if !evaluate_primary_recovery(ctx, site, &identity, session.clone(), &snapshot, lease)
                .await?
            {
                already_failed.insert(snapshot.primary_address_key);
            }
            continue;
        }

        if !primary_recovery_due
            && !active_state.probe_required
            && active_state.cooldown_until_ms <= now_ms
            && !already_failed.contains(&snapshot.active_address_key)
        {
            match attempt_address(
                ctx,
                site,
                &identity,
                session.clone(),
                active_index,
                active_state.cooldown_revision,
                &operation,
                site.max_attempts_per_address,
                request_slot,
            )
            .await
            {
                AddressAttemptResult::Success(success) => return Ok(*success),
                AddressAttemptResult::Terminal(error) => return Err(error),
                AddressAttemptResult::Switchable { error, .. } => {
                    if priority_error.is_none() {
                        priority_error = Some(error);
                    }
                    already_failed.insert(snapshot.active_address_key);
                }
            }
        }

        let serial_candidates =
            if active_state.probe_required && active_state.cooldown_until_ms <= now_ms {
                vec![active_index]
            } else {
                Vec::new()
            };
        let observed_revision = snapshot.evaluation_revision;
        let Some(lease) =
            acquire_evaluation_lease(ctx, &identity, observed_revision, started).await?
        else {
            continue;
        };
        return evaluate_read_candidates(
            ctx,
            site,
            &identity,
            session,
            operation,
            snapshot,
            lease,
            serial_candidates,
            already_failed,
            priority_error,
            request_slot,
        )
        .await;
    }
}

async fn evaluate_primary_recovery(
    ctx: &AppContext,
    site: &SiteRecord,
    identity: &SiteFailoverIdentity,
    session: Option<StoredSession>,
    snapshot: &SiteFailoverSnapshot,
    lease: SiteFailoverLease,
) -> Result<bool> {
    let primary_key = snapshot.primary_address_key;
    let primary_state = snapshot
        .address(&primary_key)
        .context("共享协调状态缺少主地址。")?;
    let probe = SiteRequestOperation::Api {
        path: "/api/v1/settings/public".to_string(),
        method: "GET".to_string(),
        payload: None,
    };
    let mut heartbeat = EvaluationLeaseHeartbeat::start(ctx, lease.clone());
    let result = attempt_address(
        ctx,
        site,
        identity,
        session,
        0,
        primary_state.cooldown_revision,
        &probe,
        1,
        PhysicalRequestSlot::None,
    )
    .await;

    match result {
        AddressAttemptResult::Success(success) => {
            heartbeat.stop().await;
            commit_evaluation_success(ctx, identity, lease, &success).await?;
            Ok(true)
        }
        AddressAttemptResult::Terminal(error) => {
            let http_status = error
                .downcast_ref::<UpstreamFailure>()
                .and_then(|failure| failure.http_status);
            let _ = ctx
                .runtime_coordination
                .record_site_failover_failure(
                    identity,
                    primary_key,
                    Some(primary_state.cooldown_revision),
                    u64::from(site.failover_cooldown_seconds).saturating_mul(1_000),
                    SiteFailoverFailureCategory::Transport,
                    http_status,
                )
                .await?;
            heartbeat.stop().await;
            let _ = ctx
                .runtime_coordination
                .complete_site_failover_evaluation(identity, lease, None)
                .await?;
            Ok(false)
        }
        AddressAttemptResult::Switchable { .. } => {
            heartbeat.stop().await;
            let _ = ctx
                .runtime_coordination
                .complete_site_failover_evaluation(identity, lease, None)
                .await?;
            Ok(false)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn evaluate_read_candidates(
    ctx: &AppContext,
    site: &SiteRecord,
    identity: &SiteFailoverIdentity,
    session: Option<StoredSession>,
    operation: SiteRequestOperation,
    mut snapshot: SiteFailoverSnapshot,
    lease: SiteFailoverLease,
    serial_candidates: Vec<usize>,
    mut excluded: HashSet<CoordinationKey>,
    mut priority_error: Option<anyhow::Error>,
    request_slot: PhysicalRequestSlot,
) -> Result<AddressAttemptSuccess> {
    let mut heartbeat = EvaluationLeaseHeartbeat::start(ctx, lease.clone());

    for index in serial_candidates {
        let Some(address_key) = identity.address_key_at(index) else {
            continue;
        };
        if excluded.contains(&address_key) || address_is_cooling(&snapshot, &address_key) {
            continue;
        }
        let cooldown_revision = snapshot
            .address(&address_key)
            .context("共享协调状态缺少候选地址。")?
            .cooldown_revision;
        match attempt_address(
            ctx,
            site,
            identity,
            session.clone(),
            index,
            cooldown_revision,
            &operation,
            site.max_attempts_per_address,
            request_slot,
        )
        .await
        {
            AddressAttemptResult::Success(success) => {
                heartbeat.stop().await;
                commit_evaluation_success(ctx, identity, lease, &success).await?;
                return Ok(*success);
            }
            AddressAttemptResult::Terminal(error) => {
                heartbeat.stop().await;
                let _ = ctx
                    .runtime_coordination
                    .complete_site_failover_evaluation(identity, lease, None)
                    .await?;
                return Err(error);
            }
            AddressAttemptResult::Switchable { error, .. } => {
                if priority_error.is_none() {
                    priority_error = Some(error);
                }
                excluded.insert(address_key);
                snapshot = ctx
                    .runtime_coordination
                    .load_site_failover(identity)
                    .await?;
            }
        }
    }

    let candidate_indices = identity
        .topology()
        .address_keys
        .iter()
        .enumerate()
        .filter_map(|(index, address_key)| {
            (!excluded.contains(address_key) && !address_is_cooling(&snapshot, address_key))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if candidate_indices.is_empty() {
        heartbeat.stop().await;
        let completed = ctx
            .runtime_coordination
            .complete_site_failover_evaluation(identity, lease, None)
            .await?
            .unwrap_or(snapshot);
        return Err(anyhow::Error::new(SiteFailoverError::exhausted(&completed)));
    }

    let mut workers = JoinSet::new();
    for index in candidate_indices {
        let worker_ctx = ctx.clone();
        let worker_site = site.clone();
        let worker_identity = identity.clone();
        let worker_session = session.clone();
        let worker_operation = operation.clone();
        let address_key = identity
            .address_key_at(index)
            .context("候选地址索引无效。")?;
        let cooldown_revision = snapshot
            .address(&address_key)
            .context("共享协调状态缺少竞速地址。")?
            .cooldown_revision;
        workers.spawn(async move {
            let result = attempt_address(
                &worker_ctx,
                &worker_site,
                &worker_identity,
                worker_session,
                index,
                cooldown_revision,
                &worker_operation,
                worker_site.max_attempts_per_address,
                request_slot,
            )
            .await;
            (index, result)
        });
    }

    let mut terminal_errors = BTreeMap::new();
    while let Some(joined) = workers.join_next().await {
        let (index, result) = match joined {
            Ok(result) => result,
            Err(error) => (
                usize::MAX,
                AddressAttemptResult::Terminal(anyhow!("站点备用地址竞速任务异常: {error}")),
            ),
        };
        match result {
            AddressAttemptResult::Success(success) => {
                workers.abort_all();
                while workers.join_next().await.is_some() {}
                heartbeat.stop().await;
                commit_evaluation_success(ctx, identity, lease, &success).await?;
                return Ok(*success);
            }
            AddressAttemptResult::Terminal(error) => {
                terminal_errors.entry(index).or_insert(error);
            }
            AddressAttemptResult::Switchable { .. } => {}
        }
    }

    let snapshot = ctx
        .runtime_coordination
        .load_site_failover(identity)
        .await?;
    heartbeat.stop().await;
    let completed = ctx
        .runtime_coordination
        .complete_site_failover_evaluation(identity, lease, None)
        .await?
        .unwrap_or(snapshot);
    if all_addresses_cooling(&completed, unix_time_ms()) {
        return Err(anyhow::Error::new(SiteFailoverError::exhausted(&completed)));
    }
    if let Some(error) = priority_error {
        return Err(error);
    }
    if let Some((_, error)) = terminal_errors.into_iter().next() {
        return Err(error);
    }
    Err(anyhow::Error::new(SiteFailoverError::exhausted(&completed)))
}

async fn request_non_idempotent_operation(
    ctx: &AppContext,
    site: &SiteRecord,
    session: Option<StoredSession>,
    operation: SiteRequestOperation,
    preferred_base_url: Option<&str>,
) -> Result<AddressAttemptSuccess> {
    let identity = ctx
        .runtime_coordination
        .site_failover_identity(&site.base_url, &site.fallback_base_urls)?;
    let preferred_index = preferred_address_index(&identity, preferred_base_url)?;
    let started = Instant::now();
    let mut excluded = HashSet::new();

    loop {
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await?;
        let now_ms = unix_time_ms();
        if all_addresses_cooling(&snapshot, now_ms) {
            return Err(anyhow::Error::new(SiteFailoverError::all_cooling(
                &snapshot, now_ms,
            )));
        }
        let active_index = address_index(&identity, &snapshot.active_address_key)?;
        let active_state = snapshot
            .address(&snapshot.active_address_key)
            .context("共享协调状态缺少活动地址。")?;
        let direct_index = preferred_index.unwrap_or(active_index);
        let direct_key = identity
            .address_key_at(direct_index)
            .context("写请求目标地址身份缺失。")?;
        let direct_state = snapshot
            .address(&direct_key)
            .context("共享协调状态缺少写请求目标地址。")?;
        let can_use_direct = excluded.is_empty()
            && direct_state.cooldown_until_ms <= now_ms
            && preferred_index.is_none()
            && !active_state.probe_required;

        if can_use_direct {
            match attempt_address(
                ctx,
                site,
                &identity,
                session.clone(),
                direct_index,
                direct_state.cooldown_revision,
                &operation,
                1,
                PhysicalRequestSlot::None,
            )
            .await
            {
                AddressAttemptResult::Success(success) => return Ok(*success),
                AddressAttemptResult::Terminal(error) => return Err(error),
                AddressAttemptResult::Switchable {
                    error,
                    explicit_rate_limit,
                } => {
                    if !explicit_rate_limit {
                        let source = error.downcast_ref::<UpstreamFailure>().cloned();
                        return Err(anyhow::Error::new(SiteFailoverError::unsafe_write(source)));
                    }
                    excluded.insert(direct_key);
                }
            }
        }

        let observed_revision = snapshot.evaluation_revision;
        let Some(lease) =
            acquire_evaluation_lease(ctx, &identity, observed_revision, started).await?
        else {
            continue;
        };
        let mut heartbeat = EvaluationLeaseHeartbeat::start(ctx, lease.clone());
        let mut evaluated_snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await?;
        let evaluated_active_index =
            address_index(&identity, &evaluated_snapshot.active_address_key)?;
        let evaluated_direct_index = preferred_index.unwrap_or(evaluated_active_index);
        let evaluated_direct_key = identity
            .address_key_at(evaluated_direct_index)
            .context("写请求最新目标地址身份缺失。")?;
        let evaluated_direct_state = evaluated_snapshot
            .address(&evaluated_direct_key)
            .context("共享协调状态缺少写请求最新目标地址。")?;
        let mut target_index =
            if excluded.is_empty() && evaluated_direct_state.cooldown_until_ms <= unix_time_ms() {
                Some(evaluated_direct_index)
            } else {
                None
            };

        loop {
            let index = match target_index.take() {
                Some(index) => index,
                None => match select_write_probe_candidate(
                    ctx,
                    site,
                    &identity,
                    session.clone(),
                    &evaluated_snapshot,
                    &excluded,
                )
                .await
                {
                    Ok(index) => index,
                    Err(error) => {
                        heartbeat.stop().await;
                        let _ = ctx
                            .runtime_coordination
                            .complete_site_failover_evaluation(&identity, lease, None)
                            .await?;
                        return Err(error);
                    }
                },
            };
            let address_key = identity
                .address_key_at(index)
                .context("写请求候选地址身份缺失。")?;
            let cooldown_revision = evaluated_snapshot
                .address(&address_key)
                .context("共享协调状态缺少写请求候选地址。")?
                .cooldown_revision;
            match attempt_address(
                ctx,
                site,
                &identity,
                session.clone(),
                index,
                cooldown_revision,
                &operation,
                1,
                PhysicalRequestSlot::None,
            )
            .await
            {
                AddressAttemptResult::Success(success) => {
                    heartbeat.stop().await;
                    commit_evaluation_success(ctx, &identity, lease, &success).await?;
                    return Ok(*success);
                }
                AddressAttemptResult::Terminal(error) => {
                    heartbeat.stop().await;
                    let _ = ctx
                        .runtime_coordination
                        .complete_site_failover_evaluation(&identity, lease, None)
                        .await?;
                    return Err(error);
                }
                AddressAttemptResult::Switchable {
                    error,
                    explicit_rate_limit,
                } => {
                    if !explicit_rate_limit {
                        heartbeat.stop().await;
                        let _ = ctx
                            .runtime_coordination
                            .complete_site_failover_evaluation(&identity, lease, None)
                            .await?;
                        let source = error.downcast_ref::<UpstreamFailure>().cloned();
                        return Err(anyhow::Error::new(SiteFailoverError::unsafe_write(source)));
                    }
                    excluded.insert(address_key);
                    evaluated_snapshot = ctx
                        .runtime_coordination
                        .load_site_failover(&identity)
                        .await?;
                }
            }
        }
    }
}

async fn select_write_probe_candidate(
    ctx: &AppContext,
    site: &SiteRecord,
    identity: &SiteFailoverIdentity,
    session: Option<StoredSession>,
    snapshot: &SiteFailoverSnapshot,
    excluded: &HashSet<CoordinationKey>,
) -> Result<usize> {
    let candidate_indices = identity
        .topology()
        .address_keys
        .iter()
        .enumerate()
        .filter_map(|(index, address_key)| {
            (!excluded.contains(address_key) && !address_is_cooling(snapshot, address_key))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if candidate_indices.is_empty() {
        return Err(anyhow::Error::new(SiteFailoverError::exhausted(snapshot)));
    }

    let probe = SiteRequestOperation::Api {
        path: "/api/v1/settings/public".to_string(),
        method: "GET".to_string(),
        payload: None,
    };
    let mut workers = JoinSet::new();
    for index in candidate_indices {
        let worker_ctx = ctx.clone();
        let worker_site = site.clone();
        let worker_identity = identity.clone();
        let worker_session = session.clone();
        let worker_probe = probe.clone();
        let address_key = identity
            .address_key_at(index)
            .context("写请求探测地址身份缺失。")?;
        let cooldown_revision = snapshot
            .address(&address_key)
            .context("共享协调状态缺少写请求探测地址。")?
            .cooldown_revision;
        workers.spawn(async move {
            let result = attempt_address(
                &worker_ctx,
                &worker_site,
                &worker_identity,
                worker_session,
                index,
                cooldown_revision,
                &worker_probe,
                worker_site.max_attempts_per_address,
                PhysicalRequestSlot::None,
            )
            .await;
            (index, result)
        });
    }

    let mut terminal_errors = BTreeMap::new();
    while let Some(joined) = workers.join_next().await {
        let (index, result) = match joined {
            Ok(result) => result,
            Err(error) => (
                usize::MAX,
                AddressAttemptResult::Terminal(anyhow!("写请求站点探测任务异常: {error}")),
            ),
        };
        match result {
            AddressAttemptResult::Success(_) => {
                workers.abort_all();
                while workers.join_next().await.is_some() {}
                return Ok(index);
            }
            AddressAttemptResult::Terminal(error) => {
                terminal_errors.entry(index).or_insert(error);
            }
            AddressAttemptResult::Switchable { .. } => {}
        }
    }

    if let Some((_, error)) = terminal_errors.into_iter().next() {
        return Err(error);
    }
    let latest = ctx
        .runtime_coordination
        .load_site_failover(identity)
        .await?;
    Err(anyhow::Error::new(SiteFailoverError::exhausted(&latest)))
}

fn preferred_address_index(
    identity: &SiteFailoverIdentity,
    preferred_base_url: Option<&str>,
) -> Result<Option<usize>> {
    let Some(preferred_base_url) = preferred_base_url else {
        return Ok(None);
    };
    let canonical = crate::domain::site_url::canonicalize_site_base_url(preferred_base_url)?;
    identity
        .canonical_addresses()
        .iter()
        .position(|candidate| candidate == &canonical)
        .map(Some)
        .context("2FA 来源地址不属于当前站点配置。")
}

async fn acquire_evaluation_lease(
    ctx: &AppContext,
    identity: &SiteFailoverIdentity,
    observed_revision: i64,
    started: Instant,
) -> Result<Option<SiteFailoverLease>> {
    loop {
        match ctx
            .runtime_coordination
            .try_acquire_site_failover_lease(identity)
            .await?
        {
            CoordinationDecision::Acquired(lease) => return Ok(Some(lease)),
            CoordinationDecision::Waiting { wait_ms } => {
                if started.elapsed() >= FAILOVER_LEASE_WAIT_LIMIT {
                    return Err(anyhow!("等待其他运行实例完成站点故障转移超时。"));
                }
                tokio::time::sleep(Duration::from_millis(wait_ms).min(FAILOVER_LEASE_POLL_MAX))
                    .await;
                let snapshot = ctx
                    .runtime_coordination
                    .load_site_failover(identity)
                    .await?;
                if snapshot.evaluation_revision != observed_revision {
                    return Ok(None);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn attempt_address(
    ctx: &AppContext,
    site: &SiteRecord,
    identity: &SiteFailoverIdentity,
    session: Option<StoredSession>,
    address_index: usize,
    observed_cooldown_revision: i64,
    operation: &SiteRequestOperation,
    max_attempts: u32,
    request_slot: PhysicalRequestSlot,
) -> AddressAttemptResult {
    let Some(base_url) = identity.canonical_addresses().get(address_index).cloned() else {
        return AddressAttemptResult::Terminal(anyhow!("站点地址索引无效。"));
    };
    let Some(address_key) = identity.address_key_at(address_index) else {
        return AddressAttemptResult::Terminal(anyhow!("站点地址身份缺失。"));
    };
    let coordination = match ctx
        .runtime_coordination
        .site_request_coordination(&base_url)
    {
        Ok(coordination) => coordination,
        Err(error) => return AddressAttemptResult::Terminal(error),
    };
    let use_system_proxy = match ctx.runtime_coordination.get_upstream_network_config().await {
        Ok(config) => config.use_system_proxy,
        Err(error) => return AddressAttemptResult::Terminal(error),
    };
    let mut client = match Sub2ApiClient::new(&base_url, session, coordination, use_system_proxy) {
        Ok(client) => client,
        Err(error) => return AddressAttemptResult::Terminal(error),
    };
    let attempts = max_attempts.max(1);
    let mut waited_ms = 0_u64;
    for attempt in 1..=attempts {
        let usage_page_slot = match request_slot {
            PhysicalRequestSlot::None => None,
            PhysicalRequestSlot::UsagePage => {
                match ctx.live_resources.acquire_usage_page_slot().await {
                    Ok(slot) => Some(slot),
                    Err(error) => return AddressAttemptResult::Terminal(error),
                }
            }
        };
        match operation.execute(&mut client).await {
            Ok(value) => {
                return AddressAttemptResult::Success(Box::new(AddressAttemptSuccess {
                    value,
                    session: client.serialize(),
                    base_url,
                    address_key,
                    observed_cooldown_revision,
                    usage_page_slot,
                }));
            }
            Err(error) => {
                drop(usage_page_slot);
                let Some(failure) = error.downcast_ref::<UpstreamFailure>() else {
                    return AddressAttemptResult::Terminal(error);
                };
                if !failure.is_switchable_address_failure() {
                    return AddressAttemptResult::Terminal(error);
                }
                let explicit_rate_limit = failure.is_explicit_http_429();
                if !explicit_rate_limit && attempt < attempts {
                    let delay_ms = address_retry_delay_ms(attempt);
                    if delay_ms <= ADDRESS_RETRY_WAIT_LIMIT_MS.saturating_sub(waited_ms) {
                        waited_ms = waited_ms.saturating_add(delay_ms);
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        continue;
                    }
                }
                let cooldown_delay_ms = failure
                    .retry_after_ms
                    .filter(|delay_ms| explicit_rate_limit && *delay_ms > 0)
                    .unwrap_or_else(|| {
                        u64::from(site.failover_cooldown_seconds).saturating_mul(1_000)
                    });
                let category = match failover_failure_category(failure) {
                    Ok(category) => category,
                    Err(category_error) => return AddressAttemptResult::Terminal(category_error),
                };
                if let Err(coordination_error) = ctx
                    .runtime_coordination
                    .record_site_failover_failure(
                        identity,
                        address_key,
                        Some(observed_cooldown_revision),
                        cooldown_delay_ms,
                        category,
                        failure.http_status,
                    )
                    .await
                    .map(|_| ())
                {
                    return AddressAttemptResult::Terminal(
                        coordination_error.context("记录站点地址冷却失败"),
                    );
                }
                return AddressAttemptResult::Switchable {
                    error,
                    explicit_rate_limit,
                };
            }
        }
    }
    AddressAttemptResult::Terminal(anyhow!("站点地址尝试预算异常。"))
}

fn failover_failure_category(failure: &UpstreamFailure) -> Result<SiteFailoverFailureCategory> {
    match failure.category {
        UpstreamFailureCategory::Timeout => Ok(SiteFailoverFailureCategory::Timeout),
        UpstreamFailureCategory::Transport => Ok(SiteFailoverFailureCategory::Transport),
        _ if failure.http_status == Some(429) => Ok(SiteFailoverFailureCategory::RateLimited),
        _ if failure.http_status == Some(502) => Ok(SiteFailoverFailureCategory::BadGateway),
        _ if failure.http_status == Some(503) => {
            Ok(SiteFailoverFailureCategory::ServiceUnavailable)
        }
        _ if failure.http_status == Some(504) => Ok(SiteFailoverFailureCategory::GatewayTimeout),
        _ => Err(anyhow!("当前上游错误不属于地址故障转移范围。")),
    }
}

async fn commit_evaluation_success(
    ctx: &AppContext,
    identity: &SiteFailoverIdentity,
    lease: SiteFailoverLease,
    success: &AddressAttemptSuccess,
) -> Result<()> {
    let committed = ctx
        .runtime_coordination
        .complete_site_failover_evaluation(
            identity,
            lease,
            Some(SiteFailoverWinner {
                address_key: success.address_key,
                observed_cooldown_revision: success.observed_cooldown_revision,
            }),
        )
        .await?
        .context("站点故障转移租约已失效，已拒绝迟到结果。")?;
    let committed_state = committed
        .address(&success.address_key)
        .context("站点故障转移提交结果缺少成功地址。")?;
    if committed.active_address_key != success.address_key
        || committed_state.probe_required
        || committed_state.cooldown_until_ms > unix_time_ms()
    {
        return Err(anyhow!("站点地址状态已变化，已拒绝迟到成功结果。"));
    }
    Ok(())
}

fn address_retry_delay_ms(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1);
    let backoff = ADDRESS_RETRY_BACKOFF_BASE_MS
        .saturating_mul(2_u64.saturating_pow(exponent))
        .min(ADDRESS_RETRY_BACKOFF_CAP_MS);
    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) % (ADDRESS_RETRY_JITTER_MAX_MS + 1);
    backoff.saturating_add(jitter)
}

fn all_addresses_cooling(snapshot: &SiteFailoverSnapshot, now_ms: i64) -> bool {
    !snapshot.addresses.is_empty()
        && snapshot
            .addresses
            .iter()
            .all(|address| address.cooldown_until_ms > now_ms)
}

fn address_is_cooling(snapshot: &SiteFailoverSnapshot, address_key: &CoordinationKey) -> bool {
    snapshot
        .address(address_key)
        .is_some_and(|address| address.cooldown_until_ms > unix_time_ms())
}

fn address_index(identity: &SiteFailoverIdentity, address_key: &CoordinationKey) -> Result<usize> {
    identity
        .topology()
        .address_keys
        .iter()
        .position(|candidate| candidate == address_key)
        .ok_or_else(|| anyhow!("活动地址不属于当前站点拓扑。"))
}

struct AddressAttemptSuccess {
    value: SiteOperationValue,
    session: StoredSession,
    base_url: String,
    address_key: CoordinationKey,
    observed_cooldown_revision: i64,
    usage_page_slot: Option<OwnedSemaphorePermit>,
}

impl AddressAttemptSuccess {
    fn into_json_result(self) -> Result<SiteFailoverRequestResult> {
        let Self {
            value,
            session,
            base_url,
            usage_page_slot,
            ..
        } = self;
        let SiteOperationValue::Json(value) = value else {
            return Err(anyhow!("站点故障转移响应类型不匹配。"));
        };
        Ok(SiteFailoverRequestResult {
            value,
            session,
            active_base_url: base_url,
            usage_page_slot,
        })
    }

    fn into_login_result(self) -> Result<SiteFailoverLoginResult> {
        let Self {
            value,
            session,
            base_url,
            ..
        } = self;
        let SiteOperationValue::Login(challenge) = value else {
            return Err(anyhow!("站点登录响应类型不匹配。"));
        };
        Ok(SiteFailoverLoginResult {
            challenge,
            session,
            active_base_url: base_url,
        })
    }

    fn into_session_result(self) -> Result<SiteFailoverSessionResult> {
        let Self {
            value,
            session,
            base_url,
            ..
        } = self;
        if !matches!(value, SiteOperationValue::Unit) {
            return Err(anyhow!("站点认证响应类型不匹配。"));
        }
        Ok(SiteFailoverSessionResult {
            session,
            active_base_url: base_url,
        })
    }
}

#[derive(Clone)]
enum SiteRequestOperation {
    Api {
        path: String,
        method: String,
        payload: Option<Value>,
    },
    Login {
        email: String,
        password: String,
    },
    Complete2fa {
        temp_token: String,
        code: String,
    },
    Refresh,
    KeyUsage {
        path: String,
        api_key: String,
    },
}

impl SiteRequestOperation {
    fn has_payload(&self) -> bool {
        matches!(
            self,
            Self::Api {
                payload: Some(_),
                ..
            }
        )
    }

    async fn execute(&self, client: &mut Sub2ApiClient) -> Result<SiteOperationValue> {
        match self {
            Self::Api {
                path,
                method,
                payload,
            } => client
                .request_api_once(path, method, payload.clone())
                .await
                .map(SiteOperationValue::Json),
            Self::Login { email, password } => client
                .login(email, password)
                .await
                .map(SiteOperationValue::Login),
            Self::Complete2fa { temp_token, code } => client
                .complete_2fa(temp_token, code)
                .await
                .map(|_| SiteOperationValue::Unit),
            Self::Refresh => client
                .refresh_token_if_needed()
                .await
                .map(|_| SiteOperationValue::Unit),
            Self::KeyUsage { path, api_key } => client
                .request_api_key_usage(path, api_key)
                .await
                .map(SiteOperationValue::Json),
        }
    }
}

enum SiteOperationValue {
    Json(Value),
    Login(LoginChallenge),
    Unit,
}

struct EvaluationLeaseHeartbeat {
    coordination: RuntimeCoordinationService,
    lease: Option<SiteFailoverLease>,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl EvaluationLeaseHeartbeat {
    fn start(ctx: &AppContext, lease: SiteFailoverLease) -> Self {
        let coordination = ctx.runtime_coordination.clone();
        let task_coordination = coordination.clone();
        let task_lease = lease.clone();
        let (stop, mut stop_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(FAILOVER_LEASE_HEARTBEAT_INTERVAL) => {
                        match task_coordination.renew_site_failover_lease(task_lease.clone()).await {
                            Ok(true) => {}
                            Ok(false) => break,
                            Err(error) => {
                                log::warn!("站点故障转移 lease 续租失败: {error}");
                                break;
                            }
                        }
                    }
                }
            }
        });
        Self {
            coordination,
            lease: Some(lease),
            stop,
            task: Some(task),
        }
    }

    async fn stop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for EvaluationLeaseHeartbeat {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let Some(lease) = self.lease.take() else {
            return;
        };
        let coordination = self.coordination.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = coordination.release_site_failover_lease(lease).await;
            });
        }
    }
}

#[derive(Clone, Copy)]
enum PhysicalRequestSlot {
    None,
    UsagePage,
}

enum AddressAttemptResult {
    Success(Box<AddressAttemptSuccess>),
    Switchable {
        error: anyhow::Error,
        explicit_rate_limit: bool,
    },
    Terminal(anyhow::Error),
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, Instant};

    use axum::{
        extract::State,
        http::{header::RETRY_AFTER, HeaderValue, StatusCode},
        response::{IntoResponse, Response},
        routing::get,
        Json, Router,
    };
    use tokio::sync::{Barrier, Mutex};

    use super::*;
    use crate::application::{context::SyncTaskHandle, resource_coordinator::ResourceCoordinator};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::Database;
    use crate::test_support::TestAxumServer;

    #[test]
    fn transport_error_payload_maps_every_failover_code() {
        let retry_at_ms = 1_700_000_000_000;
        let cases = [
            (
                SiteFailoverErrorCode::AllAddressesCooling,
                503,
                "all_site_addresses_cooling",
                Some(retry_at_ms),
                Some(1_250),
            ),
            (
                SiteFailoverErrorCode::AllAddressesRateLimited,
                429,
                "all_site_addresses_rate_limited",
                Some(retry_at_ms),
                Some(5_000),
            ),
            (
                SiteFailoverErrorCode::NoReachableAddress,
                502,
                "no_reachable_site_address",
                None,
                None,
            ),
            (
                SiteFailoverErrorCode::UnsafeWriteNotReplayed,
                502,
                "unsafe_write_not_replayed",
                None,
                None,
            ),
        ];

        for (code, expected_status, expected_code, retry_at_ms, retry_after_ms) in cases {
            let error = anyhow::Error::new(SiteFailoverError::for_test(
                code,
                retry_at_ms,
                retry_after_ms,
            ));
            let (status, payload) =
                transport_error_payload(&error).expect("map structured failover error");

            assert_eq!(status, expected_status);
            assert_eq!(payload.code, expected_code);
            assert_eq!(payload.http_status, Some(expected_status));
            assert_eq!(payload.retry_after_ms, retry_after_ms);
            assert_eq!(
                payload.retry_at.as_deref(),
                retry_at_ms.map(|_| "2023-11-14T22:13:20.000Z")
            );
        }
    }

    #[derive(Default)]
    struct WriteConcurrency {
        current: AtomicUsize,
        peak: AtomicUsize,
    }

    struct WriteInFlight(Arc<WriteConcurrency>);

    impl WriteInFlight {
        fn enter(tracker: Arc<WriteConcurrency>) -> Self {
            let current = tracker.current.fetch_add(1, Ordering::SeqCst) + 1;
            tracker.peak.fetch_max(current, Ordering::SeqCst);
            Self(tracker)
        }
    }

    impl Drop for WriteInFlight {
        fn drop(&mut self) {
            self.0.current.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct MockSiteState {
        marker: String,
        read_status: Arc<AtomicU16>,
        probe_status: Arc<AtomicU16>,
        write_status: Arc<AtomicU16>,
        read_delay_ms: Arc<AtomicU64>,
        probe_delay_ms: Arc<AtomicU64>,
        write_delay_ms: Arc<AtomicU64>,
        read_hits: Arc<AtomicUsize>,
        probe_hits: Arc<AtomicUsize>,
        write_hits: Arc<AtomicUsize>,
        read_barrier: Option<Arc<Barrier>>,
        probe_barrier: Option<Arc<Barrier>>,
        write_payloads: Arc<StdMutex<Vec<Value>>>,
        write_concurrency: Arc<WriteConcurrency>,
        read_retry_after: Arc<StdMutex<Option<String>>>,
    }

    impl MockSiteState {
        fn new(marker: &str, write_concurrency: Arc<WriteConcurrency>) -> Self {
            Self {
                marker: marker.to_string(),
                read_status: Arc::new(AtomicU16::new(StatusCode::OK.as_u16())),
                probe_status: Arc::new(AtomicU16::new(StatusCode::OK.as_u16())),
                write_status: Arc::new(AtomicU16::new(StatusCode::OK.as_u16())),
                read_delay_ms: Arc::new(AtomicU64::new(0)),
                probe_delay_ms: Arc::new(AtomicU64::new(0)),
                write_delay_ms: Arc::new(AtomicU64::new(0)),
                read_hits: Arc::new(AtomicUsize::new(0)),
                probe_hits: Arc::new(AtomicUsize::new(0)),
                write_hits: Arc::new(AtomicUsize::new(0)),
                read_barrier: None,
                probe_barrier: None,
                write_payloads: Arc::new(StdMutex::new(Vec::new())),
                write_concurrency,
                read_retry_after: Arc::new(StdMutex::new(None)),
            }
        }

        fn with_read_status(self, status: StatusCode) -> Self {
            self.read_status.store(status.as_u16(), Ordering::SeqCst);
            self
        }

        fn with_read_retry_after(self, value: &str) -> Self {
            *self.read_retry_after.lock().expect("lock mock Retry-After") = Some(value.to_string());
            self
        }

        fn with_probe_status(self, status: StatusCode) -> Self {
            self.probe_status.store(status.as_u16(), Ordering::SeqCst);
            self
        }

        fn with_write_status(self, status: StatusCode) -> Self {
            self.write_status.store(status.as_u16(), Ordering::SeqCst);
            self
        }

        fn with_read_race(mut self, barrier: Arc<Barrier>, delay_ms: u64) -> Self {
            self.read_barrier = Some(barrier);
            self.read_delay_ms.store(delay_ms, Ordering::SeqCst);
            self
        }

        fn with_probe_race(mut self, barrier: Arc<Barrier>, delay_ms: u64) -> Self {
            self.probe_barrier = Some(barrier);
            self.probe_delay_ms.store(delay_ms, Ordering::SeqCst);
            self
        }

        fn set_read_status(&self, status: StatusCode) {
            self.read_status.store(status.as_u16(), Ordering::SeqCst);
        }

        fn read_hits(&self) -> usize {
            self.read_hits.load(Ordering::SeqCst)
        }

        fn probe_hits(&self) -> usize {
            self.probe_hits.load(Ordering::SeqCst)
        }

        fn write_hits(&self) -> usize {
            self.write_hits.load(Ordering::SeqCst)
        }

        fn write_payloads(&self) -> Vec<Value> {
            self.write_payloads
                .lock()
                .expect("lock mock write payloads")
                .clone()
        }
    }

    #[tokio::test]
    async fn get_returns_first_successful_fallback_and_sticks_to_it() {
        let tracker = Arc::new(WriteConcurrency::default());
        let race = Arc::new(Barrier::new(2));
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::SERVICE_UNAVAILABLE);
        let slow =
            MockSiteState::new("slow", Arc::clone(&tracker)).with_read_race(Arc::clone(&race), 100);
        let fast = MockSiteState::new("fast", Arc::clone(&tracker)).with_read_race(race, 10);
        let primary_server = start_mock_server(primary.clone()).await;
        let slow_server = start_mock_server(slow.clone()).await;
        let fast_server = start_mock_server(fast.clone()).await;
        let site = test_site(
            primary_server.base_url(),
            &[slow_server.base_url(), fast_server.base_url()],
        );
        let (ctx, root) = build_test_context("first-success");
        let client = SiteFailoverReadClient::new(&ctx, site.clone(), test_session());

        let first = client
            .get_api("/api/v1/test")
            .await
            .expect("first request should use fastest fallback");
        assert_eq!(first["marker"], "fast");
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(slow.read_hits(), 1);
        assert_eq!(fast.read_hits(), 1);

        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive test topology");
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load committed winner");
        let fast_key = identity
            .address_key_for_base_url(fast_server.base_url())
            .expect("lookup fast fallback");
        assert_eq!(snapshot.active_address_key, fast_key);
        assert!(
            !snapshot
                .address(&fast_key)
                .expect("fast fallback state")
                .probe_required
        );

        let second = client
            .get_api("/api/v1/test")
            .await
            .expect("sticky request should reuse active fallback");
        assert_eq!(second["marker"], "fast");
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(slow.read_hits(), 1);
        assert_eq!(fast.read_hits(), 2);

        drop(client);
        primary_server.shutdown().await;
        slow_server.shutdown().await;
        fast_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn status_test_clear_and_transition_cursor_share_the_same_runtime_state() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::SERVICE_UNAVAILABLE);
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("status-clear-transitions");
        repositories::insert_site(&ctx.db, &site).expect("insert failover service test site");
        let client = SiteFailoverReadClient::new(&ctx, site.clone(), test_session());

        let fallback_result = client
            .get_api("/api/v1/test")
            .await
            .expect("fallback request should succeed");
        assert_eq!(fallback_result["marker"], "fallback");

        let status = get_site_failover_status(&ctx, &site.id)
            .await
            .expect("read failover status");
        assert_eq!(
            status.active_base_url.as_deref(),
            Some(fallback_server.base_url())
        );
        assert_eq!(
            status
                .addresses
                .iter()
                .find(|address| address.base_url == primary_server.base_url())
                .expect("primary status")
                .status,
            SiteFailoverAddressStatusKind::Cooling
        );
        assert_eq!(
            status
                .addresses
                .iter()
                .find(|address| address.base_url == fallback_server.base_url())
                .expect("fallback status")
                .status,
            SiteFailoverAddressStatusKind::Active
        );

        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive shared service topology");
        let before_test = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load state before endpoint test");
        let endpoint = test_site_endpoint(
            &ctx,
            &site.id,
            SiteEndpointTestInput {
                base_url: fallback_server.base_url().to_string(),
            },
        )
        .await
        .expect("test persisted fallback endpoint");
        assert!(endpoint.ok);
        assert_eq!(endpoint.base_url, fallback_server.base_url());
        assert_eq!(fallback.probe_hits(), 1);
        let after_test = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load state after endpoint test");
        assert_eq!(
            after_test.active_address_key,
            before_test.active_address_key
        );
        assert_eq!(
            after_test.evaluation_revision,
            before_test.evaluation_revision
        );
        assert_eq!(
            after_test.transition_revision,
            before_test.transition_revision
        );

        let cleared = clear_site_failover_cooldown(
            &ctx,
            &site.id,
            SiteCooldownClearInput {
                base_url: primary_server.base_url().to_string(),
            },
        )
        .await
        .expect("clear primary cooldown");
        assert_eq!(
            cleared
                .addresses
                .iter()
                .find(|address| address.base_url == primary_server.base_url())
                .expect("cleared primary status")
                .status,
            SiteFailoverAddressStatusKind::Pending
        );

        primary.set_read_status(StatusCode::OK);
        let primary_result = client
            .get_api("/api/v1/test")
            .await
            .expect("primary should recover after its cooldown is cleared");
        assert_eq!(primary_result["marker"], "primary");

        let transitions = list_site_failover_transitions(&ctx, 0)
            .await
            .expect("list readable failover transitions");
        assert_eq!(transitions.events.len(), 2);
        assert_eq!(
            transitions.events[0].kind,
            SiteFailoverTransitionKind::SwitchedToFallback
        );
        assert_eq!(transitions.events[0].site_id, site.id);
        assert_eq!(
            transitions.events[0].from_base_url,
            primary_server.base_url()
        );
        assert_eq!(
            transitions.events[0].to_base_url,
            fallback_server.base_url()
        );
        assert_eq!(
            transitions.events[1].kind,
            SiteFailoverTransitionKind::PrimaryRestored
        );
        assert_eq!(
            transitions.events[1].from_base_url,
            fallback_server.base_url()
        );
        assert_eq!(transitions.events[1].to_base_url, primary_server.base_url());
        let after_first = list_site_failover_transitions(&ctx, transitions.events[0].revision)
            .await
            .expect("resume transition cursor after first event");
        assert_eq!(after_first.events, vec![transitions.events[1].clone()]);

        drop(client);
        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn transition_cursor_scans_past_unmapped_runtime_pages() {
        let (ctx, root) = build_test_context("transition-filtered-pages");
        let hidden_identity = ctx
            .runtime_coordination
            .site_failover_identity(
                "https://hidden-primary.example.com",
                &["https://hidden-fallback.example.com".to_string()],
            )
            .expect("derive hidden topology");
        for index in 0..101 {
            let target_base_url = if index % 2 == 0 {
                "https://hidden-fallback.example.com"
            } else {
                "https://hidden-primary.example.com"
            };
            commit_test_winner(&ctx, &hidden_identity, target_base_url).await;
        }

        let visible_site = test_site(
            "https://visible-primary.example.com",
            &["https://visible-fallback.example.com"],
        );
        repositories::insert_site(&ctx.db, &visible_site).expect("insert visible site");
        let visible_identity = ctx
            .runtime_coordination
            .site_failover_identity(&visible_site.base_url, &visible_site.fallback_base_urls)
            .expect("derive visible topology");
        let visible_snapshot = commit_test_winner(
            &ctx,
            &visible_identity,
            "https://visible-fallback.example.com",
        )
        .await;

        let batch = list_site_failover_transitions(&ctx, 0)
            .await
            .expect("scan past hidden transition page");
        assert!(!batch.reset_required);
        assert_eq!(batch.latest_revision, visible_snapshot.transition_revision);
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].site_id, visible_site.id);
        assert_eq!(
            batch.events[0].revision,
            visible_snapshot.transition_revision
        );

        let stale_cursor = list_site_failover_transitions(
            &ctx,
            visible_snapshot.transition_revision.saturating_add(10),
        )
        .await
        .expect("reset cursor ahead of rebuilt coordination database");
        assert!(stale_cursor.reset_required);
        assert_eq!(
            stale_cursor.latest_revision,
            visible_snapshot.transition_revision
        );
        assert!(stale_cursor.events.is_empty());

        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn get_fails_fast_when_all_addresses_are_cooling() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker));
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("all-cooling");
        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive test topology");
        let mut snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("initialize test topology");
        for address_key in identity.topology().address_keys.iter().copied() {
            let revision = snapshot
                .address(&address_key)
                .expect("address state")
                .cooldown_revision;
            (_, snapshot) = ctx
                .runtime_coordination
                .record_site_failover_failure(
                    &identity,
                    address_key,
                    Some(revision),
                    60_000,
                    SiteFailoverFailureCategory::Transport,
                    None,
                )
                .await
                .expect("record address cooldown");
        }

        let error = SiteFailoverReadClient::new(&ctx, site, test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("all-cooling request must fail before transport");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured failover error");
        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesCooling);
        assert!(failure.retry_at_ms.is_some());
        assert!(failure.retry_after_ms.is_some_and(|delay| delay > 0));
        assert_eq!(primary.read_hits(), 0);
        assert_eq!(fallback.read_hits(), 0);

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn get_terminal_error_does_not_fail_over() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::UNAUTHORIZED);
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("terminal");

        let error = SiteFailoverReadClient::new(&ctx, site.clone(), test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("401 must terminate without failover");
        let failure = error
            .downcast_ref::<UpstreamFailure>()
            .expect("upstream failure");
        assert_eq!(failure.category, UpstreamFailureCategory::Unauthorized);
        assert_eq!(failure.http_status, Some(401));
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(fallback.read_hits(), 0);

        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive test topology");
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load terminal state");
        assert_eq!(
            snapshot
                .address(&snapshot.primary_address_key)
                .expect("primary state")
                .cooldown_until_ms,
            0
        );

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn primary_recovery_uses_public_probe_before_business_request() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::SERVICE_UNAVAILABLE)
            .with_probe_status(StatusCode::UNAUTHORIZED);
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("primary-recovery");
        let client = SiteFailoverReadClient::new(&ctx, site.clone(), test_session());

        let first = client
            .get_api("/api/v1/test")
            .await
            .expect("initial request should switch to fallback");
        assert_eq!(first["marker"], "fallback");
        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive test topology");
        let primary_key = identity.topology().primary_address_key;
        ctx.runtime_coordination
            .clear_site_failover_cooldown(&identity, primary_key)
            .await
            .expect("make primary recovery due");
        primary.set_read_status(StatusCode::UNAUTHORIZED);

        let second = client
            .get_api("/api/v1/test")
            .await
            .expect("failed recovery probe should preserve sticky fallback");
        assert_eq!(second["marker"], "fallback");
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(primary.probe_hits(), 1);
        assert_eq!(fallback.read_hits(), 2);
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load recovery state");
        assert_eq!(
            snapshot.active_address_key,
            identity
                .address_key_for_base_url(fallback_server.base_url())
                .expect("lookup fallback")
        );
        let primary_state = snapshot
            .address(&primary_key)
            .expect("primary recovery state");
        assert!(primary_state.probe_required);
        assert!(primary_state.cooldown_until_ms > unix_time_ms());

        drop(client);
        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn post_429_probes_candidates_and_sends_payload_to_one_winner() {
        let tracker = Arc::new(WriteConcurrency::default());
        let probe_race = Arc::new(Barrier::new(2));
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_write_status(StatusCode::TOO_MANY_REQUESTS);
        let fast = MockSiteState::new("fast", Arc::clone(&tracker))
            .with_probe_race(Arc::clone(&probe_race), 10);
        let slow =
            MockSiteState::new("slow", Arc::clone(&tracker)).with_probe_race(probe_race, 100);
        let primary_server = start_mock_server(primary.clone()).await;
        let fast_server = start_mock_server(fast.clone()).await;
        let slow_server = start_mock_server(slow.clone()).await;
        let site = test_site(
            primary_server.base_url(),
            &[fast_server.base_url(), slow_server.base_url()],
        );
        let (ctx, root) = build_test_context("post-429");
        let payload = serde_json::json!({ "name": "single-target", "enabled": true });

        let result = request_api(
            &ctx,
            &site,
            Some(test_session()),
            "/api/v1/test",
            "POST",
            Some(payload.clone()),
        )
        .await
        .expect("explicit 429 should select one probed fallback");
        assert_eq!(result.value["marker"], "fast");
        assert_eq!(primary.write_hits(), 1);
        assert_eq!(fast.probe_hits(), 1);
        assert_eq!(slow.probe_hits(), 1);
        assert_eq!(fast.write_hits(), 1);
        assert_eq!(slow.write_hits(), 0);
        assert_eq!(primary.write_payloads(), vec![payload.clone()]);
        assert_eq!(fast.write_payloads(), vec![payload]);
        assert_eq!(tracker.peak.load(Ordering::SeqCst), 1);

        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive test topology");
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load write winner");
        assert_eq!(
            snapshot.active_address_key,
            identity
                .address_key_for_base_url(fast_server.base_url())
                .expect("lookup fast fallback")
        );

        primary_server.shutdown().await;
        fast_server.shutdown().await;
        slow_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn get_all_429_returns_structured_rate_limit_error() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::TOO_MANY_REQUESTS);
        let fallback =
            MockSiteState::new("fallback", tracker).with_read_status(StatusCode::TOO_MANY_REQUESTS);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("all-rate-limited");

        let error = SiteFailoverReadClient::new(&ctx, site, test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("all 429 responses must return a structured rate-limit error");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured failover error");
        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesRateLimited);
        assert!(failure.retry_at_ms.is_some());
        assert!(failure.retry_after_ms.is_some_and(|delay| delay > 0));
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(fallback.read_hits(), 1);

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn retry_after_overrides_configured_cooldown() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::TOO_MANY_REQUESTS)
            .with_read_retry_after("2");
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary).await;
        let fallback_server = start_mock_server(fallback).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("retry-after-cooldown");

        SiteFailoverReadClient::new(&ctx, site.clone(), test_session())
            .get_api("/api/v1/test")
            .await
            .expect("fallback should complete the read");
        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive retry-after topology");
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load retry-after cooldown");
        let primary_state = snapshot
            .address(&snapshot.primary_address_key)
            .expect("primary cooldown state");
        let remaining_ms = primary_state
            .cooldown_until_ms
            .saturating_sub(unix_time_ms());

        assert!(
            (1_000..=2_500).contains(&remaining_ms),
            "Retry-After should produce about two seconds of cooldown, got {remaining_ms}ms"
        );
        assert_eq!(
            primary_state.last_failure_category.as_deref(),
            Some("rate_limited")
        );

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn invalid_retry_after_uses_configured_cooldown() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::TOO_MANY_REQUESTS)
            .with_read_retry_after("invalid");
        let fallback = MockSiteState::new("fallback", tracker);
        let primary_server = start_mock_server(primary).await;
        let fallback_server = start_mock_server(fallback).await;
        let mut site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        site.failover_cooldown_seconds = 3;
        let (ctx, root) = build_test_context("invalid-retry-after");

        SiteFailoverReadClient::new(&ctx, site.clone(), test_session())
            .get_api("/api/v1/test")
            .await
            .expect("fallback should complete the read");
        let identity = ctx
            .runtime_coordination
            .site_failover_identity(&site.base_url, &site.fallback_base_urls)
            .expect("derive configured-cooldown topology");
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("load configured cooldown");
        let primary_state = snapshot
            .address(&snapshot.primary_address_key)
            .expect("primary cooldown state");
        let remaining_ms = primary_state
            .cooldown_until_ms
            .saturating_sub(unix_time_ms());

        assert!(
            (2_000..=3_500).contains(&remaining_ms),
            "invalid Retry-After should use the three-second site cooldown, got {remaining_ms}ms"
        );

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn zero_retry_after_uses_configured_cooldown_and_keeps_all_429_classification() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::TOO_MANY_REQUESTS)
            .with_read_retry_after("0");
        let fallback = MockSiteState::new("fallback", tracker)
            .with_read_status(StatusCode::TOO_MANY_REQUESTS)
            .with_read_retry_after("0");
        let primary_server = start_mock_server(primary).await;
        let fallback_server = start_mock_server(fallback).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("zero-retry-after");

        let error = SiteFailoverReadClient::new(&ctx, site, test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("all explicit 429 responses must stay classified as rate-limited");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured failover error");

        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesRateLimited);
        assert!(failure.retry_after_ms.is_some_and(|delay| delay > 0));

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn get_mixed_switchable_failures_returns_all_cooling() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::TOO_MANY_REQUESTS);
        let fallback = MockSiteState::new("fallback", tracker)
            .with_read_status(StatusCode::SERVICE_UNAVAILABLE);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("mixed-cooling");

        let error = SiteFailoverReadClient::new(&ctx, site, test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("mixed switchable failures must report the shared cooling state");
        let failure = error
            .downcast_ref::<SiteFailoverError>()
            .expect("structured failover error");
        assert_eq!(failure.code, SiteFailoverErrorCode::AllAddressesCooling);
        assert!(failure.retry_at_ms.is_some());
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(fallback.read_hits(), 1);

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn get_prefers_current_address_error_when_terminal_candidate_does_not_cool() {
        let tracker = Arc::new(WriteConcurrency::default());
        let primary = MockSiteState::new("primary", Arc::clone(&tracker))
            .with_read_status(StatusCode::SERVICE_UNAVAILABLE);
        let fallback =
            MockSiteState::new("fallback", tracker).with_read_status(StatusCode::UNAUTHORIZED);
        let primary_server = start_mock_server(primary.clone()).await;
        let fallback_server = start_mock_server(fallback.clone()).await;
        let site = test_site(primary_server.base_url(), &[fallback_server.base_url()]);
        let (ctx, root) = build_test_context("stable-error-priority");

        let error = SiteFailoverReadClient::new(&ctx, site, test_session())
            .get_api("/api/v1/test")
            .await
            .expect_err("a terminal fallback must not replace the current address error");
        let failure = error
            .downcast_ref::<UpstreamFailure>()
            .expect("current address upstream failure");
        assert_eq!(failure.http_status, Some(503));
        assert_eq!(primary.read_hits(), 1);
        assert_eq!(fallback.read_hits(), 1);

        primary_server.shutdown().await;
        fallback_server.shutdown().await;
        cleanup_test_context(ctx, root);
    }

    #[tokio::test]
    async fn dropping_heartbeat_releases_lease_without_waiting_for_ttl() {
        let (ctx, root) = build_test_context("heartbeat-drop");
        let identity = ctx
            .runtime_coordination
            .site_failover_identity("https://primary.test", &["https://fallback.test".into()])
            .expect("derive test topology");
        ctx.runtime_coordination
            .load_site_failover(&identity)
            .await
            .expect("initialize test topology");
        let lease = match ctx
            .runtime_coordination
            .try_acquire_site_failover_lease(&identity)
            .await
            .expect("acquire initial lease")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => panic!("initial lease must be available"),
        };
        let heartbeat = EvaluationLeaseHeartbeat::start(&ctx, lease);
        drop(heartbeat);

        let peer = RuntimeCoordinationService::from_paths_for_test(&ctx.paths)
            .expect("initialize peer coordination service");
        let started = Instant::now();
        let acquired = loop {
            match peer
                .try_acquire_site_failover_lease(&identity)
                .await
                .expect("peer lease attempt")
            {
                CoordinationDecision::Acquired(lease) => break lease,
                CoordinationDecision::Waiting { .. } => {
                    assert!(
                        started.elapsed() < Duration::from_secs(2),
                        "heartbeat drop should release well before the 20-second TTL"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        };
        assert!(peer
            .release_site_failover_lease(acquired)
            .await
            .expect("release peer lease"));

        drop(peer);
        cleanup_test_context(ctx, root);
    }

    async fn start_mock_server(state: MockSiteState) -> TestAxumServer {
        TestAxumServer::start(move |_| {
            Router::new()
                .route("/api/v1/test", get(mock_read).post(mock_write))
                .route("/api/v1/settings/public", get(mock_probe))
                .with_state(state)
        })
        .await
    }

    async fn mock_read(State(state): State<MockSiteState>) -> Response {
        let hit = state.read_hits.fetch_add(1, Ordering::SeqCst);
        if hit == 0 {
            if let Some(barrier) = &state.read_barrier {
                barrier.wait().await;
            }
        }
        sleep_ms(state.read_delay_ms.load(Ordering::SeqCst)).await;
        let retry_after = state
            .read_retry_after
            .lock()
            .expect("lock mock Retry-After")
            .clone();
        mock_response(
            state.read_status.load(Ordering::SeqCst),
            &state.marker,
            retry_after.as_deref(),
        )
    }

    async fn mock_probe(State(state): State<MockSiteState>) -> Response {
        let hit = state.probe_hits.fetch_add(1, Ordering::SeqCst);
        if hit == 0 {
            if let Some(barrier) = &state.probe_barrier {
                barrier.wait().await;
            }
        }
        sleep_ms(state.probe_delay_ms.load(Ordering::SeqCst)).await;
        mock_response(
            state.probe_status.load(Ordering::SeqCst),
            &state.marker,
            None,
        )
    }

    async fn mock_write(
        State(state): State<MockSiteState>,
        Json(payload): Json<Value>,
    ) -> Response {
        let _in_flight = WriteInFlight::enter(Arc::clone(&state.write_concurrency));
        state.write_hits.fetch_add(1, Ordering::SeqCst);
        state
            .write_payloads
            .lock()
            .expect("lock mock write payloads")
            .push(payload);
        sleep_ms(state.write_delay_ms.load(Ordering::SeqCst)).await;
        mock_response(
            state.write_status.load(Ordering::SeqCst),
            &state.marker,
            None,
        )
    }

    fn mock_response(status: u16, marker: &str, retry_after: Option<&str>) -> Response {
        let status = StatusCode::from_u16(status).expect("valid mock status");
        let mut response = if status.is_success() {
            Json(serde_json::json!({
                "code": 0,
                "data": { "marker": marker }
            }))
            .into_response()
        } else {
            (
                status,
                Json(serde_json::json!({ "message": "mock failure" })),
            )
                .into_response()
        };
        if let Some(value) = retry_after {
            response.headers_mut().insert(
                RETRY_AFTER,
                HeaderValue::from_str(value).expect("valid mock Retry-After header"),
            );
        }
        response
    }

    async fn sleep_ms(delay_ms: u64) {
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
    }

    fn test_site(primary: &str, fallbacks: &[&str]) -> SiteRecord {
        SiteRecord {
            id: "site-failover-test".into(),
            name: "故障转移测试站点".into(),
            base_url: primary.to_string(),
            fallback_base_urls: fallbacks.iter().map(|value| (*value).to_string()).collect(),
            failover_cooldown_seconds: 60,
            max_attempts_per_address: 1,
            created_at: "2026-08-11T00:00:00Z".into(),
            updated_at: "2026-08-11T00:00:00Z".into(),
        }
    }

    fn test_session() -> StoredSession {
        StoredSession {
            saved_at: "2026-08-11T00:00:00Z".into(),
            access_token: Some("test-access-token".into()),
            refresh_token: Some("test-refresh-token".into()),
            token_type: Some("bearer".into()),
            cookie_jar_json: None,
        }
    }

    /// 提交一个测试 winner，用于构造可控的持久 transition 序列。
    async fn commit_test_winner(
        ctx: &AppContext,
        identity: &SiteFailoverIdentity,
        target_base_url: &str,
    ) -> SiteFailoverSnapshot {
        let snapshot = ctx
            .runtime_coordination
            .load_site_failover(identity)
            .await
            .expect("load transition test topology");
        let target_key = identity
            .address_key_for_base_url(target_base_url)
            .expect("resolve transition test target");
        let observed_cooldown_revision = snapshot
            .address(&target_key)
            .expect("load transition test address")
            .cooldown_revision;
        let lease = match ctx
            .runtime_coordination
            .try_acquire_site_failover_lease(identity)
            .await
            .expect("acquire transition test lease")
        {
            CoordinationDecision::Acquired(lease) => lease,
            CoordinationDecision::Waiting { .. } => {
                panic!("transition test lease should be available")
            }
        };
        ctx.runtime_coordination
            .complete_site_failover_evaluation(
                identity,
                lease,
                Some(SiteFailoverWinner {
                    address_key: target_key,
                    observed_cooldown_revision,
                }),
            )
            .await
            .expect("commit transition test winner")
            .expect("transition test owner remains current")
    }

    fn build_test_context(label: &str) -> (AppContext, PathBuf) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("resolve project root")
            .join("tmp")
            .join(format!(
                "input-panel-site-failover-{label}-{}",
                uuid::Uuid::new_v4()
            ));
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("ensure failover test paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("initialize failover test database");
        let runtime_coordination = RuntimeCoordinationService::from_paths_for_test(&paths)
            .expect("initialize failover test coordination");
        (
            AppContext {
                paths,
                db,
                sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
                live_resources: ResourceCoordinator::default(),
                runtime_coordination,
                native_notifications_enabled: false,
            },
            root,
        )
    }

    fn cleanup_test_context(ctx: AppContext, root: PathBuf) {
        drop(ctx);
        let _ = std::fs::remove_dir_all(root);
    }
}
