use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use reqwest::{Client, Method};
use serde_json::{json, Value};

use crate::contracts::{
    AccountRecord, AccountSnapshot, KeyRecord, LoginChallenge, PlatformPoint, SiteRecord,
    SnapshotStats, StoredSession, SubscriptionQuotaWindow, SubscriptionRecord,
    TrendPoint, UsageRow, UsageSummary,
};
use crate::domain::alerts::build_alerts;

pub struct Sub2ApiClient {
    client: Client,
    base_url: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

impl Sub2ApiClient {
    pub fn new(base_url: &str, session: Option<StoredSession>) -> Result<Self> {
        Ok(Self {
            client: Client::builder().cookie_store(true).build()?,
            base_url: if base_url.ends_with('/') {
                base_url.to_string()
            } else {
                format!("{base_url}/")
            },
            access_token: session.as_ref().and_then(|item| item.access_token.clone()),
            refresh_token: session.and_then(|item| item.refresh_token),
        })
    }

    pub fn serialize(&self) -> StoredSession {
        StoredSession {
            saved_at: Utc::now().to_rfc3339(),
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            token_type: self.access_token.as_ref().map(|_| "bearer".to_string()),
            cookie_jar_json: None,
        }
    }

    pub fn has_tokens(&self) -> bool {
        self.access_token.is_some() || self.refresh_token.is_some()
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
            let response = request.send().await?;
            if response.status().as_u16() == 404 {
                continue;
            }
            let is_success = response.status().is_success();
            let value: Value = response.json().await.context("登录响应解析失败")?;
            if !is_success {
                return Err(anyhow!(extract_message(&value, "登录失败")));
            }
            let payload = unwrap_envelope(value)?;
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
            let response = self
                .client
                .request(Method::POST, url)
                .json(&json!({
                    "temp_token": temp_token,
                    "code": code
                }))
                .send()
                .await?;
            if response.status().as_u16() == 404 {
                continue;
            }
            let is_success = response.status().is_success();
            let value: Value = response.json().await.context("2FA 响应解析失败")?;
            if !is_success {
                return Err(anyhow!(extract_message(&value, "2FA 验证失败")));
            }
            let payload = unwrap_envelope(value)?;
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
        let parsed_method = Method::from_bytes(method.as_bytes())
            .map_err(|_| anyhow!("不支持的请求方法"))?;
        self.request_json_with_method(&[path], parsed_method, body).await
    }

    pub async fn build_snapshot(
        &mut self,
        account: &AccountRecord,
        site: &SiteRecord,
    ) -> Result<AccountSnapshot> {
        let profile = self.request_json(&["/api/v1/user/profile", "/api/v1/auth/me"]).await?;
        let stats = self.dashboard_stats().await?;
        let keys = self.keys().await?;
        let subscriptions = self.subscriptions().await?;
        let usage = self.usage().await?;
        let raw_trend = self.trend(&keys).await?;
        let trend = if raw_trend.is_empty() {
            trend_from_usage(&usage)
        } else {
            raw_trend
        };
        let usage_summary = usage_summary(&stats, &usage);
        let balance = pick_f64(&profile, &["balance", "quota.remaining", "wallet.balance"]).unwrap_or(0.0);
        let fetched_at = Utc::now().to_rfc3339();
        let alerts = build_alerts(account, site, balance, &keys, &fetched_at);
        let active_subscription = subscriptions
            .iter()
            .find(|item| item.status == "active")
            .cloned()
            .or_else(|| subscriptions.first().cloned());

        Ok(AccountSnapshot {
            fetched_at,
            online: true,
            site_name: site.name.clone(),
            site_url: site.base_url.clone(),
            account_label: account.label.clone(),
            email_masked: pick_string(&profile, &["email", "email_masked", "user.email"]),
            balance,
            currency: pick_string(&profile, &["currency"]).unwrap_or_else(|| "USD".into()),
            stats,
            usage_summary,
            recent_usage: usage,
            request_history: Vec::new(),
            trend,
            keys,
            subscriptions: subscriptions.clone(),
            active_subscription,
            alerts,
        })
    }

    async fn refresh_token_if_needed(&mut self) -> Result<()> {
        let refresh = match &self.refresh_token {
            Some(value) => value.clone(),
            None => return Ok(()),
        };
        for path in ["/api/v1/auth/refresh", "/api/v1/auths/refresh"] {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let response = self
                .client
                .request(Method::POST, url)
                .json(&json!({ "refresh_token": refresh }))
                .send()
                .await?;
            if response.status().as_u16() == 404 {
                continue;
            }
            if !response.status().is_success() {
                return Err(anyhow!("刷新 token 失败"));
            }
            let value: Value = response.json().await?;
            let payload = unwrap_envelope(value)?;
            self.access_token =
                pick_string(&payload, &["access_token", "token", "jwt"]).or_else(|| self.access_token.clone());
            self.refresh_token =
                pick_string(&payload, &["refresh_token"]).or_else(|| self.refresh_token.clone());
            return Ok(());
        }
        Err(anyhow!("未找到可用的刷新 token 接口。"))
    }

    async fn dashboard_stats(&mut self) -> Result<SnapshotStats> {
        let raw = self.request_json(&["/api/v1/usage/dashboard/stats"]).await?;
        let by_platform = array_at(&raw, &["by_platform", "platforms"])
            .into_iter()
            .map(|item| PlatformPoint {
                platform: pick_string(&item, &["platform", "name"]).unwrap_or_else(|| "unknown".into()),
                total_actual_cost: pick_f64(&item, &["total_actual_cost", "actual_cost"]).unwrap_or(0.0),
                today_actual_cost: pick_f64(&item, &["today_actual_cost"]).unwrap_or(0.0),
                total_requests: pick_i64(&item, &["total_requests", "requests"]).unwrap_or(0),
                total_tokens: pick_i64(&item, &["total_tokens", "tokens"]).unwrap_or(0),
            })
            .collect();

        Ok(SnapshotStats {
            total_api_keys: pick_i64(&raw, &["total_api_keys"]).unwrap_or(0),
            active_api_keys: pick_i64(&raw, &["active_api_keys"]).unwrap_or(0),
            today_requests: pick_i64(&raw, &["today_requests"]).unwrap_or(0),
            total_requests: pick_i64(&raw, &["total_requests"]).unwrap_or(0),
            today_actual_cost: pick_f64(&raw, &["today_actual_cost", "actual_cost"]).unwrap_or(0.0),
            total_actual_cost: pick_f64(&raw, &["total_actual_cost", "actual_cost"]).unwrap_or(0.0),
            today_cost: pick_f64(&raw, &["today_cost"]).unwrap_or(0.0),
            total_cost: pick_f64(&raw, &["total_cost"]).unwrap_or(0.0),
            today_tokens: pick_i64(&raw, &["today_tokens"]).unwrap_or(0),
            total_tokens: pick_i64(&raw, &["total_tokens"]).unwrap_or(0),
            today_input_tokens: pick_i64(&raw, &["today_input_tokens", "input_tokens"]).unwrap_or(0),
            today_output_tokens: pick_i64(&raw, &["today_output_tokens", "output_tokens"]).unwrap_or(0),
            average_duration_ms: pick_f64(&raw, &["average_duration_ms", "avg_duration_ms"]).unwrap_or(0.0),
            by_platform,
        })
    }

    async fn keys(&mut self) -> Result<Vec<KeyRecord>> {
        let raw = self.request_json(&["/api/v1/keys?page=1&page_size=100"]).await?;
        Ok(normalize_items(&raw)
            .into_iter()
            .map(|item| KeyRecord {
                id: pick_string(&item, &["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                group_id: pick_i64(&item, &["group_id"]),
                name: pick_string(&item, &["name", "key_name"]).unwrap_or_else(|| "Unnamed Key".into()),
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
            })
            .collect())
    }

    async fn subscriptions(&mut self) -> Result<Vec<SubscriptionRecord>> {
        let raw = self
            .request_json(&["/api/v1/subscriptions", "/api/v1/subscriptions/active"])
            .await?;
        Ok(normalize_items(&raw)
            .into_iter()
            .map(|item| SubscriptionRecord {
                id: pick_string(&item, &["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                group_id: pick_i64(&item, &["group_id"]),
                name: pick_string(&item, &["group.name", "name"]).unwrap_or_else(|| "Subscription".into()),
                status: pick_string(&item, &["status"]).unwrap_or_else(|| "unknown".into()),
                group_name: pick_string(&item, &["group.name", "group_name"]),
                platform: pick_string(&item, &["group.platform", "platform"]),
                expires_at: pick_string(&item, &["expires_at"]),
                daily: quota_window(&item, "daily"),
                weekly: quota_window(&item, "weekly"),
                monthly: quota_window(&item, "monthly"),
            })
            .collect())
    }

    async fn usage(&mut self) -> Result<Vec<UsageRow>> {
        let raw = self.request_json(&["/api/v1/usage?page=1&page_size=20"]).await?;
        Ok(normalize_items(&raw)
            .into_iter()
            .map(|item| {
                let input_tokens = pick_i64(&item, &["input_tokens"]).unwrap_or(0);
                let output_tokens = pick_i64(&item, &["output_tokens"]).unwrap_or(0);
                let cache_creation_tokens = pick_i64(&item, &["cache_creation_tokens"]).unwrap_or(0);
                let cache_read_tokens =
                    pick_i64(&item, &["cache_read_tokens", "total_cache_tokens"]).unwrap_or(0);
                UsageRow {
                    id: pick_string(&item, &["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    api_key_id: pick_i64(&item, &["api_key_id"]),
                    created_at: pick_string(&item, &["created_at"]).unwrap_or_else(|| Utc::now().to_rfc3339()),
                    model: pick_string(&item, &["model"]).unwrap_or_else(|| "unknown".into()),
                    reasoning_effort: pick_string(&item, &["reasoning_effort"]),
                    endpoint: pick_string(&item, &["endpoint", "inbound_endpoint"]),
                    upstream_endpoint: pick_string(&item, &["upstream_endpoint"]),
                    actual_cost: pick_f64(&item, &["actual_cost", "total_actual_cost"]).unwrap_or(0.0),
                    total_cost: pick_f64(&item, &["total_cost", "cost"]).unwrap_or(0.0),
                    input_tokens,
                    output_tokens,
                    input_cost: pick_f64(&item, &["input_cost"]),
                    output_cost: pick_f64(&item, &["output_cost"]),
                    cache_creation_tokens: Some(cache_creation_tokens),
                    cache_read_tokens: Some(cache_read_tokens),
                    cache_creation_cost: pick_f64(&item, &["cache_creation_cost"]),
                    cache_read_cost: pick_f64(&item, &["cache_read_cost"]),
                    total_tokens: pick_i64(&item, &["total_tokens"])
                        .unwrap_or(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens),
                    first_token_ms: pick_i64(&item, &["first_token_ms"]),
                    duration_ms: pick_i64(&item, &["duration_ms"]),
                    billing_mode: pick_string(&item, &["billing_mode"]),
                    request_type: pick_string(&item, &["request_type"]),
                    stream: item.get("stream").and_then(Value::as_bool),
                    billing_type: pick_i64(&item, &["billing_type"]),
                    rate_multiplier: pick_f64(&item, &["rate_multiplier"]),
                    user_agent: pick_string(&item, &["user_agent"]),
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
                .request_json(&[&format!("/api/v1/user/api-keys/{}/usage/daily?days=7", key.id)])
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
                    entry.actual_cost += pick_f64(&item, &["actual_cost", "total_actual_cost"]).unwrap_or(0.0);
                    entry.total_cost += pick_f64(&item, &["total_cost", "cost"]).unwrap_or(0.0);
                    entry.requests += pick_i64(&item, &["requests", "request_count"]).unwrap_or(0);
                    entry.input_tokens += pick_i64(&item, &["input_tokens"]).unwrap_or(0);
                    entry.output_tokens += pick_i64(&item, &["output_tokens"]).unwrap_or(0);
                    entry.cache_creation_tokens +=
                        pick_i64(&item, &["cache_creation_tokens", "cache_write_tokens"]).unwrap_or(0);
                    entry.cache_read_tokens += pick_i64(&item, &["cache_read_tokens"]).unwrap_or(0);
                    entry.total_tokens += pick_i64(&item, &["total_tokens", "tokens"]).unwrap_or(0);
                }
            }
        }
        let mut trend: Vec<TrendPoint> = points.into_values().collect();
        trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));
        Ok(trend)
    }

    async fn request_json(&mut self, paths: &[&str]) -> Result<Value> {
        self.request_json_with_method(paths, Method::GET, None).await
    }

    async fn request_json_with_method(
        &mut self,
        paths: &[&str],
        method: Method,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut last_error: Option<anyhow::Error> = None;

        for path in paths {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let mut request = self.client.request(method.clone(), url);
            if let Some(token) = &self.access_token {
                request = request.bearer_auth(token);
            }
            if let Some(payload) = body.clone() {
                request = request.json(&payload);
            }
            let response = request.send().await?;

            if response.status().as_u16() == 404 {
                continue;
            }

            if response.status().as_u16() == 401 && self.refresh_token.is_some() {
                if self.refresh_token_if_needed().await.is_err() {
                    self.clear_tokens();
                    return Err(anyhow!("认证已失效"));
                }
                let mut retry = self
                    .client
                    .request(method.clone(), format!("{}{}", self.base_url.trim_end_matches('/'), path));
                if let Some(token) = &self.access_token {
                    retry = retry.bearer_auth(token);
                }
                if let Some(payload) = body.clone() {
                    retry = retry.json(&payload);
                }
                let retried = retry.send().await?;
                let retried_status = retried.status().as_u16();
                let retried_ok = retried_status < 400;
                let value: Value = retried.json().await?;
                if retried_ok {
                    return unwrap_envelope(value);
                }
                if retried_status == 401 {
                    self.clear_tokens();
                    return Err(anyhow!("认证已失效"));
                }
                last_error = Some(anyhow!(extract_message(&value, "请求失败")));
                break;
            }

            if response.status().as_u16() == 401 {
                self.clear_tokens();
                return Err(anyhow!("认证已失效"));
            }

            let is_success = response.status().is_success();
            let value: Value = response.json().await?;
            if !is_success {
                last_error = Some(anyhow!(extract_message(&value, "请求失败")));
                break;
            }
            return unwrap_envelope(value);
        }

        Err(last_error.unwrap_or_else(|| anyhow!("未找到可用的接口路径。")))
    }
}

fn unwrap_envelope(value: Value) -> Result<Value> {
    if let Some(code) = value.get("code").and_then(Value::as_i64) {
        if code != 0 {
            return Err(anyhow!(extract_message(&value, "接口返回异常")));
        }
        if let Some(inner) = value.get("data") {
            return Ok(inner.clone());
        }
    }
    Ok(value)
}

fn normalize_items(value: &Value) -> Vec<Value> {
    for key in ["items", "data", "list", "subscriptions", "models", "trend", "platform_quotas"] {
        if let Some(array) = pick_value(value, key).and_then(Value::as_array) {
            return array.clone();
        }
    }
    value.as_array().cloned().unwrap_or_default()
}

fn array_at(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(array) = pick_value(value, key).and_then(Value::as_array) {
            return array.clone();
        }
    }
    Vec::new()
}

fn quota_window(value: &Value, prefix: &str) -> Option<SubscriptionQuotaWindow> {
    let limit = pick_f64(
        value,
        &[&format!("{prefix}_limit_usd"), &format!("group.{prefix}_limit_usd")],
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

fn usage_summary(stats: &SnapshotStats, usage: &[UsageRow]) -> UsageSummary {
    let average_duration_ms = if stats.average_duration_ms > 0.0 {
        stats.average_duration_ms
    } else if usage.is_empty() {
        0.0
    } else {
        usage
            .iter()
            .map(|item| item.duration_ms.unwrap_or_default() as f64)
            .sum::<f64>()
            / usage.len() as f64
    };

    let total_input_tokens = usage.iter().map(|item| item.input_tokens).sum::<i64>();
    let total_output_tokens = usage.iter().map(|item| item.output_tokens).sum::<i64>();

    UsageSummary {
        total_requests: stats.total_requests,
        total_tokens: stats.total_tokens,
        total_input_tokens,
        total_output_tokens,
        total_actual_cost: stats.total_actual_cost,
        total_cost: stats.total_cost,
        average_duration_ms,
    }
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
    path.split('.').try_fold(value, |current, segment| current.get(segment))
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
    use axum::{
        extract::Json,
        routing::{get, post},
        Router,
    };
    use serde_json::{json, Value};

    use super::Sub2ApiClient;
    use crate::contracts::{AccountRecord, SiteRecord};

    #[tokio::test]
    async fn supports_2fa_flow_and_build_snapshot() {
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
                    && body.get("code").and_then(Value::as_str) == Some("654321");
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
            .route("/api/v1/usage", get(|| async { Json(json!({ "items": [] })) }))
            .route("/api/v1/usage?page=1&page_size=20", get(|| async { Json(json!({ "items": [] })) }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let base_url = format!("http://{}", address);
        let mut client = Sub2ApiClient::new(&base_url, None).expect("create client");
        let login = client
            .login("demo@example.com", "secret")
            .await
            .expect("login challenge");
        assert!(login.requires2fa);
        client
            .complete_2fa("temp-123", "654321")
            .await
            .expect("complete 2fa");
        let snapshot = client
            .build_snapshot(
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
                },
            )
            .await
            .expect("build snapshot");
        assert_eq!(snapshot.balance, 3.2);
    }
}
