use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{DateTime, Local, NaiveDate};

use crate::contracts::{
    DailyUsagePoint, DashboardModelsPayload, PaginatedResult, UsageRow, UsageStatsRecord,
    UsageTrendPayload,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::normalizers::{
    build_paginated, normalize_daily_usage_rows, normalize_items, normalize_models_payload,
    normalize_trend_payload, normalize_usage_row, normalize_usage_stats,
};

use super::{proxy_service, AppContext};

#[derive(Debug, Clone, Default)]
pub struct UsageListQuery {
    pub page: i64,
    pub page_size: i64,
    pub api_key_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageStatsQuery {
    pub period: Option<String>,
    pub api_key_id: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

pub async fn list_usage_records(
    ctx: &AppContext,
    account_id: &str,
    query: UsageListQuery,
) -> Result<PaginatedResult<UsageRow>> {
    let params = build_query_params(&[
        ("page", Some(query.page.to_string())),
        ("page_size", Some(query.page_size.to_string())),
        ("api_key_id", query.api_key_id),
        ("start_date", query.start_date),
        ("end_date", query.end_date),
    ]);
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/usage?{params}"),
        "GET",
        None,
    )
    .await?;
    let items = normalize_items(&raw)
        .iter()
        .map(normalize_usage_row)
        .collect();
    Ok(build_paginated(&raw, items, query.page, query.page_size))
}

pub async fn get_usage_stats(
    ctx: &AppContext,
    account_id: &str,
    query: UsageStatsQuery,
) -> Result<UsageStatsRecord> {
    let params = build_query_params(&[
        ("period", query.period.clone()),
        ("api_key_id", query.api_key_id.clone()),
        ("start_date", query.start_date.clone()),
        ("end_date", query.end_date.clone()),
    ]);
    let path = if params.is_empty() {
        "/api/v1/usage/stats".to_string()
    } else {
        format!("/api/v1/usage/stats?{params}")
    };
    let raw = match proxy_service::account_proxy_request(ctx, account_id, &path, "GET", None).await {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            return Ok(build_usage_stats_from_snapshot(
                load_snapshot_rows(ctx, account_id)?,
                &query,
            ))
        }
        Err(error) => return Err(error),
    };
    Ok(normalize_usage_stats(&raw))
}

pub async fn get_dashboard_models(
    ctx: &AppContext,
    account_id: &str,
    days: i64,
) -> Result<DashboardModelsPayload> {
    let raw = match proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/usage/dashboard/models?days={days}"),
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            return Ok(build_models_payload_from_rows(load_snapshot_rows(ctx, account_id)?))
        }
        Err(error) => return Err(error),
    };
    Ok(normalize_models_payload(&raw))
}

pub async fn get_dashboard_trend(
    ctx: &AppContext,
    account_id: &str,
    days: i64,
) -> Result<UsageTrendPayload> {
    let raw = match proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/usage/dashboard/trend?days={days}"),
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) if is_optional_endpoint_unavailable(&error) => {
            return Ok(build_trend_payload_from_snapshot(
                load_snapshot(ctx, account_id)?,
                days,
            ))
        }
        Err(error) => return Err(error),
    };
    Ok(normalize_trend_payload(&raw))
}

pub async fn get_key_daily_usage(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    days: i64,
) -> Result<Vec<DailyUsagePoint>> {
    let raw = proxy_service::account_proxy_request(
        ctx,
        account_id,
        &format!("/api/v1/user/api-keys/{key_id}/usage/daily?days={days}"),
        "GET",
        None,
    )
    .await?;
    let items = normalize_items(&raw);
    Ok(normalize_daily_usage_rows(&items))
}

fn build_query_params(entries: &[(&str, Option<String>)]) -> String {
    entries
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_ref()
                .filter(|value| !value.is_empty())
                .map(|value| format!("{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn load_snapshot(ctx: &AppContext, account_id: &str) -> Result<Option<crate::contracts::AccountSnapshot>> {
    Ok(repositories::read_state(&ctx.db)?
        .snapshots
        .get(account_id)
        .cloned())
}

fn load_snapshot_rows(ctx: &AppContext, account_id: &str) -> Result<Vec<UsageRow>> {
    Ok(load_snapshot(ctx, account_id)?
        .map(|snapshot| {
            if !snapshot.request_history.is_empty() {
                snapshot
                    .request_history
                    .iter()
                    .map(|row| UsageRow {
                        id: row.id.clone(),
                        api_key_id: row.api_key_id,
                        created_at: row.created_at.clone(),
                        model: row.model.clone(),
                        reasoning_effort: row.reasoning_effort.clone(),
                        endpoint: row.endpoint.clone(),
                        upstream_endpoint: row.upstream_endpoint.clone(),
                        actual_cost: row.actual_cost,
                        total_cost: row.total_cost,
                        input_tokens: row.input_tokens,
                        output_tokens: row.output_tokens,
                        input_cost: row.input_cost,
                        output_cost: row.output_cost,
                        cache_creation_tokens: row.cache_creation_tokens,
                        cache_read_tokens: row.cache_read_tokens,
                        cache_creation_cost: row.cache_creation_cost,
                        cache_read_cost: row.cache_read_cost,
                        total_tokens: row.total_tokens,
                        first_token_ms: row.first_token_ms,
                        duration_ms: row.duration_ms,
                        billing_mode: row.billing_mode.clone(),
                        request_type: row.request_type.clone(),
                        stream: row.stream,
                        billing_type: row.billing_type,
                        rate_multiplier: row.rate_multiplier,
                        user_agent: row.user_agent.clone(),
                        api_key_name: row.api_key_name.clone(),
                        platform: row.platform.clone(),
                        subscription_name: row.subscription_name.clone(),
                        group_name: row.group_name.clone(),
                        subscription_type: row.subscription_type.clone(),
                    })
                    .collect()
            } else {
                snapshot.recent_usage
            }
        })
        .unwrap_or_default())
}

fn build_usage_stats_from_snapshot(rows: Vec<UsageRow>, query: &UsageStatsQuery) -> UsageStatsRecord {
    let filtered = filter_usage_rows(
        rows,
        query.api_key_id.as_deref(),
        query.start_date.as_deref(),
        query.end_date.as_deref(),
        query.period.as_deref(),
    );
    let duration_count = filtered.iter().filter(|row| row.duration_ms.is_some()).count() as f64;
    let duration_total = filtered
        .iter()
        .filter_map(|row| row.duration_ms.map(|value| value as f64))
        .sum::<f64>();

    UsageStatsRecord {
        total_requests: filtered.len() as i64,
        total_input_tokens: filtered.iter().map(|row| row.input_tokens).sum(),
        total_output_tokens: filtered.iter().map(|row| row.output_tokens).sum(),
        total_cache_tokens: Some(
            filtered
                .iter()
                .map(|row| row.cache_read_tokens.unwrap_or(0) + row.cache_creation_tokens.unwrap_or(0))
                .sum(),
        ),
        total_cache_creation_tokens: Some(
            filtered
                .iter()
                .map(|row| row.cache_creation_tokens.unwrap_or(0))
                .sum(),
        ),
        total_cache_read_tokens: Some(filtered.iter().map(|row| row.cache_read_tokens.unwrap_or(0)).sum()),
        total_tokens: filtered.iter().map(|row| row.total_tokens).sum(),
        total_cost: filtered.iter().map(|row| row.total_cost).sum(),
        total_actual_cost: filtered.iter().map(|row| row.actual_cost).sum(),
        average_duration_ms: if duration_count > 0.0 {
            duration_total / duration_count
        } else {
            0.0
        },
        rpm: None,
        tpm: None,
    }
}

fn build_models_payload_from_rows(rows: Vec<UsageRow>) -> DashboardModelsPayload {
    let (start_date, end_date) = infer_date_bounds(&rows);
    let mut grouped = BTreeMap::<String, crate::contracts::ModelUsagePoint>::new();
    for row in rows {
        let entry = grouped
            .entry(row.model.clone())
            .or_insert_with(|| crate::contracts::ModelUsagePoint {
                model: row.model.clone(),
                requests: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                total_tokens: 0,
                cost: Some(0.0),
                actual_cost: Some(0.0),
            });
        entry.requests += 1;
        entry.input_tokens += row.input_tokens;
        entry.output_tokens += row.output_tokens;
        entry.cache_creation_tokens = Some(
            entry.cache_creation_tokens.unwrap_or(0) + row.cache_creation_tokens.unwrap_or(0),
        );
        entry.cache_read_tokens =
            Some(entry.cache_read_tokens.unwrap_or(0) + row.cache_read_tokens.unwrap_or(0));
        entry.total_tokens += row.total_tokens;
        entry.cost = Some(entry.cost.unwrap_or(0.0) + row.total_cost);
        entry.actual_cost = Some(entry.actual_cost.unwrap_or(0.0) + row.actual_cost);
    }
    let mut models = grouped.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| {
        right
            .actual_cost
            .unwrap_or(0.0)
            .partial_cmp(&left.actual_cost.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right.requests.cmp(&left.requests))
    });

    DashboardModelsPayload {
        start_date,
        end_date,
        models,
    }
}

fn build_trend_payload_from_snapshot(
    snapshot: Option<crate::contracts::AccountSnapshot>,
    days: i64,
) -> UsageTrendPayload {
    let Some(snapshot) = snapshot else {
        return UsageTrendPayload {
            start_date: String::new(),
            end_date: String::new(),
            granularity: Some("day".into()),
            trend: Vec::new(),
        };
    };

    let cutoff = Local::now().date_naive() - chrono::Days::new(days.saturating_sub(1).max(0) as u64);
    let trend = snapshot
        .trend
        .into_iter()
        .filter(|item| parse_usage_date(&item.bucket).is_none_or(|date| date >= cutoff))
        .map(|item| DailyUsagePoint {
            date: item.bucket,
            requests: item.requests,
            input_tokens: item.input_tokens,
            output_tokens: item.output_tokens,
            cache_read_tokens: Some(item.cache_read_tokens),
            cache_write_tokens: Some(item.cache_creation_tokens),
            total_tokens: Some(item.total_tokens),
            actual_cost: Some(item.actual_cost),
            total_cost: Some(item.total_cost),
        })
        .collect::<Vec<_>>();
    let start_date = trend.first().map(|item| item.date.clone()).unwrap_or_default();
    let end_date = trend.last().map(|item| item.date.clone()).unwrap_or_default();

    UsageTrendPayload {
        start_date,
        end_date,
        granularity: Some("day".into()),
        trend,
    }
}

fn filter_usage_rows(
    rows: Vec<UsageRow>,
    api_key_id: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
    period: Option<&str>,
) -> Vec<UsageRow> {
    let today = Local::now().date_naive();
    let period_start = match period {
        Some("today") => Some(today),
        _ => None,
    };
    let start = start_date.and_then(parse_usage_date).or(period_start);
    let end = end_date.and_then(parse_usage_date).or(period_start);

    rows.into_iter()
        .filter(|row| {
            let key_matches = api_key_id
                .map(|expected| row.api_key_id.map(|value| value.to_string()) == Some(expected.to_string()))
                .unwrap_or(true);
            let date = parse_usage_date(&row.created_at);
            let start_matches = start.is_none_or(|value| date.is_some_and(|date| date >= value));
            let end_matches = end.is_none_or(|value| date.is_some_and(|date| date <= value));
            key_matches && start_matches && end_matches
        })
        .collect()
}

fn infer_date_bounds(rows: &[UsageRow]) -> (String, String) {
    let dates = rows
        .iter()
        .filter_map(|row| parse_usage_date(&row.created_at).map(|date| date.to_string()))
        .collect::<Vec<_>>();
    (
        dates.first().cloned().unwrap_or_default(),
        dates.last().cloned().unwrap_or_default(),
    )
}

fn parse_usage_date(value: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.naive_local().date())
        .or_else(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn is_optional_endpoint_unavailable(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("未找到可用的接口路径") || message.contains("404")
}
