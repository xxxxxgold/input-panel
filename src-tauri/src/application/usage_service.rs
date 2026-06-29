use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{DateTime, Local, NaiveDate};

use crate::contracts::{
    DailyUsagePoint, DashboardModelsPayload, PaginatedResult, UsageRow, UsageStatsRecord,
    UsageTrendPayload,
};
use crate::infrastructure::sqlite::repositories;

use super::{data_center_service, AppContext};

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
    maybe_sync_usage_range(ctx, account_id, &query).await?;
    repositories::list_usage_rows_page(
        &ctx.db,
        account_id,
        parse_api_key_id_filter(query.api_key_id.as_deref()),
        query.start_date.as_deref(),
        query.end_date.as_deref(),
        query.page,
        query.page_size,
    )
}

pub async fn get_usage_stats(
    ctx: &AppContext,
    account_id: &str,
    query: UsageStatsQuery,
) -> Result<UsageStatsRecord> {
    let rows = load_cached_usage_rows(ctx, account_id, &build_usage_list_query_from_stats_query(&query)).await?;
    Ok(build_usage_stats_from_rows(rows, &query))
}

pub async fn get_dashboard_models(
    ctx: &AppContext,
    account_id: &str,
    query: UsageStatsQuery,
) -> Result<DashboardModelsPayload> {
    let rows_query = build_dashboard_usage_query(&query);
    let rows = load_cached_usage_rows(
        ctx,
        account_id,
        &rows_query,
    )
    .await?;
    Ok(build_models_payload_from_rows(rows))
}

pub async fn get_dashboard_trend(
    ctx: &AppContext,
    account_id: &str,
    query: UsageStatsQuery,
) -> Result<UsageTrendPayload> {
    let rows_query = build_dashboard_usage_query(&query);
    let rows = load_cached_usage_rows(
        ctx,
        account_id,
        &rows_query,
    )
    .await?;
    Ok(build_trend_payload_from_rows(rows))
}

pub async fn get_key_daily_usage(
    ctx: &AppContext,
    account_id: &str,
    key_id: &str,
    days: i64,
) -> Result<Vec<DailyUsagePoint>> {
    let now = Local::now().date_naive();
    let start = (now - chrono::Days::new(days.saturating_sub(1).max(0) as u64)).to_string();
    let end = now.to_string();
    let api_key_filter = repositories::find_key_cache(&ctx.db, account_id, key_id)?
        .and_then(|record| record.row.api_key_id.map(|value| value.to_string()))
        .or_else(|| Some(key_id.to_string()));
    let rows = load_cached_usage_rows(
        ctx,
        account_id,
        &UsageListQuery {
            api_key_id: api_key_filter,
            start_date: Some(start),
            end_date: Some(end),
            ..UsageListQuery::default()
        },
    )
    .await?;
    Ok(build_daily_usage_points(rows))
}

async fn load_cached_usage_rows(
    ctx: &AppContext,
    account_id: &str,
    query: &UsageListQuery,
) -> Result<Vec<UsageRow>> {
    maybe_sync_usage_range(ctx, account_id, query).await?;
    let rows = repositories::list_usage_row_cache(
        &ctx.db,
        account_id,
        parse_api_key_id_filter(query.api_key_id.as_deref()),
        query.start_date.as_deref(),
        query.end_date.as_deref(),
    )?
        .into_iter()
        .map(|record| record.row)
        .collect::<Vec<_>>();
    Ok(filter_usage_rows(
        rows,
        query.api_key_id.as_deref(),
        query.start_date.as_deref(),
        query.end_date.as_deref(),
        None,
    ))
}

fn build_usage_stats_from_rows(rows: Vec<UsageRow>, query: &UsageStatsQuery) -> UsageStatsRecord {
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

    let stats = UsageStatsRecord {
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
    };

    apply_usage_rate_fallback(stats, query, Local::now())
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

fn build_trend_payload_from_rows(rows: Vec<UsageRow>) -> UsageTrendPayload {
    if rows.is_empty() {
        return UsageTrendPayload {
            start_date: String::new(),
            end_date: String::new(),
            granularity: Some("day".into()),
            trend: Vec::new(),
        };
    }
    let trend = build_daily_usage_points(rows);
    let start_date = trend.first().map(|item| item.date.clone()).unwrap_or_default();
    let end_date = trend.last().map(|item| item.date.clone()).unwrap_or_default();

    UsageTrendPayload {
        start_date,
        end_date,
        granularity: Some("day".into()),
        trend,
    }
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
        entry.cache_read_tokens = Some(entry.cache_read_tokens.unwrap_or(0) + row.cache_read_tokens.unwrap_or(0));
        entry.cache_write_tokens = Some(entry.cache_write_tokens.unwrap_or(0) + row.cache_creation_tokens.unwrap_or(0));
        entry.total_tokens = Some(entry.total_tokens.unwrap_or(0) + row.total_tokens);
        entry.actual_cost = Some(entry.actual_cost.unwrap_or(0.0) + row.actual_cost);
        entry.total_cost = Some(entry.total_cost.unwrap_or(0.0) + row.total_cost);
    }
    grouped.into_values().collect()
}

fn build_dashboard_usage_query(query: &UsageStatsQuery) -> UsageListQuery {
    let today = Local::now().date_naive();
    let days = query
        .period
        .as_deref()
        .and_then(|period| period.strip_prefix("days:"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(7);
    let default_start = (today - chrono::Days::new(days.saturating_sub(1).max(0) as u64)).to_string();
    let default_end = today.to_string();

    UsageListQuery {
        api_key_id: query.api_key_id.clone(),
        start_date: Some(query.start_date.clone().unwrap_or(default_start)),
        end_date: Some(query.end_date.clone().unwrap_or(default_end)),
        ..UsageListQuery::default()
    }
}

fn build_usage_list_query_from_stats_query(query: &UsageStatsQuery) -> UsageListQuery {
    let today = Local::now().date_naive().to_string();
    let (start_date, end_date) = match query.period.as_deref() {
        Some("today") if query.start_date.is_none() && query.end_date.is_none() => {
            (Some(today.clone()), Some(today))
        }
        _ => (query.start_date.clone(), query.end_date.clone()),
    };
    UsageListQuery {
        api_key_id: query.api_key_id.clone(),
        start_date,
        end_date,
        ..UsageListQuery::default()
    }
}

async fn maybe_sync_usage_range(
    ctx: &AppContext,
    account_id: &str,
    query: &UsageListQuery,
) -> Result<()> {
    let Some(start_date) = query.start_date.as_deref().and_then(parse_usage_date) else {
        return Ok(());
    };
    let Some(end_date) = query.end_date.as_deref().and_then(parse_usage_date) else {
        return Ok(());
    };
    let today = Local::now().date_naive();
    let default_start = today - chrono::Days::new(34);
    if start_date >= default_start && end_date <= today {
        let cached = repositories::list_usage_row_cache(
            &ctx.db,
            account_id,
            None,
            query.start_date.as_deref(),
            query.end_date.as_deref(),
        )?;
        if !cached.is_empty() {
            return Ok(());
        }
    }
    data_center_service::sync_usage_scope(
        ctx,
        account_id,
        crate::contracts::DataSyncTrigger::Manual,
        Some(start_date.to_string()),
        Some(end_date.to_string()),
    )
    .await
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

fn apply_usage_rate_fallback(
    mut stats: UsageStatsRecord,
    query: &UsageStatsQuery,
    now: DateTime<Local>,
) -> UsageStatsRecord {
    let Some(window_minutes) = infer_usage_window_minutes(query, now) else {
        return stats;
    };

    if stats.rpm.is_none() {
        stats.rpm = Some(stats.total_requests as f64 / window_minutes);
    }
    if stats.tpm.is_none() {
        stats.tpm = Some(stats.total_tokens as f64 / window_minutes);
    }

    stats
}

fn infer_usage_window_minutes(query: &UsageStatsQuery, now: DateTime<Local>) -> Option<f64> {
    let today = now.date_naive();
    let period_day = match query.period.as_deref() {
        Some("today") => Some(today),
        _ => None,
    };
    let parsed_start_date = query.start_date.as_deref().and_then(parse_usage_date);
    let parsed_end_date = query.end_date.as_deref().and_then(parse_usage_date);
    let start_date = query
        .start_date
        .as_deref()
        .and_then(parse_usage_date)
        .or(period_day)
        .or(parsed_end_date)?;
    let end_date = query
        .end_date
        .as_deref()
        .and_then(parse_usage_date)
        .or(period_day)
        .or(parsed_start_date)
        .or(Some(start_date))?;

    let start_dt = start_date.and_hms_opt(0, 0, 0)?;
    let end_dt = if end_date >= today {
        now.naive_local()
    } else {
        end_date.and_hms_opt(23, 59, 59)?
    };
    if end_dt < start_dt {
        return None;
    }

    let elapsed_seconds = (end_dt - start_dt).num_seconds().max(60) as f64;
    Some(elapsed_seconds / 60.0)
}

#[cfg(test)]
mod tests {
    use chrono::{Local, TimeZone};

    use super::{apply_usage_rate_fallback, build_dashboard_usage_query, infer_usage_window_minutes, UsageStatsQuery};
    use crate::contracts::UsageStatsRecord;

    fn sample_stats() -> UsageStatsRecord {
        UsageStatsRecord {
            total_requests: 120,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_tokens: Some(0),
            total_cache_creation_tokens: Some(0),
            total_cache_read_tokens: Some(0),
            total_tokens: 24_000,
            total_cost: 0.0,
            total_actual_cost: 0.0,
            average_duration_ms: 0.0,
            rpm: None,
            tpm: None,
        }
    }

    #[test]
    fn infers_today_window_until_now() {
        let now = Local
            .with_ymd_and_hms(2026, 6, 15, 12, 0, 0)
            .single()
            .expect("valid local datetime");
        let minutes = infer_usage_window_minutes(
            &UsageStatsQuery {
                period: Some("today".into()),
                ..UsageStatsQuery::default()
            },
            now,
        )
        .expect("today window minutes");

        assert_eq!(minutes, 720.0);
    }

    #[test]
    fn fills_missing_rates_from_query_window() {
        let now = Local
            .with_ymd_and_hms(2026, 6, 15, 12, 0, 0)
            .single()
            .expect("valid local datetime");
        let stats = apply_usage_rate_fallback(
            sample_stats(),
            &UsageStatsQuery {
                start_date: Some("2026-06-14".into()),
                end_date: Some("2026-06-15".into()),
                ..UsageStatsQuery::default()
            },
            now,
        );

        assert_eq!(stats.rpm, Some(120.0 / 2160.0));
        assert_eq!(stats.tpm, Some(24_000.0 / 2160.0));
    }

    #[test]
    fn keeps_upstream_rates_when_present() {
        let now = Local
            .with_ymd_and_hms(2026, 6, 15, 12, 0, 0)
            .single()
            .expect("valid local datetime");
        let stats = apply_usage_rate_fallback(
            UsageStatsRecord {
                rpm: Some(8.5),
                tpm: Some(12_345.0),
                ..sample_stats()
            },
            &UsageStatsQuery {
                period: Some("today".into()),
                ..UsageStatsQuery::default()
            },
            now,
        );

        assert_eq!(stats.rpm, Some(8.5));
        assert_eq!(stats.tpm, Some(12_345.0));
    }

    #[test]
    fn dashboard_query_preserves_explicit_filter_window() {
        let query = build_dashboard_usage_query(&UsageStatsQuery {
            period: Some("days:7".into()),
            api_key_id: Some("3641".into()),
            start_date: Some("2026-06-28".into()),
            end_date: Some("2026-06-28".into()),
        });

        assert_eq!(query.api_key_id.as_deref(), Some("3641"));
        assert_eq!(query.start_date.as_deref(), Some("2026-06-28"));
        assert_eq!(query.end_date.as_deref(), Some("2026-06-28"));
    }
}

fn parse_api_key_id_filter(value: Option<&str>) -> Option<i64> {
    value.and_then(|item| item.parse::<i64>().ok())
}
