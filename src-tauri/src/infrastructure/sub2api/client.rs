use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use reqwest::{header::RETRY_AFTER, Client, Method, RequestBuilder, StatusCode};
use serde_json::{json, Value};

use crate::contracts::{
    AccountCacheStats, AccountCacheView, AccountRecord, KeyRecord, LoginChallenge, SiteRecord,
    StoredSession, SubscriptionQuotaWindow, SubscriptionRecord, TrendPoint, UsageRow,
};
use crate::domain::alerts::build_alerts;
use crate::infrastructure::datetime::{now_storage_timestamp, shanghai_today};
use crate::infrastructure::runtime_coordination::{
    SiteRequestClass, SiteRequestCoordination, SiteRequestPermitGuard, USAGE_PAGE_ENDPOINT_FAMILY,
};
use crate::infrastructure::sub2api::normalizers::{
    normalize_dashboard_cache_stats, normalize_trend_payload,
};
use crate::infrastructure::upstream_http_client::upstream_http_client_builder;

const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const UPSTREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamFailureCategory {
    Unauthorized,
    RateLimited,
    Http,
    Timeout,
    Transport,
    Decode,
    Business,
}

/// 上游单次 attempt 的结构化错误；Display 只暴露已脱敏的稳定语义。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamFailure {
    pub category: UpstreamFailureCategory,
    pub http_status: Option<u16>,
    pub message: String,
    pub retry_after_ms: Option<u64>,
    pub endpoint_family: String,
}

impl UpstreamFailure {
    pub fn is_status(&self, status: u16) -> bool {
        self.http_status == Some(status)
    }

    pub fn is_switchable_address_failure(&self) -> bool {
        matches!(
            self.category,
            UpstreamFailureCategory::Timeout | UpstreamFailureCategory::Transport
        ) || matches!(self.http_status, Some(429 | 502 | 503 | 504))
    }

    pub fn is_explicit_http_429(&self) -> bool {
        self.http_status == Some(429)
    }
}

impl std::fmt::Display for UpstreamFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.category {
            UpstreamFailureCategory::Unauthorized => formatter.write_str("认证已失效"),
            UpstreamFailureCategory::RateLimited => {
                formatter.write_str("上游请求受限，请稍后重试。")
            }
            UpstreamFailureCategory::Timeout => {
                formatter.write_str("上游服务响应超时，请稍后重试。")
            }
            UpstreamFailureCategory::Transport => {
                formatter.write_str("请求上游服务失败，请检查网络后重试。")
            }
            UpstreamFailureCategory::Decode => formatter.write_str("上游响应解析失败。"),
            UpstreamFailureCategory::Http => match self.http_status {
                Some(status) if self.message.is_empty() => {
                    write!(formatter, "上游请求失败（HTTP {status}）。")
                }
                Some(status) => {
                    write!(formatter, "上游请求失败（HTTP {status}）：{}", self.message)
                }
                None => formatter.write_str("上游请求失败。"),
            },
            UpstreamFailureCategory::Business => {
                if self.message.is_empty() {
                    formatter.write_str("上游接口返回业务错误。")
                } else {
                    formatter.write_str(&self.message)
                }
            }
        }
    }
}

impl std::error::Error for UpstreamFailure {}

/// 只读请求按网络模式共享连接池；登录/写路径仍按账号独立持有 cookie jar。
fn shared_read_http_client(use_system_proxy: bool) -> Result<Client> {
    static DIRECT: OnceLock<Client> = OnceLock::new();
    static SYSTEM_PROXY: OnceLock<Client> = OnceLock::new();
    let shared = if use_system_proxy {
        &SYSTEM_PROXY
    } else {
        &DIRECT
    };
    if let Some(client) = shared.get() {
        return Ok(client.clone());
    }
    let client = upstream_http_client_builder(use_system_proxy)
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        .timeout(UPSTREAM_REQUEST_TIMEOUT)
        .build()?;
    Ok(shared.get_or_init(|| client).clone())
}

pub struct Sub2ApiClient {
    client: Client,
    base_url: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    request_coordination: SiteRequestCoordination,
    use_system_proxy: bool,
}

#[derive(Clone)]
pub(crate) struct Sub2ApiReadClient {
    client: Client,
    base_url: String,
    access_token: String,
    request_coordination: SiteRequestCoordination,
}

impl Sub2ApiClient {
    pub fn new(
        base_url: &str,
        session: Option<StoredSession>,
        request_coordination: SiteRequestCoordination,
        use_system_proxy: bool,
    ) -> Result<Self> {
        Self::new_with_timeouts(
            base_url,
            session,
            request_coordination,
            use_system_proxy,
            UPSTREAM_CONNECT_TIMEOUT,
            UPSTREAM_REQUEST_TIMEOUT,
        )
    }

    fn new_with_timeouts(
        base_url: &str,
        session: Option<StoredSession>,
        request_coordination: SiteRequestCoordination,
        use_system_proxy: bool,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self> {
        Ok(Self {
            client: upstream_http_client_builder(use_system_proxy)
                .cookie_store(true)
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .build()?,
            base_url: if base_url.ends_with('/') {
                base_url.to_string()
            } else {
                format!("{base_url}/")
            },
            access_token: session.as_ref().and_then(|item| item.access_token.clone()),
            refresh_token: session.and_then(|item| item.refresh_token),
            request_coordination,
            use_system_proxy,
        })
    }

    pub fn serialize(&self) -> StoredSession {
        StoredSession {
            saved_at: now_storage_timestamp(),
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            token_type: self.access_token.as_ref().map(|_| "bearer".to_string()),
            cookie_jar_json: None,
        }
    }

    pub fn has_tokens(&self) -> bool {
        self.access_token.is_some() || self.refresh_token.is_some()
    }

    pub fn has_access_token(&self) -> bool {
        self.access_token.is_some()
    }

    pub(crate) fn read_only_handle(&self) -> Result<Sub2ApiReadClient> {
        let access_token = self
            .access_token
            .clone()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| anyhow!("认证已失效"))?;
        Ok(Sub2ApiReadClient {
            client: shared_read_http_client(self.use_system_proxy)?,
            base_url: self.base_url.clone(),
            access_token,
            request_coordination: self.request_coordination.clone(),
        })
    }

    async fn execute_attempt(
        &self,
        request: RequestBuilder,
        endpoint_family: &str,
        request_class: SiteRequestClass,
    ) -> Result<Value> {
        let permit = self
            .request_coordination
            .acquire(endpoint_family, request_class)
            .await
            .context("共享上游请求协调失败")?;
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                release_request_permit(permit, endpoint_family).await;
                return Err(normalize_upstream_request_error(error, endpoint_family));
            }
        };
        let status = response.status();
        let retry_after_ms = parse_retry_after(response.headers().get(RETRY_AFTER));
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(error) => {
                release_request_permit(permit, endpoint_family).await;
                return Err(normalize_upstream_request_error(error, endpoint_family));
            }
        };
        release_request_permit(permit, endpoint_family).await;

        decode_upstream_response(status, retry_after_ms, &body, endpoint_family)
    }

    pub fn clear_tokens(&mut self) {
        self.access_token = None;
        self.refresh_token = None;
    }

    pub async fn login(&mut self, email: &str, password: &str) -> Result<LoginChallenge> {
        for (path, as_form) in [
            ("/api/v1/auth/login", false),
            ("/api/v1/auth/login", true),
            ("/api/v1/auths/signin", false),
        ] {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let request = if as_form {
                self.client
                    .request(Method::POST, url)
                    .form(&[("email", email), ("password", password)])
            } else {
                self.client
                    .request(Method::POST, url)
                    .json(&json!({ "email": email, "password": password }))
            };
            let payload = match self
                .execute_attempt(request, "auth_login", SiteRequestClass::Auth)
                .await
            {
                Ok(payload) => payload,
                Err(error) if is_http_status(&error, 404) => continue,
                Err(error) => return Err(error),
            };
            if let Some(token) = pick_string(&payload, &["access_token", "token", "jwt"]) {
                self.access_token = Some(token);
            }
            if let Some(refresh_token) = pick_string(&payload, &["refresh_token"]) {
                self.refresh_token = Some(refresh_token);
            }
            return Ok(LoginChallenge {
                requires2fa: payload.get("temp_token").and_then(Value::as_str).is_some(),
                temp_token: pick_string(&payload, &["temp_token"]),
                email_masked: pick_string(&payload, &["user_email_masked", "email_masked"]),
            });
        }
        Err(anyhow!("未找到可用的登录接口。"))
    }

    pub async fn complete_2fa(&mut self, temp_token: &str, code: &str) -> Result<()> {
        for path in ["/api/v1/auth/login/2fa", "/api/v1/auths/signin/2fa"] {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let request = self.client.request(Method::POST, url).json(&json!({
                "temp_token": temp_token,
                "totp_code": code
            }));
            let payload = match self
                .execute_attempt(request, "auth_2fa", SiteRequestClass::Auth)
                .await
            {
                Ok(payload) => payload,
                Err(error) if is_http_status(&error, 404) => continue,
                Err(error) => return Err(error),
            };
            if let Some(token) = pick_string(&payload, &["access_token", "token", "jwt"]) {
                self.access_token = Some(token);
            }
            if let Some(refresh_token) = pick_string(&payload, &["refresh_token"]) {
                self.refresh_token = Some(refresh_token);
            }
            return Ok(());
        }
        Err(anyhow!("未找到可用的 2FA 接口。"))
    }

    pub async fn request_api(
        &mut self,
        path: &str,
        method: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let parsed_method =
            Method::from_bytes(method.as_bytes()).map_err(|_| anyhow!("不支持的请求方法"))?;
        self.request_json_with_method(&[path], parsed_method, body)
            .await
    }

    /// 执行一次用户中心请求，不在基础设施层刷新 token 或重试。
    pub async fn request_api_once(
        &mut self,
        path: &str,
        method: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let parsed_method =
            Method::from_bytes(method.as_bytes()).map_err(|_| anyhow!("不支持的请求方法"))?;
        self.request_json_with_method_with_auth_recovery(&[path], parsed_method, body, false)
            .await
    }

    pub async fn request_api_read_only(
        &self,
        path: &str,
        method: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if method != "GET" || body.is_some() {
            return Err(anyhow!("只读上游请求只允许 GET。"));
        }
        self.read_only_handle()?.get_api(path).await
    }

    pub async fn request_api_key_usage(&self, path: &str, api_key: &str) -> Result<Value> {
        if !path.starts_with("/v1/usage") {
            return Err(anyhow!("仅允许代理密钥用量 API 路径。"));
        }
        let token = api_key.trim();
        if token.is_empty() {
            return Err(anyhow!("当前密钥为空，无法读取完整用量。"));
        }

        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let request = shared_read_http_client(self.use_system_proxy)?
            .request(Method::GET, url)
            .bearer_auth(token);
        self.execute_attempt(request, "key_usage", SiteRequestClass::Interactive)
            .await
    }

    pub async fn build_runtime_cache_view_for_smoke(
        &mut self,
        account: &AccountRecord,
        site: &SiteRecord,
    ) -> Result<AccountCacheView> {
        let profile = self
            .request_json(&["/api/v1/user/profile", "/api/v1/auth/me"])
            .await?;
        let stats = self.dashboard_stats().await?;
        let keys = self.keys().await?;
        let subscriptions = self.subscriptions().await?;
        let usage = self.usage().await?;
        let raw_trend = match self.dashboard_trend(7).await {
            Ok(trend) => trend,
            Err(_) => self.trend(&keys).await?,
        };
        let trend = if raw_trend.is_empty() {
            trend_from_usage(&usage)
        } else {
            raw_trend
        };
        let balance =
            pick_f64(&profile, &["balance", "quota.remaining", "wallet.balance"]).unwrap_or(0.0);
        let fetched_at = Utc::now().to_rfc3339();
        let alerts = build_alerts(account, site, balance, &keys, &fetched_at);
        let active_subscription = subscriptions
            .iter()
            .find(|item| item.status == "active")
            .cloned()
            .or_else(|| subscriptions.first().cloned());

        Ok(AccountCacheView {
            fetched_at,
            online: true,
            site_name: site.name.clone(),
            balance,
            stats,
            recent_usage: usage,
            trend,
            keys,
            subscriptions: subscriptions.clone(),
            active_subscription,
            alerts,
        })
    }

    pub(crate) async fn refresh_token_if_needed(&mut self) -> Result<()> {
        let refresh = match &self.refresh_token {
            Some(value) => value.clone(),
            None => return Ok(()),
        };
        for path in ["/api/v1/auth/refresh", "/api/v1/auths/refresh"] {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let request = self
                .client
                .request(Method::POST, url)
                .json(&json!({ "refresh_token": refresh }));
            let payload = match self
                .execute_attempt(request, "auth_refresh", SiteRequestClass::Auth)
                .await
            {
                Ok(payload) => payload,
                Err(error) if is_http_status(&error, 404) => continue,
                Err(error) => return Err(error),
            };
            self.access_token = pick_string(&payload, &["access_token", "token", "jwt"])
                .or_else(|| self.access_token.clone());
            self.refresh_token =
                pick_string(&payload, &["refresh_token"]).or_else(|| self.refresh_token.clone());
            return Ok(());
        }
        Err(anyhow!("未找到可用的刷新 token 接口。"))
    }

    async fn dashboard_stats(&mut self) -> Result<AccountCacheStats> {
        let raw = self
            .request_json(&["/api/v1/usage/dashboard/stats"])
            .await?;
        Ok(normalize_dashboard_cache_stats(&raw))
    }

    async fn keys(&mut self) -> Result<Vec<KeyRecord>> {
        let raw = self
            .request_json(&["/api/v1/keys?page=1&page_size=100"])
            .await?;
        Ok(normalize_items(&raw)
            .into_iter()
            .map(|item| KeyRecord {
                id: pick_string(&item, &["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                group_id: pick_i64(&item, &["group_id"]),
                name: pick_string(&item, &["name", "key_name"])
                    .unwrap_or_else(|| "Unnamed Key".into()),
                status: pick_string(&item, &["status"]).unwrap_or_else(|| "unknown".into()),
                platform: pick_string(&item, &["group.platform", "platform"]),
                group_name: pick_string(&item, &["group.name", "group_name"]),
                expires_at: pick_string(&item, &["expires_at"]),
                last_used_at: pick_string(&item, &["last_used_at"]),
                quota: pick_f64(&item, &["quota"]),
                quota_used: pick_f64(&item, &["quota_used"]),
                rate_limit5h: pick_f64(&item, &["rate_limit_5h"]),
                rate_limit1d: pick_f64(&item, &["rate_limit_1d"]),
                rate_limit7d: pick_f64(&item, &["rate_limit_7d"]),
                usage5h: pick_f64(&item, &["usage_5h"]),
                usage1d: pick_f64(&item, &["usage_1d"]),
                usage7d: pick_f64(&item, &["usage_7d"]),
                current_concurrency: pick_i64(&item, &["current_concurrency"]),
            })
            .collect())
    }

    async fn subscriptions(&mut self) -> Result<Vec<SubscriptionRecord>> {
        let raw = self
            .request_json(&["/api/v1/subscriptions", "/api/v1/subscriptions/active"])
            .await?;
        let mut subscriptions = normalize_items(&raw)
            .into_iter()
            .map(|item| {
                let upstream_id = pick_string(&item, &["id"]);
                let group_id = pick_i64(&item, &["group_id"]);
                let name = pick_string(&item, &["group.name", "name"])
                    .unwrap_or_else(|| "Subscription".into());
                let group_name = pick_string(&item, &["group.name", "group_name"]);
                let platform = pick_string(&item, &["group.platform", "platform"]);
                let identity = crate::domain::subscription_identity::derive_subscription_identity(
                    group_id,
                    upstream_id.as_deref(),
                    platform.as_deref(),
                    group_name.as_deref(),
                    &name,
                );
                SubscriptionRecord {
                    id: upstream_id.unwrap_or_else(|| identity.subscription_key.clone()),
                    subscription_key: identity.subscription_key,
                    identity_kind: identity.identity_kind,
                    identity_ambiguous: false,
                    upstream_subscription_id: identity.upstream_subscription_id,
                    fallback_identity: identity.fallback_identity,
                    group_id,
                    name,
                    status: pick_string(&item, &["status"]).unwrap_or_else(|| "unknown".into()),
                    group_name,
                    platform,
                    expires_at: pick_string(&item, &["expires_at"]),
                    daily: quota_window(&item, "daily"),
                    weekly: quota_window(&item, "weekly"),
                    monthly: quota_window(&item, "monthly"),
                }
            })
            .collect::<Vec<_>>();
        crate::domain::subscription_identity::mark_ambiguous_subscription_identities(
            &mut subscriptions,
        );
        Ok(subscriptions)
    }

    async fn usage(&mut self) -> Result<Vec<UsageRow>> {
        let raw = self
            .request_json(&["/api/v1/usage?page=1&page_size=20"])
            .await?;
        Ok(normalize_items(&raw)
            .into_iter()
            .map(|item| {
                let input_tokens = pick_i64(&item, &["input_tokens"]).unwrap_or(0);
                let output_tokens = pick_i64(&item, &["output_tokens"]).unwrap_or(0);
                let cache_creation_tokens =
                    pick_i64(&item, &["cache_creation_tokens"]).unwrap_or(0);
                let cache_read_tokens =
                    pick_i64(&item, &["cache_read_tokens", "total_cache_tokens"]).unwrap_or(0);
                UsageRow {
                    id: pick_string(&item, &["id"])
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    upstream_user_id: pick_i64(&item, &["user_id"]),
                    api_key_id: pick_i64(&item, &["api_key_id"]),
                    upstream_account_id: pick_i64(&item, &["account_id"]),
                    request_id: pick_string(&item, &["request_id"]),
                    created_at: pick_string(&item, &["created_at"])
                        .unwrap_or_else(|| Utc::now().to_rfc3339()),
                    model: pick_string(&item, &["model"]).unwrap_or_else(|| "unknown".into()),
                    reasoning_effort: pick_string(&item, &["reasoning_effort"]),
                    endpoint: pick_string(&item, &["endpoint", "inbound_endpoint"]),
                    upstream_endpoint: pick_string(&item, &["upstream_endpoint"]),
                    group_id: pick_i64(&item, &["group_id"]),
                    subscription_id: pick_i64(&item, &["subscription_id"]),
                    actual_cost: pick_f64(&item, &["actual_cost", "total_actual_cost"])
                        .unwrap_or(0.0),
                    total_cost: pick_f64(&item, &["total_cost", "cost"]).unwrap_or(0.0),
                    input_tokens,
                    output_tokens,
                    input_cost: pick_f64(&item, &["input_cost"]),
                    output_cost: pick_f64(&item, &["output_cost"]),
                    cache_creation_tokens: Some(cache_creation_tokens),
                    cache_read_tokens: Some(cache_read_tokens),
                    cache_creation_5m_tokens: pick_i64(&item, &["cache_creation_5m_tokens"]),
                    cache_creation_1h_tokens: pick_i64(&item, &["cache_creation_1h_tokens"]),
                    cache_creation_cost: pick_f64(&item, &["cache_creation_cost"]),
                    cache_read_cost: pick_f64(&item, &["cache_read_cost"]),
                    total_tokens: pick_i64(&item, &["total_tokens"]).unwrap_or(
                        input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens,
                    ),
                    first_token_ms: pick_i64(&item, &["first_token_ms"]),
                    duration_ms: pick_i64(&item, &["duration_ms"]),
                    billing_mode: pick_string(&item, &["billing_mode"]),
                    request_type: pick_string(&item, &["request_type"]),
                    stream: item.get("stream").and_then(Value::as_bool),
                    openai_ws_mode: item.get("openai_ws_mode").and_then(Value::as_bool),
                    billing_type: pick_i64(&item, &["billing_type"]),
                    service_tier: pick_string(&item, &["service_tier"]),
                    long_context_billing_applied: item
                        .get("long_context_billing_applied")
                        .and_then(Value::as_bool),
                    image_count: pick_i64(&item, &["image_count"]),
                    image_input_tokens: pick_i64(&item, &["image_input_tokens"]),
                    image_size: pick_string(&item, &["image_size"]),
                    image_input_size: pick_string(&item, &["image_input_size"]),
                    image_output_size: pick_string(&item, &["image_output_size"]),
                    image_output_tokens: pick_i64(&item, &["image_output_tokens"]),
                    image_input_cost: pick_f64(&item, &["image_input_cost"]),
                    image_output_cost: pick_f64(&item, &["image_output_cost"]),
                    image_size_source: pick_string(&item, &["image_size_source"]),
                    image_size_breakdown: item
                        .get("image_size_breakdown")
                        .map(|value| value.to_string()),
                    media_type: pick_string(&item, &["media_type"]),
                    rate_multiplier: pick_f64(&item, &["rate_multiplier"]),
                    user_agent: pick_string(&item, &["user_agent"]),
                    ip_address: pick_string(&item, &["ip_address"]),
                    cache_ttl_overridden: item.get("cache_ttl_overridden").and_then(Value::as_bool),
                    api_key_name: pick_string(&item, &["api_key.name", "api_key_name"]),
                    platform: pick_string(&item, &["group.platform", "platform"]),
                    subscription_name: pick_string(
                        &item,
                        &["subscription.group.name", "subscription_name", "group.name"],
                    ),
                    group_name: pick_string(&item, &["group.name", "group_name"]),
                    subscription_type: pick_string(
                        &item,
                        &["group.subscription_type", "subscription.subscription_type"],
                    ),
                }
            })
            .collect())
    }

    async fn trend(&mut self, keys: &[KeyRecord]) -> Result<Vec<TrendPoint>> {
        let mut points: HashMap<String, TrendPoint> = HashMap::new();
        for key in keys {
            let raw = match self
                .request_json(&[&format!(
                    "/api/v1/user/api-keys/{}/usage/daily?days=7",
                    key.id
                )])
                .await
            {
                Ok(value) => value,
                Err(_) => continue,
            };

            for item in normalize_items(&raw) {
                if let Some(bucket) = pick_string(&item, &["date", "bucket", "day"]) {
                    let entry = points.entry(bucket.clone()).or_insert(TrendPoint {
                        bucket,
                        actual_cost: 0.0,
                        total_cost: 0.0,
                        requests: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_tokens: 0,
                        cache_read_tokens: 0,
                        total_tokens: 0,
                    });
                    entry.actual_cost +=
                        pick_f64(&item, &["actual_cost", "total_actual_cost"]).unwrap_or(0.0);
                    entry.total_cost += pick_f64(&item, &["total_cost", "cost"]).unwrap_or(0.0);
                    entry.requests += pick_i64(&item, &["requests", "request_count"]).unwrap_or(0);
                    entry.input_tokens += pick_i64(&item, &["input_tokens"]).unwrap_or(0);
                    entry.output_tokens += pick_i64(&item, &["output_tokens"]).unwrap_or(0);
                    entry.cache_creation_tokens +=
                        pick_i64(&item, &["cache_creation_tokens", "cache_write_tokens"])
                            .unwrap_or(0);
                    entry.cache_read_tokens += pick_i64(&item, &["cache_read_tokens"]).unwrap_or(0);
                    entry.total_tokens += pick_i64(&item, &["total_tokens", "tokens"]).unwrap_or(0);
                }
            }
        }
        let mut trend: Vec<TrendPoint> = points.into_values().collect();
        trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));
        Ok(trend)
    }

    async fn dashboard_trend(&mut self, days: i64) -> Result<Vec<TrendPoint>> {
        let end_date = shanghai_today();
        let start_date = end_date - chrono::Days::new(days.saturating_sub(1).max(0) as u64);
        let raw = self
            .request_json(&[&format!(
                "/api/v1/usage/dashboard/trend?start_date={start_date}&end_date={end_date}&granularity=day"
            )])
            .await?;
        let payload = normalize_trend_payload(&raw);
        let mut trend = payload
            .trend
            .into_iter()
            .map(|item| TrendPoint {
                bucket: item.date,
                actual_cost: item.actual_cost.unwrap_or(0.0),
                total_cost: item.total_cost.unwrap_or(0.0),
                requests: item.requests,
                input_tokens: item.input_tokens,
                output_tokens: item.output_tokens,
                cache_creation_tokens: item.cache_write_tokens.unwrap_or(0),
                cache_read_tokens: item.cache_read_tokens.unwrap_or(0),
                total_tokens: item.total_tokens.unwrap_or(0),
            })
            .collect::<Vec<_>>();
        trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));
        Ok(trend)
    }

    async fn request_json(&mut self, paths: &[&str]) -> Result<Value> {
        self.request_json_with_method(paths, Method::GET, None)
            .await
    }

    async fn request_json_with_method(
        &mut self,
        paths: &[&str],
        method: Method,
        body: Option<Value>,
    ) -> Result<Value> {
        self.request_json_with_method_with_auth_recovery(paths, method, body, true)
            .await
    }

    async fn request_json_with_method_with_auth_recovery(
        &mut self,
        paths: &[&str],
        method: Method,
        body: Option<Value>,
        allow_auth_recovery: bool,
    ) -> Result<Value> {
        for path in paths {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let mut request = self.client.request(method.clone(), url);
            if let Some(token) = &self.access_token {
                request = request.bearer_auth(token);
            }
            if let Some(payload) = body.clone() {
                request = request.json(&payload);
            }
            let result = self
                .execute_attempt(
                    request,
                    endpoint_family_for_path(path),
                    request_class_for_method(&method),
                )
                .await;
            match result {
                Ok(value) => return Ok(value),
                Err(error) if is_http_status(&error, 404) => continue,
                Err(error)
                    if allow_auth_recovery
                        && is_upstream_category(&error, UpstreamFailureCategory::Unauthorized)
                        && self.refresh_token.is_some() =>
                {
                    if let Err(refresh_error) = self.refresh_token_if_needed().await {
                        if is_upstream_category(
                            &refresh_error,
                            UpstreamFailureCategory::Unauthorized,
                        ) {
                            self.clear_tokens();
                            return Err(anyhow!("认证已失效"));
                        }
                        return Err(refresh_error);
                    }
                    let mut retry = self.client.request(
                        method.clone(),
                        format!("{}{}", self.base_url.trim_end_matches('/'), path),
                    );
                    if let Some(token) = &self.access_token {
                        retry = retry.bearer_auth(token);
                    }
                    if let Some(payload) = body.clone() {
                        retry = retry.json(&payload);
                    }
                    match self
                        .execute_attempt(
                            retry,
                            endpoint_family_for_path(path),
                            request_class_for_method(&method),
                        )
                        .await
                    {
                        Ok(value) => return Ok(value),
                        Err(error) if is_http_status(&error, 401) => {
                            self.clear_tokens();
                            return Err(error);
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error)
                    if is_upstream_category(&error, UpstreamFailureCategory::Unauthorized) =>
                {
                    self.clear_tokens();
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }

        Err(anyhow!("未找到可用的接口路径。"))
    }
}

impl Sub2ApiReadClient {
    pub async fn get_api(&self, path: &str) -> Result<Value> {
        if !path.starts_with("/api/v1/") {
            return Err(anyhow!("仅允许代理用户中心 API 路径。"));
        }

        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let request = self
            .client
            .request(Method::GET, url)
            .bearer_auth(&self.access_token);
        let permit = self
            .request_coordination
            .acquire(USAGE_PAGE_ENDPOINT_FAMILY, SiteRequestClass::FreshUsage)
            .await
            .context("共享上游请求协调失败")?;
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                release_request_permit(permit, USAGE_PAGE_ENDPOINT_FAMILY).await;
                return Err(normalize_upstream_request_error(
                    error,
                    USAGE_PAGE_ENDPOINT_FAMILY,
                ));
            }
        };
        let status = response.status();
        let retry_after_ms = parse_retry_after(response.headers().get(RETRY_AFTER));
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(error) => {
                release_request_permit(permit, USAGE_PAGE_ENDPOINT_FAMILY).await;
                return Err(normalize_upstream_request_error(
                    error,
                    USAGE_PAGE_ENDPOINT_FAMILY,
                ));
            }
        };
        release_request_permit(permit, USAGE_PAGE_ENDPOINT_FAMILY).await;
        decode_upstream_response(status, retry_after_ms, &body, USAGE_PAGE_ENDPOINT_FAMILY)
    }
}

async fn release_request_permit(permit: SiteRequestPermitGuard, endpoint_family: &str) {
    if let Err(error) = permit.release().await {
        log::warn!(
            "共享上游请求 permit 释放失败: endpoint_family={}, error={}",
            endpoint_family,
            error
        );
    }
}

fn normalize_upstream_request_error(error: reqwest::Error, endpoint_family: &str) -> anyhow::Error {
    let category = if error.is_timeout() {
        UpstreamFailureCategory::Timeout
    } else {
        UpstreamFailureCategory::Transport
    };
    anyhow::Error::new(UpstreamFailure {
        category,
        http_status: None,
        message: if matches!(category, UpstreamFailureCategory::Timeout) {
            "上游服务响应超时".into()
        } else {
            "请求上游服务失败".into()
        },
        retry_after_ms: None,
        endpoint_family: endpoint_family.to_string(),
    })
}

fn decode_upstream_response(
    status: StatusCode,
    retry_after_ms: Option<u64>,
    body: &[u8],
    endpoint_family: &str,
) -> Result<Value> {
    let parsed = serde_json::from_slice::<Value>(body);
    if !status.is_success() {
        let message = parsed
            .as_ref()
            .map(|value| extract_message(value, "上游返回错误"))
            .unwrap_or_else(|_| sanitize_upstream_message(&String::from_utf8_lossy(body)));
        let category = if status == StatusCode::UNAUTHORIZED {
            UpstreamFailureCategory::Unauthorized
        } else if status == StatusCode::TOO_MANY_REQUESTS || is_rate_limit_message(&message) {
            UpstreamFailureCategory::RateLimited
        } else {
            UpstreamFailureCategory::Http
        };
        return Err(anyhow::Error::new(UpstreamFailure {
            category,
            http_status: Some(status.as_u16()),
            message,
            retry_after_ms,
            endpoint_family: endpoint_family.to_string(),
        }));
    }

    let value = parsed.map_err(|_| {
        anyhow::Error::new(UpstreamFailure {
            category: UpstreamFailureCategory::Decode,
            http_status: Some(status.as_u16()),
            message: "上游响应不是有效 JSON".into(),
            retry_after_ms,
            endpoint_family: endpoint_family.to_string(),
        })
    })?;
    unwrap_envelope(value, endpoint_family, retry_after_ms)
}

fn unwrap_envelope(
    value: Value,
    endpoint_family: &str,
    retry_after_ms: Option<u64>,
) -> Result<Value> {
    if let Some(code) = value.get("code").and_then(Value::as_i64) {
        if code != 0 {
            let message = extract_message(&value, "接口返回异常");
            let category = if is_rate_limit_message(&message) {
                UpstreamFailureCategory::RateLimited
            } else {
                UpstreamFailureCategory::Business
            };
            return Err(anyhow::Error::new(UpstreamFailure {
                category,
                http_status: Some(StatusCode::OK.as_u16()),
                message,
                retry_after_ms,
                endpoint_family: endpoint_family.to_string(),
            }));
        }
        if let Some(inner) = value.get("data") {
            return Ok(inner.clone());
        }
    } else if let Some(message) = value.get("message").and_then(Value::as_str) {
        let message = sanitize_upstream_message(message);
        if is_rate_limit_message(&message) {
            return Err(anyhow::Error::new(UpstreamFailure {
                category: UpstreamFailureCategory::RateLimited,
                http_status: Some(StatusCode::OK.as_u16()),
                message,
                retry_after_ms,
                endpoint_family: endpoint_family.to_string(),
            }));
        }
    }
    Ok(value)
}

fn is_http_status(error: &anyhow::Error, status: u16) -> bool {
    error
        .downcast_ref::<UpstreamFailure>()
        .is_some_and(|failure| failure.http_status == Some(status))
}

fn is_upstream_category(error: &anyhow::Error, category: UpstreamFailureCategory) -> bool {
    error
        .downcast_ref::<UpstreamFailure>()
        .is_some_and(|failure| failure.category == category)
}

fn request_class_for_method(method: &Method) -> SiteRequestClass {
    if method == Method::GET {
        SiteRequestClass::Interactive
    } else {
        SiteRequestClass::Write
    }
}

fn endpoint_family_for_path(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or(path);
    if path == "/api/v1/usage" {
        return USAGE_PAGE_ENDPOINT_FAMILY;
    }
    if path.starts_with("/api/v1/auth") {
        return "auth";
    }
    if path.starts_with("/api/v1/usage") {
        return "usage";
    }
    if path.starts_with("/api/v1/keys") {
        return "keys";
    }
    if path.starts_with("/api/v1/subscriptions") {
        return "subscriptions";
    }
    if path.starts_with("/api/v1/groups") {
        return "groups";
    }
    if path.starts_with("/api/v1/user") {
        return "user";
    }
    "user_center"
}

fn parse_retry_after(value: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    let value = value?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.saturating_mul(1_000));
    }
    let when = httpdate::parse_http_date(value).ok()?;
    Some(
        when.duration_since(SystemTime::now())
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
    )
}

fn is_rate_limit_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("too many request")
        || normalized.contains("rate limit")
        || normalized.contains("rate-limit")
        || normalized.contains("请求过于频繁")
        || normalized.contains("请求频率")
        || normalized.contains("请求受限")
        || normalized.contains("稍后重试")
}

fn sanitize_upstream_message(message: &str) -> String {
    let mut parts = Vec::new();
    for raw_part in message.split_whitespace() {
        let trimmed = raw_part.trim_matches(|value: char| {
            matches!(
                value,
                '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '"' | '\''
            )
        });
        let lower = trimmed.to_ascii_lowercase();
        let is_url = lower.starts_with("http://") || lower.starts_with("https://");
        let is_sensitive = [
            "token=",
            "password=",
            "passwd=",
            "cookie=",
            "authorization:",
            "bearer",
            "api_key=",
            "apikey=",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
        let is_email = trimmed.matches('@').count() == 1
            && trimmed
                .split_once('@')
                .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'));
        if is_url || is_sensitive || is_email {
            parts.push("[已隐藏敏感信息]");
        } else {
            parts.push(trimmed);
        }
    }
    parts.join(" ").chars().take(256).collect::<String>()
}

fn normalize_items(value: &Value) -> Vec<Value> {
    for key in [
        "items",
        "data",
        "list",
        "subscriptions",
        "models",
        "trend",
        "platform_quotas",
    ] {
        if let Some(array) = pick_value(value, key).and_then(Value::as_array) {
            return array.clone();
        }
    }
    value.as_array().cloned().unwrap_or_default()
}

fn quota_window(value: &Value, prefix: &str) -> Option<SubscriptionQuotaWindow> {
    let limit = pick_f64(
        value,
        &[
            &format!("{prefix}_limit_usd"),
            &format!("group.{prefix}_limit_usd"),
        ],
    )?;
    if limit <= 0.0 {
        return None;
    }
    Some(SubscriptionQuotaWindow {
        current: pick_f64(value, &[&format!("{prefix}_usage_usd")]).unwrap_or(0.0),
        limit,
        window_start: pick_string(value, &[&format!("{prefix}_window_start")]),
    })
}

fn trend_from_usage(usage: &[UsageRow]) -> Vec<TrendPoint> {
    let mut points: HashMap<String, TrendPoint> = HashMap::new();
    for row in usage {
        let bucket = row.created_at.chars().take(10).collect::<String>();
        let entry = points.entry(bucket.clone()).or_insert(TrendPoint {
            bucket,
            actual_cost: 0.0,
            total_cost: 0.0,
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
        });
        entry.actual_cost += row.actual_cost;
        entry.total_cost += row.total_cost;
        entry.requests += 1;
        entry.input_tokens += row.input_tokens;
        entry.output_tokens += row.output_tokens;
        entry.cache_creation_tokens += row.cache_creation_tokens.unwrap_or(0);
        entry.cache_read_tokens += row.cache_read_tokens.unwrap_or(0);
        entry.total_tokens += row.total_tokens;
    }

    let mut trend: Vec<TrendPoint> = points.into_values().collect();
    trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    trend
}

fn pick_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, segment| current.get(segment))
}

fn pick_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        pick_value(value, key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(ToString::to_string)
    })
}

fn pick_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let node = pick_value(value, key)?;
        node.as_f64()
            .or_else(|| node.as_str().and_then(|item| item.parse::<f64>().ok()))
    })
}

fn pick_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let node = pick_value(value, key)?;
        node.as_i64()
            .or_else(|| node.as_str().and_then(|item| item.parse::<i64>().ok()))
    })
}

fn extract_message(value: &Value, fallback: &str) -> String {
    pick_string(value, &["message", "error", "detail"]).unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, SystemTime};

    use axum::{
        extract::Json,
        http::{header, HeaderValue, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Router,
    };
    use serde_json::{json, Value};

    use super::{parse_retry_after, Sub2ApiClient, UpstreamFailure, UpstreamFailureCategory};
    use crate::application::runtime_coordination_service::RuntimeCoordinationService;
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::runtime_coordination::SiteRequestCoordination;
    use crate::test_support::TestAxumServer;

    fn test_request_coordination(base_url: &str) -> SiteRequestCoordination {
        let root = std::env::temp_dir().join(format!(
            "input-panel-sub2api-client-coordination-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("create coordination directory");
        RuntimeCoordinationService::from_paths_for_test(&paths)
            .expect("initialize runtime coordination")
            .site_request_coordination(base_url)
            .expect("create site request coordination")
    }

    #[test]
    fn retry_after_supports_seconds_http_date_and_invalid_fallback() {
        let seconds = HeaderValue::from_static("3");
        assert_eq!(parse_retry_after(Some(&seconds)), Some(3_000));

        let future = SystemTime::now() + Duration::from_secs(2);
        let http_date = HeaderValue::from_str(&httpdate::fmt_http_date(future))
            .expect("valid HTTP-date header");
        let parsed = parse_retry_after(Some(&http_date)).expect("parse HTTP-date");
        assert!(
            (500..=2_000).contains(&parsed),
            "unexpected delay: {parsed}"
        );

        let invalid = HeaderValue::from_static("not-a-retry-delay");
        assert_eq!(parse_retry_after(Some(&invalid)), None);
    }

    #[tokio::test]
    async fn non_json_429_preserves_metadata_and_sanitizes_message() {
        let app = Router::new().route(
            "/api/v1/test",
            get(|| async {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(header::RETRY_AFTER, "1")],
                    "Too many requests for demo@example.com at https://example.test token=secret",
                )
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let mut client = Sub2ApiClient::new(
            server.base_url(),
            Some(crate::contracts::StoredSession {
                saved_at: "2026-08-08 00:00:00".into(),
                access_token: Some("access".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
            test_request_coordination(server.base_url()),
            false,
        )
        .expect("create client");

        let error = client
            .request_api_once("/api/v1/test", "GET", None)
            .await
            .expect_err("429 must remain an error");
        let failure = error
            .downcast_ref::<UpstreamFailure>()
            .expect("structured upstream failure");
        assert_eq!(failure.category, UpstreamFailureCategory::RateLimited);
        assert_eq!(failure.http_status, Some(429));
        assert_eq!(failure.retry_after_ms, Some(1_000));
        assert!(!failure.message.contains("demo@example.com"));
        assert!(!failure.message.contains("https://example.test"));
        assert!(!failure.message.contains("token=secret"));
        server.shutdown().await;
    }

    #[tokio::test]
    async fn successful_http_business_rate_limit_is_structured() {
        let app = Router::new().route(
            "/api/v1/test",
            get(|| async {
                Json(json!({
                    "code": 42901,
                    "message": "Too many requests, please slow down"
                }))
            }),
        );
        let server = TestAxumServer::start(move |_| app).await;
        let mut client = Sub2ApiClient::new(
            server.base_url(),
            Some(crate::contracts::StoredSession {
                saved_at: "2026-08-08 00:00:00".into(),
                access_token: Some("access".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
            test_request_coordination(server.base_url()),
            false,
        )
        .expect("create client");

        let error = client
            .request_api_once("/api/v1/test", "GET", None)
            .await
            .expect_err("business rate-limit must remain an error");
        let failure = error
            .downcast_ref::<UpstreamFailure>()
            .expect("structured upstream failure");
        assert_eq!(failure.category, UpstreamFailureCategory::RateLimited);
        assert_eq!(failure.http_status, Some(200));
        server.shutdown().await;
    }

    #[tokio::test]
    async fn login_returns_readable_error_when_upstream_times_out() {
        let server = TestAxumServer::start(|shutdown| {
            Router::new().route(
                "/api/v1/auth/login",
                post(move || {
                    let mut shutdown = shutdown.clone();
                    async move {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                                Json(json!({ "code": 0, "data": {} })).into_response()
                            }
                            _ = shutdown.changed() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                        }
                    }
                }),
            )
        })
        .await;

        let mut client = Sub2ApiClient::new_with_timeouts(
            server.base_url(),
            None,
            test_request_coordination(server.base_url()),
            false,
            Duration::from_millis(20),
            Duration::from_millis(50),
        )
        .expect("create client");
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            client.login("demo@example.com", "secret"),
        )
        .await
        .expect("client request must finish")
        .expect_err("request must time out");

        server.shutdown().await;
        assert_eq!(error.to_string(), "上游服务响应超时，请稍后重试。");
    }

    #[tokio::test]
    async fn request_api_once_returns_401_without_refreshing_token() {
        let refresh_hits = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/api/v1/test",
                get(|| async { axum::http::StatusCode::UNAUTHORIZED }),
            )
            .route(
                "/api/v1/auth/refresh",
                post({
                    let refresh_hits = Arc::clone(&refresh_hits);
                    move || {
                        let refresh_hits = Arc::clone(&refresh_hits);
                        async move {
                            refresh_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "code": 0,
                                "data": {
                                    "access_token": "access-new",
                                    "refresh_token": "refresh-new"
                                }
                            }))
                        }
                    }
                }),
            );
        let server = TestAxumServer::start(move |_| app).await;

        let mut client = Sub2ApiClient::new(
            server.base_url(),
            Some(crate::contracts::StoredSession {
                saved_at: "2026-07-29T00:00:00Z".into(),
                access_token: Some("access-old".into()),
                refresh_token: Some("refresh-old".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
            test_request_coordination(server.base_url()),
            false,
        )
        .expect("create client");

        let error = client
            .request_api_once("/api/v1/test", "GET", None)
            .await
            .expect_err("single request must surface 401");

        server.shutdown().await;
        assert_eq!(error.to_string(), "认证已失效");
        assert_eq!(refresh_hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn supports_2fa_flow_and_build_runtime_cache_view_for_smoke() {
        let app = Router::new()
            .route("/api/v1/auth/login", post(|| async {
                Json(json!({
                    "code": 0,
                    "data": {
                        "temp_token": "temp-123",
                        "user_email_masked": "demo***@example.com"
                    }
                }))
            }))
            .route("/api/v1/auth/login/2fa", post(|Json(body): Json<Value>| async move {
                let ok = body.get("temp_token").and_then(Value::as_str) == Some("temp-123")
                    && body.get("totp_code").and_then(Value::as_str) == Some("654321");
                if ok {
                    Json(json!({
                        "code": 0,
                        "data": {
                            "access_token": "access-2fa",
                            "refresh_token": "refresh-2fa"
                        }
                    }))
                } else {
                    Json(json!({ "message": "bad code" }))
                }
            }))
            .route("/api/v1/user/profile", get(|| async {
                Json(json!({ "balance": 3.2, "email": "demo@example.com" }))
            }))
            .route("/api/v1/usage/dashboard/stats", get(|| async {
                Json(json!({ "total_api_keys": 0, "active_api_keys": 0, "today_requests": 1, "total_requests": 1, "today_actual_cost": 0.1, "total_actual_cost": 0.1, "today_cost": 0.1, "total_cost": 0.1, "today_tokens": 10, "total_tokens": 10, "today_input_tokens": 5, "today_output_tokens": 5, "average_duration_ms": 100, "by_platform": [] }))
            }))
            .route("/api/v1/keys", get(|| async { Json(json!({ "items": [] })) }))
            .route("/api/v1/keys?page=1&page_size=100", get(|| async { Json(json!({ "items": [] })) }))
            .route("/api/v1/subscriptions", get(|| async { Json(json!({ "items": [] })) }))
            .route("/api/v1/usage/dashboard/trend", get(|| async {
                Json(json!({
                    "start_date": "2026-06-09",
                    "end_date": "2026-06-15",
                    "trend": [
                        {
                            "date": "2026-06-09",
                            "requests": 7,
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "cache_read_tokens": 300,
                            "cache_write_tokens": 0,
                            "total_tokens": 440,
                            "actual_cost": 1.5,
                            "total_cost": 1.5
                        },
                        {
                            "date": "2026-06-15",
                            "requests": 2,
                            "input_tokens": 30,
                            "output_tokens": 10,
                            "cache_read_tokens": 20,
                            "cache_write_tokens": 0,
                            "total_tokens": 60,
                            "actual_cost": 0.5,
                            "total_cost": 0.5
                        }
                    ]
                }))
            }))
            .route("/api/v1/usage", get(|| async {
                Json(json!({
                    "items": [
                        {
                            "id": "usage-fields",
                            "created_at": "2026-07-28T00:00:00+08:00",
                            "model": "gpt-5.4",
                            "service_tier": "priority",
                            "image_input_tokens": 42,
                            "image_input_cost": 0.125,
                            "long_context_billing_applied": true
                        }
                    ]
                }))
            }));

        let server = TestAxumServer::start(move |_| app).await;

        let base_url = server.base_url().to_string();
        let mut client =
            Sub2ApiClient::new(&base_url, None, test_request_coordination(&base_url), false)
                .expect("create client");
        let login = client
            .login("demo@example.com", "secret")
            .await
            .expect("login challenge");
        assert!(login.requires2fa);
        client
            .complete_2fa("temp-123", "654321")
            .await
            .expect("complete 2fa");
        let cache_view = client
            .build_runtime_cache_view_for_smoke(
                &AccountRecord {
                    id: "account-3".into(),
                    site_id: "site-3".into(),
                    label: "2FA".into(),
                    email: "demo@example.com".into(),
                    balance_warning: 1.0,
                    last_login_at: None,
                    created_at: "2026-06-05T00:00:00.000Z".into(),
                    updated_at: "2026-06-05T00:00:00.000Z".into(),
                },
                &SiteRecord {
                    id: "site-3".into(),
                    name: "2FA Site".into(),
                    base_url,
                    created_at: "2026-06-05T00:00:00.000Z".into(),
                    updated_at: "2026-06-05T00:00:00.000Z".into(),
                    ..SiteRecord::default()
                },
            )
            .await
            .expect("build runtime cache view for smoke");
        assert_eq!(cache_view.balance, 3.2);
        assert_eq!(cache_view.trend.len(), 2);
        assert_eq!(cache_view.trend[0].bucket, "2026-06-09");
        assert_eq!(cache_view.trend[0].requests, 7);
        assert_eq!(cache_view.trend[1].bucket, "2026-06-15");
        assert_eq!(cache_view.trend[1].total_tokens, 60);
        assert_eq!(cache_view.recent_usage.len(), 1);
        assert_eq!(
            cache_view.recent_usage[0].service_tier.as_deref(),
            Some("priority")
        );
        assert_eq!(cache_view.recent_usage[0].image_input_tokens, Some(42));
        assert_eq!(cache_view.recent_usage[0].image_input_cost, Some(0.125));
        assert_eq!(
            cache_view.recent_usage[0].long_context_billing_applied,
            Some(true)
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn falls_back_to_key_daily_when_dashboard_trend_is_unavailable() {
        let app = Router::new()
            .route("/api/v1/user/profile", get(|| async {
                Json(json!({ "balance": 3.2, "email": "demo@example.com" }))
            }))
            .route("/api/v1/usage/dashboard/stats", get(|| async {
                Json(json!({ "total_api_keys": 1, "active_api_keys": 1, "today_requests": 1, "total_requests": 1, "today_actual_cost": 0.1, "total_actual_cost": 0.1, "today_cost": 0.1, "total_cost": 0.1, "today_tokens": 10, "total_tokens": 10, "today_input_tokens": 5, "today_output_tokens": 5, "average_duration_ms": 100, "by_platform": [] }))
            }))
            .route("/api/v1/keys", get(|| async {
                Json(json!({
                    "items": [
                        {
                            "id": "key-1",
                            "name": "demo-key",
                            "status": "active"
                        }
                    ]
                }))
            }))
            .route("/api/v1/subscriptions", get(|| async { Json(json!({ "items": [] })) }))
            .route("/api/v1/usage/dashboard/trend", get(|| async {
                axum::http::StatusCode::NOT_FOUND
            }))
            .route("/api/v1/user/api-keys/key-1/usage/daily", get(|| async {
                Json(json!({
                    "items": [
                        {
                            "date": "2026-06-14",
                            "requests": 4,
                            "input_tokens": 200,
                            "output_tokens": 80,
                            "cache_read_tokens": 120,
                            "total_tokens": 400,
                            "actual_cost": 0.8,
                            "total_cost": 0.8
                        }
                    ]
                }))
            }))
            .route("/api/v1/usage", get(|| async { Json(json!({ "items": [] })) }));

        let server = TestAxumServer::start(move |_| app).await;

        let base_url = server.base_url().to_string();
        let mut client = Sub2ApiClient::new(
            &base_url,
            Some(crate::contracts::StoredSession {
                saved_at: "2026-06-15T00:00:00Z".into(),
                access_token: Some("token".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            }),
            test_request_coordination(&base_url),
            false,
        )
        .expect("create client");

        let cache_view = client
            .build_runtime_cache_view_for_smoke(
                &AccountRecord {
                    id: "account-4".into(),
                    site_id: "site-4".into(),
                    label: "fallback".into(),
                    email: "demo@example.com".into(),
                    balance_warning: 1.0,
                    last_login_at: None,
                    created_at: "2026-06-05T00:00:00.000Z".into(),
                    updated_at: "2026-06-05T00:00:00.000Z".into(),
                },
                &SiteRecord {
                    id: "site-4".into(),
                    name: "Fallback Site".into(),
                    base_url,
                    created_at: "2026-06-05T00:00:00.000Z".into(),
                    updated_at: "2026-06-05T00:00:00.000Z".into(),
                    ..SiteRecord::default()
                },
            )
            .await
            .expect("build runtime cache view for smoke");

        assert_eq!(cache_view.trend.len(), 1);
        assert_eq!(cache_view.trend[0].bucket, "2026-06-14");
        assert_eq!(cache_view.trend[0].requests, 4);
        assert_eq!(cache_view.trend[0].cache_read_tokens, 120);
        server.shutdown().await;
    }
}
