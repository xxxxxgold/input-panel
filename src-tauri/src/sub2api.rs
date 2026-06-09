use crate::models::{
    AccountRecord, AccountSnapshot, KeyRecord, LoginChallenge, PlatformPoint, SiteRecord,
    SnapshotAlert, SnapshotStats, StoredSession, SubscriptionQuotaWindow, SubscriptionRecord,
    TrendPoint, UsageHistoryRow, UsageRow, UsageSummary,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use reqwest::{Client, Method};
use serde_json::{json, Value};
use std::collections::HashMap;

fn is_balance_warning_disabled(value: f64) -> bool {
    value < 0.0
}

pub struct Sub2ApiClient {
    client: Client,
    base_url: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

impl Sub2ApiClient {
    pub fn new(base_url: &str, session: Option<StoredSession>) -> Result<Self> {
        Ok(Self {
            client: Client::builder().build()?,
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
        }
    }

    pub fn clear_tokens(&mut self) {
        self.access_token = None;
        self.refresh_token = None;
    }

    pub async fn login(&mut self, email: &str, password: &str) -> Result<LoginChallenge> {
        for path in ["/api/v1/auth/login", "/api/v1/auths/signin"] {
            let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
            let response = self
                .client
                .request(Method::POST, url)
                .json(&json!({ "email": email, "password": password }))
                .send()
                .await?;
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
            let challenge = LoginChallenge {
                requires2fa: payload.get("temp_token").and_then(Value::as_str).is_some(),
                temp_token: pick_string(&payload, &["temp_token"]),
                email_masked: pick_string(&payload, &["user_email_masked", "email_masked"]),
            };
            return Ok(challenge);
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

    pub async fn refresh_token_if_needed(&mut self) -> Result<()> {
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

    async fn dashboard_stats(&mut self) -> Result<SnapshotStats> {
        let raw = self
            .request_json(&["/api/v1/usage/dashboard/stats"])
            .await?;
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
                name: pick_string(&item, &["name", "key_name"]).unwrap_or_else(|| "Unnamed Key".into()),
                status: pick_string(&item, &["status"]).unwrap_or_else(|| "unknown".into()),
                platform: pick_string(&item, &["group.platform", "platform"]),
                group_name: pick_string(&item, &["group.name", "group_name"]),
                expires_at: pick_string(&item, &["expires_at"]),
                last_used_at: pick_string(&item, &["last_used_at"]),
                quota: Some(pick_f64(&item, &["quota"]).unwrap_or(0.0)),
                quota_used: Some(pick_f64(&item, &["quota_used"]).unwrap_or(0.0)),
                rate_limit5h: Some(pick_f64(&item, &["rate_limit_5h"]).unwrap_or(0.0)),
                rate_limit1d: Some(pick_f64(&item, &["rate_limit_1d"]).unwrap_or(0.0)),
                rate_limit7d: Some(pick_f64(&item, &["rate_limit_7d"]).unwrap_or(0.0)),
                usage5h: Some(pick_f64(&item, &["usage_5h"]).unwrap_or(0.0)),
                usage1d: Some(pick_f64(&item, &["usage_1d"]).unwrap_or(0.0)),
                usage7d: Some(pick_f64(&item, &["usage_7d"]).unwrap_or(0.0)),
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
                UsageRow {
                    id: pick_string(&item, &["id"]).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    api_key_id: pick_i64(&item, &["api_key_id"]),
                    created_at: pick_string(&item, &["created_at"]).unwrap_or_else(|| Utc::now().to_rfc3339()),
                    model: pick_string(&item, &["model"]).unwrap_or_else(|| "unknown".into()),
                    reasoning_effort: pick_string(&item, &["reasoning_effort"]),
                    endpoint: pick_string(&item, &["endpoint", "inbound_endpoint"]),
                    upstream_endpoint: pick_string(&item, &["upstream_endpoint"]),
                    actual_cost: pick_f64(&item, &["actual_cost", "total_actual_cost"]).unwrap_or(0.0),
                    total_cost: pick_f64(&item, &["total_cost"]).unwrap_or(0.0),
                    input_tokens,
                    output_tokens,
                    cache_creation_tokens: pick_i64(&item, &["cache_creation_tokens"]),
                    cache_read_tokens: pick_i64(&item, &["cache_read_tokens", "total_cache_tokens"]),
                    total_tokens: pick_i64(&item, &["total_tokens"]).unwrap_or(input_tokens + output_tokens),
                    first_token_ms: pick_i64(&item, &["first_token_ms"]),
                    duration_ms: pick_i64(&item, &["duration_ms"]),
                    billing_mode: pick_string(&item, &["billing_mode"]),
                    request_type: pick_string(&item, &["request_type"]),
                    stream: item.get("stream").and_then(Value::as_bool),
                    billing_type: pick_i64(&item, &["billing_type"]),
                    user_agent: pick_string(&item, &["user_agent"]),
                    api_key_name: pick_string(&item, &["api_key.name", "api_key_name"]),
                    platform: pick_string(&item, &["group.platform", "platform"]),
                    subscription_name: pick_string(
                        &item,
                        &["subscription.group.name", "subscription_name", "group.name"],
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
                        total_tokens: 0,
                    });
                    entry.actual_cost += pick_f64(&item, &["actual_cost", "total_actual_cost"]).unwrap_or(0.0);
                    entry.total_cost += pick_f64(&item, &["total_cost"]).unwrap_or(0.0);
                    entry.requests += pick_i64(&item, &["requests", "request_count"]).unwrap_or(0);
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
    for key in ["items", "data", "list"] {
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
    let limit = pick_f64(value, &[&format!("{prefix}_limit_usd"), &format!("group.{prefix}_limit_usd")])?;
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
    UsageSummary {
        total_requests: stats.total_requests,
        total_tokens: stats.total_tokens,
        total_input_tokens: stats.today_input_tokens,
        total_output_tokens: stats.today_output_tokens,
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
            total_tokens: 0,
        });
        entry.actual_cost += row.actual_cost;
        entry.total_cost += row.total_cost;
        entry.requests += 1;
        entry.total_tokens += row.total_tokens;
    }
    let mut trend: Vec<TrendPoint> = points.into_values().collect();
    trend.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    trend
}

fn build_alerts(
    account: &AccountRecord,
    site: &SiteRecord,
    balance: f64,
    keys: &[KeyRecord],
    fetched_at: &str,
) -> Vec<SnapshotAlert> {
    let mut alerts = Vec::new();
    if balance <= 0.0 {
        alerts.push(SnapshotAlert {
            id: format!("{}:balance-empty", account.id),
            severity: "critical".into(),
            title: format!("{} 余额已耗尽", account.label),
            detail: format!("{} 当前余额为 0，请尽快充值或检查套餐。", site.name),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    } else if !is_balance_warning_disabled(account.balance_warning) && balance <= account.balance_warning {
        alerts.push(SnapshotAlert {
            id: format!("{}:balance-low", account.id),
            severity: "high".into(),
            title: format!("{} 余额偏低", account.label),
            detail: format!(
                "{} 当前余额 {:.2}，低于预警阈值 {:.2}。",
                site.name, balance, account.balance_warning
            ),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    }
    let exhausted = keys
        .iter()
        .filter(|item| item.status == "quota_exhausted")
        .count();
    if exhausted > 0 {
        alerts.push(SnapshotAlert {
            id: format!("{}:keys-exhausted", account.id),
            severity: "medium".into(),
            title: format!("{} 存在额度耗尽的 Keys", account.label),
            detail: format!("共 {exhausted} 个 key 处于 quota_exhausted 状态。"),
            site_id: site.id.clone(),
            account_id: account.id.clone(),
            created_at: fetched_at.to_string(),
        });
    }
    alerts
}

pub fn merge_request_history(
    previous: &[UsageHistoryRow],
    latest: &[UsageRow],
    fetched_at: &str,
) -> Vec<UsageHistoryRow> {
    let latest_keys: std::collections::HashSet<String> =
        latest.iter().map(usage_identity).collect();
    let mut merged: HashMap<String, UsageHistoryRow> = HashMap::new();

    for row in previous {
        let identity = usage_identity(&row.row);
        merged.insert(
            identity.clone(),
            UsageHistoryRow {
                row: row.row.clone(),
                first_seen_at: row.first_seen_at.clone(),
                last_seen_at: if latest_keys.contains(&identity) {
                    fetched_at.to_string()
                } else {
                    row.last_seen_at.clone()
                },
                is_latest: latest_keys.contains(&identity),
            },
        );
    }

    for row in latest {
        let identity = usage_identity(row);
        if let Some(existing) = merged.get_mut(&identity) {
            existing.row = row.clone();
            existing.last_seen_at = fetched_at.to_string();
            existing.is_latest = true;
            continue;
        }
        merged.insert(
            identity,
            UsageHistoryRow {
                row: row.clone(),
                first_seen_at: fetched_at.to_string(),
                last_seen_at: fetched_at.to_string(),
                is_latest: true,
            },
        );
    }

    let mut items: Vec<UsageHistoryRow> = merged.into_values().collect();
    items.sort_by(|left, right| {
        right
            .row
            .created_at
            .cmp(&left.row.created_at)
            .then_with(|| right.last_seen_at.cmp(&left.last_seen_at))
    });
    items
}

fn usage_identity(row: &UsageRow) -> String {
    if !row.id.trim().is_empty() {
        return format!("id:{}", row.id);
    }
    format!(
        "fallback:{}:{}:{}:{}",
        row.created_at, row.model, row.actual_cost, row.total_tokens
    )
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
        node.as_f64().or_else(|| node.as_str().and_then(|item| item.parse::<f64>().ok()))
    })
}

fn pick_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        let node = pick_value(value, key)?;
        node.as_i64().or_else(|| node.as_str().and_then(|item| item.parse::<i64>().ok()))
    })
}

fn extract_message(value: &Value, fallback: &str) -> String {
    pick_string(value, &["message", "error", "detail"]).unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::{build_alerts, merge_request_history, trend_from_usage, unwrap_envelope};
    use crate::models::{AccountRecord, KeyRecord, SiteRecord, UsageHistoryRow, UsageRow};
    use serde_json::json;

    #[test]
    fn unwrap_envelope_returns_inner_data() {
        let payload = unwrap_envelope(json!({
            "code": 0,
            "data": {
                "access_token": "token-1"
            }
        }))
        .expect("unwrap should succeed");

        assert_eq!(payload.get("access_token").and_then(|v| v.as_str()), Some("token-1"));
    }

    #[test]
    fn trend_from_usage_groups_by_day() {
        let trend = trend_from_usage(&[
            UsageRow {
                id: "1".into(),
                api_key_id: Some(3641),
                created_at: "2026-06-05T08:00:00+08:00".into(),
                model: "gpt-5.4".into(),
                reasoning_effort: Some("xhigh".into()),
                endpoint: Some("/responses".into()),
                upstream_endpoint: Some("/v1/responses".into()),
                actual_cost: 1.0,
                total_cost: 1.0,
                input_tokens: 100,
                output_tokens: 200,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                total_tokens: 300,
                first_token_ms: Some(1000),
                duration_ms: Some(2000),
                billing_mode: Some("token".into()),
                request_type: Some("stream".into()),
                stream: Some(true),
                billing_type: Some(1),
                user_agent: Some("Codex Desktop".into()),
                api_key_name: Some("codex".into()),
                platform: Some("openai".into()),
                subscription_name: Some("CodeX Plus".into()),
            },
            UsageRow {
                id: "2".into(),
                api_key_id: Some(3641),
                created_at: "2026-06-05T09:00:00+08:00".into(),
                model: "gpt-5.4".into(),
                reasoning_effort: Some("xhigh".into()),
                endpoint: Some("/responses".into()),
                upstream_endpoint: Some("/v1/responses".into()),
                actual_cost: 2.0,
                total_cost: 2.0,
                input_tokens: 50,
                output_tokens: 50,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                total_tokens: 100,
                first_token_ms: Some(1000),
                duration_ms: Some(2000),
                billing_mode: Some("token".into()),
                request_type: Some("stream".into()),
                stream: Some(true),
                billing_type: Some(1),
                user_agent: Some("Codex Desktop".into()),
                api_key_name: Some("codex".into()),
                platform: Some("openai".into()),
                subscription_name: Some("CodeX Plus".into()),
            },
        ]);

        assert_eq!(trend.len(), 1);
        assert_eq!(trend[0].bucket, "2026-06-05");
        assert_eq!(trend[0].requests, 2);
        assert_eq!(trend[0].total_tokens, 400);
    }

    #[test]
    fn build_alerts_emits_balance_warning() {
        let alerts = build_alerts(
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "demo@example.com".into(),
                balance_warning: 10.0,
                last_login_at: None,
                created_at: "2026-06-05T00:00:00Z".into(),
                updated_at: "2026-06-05T00:00:00Z".into(),
            },
            &SiteRecord {
                id: "site-1".into(),
                name: "AI INPUT".into(),
                base_url: "https://ai.input.im".into(),
                created_at: "2026-06-05T00:00:00Z".into(),
                updated_at: "2026-06-05T00:00:00Z".into(),
            },
            0.0,
            &[KeyRecord {
                id: "key-1".into(),
                name: "codex".into(),
                status: "active".into(),
                platform: Some("openai".into()),
                group_name: Some("CodeX Plus".into()),
                expires_at: None,
                last_used_at: None,
                quota: None,
                quota_used: None,
                rate_limit5h: None,
                rate_limit1d: None,
                rate_limit7d: None,
                usage5h: None,
                usage1d: None,
                usage7d: None,
            }],
            "2026-06-05T12:00:00Z",
        );

        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].severity, "critical");
    }

    #[test]
    fn build_alerts_skips_low_balance_when_warning_disabled() {
        let alerts = build_alerts(
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "主账号".into(),
                email: "demo@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-06-05T00:00:00Z".into(),
                updated_at: "2026-06-05T00:00:00Z".into(),
            },
            &SiteRecord {
                id: "site-1".into(),
                name: "AI INPUT".into(),
                base_url: "https://ai.input.im".into(),
                created_at: "2026-06-05T00:00:00Z".into(),
                updated_at: "2026-06-05T00:00:00Z".into(),
            },
            0.5,
            &[],
            "2026-06-05T12:00:00Z",
        );

        assert!(alerts.is_empty());
    }

    #[test]
    fn merge_request_history_marks_latest_rows_and_keeps_history() {
        let previous = vec![UsageHistoryRow {
            row: UsageRow {
                id: "usage-1".into(),
                api_key_id: Some(11),
                created_at: "2026-06-05T08:00:00Z".into(),
                model: "gpt-4.1".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                actual_cost: 0.1,
                total_cost: 0.1,
                input_tokens: 10,
                output_tokens: 20,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                total_tokens: 30,
                first_token_ms: Some(100),
                duration_ms: Some(400),
                billing_mode: Some("token".into()),
                request_type: Some("stream".into()),
                stream: Some(true),
                billing_type: Some(1),
                user_agent: Some("Codex Desktop".into()),
                api_key_name: Some("Main".into()),
                platform: Some("openai".into()),
                subscription_name: Some("Pro".into()),
            },
            first_seen_at: "2026-06-05T09:00:00Z".into(),
            last_seen_at: "2026-06-05T09:00:00Z".into(),
            is_latest: true,
        }];

        let latest = vec![UsageRow {
            id: "usage-2".into(),
            api_key_id: Some(11),
            created_at: "2026-06-05T10:00:00Z".into(),
            model: "gpt-4.1-mini".into(),
            reasoning_effort: None,
            endpoint: Some("/chat/completions".into()),
            upstream_endpoint: None,
            actual_cost: 0.2,
            total_cost: 0.2,
            input_tokens: 50,
            output_tokens: 40,
            cache_creation_tokens: Some(0),
            cache_read_tokens: Some(0),
            total_tokens: 90,
            first_token_ms: Some(90),
            duration_ms: Some(300),
            billing_mode: Some("token".into()),
            request_type: Some("stream".into()),
            stream: Some(true),
            billing_type: Some(1),
            user_agent: Some("Codex Desktop".into()),
            api_key_name: Some("Main".into()),
            platform: Some("openai".into()),
            subscription_name: Some("Pro".into()),
        }];

        let merged = merge_request_history(&previous, &latest, "2026-06-05T11:00:00Z");
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].row.id, "usage-2");
        assert!(merged[0].is_latest);
        assert_eq!(merged[1].row.id, "usage-1");
        assert!(!merged[1].is_latest);
    }
}
