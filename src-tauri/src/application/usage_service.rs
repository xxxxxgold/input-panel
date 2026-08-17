use std::collections::BTreeMap;

use anyhow::{anyhow, Context, Result};
use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::contracts::{
    ApiKeyUsageStatsRecord, DailyUsagePoint, DashboardModelsPayload, KeyUsageSummaryPayload,
    OverviewDashboardStatsPayload, SubscriptionKeyUsageItem, SubscriptionKeyUsagePayload,
    UsageAnalyticsPayload, UsageCursorDirection, UsageCursorPage, UsageExtremesPayload,
    UsageF64Range, UsageFacetPage, UsageFacetRequest, UsageFilter, UsageI64Range,
    UsageInsightsPayload, UsageListRequest, UsageRow, UsageStatsRecord, UsageTextFilter,
    UsageTrendPayload,
};
use crate::infrastructure::datetime::{
    normalize_storage_timestamp, shanghai_today, storage_timestamp_date,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::normalizers::{
    normalize_daily_usage_rows, normalize_items, normalize_key_usage_summary,
    normalize_overview_dashboard_stats, normalize_usage_row,
};

use super::{
    account_service, data_center_service,
    resource_coordinator::LiveResourceKind,
    site_failover_service,
    upstream_service::{self, UpstreamRequestPolicy},
    AppContext,
};

const DIRECT_KEY_USAGE_PAGE_SIZE: i64 = 500;
const DIRECT_KEY_USAGE_MAX_PAGES: i64 = 10;
const MAX_USAGE_PAGE_SIZE: i64 = 100;
const USAGE_CURSOR_VERSION: u8 = 1;
const USAGE_CURSOR_SORT: &str = "occurred_at_desc_usage_id_desc";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageCursorPayload {
    version: u8,
    account_id: String,
    occurred_at: String,
    usage_id: String,
    direction: UsageCursorDirection,
    page_size: i64,
    filter_signature: String,
    sort: String,
}

pub async fn list_usage_records(
    ctx: &AppContext,
    account_id: &str,
    request: UsageListRequest,
) -> Result<UsageCursorPage<UsageRow>> {
    if !(1..=MAX_USAGE_PAGE_SIZE).contains(&request.page_size) {
        return Err(usage_query_error(
            "USAGE_INVALID_FILTER",
            "page_size must be between 1 and 100",
        ));
    }
    let filter = canonicalize_usage_filter(request.filter)?;
    let filter_signature = usage_filter_signature(&filter)?;
    let anchor = request
        .cursor
        .as_deref()
        .map(|cursor| {
            decode_usage_cursor(
                cursor,
                account_id,
                request.direction,
                request.page_size,
                &filter_signature,
            )
        })
        .transpose()?;
    let repository_direction = match request.direction {
        UsageCursorDirection::Next => repositories::UsagePageDirection::Next,
        UsageCursorDirection::Previous => repositories::UsagePageDirection::Previous,
    };
    let page = repositories::list_usage_rows_filtered_page(
        &ctx.db,
        account_id,
        &filter,
        anchor.as_ref(),
        repository_direction,
        request.page_size,
    )?;
    let traversed_from_another_page = request.cursor.is_some();
    let (has_next, has_previous) = match request.direction {
        UsageCursorDirection::Next => (page.has_more, traversed_from_another_page),
        UsageCursorDirection::Previous => (
            traversed_from_another_page && !page.items.is_empty(),
            page.has_more,
        ),
    };
    let next_cursor = if has_next {
        page.items
            .last()
            .map(|row| {
                encode_usage_cursor(
                    account_id,
                    row,
                    UsageCursorDirection::Next,
                    request.page_size,
                    &filter_signature,
                )
            })
            .transpose()?
    } else {
        None
    };
    let previous_cursor = if has_previous {
        page.items
            .first()
            .map(|row| {
                encode_usage_cursor(
                    account_id,
                    row,
                    UsageCursorDirection::Previous,
                    request.page_size,
                    &filter_signature,
                )
            })
            .transpose()?
    } else {
        None
    };

    Ok(UsageCursorPage {
        items: page.items,
        page_size: request.page_size,
        next_cursor,
        previous_cursor,
        has_next,
        has_previous,
        total: None,
    })
}

/// 返回完整筛选范围内的有界筛选候选。
pub async fn list_usage_facets(
    ctx: &AppContext,
    account_id: &str,
    request: UsageFacetRequest,
) -> Result<UsageFacetPage> {
    if !(1..=MAX_USAGE_PAGE_SIZE).contains(&request.limit) {
        return Err(usage_query_error(
            "USAGE_INVALID_FILTER",
            "facet limit must be between 1 and 100",
        ));
    }
    let filter = canonicalize_usage_filter(request.filter)?;
    repositories::list_usage_facets(
        &ctx.db,
        account_id,
        &filter,
        request.field,
        request.search.as_deref(),
        request.limit,
    )
}

pub async fn get_usage_stats(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<UsageStatsRecord> {
    let filter = canonicalize_usage_filter(filter)?;
    if usage_filter_can_use_daily_rollup(&filter) {
        repositories::summarize_usage_rollup_filtered(&ctx.db, account_id, &filter)
    } else {
        repositories::summarize_usage_rows_filtered(&ctx.db, account_id, &filter)
    }
}

/// 返回分析页所需的单次、有界 SQLite 聚合快照。
pub async fn get_usage_analytics(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<UsageAnalyticsPayload> {
    let filter = canonicalize_usage_filter(filter)?;
    repositories::get_usage_analytics_filtered(&ctx.db, account_id, &filter)
}

pub async fn get_overview_dashboard_stats(
    ctx: &AppContext,
    account_id: &str,
    force: bool,
) -> Result<OverviewDashboardStatsPayload> {
    ctx.live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::DashboardStats,
            force,
            || async {
                let raw = upstream_service::account_upstream_request(
                    ctx,
                    account_id,
                    "/api/v1/usage/dashboard/stats?timezone=Asia%2FShanghai",
                    "GET",
                    None,
                    UpstreamRequestPolicy::ReadOnly,
                )
                .await?;
                Ok(normalize_overview_dashboard_stats(&raw))
            },
        )
        .await
}

pub async fn get_dashboard_models(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<DashboardModelsPayload> {
    let filter = canonicalize_usage_filter(filter)?;
    let models = if usage_filter_can_use_daily_rollup(&filter) {
        repositories::list_usage_models_rollup_filtered(&ctx.db, account_id, &filter)?
    } else {
        repositories::list_usage_models_filtered(&ctx.db, account_id, &filter)?
    };
    Ok(DashboardModelsPayload {
        start_date: filter.start_date.unwrap_or_default(),
        end_date: filter.end_date.unwrap_or_default(),
        models,
    })
}

pub async fn get_dashboard_trend(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<UsageTrendPayload> {
    let filter = canonicalize_usage_filter(filter)?;
    let trend = if usage_filter_can_use_daily_rollup(&filter) {
        repositories::list_usage_trend_rollup_filtered(&ctx.db, account_id, &filter)?
    } else {
        repositories::list_usage_trend_filtered(&ctx.db, account_id, &filter)?
    };
    Ok(UsageTrendPayload {
        start_date: filter.start_date.unwrap_or_default(),
        end_date: filter.end_date.unwrap_or_default(),
        granularity: Some("day".into()),
        trend,
    })
}

pub async fn get_usage_insights(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<UsageInsightsPayload> {
    let filter = canonicalize_usage_filter(filter)?;
    repositories::summarize_usage_insights_filtered(&ctx.db, account_id, &filter)
}

pub async fn get_usage_extremes(
    ctx: &AppContext,
    account_id: &str,
    filter: UsageFilter,
) -> Result<UsageExtremesPayload> {
    let filter = canonicalize_usage_filter(filter)?;
    repositories::find_usage_extremes_filtered(&ctx.db, account_id, &filter)
}

pub async fn get_key_daily_usage(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    days: i64,
) -> Result<Vec<DailyUsagePoint>> {
    let now = shanghai_today();
    let start = (now - chrono::Days::new(days.saturating_sub(1).max(0) as u64)).to_string();
    let end = now.to_string();
    let api_key_filter = resolve_api_key_id_filter(ctx, account_id, key_id).await;
    if let Some(api_key_id) = api_key_filter.as_deref() {
        if let Ok(mut daily) =
            fetch_upstream_key_daily_usage_points(ctx, account_id, api_key_id, days).await
        {
            daily.sort_by(|left, right| left.date.cmp(&right.date));
            return Ok(daily);
        }
    }
    let rows = fetch_upstream_key_usage_rows(
        ctx,
        account_id,
        api_key_filter.as_deref(),
        &start,
        &end,
        days,
    )
    .await?;
    Ok(build_daily_usage_points(filter_usage_rows(
        rows,
        api_key_filter.as_deref(),
        Some(&start),
        Some(&end),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )))
}

pub async fn get_key_usage_summary(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    days: i64,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<KeyUsageSummaryPayload> {
    let keys =
        data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly).await?;
    let key = find_managed_key(keys, key_id).context("密钥不存在。")?;
    let raw_key = key
        .raw_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("当前密钥未返回原始密钥，无法读取完整用量。")?;
    let (_, site) = account_service::load_account_site(ctx, account_id)?;
    let (start_date, end_date, days) =
        normalize_key_usage_summary_window(days, start_date, end_date)?;
    let path = build_gateway_key_usage_summary_path(&start_date, &end_date, days);
    let raw = site_failover_service::request_api_key_usage(ctx, &site, &path, raw_key).await?;

    Ok(normalize_key_usage_summary(&raw))
}

pub async fn get_subscription_key_usage(
    ctx: &AppContext,
    account_id: &str,
    key_ids: Vec<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<SubscriptionKeyUsagePayload> {
    let live_keys =
        data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly).await?;
    let selected_keys = select_subscription_keys(live_keys, &key_ids);
    if selected_keys.is_empty() {
        return Ok(SubscriptionKeyUsagePayload {
            items: Vec::new(),
            total_requests: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_tokens: 0,
            total_actual_cost: 0.0,
            active_key_count: 0,
            inactive_key_count: 0,
        });
    }

    let (start_date, end_date) = normalize_subscription_usage_window(start_date, end_date);
    let stats_by_api_key_id =
        repositories::summarize_usage_rows_by_key(&ctx.db, account_id, &start_date, &end_date)?;

    Ok(build_subscription_key_usage_payload(
        selected_keys,
        stats_by_api_key_id,
    ))
}

async fn fetch_upstream_key_daily_usage_points(
    ctx: &AppContext,
    account_id: &str,
    api_key_id: &str,
    days: i64,
) -> Result<Vec<DailyUsagePoint>> {
    let path = build_upstream_key_daily_usage_path(api_key_id, days);
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        &path,
        "GET",
        None,
        UpstreamRequestPolicy::ReadOnly,
    )
    .await?;
    Ok(normalize_daily_usage_rows(&normalize_items(&raw)))
}

fn build_upstream_key_daily_usage_path(api_key_id: &str, days: i64) -> String {
    format!("/api/v1/user/api-keys/{api_key_id}/usage/daily?days={days}&timezone=Asia%2FShanghai")
}

fn build_gateway_key_usage_summary_path(
    start_date: &NaiveDate,
    end_date: &NaiveDate,
    days: i64,
) -> String {
    format!("/v1/usage?start_date={start_date}&end_date={end_date}&days={days}&timezone=Asia%2FShanghai")
}

fn normalize_key_usage_summary_window(
    days: i64,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<(NaiveDate, NaiveDate, i64)> {
    let days = normalize_usage_days(days);
    let start_date = start_date
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| parse_key_usage_summary_date(value, "开始日期"))
        .transpose()?;
    let end_date = end_date
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| parse_key_usage_summary_date(value, "结束日期"))
        .transpose()?;

    match (start_date, end_date) {
        (Some(start), Some(end)) => {
            if start > end {
                anyhow::bail!("开始日期不能晚于结束日期。");
            }
            let range_days = normalize_usage_days((end - start).num_days() + 1);
            Ok((start, end, range_days))
        }
        (Some(start), None) => {
            let end = start + Duration::days(days - 1);
            Ok((start, end, days))
        }
        (None, Some(end)) => {
            let start = end - Duration::days(days - 1);
            Ok((start, end, days))
        }
        (None, None) => {
            let end = shanghai_today();
            let start = end - Duration::days(days - 1);
            Ok((start, end, days))
        }
    }
}

fn parse_key_usage_summary_date(value: &str, label: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
        .with_context(|| format!("{label}格式无效。"))
}

fn normalize_usage_days(days: i64) -> i64 {
    days.clamp(1, 90)
}

async fn fetch_upstream_key_usage_rows(
    ctx: &AppContext,
    account_id: &str,
    api_key_id: Option<&str>,
    start_date: &str,
    end_date: &str,
    days: i64,
) -> Result<Vec<UsageRow>> {
    let mut page = 1_i64;
    let mut rows = Vec::new();

    loop {
        let path = build_upstream_key_usage_path(
            page,
            DIRECT_KEY_USAGE_PAGE_SIZE,
            api_key_id,
            start_date,
            end_date,
            days,
        );
        let raw = upstream_service::account_upstream_request(
            ctx,
            account_id,
            &path,
            "GET",
            None,
            UpstreamRequestPolicy::ReadOnly,
        )
        .await?;
        let next = normalize_items(&raw)
            .into_iter()
            .map(|item| normalize_usage_row(&item))
            .collect::<Vec<_>>();
        let batch_size = next.len() as i64;
        if next.is_empty() {
            break;
        }
        rows.extend(next);
        if batch_size < DIRECT_KEY_USAGE_PAGE_SIZE || page >= DIRECT_KEY_USAGE_MAX_PAGES {
            break;
        }
        page += 1;
    }

    Ok(rows)
}

fn build_upstream_key_usage_path(
    page: i64,
    page_size: i64,
    api_key_id: Option<&str>,
    start_date: &str,
    end_date: &str,
    days: i64,
) -> String {
    let mut params = vec![
        format!("page={page}"),
        format!("page_size={page_size}"),
        format!("start_date={start_date}"),
        format!("end_date={end_date}"),
        format!("days={days}"),
        "sort_by=created_at".to_string(),
        "sort_order=desc".to_string(),
        "timezone=Asia%2FShanghai".to_string(),
    ];
    if let Some(api_key_id) = api_key_id.filter(|value| !value.is_empty()) {
        params.push(format!("api_key_id={api_key_id}"));
    }
    format!("/api/v1/usage?{}", params.join("&"))
}

fn build_daily_usage_points(rows: Vec<UsageRow>) -> Vec<DailyUsagePoint> {
    let mut grouped = BTreeMap::<String, DailyUsagePoint>::new();
    for row in rows {
        let bucket = parse_usage_date(&row.created_at)
            .map(|item| item.to_string())
            .unwrap_or_else(|| row.created_at.clone());
        let entry = grouped.entry(bucket.clone()).or_insert(DailyUsagePoint {
            date: bucket,
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            total_tokens: Some(0),
            actual_cost: Some(0.0),
            total_cost: Some(0.0),
        });
        entry.requests += 1;
        entry.input_tokens += row.input_tokens;
        entry.output_tokens += row.output_tokens;
        entry.cache_read_tokens =
            Some(entry.cache_read_tokens.unwrap_or(0) + row.cache_read_tokens.unwrap_or(0));
        entry.cache_write_tokens =
            Some(entry.cache_write_tokens.unwrap_or(0) + row.cache_creation_tokens.unwrap_or(0));
        entry.total_tokens = Some(entry.total_tokens.unwrap_or(0) + row.total_tokens);
        entry.actual_cost = Some(entry.actual_cost.unwrap_or(0.0) + row.actual_cost);
        entry.total_cost = Some(entry.total_cost.unwrap_or(0.0) + row.total_cost);
    }
    grouped.into_values().collect()
}

fn usage_filter_can_use_daily_rollup(filter: &UsageFilter) -> bool {
    let mut unsupported = filter.clone();
    unsupported.start_date = None;
    unsupported.end_date = None;
    unsupported.model = None;
    unsupported.platform = None;
    unsupported == UsageFilter::default()
}

pub(crate) fn canonicalize_usage_filter(mut filter: UsageFilter) -> Result<UsageFilter> {
    filter.start_date = canonicalize_usage_date("start_date", filter.start_date)?;
    filter.end_date = canonicalize_usage_date("end_date", filter.end_date)?;
    if let (Some(start), Some(end)) = (&filter.start_date, &filter.end_date) {
        if start > end {
            return Err(usage_query_error(
                "USAGE_INVALID_FILTER",
                "start_date must not be after end_date",
            ));
        }
    }

    for (name, value) in [
        ("api_key_id", filter.api_key_id),
        ("upstream_user_id", filter.upstream_user_id),
        ("upstream_account_id", filter.upstream_account_id),
        ("group_id", filter.group_id),
        ("subscription_id", filter.subscription_id),
        ("billing_type", filter.billing_type),
    ] {
        if value.is_some_and(|value| value < 0) {
            return Err(usage_query_error(
                "USAGE_INVALID_FILTER",
                &format!("{name} must be non-negative"),
            ));
        }
    }

    normalize_usage_text_field(&mut filter.usage_id);
    normalize_usage_text_field(&mut filter.request_id);
    normalize_usage_text_field(&mut filter.api_key_name);
    normalize_usage_text_field(&mut filter.model);
    normalize_usage_text_field(&mut filter.platform);
    normalize_usage_text_field(&mut filter.endpoint);
    normalize_usage_text_field(&mut filter.upstream_endpoint);
    normalize_usage_text_field(&mut filter.group_name);
    normalize_usage_text_field(&mut filter.subscription_name);
    normalize_usage_text_field(&mut filter.subscription_type);
    normalize_usage_text_field(&mut filter.service_tier);
    normalize_usage_text_field(&mut filter.reasoning_effort);
    normalize_usage_text_field(&mut filter.request_type);
    normalize_usage_text_field(&mut filter.billing_mode);
    normalize_usage_text_field(&mut filter.media_type);
    normalize_usage_text_field(&mut filter.image_size);
    normalize_usage_text_field(&mut filter.image_input_size);
    normalize_usage_text_field(&mut filter.image_output_size);
    normalize_usage_text_field(&mut filter.image_size_source);
    normalize_usage_text_field(&mut filter.image_size_breakdown);
    normalize_usage_text_field(&mut filter.ip_address);
    if let Some(request_type) = filter.request_type.as_mut() {
        if request_type.value == "default" {
            request_type.value = "standard".to_string();
        }
    }
    filter.user_agent_query = filter
        .user_agent_query
        .take()
        .map(|value| {
            value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        })
        .filter(|value| !value.is_empty());

    validate_usage_i64_range("input_tokens", &filter.input_tokens)?;
    validate_usage_i64_range("output_tokens", &filter.output_tokens)?;
    validate_usage_i64_range("total_tokens", &filter.total_tokens)?;
    validate_usage_i64_range("cache_creation_tokens", &filter.cache_creation_tokens)?;
    validate_usage_i64_range("cache_read_tokens", &filter.cache_read_tokens)?;
    validate_usage_i64_range("cache_creation_5m_tokens", &filter.cache_creation_5m_tokens)?;
    validate_usage_i64_range("cache_creation_1h_tokens", &filter.cache_creation_1h_tokens)?;
    validate_usage_i64_range("image_input_tokens", &filter.image_input_tokens)?;
    validate_usage_i64_range("image_output_tokens", &filter.image_output_tokens)?;
    validate_usage_i64_range("duration_ms", &filter.duration_ms)?;
    validate_usage_i64_range("first_token_ms", &filter.first_token_ms)?;
    validate_usage_i64_range("image_count", &filter.image_count)?;

    validate_usage_f64_range("actual_cost", &mut filter.actual_cost)?;
    validate_usage_f64_range("total_cost", &mut filter.total_cost)?;
    validate_usage_f64_range("input_cost", &mut filter.input_cost)?;
    validate_usage_f64_range("output_cost", &mut filter.output_cost)?;
    validate_usage_f64_range("cache_creation_cost", &mut filter.cache_creation_cost)?;
    validate_usage_f64_range("cache_read_cost", &mut filter.cache_read_cost)?;
    validate_usage_f64_range("image_input_cost", &mut filter.image_input_cost)?;
    validate_usage_f64_range("image_output_cost", &mut filter.image_output_cost)?;
    validate_usage_f64_range("rate_multiplier", &mut filter.rate_multiplier)?;

    Ok(filter)
}

fn canonicalize_usage_date(name: &str, value: Option<String>) -> Result<Option<String>> {
    value
        .map(|value| {
            let value = value.trim();
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map(|date| date.to_string())
                .map_err(|_| {
                    usage_query_error(
                        "USAGE_INVALID_FILTER",
                        &format!("{name} must use YYYY-MM-DD"),
                    )
                })
        })
        .transpose()
}

fn normalize_usage_text_field(field: &mut Option<UsageTextFilter>) {
    *field = field.take().and_then(|mut filter| {
        filter.value = filter.value.trim().to_lowercase();
        (!filter.value.is_empty()).then_some(filter)
    });
}

fn validate_usage_i64_range(name: &str, range: &UsageI64Range) -> Result<()> {
    if range.min.is_some_and(|value| value < 0) || range.max.is_some_and(|value| value < 0) {
        return Err(usage_query_error(
            "USAGE_INVALID_FILTER",
            &format!("{name} range must be non-negative"),
        ));
    }
    if matches!((range.min, range.max), (Some(min), Some(max)) if min > max) {
        return Err(usage_query_error(
            "USAGE_INVALID_FILTER",
            &format!("{name} range min must not exceed max"),
        ));
    }
    Ok(())
}

fn validate_usage_f64_range(name: &str, range: &mut UsageF64Range) -> Result<()> {
    for value in [range.min, range.max].into_iter().flatten() {
        if !value.is_finite() || value < 0.0 {
            return Err(usage_query_error(
                "USAGE_INVALID_FILTER",
                &format!("{name} range must be finite and non-negative"),
            ));
        }
    }
    if matches!((range.min, range.max), (Some(min), Some(max)) if min > max) {
        return Err(usage_query_error(
            "USAGE_INVALID_FILTER",
            &format!("{name} range min must not exceed max"),
        ));
    }
    range.min = range
        .min
        .map(|value| if value == 0.0 { 0.0 } else { value });
    range.max = range
        .max
        .map(|value| if value == 0.0 { 0.0 } else { value });
    Ok(())
}

fn usage_filter_signature(filter: &UsageFilter) -> Result<String> {
    let serialized = serde_json::to_vec(filter).context("serialize canonical usage filter")?;
    Ok(encode_hex(&Sha256::digest(serialized)))
}

fn encode_usage_cursor(
    account_id: &str,
    row: &UsageRow,
    direction: UsageCursorDirection,
    page_size: i64,
    filter_signature: &str,
) -> Result<String> {
    let payload = UsageCursorPayload {
        version: USAGE_CURSOR_VERSION,
        account_id: account_id.to_string(),
        occurred_at: normalize_storage_timestamp(&row.created_at)
            .context("normalize usage cursor timestamp")?,
        usage_id: row.id.clone(),
        direction,
        page_size,
        filter_signature: filter_signature.to_string(),
        sort: USAGE_CURSOR_SORT.to_string(),
    };
    let serialized = serde_json::to_vec(&payload).context("serialize usage cursor")?;
    Ok(encode_hex(&serialized))
}

fn decode_usage_cursor(
    cursor: &str,
    account_id: &str,
    direction: UsageCursorDirection,
    page_size: i64,
    filter_signature: &str,
) -> Result<repositories::UsagePageAnchor> {
    let serialized = decode_hex(cursor)
        .map_err(|_| usage_query_error("USAGE_INVALID_CURSOR", "cursor is malformed"))?;
    let payload: UsageCursorPayload = serde_json::from_slice(&serialized)
        .map_err(|_| usage_query_error("USAGE_INVALID_CURSOR", "cursor is malformed"))?;
    if payload.version != USAGE_CURSOR_VERSION {
        return Err(usage_query_error(
            "USAGE_CURSOR_VERSION",
            "cursor version is not supported",
        ));
    }
    if payload.direction != direction {
        return Err(usage_query_error(
            "USAGE_CURSOR_DIRECTION",
            "cursor direction does not match the request",
        ));
    }
    if payload.account_id != account_id
        || payload.page_size != page_size
        || payload.filter_signature != filter_signature
        || payload.sort != USAGE_CURSOR_SORT
    {
        return Err(usage_query_error(
            "USAGE_CURSOR_FILTER_MISMATCH",
            "cursor does not match the current query",
        ));
    }
    if payload.usage_id.trim().is_empty()
        || NaiveDateTime::parse_from_str(&payload.occurred_at, "%Y-%m-%d %H:%M:%S").is_err()
    {
        return Err(usage_query_error(
            "USAGE_INVALID_CURSOR",
            "cursor anchor is malformed",
        ));
    }
    Ok(repositories::UsagePageAnchor {
        occurred_at: payload.occurred_at,
        usage_id: payload.usage_id,
    })
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if value.is_empty() || value.len() % 2 != 0 || !value.is_ascii() {
        return Err(anyhow!("invalid hex"));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|_| anyhow!("invalid hex"))?;
            u8::from_str_radix(pair, 16).map_err(|_| anyhow!("invalid hex"))
        })
        .collect()
}

fn usage_query_error(code: &str, detail: &str) -> anyhow::Error {
    anyhow!("{code}: {detail}")
}

fn filter_usage_rows(
    rows: Vec<UsageRow>,
    api_key_id: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
    period: Option<&str>,
    model: Option<&str>,
    group_name: Option<&str>,
    subscription_name: Option<&str>,
    platform: Option<&str>,
    reasoning_effort: Option<&str>,
    request_type: Option<&str>,
    billing_type: Option<&str>,
    billing_mode: Option<&str>,
) -> Vec<UsageRow> {
    let today = shanghai_today();
    let period_start = match period {
        Some("today") => Some(today),
        _ => None,
    };
    let start = start_date.and_then(parse_usage_date).or(period_start);
    let end = end_date.and_then(parse_usage_date).or(period_start);

    rows.into_iter()
        .filter(|row| {
            let key_matches = api_key_id
                .map(|expected| {
                    row.api_key_id.map(|value| value.to_string()) == Some(expected.to_string())
                })
                .unwrap_or(true);
            let date = parse_usage_date(&row.created_at);
            let start_matches = start.is_none_or(|value| date.is_some_and(|date| date >= value));
            let end_matches = end.is_none_or(|value| date.is_some_and(|date| date <= value));
            let model_matches = matches_usage_text_filter(Some(row.model.as_str()), model);
            let group_matches = matches_usage_group_filter(row, group_name);
            let subscription_matches =
                matches_usage_text_filter(row.subscription_name.as_deref(), subscription_name);
            let platform_matches = matches_usage_text_filter(row.platform.as_deref(), platform);
            let reasoning_matches =
                matches_usage_text_filter(row.reasoning_effort.as_deref(), reasoning_effort);
            let request_type_matches = matches_usage_request_type_filter(row, request_type);
            let billing_type_matches = matches_usage_billing_type_filter(row, billing_type);
            let billing_mode_matches =
                matches_usage_text_filter(row.billing_mode.as_deref(), billing_mode);
            key_matches
                && start_matches
                && end_matches
                && model_matches
                && group_matches
                && subscription_matches
                && platform_matches
                && reasoning_matches
                && request_type_matches
                && billing_type_matches
                && billing_mode_matches
        })
        .collect()
}

fn matches_usage_text_filter(actual: Option<&str>, expected: Option<&str>) -> bool {
    let normalized_expected = normalize_usage_filter_text(expected);
    if normalized_expected.is_none() {
        return true;
    }
    normalize_usage_filter_text(actual) == normalized_expected
}

fn matches_usage_group_filter(row: &UsageRow, expected: Option<&str>) -> bool {
    matches_usage_text_filter(
        row.group_name
            .as_deref()
            .or(row.subscription_name.as_deref()),
        expected,
    )
}

fn matches_usage_request_type_filter(row: &UsageRow, expected: Option<&str>) -> bool {
    let normalized_expected = normalize_usage_filter_text(expected);
    if normalized_expected.is_none() {
        return true;
    }
    normalize_usage_request_type_filter_value(row.request_type.as_deref(), row.stream)
        == normalized_expected
}

fn matches_usage_billing_type_filter(row: &UsageRow, expected: Option<&str>) -> bool {
    let expected = expected
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok());
    expected.is_none_or(|value| row.billing_type == Some(value))
}

fn normalize_usage_request_type_filter_value(
    request_type: Option<&str>,
    stream: Option<bool>,
) -> Option<String> {
    let normalized = normalize_usage_filter_text(request_type);
    if stream.unwrap_or(false) || normalized.as_deref() == Some("stream") {
        return Some("stream".into());
    }
    match normalized.as_deref() {
        Some("sync") => Some("sync".into()),
        Some("batch") => Some("batch".into()),
        Some("default") | Some("standard") | None => Some("standard".into()),
        Some(other) => Some(other.to_string()),
    }
}

fn normalize_usage_filter_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
}

fn parse_usage_date(value: &str) -> Option<NaiveDate> {
    storage_timestamp_date(value)
        .ok()
        .or_else(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn usage_query_window_for_today() -> (String, String) {
    let today = shanghai_today().to_string();
    (today.clone(), today)
}

fn normalize_subscription_usage_window(
    start_date: Option<String>,
    end_date: Option<String>,
) -> (String, String) {
    let default = usage_query_window_for_today();
    let next_start = start_date.unwrap_or_else(|| default.0.clone());
    let next_end = end_date.unwrap_or_else(|| default.1.clone());
    (next_start, next_end)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{routing::get, Json, Router};
    use serde_json::json;
    use tokio::sync::Mutex;

    use super::{
        build_daily_usage_points, build_gateway_key_usage_summary_path,
        build_upstream_key_daily_usage_path, build_upstream_key_usage_path, filter_usage_rows,
        get_dashboard_models, get_dashboard_trend, get_usage_analytics, get_usage_extremes,
        get_usage_insights, get_usage_stats, list_usage_records,
        normalize_key_usage_summary_window, normalize_usage_days,
        usage_filter_can_use_daily_rollup,
    };
    use crate::application::{context::SyncTaskHandle, AppContext};
    use crate::contracts::{
        AccountRecord, SiteRecord, StoredSession, UsageFacetRequest, UsageFilter, UsageListRequest,
        UsageRow, UsageTextFilter, UsageTextMatchMode,
    };
    use crate::infrastructure::datetime::shanghai_today;
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::{repositories, Database};

    #[tokio::test]
    async fn usage_query_endpoints_are_local_reads_only() {
        let usage_hits = Arc::new(AtomicUsize::new(0));
        let stats_hits = Arc::new(AtomicUsize::new(0));
        let app = {
            let usage_hits = Arc::clone(&usage_hits);
            let stats_hits = Arc::clone(&stats_hits);
            Router::new()
                .route(
                    "/api/v1/usage",
                    get(move || {
                        let usage_hits = Arc::clone(&usage_hits);
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "items": [{
                                    "id": "unexpected-upstream-row",
                                    "created_at": "2000-01-01T08:00:00+08:00",
                                    "model": "gpt-5.4",
                                    "actual_cost": 99.0,
                                    "total_cost": 99.0,
                                    "input_tokens": 99,
                                    "output_tokens": 1,
                                    "total_tokens": 100
                                }]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage/stats",
                    get(move || {
                        let stats_hits = Arc::clone(&stats_hits);
                        async move {
                            stats_hits.fetch_add(1, Ordering::SeqCst);
                            Json(json!({
                                "total_requests": 999,
                                "total_input_tokens": 999,
                                "total_output_tokens": 999,
                                "total_tokens": 1998,
                                "total_cost": 99.0,
                                "total_actual_cost": 99.0,
                                "average_duration_ms": 999.0
                            }))
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_usage_test_context();
        seed_usage_test_account(&ctx, &format!("http://{address}"));
        let today = shanghai_today().to_string();
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-local-read",
            &[UsageRow {
                id: "cached-local-row".into(),
                created_at: format!("{today}T08:00:00+08:00"),
                model: "gpt-5.4".into(),
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                actual_cost: 0.1,
                total_cost: 0.2,
                ..sample_usage_row()
            }],
            "2026-07-10T00:00:00Z",
        )
        .expect("seed cached usage");

        let filter = UsageFilter {
            start_date: Some(today.clone()),
            end_date: Some(today.clone()),
            ..UsageFilter::default()
        };
        let stats = get_usage_stats(&ctx, "account-local-read", filter.clone())
            .await
            .expect("read local stats");
        assert_eq!(stats.total_requests, 1);
        assert_eq!(stats.total_tokens, 15);
        assert_eq!(stats.rpm, None);
        assert_eq!(stats.tpm, None);
        get_dashboard_models(&ctx, "account-local-read", filter.clone())
            .await
            .expect("read local models");
        get_dashboard_trend(&ctx, "account-local-read", filter.clone())
            .await
            .expect("read local trend");
        let analytics = get_usage_analytics(&ctx, "account-local-read", filter.clone())
            .await
            .expect("read local analytics");
        assert_eq!(analytics.matched_rows, 1);
        assert_eq!(analytics.totals.total_tokens, 15);
        get_usage_insights(&ctx, "account-local-read", filter.clone())
            .await
            .expect("read local insights");
        get_usage_extremes(&ctx, "account-local-read", filter)
            .await
            .expect("read local extremes");

        let empty_page = list_usage_records(
            &ctx,
            "account-local-read",
            UsageListRequest {
                page_size: 20,
                filter: UsageFilter {
                    start_date: Some("2000-01-01".into()),
                    end_date: Some("2000-01-01".into()),
                    ..UsageFilter::default()
                },
                ..UsageListRequest::default()
            },
        )
        .await
        .expect("read empty local range");
        server.abort();

        assert!(empty_page.items.is_empty());
        assert_eq!(usage_hits.load(Ordering::SeqCst), 0);
        assert_eq!(stats_hits.load(Ordering::SeqCst), 0);
        let stored_rows =
            repositories::list_usage_row_cache(&ctx.db, "account-local-read", None, None, None)
                .expect("read stored usage rows");
        assert_eq!(stored_rows.len(), 1);
        assert_eq!(stored_rows[0].row.id, "cached-local-row");
    }

    fn build_usage_test_context() -> AppContext {
        let root =
            std::env::temp_dir().join(format!("api-token-usage-tests-{}", uuid::Uuid::new_v4()));
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

    fn seed_usage_test_account(ctx: &AppContext, base_url: &str) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: "site-local-read".into(),
                name: "Test Site".into(),
                base_url: base_url.into(),
                created_at: "2026-07-10T00:00:00Z".into(),
                updated_at: "2026-07-10T00:00:00Z".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: "account-local-read".into(),
                site_id: "site-local-read".into(),
                label: "本地只读账号".into(),
                email: "local-read@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-07-10T00:00:00Z".into(),
                updated_at: "2026-07-10T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        repositories::save_session(
            &ctx.db,
            "account-local-read",
            &StoredSession {
                saved_at: "2026-07-10T00:00:00Z".into(),
                access_token: Some("test-token".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");
    }

    #[test]
    fn daily_rollup_accepts_only_date_model_and_platform_filters() {
        let eligible = UsageFilter {
            start_date: Some("2026-06-01".into()),
            end_date: Some("2026-06-30".into()),
            model: Some(UsageTextFilter {
                value: "gpt-5".into(),
                mode: UsageTextMatchMode::Prefix,
            }),
            platform: Some(UsageTextFilter::from("openai")),
            ..UsageFilter::default()
        };
        assert!(usage_filter_can_use_daily_rollup(&eligible));

        let mut advanced = eligible.clone();
        advanced.stream = Some(false);
        assert!(!usage_filter_can_use_daily_rollup(&advanced));

        let mut future_detail_only = eligible;
        future_detail_only.user_agent_query = Some("codex*".into());
        assert!(!usage_filter_can_use_daily_rollup(&future_detail_only));
    }

    #[test]
    fn usage_facet_request_defaults_to_fifty_items() {
        let request: UsageFacetRequest = serde_json::from_value(json!({
            "field": "model"
        }))
        .expect("deserialize facet request with defaults");

        assert_eq!(request.limit, 50);
        assert_eq!(request.filter, UsageFilter::default());
        assert_eq!(request.search, None);
    }

    #[tokio::test]
    async fn advanced_filters_bypass_daily_rollup_for_all_supported_aggregates() {
        let ctx = build_usage_test_context();
        seed_usage_test_account(&ctx, "http://127.0.0.1:1");
        let mut row = sample_usage_row();
        row.id = "detail-only-row".into();
        row.created_at = "2026-08-11T10:00:00+08:00".into();
        row.model = "gpt-5.4".into();
        row.platform = Some("openai".into());
        row.stream = Some(false);
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-local-read",
            &[row],
            "2026-08-11T10:01:00+08:00",
        )
        .expect("seed detail-only aggregate row");
        ctx.db
            .connect()
            .expect("open rollup fixture")
            .execute(
                "UPDATE account_usage_daily_rollup SET requests = 999
                 WHERE account_id = ?1",
                ["account-local-read"],
            )
            .expect("make rollup source distinguishable");

        let eligible_filter = UsageFilter {
            start_date: Some("2026-08-11".into()),
            end_date: Some("2026-08-11".into()),
            model: Some(UsageTextFilter::from("gpt-5.4")),
            platform: Some(UsageTextFilter::from("openai")),
            ..UsageFilter::default()
        };
        assert_eq!(
            get_usage_stats(&ctx, "account-local-read", eligible_filter.clone())
                .await
                .expect("read eligible rollup stats")
                .total_requests,
            999
        );

        let advanced_filter = UsageFilter {
            stream: Some(false),
            ..eligible_filter
        };
        let stats = get_usage_stats(&ctx, "account-local-read", advanced_filter.clone())
            .await
            .expect("read detail stats");
        let models = get_dashboard_models(&ctx, "account-local-read", advanced_filter.clone())
            .await
            .expect("read detail models");
        let trend = get_dashboard_trend(&ctx, "account-local-read", advanced_filter)
            .await
            .expect("read detail trend");

        assert_eq!(stats.total_requests, 1);
        assert_eq!(models.models[0].requests, 1);
        assert_eq!(trend.trend[0].requests, 1);
    }

    #[test]
    fn filter_usage_rows_matches_local_detail_filters() {
        let rows = vec![
            UsageRow {
                id: "stream-token".into(),
                model: "gpt-5.4".into(),
                group_name: Some("CodeX Plus".into()),
                subscription_name: Some("CodeX Plus Monthly".into()),
                platform: Some("openai".into()),
                reasoning_effort: Some("low".into()),
                request_type: Some("stream".into()),
                stream: Some(true),
                billing_type: Some(1),
                billing_mode: Some("token".into()),
                ..sample_usage_row()
            },
            UsageRow {
                id: "image-sync".into(),
                model: "gpt-image-1".into(),
                group_name: Some("Vision".into()),
                subscription_name: Some("Vision Annual".into()),
                platform: Some("openai".into()),
                reasoning_effort: Some("medium".into()),
                request_type: Some("sync".into()),
                stream: Some(false),
                billing_type: Some(2),
                billing_mode: Some("image".into()),
                ..sample_usage_row()
            },
        ];

        let filtered = filter_usage_rows(
            rows,
            None,
            None,
            None,
            None,
            Some("gpt-image-1"),
            Some("Vision"),
            Some("Vision Annual"),
            Some("openai"),
            Some("medium"),
            Some("sync"),
            Some("2"),
            Some("image"),
        );

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "image-sync");
    }

    #[test]
    fn upstream_key_daily_usage_path_targets_key_aggregate_endpoint() {
        let path = build_upstream_key_daily_usage_path("3641", 30);

        assert_eq!(
            path,
            "/api/v1/user/api-keys/3641/usage/daily?days=30&timezone=Asia%2FShanghai"
        );
    }

    #[test]
    fn gateway_key_usage_summary_path_matches_runtime_usage_endpoint() {
        let start = chrono::NaiveDate::from_ymd_opt(2026, 7, 6).expect("valid start");
        let end = chrono::NaiveDate::from_ymd_opt(2026, 7, 6).expect("valid end");
        let path = build_gateway_key_usage_summary_path(&start, &end, 30);

        assert_eq!(
            path,
            "/v1/usage?start_date=2026-07-06&end_date=2026-07-06&days=30&timezone=Asia%2FShanghai"
        );
    }

    #[test]
    fn key_usage_summary_window_accepts_custom_dates() {
        let (start, end, days) = normalize_key_usage_summary_window(
            30,
            Some("2026-07-01".into()),
            Some("2026-07-06".into()),
        )
        .expect("valid custom range");

        assert_eq!(start.to_string(), "2026-07-01");
        assert_eq!(end.to_string(), "2026-07-06");
        assert_eq!(days, 6);
    }

    #[test]
    fn key_usage_summary_window_rejects_reversed_dates() {
        let result = normalize_key_usage_summary_window(
            30,
            Some("2026-07-06".into()),
            Some("2026-07-01".into()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn gateway_key_usage_summary_days_are_clamped() {
        assert_eq!(normalize_usage_days(0), 1);
        assert_eq!(normalize_usage_days(30), 30);
        assert_eq!(normalize_usage_days(180), 90);
    }

    #[test]
    fn upstream_key_usage_path_preserves_filters() {
        let path =
            build_upstream_key_usage_path(2, 500, Some("3641"), "2026-07-01", "2026-07-06", 30);

        assert_eq!(
            path,
            "/api/v1/usage?page=2&page_size=500&start_date=2026-07-01&end_date=2026-07-06&days=30&sort_by=created_at&sort_order=desc&timezone=Asia%2FShanghai&api_key_id=3641"
        );
    }

    #[test]
    fn key_daily_usage_aggregates_only_selected_upstream_rows() {
        let rows = vec![
            UsageRow {
                id: "target-first".into(),
                api_key_id: Some(3641),
                created_at: "2026-07-05T10:00:00+08:00".into(),
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: Some(3),
                cache_creation_tokens: Some(4),
                total_tokens: 37,
                actual_cost: 0.5,
                total_cost: 0.7,
                ..sample_usage_row()
            },
            UsageRow {
                id: "target-second".into(),
                api_key_id: Some(3641),
                created_at: "2026-07-05T12:00:00+08:00".into(),
                input_tokens: 5,
                output_tokens: 6,
                cache_read_tokens: Some(1),
                cache_creation_tokens: Some(2),
                total_tokens: 14,
                actual_cost: 0.25,
                total_cost: 0.3,
                ..sample_usage_row()
            },
            UsageRow {
                id: "other-key".into(),
                api_key_id: Some(9999),
                created_at: "2026-07-05T13:00:00+08:00".into(),
                input_tokens: 999,
                output_tokens: 999,
                total_tokens: 1998,
                actual_cost: 9.9,
                total_cost: 9.9,
                ..sample_usage_row()
            },
            UsageRow {
                id: "target-next-day".into(),
                api_key_id: Some(3641),
                created_at: "2026-07-06T09:00:00+08:00".into(),
                input_tokens: 8,
                output_tokens: 9,
                cache_read_tokens: Some(0),
                cache_creation_tokens: Some(1),
                total_tokens: 18,
                actual_cost: 0.1,
                total_cost: 0.12,
                ..sample_usage_row()
            },
            UsageRow {
                id: "out-of-range".into(),
                api_key_id: Some(3641),
                created_at: "2026-07-07T09:00:00+08:00".into(),
                input_tokens: 100,
                output_tokens: 100,
                total_tokens: 200,
                actual_cost: 1.0,
                total_cost: 1.0,
                ..sample_usage_row()
            },
        ];

        let daily = build_daily_usage_points(filter_usage_rows(
            rows,
            Some("3641"),
            Some("2026-07-05"),
            Some("2026-07-06"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ));

        assert_eq!(daily.len(), 2);
        assert_eq!(daily[0].date, "2026-07-05");
        assert_eq!(daily[0].requests, 2);
        assert_eq!(daily[0].input_tokens, 15);
        assert_eq!(daily[0].output_tokens, 26);
        assert_eq!(daily[0].cache_read_tokens, Some(4));
        assert_eq!(daily[0].cache_write_tokens, Some(6));
        assert_eq!(daily[0].total_tokens, Some(51));
        assert_eq!(daily[0].actual_cost, Some(0.75));
        assert_eq!(daily[0].total_cost, Some(1.0));
        assert_eq!(daily[1].date, "2026-07-06");
        assert_eq!(daily[1].requests, 1);
        assert_eq!(daily[1].total_tokens, Some(18));
    }

    #[test]
    fn repository_extreme_query_honors_range_and_key_filter() {
        let db_path = std::env::temp_dir().join(format!(
            "api-token-usage-extreme-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = crate::infrastructure::sqlite::Database::new(db_path.clone());
        let conn = db.connect().expect("connect sqlite db");
        conn.execute(
            "INSERT INTO sites (id, name, base_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                "site-1",
                "Test Site",
                "https://example.test",
                "2026-06-28T00:00:00+08:00",
                "2026-06-28T00:00:00+08:00",
            ],
        )
        .expect("insert site");
        conn.execute(
            "INSERT INTO accounts (id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
            rusqlite::params![
                "account-1",
                "site-1",
                "Test Account",
                "test@example.com",
                0.0_f64,
                "2026-06-28T00:00:00+08:00",
                "2026-06-28T00:00:00+08:00",
            ],
        )
        .expect("insert account");

        let insert = |row: UsageRow, occurred_at: &str| {
            conn.execute(
                "INSERT INTO account_usage_row_cache (
                    account_id, usage_id, api_key_id, upstream_user_id, upstream_account_id, request_id,
                    model, reasoning_effort, endpoint, upstream_endpoint, group_id, subscription_id,
                    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                    cache_creation_5m_tokens, cache_creation_1h_tokens, input_cost, output_cost,
                    cache_creation_cost, cache_read_cost, total_cost, actual_cost, rate_multiplier,
                    billing_type, request_type, stream, openai_ws_mode, duration_ms, first_token_ms,
                    image_count, image_size, image_input_size, image_output_size, image_output_tokens,
                    image_output_cost, image_size_source, image_size_breakdown, media_type, user_agent,
                    cache_ttl_overridden, billing_mode, platform, api_key_name, group_name,
                    subscription_name, subscription_type, occurred_at, updated_at, first_seen_at, last_seen_at
                 ) VALUES (
                    ?1, ?2, ?3, NULL, NULL, NULL,
                    ?4, NULL, NULL, NULL, NULL, NULL,
                    ?5, ?6, NULL, NULL,
                    NULL, NULL, NULL, NULL,
                    NULL, NULL, ?7, ?8, NULL,
                    NULL, NULL, NULL, NULL, ?9, ?10,
                    NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, NULL,
                    NULL, NULL, ?11, NULL, NULL,
                    NULL, NULL, ?12, ?12, ?12, ?12
                 )",
                rusqlite::params![
                    "account-1",
                    row.id,
                    row.api_key_id,
                    row.model,
                    row.input_tokens,
                    row.output_tokens,
                    row.total_cost,
                    row.actual_cost,
                    row.duration_ms,
                    row.first_token_ms,
                    row.platform,
                    occurred_at,
                ],
            )
            .expect("insert row");
        };

        insert(
            UsageRow {
                id: "old".into(),
                api_key_id: Some(1),
                model: "gpt-old".into(),
                input_tokens: 999_999,
                output_tokens: 999_999,
                total_cost: 9.9,
                actual_cost: 9.9,
                duration_ms: Some(10_000),
                first_token_ms: Some(99_999),
                platform: Some("openai".into()),
                ..sample_usage_row()
            },
            "2026-06-20T10:00:00+08:00",
        );
        insert(
            UsageRow {
                id: "cost-hit".into(),
                api_key_id: Some(1),
                model: "gpt-4.1".into(),
                input_tokens: 1_000,
                output_tokens: 500,
                total_cost: 0.9,
                actual_cost: 0.8,
                duration_ms: Some(8_000),
                first_token_ms: Some(4_000),
                platform: Some("openai".into()),
                ..sample_usage_row()
            },
            "2026-06-28T10:00:00+08:00",
        );
        insert(
            UsageRow {
                id: "first-token-hit".into(),
                api_key_id: Some(1),
                model: "gpt-4.1".into(),
                input_tokens: 2_000,
                output_tokens: 600,
                total_cost: 0.4,
                actual_cost: 0.4,
                duration_ms: Some(8_000),
                first_token_ms: Some(12_000),
                platform: Some("openai".into()),
                ..sample_usage_row()
            },
            "2026-06-29T10:00:00+08:00",
        );
        insert(
            UsageRow {
                id: "input-hit".into(),
                api_key_id: Some(1),
                model: "gpt-4.1".into(),
                input_tokens: 8_000,
                output_tokens: 200,
                total_cost: 0.3,
                actual_cost: 0.3,
                duration_ms: Some(8_000),
                first_token_ms: Some(3_000),
                platform: Some("openai".into()),
                ..sample_usage_row()
            },
            "2026-06-30T10:00:00+08:00",
        );
        insert(
            UsageRow {
                id: "output-hit-other-key".into(),
                api_key_id: Some(2),
                model: "gpt-4.1".into(),
                input_tokens: 500,
                output_tokens: 9_000,
                total_cost: 0.2,
                actual_cost: 0.2,
                duration_ms: Some(8_000),
                first_token_ms: Some(2_000),
                platform: Some("openai".into()),
                ..sample_usage_row()
            },
            "2026-06-30T12:00:00+08:00",
        );
        drop(conn);

        let cost_row = repositories::find_usage_row_extreme(
            &db,
            "account-1",
            None,
            Some("2026-06-28"),
            Some("2026-06-30"),
            "actual_cost",
        )
        .expect("cost extreme")
        .expect("cost row");
        assert_eq!(cost_row.id, "cost-hit");

        let first_token_row = repositories::find_usage_row_extreme(
            &db,
            "account-1",
            None,
            Some("2026-06-28"),
            Some("2026-06-30"),
            "first_token_ms",
        )
        .expect("first token extreme")
        .expect("first token row");
        assert_eq!(first_token_row.id, "first-token-hit");

        let input_row = repositories::find_usage_row_extreme(
            &db,
            "account-1",
            Some(1),
            Some("2026-06-28"),
            Some("2026-06-30"),
            "input_tokens",
        )
        .expect("input extreme")
        .expect("input row");
        assert_eq!(input_row.id, "input-hit");

        let output_row = repositories::find_usage_row_extreme(
            &db,
            "account-1",
            Some(1),
            Some("2026-06-28"),
            Some("2026-06-30"),
            "output_tokens",
        )
        .expect("output extreme")
        .expect("output row");
        assert_eq!(output_row.id, "first-token-hit");

        let _ = std::fs::remove_file(db_path);
    }

    fn sample_usage_row() -> UsageRow {
        UsageRow {
            id: "sample".into(),
            upstream_user_id: None,
            api_key_id: None,
            upstream_account_id: None,
            request_id: None,
            created_at: "2026-06-28T00:00:00+08:00".into(),
            model: "gpt-4.1".into(),
            reasoning_effort: None,
            endpoint: None,
            upstream_endpoint: None,
            group_id: None,
            subscription_id: None,
            actual_cost: 0.0,
            total_cost: 0.0,
            input_tokens: 0,
            output_tokens: 0,
            input_cost: None,
            output_cost: None,
            cache_creation_tokens: None,
            cache_read_tokens: None,
            cache_creation_5m_tokens: None,
            cache_creation_1h_tokens: None,
            cache_creation_cost: None,
            cache_read_cost: None,
            total_tokens: 0,
            first_token_ms: None,
            duration_ms: None,
            billing_mode: None,
            request_type: None,
            stream: None,
            openai_ws_mode: None,
            billing_type: None,
            service_tier: None,
            long_context_billing_applied: None,
            image_count: None,
            image_input_tokens: None,
            image_size: None,
            image_input_size: None,
            image_output_size: None,
            image_output_tokens: None,
            image_input_cost: None,
            image_output_cost: None,
            image_size_source: None,
            image_size_breakdown: None,
            media_type: None,
            rate_multiplier: None,
            user_agent: None,
            ip_address: None,
            cache_ttl_overridden: None,
            api_key_name: None,
            platform: None,
            subscription_name: None,
            group_name: None,
            subscription_type: None,
        }
    }
}

fn select_subscription_keys(
    keys: Vec<crate::contracts::ManagedKeyRecord>,
    requested_key_ids: &[String],
) -> Vec<crate::contracts::ManagedKeyRecord> {
    if requested_key_ids.is_empty() {
        return keys;
    }

    let requested_set = requested_key_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>();

    keys.into_iter()
        .filter(|item| requested_set.contains(item.key.id.as_str()))
        .collect()
}

fn build_subscription_key_usage_payload(
    keys: Vec<crate::contracts::ManagedKeyRecord>,
    stats_by_api_key_id: std::collections::HashMap<i64, ApiKeyUsageStatsRecord>,
) -> SubscriptionKeyUsagePayload {
    let items = keys
        .into_iter()
        .map(|key| {
            let fallback_api_key_id = key.key.id.parse::<i64>().ok();
            let stat = key
                .api_key_id
                .and_then(|api_key_id| stats_by_api_key_id.get(&api_key_id))
                .or_else(|| {
                    fallback_api_key_id.and_then(|api_key_id| stats_by_api_key_id.get(&api_key_id))
                });
            SubscriptionKeyUsageItem {
                key_id: key.key.id,
                api_key_id: key.api_key_id,
                raw_key_available: key
                    .raw_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some(),
                key_name: key.key.name,
                status: key.key.status,
                platform: key.key.platform,
                group_name: key.key.group_name,
                plan_name: None,
                quota_mode: None,
                quota_remaining: None,
                quota_limit: None,
                requests: stat.map(|item| item.requests).unwrap_or(0),
                input_tokens: stat.map(|item| item.input_tokens).unwrap_or(0),
                output_tokens: stat.map(|item| item.output_tokens).unwrap_or(0),
                total_tokens: stat.map(|item| item.total_tokens).unwrap_or(0),
                actual_cost: stat.map(|item| item.actual_cost).unwrap_or(0.0),
            }
        })
        .collect::<Vec<_>>();

    let total_requests = items.iter().map(|item| item.requests).sum();
    let total_input_tokens = items.iter().map(|item| item.input_tokens).sum();
    let total_output_tokens = items.iter().map(|item| item.output_tokens).sum();
    let total_tokens = items.iter().map(|item| item.total_tokens).sum();
    let total_actual_cost = items.iter().map(|item| item.actual_cost).sum();
    let active_key_count = items.iter().filter(|item| item.status == "active").count() as i64;
    let inactive_key_count = items.len() as i64 - active_key_count;

    SubscriptionKeyUsagePayload {
        items,
        total_requests,
        total_input_tokens,
        total_output_tokens,
        total_tokens,
        total_actual_cost,
        active_key_count,
        inactive_key_count,
    }
}

async fn resolve_api_key_id_filter(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
) -> Option<String> {
    if let Ok(api_key_id) = key_id.parse::<i64>() {
        return Some(api_key_id.to_string());
    }

    data_center_service::fetch_keys(ctx, account_id, UpstreamRequestPolicy::ReadOnly)
        .await
        .ok()
        .and_then(|keys| {
            keys.into_iter()
                .find(|item| item.key.id == key_id)
                .and_then(|item| item.api_key_id)
                .map(|value| value.to_string())
        })
        .or_else(|| Some("-1".to_string()))
}

fn find_managed_key(
    keys: Vec<crate::contracts::ManagedKeyRecord>,
    key_id: &str,
) -> Option<crate::contracts::ManagedKeyRecord> {
    keys.into_iter().find(|item| {
        item.key.id == key_id
            || item
                .api_key_id
                .map(|value| value.to_string())
                .is_some_and(|value| value == key_id)
    })
}
