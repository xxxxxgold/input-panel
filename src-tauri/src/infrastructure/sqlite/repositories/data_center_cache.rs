use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use chrono::{Days, NaiveDate};
use rusqlite::{named_params, params, params_from_iter, types::Value, OptionalExtension};

use crate::contracts::{
    AccountCacheStats, AccountUsageRowCacheRecord, ApiKeyUsageStatsRecord, DailyUsagePoint,
    ModelUsagePoint, OverviewModelPoint, PlatformPoint, TrendPoint, UsageAnalyticsAggregatePoint,
    UsageAnalyticsCostPoint, UsageAnalyticsFlowPoint, UsageAnalyticsHeatmapPoint,
    UsageAnalyticsLatencyPercentiles, UsageAnalyticsPayload, UsageAnalyticsPercentilePoint,
    UsageExtremesPayload, UsageF64Range, UsageFacetField, UsageFacetItem, UsageFacetPage,
    UsageFilter, UsageI64Range, UsageInsightPoint, UsageInsightsPayload, UsageRow,
    UsageStatsRecord, UsageTextFilter, UsageTextMatchMode,
};
use crate::infrastructure::datetime::{
    normalize_storage_timestamp, now_storage_timestamp, shanghai_today,
};
use crate::infrastructure::sqlite::Database;

const USAGE_ROW_SELECT_COLUMNS: &str = concat!(
    "usage_id, api_key_id, upstream_user_id, upstream_account_id, request_id, occurred_at, ",
    "model, reasoning_effort, endpoint, upstream_endpoint, group_id, subscription_id, ",
    "input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, ",
    "cache_creation_5m_tokens, cache_creation_1h_tokens, input_cost, output_cost, ",
    "cache_creation_cost, cache_read_cost, total_cost, actual_cost, rate_multiplier, ",
    "billing_type, service_tier, long_context_billing_applied, request_type, stream, openai_ws_mode, ",
    "duration_ms, first_token_ms, image_count, image_input_tokens, image_size, image_input_size, ",
    "image_output_size, image_output_tokens, image_input_cost, image_output_cost, ",
    "image_size_source, image_size_breakdown, media_type, user_agent, ip_address, ",
    "cache_ttl_overridden, billing_mode, platform, api_key_name, group_name, ",
    "subscription_name, subscription_type"
);
const MAX_USAGE_PAGE_SIZE: i64 = 100;
const USAGE_ANALYTICS_TOP_N: i64 = 12;
const USAGE_ANALYTICS_SAMPLE_SIZE: i64 = 20;
const USAGE_ANALYTICS_EXTREME_SIZE: i64 = 12;

#[derive(Debug, Clone)]
pub struct OverviewUsageCacheSummary {
    pub stats: AccountCacheStats,
    pub trend: Vec<TrendPoint>,
}

/// 兼容已有聚合仓储调用的类型别名；Usage 的筛选真相源位于 contracts::UsageFilter。
pub type UsageQueryFilter = UsageFilter;

/// 明细 keyset 查询方向。游标 codec 位于 application 层，repository 只执行锚点谓词。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsagePageDirection {
    Next,
    Previous,
}

/// 数据库中的稳定分页锚点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsagePageAnchor {
    pub occurred_at: String,
    pub usage_id: String,
}

/// repository 返回的有界明细页；`has_more` 由额外读取的一行决定。
#[derive(Debug, Clone)]
pub struct UsageRowsPage {
    pub items: Vec<UsageRow>,
    pub has_more: bool,
}

/// 分析聚合允许使用的固定维度，所有 SQL 片段均来自内部白名单。
#[derive(Debug, Clone, Copy)]
enum UsageAnalyticsDimension {
    Model,
    Platform,
    Endpoint,
    ApiKey,
    Group,
    Subscription,
    ReasoningEffort,
    RequestType,
    ReasoningRequestCombination,
    UserAgent,
}

impl UsageAnalyticsDimension {
    fn key_sql(self) -> &'static str {
        match self {
            Self::Model => "LOWER(COALESCE(NULLIF(TRIM(model), ''), 'unknown'))",
            Self::Platform => "LOWER(COALESCE(NULLIF(TRIM(platform), ''), 'unknown'))",
            Self::Endpoint => "LOWER(COALESCE(NULLIF(TRIM(endpoint), ''), 'unknown'))",
            Self::ApiKey => "CASE WHEN api_key_id IS NOT NULL THEN CAST(api_key_id AS TEXT) WHEN NULLIF(TRIM(api_key_name), '') IS NOT NULL THEN 'name:' || LOWER(TRIM(api_key_name)) ELSE 'unknown' END",
            Self::Group => "CASE WHEN group_id IS NOT NULL THEN CAST(group_id AS TEXT) ELSE 'name:' || LOWER(COALESCE(NULLIF(TRIM(group_name), ''), '未分组')) END",
            Self::Subscription => "CASE WHEN subscription_id IS NOT NULL THEN CAST(subscription_id AS TEXT) ELSE 'name:' || LOWER(COALESCE(NULLIF(TRIM(subscription_name), ''), '未归属订阅')) END",
            Self::ReasoningEffort => "LOWER(COALESCE(NULLIF(TRIM(reasoning_effort), ''), 'unknown'))",
            Self::RequestType => request_type_bucket_sql(),
            Self::ReasoningRequestCombination => "LOWER((CASE WHEN stream = 1 OR LOWER(TRIM(COALESCE(request_type, ''))) = 'stream' THEN 'stream' WHEN LOWER(TRIM(COALESCE(request_type, ''))) IN ('sync', 'batch') THEN LOWER(TRIM(request_type)) ELSE 'standard' END) || ' x ' || COALESCE(NULLIF(TRIM(reasoning_effort), ''), 'unknown'))",
            Self::UserAgent => "LOWER(CASE WHEN INSTR(COALESCE(user_agent, ''), 'Codex Desktop') > 0 THEN 'Codex Desktop' WHEN INSTR(COALESCE(user_agent, ''), 'Mozilla') > 0 THEN 'Browser' WHEN NULLIF(TRIM(user_agent), '') IS NULL THEN 'unknown' ELSE SUBSTR(TRIM(user_agent), 1, 48) END)",
        }
    }

    fn label_sql(self) -> &'static str {
        match self {
            Self::Model => "COALESCE(NULLIF(TRIM(model), ''), 'unknown')",
            Self::Platform => "COALESCE(NULLIF(TRIM(platform), ''), 'unknown')",
            Self::Endpoint => "COALESCE(NULLIF(TRIM(endpoint), ''), 'unknown')",
            Self::ApiKey => "COALESCE(NULLIF(TRIM(api_key_name), ''), CASE WHEN api_key_id IS NOT NULL THEN '#' || CAST(api_key_id AS TEXT) ELSE '未知 Key' END)",
            Self::Group => "COALESCE(NULLIF(TRIM(group_name), ''), '未分组')",
            Self::Subscription => "COALESCE(NULLIF(TRIM(subscription_name), ''), '未归属订阅')",
            Self::ReasoningEffort => "COALESCE(NULLIF(TRIM(reasoning_effort), ''), 'unknown')",
            Self::RequestType => request_type_bucket_sql(),
            Self::ReasoningRequestCombination => "(CASE WHEN stream = 1 OR LOWER(TRIM(COALESCE(request_type, ''))) = 'stream' THEN 'stream' WHEN LOWER(TRIM(COALESCE(request_type, ''))) IN ('sync', 'batch') THEN LOWER(TRIM(request_type)) ELSE 'standard' END) || ' × ' || COALESCE(NULLIF(TRIM(reasoning_effort), ''), 'unknown')",
            Self::UserAgent => "CASE WHEN INSTR(COALESCE(user_agent, ''), 'Codex Desktop') > 0 THEN 'Codex Desktop' WHEN INSTR(COALESCE(user_agent, ''), 'Mozilla') > 0 THEN 'Browser' WHEN NULLIF(TRIM(user_agent), '') IS NULL THEN 'unknown' ELSE SUBSTR(TRIM(user_agent), 1, 48) END",
        }
    }
}

fn request_type_bucket_sql() -> &'static str {
    "CASE WHEN stream = 1 OR LOWER(TRIM(COALESCE(request_type, ''))) = 'stream' THEN 'stream' WHEN LOWER(TRIM(COALESCE(request_type, ''))) IN ('sync', 'batch') THEN LOWER(TRIM(request_type)) ELSE 'standard' END"
}

pub fn merge_usage_row_cache(
    db: &Database,
    account_id: &str,
    rows: &[UsageRow],
    updated_at: &str,
) -> Result<i64> {
    let updated_at =
        normalize_storage_timestamp(updated_at).context("规范化 usage 缓存更新时间失败")?;
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let mut count = 0_i64;
    let mut stmt = tx.prepare(
            "INSERT INTO account_usage_row_cache (
                account_id, usage_id, api_key_id, upstream_user_id, upstream_account_id, request_id,
                model, reasoning_effort, endpoint, upstream_endpoint, group_id, subscription_id,
                input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                cache_creation_5m_tokens, cache_creation_1h_tokens, input_cost, output_cost,
                cache_creation_cost, cache_read_cost, total_cost, actual_cost, rate_multiplier,
                billing_type, service_tier, long_context_billing_applied, request_type, stream,
                openai_ws_mode, duration_ms, first_token_ms, image_count, image_input_tokens,
                image_size, image_input_size, image_output_size, image_output_tokens,
                image_input_cost, image_output_cost, image_size_source, image_size_breakdown,
                media_type, user_agent, ip_address,
                cache_ttl_overridden, billing_mode, platform, api_key_name, group_name,
                subscription_name, subscription_type, occurred_at, updated_at,
                first_seen_at, last_seen_at
             ) VALUES (
                :account_id, :usage_id, :api_key_id, :upstream_user_id, :upstream_account_id, :request_id,
                :model, :reasoning_effort, :endpoint, :upstream_endpoint, :group_id, :subscription_id,
                :input_tokens, :output_tokens, :cache_creation_tokens, :cache_read_tokens,
                :cache_creation_5m_tokens, :cache_creation_1h_tokens, :input_cost, :output_cost,
                :cache_creation_cost, :cache_read_cost, :total_cost, :actual_cost, :rate_multiplier,
                :billing_type, :service_tier, :long_context_billing_applied, :request_type, :stream,
                :openai_ws_mode, :duration_ms, :first_token_ms, :image_count, :image_input_tokens,
                :image_size, :image_input_size, :image_output_size, :image_output_tokens,
                :image_input_cost, :image_output_cost, :image_size_source, :image_size_breakdown,
                :media_type, :user_agent, :ip_address,
                :cache_ttl_overridden, :billing_mode, :platform, :api_key_name, :group_name,
                :subscription_name, :subscription_type, :occurred_at, :updated_at,
                :first_seen_at, :last_seen_at
             )
             ON CONFLICT(account_id, usage_id, occurred_at) DO UPDATE SET
                api_key_id = excluded.api_key_id,
                upstream_user_id = excluded.upstream_user_id,
                upstream_account_id = excluded.upstream_account_id,
                request_id = excluded.request_id,
                model = excluded.model,
                reasoning_effort = excluded.reasoning_effort,
                endpoint = excluded.endpoint,
                upstream_endpoint = excluded.upstream_endpoint,
                group_id = excluded.group_id,
                subscription_id = excluded.subscription_id,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
                cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
                input_cost = excluded.input_cost,
                output_cost = excluded.output_cost,
                cache_creation_cost = excluded.cache_creation_cost,
                cache_read_cost = excluded.cache_read_cost,
                total_cost = excluded.total_cost,
                actual_cost = excluded.actual_cost,
                rate_multiplier = excluded.rate_multiplier,
                billing_type = excluded.billing_type,
                service_tier = excluded.service_tier,
                long_context_billing_applied = excluded.long_context_billing_applied,
                request_type = excluded.request_type,
                stream = excluded.stream,
                openai_ws_mode = excluded.openai_ws_mode,
                duration_ms = excluded.duration_ms,
                first_token_ms = excluded.first_token_ms,
                image_count = excluded.image_count,
                image_input_tokens = excluded.image_input_tokens,
                image_size = excluded.image_size,
                image_input_size = excluded.image_input_size,
                image_output_size = excluded.image_output_size,
                image_output_tokens = excluded.image_output_tokens,
                image_input_cost = excluded.image_input_cost,
                image_output_cost = excluded.image_output_cost,
                image_size_source = excluded.image_size_source,
                image_size_breakdown = excluded.image_size_breakdown,
                media_type = excluded.media_type,
                user_agent = excluded.user_agent,
                ip_address = excluded.ip_address,
                cache_ttl_overridden = excluded.cache_ttl_overridden,
                billing_mode = excluded.billing_mode,
                platform = excluded.platform,
                api_key_name = excluded.api_key_name,
                group_name = excluded.group_name,
                subscription_name = excluded.subscription_name,
                subscription_type = excluded.subscription_type,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at
             WHERE (
                account_usage_row_cache.api_key_id,
                account_usage_row_cache.upstream_user_id,
                account_usage_row_cache.upstream_account_id,
                account_usage_row_cache.request_id,
                account_usage_row_cache.model,
                account_usage_row_cache.reasoning_effort,
                account_usage_row_cache.endpoint,
                account_usage_row_cache.upstream_endpoint,
                account_usage_row_cache.group_id,
                account_usage_row_cache.subscription_id,
                account_usage_row_cache.input_tokens,
                account_usage_row_cache.output_tokens,
                account_usage_row_cache.cache_creation_tokens,
                account_usage_row_cache.cache_read_tokens,
                account_usage_row_cache.cache_creation_5m_tokens,
                account_usage_row_cache.cache_creation_1h_tokens,
                account_usage_row_cache.input_cost,
                account_usage_row_cache.output_cost,
                account_usage_row_cache.cache_creation_cost,
                account_usage_row_cache.cache_read_cost,
                account_usage_row_cache.total_cost,
                account_usage_row_cache.actual_cost,
                account_usage_row_cache.rate_multiplier,
                account_usage_row_cache.billing_type,
                account_usage_row_cache.service_tier,
                account_usage_row_cache.long_context_billing_applied,
                account_usage_row_cache.request_type,
                account_usage_row_cache.stream,
                account_usage_row_cache.openai_ws_mode,
                account_usage_row_cache.duration_ms,
                account_usage_row_cache.first_token_ms,
                account_usage_row_cache.image_count,
                account_usage_row_cache.image_input_tokens,
                account_usage_row_cache.image_size,
                account_usage_row_cache.image_input_size,
                account_usage_row_cache.image_output_size,
                account_usage_row_cache.image_output_tokens,
                account_usage_row_cache.image_input_cost,
                account_usage_row_cache.image_output_cost,
                account_usage_row_cache.image_size_source,
                account_usage_row_cache.image_size_breakdown,
                account_usage_row_cache.media_type,
                account_usage_row_cache.user_agent,
                account_usage_row_cache.ip_address,
                account_usage_row_cache.cache_ttl_overridden,
                account_usage_row_cache.billing_mode,
                account_usage_row_cache.platform,
                account_usage_row_cache.api_key_name,
                account_usage_row_cache.group_name,
                account_usage_row_cache.subscription_name,
                account_usage_row_cache.subscription_type
             ) IS NOT (
                excluded.api_key_id,
                excluded.upstream_user_id,
                excluded.upstream_account_id,
                excluded.request_id,
                excluded.model,
                excluded.reasoning_effort,
                excluded.endpoint,
                excluded.upstream_endpoint,
                excluded.group_id,
                excluded.subscription_id,
                excluded.input_tokens,
                excluded.output_tokens,
                excluded.cache_creation_tokens,
                excluded.cache_read_tokens,
                excluded.cache_creation_5m_tokens,
                excluded.cache_creation_1h_tokens,
                excluded.input_cost,
                excluded.output_cost,
                excluded.cache_creation_cost,
                excluded.cache_read_cost,
                excluded.total_cost,
                excluded.actual_cost,
                excluded.rate_multiplier,
                excluded.billing_type,
                excluded.service_tier,
                excluded.long_context_billing_applied,
                excluded.request_type,
                excluded.stream,
                excluded.openai_ws_mode,
                excluded.duration_ms,
                excluded.first_token_ms,
                excluded.image_count,
                excluded.image_input_tokens,
                excluded.image_size,
                excluded.image_input_size,
                excluded.image_output_size,
                excluded.image_output_tokens,
                excluded.image_input_cost,
                excluded.image_output_cost,
                excluded.image_size_source,
                excluded.image_size_breakdown,
                excluded.media_type,
                excluded.user_agent,
                excluded.ip_address,
                excluded.cache_ttl_overridden,
                excluded.billing_mode,
                excluded.platform,
                excluded.api_key_name,
                excluded.group_name,
                excluded.subscription_name,
                excluded.subscription_type
             )",
    )?;
    for row in rows {
        let occurred_at =
            normalize_storage_timestamp(&row.created_at).context("规范化 usage 发生时间失败")?;
        count += stmt.execute(named_params! {
            ":account_id": account_id,
            ":usage_id": row.id.as_str(),
            ":api_key_id": row.api_key_id,
            ":upstream_user_id": row.upstream_user_id,
            ":upstream_account_id": row.upstream_account_id,
            ":request_id": row.request_id.as_deref(),
            ":model": row.model.as_str(),
            ":reasoning_effort": row.reasoning_effort.as_deref(),
            ":endpoint": row.endpoint.as_deref(),
            ":upstream_endpoint": row.upstream_endpoint.as_deref(),
            ":group_id": row.group_id,
            ":subscription_id": row.subscription_id,
            ":input_tokens": row.input_tokens,
            ":output_tokens": row.output_tokens,
            ":cache_creation_tokens": row.cache_creation_tokens,
            ":cache_read_tokens": row.cache_read_tokens,
            ":cache_creation_5m_tokens": row.cache_creation_5m_tokens,
            ":cache_creation_1h_tokens": row.cache_creation_1h_tokens,
            ":input_cost": row.input_cost,
            ":output_cost": row.output_cost,
            ":cache_creation_cost": row.cache_creation_cost,
            ":cache_read_cost": row.cache_read_cost,
            ":total_cost": row.total_cost,
            ":actual_cost": row.actual_cost,
            ":rate_multiplier": row.rate_multiplier,
            ":billing_type": row.billing_type,
            ":service_tier": row.service_tier.as_deref(),
            ":long_context_billing_applied": row.long_context_billing_applied,
            ":request_type": row.request_type.as_deref(),
            ":stream": row.stream,
            ":openai_ws_mode": row.openai_ws_mode,
            ":duration_ms": row.duration_ms,
            ":first_token_ms": row.first_token_ms,
            ":image_count": row.image_count,
            ":image_input_tokens": row.image_input_tokens,
            ":image_size": row.image_size.as_deref(),
            ":image_input_size": row.image_input_size.as_deref(),
            ":image_output_size": row.image_output_size.as_deref(),
            ":image_output_tokens": row.image_output_tokens,
            ":image_input_cost": row.image_input_cost,
            ":image_output_cost": row.image_output_cost,
            ":image_size_source": row.image_size_source.as_deref(),
            ":image_size_breakdown": row.image_size_breakdown.as_deref(),
            ":media_type": row.media_type.as_deref(),
            ":user_agent": row.user_agent.as_deref(),
            ":ip_address": row.ip_address.as_deref(),
            ":cache_ttl_overridden": row.cache_ttl_overridden,
            ":billing_mode": row.billing_mode.as_deref(),
            ":platform": row.platform.as_deref(),
            ":api_key_name": row.api_key_name.as_deref(),
            ":group_name": row.group_name.as_deref(),
            ":subscription_name": row.subscription_name.as_deref(),
            ":subscription_type": row.subscription_type.as_deref(),
            ":occurred_at": occurred_at.as_str(),
            ":updated_at": updated_at.as_str(),
            ":first_seen_at": updated_at.as_str(),
            ":last_seen_at": updated_at.as_str(),
        })? as i64;
    }
    drop(stmt);
    tx.commit()?;
    Ok(count)
}

/// Returns cache presence aligned with `rows` using one bounded lookup.
pub fn usage_row_cache_presence(
    db: &Database,
    account_id: &str,
    rows: &[UsageRow],
) -> Result<Vec<bool>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let identities = rows
        .iter()
        .map(|row| {
            Ok((
                row.id.clone(),
                normalize_storage_timestamp(&row.created_at)
                    .context("规范化 usage 缓存身份时间失败")?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;

    let placeholders = std::iter::repeat("(?, ?)")
        .take(identities.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "WITH requested(usage_id, occurred_at) AS (VALUES {placeholders})
         SELECT cache.usage_id, cache.occurred_at
         FROM account_usage_row_cache AS cache
         INNER JOIN requested
           ON requested.usage_id = cache.usage_id
          AND requested.occurred_at = cache.occurred_at
         WHERE cache.account_id = ?"
    );
    let mut values = Vec::with_capacity(identities.len() * 2 + 1);
    for (usage_id, occurred_at) in &identities {
        values.push(Value::Text(usage_id.clone()));
        values.push(Value::Text(occurred_at.clone()));
    }
    values.push(Value::Text(account_id.to_string()));

    let conn = db.connect()?;
    let mut stmt = conn.prepare(&sql)?;
    let existing = stmt
        .query_map(params_from_iter(values.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<HashSet<_>>>()?;

    Ok(identities
        .iter()
        .map(|identity| existing.contains(identity))
        .collect())
}

pub fn prune_usage_row_cache_before(
    db: &Database,
    account_id: &str,
    min_occurred_at: &str,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM account_usage_row_cache WHERE account_id = ?1 AND occurred_at < ?2",
        params![account_id, min_occurred_at],
    )?;
    Ok(())
}

pub fn list_usage_rows_updated_at(
    db: &Database,
    account_id: &str,
    updated_at: &str,
) -> Result<Vec<UsageRow>> {
    let updated_at =
        normalize_storage_timestamp(updated_at).context("规范化 usage 查询更新时间失败")?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {USAGE_ROW_SELECT_COLUMNS}
         FROM account_usage_row_cache
         WHERE account_id = ?1 AND updated_at = ?2
         ORDER BY occurred_at DESC, usage_id DESC"
    ))?;
    let rows = stmt.query_map(params![account_id, updated_at], map_usage_row)?;
    collect_rows(rows)
}

pub fn list_usage_row_cache(
    db: &Database,
    account_id: &str,
    api_key_id: Option<i64>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<Vec<AccountUsageRowCacheRecord>> {
    let conn = db.connect()?;
    let (start_bound, end_exclusive) = usage_range_query_bounds(start_date, end_date);
    let from_clause = if api_key_id.is_some() {
        "account_usage_row_cache INDEXED BY idx_account_usage_row_cache_account_key_occurred_usage"
    } else {
        "account_usage_row_cache INDEXED BY idx_account_usage_row_cache_account_occurred_usage"
    };
    match (api_key_id, start_bound.as_ref(), end_exclusive.as_ref()) {
        (Some(key_id), Some(start), Some(end)) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at >= ?3
                   AND occurred_at < ?4
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(
                params![account_id, key_id, start, end],
                map_usage_row_cache_record,
            )?;
            collect_rows(rows)
        }
        (Some(key_id), Some(start), None) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at >= ?3
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(
                params![account_id, key_id, start],
                map_usage_row_cache_record,
            )?;
            collect_rows(rows)
        }
        (Some(key_id), None, Some(end)) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at < ?3
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows =
                stmt.query_map(params![account_id, key_id, end], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
        (Some(key_id), None, None) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(params![account_id, key_id], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
        (None, Some(start), Some(end)) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at >= ?2
                   AND occurred_at < ?3
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows =
                stmt.query_map(params![account_id, start, end], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
        (None, Some(start), None) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at >= ?2
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(params![account_id, start], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
        (None, None, Some(end)) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at < ?2
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(params![account_id, end], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
        (None, None, None) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT account_id, {USAGE_ROW_SELECT_COLUMNS}, updated_at, first_seen_at, last_seen_at
                 FROM {from_clause}
                 WHERE account_id = ?1
                 ORDER BY occurred_at DESC, usage_id DESC"
            ))?;
            let rows = stmt.query_map(params![account_id], map_usage_row_cache_record)?;
            collect_rows(rows)
        }
    }
}

pub fn summarize_usage_rows_by_key(
    db: &Database,
    account_id: &str,
    start_date: &str,
    end_date: &str,
) -> Result<HashMap<i64, ApiKeyUsageStatsRecord>> {
    let (Some(start_bound), Some(end_exclusive)) =
        usage_range_query_bounds(Some(start_date), Some(end_date))
    else {
        return Ok(HashMap::new());
    };
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT
            api_key_id,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM account_usage_row_cache INDEXED BY idx_account_usage_row_cache_account_key_occurred_usage
         WHERE account_id = ?1
           AND api_key_id IS NOT NULL
           AND occurred_at >= ?2
           AND occurred_at < ?3
         GROUP BY api_key_id",
    )?;
    let rows = stmt.query_map(params![account_id, start_bound, end_exclusive], |row| {
        Ok((
            row.get::<_, i64>("api_key_id")?,
            ApiKeyUsageStatsRecord {
                requests: row.get("requests")?,
                input_tokens: row.get("input_tokens")?,
                output_tokens: row.get("output_tokens")?,
                total_tokens: row.get("total_tokens")?,
                actual_cost: row.get("actual_cost")?,
            },
        ))
    })?;
    let mut stats = HashMap::new();
    for row in rows {
        let (api_key_id, value) = row?;
        stats.insert(api_key_id, value);
    }
    Ok(stats)
}

pub fn list_key_daily_usage_points(
    db: &Database,
    account_id: &str,
    api_key_id: i64,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<DailyUsagePoint>> {
    let conn = db.connect()?;
    let (Some(start_bound), Some(end_exclusive)) =
        usage_range_query_bounds(Some(start_date), Some(end_date))
    else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT
            substr(occurred_at, 1, 10) AS date,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_write_tokens,
            COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_row_cache INDEXED BY idx_account_usage_row_cache_account_key_occurred_usage
         WHERE account_id = ?1
           AND api_key_id = ?2
           AND occurred_at >= ?3
           AND occurred_at < ?4
         GROUP BY substr(occurred_at, 1, 10)
         ORDER BY date ASC",
    )?;
    let rows = stmt.query_map(
        params![account_id, api_key_id, start_bound, end_exclusive],
        |row| {
            Ok(DailyUsagePoint {
                date: row.get("date")?,
                requests: row.get("requests")?,
                input_tokens: row.get("input_tokens")?,
                output_tokens: row.get("output_tokens")?,
                cache_read_tokens: Some(row.get("cache_read_tokens")?),
                cache_write_tokens: Some(row.get("cache_write_tokens")?),
                total_tokens: Some(row.get("total_tokens")?),
                actual_cost: Some(row.get("actual_cost")?),
                total_cost: Some(row.get("total_cost")?),
            })
        },
    )?;
    collect_rows(rows)
}

pub fn load_usage_cache_last_updated_at(db: &Database, account_id: &str) -> Result<Option<String>> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT MAX(updated_at) FROM account_usage_row_cache WHERE account_id = ?1",
        params![account_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(Into::into)
}

pub fn load_usage_high_watermark(
    db: &Database,
    account_id: &str,
) -> Result<Option<(String, String)>> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT occurred_at, usage_id
         FROM account_usage_row_cache INDEXED BY idx_account_usage_row_cache_account_occurred_usage
         WHERE account_id = ?1
         ORDER BY occurred_at DESC, usage_id DESC
         LIMIT 1",
        params![account_id],
        |row| Ok((row.get("occurred_at")?, row.get("usage_id")?)),
    )
    .optional()
    .map_err(Into::into)
}

pub fn read_usage_cache_sync_snapshot(
    db: &Database,
    account_id: &str,
) -> Result<(i64, Option<String>)> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT COUNT(*) AS item_count, MAX(updated_at) AS last_success_at
         FROM account_usage_row_cache
         WHERE account_id = ?1",
        params![account_id],
        |row| Ok((row.get("item_count")?, row.get("last_success_at")?)),
    )
    .map_err(Into::into)
}

pub fn summarize_usage_row_cache(db: &Database, account_id: &str) -> Result<AccountCacheStats> {
    let conn = db.connect()?;
    let today = shanghai_today().to_string();

    conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN requests ELSE 0 END), 0) AS today_requests,
            COALESCE(SUM(requests), 0) AS total_requests,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN actual_cost ELSE 0 END), 0) AS today_actual_cost,
            COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN total_cost ELSE 0 END), 0) AS today_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens ELSE 0 END), 0) AS today_tokens,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN input_tokens ELSE 0 END), 0) AS today_input_tokens,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN output_tokens ELSE 0 END), 0) AS today_output_tokens,
            CASE WHEN COALESCE(SUM(duration_ms_count), 0) > 0
                 THEN CAST(SUM(duration_ms_sum) AS REAL) / SUM(duration_ms_count)
                 ELSE 0 END AS average_duration_ms
         FROM account_usage_daily_rollup
         WHERE account_id = ?1",
        params![account_id, today],
        |row| {
            Ok(AccountCacheStats {
                total_api_keys: 0,
                active_api_keys: 0,
                today_requests: row.get("today_requests")?,
                total_requests: row.get("total_requests")?,
                today_actual_cost: row.get("today_actual_cost")?,
                total_actual_cost: row.get("total_actual_cost")?,
                today_cost: row.get("today_cost")?,
                total_cost: row.get("total_cost")?,
                today_tokens: row.get("today_tokens")?,
                total_tokens: row.get("total_tokens")?,
                today_input_tokens: row.get("today_input_tokens")?,
                today_output_tokens: row.get("today_output_tokens")?,
                average_duration_ms: row.get("average_duration_ms")?,
                by_platform: Vec::new(),
                by_model: Vec::new(),
            })
        },
    )
    .map_err(Into::into)
}

pub fn summarize_overview_usage_cache(
    db: &Database,
    account_id: &str,
    trend_start_date: Option<&str>,
    trend_end_date: Option<&str>,
) -> Result<OverviewUsageCacheSummary> {
    let mut stats = summarize_usage_row_cache(db, account_id)?;
    stats.by_platform = list_usage_platform_points(db, account_id)?;
    stats.by_model = list_usage_model_points(db, account_id)?;
    let trend = list_usage_trend_points(db, account_id, trend_start_date, trend_end_date)?;

    Ok(OverviewUsageCacheSummary { stats, trend })
}

pub fn list_recent_usage_rows(
    db: &Database,
    account_id: &str,
    limit: i64,
) -> Result<Vec<UsageRow>> {
    if limit <= 0 {
        return Ok(Vec::new());
    }
    let conn = db.connect()?;
    let query = format!(
        "SELECT {USAGE_ROW_SELECT_COLUMNS}
         FROM account_usage_row_cache
         WHERE account_id = ?1
         ORDER BY occurred_at DESC, usage_id DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params![account_id, limit], map_usage_row)?;
    collect_rows(rows)
}

pub fn list_usage_platform_points(db: &Database, account_id: &str) -> Result<Vec<PlatformPoint>> {
    let conn = db.connect()?;
    let today = shanghai_today().to_string();
    let mut stmt = conn.prepare(
        "SELECT
            platform,
            COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
            COALESCE(SUM(CASE WHEN usage_date = ?2 THEN actual_cost ELSE 0 END), 0) AS today_actual_cost,
            COALESCE(SUM(requests), 0) AS total_requests,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens
         FROM account_usage_daily_rollup
         WHERE account_id = ?1
         GROUP BY platform
         ORDER BY total_actual_cost DESC, total_requests DESC, platform ASC"
    )?;
    let rows = stmt.query_map(params![account_id, today], |row| {
        Ok(PlatformPoint {
            platform: row.get("platform")?,
            total_actual_cost: row.get("total_actual_cost")?,
            today_actual_cost: row.get("today_actual_cost")?,
            total_requests: row.get("total_requests")?,
            total_tokens: row.get("total_tokens")?,
        })
    })?;
    collect_rows(rows)
}

pub fn list_usage_model_points(db: &Database, account_id: &str) -> Result<Vec<OverviewModelPoint>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT
            model,
            COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_daily_rollup
         WHERE account_id = ?1
         GROUP BY model
         ORDER BY actual_cost DESC, requests DESC, model ASC"
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        Ok(OverviewModelPoint {
            model: row.get("model")?,
            requests: row.get("requests")?,
            total_tokens: row.get("total_tokens")?,
            actual_cost: row.get("actual_cost")?,
            total_cost: row.get("total_cost")?,
        })
    })?;
    collect_rows(rows)
}

pub fn list_usage_trend_points(
    db: &Database,
    account_id: &str,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<Vec<TrendPoint>> {
    let conn = db.connect()?;
    let (start_bound, end_exclusive) = usage_range_query_bounds(start_date, end_date);
    let mut stmt = conn.prepare(
        "SELECT
            usage_date AS bucket,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost,
            COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens
         FROM account_usage_daily_rollup
         WHERE account_id = ?1
           AND (?2 IS NULL OR usage_date >= ?2)
           AND (?3 IS NULL OR usage_date < ?3)
         GROUP BY usage_date
         ORDER BY bucket ASC"
    )?;
    let rows = stmt.query_map(params![account_id, start_bound, end_exclusive], |row| {
        Ok(TrendPoint {
            bucket: row.get("bucket")?,
            actual_cost: row.get("actual_cost")?,
            total_cost: row.get("total_cost")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_creation_tokens: row.get("cache_creation_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            total_tokens: row.get("total_tokens")?,
        })
    })?;
    collect_rows(rows)
}

/// 按稳定时间/ID 锚点读取一页明细，不执行 COUNT 或 OFFSET。
pub fn list_usage_rows_filtered_page(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
    anchor: Option<&UsagePageAnchor>,
    direction: UsagePageDirection,
    page_size: i64,
) -> Result<UsageRowsPage> {
    let conn = db.connect()?;
    let safe_page_size = page_size.clamp(1, MAX_USAGE_PAGE_SIZE);
    let (base_where, mut values) = build_usage_filter_where(account_id, filter);
    let (anchor_sql, order_sql) = match (anchor, direction) {
        (None, UsagePageDirection::Next) => (None, "occurred_at DESC, usage_id DESC"),
        (Some(anchor), UsagePageDirection::Next) => {
            values.push(Value::Text(anchor.occurred_at.clone()));
            values.push(Value::Text(anchor.occurred_at.clone()));
            values.push(Value::Text(anchor.usage_id.clone()));
            (
                Some("(occurred_at < ? OR (occurred_at = ? AND usage_id < ?))".to_string()),
                "occurred_at DESC, usage_id DESC",
            )
        }
        (Some(anchor), UsagePageDirection::Previous) => {
            values.push(Value::Text(anchor.occurred_at.clone()));
            values.push(Value::Text(anchor.occurred_at.clone()));
            values.push(Value::Text(anchor.usage_id.clone()));
            (
                Some("(occurred_at > ? OR (occurred_at = ? AND usage_id > ?))".to_string()),
                "occurred_at ASC, usage_id ASC",
            )
        }
        (None, UsagePageDirection::Previous) => {
            return Err(anyhow::anyhow!(
                "USAGE_INVALID_CURSOR: previous direction requires a cursor"
            ));
        }
    };
    let where_sql = match anchor_sql {
        Some(anchor_sql) => format!("{base_where} AND {anchor_sql}"),
        None => base_where,
    };
    values.push(Value::Integer(safe_page_size.saturating_add(1)));
    let mut stmt = conn.prepare(&format!(
        "SELECT {USAGE_ROW_SELECT_COLUMNS}
         FROM account_usage_row_cache
         {where_sql}
         ORDER BY {order_sql}
         LIMIT ?"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), map_usage_row)?;
    let mut items = collect_rows(rows)?;
    let has_more = items.len() > safe_page_size as usize;
    if has_more {
        items.truncate(safe_page_size as usize);
    }
    if direction == UsagePageDirection::Previous {
        items.reverse();
    }
    Ok(UsageRowsPage { items, has_more })
}

/// 从完整筛选范围读取有界 facet，当前 facet 字段不会反向约束自身候选。
pub fn list_usage_facets(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
    field: UsageFacetField,
    search: Option<&str>,
    limit: i64,
) -> Result<UsageFacetPage> {
    let safe_limit = limit.clamp(1, MAX_USAGE_PAGE_SIZE);
    let mut facet_filter = filter.clone();
    clear_usage_facet_filter(&mut facet_filter, field);
    let (where_sql, mut values) = build_usage_filter_where(account_id, &facet_filter);
    let (value_sql, label_sql) = usage_facet_sql(field);
    let mut conditions = vec![format!("NULLIF(TRIM({value_sql}), '') IS NOT NULL")];
    if let Some(search) = normalize_usage_filter_value(search) {
        conditions.push(format!(
            "LOWER(TRIM(COALESCE({label_sql}, ''))) LIKE ? ESCAPE '\\'"
        ));
        values.push(Value::Text(format!("{}%", escape_like_prefix(&search))));
    }
    values.push(Value::Integer(safe_limit.saturating_add(1)));
    let conn = db.connect()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT CAST({value_sql} AS TEXT) AS facet_value,
                MAX(COALESCE(NULLIF(TRIM({label_sql}), ''), CAST({value_sql} AS TEXT))) AS facet_label,
                COUNT(*) AS facet_count
         FROM account_usage_row_cache
         {where_sql} AND {}
         GROUP BY {value_sql}
         ORDER BY facet_count DESC, facet_value ASC
         LIMIT ?",
        conditions.join(" AND ")
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(UsageFacetItem {
            value: row.get("facet_value")?,
            label: row.get("facet_label")?,
            count: row.get("facet_count")?,
        })
    })?;
    let mut items = collect_rows(rows)?;
    let has_more = items.len() > safe_limit as usize;
    if has_more {
        items.truncate(safe_limit as usize);
    }
    Ok(UsageFacetPage {
        field,
        items,
        has_more,
    })
}

/// 在 SQLite 内完成分析页所需的全部有界聚合。
pub fn get_usage_analytics_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<UsageAnalyticsPayload> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    let (totals, cost_breakdown) = query_usage_analytics_totals(&conn, &where_sql, &values)?;
    let matched_rows = totals.total_requests;

    Ok(UsageAnalyticsPayload {
        version: 1,
        start_date: filter.start_date.clone().unwrap_or_default(),
        end_date: filter.end_date.clone().unwrap_or_default(),
        generated_at: now_storage_timestamp(),
        matched_rows,
        top_n: USAGE_ANALYTICS_TOP_N,
        totals,
        trend: query_usage_analytics_trend(&conn, &where_sql, &values)?,
        models: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::Model,
        )?,
        platforms: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::Platform,
        )?,
        endpoints: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::Endpoint,
        )?,
        api_keys: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::ApiKey,
        )?,
        groups: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::Group,
        )?,
        subscriptions: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::Subscription,
        )?,
        reasoning_efforts: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::ReasoningEffort,
        )?,
        request_types: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::RequestType,
        )?,
        reasoning_request_combinations: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::ReasoningRequestCombination,
        )?,
        user_agents: query_usage_analytics_dimension(
            &conn,
            &where_sql,
            &values,
            UsageAnalyticsDimension::UserAgent,
        )?,
        hourly_heatmap: query_usage_analytics_heatmap(&conn, &where_sql, &values)?,
        endpoint_flows: query_usage_analytics_flows(&conn, &where_sql, &values)?,
        cost_breakdown,
        latency_percentiles: UsageAnalyticsLatencyPercentiles {
            first_token: query_usage_analytics_percentiles(
                &conn,
                &where_sql,
                &values,
                "first_token_ms",
            )?,
            duration: query_usage_analytics_percentiles(
                &conn,
                &where_sql,
                &values,
                "duration_ms",
            )?,
        },
        extremes: query_usage_analytics_rows(
            &conn,
            &where_sql,
            &values,
            "actual_cost DESC, (input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)) DESC, COALESCE(duration_ms, 0) DESC, occurred_at DESC, usage_id DESC",
            USAGE_ANALYTICS_EXTREME_SIZE,
        )?,
        sample_rows: query_usage_analytics_rows(
            &conn,
            &where_sql,
            &values,
            "occurred_at DESC, usage_id DESC",
            USAGE_ANALYTICS_SAMPLE_SIZE,
        )?,
    })
}

fn query_usage_analytics_totals(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
) -> Result<(UsageStatsRecord, Vec<UsageAnalyticsCostPoint>)> {
    let row = conn.query_row(
        &format!(
            "SELECT
                COUNT(*) AS total_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_cache_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS total_cache_creation_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS total_cache_read_tokens,
                COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
                COALESCE(AVG(CASE WHEN duration_ms > 0 THEN duration_ms END), 0) AS average_duration_ms,
                COALESCE(SUM(input_cost), 0) AS input_cost,
                COALESCE(SUM(output_cost), 0) AS output_cost,
                COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
                COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost
             FROM account_usage_row_cache
             {where_sql}"
        ),
        params_from_iter(values.iter()),
        |row| {
            Ok((
                UsageStatsRecord {
                    total_requests: row.get("total_requests")?,
                    total_input_tokens: row.get("total_input_tokens")?,
                    total_output_tokens: row.get("total_output_tokens")?,
                    total_cache_tokens: Some(row.get("total_cache_tokens")?),
                    total_cache_creation_tokens: Some(row.get("total_cache_creation_tokens")?),
                    total_cache_read_tokens: Some(row.get("total_cache_read_tokens")?),
                    total_tokens: row.get("total_tokens")?,
                    total_cost: row.get("total_cost")?,
                    total_actual_cost: row.get("total_actual_cost")?,
                    average_duration_ms: row.get("average_duration_ms")?,
                    rpm: None,
                    tpm: None,
                },
                [
                    ("input", "输入成本", row.get::<_, f64>("input_cost")?),
                    ("output", "输出成本", row.get::<_, f64>("output_cost")?),
                    (
                        "cache_creation",
                        "缓存写入成本",
                        row.get::<_, f64>("cache_creation_cost")?,
                    ),
                    (
                        "cache_read",
                        "缓存读取成本",
                        row.get::<_, f64>("cache_read_cost")?,
                    ),
                ]
                .into_iter()
                .filter(|(_, _, value)| *value > 0.0)
                .map(|(key, label, value)| UsageAnalyticsCostPoint {
                    key: key.to_string(),
                    label: label.to_string(),
                    value,
                })
                .collect(),
            ))
        },
    )?;
    Ok(row)
}

fn query_usage_analytics_trend(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
) -> Result<Vec<DailyUsagePoint>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT
            SUBSTR(occurred_at, 1, 10) AS date,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_write_tokens,
            COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_row_cache
         {where_sql}
         GROUP BY SUBSTR(occurred_at, 1, 10)
         ORDER BY date ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(DailyUsagePoint {
            date: row.get("date")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: Some(row.get("cache_read_tokens")?),
            cache_write_tokens: Some(row.get("cache_write_tokens")?),
            total_tokens: Some(row.get("total_tokens")?),
            actual_cost: Some(row.get("actual_cost")?),
            total_cost: Some(row.get("total_cost")?),
        })
    })?;
    collect_rows(rows)
}

fn query_usage_analytics_dimension(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
    dimension: UsageAnalyticsDimension,
) -> Result<Vec<UsageAnalyticsAggregatePoint>> {
    let key_sql = dimension.key_sql();
    let label_sql = dimension.label_sql();
    let mut query_values = values.to_vec();
    query_values.push(Value::Integer(USAGE_ANALYTICS_TOP_N));
    let mut stmt = conn.prepare(&format!(
        "WITH grouped AS (
            SELECT
                {key_sql} AS dimension_key,
                MAX({label_sql}) AS dimension_label,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_creation_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
                COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS actual_cost,
                COALESCE(SUM(CASE WHEN first_token_ms > 0 THEN first_token_ms ELSE 0 END), 0) AS first_token_sum,
                SUM(CASE WHEN first_token_ms > 0 THEN 1 ELSE 0 END) AS first_token_count,
                COALESCE(SUM(CASE WHEN duration_ms > 0 THEN duration_ms ELSE 0 END), 0) AS duration_sum,
                SUM(CASE WHEN duration_ms > 0 THEN 1 ELSE 0 END) AS duration_count,
                COALESCE(SUM(CASE WHEN rate_multiplier > 0 THEN rate_multiplier ELSE 0 END), 0) AS multiplier_sum,
                SUM(CASE WHEN rate_multiplier > 0 THEN 1 ELSE 0 END) AS multiplier_count
            FROM account_usage_row_cache
            {where_sql}
            GROUP BY {key_sql}
        ), ranked AS (
            SELECT grouped.*,
                   ROW_NUMBER() OVER (
                       ORDER BY actual_cost DESC, total_tokens DESC, requests DESC, dimension_key ASC
                   ) AS rank_no
            FROM grouped
        ), tagged AS (
            SELECT
                CASE WHEN rank_no <= ? THEN dimension_key ELSE '__other__' END AS bucket_key,
                CASE WHEN rank_no <= ? THEN dimension_label ELSE '其他' END AS bucket_label,
                CASE WHEN rank_no <= ? THEN rank_no ELSE ? + 1 END AS bucket_order,
                requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                total_tokens, total_cost, actual_cost, first_token_sum, first_token_count,
                duration_sum, duration_count, multiplier_sum, multiplier_count
            FROM ranked
        )
        SELECT
            bucket_key AS key,
            MAX(bucket_label) AS label,
            CASE WHEN bucket_key = '__other__' THEN 1 ELSE 0 END AS is_other,
            SUM(requests) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(total_cost) AS total_cost,
            SUM(actual_cost) AS actual_cost,
            COALESCE(1.0 * SUM(first_token_sum) / NULLIF(SUM(first_token_count), 0), 0) AS average_first_token_ms,
            COALESCE(1.0 * SUM(duration_sum) / NULLIF(SUM(duration_count), 0), 0) AS average_duration_ms,
            COALESCE(1.0 * SUM(multiplier_sum) / NULLIF(SUM(multiplier_count), 0), 0) AS average_rate_multiplier
        FROM tagged
        GROUP BY bucket_key
        ORDER BY MIN(bucket_order), bucket_key"
    ))?;

    // `top_n` 在 tagged CTE 中出现四次，按 SQL 占位顺序追加相同值。
    query_values.extend([
        Value::Integer(USAGE_ANALYTICS_TOP_N),
        Value::Integer(USAGE_ANALYTICS_TOP_N),
        Value::Integer(USAGE_ANALYTICS_TOP_N),
    ]);
    let rows = stmt.query_map(params_from_iter(query_values.iter()), |row| {
        Ok(UsageAnalyticsAggregatePoint {
            key: row.get("key")?,
            label: row.get("label")?,
            is_other: row.get::<_, i64>("is_other")? != 0,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_creation_tokens: row.get("cache_creation_tokens")?,
            cache_read_tokens: row.get("cache_read_tokens")?,
            total_tokens: row.get("total_tokens")?,
            total_cost: row.get("total_cost")?,
            actual_cost: row.get("actual_cost")?,
            average_first_token_ms: row.get("average_first_token_ms")?,
            average_duration_ms: row.get("average_duration_ms")?,
            average_rate_multiplier: row.get("average_rate_multiplier")?,
        })
    })?;
    collect_rows(rows)
}

fn query_usage_analytics_heatmap(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
) -> Result<Vec<UsageAnalyticsHeatmapPoint>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT
            (CAST(STRFTIME('%w', occurred_at) AS INTEGER) + 6) % 7 AS weekday,
            CAST(STRFTIME('%H', occurred_at) AS INTEGER) AS hour,
            COUNT(*) AS requests,
            COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM account_usage_row_cache
         {where_sql}
         GROUP BY weekday, hour
         ORDER BY weekday ASC, hour ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(UsageAnalyticsHeatmapPoint {
            weekday: row.get("weekday")?,
            hour: row.get("hour")?,
            requests: row.get("requests")?,
            actual_cost: row.get("actual_cost")?,
        })
    })?;
    collect_rows(rows)
}

fn query_usage_analytics_flows(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
) -> Result<Vec<UsageAnalyticsFlowPoint>> {
    let mut query_values = values.to_vec();
    query_values.extend([
        Value::Integer(USAGE_ANALYTICS_TOP_N),
        Value::Integer(USAGE_ANALYTICS_TOP_N),
        Value::Integer(USAGE_ANALYTICS_TOP_N),
        Value::Integer(USAGE_ANALYTICS_TOP_N),
    ]);
    let mut stmt = conn.prepare(&format!(
        "WITH normalized AS (
            SELECT
                LOWER(COALESCE(NULLIF(TRIM(endpoint), ''), 'unknown')) AS source_key,
                LOWER(COALESCE(NULLIF(TRIM(upstream_endpoint), ''), NULLIF(TRIM(model), ''), 'unknown')) AS target_key,
                COALESCE(NULLIF(TRIM(endpoint), ''), 'unknown') AS source_label,
                COALESCE(NULLIF(TRIM(upstream_endpoint), ''), NULLIF(TRIM(model), ''), 'unknown') AS target_label,
                actual_cost
            FROM account_usage_row_cache
            {where_sql}
        ), grouped AS (
            SELECT
                source_key || ' -> ' || target_key AS flow_key,
                MAX(source_label) AS source,
                MAX(target_label) AS target,
                COUNT(*) AS requests,
                COALESCE(SUM(actual_cost), 0) AS actual_cost
            FROM normalized
            GROUP BY source_key, target_key
        ), ranked AS (
            SELECT grouped.*,
                   ROW_NUMBER() OVER (
                       ORDER BY requests DESC, actual_cost DESC, source ASC, target ASC
                   ) AS rank_no
            FROM grouped
        ), tagged AS (
            SELECT
                CASE WHEN rank_no <= ? THEN flow_key ELSE '__other__' END AS bucket_key,
                CASE WHEN rank_no <= ? THEN source ELSE '其他' END AS bucket_source,
                CASE WHEN rank_no <= ? THEN target ELSE '其他' END AS bucket_target,
                CASE WHEN rank_no <= ? THEN rank_no ELSE ? + 1 END AS bucket_order,
                requests,
                actual_cost
            FROM ranked
        )
        SELECT
            bucket_key AS key,
            MAX(bucket_source || ' -> ' || bucket_target) AS label,
            CASE WHEN bucket_key = '__other__' THEN 1 ELSE 0 END AS is_other,
            MAX(bucket_source) AS source,
            MAX(bucket_target) AS target,
            SUM(requests) AS requests,
            SUM(actual_cost) AS actual_cost
        FROM tagged
        GROUP BY bucket_key
        ORDER BY MIN(bucket_order), bucket_key"
    ))?;
    query_values.push(Value::Integer(USAGE_ANALYTICS_TOP_N));
    let rows = stmt.query_map(params_from_iter(query_values.iter()), |row| {
        Ok(UsageAnalyticsFlowPoint {
            key: row.get("key")?,
            label: row.get("label")?,
            is_other: row.get::<_, i64>("is_other")? != 0,
            source: row.get("source")?,
            target: row.get("target")?,
            requests: row.get("requests")?,
            actual_cost: row.get("actual_cost")?,
        })
    })?;
    collect_rows(rows)
}

fn query_usage_analytics_percentiles(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
    metric_sql: &str,
) -> Result<Option<UsageAnalyticsPercentilePoint>> {
    if !matches!(metric_sql, "first_token_ms" | "duration_ms") {
        return Err(anyhow::anyhow!("不支持的分析延迟字段。"));
    }
    let result = conn.query_row(
        &format!(
            "WITH ordered AS (
                SELECT
                    CAST({metric_sql} AS REAL) AS value,
                    ROW_NUMBER() OVER (ORDER BY {metric_sql} ASC) AS row_no,
                    COUNT(*) OVER () AS total
                FROM account_usage_row_cache
                {where_sql} AND {metric_sql} > 0
            )
            SELECT
                MAX(CASE WHEN row_no = CAST(((total - 1) * 0.50) + 0.5 AS INTEGER) + 1 THEN value END) AS p50,
                MAX(CASE WHEN row_no = CAST(((total - 1) * 0.90) + 0.5 AS INTEGER) + 1 THEN value END) AS p90,
                MAX(CASE WHEN row_no = CAST(((total - 1) * 0.99) + 0.5 AS INTEGER) + 1 THEN value END) AS p99
            FROM ordered"
        ),
        params_from_iter(values.iter()),
        |row| {
            let p50 = row.get::<_, Option<f64>>("p50")?;
            let p90 = row.get::<_, Option<f64>>("p90")?;
            let p99 = row.get::<_, Option<f64>>("p99")?;
            Ok(match (p50, p90, p99) {
                (Some(p50), Some(p90), Some(p99)) => Some(UsageAnalyticsPercentilePoint {
                    p50,
                    p90,
                    p99,
                }),
                _ => None,
            })
        },
    )?;
    Ok(result)
}

fn query_usage_analytics_rows(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
    order_sql: &str,
    limit: i64,
) -> Result<Vec<UsageRow>> {
    let allowed_order = matches!(
        order_sql,
        "occurred_at DESC, usage_id DESC"
            | "actual_cost DESC, (input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)) DESC, COALESCE(duration_ms, 0) DESC, occurred_at DESC, usage_id DESC"
    );
    if !allowed_order {
        return Err(anyhow::anyhow!("不支持的分析明细排序。"));
    }
    let mut query_values = values.to_vec();
    query_values.push(Value::Integer(limit));
    let mut stmt = conn.prepare(&format!(
        "SELECT {USAGE_ROW_SELECT_COLUMNS}
         FROM account_usage_row_cache
         {where_sql}
         ORDER BY {order_sql}
         LIMIT ?"
    ))?;
    let rows = stmt.query_map(params_from_iter(query_values.iter()), map_usage_row)?;
    collect_rows(rows)
}

pub fn summarize_usage_insights_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<UsageInsightsPayload> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    let total_requests = conn.query_row(
        &format!("SELECT COUNT(*) FROM account_usage_row_cache {where_sql}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    let groups = list_usage_insight_points(
        &conn,
        &where_sql,
        &values,
        "COALESCE(NULLIF(TRIM(group_name), ''), '未分组')",
    )?;
    let endpoints = list_usage_insight_points(
        &conn,
        &where_sql,
        &values,
        "COALESCE(NULLIF(endpoint, ''), NULLIF(upstream_endpoint, ''), '未标记端点')",
    )?;

    Ok(UsageInsightsPayload {
        start_date: filter.start_date.clone().unwrap_or_default(),
        end_date: filter.end_date.clone().unwrap_or_default(),
        total_requests,
        groups,
        endpoints,
    })
}

fn list_usage_insight_points(
    conn: &rusqlite::Connection,
    where_sql: &str,
    values: &[Value],
    dimension_sql: &str,
) -> Result<Vec<UsageInsightPoint>> {
    let query = format!(
        "SELECT {dimension_sql} AS name,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
                COALESCE(SUM(actual_cost), 0) AS actual_cost,
                COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_row_cache
         {where_sql}
         GROUP BY {dimension_sql}
         ORDER BY actual_cost DESC, total_tokens DESC, requests DESC, name ASC"
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(UsageInsightPoint {
            name: row.get("name")?,
            requests: row.get("requests")?,
            total_tokens: row.get("total_tokens")?,
            actual_cost: row.get("actual_cost")?,
            total_cost: row.get("total_cost")?,
        })
    })?;
    collect_rows(rows)
}

fn build_usage_rollup_filter_where(
    account_id: &str,
    filter: &UsageQueryFilter,
) -> (String, Vec<Value>) {
    let mut clauses = vec!["account_id = ?".to_string()];
    let mut values = vec![Value::Text(account_id.to_string())];
    if let Some(start_date) = filter.start_date.as_ref() {
        clauses.push("usage_date >= ?".to_string());
        values.push(Value::Text(start_date.clone()));
    }
    if let Some(end_date) = filter.end_date.as_ref() {
        clauses.push("usage_date <= ?".to_string());
        values.push(Value::Text(end_date.clone()));
    }
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(model, '')))",
        filter.model.as_ref(),
    );
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(platform, '')))",
        filter.platform.as_ref(),
    );
    (format!("WHERE {}", clauses.join(" AND ")), values)
}

/// 使用日汇总回答仅包含日期、模型和平台条件的统计查询。
pub fn summarize_usage_rollup_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<UsageStatsRecord> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_rollup_filter_where(account_id, filter);
    conn.query_row(
        &format!(
            "SELECT
                COALESCE(SUM(requests), 0) AS total_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(cache_creation_tokens + cache_read_tokens), 0) AS total_cache_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
                COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
                CASE WHEN COALESCE(SUM(duration_ms_count), 0) > 0
                     THEN CAST(SUM(duration_ms_sum) AS REAL) / SUM(duration_ms_count)
                     ELSE 0 END AS average_duration_ms
             FROM account_usage_daily_rollup
             {where_sql}"
        ),
        params_from_iter(values.iter()),
        |row| {
            Ok(UsageStatsRecord {
                total_requests: row.get("total_requests")?,
                total_input_tokens: row.get("total_input_tokens")?,
                total_output_tokens: row.get("total_output_tokens")?,
                total_cache_tokens: Some(row.get("total_cache_tokens")?),
                total_cache_creation_tokens: Some(row.get("total_cache_creation_tokens")?),
                total_cache_read_tokens: Some(row.get("total_cache_read_tokens")?),
                total_tokens: row.get("total_tokens")?,
                total_cost: row.get("total_cost")?,
                total_actual_cost: row.get("total_actual_cost")?,
                average_duration_ms: row.get("average_duration_ms")?,
                rpm: None,
                tpm: None,
            })
        },
    )
    .map_err(Into::into)
}

/// 使用日汇总回答仅包含日期、模型和平台条件的模型分布查询。
pub fn list_usage_models_rollup_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<Vec<ModelUsagePoint>> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_rollup_filter_where(account_id, filter);
    let mut stmt = conn.prepare(&format!(
        "SELECT
            COALESCE(NULLIF(model, ''), 'unknown') AS model,
            COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
            COALESCE(SUM(total_cost), 0) AS cost,
            COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM account_usage_daily_rollup
         {where_sql}
         GROUP BY COALESCE(NULLIF(model, ''), 'unknown')
         ORDER BY actual_cost DESC, requests DESC, model ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(ModelUsagePoint {
            model: row.get("model")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_creation_tokens: Some(row.get("cache_creation_tokens")?),
            cache_read_tokens: Some(row.get("cache_read_tokens")?),
            total_tokens: row.get("total_tokens")?,
            cost: Some(row.get("cost")?),
            actual_cost: Some(row.get("actual_cost")?),
        })
    })?;
    collect_rows(rows)
}

/// 使用日汇总回答仅包含日期、模型和平台条件的每日趋势查询。
pub fn list_usage_trend_rollup_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<Vec<DailyUsagePoint>> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_rollup_filter_where(account_id, filter);
    let mut stmt = conn.prepare(&format!(
        "SELECT
            usage_date AS date,
            COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_daily_rollup
         {where_sql}
         GROUP BY usage_date
         ORDER BY date ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(DailyUsagePoint {
            date: row.get("date")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: Some(row.get("cache_read_tokens")?),
            cache_write_tokens: Some(row.get("cache_write_tokens")?),
            total_tokens: Some(row.get("total_tokens")?),
            actual_cost: Some(row.get("actual_cost")?),
            total_cost: Some(row.get("total_cost")?),
        })
    })?;
    collect_rows(rows)
}

pub fn summarize_usage_rows_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<UsageStatsRecord> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    conn.query_row(
        &format!(
            "SELECT
                COUNT(*) AS total_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_cache_tokens,
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS total_cache_creation_tokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS total_cache_read_tokens,
                COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
                COALESCE(SUM(total_cost), 0) AS total_cost,
                COALESCE(SUM(actual_cost), 0) AS total_actual_cost,
                COALESCE(AVG(duration_ms), 0) AS average_duration_ms
             FROM account_usage_row_cache
             {where_sql}"
        ),
        params_from_iter(values.iter()),
        |row| {
            Ok(UsageStatsRecord {
                total_requests: row.get("total_requests")?,
                total_input_tokens: row.get("total_input_tokens")?,
                total_output_tokens: row.get("total_output_tokens")?,
                total_cache_tokens: Some(row.get("total_cache_tokens")?),
                total_cache_creation_tokens: Some(row.get("total_cache_creation_tokens")?),
                total_cache_read_tokens: Some(row.get("total_cache_read_tokens")?),
                total_tokens: row.get("total_tokens")?,
                total_cost: row.get("total_cost")?,
                total_actual_cost: row.get("total_actual_cost")?,
                average_duration_ms: row.get("average_duration_ms")?,
                rpm: None,
                tpm: None,
            })
        },
    )
    .map_err(Into::into)
}

pub fn list_usage_models_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<Vec<ModelUsagePoint>> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    let mut stmt = conn.prepare(&format!(
        "SELECT
            COALESCE(NULLIF(model, ''), 'unknown') AS model,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_creation_tokens,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
            COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
            COALESCE(SUM(total_cost), 0) AS cost,
            COALESCE(SUM(actual_cost), 0) AS actual_cost
         FROM account_usage_row_cache
         {where_sql}
         GROUP BY COALESCE(NULLIF(model, ''), 'unknown')
         ORDER BY actual_cost DESC, requests DESC, model ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(ModelUsagePoint {
            model: row.get("model")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_creation_tokens: Some(row.get("cache_creation_tokens")?),
            cache_read_tokens: Some(row.get("cache_read_tokens")?),
            total_tokens: row.get("total_tokens")?,
            cost: Some(row.get("cost")?),
            actual_cost: Some(row.get("actual_cost")?),
        })
    })?;
    collect_rows(rows)
}

pub fn list_usage_trend_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<Vec<DailyUsagePoint>> {
    let conn = db.connect()?;
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    let mut stmt = conn.prepare(&format!(
        "SELECT
            substr(occurred_at, 1, 10) AS date,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
            COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_write_tokens,
            COALESCE(SUM(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0)), 0) AS total_tokens,
            COALESCE(SUM(actual_cost), 0) AS actual_cost,
            COALESCE(SUM(total_cost), 0) AS total_cost
         FROM account_usage_row_cache
         {where_sql}
         GROUP BY substr(occurred_at, 1, 10)
         ORDER BY date ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(DailyUsagePoint {
            date: row.get("date")?,
            requests: row.get("requests")?,
            input_tokens: row.get("input_tokens")?,
            output_tokens: row.get("output_tokens")?,
            cache_read_tokens: Some(row.get("cache_read_tokens")?),
            cache_write_tokens: Some(row.get("cache_write_tokens")?),
            total_tokens: Some(row.get("total_tokens")?),
            actual_cost: Some(row.get("actual_cost")?),
            total_cost: Some(row.get("total_cost")?),
        })
    })?;
    collect_rows(rows)
}

pub fn find_usage_extremes_filtered(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
) -> Result<UsageExtremesPayload> {
    Ok(UsageExtremesPayload {
        longest_first_token: find_usage_row_extreme_with_filter(
            db,
            account_id,
            filter,
            "first_token_ms",
        )?,
        highest_actual_cost: find_usage_row_extreme_with_filter(
            db,
            account_id,
            filter,
            "actual_cost",
        )?,
        highest_input_tokens: find_usage_row_extreme_with_filter(
            db,
            account_id,
            filter,
            "input_tokens",
        )?,
        highest_output_tokens: find_usage_row_extreme_with_filter(
            db,
            account_id,
            filter,
            "output_tokens",
        )?,
    })
}

fn find_usage_row_extreme_with_filter(
    db: &Database,
    account_id: &str,
    filter: &UsageQueryFilter,
    metric_sql: &str,
) -> Result<Option<UsageRow>> {
    let forced_index = match (metric_sql, filter.api_key_id.is_some()) {
        ("input_tokens", true) => Some("idx_account_usage_row_cache_account_key_input_tokens"),
        ("input_tokens", false) => Some("idx_account_usage_row_cache_account_input_tokens"),
        ("output_tokens", true) => Some("idx_account_usage_row_cache_account_key_output_tokens"),
        ("output_tokens", false) => Some("idx_account_usage_row_cache_account_output_tokens"),
        ("first_token_ms", true) => Some("idx_account_usage_row_cache_account_key_first_token_ms"),
        ("first_token_ms", false) => Some("idx_account_usage_row_cache_account_first_token_ms"),
        ("actual_cost", _) => None,
        _ => return Err(anyhow::anyhow!("不支持的用量极值字段。")),
    };
    let from_clause = forced_index
        .map(|index_name| format!("account_usage_row_cache INDEXED BY {index_name}"))
        .unwrap_or_else(|| "account_usage_row_cache".to_string());
    let (where_sql, values) = build_usage_filter_where(account_id, filter);
    let conn = db.connect()?;
    conn.query_row(
        &format!(
            "SELECT {USAGE_ROW_SELECT_COLUMNS}
             FROM {from_clause}
             {where_sql} AND {metric_sql} IS NOT NULL
             ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
             LIMIT 1"
        ),
        params_from_iter(values.iter()),
        map_usage_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn find_usage_row_extreme(
    db: &Database,
    account_id: &str,
    api_key_id: Option<i64>,
    start_date: Option<&str>,
    end_date: Option<&str>,
    metric_sql: &str,
) -> Result<Option<UsageRow>> {
    let conn = db.connect()?;
    let (start_bound, end_exclusive) = usage_range_query_bounds(start_date, end_date);
    let forced_index = match (metric_sql, api_key_id.is_some()) {
        ("input_tokens", true) => Some("idx_account_usage_row_cache_account_key_input_tokens"),
        ("input_tokens", false) => Some("idx_account_usage_row_cache_account_input_tokens"),
        ("output_tokens", true) => Some("idx_account_usage_row_cache_account_key_output_tokens"),
        ("output_tokens", false) => Some("idx_account_usage_row_cache_account_output_tokens"),
        ("first_token_ms", true) => Some("idx_account_usage_row_cache_account_key_first_token_ms"),
        ("first_token_ms", false) => Some("idx_account_usage_row_cache_account_first_token_ms"),
        _ => None,
    };
    let from_clause = forced_index
        .map(|index_name| format!("account_usage_row_cache INDEXED BY {index_name}"))
        .unwrap_or_else(|| "account_usage_row_cache".to_string());
    let row = match (api_key_id, start_bound.as_ref(), end_exclusive.as_ref()) {
        (Some(key_id), Some(start), Some(end)) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at >= ?3
                   AND occurred_at < ?4
                   AND {metric_sql} IS NOT NULL
                 ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, key_id, start, end],
            map_usage_row,
        ),
        (Some(key_id), Some(start), None) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at >= ?3
                   AND {metric_sql} IS NOT NULL
                 ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, key_id, start],
            map_usage_row,
        ),
        (Some(key_id), None, Some(end)) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND occurred_at < ?3
                   AND {metric_sql} IS NOT NULL
                 ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, key_id, end],
            map_usage_row,
        ),
        (Some(key_id), None, None) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND api_key_id = ?2
                   AND {metric_sql} IS NOT NULL
                   ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, key_id],
            map_usage_row,
        ),
        (None, Some(start), Some(end)) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at >= ?2
                   AND occurred_at < ?3
                   AND {metric_sql} IS NOT NULL
                 ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, start, end],
            map_usage_row,
        ),
        (None, Some(start), None) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at >= ?2
                   AND {metric_sql} IS NOT NULL
                   ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, start],
            map_usage_row,
        ),
        (None, None, Some(end)) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND occurred_at < ?2
                   AND {metric_sql} IS NOT NULL
                   ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                 LIMIT 1"
            ),
            params![account_id, end],
            map_usage_row,
        ),
        (None, None, None) => conn.query_row(
            &format!(
                "SELECT {USAGE_ROW_SELECT_COLUMNS}
                 FROM {from_clause}
                 WHERE account_id = ?1
                   AND {metric_sql} IS NOT NULL
                   ORDER BY {metric_sql} DESC, occurred_at DESC, usage_id DESC
                   LIMIT 1"
            ),
            params![account_id],
            map_usage_row,
        ),
    };

    row.optional().map_err(Into::into)
}

fn usage_facet_sql(field: UsageFacetField) -> (&'static str, &'static str) {
    match field {
        UsageFacetField::ApiKey => (
            "CAST(api_key_id AS TEXT)",
            "COALESCE(NULLIF(TRIM(api_key_name), ''), '#' || CAST(api_key_id AS TEXT))",
        ),
        UsageFacetField::Model => (
            "LOWER(TRIM(COALESCE(model, '')))",
            "TRIM(COALESCE(model, ''))",
        ),
        UsageFacetField::Platform => (
            "LOWER(TRIM(COALESCE(platform, '')))",
            "TRIM(COALESCE(platform, ''))",
        ),
        UsageFacetField::Endpoint => (
            "LOWER(TRIM(COALESCE(endpoint, '')))",
            "TRIM(COALESCE(endpoint, ''))",
        ),
        UsageFacetField::UpstreamEndpoint => (
            "LOWER(TRIM(COALESCE(upstream_endpoint, '')))",
            "TRIM(COALESCE(upstream_endpoint, ''))",
        ),
        UsageFacetField::Group => (
            "CASE WHEN group_id IS NOT NULL THEN CAST(group_id AS TEXT) ELSE 'name:' || LOWER(TRIM(COALESCE(group_name, ''))) END",
            "COALESCE(NULLIF(TRIM(group_name), ''), CASE WHEN group_id IS NOT NULL THEN '#' || CAST(group_id AS TEXT) END)",
        ),
        UsageFacetField::Subscription => (
            "CASE WHEN subscription_id IS NOT NULL THEN CAST(subscription_id AS TEXT) ELSE 'name:' || LOWER(TRIM(COALESCE(subscription_name, ''))) END",
            "COALESCE(NULLIF(TRIM(subscription_name), ''), CASE WHEN subscription_id IS NOT NULL THEN '#' || CAST(subscription_id AS TEXT) END)",
        ),
        UsageFacetField::SubscriptionType => (
            "LOWER(TRIM(COALESCE(subscription_type, '')))",
            "TRIM(COALESCE(subscription_type, ''))",
        ),
        UsageFacetField::ServiceTier => (
            "LOWER(TRIM(COALESCE(service_tier, '')))",
            "TRIM(COALESCE(service_tier, ''))",
        ),
        UsageFacetField::ReasoningEffort => (
            "LOWER(TRIM(COALESCE(reasoning_effort, '')))",
            "TRIM(COALESCE(reasoning_effort, ''))",
        ),
        UsageFacetField::RequestType => (request_type_bucket_sql(), request_type_bucket_sql()),
        UsageFacetField::BillingType => (
            "CAST(billing_type AS TEXT)",
            "CAST(billing_type AS TEXT)",
        ),
        UsageFacetField::BillingMode => (
            "LOWER(TRIM(COALESCE(billing_mode, '')))",
            "TRIM(COALESCE(billing_mode, ''))",
        ),
        UsageFacetField::MediaType => (
            "LOWER(TRIM(COALESCE(media_type, '')))",
            "TRIM(COALESCE(media_type, ''))",
        ),
        UsageFacetField::ImageSize => (
            "LOWER(TRIM(COALESCE(image_size, '')))",
            "TRIM(COALESCE(image_size, ''))",
        ),
        UsageFacetField::ImageInputSize => (
            "LOWER(TRIM(COALESCE(image_input_size, '')))",
            "TRIM(COALESCE(image_input_size, ''))",
        ),
        UsageFacetField::ImageOutputSize => (
            "LOWER(TRIM(COALESCE(image_output_size, '')))",
            "TRIM(COALESCE(image_output_size, ''))",
        ),
        UsageFacetField::ImageSizeSource => (
            "LOWER(TRIM(COALESCE(image_size_source, '')))",
            "TRIM(COALESCE(image_size_source, ''))",
        ),
        UsageFacetField::ImageSizeBreakdown => (
            "LOWER(TRIM(COALESCE(image_size_breakdown, '')))",
            "TRIM(COALESCE(image_size_breakdown, ''))",
        ),
    }
}

fn clear_usage_facet_filter(filter: &mut UsageQueryFilter, field: UsageFacetField) {
    match field {
        UsageFacetField::ApiKey => {
            filter.api_key_id = None;
            filter.api_key_name = None;
        }
        UsageFacetField::Model => filter.model = None,
        UsageFacetField::Platform => filter.platform = None,
        UsageFacetField::Endpoint => filter.endpoint = None,
        UsageFacetField::UpstreamEndpoint => filter.upstream_endpoint = None,
        UsageFacetField::Group => {
            filter.group_id = None;
            filter.group_name = None;
        }
        UsageFacetField::Subscription => {
            filter.subscription_id = None;
            filter.subscription_name = None;
        }
        UsageFacetField::SubscriptionType => filter.subscription_type = None,
        UsageFacetField::ServiceTier => filter.service_tier = None,
        UsageFacetField::ReasoningEffort => filter.reasoning_effort = None,
        UsageFacetField::RequestType => filter.request_type = None,
        UsageFacetField::BillingType => filter.billing_type = None,
        UsageFacetField::BillingMode => filter.billing_mode = None,
        UsageFacetField::MediaType => filter.media_type = None,
        UsageFacetField::ImageSize => filter.image_size = None,
        UsageFacetField::ImageInputSize => filter.image_input_size = None,
        UsageFacetField::ImageOutputSize => filter.image_output_size = None,
        UsageFacetField::ImageSizeSource => filter.image_size_source = None,
        UsageFacetField::ImageSizeBreakdown => filter.image_size_breakdown = None,
    }
}

fn build_usage_filter_where(account_id: &str, filter: &UsageQueryFilter) -> (String, Vec<Value>) {
    let mut clauses = vec!["account_id = ?".to_string()];
    let mut values = vec![Value::Text(account_id.to_string())];

    if let Some(api_key_id) = filter.api_key_id {
        clauses.push("api_key_id = ?".to_string());
        values.push(Value::Integer(api_key_id));
    }
    for (column, value) in [
        ("upstream_user_id", filter.upstream_user_id),
        ("upstream_account_id", filter.upstream_account_id),
        ("group_id", filter.group_id),
        ("subscription_id", filter.subscription_id),
    ] {
        if let Some(value) = value {
            clauses.push(format!("{column} = ?"));
            values.push(Value::Integer(value));
        }
    }
    let (start_bound, end_exclusive) =
        usage_range_query_bounds(filter.start_date.as_deref(), filter.end_date.as_deref());
    if let Some(start_bound) = start_bound {
        clauses.push("occurred_at >= ?".to_string());
        values.push(Value::Text(start_bound));
    }
    if let Some(end_exclusive) = end_exclusive {
        clauses.push("occurred_at < ?".to_string());
        values.push(Value::Text(end_exclusive));
    }

    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(model, '')))",
        filter.model.as_ref(),
    );
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(group_name, '')))",
        filter.group_name.as_ref(),
    );
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(subscription_name, '')))",
        filter.subscription_name.as_ref(),
    );
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(platform, '')))",
        filter.platform.as_ref(),
    );
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(reasoning_effort, '')))",
        filter.reasoning_effort.as_ref(),
    );
    if let Some(request_type) = filter.request_type.as_ref() {
        let normalized = UsageTextFilter {
            value: normalize_usage_request_type_value(&request_type.value),
            mode: request_type.mode,
        };
        push_usage_text_filter(
            &mut clauses,
            &mut values,
            request_type_bucket_sql(),
            Some(&normalized),
        );
    }
    if let Some(billing_type) = filter.billing_type {
        clauses.push("billing_type = ?".to_string());
        values.push(Value::Integer(billing_type));
    }
    push_usage_text_filter(
        &mut clauses,
        &mut values,
        "LOWER(TRIM(COALESCE(billing_mode, '')))",
        filter.billing_mode.as_ref(),
    );

    for (column, value) in [
        ("subscription_type", filter.subscription_type.as_ref()),
        ("service_tier", filter.service_tier.as_ref()),
        ("api_key_name", filter.api_key_name.as_ref()),
        ("usage_id", filter.usage_id.as_ref()),
        ("request_id", filter.request_id.as_ref()),
        ("endpoint", filter.endpoint.as_ref()),
        ("upstream_endpoint", filter.upstream_endpoint.as_ref()),
        ("media_type", filter.media_type.as_ref()),
        ("image_size", filter.image_size.as_ref()),
        ("image_input_size", filter.image_input_size.as_ref()),
        ("image_output_size", filter.image_output_size.as_ref()),
        ("image_size_source", filter.image_size_source.as_ref()),
        ("image_size_breakdown", filter.image_size_breakdown.as_ref()),
        ("ip_address", filter.ip_address.as_ref()),
    ] {
        let expression = format!("LOWER(TRIM(COALESCE({column}, '')))");
        push_usage_text_filter(&mut clauses, &mut values, &expression, value);
    }
    if let Some(stream) = filter.stream {
        push_usage_bool_filter(&mut clauses, &mut values, "stream", stream);
    }
    if let Some(openai_ws_mode) = filter.openai_ws_mode {
        push_usage_bool_filter(&mut clauses, &mut values, "openai_ws_mode", openai_ws_mode);
    }
    if let Some(long_context) = filter.long_context_billing_applied {
        push_usage_bool_filter(
            &mut clauses,
            &mut values,
            "long_context_billing_applied",
            long_context,
        );
    }
    if let Some(cache_ttl) = filter.cache_ttl_overridden {
        push_usage_bool_filter(&mut clauses, &mut values, "cache_ttl_overridden", cache_ttl);
    }

    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "input_tokens",
        &filter.input_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "output_tokens",
        &filter.output_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "(input_tokens + output_tokens + COALESCE(cache_creation_tokens, 0) + COALESCE(cache_read_tokens, 0))",
        &filter.total_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "cache_creation_tokens",
        &filter.cache_creation_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "cache_read_tokens",
        &filter.cache_read_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "cache_creation_5m_tokens",
        &filter.cache_creation_5m_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "cache_creation_1h_tokens",
        &filter.cache_creation_1h_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "image_input_tokens",
        &filter.image_input_tokens,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "image_output_tokens",
        &filter.image_output_tokens,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "actual_cost",
        &filter.actual_cost,
    );
    push_usage_f64_range(&mut clauses, &mut values, "total_cost", &filter.total_cost);
    push_usage_f64_range(&mut clauses, &mut values, "input_cost", &filter.input_cost);
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "output_cost",
        &filter.output_cost,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "cache_creation_cost",
        &filter.cache_creation_cost,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "cache_read_cost",
        &filter.cache_read_cost,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "image_input_cost",
        &filter.image_input_cost,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "image_output_cost",
        &filter.image_output_cost,
    );
    push_usage_f64_range(
        &mut clauses,
        &mut values,
        "rate_multiplier",
        &filter.rate_multiplier,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "duration_ms",
        &filter.duration_ms,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "first_token_ms",
        &filter.first_token_ms,
    );
    push_usage_i64_range(
        &mut clauses,
        &mut values,
        "image_count",
        &filter.image_count,
    );
    if let Some(query) = normalize_user_agent_fts_query(filter.user_agent_query.as_deref()) {
        clauses.push(
            "EXISTS (SELECT 1 FROM account_usage_user_agent_fts
                     WHERE account_usage_user_agent_fts.rowid = account_usage_row_cache.rowid
                       AND account_usage_user_agent_fts MATCH ?)"
                .to_string(),
        );
        values.push(Value::Text(query));
    }

    (format!("WHERE {}", clauses.join(" AND ")), values)
}

fn push_usage_text_filter(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    column_sql: &str,
    value: Option<&UsageTextFilter>,
) {
    let Some(value) = normalize_usage_text_filter(value) else {
        return;
    };

    match value.mode {
        UsageTextMatchMode::Exact => {
            clauses.push(format!("{column_sql} = ?"));
            values.push(Value::Text(value.value));
        }
        UsageTextMatchMode::Prefix => {
            clauses.push(format!("{column_sql} LIKE ? ESCAPE '\\'"));
            values.push(Value::Text(format!(
                "{}%",
                escape_like_prefix(&value.value)
            )));
        }
    }
}

fn push_usage_bool_filter(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    column_sql: &str,
    value: bool,
) {
    clauses.push(format!("COALESCE({column_sql}, 0) = ?"));
    values.push(Value::Integer(i64::from(value)));
}

fn push_usage_i64_range(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    expression: &str,
    range: &UsageI64Range,
) {
    if let Some(min) = range.min {
        clauses.push(format!("{expression} >= ?"));
        values.push(Value::Integer(min));
    }
    if let Some(max) = range.max {
        clauses.push(format!("{expression} <= ?"));
        values.push(Value::Integer(max));
    }
}

fn push_usage_f64_range(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    expression: &str,
    range: &UsageF64Range,
) {
    if let Some(min) = range.min {
        clauses.push(format!("{expression} >= ?"));
        values.push(Value::Real(min));
    }
    if let Some(max) = range.max {
        clauses.push(format!("{expression} <= ?"));
        values.push(Value::Real(max));
    }
}

fn normalize_usage_text_filter(value: Option<&UsageTextFilter>) -> Option<UsageTextFilter> {
    let value = value?;
    let normalized = normalize_usage_filter_value(Some(&value.value))?;
    Some(UsageTextFilter {
        value: normalized,
        mode: value.mode,
    })
}

fn normalize_usage_filter_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
}

fn normalize_usage_request_type_value(value: &str) -> String {
    normalize_usage_filter_value(Some(value))
        .map(|value| match value.as_str() {
            "default" => "standard".to_string(),
            _ => value,
        })
        .unwrap_or_default()
}

fn escape_like_prefix(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn normalize_user_agent_fts_query(value: Option<&str>) -> Option<String> {
    let tokens = value?
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{token}\"*"))
        .collect::<Vec<_>>();
    (!tokens.is_empty()).then(|| tokens.join(" AND "))
}

fn usage_range_query_bounds(
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> (Option<String>, Option<String>) {
    let start_bound = start_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let end_exclusive = end_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.checked_add_days(Days::new(1)))
                .map(|date| date.to_string())
                .unwrap_or_else(|| format!("{value}~"))
        });
    (start_bound, end_exclusive)
}

fn map_usage_row_cache_record(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<AccountUsageRowCacheRecord> {
    Ok(AccountUsageRowCacheRecord {
        account_id: row.get("account_id")?,
        usage_id: row.get("usage_id")?,
        occurred_at: row.get("occurred_at")?,
        row: map_usage_row(row)?,
        updated_at: row.get("updated_at")?,
        first_seen_at: row.get("first_seen_at")?,
        last_seen_at: row.get("last_seen_at")?,
    })
}

fn map_usage_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageRow> {
    let input_tokens = row.get::<_, Option<i64>>("input_tokens")?.unwrap_or(0);
    let output_tokens = row.get::<_, Option<i64>>("output_tokens")?.unwrap_or(0);
    let cache_creation_tokens = row.get::<_, Option<i64>>("cache_creation_tokens")?;
    let cache_read_tokens = row.get::<_, Option<i64>>("cache_read_tokens")?;
    let total_tokens = input_tokens
        + output_tokens
        + cache_creation_tokens.unwrap_or(0)
        + cache_read_tokens.unwrap_or(0);

    Ok(UsageRow {
        id: row.get("usage_id")?,
        upstream_user_id: row.get("upstream_user_id")?,
        api_key_id: row.get("api_key_id")?,
        upstream_account_id: row.get("upstream_account_id")?,
        request_id: row.get("request_id")?,
        created_at: row.get("occurred_at")?,
        model: row
            .get::<_, Option<String>>("model")?
            .unwrap_or_else(|| "unknown".into()),
        reasoning_effort: row.get("reasoning_effort")?,
        endpoint: row.get("endpoint")?,
        upstream_endpoint: row.get("upstream_endpoint")?,
        group_id: row.get("group_id")?,
        subscription_id: row.get("subscription_id")?,
        actual_cost: row.get::<_, Option<f64>>("actual_cost")?.unwrap_or(0.0),
        total_cost: row.get::<_, Option<f64>>("total_cost")?.unwrap_or(0.0),
        input_tokens,
        output_tokens,
        input_cost: row.get("input_cost")?,
        output_cost: row.get("output_cost")?,
        cache_creation_tokens,
        cache_read_tokens,
        cache_creation_5m_tokens: row.get("cache_creation_5m_tokens")?,
        cache_creation_1h_tokens: row.get("cache_creation_1h_tokens")?,
        cache_creation_cost: row.get("cache_creation_cost")?,
        cache_read_cost: row.get("cache_read_cost")?,
        total_tokens,
        first_token_ms: row.get("first_token_ms")?,
        duration_ms: row.get("duration_ms")?,
        billing_mode: row.get("billing_mode")?,
        request_type: row.get("request_type")?,
        stream: row.get("stream")?,
        openai_ws_mode: row.get("openai_ws_mode")?,
        billing_type: row.get("billing_type")?,
        service_tier: row.get("service_tier")?,
        long_context_billing_applied: row.get("long_context_billing_applied")?,
        image_count: row.get("image_count")?,
        image_input_tokens: row.get("image_input_tokens")?,
        image_size: row.get("image_size")?,
        image_input_size: row.get("image_input_size")?,
        image_output_size: row.get("image_output_size")?,
        image_output_tokens: row.get("image_output_tokens")?,
        image_input_cost: row.get("image_input_cost")?,
        image_output_cost: row.get("image_output_cost")?,
        image_size_source: row.get("image_size_source")?,
        image_size_breakdown: row.get("image_size_breakdown")?,
        media_type: row.get("media_type")?,
        rate_multiplier: row.get("rate_multiplier")?,
        user_agent: row.get("user_agent")?,
        ip_address: row.get("ip_address")?,
        cache_ttl_overridden: row.get("cache_ttl_overridden")?,
        api_key_name: row.get("api_key_name")?,
        platform: row.get("platform")?,
        subscription_name: row.get("subscription_name")?,
        group_name: row.get("group_name")?,
        subscription_type: row.get("subscription_type")?,
    })
}

fn collect_rows<T, F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rusqlite::{params, Connection};
    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::infrastructure::sqlite::{schema, Database};

    #[test]
    fn usage_row_cache_presence_is_batched_and_account_scoped() {
        let db_path = temp_db_path("usage-row-cache-presence");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let known = sample_usage_row();
        let mut unseen = known.clone();
        unseen.id = "usage-unseen".into();
        let updated_at = "2026-07-02T16:15:00+08:00";
        merge_usage_row_cache(&db, "account-1", &[known.clone()], updated_at)
            .expect("seed cached row");

        assert_eq!(
            usage_row_cache_presence(&db, "account-1", &[known.clone(), unseen.clone()])
                .expect("lookup cache presence"),
            vec![true, false]
        );
        assert_eq!(
            usage_row_cache_presence(&db, "other-account", &[known])
                .expect("lookup other account presence"),
            vec![false]
        );
        assert!(usage_row_cache_presence(&db, "account-1", &[])
            .expect("lookup empty cache presence")
            .is_empty());

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_row_cache_presence_error_does_not_expose_usage_id() {
        let db = Database::new(temp_db_path("usage-row-cache-presence-invalid-time"));
        let mut row = sample_usage_row();
        row.id = "usage-sensitive-id".into();
        row.created_at = "invalid-storage-time".into();

        let error = usage_row_cache_presence(&db, "account-1", &[row])
            .expect_err("invalid timestamp should fail cache presence lookup")
            .to_string();

        assert!(error.contains("规范化 usage 缓存身份时间失败"));
        assert!(!error.contains("usage-sensitive-id"));
    }

    #[test]
    fn usage_row_cache_presence_keeps_one_hundred_identities_aligned() {
        let db_path = temp_db_path("usage-row-cache-presence-hundred");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let rows = (0..100)
            .map(|index| {
                let mut row = sample_usage_row();
                row.id = format!("usage-presence-{index:03}");
                row.created_at =
                    format!("2026-07-21T00:{:02}:{:02}+08:00", index / 60, index % 60,);
                row
            })
            .collect::<Vec<_>>();
        let existing = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| (index % 2 == 0).then(|| row.clone()))
            .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &existing, "2026-07-21T01:00:00+08:00")
            .expect("seed one hundred presence rows");

        let presence = usage_row_cache_presence(&db, "account-1", &rows)
            .expect("look up one hundred cache identities");
        assert_eq!(presence.len(), 100);
        for (index, present) in presence.into_iter().enumerate() {
            assert_eq!(present, index % 2 == 0, "unexpected presence at {index}");
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn schema_apply_rebuilds_usage_cache_without_row_json() {
        let db_path = temp_db_path("schema-backfill");
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE sites (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              base_url TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE accounts (
              id TEXT PRIMARY KEY,
              site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
              label TEXT NOT NULL,
              email TEXT NOT NULL,
              balance_warning REAL NOT NULL,
              last_login_at TEXT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE account_usage_row_cache (
              account_id TEXT NOT NULL,
              usage_id TEXT NOT NULL,
              api_key_id INTEGER NULL,
              occurred_at TEXT NOT NULL,
              row_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              first_seen_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              PRIMARY KEY (account_id, usage_id, occurred_at)
            );
            "#,
        )
        .expect("create legacy usage cache table");
        conn.execute(
            "INSERT INTO sites (id, name, base_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "site-legacy",
                "Legacy Site",
                "http://127.0.0.1:16661",
                "2026-07-02T16:00:00+08:00",
                "2026-07-02T16:00:00+08:00"
            ],
        )
        .expect("insert legacy site");
        conn.execute(
            "INSERT INTO accounts (id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                "account-legacy",
                "site-legacy",
                "Legacy Account",
                "legacy@example.com",
                0.0,
                Option::<String>::None,
                "2026-07-02T16:00:00+08:00",
                "2026-07-02T16:00:00+08:00"
            ],
        )
        .expect("insert legacy account");
        conn.execute(
            "INSERT INTO account_usage_row_cache (
                account_id, usage_id, api_key_id, occurred_at, row_json, updated_at, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                "account-legacy",
                "usage-legacy",
                Option::<i64>::None,
                "2026-07-02T16:14:30+08:00",
                {
                    let mut legacy_row = json!({
                    "id": "usage-legacy",
                    "apiKeyId": 3641,
                    "createdAt": "2026-07-02T16:14:30+08:00",
                    "model": "gpt-4.1",
                    "reasoningEffort": "high",
                    "endpoint": "/responses",
                    "upstreamEndpoint": "/v1/responses",
                    "actualCost": 1.25,
                    "totalCost": 1.5,
                    "inputTokens": 100,
                    "outputTokens": 200,
                    "inputCost": 0.5,
                    "outputCost": 1.0,
                    "cacheCreationTokens": 3,
                    "cacheReadTokens": 4,
                    "cacheCreationCost": 0.1,
                    "cacheReadCost": 0.05,
                    "totalTokens": 307,
                    "firstTokenMs": 123,
                    "durationMs": 456,
                    "billingMode": "token",
                    "requestType": "stream",
                    "stream": true,
                    "billingType": 1,
                    "imageCount": 2,
                    "imageSize": "1024x1024",
                    "imageInputSize": "auto",
                    "imageOutputSize": "1024x1024",
                    "imageOutputTokens": 99,
                    "imageOutputCost": 0.9,
                    "imageSizeSource": "explicit",
                    "imageSizeBreakdown": "{\"1024x1024\":2}",
                    "mediaType": "image",
                    "rateMultiplier": 1.2,
                    "userAgent": "UA",
                    "ipAddress": "36.248.234.88",
                    "apiKeyName": "codex",
                    "platform": "openai",
                    "subscriptionName": "Plan A",
                    "groupName": "Group A",
                    "subscriptionType": "subscription"
                    });
                    legacy_row["serviceTier"] = json!("priority");
                    legacy_row["longContextBillingApplied"] = json!(true);
                    legacy_row["imageInputTokens"] = json!(42);
                    legacy_row["imageInputCost"] = json!(0.2);
                    legacy_row.to_string()
                },
                "2026-07-02T16:15:00+08:00",
                "2026-07-02T16:15:00+08:00",
                "2026-07-02T16:15:00+08:00"
            ],
        )
        .expect("insert legacy row");

        let mut conn = conn;
        schema::apply(&mut conn).expect("apply schema migration");

        let columns = table_columns(&conn, "account_usage_row_cache");
        assert!(!columns.iter().any(|column| column == "row_json"));

        let migrated = conn
            .query_row(
                "SELECT api_key_id, model, input_tokens, output_tokens, total_cost, actual_cost,
                        request_type, stream, api_key_name, platform, ip_address, cache_creation_5m_tokens,
                        openai_ws_mode, cache_ttl_overridden, service_tier, image_input_tokens,
                        image_input_cost, long_context_billing_applied
                 FROM account_usage_row_cache
                 WHERE usage_id = ?1",
                params!["usage-legacy"],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<f64>>(4)?,
                        row.get::<_, Option<f64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<bool>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                        row.get::<_, Option<i64>>(11)?,
                        row.get::<_, Option<bool>>(12)?,
                        row.get::<_, Option<bool>>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, Option<i64>>(15)?,
                        row.get::<_, Option<f64>>(16)?,
                        row.get::<_, Option<bool>>(17)?,
                    ))
                },
            )
            .expect("read migrated row");

        assert_eq!(migrated.0, Some(3641));
        assert_eq!(migrated.1.as_deref(), Some("gpt-4.1"));
        assert_eq!(migrated.2, Some(100));
        assert_eq!(migrated.3, Some(200));
        assert_eq!(migrated.4, Some(1.5));
        assert_eq!(migrated.5, Some(1.25));
        assert_eq!(migrated.6.as_deref(), Some("stream"));
        assert_eq!(migrated.7, Some(true));
        assert_eq!(migrated.8.as_deref(), Some("codex"));
        assert_eq!(migrated.9.as_deref(), Some("openai"));
        assert_eq!(migrated.10.as_deref(), Some("36.248.234.88"));
        assert_eq!(migrated.11, None);
        assert_eq!(migrated.12, None);
        assert_eq!(migrated.13, None);
        assert_eq!(migrated.14.as_deref(), Some("priority"));
        assert_eq!(migrated.15, Some(42));
        assert_eq!(migrated.16, Some(0.2));
        assert_eq!(migrated.17, Some(true));
    }

    #[test]
    fn usage_rows_round_trip_from_flattened_columns() {
        let db_path = temp_db_path("usage-round-trip");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let row = sample_usage_row();

        merge_usage_row_cache(
            &db,
            "account-1",
            &[row.clone()],
            "2026-07-02T16:15:00+08:00",
        )
        .expect("merge usage row cache");

        let conn = db.connect().expect("open sqlite");
        let stored = conn
            .query_row(
                "SELECT upstream_user_id, request_id, ip_address, cache_creation_5m_tokens,
                        openai_ws_mode, cache_ttl_overridden, service_tier, image_input_tokens,
                        image_input_cost, long_context_billing_applied
                 FROM account_usage_row_cache
                 WHERE account_id = ?1 AND usage_id = ?2",
                params!["account-1", "usage-1"],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<bool>>(4)?,
                        row.get::<_, Option<bool>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<f64>>(8)?,
                        row.get::<_, Option<bool>>(9)?,
                    ))
                },
            )
            .expect("read stored columns");
        assert_eq!(stored.0, Some(2566));
        assert_eq!(
            stored.1.as_deref(),
            Some("client:38ee5a3b-8bae-4d6c-9ee0-917c0a21abb0")
        );
        assert_eq!(stored.2.as_deref(), Some("36.248.234.88"));
        assert_eq!(stored.3, Some(1));
        assert_eq!(stored.4, Some(false));
        assert_eq!(stored.5, Some(false));
        assert_eq!(stored.6.as_deref(), Some("priority"));
        assert_eq!(stored.7, Some(42));
        assert_eq!(stored.8, Some(0.2));
        assert_eq!(stored.9, Some(true));
        assert!(!table_columns(&conn, "account_usage_row_cache")
            .iter()
            .any(|column| column == "row_json"));

        let cached =
            list_usage_row_cache(&db, "account-1", None, None, None).expect("list usage cache");
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].row.id, "usage-1");
        assert_eq!(cached[0].row.upstream_user_id, Some(2566));
        assert_eq!(cached[0].row.upstream_account_id, Some(8172));
        assert_eq!(cached[0].row.group_id, Some(4));
        assert_eq!(cached[0].row.subscription_id, Some(3052));
        assert_eq!(cached[0].row.cache_creation_5m_tokens, Some(1));
        assert_eq!(cached[0].row.cache_creation_1h_tokens, Some(2));
        assert_eq!(cached[0].row.total_tokens, 307);
        assert_eq!(cached[0].row.openai_ws_mode, Some(false));
        assert_eq!(cached[0].row.ip_address.as_deref(), Some("36.248.234.88"));
        assert_eq!(cached[0].row.cache_ttl_overridden, Some(false));
        assert_eq!(cached[0].row.service_tier.as_deref(), Some("priority"));
        assert_eq!(cached[0].row.image_input_tokens, Some(42));
        assert_eq!(cached[0].row.image_input_cost, Some(0.2));
        assert_eq!(cached[0].row.long_context_billing_applied, Some(true));

        let page = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &UsageQueryFilter::default(),
            None,
            UsagePageDirection::Next,
            10,
        )
        .expect("list usage page");
        assert_eq!(page.items.len(), 1);
        assert!(!page.has_more);
        assert_eq!(page.items[0].id, "usage-1");
        assert_eq!(
            page.items[0].request_id.as_deref(),
            row.request_id.as_deref()
        );
        assert_eq!(page.items[0].service_tier, row.service_tier);

        let recent = list_recent_usage_rows(&db, "account-1", 1).expect("list recent usage rows");
        assert_eq!(recent[0].image_input_tokens, row.image_input_tokens);

        let extremes = find_usage_extremes_filtered(&db, "account-1", &UsageQueryFilter::default())
            .expect("find usage extremes");
        let highest_cost = extremes
            .highest_actual_cost
            .expect("highest actual cost row");
        assert_eq!(highest_cost.image_input_cost, row.image_input_cost);
        assert_eq!(
            highest_cost.long_context_billing_applied,
            row.long_context_billing_applied
        );
    }

    #[test]
    fn usage_merge_updates_nullable_billing_fields_in_both_directions() {
        let db_path = temp_db_path("usage-merge-billing-fields");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let original = sample_usage_row();

        assert_eq!(
            merge_usage_row_cache(
                &db,
                "account-1",
                &[original.clone()],
                "2026-07-02T16:15:00+08:00",
            )
            .expect("insert usage row"),
            1
        );

        let mut cleared = original.clone();
        cleared.service_tier = None;
        cleared.image_input_tokens = None;
        cleared.image_input_cost = None;
        cleared.long_context_billing_applied = None;
        assert_eq!(
            merge_usage_row_cache(
                &db,
                "account-1",
                &[cleared.clone()],
                "2026-07-02T16:16:00+08:00",
            )
            .expect("clear nullable billing fields"),
            1
        );

        let cached = list_usage_row_cache(&db, "account-1", None, None, None)
            .expect("read cleared billing fields");
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].row.service_tier, None);
        assert_eq!(cached[0].row.image_input_tokens, None);
        assert_eq!(cached[0].row.image_input_cost, None);
        assert_eq!(cached[0].row.long_context_billing_applied, None);

        let mut restored = cleared;
        restored.service_tier = Some("standard".into());
        restored.image_input_tokens = Some(84);
        restored.image_input_cost = Some(0.4);
        restored.long_context_billing_applied = Some(false);
        assert_eq!(
            merge_usage_row_cache(
                &db,
                "account-1",
                &[restored.clone()],
                "2026-07-02T16:17:00+08:00",
            )
            .expect("restore nullable billing fields"),
            1
        );
        assert_eq!(
            merge_usage_row_cache(
                &db,
                "account-1",
                &[restored.clone()],
                "2026-07-02T16:18:00+08:00",
            )
            .expect("skip unchanged billing fields"),
            0
        );

        let cached = list_usage_row_cache(&db, "account-1", None, None, None)
            .expect("read restored billing fields");
        assert_eq!(cached[0].row.service_tier.as_deref(), Some("standard"));
        assert_eq!(cached[0].row.image_input_tokens, Some(84));
        assert_eq!(cached[0].row.image_input_cost, Some(0.4));
        assert_eq!(cached[0].row.long_context_billing_applied, Some(false));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_merge_skips_unchanged_rows_and_preserves_first_seen_at() {
        let db_path = temp_db_path("usage-merge-dedup");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let mut first = sample_usage_row();
        first.id = "usage-first".into();
        let mut second = sample_usage_row();
        second.id = "usage-second".into();
        second.created_at = "2026-07-02T17:00:00+08:00".into();
        let initial_seen = "2026-07-02T18:00:00+08:00";
        let later_seen = "2026-07-02T19:00:00+08:00";

        let inserted = merge_usage_row_cache(
            &db,
            "account-1",
            &[first.clone(), second.clone()],
            initial_seen,
        )
        .expect("insert usage rows");
        assert_eq!(inserted, 2);

        let unchanged = merge_usage_row_cache(
            &db,
            "account-1",
            &[first.clone(), second.clone()],
            later_seen,
        )
        .expect("merge unchanged rows");
        assert_eq!(unchanged, 0);

        second.output_tokens += 1;
        let changed = merge_usage_row_cache(
            &db,
            "account-1",
            &[first.clone(), second.clone()],
            later_seen,
        )
        .expect("merge one changed row");
        assert_eq!(changed, 1);
        let changed_rows = list_usage_rows_updated_at(&db, "account-1", later_seen)
            .expect("list this merge's changed rows");
        assert_eq!(changed_rows.len(), 1);
        assert_eq!(changed_rows[0].id, "usage-second");
        assert_eq!(changed_rows[0].output_tokens, second.output_tokens);

        let conn = db.connect().expect("open sqlite");
        let first_timestamps = conn
            .query_row(
                "SELECT updated_at, first_seen_at, last_seen_at
                 FROM account_usage_row_cache
                 WHERE account_id = ?1 AND usage_id = ?2",
                params!["account-1", "usage-first"],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .expect("read first timestamps");
        assert_eq!(first_timestamps.0, "2026-07-02 18:00:00");
        assert_eq!(first_timestamps.1, "2026-07-02 18:00:00");
        assert_eq!(first_timestamps.2, "2026-07-02 18:00:00");

        let second_timestamps = conn
            .query_row(
                "SELECT output_tokens, updated_at, first_seen_at, last_seen_at
                 FROM account_usage_row_cache
                 WHERE account_id = ?1 AND usage_id = ?2",
                params!["account-1", "usage-second"],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .expect("read second timestamps");
        assert_eq!(second_timestamps.0, second.output_tokens);
        assert_eq!(second_timestamps.1, "2026-07-02 19:00:00");
        assert_eq!(second_timestamps.2, "2026-07-02 18:00:00");
        assert_eq!(second_timestamps.3, "2026-07-02 19:00:00");

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_cache_last_updated_at_uses_dedicated_covering_index() {
        let db_path = temp_db_path("usage-cache-last-updated-index");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut latest_usage = sample_usage_row();
        latest_usage.id = "usage-latest".into();
        latest_usage.created_at = "2026-07-02T17:00:00+08:00".into();
        merge_usage_row_cache(
            &db,
            "account-1",
            &[latest_usage],
            "2026-07-02T18:00:00+08:00",
        )
        .expect("seed latest usage row");

        let mut older_usage = sample_usage_row();
        older_usage.id = "usage-older".into();
        older_usage.created_at = "2026-07-01T17:00:00+08:00".into();
        merge_usage_row_cache(
            &db,
            "account-1",
            &[older_usage],
            "2026-07-02T19:00:00+08:00",
        )
        .expect("seed later cache update on an older usage row");

        assert_eq!(
            load_usage_cache_last_updated_at(&db, "account-1")
                .expect("load cache update timestamp")
                .as_deref(),
            Some("2026-07-02 19:00:00")
        );

        let conn = db.connect().expect("open sqlite");
        let mut plan = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT MAX(updated_at)
                 FROM account_usage_row_cache
                 WHERE account_id = ?1",
            )
            .expect("prepare cache timestamp query plan");
        let details = plan
            .query_map(params!["account-1"], |row| row.get::<_, String>(3))
            .expect("read cache timestamp query plan")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect cache timestamp query plan");
        assert!(
            details.iter().any(|detail| {
                detail.contains("USING COVERING INDEX idx_account_usage_row_cache_account_updated")
            }),
            "unexpected query plan: {details:?}"
        );

        drop(plan);
        drop(conn);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_merge_skips_five_thousand_unchanged_rows() {
        let db_path = temp_db_path("usage-merge-5000-dedup");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let rows = (0..5_000)
            .map(|index| UsageRow {
                id: format!("usage-{index:04}"),
                ..sample_usage_row()
            })
            .collect::<Vec<_>>();

        let inserted = merge_usage_row_cache(&db, "account-1", &rows, "2026-07-02T18:00:00+08:00")
            .expect("insert 5000 usage rows");
        assert_eq!(inserted, 5_000);

        let unchanged = merge_usage_row_cache(&db, "account-1", &rows, "2026-07-02T19:00:00+08:00")
            .expect("merge 5000 unchanged rows");
        assert_eq!(unchanged, 0);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_cache_queries_preserve_filters_and_order() {
        let db_path = temp_db_path("usage-filter-order");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut first = sample_usage_row();
        first.id = "usage-1".into();
        first.api_key_id = Some(3641);
        first.created_at = "2026-07-02T10:00:00+08:00".into();

        let mut second = sample_usage_row();
        second.id = "usage-2".into();
        second.api_key_id = Some(3641);
        second.created_at = "2026-07-02T10:00:00+08:00".into();

        let mut third = sample_usage_row();
        third.id = "usage-3".into();
        third.api_key_id = Some(9999);
        third.created_at = "2026-07-01T10:00:00+08:00".into();

        merge_usage_row_cache(
            &db,
            "account-1",
            &[first.clone(), second.clone(), third.clone()],
            "2026-07-03T00:00:00+08:00",
        )
        .expect("merge usage rows");

        let filtered = list_usage_row_cache(
            &db,
            "account-1",
            Some(3641),
            Some("2026-07-02"),
            Some("2026-07-02"),
        )
        .expect("list filtered cache");
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].row.id, "usage-2");
        assert_eq!(filtered[1].row.id, "usage-1");

        let filter = UsageQueryFilter {
            api_key_id: Some(3641),
            start_date: Some("2026-07-02".into()),
            end_date: Some("2026-07-02".into()),
            ..UsageQueryFilter::default()
        };
        let page = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &filter,
            None,
            UsagePageDirection::Next,
            1,
        )
        .expect("page filtered cache");
        assert_eq!(page.items.len(), 1);
        assert!(page.has_more);
        assert_eq!(page.items[0].id, "usage-2");

        let next = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &filter,
            Some(&UsagePageAnchor {
                occurred_at: page.items[0].created_at.clone(),
                usage_id: page.items[0].id.clone(),
            }),
            UsagePageDirection::Next,
            1,
        )
        .expect("read next keyset page");
        assert_eq!(next.items.len(), 1);
        assert!(!next.has_more);
        assert_eq!(next.items[0].id, "usage-1");

        let previous = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &filter,
            Some(&UsagePageAnchor {
                occurred_at: next.items[0].created_at.clone(),
                usage_id: next.items[0].id.clone(),
            }),
            UsagePageDirection::Previous,
            1,
        )
        .expect("read previous keyset page");
        assert_eq!(previous.items.len(), 1);
        assert!(!previous.has_more);
        assert_eq!(previous.items[0].id, "usage-2");
    }

    #[test]
    fn usage_keyset_cursor_round_trip_is_stable_for_tied_timestamps() {
        let db_path = temp_db_path("usage-keyset-tied-timestamps");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let rows = [
            ("usage-03", "2026-08-11T10:00:00+08:00"),
            ("usage-02", "2026-08-11T10:00:00+08:00"),
            ("usage-01", "2026-08-11T10:00:00+08:00"),
            ("usage-00", "2026-08-11T09:59:59+08:00"),
        ]
        .into_iter()
        .map(|(id, created_at)| UsageRow {
            id: id.into(),
            created_at: created_at.into(),
            ..sample_usage_row()
        })
        .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &rows, "2026-08-11T10:01:00+08:00")
            .expect("seed tied usage rows");

        let first = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &UsageQueryFilter::default(),
            None,
            UsagePageDirection::Next,
            2,
        )
        .expect("read first keyset page");
        assert_eq!(
            first
                .items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["usage-03", "usage-02"]
        );
        assert!(first.has_more);

        let next = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &UsageQueryFilter::default(),
            Some(&UsagePageAnchor {
                occurred_at: first.items[1].created_at.clone(),
                usage_id: first.items[1].id.clone(),
            }),
            UsagePageDirection::Next,
            2,
        )
        .expect("read next keyset page");
        assert_eq!(
            next.items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["usage-01", "usage-00"]
        );
        assert!(!next.has_more);

        let previous = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &UsageQueryFilter::default(),
            Some(&UsagePageAnchor {
                occurred_at: next.items[0].created_at.clone(),
                usage_id: next.items[0].id.clone(),
            }),
            UsagePageDirection::Previous,
            2,
        )
        .expect("return to previous keyset page");
        assert_eq!(
            previous
                .items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["usage-03", "usage-02"]
        );
        assert!(!previous.has_more);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn advanced_usage_filters_preserve_false_null_and_fts_semantics() {
        let db_path = temp_db_path("usage-advanced-filters");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut selected = sample_usage_row();
        selected.id = "selected-usage".into();
        selected.request_id = Some("request-prefix-001".into());
        selected.api_key_name = Some("alpha%beta_key".into());
        selected.endpoint = Some("/v1/responses".into());
        selected.openai_ws_mode = Some(false);
        selected.first_token_ms = Some(0);
        selected.input_tokens = 150;
        selected.actual_cost = 1.5;
        selected.duration_ms = Some(900);
        selected.image_count = Some(2);
        selected.media_type = Some("image".into());
        selected.image_size_source = Some("explicit".into());
        selected.user_agent = Some("Mozilla/5.0 Codex Desktop".into());

        let mut null_boolean = selected.clone();
        null_boolean.id = "selected-null-boolean".into();
        null_boolean.openai_ws_mode = None;

        let mut null_numeric = selected.clone();
        null_numeric.id = "selected-null-numeric".into();
        null_numeric.first_token_ms = None;

        let mut escaped_prefix_noise = selected.clone();
        escaped_prefix_noise.id = "selected-escaped-prefix-noise".into();
        escaped_prefix_noise.api_key_name = Some("alphaXbeta_key".into());

        merge_usage_row_cache(
            &db,
            "account-1",
            &[selected, null_boolean, null_numeric, escaped_prefix_noise],
            "2026-08-11T10:01:00+08:00",
        )
        .expect("seed advanced filter rows");

        let filter = UsageQueryFilter {
            usage_id: Some(UsageTextFilter {
                value: "selected".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            request_id: Some(UsageTextFilter {
                value: "request-prefix".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            api_key_name: Some(UsageTextFilter {
                value: "alpha%".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            upstream_user_id: Some(2566),
            upstream_account_id: Some(8172),
            endpoint: Some(UsageTextFilter {
                value: "/v1/".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            group_id: Some(4),
            subscription_id: Some(3052),
            service_tier: Some("priority".into()),
            openai_ws_mode: Some(false),
            input_tokens: UsageI64Range {
                min: Some(100),
                max: Some(200),
            },
            actual_cost: UsageF64Range {
                min: Some(1.0),
                max: Some(2.0),
            },
            duration_ms: UsageI64Range {
                min: Some(800),
                max: Some(1_000),
            },
            first_token_ms: UsageI64Range {
                min: Some(0),
                max: Some(0),
            },
            image_count: UsageI64Range {
                min: Some(2),
                max: Some(2),
            },
            media_type: Some("image".into()),
            image_size_source: Some("explicit".into()),
            ip_address: Some(UsageTextFilter {
                value: "36.248.".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            user_agent_query: Some("codex*".into()),
            ..UsageQueryFilter::default()
        };
        let page = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &filter,
            None,
            UsagePageDirection::Next,
            20,
        )
        .expect("run advanced filter query");

        assert_eq!(
            page.items
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["selected-usage", "selected-null-boolean"]
        );
        assert!(!page.has_more);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn user_agent_fts_query_follows_unicode61_token_boundaries() {
        assert_eq!(
            normalize_user_agent_fts_query(Some("Mozilla/5.0 Codex_Desktop")),
            Some("\"Mozilla\"* AND \"5\"* AND \"0\"* AND \"Codex_Desktop\"*".into())
        );
    }

    #[test]
    fn usage_facets_use_full_scope_without_self_filter() {
        let db_path = temp_db_path("usage-facets-full-scope");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");
        let rows = [
            ("facet-a-1", "gpt-a", "openai"),
            ("facet-a-2", "gpt-a", "openai"),
            ("facet-b", "gpt-b", "openai"),
            ("facet-c", "gpt-c", "azure"),
        ]
        .into_iter()
        .map(|(id, model, platform)| UsageRow {
            id: id.into(),
            model: model.into(),
            platform: Some(platform.into()),
            created_at: "2026-08-11T10:00:00+08:00".into(),
            ..sample_usage_row()
        })
        .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &rows, "2026-08-11T10:01:00+08:00")
            .expect("seed facet rows");
        let filter = UsageQueryFilter {
            start_date: Some("2026-08-11".into()),
            end_date: Some("2026-08-11".into()),
            model: Some("gpt-a".into()),
            platform: Some("openai".into()),
            ..UsageQueryFilter::default()
        };

        let limited = list_usage_facets(&db, "account-1", &filter, UsageFacetField::Model, None, 1)
            .expect("list bounded model facets");
        assert_eq!(limited.items.len(), 1);
        assert_eq!(limited.items[0].value, "gpt-a");
        assert_eq!(limited.items[0].count, 2);
        assert!(limited.has_more);

        let searched = list_usage_facets(
            &db,
            "account-1",
            &filter,
            UsageFacetField::Model,
            Some("GPT-B"),
            10,
        )
        .expect("search model facets");
        assert_eq!(searched.items.len(), 1);
        assert_eq!(searched.items[0].value, "gpt-b");
        assert_eq!(searched.items[0].count, 1);
        assert!(!searched.has_more);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn filtered_usage_queries_match_sql_truth_and_clamp_page_size() {
        let db_path = temp_db_path("usage-filtered-aggregates");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut first = sample_usage_row();
        first.id = "selected-old-high-cost".into();
        first.created_at = "2026-07-01T08:00:00+08:00".into();
        first.model = "gpt-5.4".into();
        first.group_name = Some("CodeX Plus".into());
        first.subscription_name = Some("CodeX Plus Annual".into());
        first.platform = Some("OpenAI".into());
        first.reasoning_effort = Some("High".into());
        first.request_type = Some("default".into());
        first.stream = Some(true);
        first.billing_type = Some(1);
        first.billing_mode = Some("Token".into());
        first.input_tokens = 10;
        first.output_tokens = 5;
        first.cache_creation_tokens = Some(2);
        first.cache_read_tokens = Some(3);
        first.actual_cost = 100.0;
        first.total_cost = 101.0;
        first.first_token_ms = Some(100);
        first.duration_ms = Some(1000);

        let mut second = first.clone();
        second.id = "selected-latest-heavy".into();
        second.created_at = "2026-07-02T09:00:00+08:00".into();
        second.request_type = Some("stream".into());
        second.stream = Some(false);
        second.input_tokens = 20;
        second.output_tokens = 10;
        second.cache_creation_tokens = Some(1);
        second.cache_read_tokens = Some(4);
        second.actual_cost = 2.0;
        second.total_cost = 3.0;
        second.first_token_ms = Some(300);
        second.duration_ms = Some(3000);

        let mut third = first.clone();
        third.id = "selected-latest-small".into();
        third.created_at = "2026-07-02T10:00:00+08:00".into();
        third.request_type = None;
        third.stream = Some(true);
        third.input_tokens = 5;
        third.output_tokens = 5;
        third.cache_creation_tokens = None;
        third.cache_read_tokens = None;
        third.actual_cost = 1.0;
        third.total_cost = 1.0;
        third.first_token_ms = Some(200);
        third.duration_ms = None;

        let mut rows = vec![first, second, third];
        for index in 0..9 {
            let mut noise = sample_usage_row();
            noise.id = format!("noise-{index}");
            noise.created_at = format!("2026-07-02T{index:02}:30:00+08:00");
            noise.model = "other-model".into();
            noise.actual_cost = 1000.0;
            rows.push(noise);
        }
        merge_usage_row_cache(&db, "account-1", &rows, "2026-07-02T23:59:59+08:00")
            .expect("merge usage rows");

        let filter = UsageQueryFilter {
            api_key_id: Some(3641),
            start_date: Some("2026-07-01".into()),
            end_date: Some("2026-07-02".into()),
            model: Some("GPT-5.4".into()),
            group_name: Some("codex plus".into()),
            subscription_name: Some("CODEX PLUS ANNUAL".into()),
            platform: Some("openai".into()),
            reasoning_effort: Some("high".into()),
            request_type: Some("stream".into()),
            billing_type: Some(1),
            billing_mode: Some("token".into()),
            ..UsageQueryFilter::default()
        };

        let page = list_usage_rows_filtered_page(
            &db,
            "account-1",
            &filter,
            None,
            UsagePageDirection::Next,
            500,
        )
        .expect("list filtered page");
        assert_eq!(page.items.len(), 3);
        assert!(!page.has_more);
        assert_eq!(page.items[0].id, "selected-latest-small");

        let stats = summarize_usage_rows_filtered(&db, "account-1", &filter)
            .expect("summarize filtered usage");
        assert_eq!(stats.total_requests, 3);
        assert_eq!(stats.total_input_tokens, 35);
        assert_eq!(stats.total_output_tokens, 20);
        assert_eq!(stats.total_cache_creation_tokens, Some(3));
        assert_eq!(stats.total_cache_read_tokens, Some(7));
        assert_eq!(stats.total_tokens, 65);
        assert!((stats.total_actual_cost - 103.0).abs() < f64::EPSILON);
        assert!((stats.total_cost - 105.0).abs() < f64::EPSILON);
        assert!((stats.average_duration_ms - 2000.0).abs() < f64::EPSILON);

        let models =
            list_usage_models_filtered(&db, "account-1", &filter).expect("list filtered models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model, "gpt-5.4");
        assert_eq!(models[0].requests, 3);
        assert_eq!(models[0].total_tokens, 65);

        let trend =
            list_usage_trend_filtered(&db, "account-1", &filter).expect("list filtered trend");
        assert_eq!(trend.len(), 2);
        assert_eq!(trend[0].date, "2026-07-01");
        assert_eq!(trend[0].requests, 1);
        assert_eq!(trend[1].date, "2026-07-02");
        assert_eq!(trend[1].requests, 2);

        let insights = summarize_usage_insights_filtered(&db, "account-1", &filter)
            .expect("summarize filtered insights");
        assert_eq!(insights.total_requests, 3);
        assert_eq!(insights.groups.len(), 1);
        assert_eq!(insights.groups[0].name, "CodeX Plus");
        assert_eq!(insights.groups[0].requests, 3);
        assert_eq!(insights.groups[0].total_tokens, 65);
        assert_eq!(insights.endpoints.len(), 1);
        assert_eq!(insights.endpoints[0].requests, 3);

        let extremes = find_usage_extremes_filtered(&db, "account-1", &filter)
            .expect("find filtered extremes");
        assert_eq!(
            extremes.highest_actual_cost.expect("cost extreme").id,
            "selected-old-high-cost"
        );
        assert_eq!(
            extremes
                .longest_first_token
                .expect("first token extreme")
                .id,
            "selected-latest-heavy"
        );
        assert_eq!(
            extremes.highest_input_tokens.expect("input extreme").id,
            "selected-latest-heavy"
        );
        assert_eq!(
            extremes.highest_output_tokens.expect("output extreme").id,
            "selected-latest-heavy"
        );

        let analytics = get_usage_analytics_filtered(&db, "account-1", &filter)
            .expect("query bounded usage analytics");
        assert_eq!(analytics.version, 1);
        assert_eq!(analytics.matched_rows, 3);
        assert_eq!(analytics.totals.total_requests, 3);
        assert_eq!(analytics.totals.total_tokens, 65);
        assert_eq!(analytics.sample_rows.len(), 3);
        assert_eq!(analytics.sample_rows[0].id, "selected-latest-small");
        assert_eq!(analytics.extremes[0].id, "selected-old-high-cost");
        assert_eq!(analytics.models.len(), 1);
        assert_eq!(analytics.models[0].requests, 3);
        assert_eq!(analytics.models[0].total_tokens, 65);
        for dimension in [
            &analytics.models,
            &analytics.platforms,
            &analytics.endpoints,
            &analytics.api_keys,
            &analytics.groups,
            &analytics.subscriptions,
            &analytics.reasoning_efforts,
            &analytics.request_types,
            &analytics.reasoning_request_combinations,
            &analytics.user_agents,
        ] {
            assert_eq!(dimension.len(), 1);
            assert_eq!(dimension[0].requests, 3);
            assert_eq!(dimension[0].total_tokens, 65);
            assert!((dimension[0].actual_cost - 103.0).abs() < f64::EPSILON);
            assert!((dimension[0].total_cost - 105.0).abs() < f64::EPSILON);
        }
        assert_eq!(analytics.models[0].key, "gpt-5.4");
        assert_eq!(analytics.platforms[0].key, "openai");
        assert_eq!(analytics.endpoints[0].key, "/responses");
        assert_eq!(analytics.api_keys[0].key, "3641");
        assert_eq!(analytics.groups[0].key, "4");
        assert_eq!(analytics.subscriptions[0].key, "3052");
        assert_eq!(analytics.reasoning_efforts[0].key, "high");
        assert_eq!(analytics.request_types[0].label, "stream");
        assert_eq!(analytics.request_types[0].requests, 3);
        assert_eq!(
            analytics.reasoning_request_combinations[0].key,
            "stream x high"
        );
        assert_eq!(analytics.user_agents[0].key, "ua");
        assert_eq!(
            analytics
                .trend
                .iter()
                .map(|point| point.requests)
                .sum::<i64>(),
            3
        );
        assert_eq!(analytics.hourly_heatmap.len(), 3);
        assert_eq!(analytics.endpoint_flows.len(), 1);
        assert_eq!(analytics.endpoint_flows[0].requests, 3);
        assert_eq!(analytics.cost_breakdown.len(), 4);
        for (key, expected) in [
            ("input", 1.5),
            ("output", 3.0),
            ("cache_creation", 0.3),
            ("cache_read", 0.15),
        ] {
            let value = analytics
                .cost_breakdown
                .iter()
                .find(|point| point.key == key)
                .expect("cost breakdown bucket")
                .value;
            assert!((value - expected).abs() < f64::EPSILON);
        }
        assert_eq!(
            analytics
                .latency_percentiles
                .first_token
                .expect("first token percentiles")
                .p50,
            200.0
        );
        assert_eq!(
            analytics
                .latency_percentiles
                .duration
                .expect("duration percentiles")
                .p50,
            3000.0
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_analytics_top_n_other_preserves_totals() {
        let db_path = temp_db_path("usage-analytics-top-n");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut rows = (0..14)
            .map(|index| {
                let mut row = sample_usage_row();
                row.id = format!("analytics-model-{index:02}");
                row.created_at = format!("2026-07-02T{:02}:00:00+08:00", index);
                row.model = format!("model-{index:02}");
                row.input_tokens = index + 1;
                row.output_tokens = index + 2;
                row.actual_cost = (index + 1) as f64;
                row.total_cost = (index + 2) as f64;
                row
            })
            .collect::<Vec<_>>();
        let mut renamed_model = sample_usage_row();
        renamed_model.id = "analytics-model-renamed".into();
        renamed_model.created_at = "2026-07-02T20:00:00+08:00".into();
        renamed_model.model = "MODEL-00".into();
        renamed_model.input_tokens = 100;
        renamed_model.output_tokens = 50;
        renamed_model.actual_cost = 100.0;
        renamed_model.total_cost = 101.0;
        rows.push(renamed_model);
        merge_usage_row_cache(&db, "account-1", &rows, "2026-07-02T23:59:59+08:00")
            .expect("merge analytics rows");

        let analytics = get_usage_analytics_filtered(
            &db,
            "account-1",
            &UsageQueryFilter {
                start_date: Some("2026-07-02".into()),
                end_date: Some("2026-07-02".into()),
                ..UsageQueryFilter::default()
            },
        )
        .expect("query analytics top n");

        assert_eq!(analytics.matched_rows, 15);
        assert_eq!(analytics.models.len(), 13);
        let renamed = analytics
            .models
            .iter()
            .find(|point| point.key == "model-00")
            .expect("renamed model bucket");
        assert_eq!(renamed.requests, 2);
        let other = analytics
            .models
            .iter()
            .find(|point| point.is_other)
            .expect("other model bucket");
        assert_eq!(other.key, "__other__");
        assert_eq!(other.requests, 2);
        assert_eq!(
            analytics
                .models
                .iter()
                .map(|point| point.requests)
                .sum::<i64>(),
            analytics.matched_rows
        );
        assert_eq!(
            analytics
                .models
                .iter()
                .map(|point| point.total_tokens)
                .sum::<i64>(),
            analytics.totals.total_tokens
        );
        assert!(
            (analytics
                .models
                .iter()
                .map(|point| point.actual_cost)
                .sum::<f64>()
                - analytics.totals.total_actual_cost)
                .abs()
                < f64::EPSILON
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_analytics_flows_merge_stable_keys_before_ranking() {
        let db_path = temp_db_path("usage-analytics-flow-stable-keys");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let case_variant = |value: &str, mask: usize| {
            let mut letter_index = 0;
            value
                .chars()
                .map(|character| {
                    if !character.is_ascii_alphabetic() {
                        return character;
                    }
                    let uppercase = mask & (1 << letter_index) != 0;
                    letter_index += 1;
                    if uppercase {
                        character.to_ascii_uppercase()
                    } else {
                        character.to_ascii_lowercase()
                    }
                })
                .collect::<String>()
        };
        let rows = (0..15)
            .map(|index| {
                let mut row = sample_usage_row();
                row.id = format!("analytics-flow-{index:02}");
                row.created_at = format!("2026-07-02T{index:02}:00:00+08:00");
                row.endpoint = Some(case_variant("/responses", index));
                row.upstream_endpoint = Some(case_variant("/v1/responses", index));
                row
            })
            .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &rows, "2026-07-02T23:59:59+08:00")
            .expect("merge analytics flow rows");

        let analytics = get_usage_analytics_filtered(
            &db,
            "account-1",
            &UsageQueryFilter {
                start_date: Some("2026-07-02".into()),
                end_date: Some("2026-07-02".into()),
                ..UsageQueryFilter::default()
            },
        )
        .expect("query analytics flows");

        assert_eq!(analytics.matched_rows, 15);
        assert_eq!(analytics.endpoint_flows.len(), 1);
        assert_eq!(
            analytics.endpoint_flows[0].key,
            "/responses -> /v1/responses"
        );
        assert!(!analytics.endpoint_flows[0].is_other);
        assert_eq!(analytics.endpoint_flows[0].requests, 15);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_analytics_request_type_default_filter_matches_standard_bucket() {
        let db_path = temp_db_path("usage-analytics-request-type-default");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut standard = sample_usage_row();
        standard.id = "standard-request".into();
        standard.created_at = "2026-07-02T08:00:00+08:00".into();
        standard.request_type = Some("default".into());
        standard.stream = Some(false);
        let mut stream = standard.clone();
        stream.id = "stream-request".into();
        stream.created_at = "2026-07-02T09:00:00+08:00".into();
        stream.stream = Some(true);
        merge_usage_row_cache(
            &db,
            "account-1",
            &[standard, stream],
            "2026-07-02T23:59:59+08:00",
        )
        .expect("merge request type rows");

        let analytics = get_usage_analytics_filtered(
            &db,
            "account-1",
            &UsageQueryFilter {
                start_date: Some("2026-07-02".into()),
                end_date: Some("2026-07-02".into()),
                request_type: Some("default".into()),
                ..UsageQueryFilter::default()
            },
        )
        .expect("query default request type");

        assert_eq!(analytics.matched_rows, 1);
        assert_eq!(analytics.request_types.len(), 1);
        assert_eq!(analytics.request_types[0].key, "standard");
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_rows_by_key_are_grouped_in_sql_with_inclusive_date_bounds() {
        let db_path = temp_db_path("usage-by-key-summary");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut first = sample_usage_row();
        first.id = "usage-key-3641-first".into();
        first.api_key_id = Some(3641);
        first.created_at = "2026-07-02T10:00:00+08:00".into();
        first.input_tokens = 10;
        first.output_tokens = 20;
        first.cache_creation_tokens = Some(2);
        first.cache_read_tokens = Some(3);
        first.actual_cost = 1.25;

        let mut second = sample_usage_row();
        second.id = "usage-key-3641-second".into();
        second.api_key_id = Some(3641);
        second.created_at = "2026-07-03T23:59:59+08:00".into();
        second.input_tokens = 4;
        second.output_tokens = 6;
        second.cache_creation_tokens = None;
        second.cache_read_tokens = Some(5);
        second.actual_cost = 0.5;

        let mut other_key = sample_usage_row();
        other_key.id = "usage-key-9999".into();
        other_key.api_key_id = Some(9999);
        other_key.created_at = "2026-07-02T12:00:00+08:00".into();
        other_key.input_tokens = 100;
        other_key.output_tokens = 200;
        other_key.cache_creation_tokens = None;
        other_key.cache_read_tokens = None;
        other_key.actual_cost = 2.5;

        let mut without_key = sample_usage_row();
        without_key.id = "usage-without-key".into();
        without_key.api_key_id = None;
        without_key.created_at = "2026-07-02T13:00:00+08:00".into();

        let mut outside_range = sample_usage_row();
        outside_range.id = "usage-key-outside-range".into();
        outside_range.api_key_id = Some(7777);
        outside_range.created_at = "2026-07-04T00:00:00+08:00".into();

        merge_usage_row_cache(
            &db,
            "account-1",
            &[first, second, other_key, without_key, outside_range],
            "2026-07-04T00:01:00+08:00",
        )
        .expect("merge usage rows");

        let stats = summarize_usage_rows_by_key(&db, "account-1", "2026-07-02", "2026-07-03")
            .expect("summarize usage by key");

        assert_eq!(stats.len(), 2);
        let selected = stats.get(&3641).expect("selected key stats");
        assert_eq!(selected.requests, 2);
        assert_eq!(selected.input_tokens, 14);
        assert_eq!(selected.output_tokens, 26);
        assert_eq!(selected.total_tokens, 50);
        assert!((selected.actual_cost - 1.75).abs() < f64::EPSILON);

        let other = stats.get(&9999).expect("other key stats");
        assert_eq!(other.requests, 1);
        assert_eq!(other.input_tokens, 100);
        assert_eq!(other.output_tokens, 200);
        assert_eq!(other.total_tokens, 300);
        assert!((other.actual_cost - 2.5).abs() < f64::EPSILON);
        assert!(!stats.contains_key(&7777));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn key_daily_usage_points_aggregate_one_key_by_day() {
        let db_path = temp_db_path("key-daily-usage");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut first = sample_usage_row();
        first.id = "usage-1".into();
        first.api_key_id = Some(3641);
        first.created_at = "2026-07-02T10:00:00+08:00".into();
        first.input_tokens = 10;
        first.output_tokens = 20;
        first.cache_creation_tokens = Some(2);
        first.cache_read_tokens = Some(3);
        first.actual_cost = 1.25;
        first.total_cost = 1.5;

        let mut second = sample_usage_row();
        second.id = "usage-2".into();
        second.api_key_id = Some(3641);
        second.created_at = "2026-07-02T11:00:00+08:00".into();
        second.input_tokens = 4;
        second.output_tokens = 6;
        second.cache_creation_tokens = None;
        second.cache_read_tokens = Some(5);
        second.actual_cost = 0.5;
        second.total_cost = 0.7;

        let mut third = sample_usage_row();
        third.id = "usage-3".into();
        third.api_key_id = Some(9999);
        third.created_at = "2026-07-02T12:00:00+08:00".into();
        third.input_tokens = 1000;
        third.output_tokens = 1000;

        let mut fourth = sample_usage_row();
        fourth.id = "usage-4".into();
        fourth.api_key_id = Some(3641);
        fourth.created_at = "2026-07-03T09:00:00+08:00".into();
        fourth.input_tokens = 7;
        fourth.output_tokens = 8;
        fourth.cache_creation_tokens = Some(1);
        fourth.cache_read_tokens = Some(0);
        fourth.actual_cost = 0.25;
        fourth.total_cost = 0.3;

        merge_usage_row_cache(
            &db,
            "account-1",
            &[first, second, third, fourth],
            "2026-07-03T12:00:00+08:00",
        )
        .expect("merge usage rows");

        let daily = list_key_daily_usage_points(&db, "account-1", 3641, "2026-07-02", "2026-07-03")
            .expect("list key daily usage");

        assert_eq!(daily.len(), 2);
        assert_eq!(daily[0].date, "2026-07-02");
        assert_eq!(daily[0].requests, 2);
        assert_eq!(daily[0].input_tokens, 14);
        assert_eq!(daily[0].output_tokens, 26);
        assert_eq!(daily[0].cache_write_tokens, Some(2));
        assert_eq!(daily[0].cache_read_tokens, Some(8));
        assert_eq!(daily[0].total_tokens, Some(50));
        assert!((daily[0].actual_cost.unwrap_or_default() - 1.75).abs() < f64::EPSILON);
        assert!((daily[0].total_cost.unwrap_or_default() - 2.2).abs() < f64::EPSILON);

        assert_eq!(daily[1].date, "2026-07-03");
        assert_eq!(daily[1].requests, 1);
        assert_eq!(daily[1].total_tokens, Some(16));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_rollup_tracks_insert_update_dimension_move_and_delete() {
        let db_path = temp_db_path("usage-rollup-mutations");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let mut original = sample_usage_row();
        original.created_at = "2026-07-02T16:14:30+08:00".into();
        merge_usage_row_cache(
            &db,
            "account-1",
            &[original.clone()],
            "2026-07-02T16:15:00+08:00",
        )
        .expect("insert original usage row");
        assert_rollup_matches_detail(&db, "account-1");

        let mut moved = original;
        moved.model = "claude-5".into();
        moved.platform = Some("anthropic".into());
        moved.input_tokens = 400;
        moved.output_tokens = 50;
        moved.cache_creation_tokens = None;
        moved.cache_read_tokens = Some(25);
        moved.total_cost = 3.0;
        moved.actual_cost = 2.25;
        moved.duration_ms = None;
        merge_usage_row_cache(&db, "account-1", &[moved], "2026-07-02T16:16:00+08:00")
            .expect("update usage row and move rollup dimensions");
        assert_rollup_matches_detail(&db, "account-1");

        prune_usage_row_cache_before(&db, "account-1", "2026-07-03")
            .expect("delete detailed usage row");
        assert_rollup_matches_detail(&db, "account-1");

        let conn = db.connect().expect("open sqlite");
        let rollup_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM account_usage_daily_rollup WHERE account_id = ?1",
                ["account-1"],
                |row| row.get(0),
            )
            .expect("count rollup rows");
        assert_eq!(rollup_count, 0);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn usage_rollup_matches_each_detail_dimension_bucket() {
        let db_path = temp_db_path("usage-rollup-buckets");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let rows = (0..12)
            .map(|index| {
                let mut row = sample_usage_row();
                row.id = format!("usage-rollup-bucket-{index}");
                row.created_at = format!("2026-07-{:02}T{:02}:00:00+08:00", 2 + index % 3, index,);
                row.model = match index % 3 {
                    0 => "gpt-4.1".into(),
                    1 => "claude-5".into(),
                    _ => String::new(),
                };
                row.platform = match index % 3 {
                    0 => Some("openai".into()),
                    1 => Some("anthropic".into()),
                    _ => None,
                };
                row.input_tokens = 10 + index as i64;
                row.output_tokens = 20 + index as i64;
                row.cache_creation_tokens = (index % 2 == 0).then_some(index as i64);
                row.cache_read_tokens = (index % 4 != 0).then_some((index * 2) as i64);
                row.total_cost = index as f64 + 0.5;
                row.actual_cost = index as f64 + 0.25;
                row.duration_ms = (index % 4 != 0).then_some(100 + index as i64);
                row
            })
            .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &rows, "2026-07-05T12:00:00+08:00")
            .expect("insert multiple rollup buckets");
        assert_rollup_matches_detail(&db, "account-1");

        let mut moved = rows[7].clone();
        moved.model = "gpt-5".into();
        moved.platform = Some("openai".into());
        moved.input_tokens = 777;
        moved.cache_creation_tokens = None;
        moved.duration_ms = None;
        merge_usage_row_cache(&db, "account-1", &[moved], "2026-07-05T12:01:00+08:00")
            .expect("move a rollup bucket");
        assert_rollup_matches_detail(&db, "account-1");

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn filtered_usage_rollup_matches_detail_for_supported_dimensions() {
        let db_path = temp_db_path("usage-rollup-filter-equivalence");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let rows = [
            ("rollup-filter-a", "2026-08-09T08:00:00+08:00", "gpt-5.4", "openai", Some(100)),
            ("rollup-filter-b", "2026-08-10T09:00:00+08:00", "gpt-5.4-mini", "openai", None),
            ("rollup-filter-c", "2026-08-10T10:00:00+08:00", "claude-sonnet", "anthropic", Some(300)),
        ]
        .into_iter()
        .map(|(id, created_at, model, platform, duration_ms)| {
            let mut row = sample_usage_row();
            row.id = id.into();
            row.created_at = created_at.into();
            row.model = model.into();
            row.platform = Some(platform.into());
            row.duration_ms = duration_ms;
            row
        })
        .collect::<Vec<_>>();
        merge_usage_row_cache(&db, "account-1", &rows, "2026-08-10T10:01:00+08:00")
            .expect("seed filtered rollup rows");

        let filters = [
            UsageQueryFilter::default(),
            UsageQueryFilter {
                start_date: Some("2026-08-10".into()),
                end_date: Some("2026-08-10".into()),
                ..UsageQueryFilter::default()
            },
            UsageQueryFilter {
                model: Some(UsageTextFilter {
                    value: "gpt-5.4".into(),
                    mode: UsageTextMatchMode::Prefix,
                }),
                platform: Some(UsageTextFilter::from("openai")),
                ..UsageQueryFilter::default()
            },
        ];

        for filter in filters {
            let detail_stats = summarize_usage_rows_filtered(&db, "account-1", &filter)
                .expect("summarize detail rows");
            let rollup_stats = summarize_usage_rollup_filtered(&db, "account-1", &filter)
                .expect("summarize rollup rows");
            assert_eq!(detail_stats.total_requests, rollup_stats.total_requests);
            assert_eq!(detail_stats.total_input_tokens, rollup_stats.total_input_tokens);
            assert_eq!(detail_stats.total_output_tokens, rollup_stats.total_output_tokens);
            assert_eq!(detail_stats.total_cache_tokens, rollup_stats.total_cache_tokens);
            assert_eq!(detail_stats.total_tokens, rollup_stats.total_tokens);
            assert!((detail_stats.total_cost - rollup_stats.total_cost).abs() < 1e-9);
            assert!((detail_stats.total_actual_cost - rollup_stats.total_actual_cost).abs() < 1e-9);
            assert!((detail_stats.average_duration_ms - rollup_stats.average_duration_ms).abs() < 1e-9);

            let detail_models = list_usage_models_filtered(&db, "account-1", &filter)
                .expect("list detail models");
            let rollup_models = list_usage_models_rollup_filtered(&db, "account-1", &filter)
                .expect("list rollup models");
            assert_eq!(
                serde_json::to_value(detail_models).expect("serialize detail models"),
                serde_json::to_value(rollup_models).expect("serialize rollup models")
            );

            let detail_trend = list_usage_trend_filtered(&db, "account-1", &filter)
                .expect("list detail trend");
            let rollup_trend = list_usage_trend_rollup_filtered(&db, "account-1", &filter)
                .expect("list rollup trend");
            assert_eq!(
                serde_json::to_value(detail_trend).expect("serialize detail trend"),
                serde_json::to_value(rollup_trend).expect("serialize rollup trend")
            );
        }

        let _ = std::fs::remove_file(db_path);
    }

    fn assert_rollup_matches_detail(db: &Database, account_id: &str) {
        let conn = db.connect().expect("open sqlite");
        let detail = read_rollup_buckets(
            &conn,
            "SELECT
                substr(occurred_at, 1, 10),
                COALESCE(NULLIF(model, ''), 'unknown'),
                COALESCE(NULLIF(platform, ''), 'unknown'),
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0),
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0),
                COALESCE(SUM(total_cost), 0),
                COALESCE(SUM(actual_cost), 0),
                COALESCE(SUM(COALESCE(duration_ms, 0)), 0),
                COALESCE(SUM(CASE WHEN duration_ms IS NULL THEN 0 ELSE 1 END), 0)
             FROM account_usage_row_cache
             WHERE account_id = ?1
             GROUP BY 1, 2, 3
             ORDER BY 1, 2, 3",
            account_id,
        );
        let rollup = read_rollup_buckets(
            &conn,
            "SELECT
                usage_date, model, platform,
                requests, input_tokens, output_tokens,
                cache_creation_tokens, cache_read_tokens,
                total_cost, actual_cost, duration_ms_sum, duration_ms_count
             FROM account_usage_daily_rollup
             WHERE account_id = ?1
             ORDER BY usage_date, model, platform",
            account_id,
        );

        assert_eq!(detail.len(), rollup.len(), "rollup bucket count differs");
        for (detail, rollup) in detail.iter().zip(&rollup) {
            assert_eq!(detail.0, rollup.0, "usage_date differs");
            assert_eq!(detail.1, rollup.1, "model differs");
            assert_eq!(detail.2, rollup.2, "platform differs");
            assert_eq!(detail.3, rollup.3, "requests differ");
            assert_eq!(detail.4, rollup.4, "input tokens differ");
            assert_eq!(detail.5, rollup.5, "output tokens differ");
            assert_eq!(detail.6, rollup.6, "cache creation tokens differ");
            assert_eq!(detail.7, rollup.7, "cache read tokens differ");
            assert!((detail.8 - rollup.8).abs() < 1e-9, "total cost differs");
            assert!((detail.9 - rollup.9).abs() < 1e-9, "actual cost differs");
            assert_eq!(detail.10, rollup.10, "duration sum differs");
            assert_eq!(detail.11, rollup.11, "duration count differs");
        }
    }

    type RollupBucket = (
        String,
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        f64,
        f64,
        i64,
        i64,
    );

    fn read_rollup_buckets(conn: &Connection, sql: &str, account_id: &str) -> Vec<RollupBucket> {
        conn.prepare(sql)
            .expect("prepare rollup bucket query")
            .query_map([account_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                ))
            })
            .expect("query rollup buckets")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect rollup buckets")
    }

    #[test]
    fn overview_usage_summary_scans_cache_once_and_keeps_metrics_consistent() {
        let db_path = temp_db_path("overview-summary");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let today = shanghai_today();
        let yesterday = today - Days::new(1);
        let trend_start = today - Days::new(6);

        let mut today_openai = sample_usage_row();
        today_openai.id = "today-openai".into();
        today_openai.created_at = format!("{today}T09:00:00+08:00");
        today_openai.platform = Some("openai".into());
        today_openai.model = "gpt-5.4".into();
        today_openai.input_tokens = 120;
        today_openai.output_tokens = 30;
        today_openai.cache_creation_tokens = Some(10);
        today_openai.cache_read_tokens = Some(40);
        today_openai.actual_cost = 1.25;
        today_openai.total_cost = 1.5;
        today_openai.duration_ms = Some(500);

        let mut today_anthropic = sample_usage_row();
        today_anthropic.id = "today-anthropic".into();
        today_anthropic.created_at = format!("{today}T10:00:00+08:00");
        today_anthropic.platform = Some("anthropic".into());
        today_anthropic.model = "claude-4".into();
        today_anthropic.input_tokens = 80;
        today_anthropic.output_tokens = 20;
        today_anthropic.cache_creation_tokens = Some(0);
        today_anthropic.cache_read_tokens = Some(0);
        today_anthropic.actual_cost = 0.75;
        today_anthropic.total_cost = 0.9;
        today_anthropic.duration_ms = Some(1500);

        let mut yesterday_openai = sample_usage_row();
        yesterday_openai.id = "yesterday-openai".into();
        yesterday_openai.created_at = format!("{yesterday}T08:00:00+08:00");
        yesterday_openai.platform = Some("openai".into());
        yesterday_openai.model = "gpt-5.4".into();
        yesterday_openai.input_tokens = 50;
        yesterday_openai.output_tokens = 10;
        yesterday_openai.cache_creation_tokens = Some(5);
        yesterday_openai.cache_read_tokens = Some(15);
        yesterday_openai.actual_cost = 0.5;
        yesterday_openai.total_cost = 0.65;
        yesterday_openai.duration_ms = Some(1000);

        merge_usage_row_cache(
            &db,
            "account-1",
            &[
                today_openai.clone(),
                today_anthropic.clone(),
                yesterday_openai.clone(),
            ],
            &format!("{today}T12:00:00+08:00"),
        )
        .expect("merge usage rows");

        let summary = summarize_overview_usage_cache(
            &db,
            "account-1",
            Some(&trend_start.to_string()),
            Some(&today.to_string()),
        )
        .expect("summarize overview usage cache");

        assert_eq!(summary.stats.total_requests, 3);
        assert_eq!(summary.stats.today_requests, 2);
        assert!((summary.stats.total_actual_cost - 2.5).abs() < f64::EPSILON);
        assert!((summary.stats.today_actual_cost - 2.0).abs() < f64::EPSILON);
        assert_eq!(summary.stats.total_tokens, 380);
        assert_eq!(summary.stats.today_tokens, 300);
        assert_eq!(summary.stats.today_input_tokens, 200);
        assert_eq!(summary.stats.today_output_tokens, 50);
        assert!((summary.stats.average_duration_ms - 1000.0).abs() < f64::EPSILON);

        assert_eq!(summary.stats.by_platform.len(), 2);
        assert_eq!(summary.stats.by_platform[0].platform, "openai");
        assert_eq!(summary.stats.by_platform[0].total_requests, 2);
        assert_eq!(summary.stats.by_platform[0].total_tokens, 280);
        assert!((summary.stats.by_platform[0].today_actual_cost - 1.25).abs() < f64::EPSILON);
        assert_eq!(summary.stats.by_platform[1].platform, "anthropic");

        assert_eq!(summary.stats.by_model.len(), 2);
        assert_eq!(summary.stats.by_model[0].model, "gpt-5.4");
        assert_eq!(summary.stats.by_model[0].requests, 2);
        assert_eq!(summary.stats.by_model[0].total_tokens, 280);
        assert!((summary.stats.by_model[0].actual_cost - 1.75).abs() < f64::EPSILON);

        assert_eq!(summary.trend.len(), 2);
        assert_eq!(summary.trend[0].bucket, yesterday.to_string());
        assert_eq!(summary.trend[0].requests, 1);
        assert_eq!(summary.trend[1].bucket, today.to_string());
        assert_eq!(summary.trend[1].requests, 2);
        assert_eq!(summary.trend[1].total_tokens, 300);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn overview_usage_summary_uses_all_rows_instead_of_recent_sample() {
        let db_path = temp_db_path("overview-summary-latest-ten");
        let db = Database::new(db_path.clone());
        seed_account(&db, "account-1");

        let today = shanghai_today();
        let mut rows = Vec::new();
        for hour in 0..12 {
            let mut row = sample_usage_row();
            row.id = format!("usage-{hour:02}");
            row.created_at = format!("{today}T{hour:02}:00:00+08:00");
            row.platform = Some("openai".into());
            row.model = "gpt-5.4".into();
            row.input_tokens = 10;
            row.output_tokens = 5;
            row.cache_creation_tokens = Some(0);
            row.cache_read_tokens = Some(0);
            row.actual_cost = if hour < 2 { 100.0 } else { 1.0 };
            row.total_cost = row.actual_cost;
            row.duration_ms = Some(1000);
            rows.push(row);
        }

        merge_usage_row_cache(&db, "account-1", &rows, &format!("{today}T23:59:59+08:00"))
            .expect("merge usage rows");

        let summary = summarize_overview_usage_cache(
            &db,
            "account-1",
            Some(&today.to_string()),
            Some(&today.to_string()),
        )
        .expect("summarize overview usage cache");

        assert_eq!(summary.stats.total_requests, 12);
        assert_eq!(summary.stats.today_requests, 12);
        assert!((summary.stats.total_actual_cost - 210.0).abs() < f64::EPSILON);
        assert!((summary.stats.total_cost - 210.0).abs() < f64::EPSILON);
        assert_eq!(summary.stats.total_tokens, 180);
        assert_eq!(summary.stats.today_tokens, 180);
        assert_eq!(summary.stats.by_model[0].requests, 12);
        assert_eq!(summary.trend.len(), 1);
        assert_eq!(summary.trend[0].requests, 12);

        let _ = std::fs::remove_file(db_path);
    }

    fn table_columns(conn: &Connection, table_name: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table_name})"))
            .expect("prepare table_info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(|value| value.ok())
            .collect()
    }

    fn temp_db_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("api-token-{label}-{}.db", Uuid::new_v4()))
    }

    fn seed_account(db: &Database, account_id: &str) {
        let conn = db.connect().expect("open sqlite");
        conn.execute(
            "INSERT INTO sites (id, name, base_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "site-1",
                "Test Site",
                "http://127.0.0.1:16661",
                "2026-07-02T16:00:00+08:00",
                "2026-07-02T16:00:00+08:00"
            ],
        )
        .expect("insert site");
        conn.execute(
            "INSERT INTO accounts (id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                account_id,
                "site-1",
                "Test Account",
                "user@example.com",
                0.0,
                Option::<String>::None,
                "2026-07-02T16:00:00+08:00",
                "2026-07-02T16:00:00+08:00"
            ],
        )
        .expect("insert account");
    }

    fn sample_usage_row() -> UsageRow {
        UsageRow {
            id: "usage-1".into(),
            upstream_user_id: Some(2566),
            api_key_id: Some(3641),
            upstream_account_id: Some(8172),
            request_id: Some("client:38ee5a3b-8bae-4d6c-9ee0-917c0a21abb0".into()),
            created_at: "2026-07-02T16:14:30+08:00".into(),
            model: "gpt-4.1".into(),
            reasoning_effort: Some("high".into()),
            endpoint: Some("/responses".into()),
            upstream_endpoint: Some("/v1/responses".into()),
            group_id: Some(4),
            subscription_id: Some(3052),
            actual_cost: 1.25,
            total_cost: 1.5,
            input_tokens: 100,
            output_tokens: 200,
            input_cost: Some(0.5),
            output_cost: Some(1.0),
            cache_creation_tokens: Some(3),
            cache_read_tokens: Some(4),
            cache_creation_5m_tokens: Some(1),
            cache_creation_1h_tokens: Some(2),
            cache_creation_cost: Some(0.1),
            cache_read_cost: Some(0.05),
            total_tokens: 307,
            first_token_ms: Some(123),
            duration_ms: Some(456),
            billing_mode: Some("token".into()),
            request_type: Some("stream".into()),
            stream: Some(true),
            openai_ws_mode: Some(false),
            billing_type: Some(1),
            service_tier: Some("priority".into()),
            long_context_billing_applied: Some(true),
            image_count: Some(2),
            image_input_tokens: Some(42),
            image_size: Some("1024x1024".into()),
            image_input_size: Some("auto".into()),
            image_output_size: Some("1024x1024".into()),
            image_output_tokens: Some(99),
            image_input_cost: Some(0.2),
            image_output_cost: Some(0.9),
            image_size_source: Some("explicit".into()),
            image_size_breakdown: Some("{\"1024x1024\":2}".into()),
            media_type: Some("image".into()),
            rate_multiplier: Some(1.2),
            user_agent: Some("UA".into()),
            ip_address: Some("36.248.234.88".into()),
            cache_ttl_overridden: Some(false),
            api_key_name: Some("codex".into()),
            platform: Some("openai".into()),
            subscription_name: Some("Plan A".into()),
            group_name: Some("Group A".into()),
            subscription_type: Some("subscription".into()),
        }
    }
}
