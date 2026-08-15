use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{de, Deserialize, Deserializer};

use crate::contracts::{
    CodexRadarDegradationAlert, CodexRadarFastRadarItem, CodexRadarFastRadarPayload,
    CodexRadarFastRadarSummary, CodexRadarInsightsPayload, CodexRadarInsightsTrendPoint,
    CodexRadarIntelligenceDetailItem, CodexRadarIntelligenceEfficiencyPoint,
    CodexRadarIntelligenceHistoryPoint, CodexRadarIntelligencePayload, CodexRadarModelIqEntry,
    CodexRadarModelIqPayload, CodexRadarRecommendationGroup, CodexRadarRecommendationItem,
};
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::{
    repositories::{
        self, CodexRadarFastCacheRecord, CodexRadarInsightsCacheRecord,
        CodexRadarIntelligenceCacheRecord, CodexRadarModelIqCacheRecord,
    },
    Database,
};
use crate::infrastructure::upstream_http_client::upstream_http_client_builder;

use super::AppContext;

const CODEX_RADAR_CURRENT_URL: &str = "https://codexradar.com/current.json";
const CODEX_RADAR_HOME_URL: &str = "https://codexradar.com/";
const CODEX_RADAR_INTELLIGENCE_URL: &str =
    "https://codexradar.com/data/intelligence-efficiency.json";
const CODEX_RADAR_INSIGHTS_URL: &str = "https://codexradar.com/api/radar-insights";
const CODEX_RADAR_INSIGHTS_REFRESH_URL: &str =
    "https://codexradar.com/api/radar-insights?refresh=1";
const CODEX_RADAR_REQUEST_TIMEOUT_SECS: u64 = 10;
const CODEX_RADAR_SCHEMA_VERSION: &str = "2.0";
const CODEX_RADAR_PUBLIC_SUMMARY_TYPE: &str = "public_summary";
const CODEX_RADAR_INTELLIGENCE_SCHEMA: i64 = 2;
const CODEX_RADAR_INTELLIGENCE_TYPE: &str = "distributed_intelligence_efficiency";
const CODEX_RADAR_INSIGHTS_SCHEMA: i64 = 1;

#[derive(Debug, Deserialize)]
struct CodexRadarCurrentResponse {
    schema_version: String,
    #[serde(rename = "type")]
    response_type: String,
    model_iq: CodexRadarModelIqSummary,
}

#[derive(Debug, Deserialize)]
struct CodexRadarModelIqSummary {
    latest: CodexRadarModelIqLatest,
    comparisons: BTreeMap<String, CodexRadarModelIqComparison>,
    #[serde(default)]
    recent_days: Vec<CodexRadarModelIqLatest>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarModelIqComparison {
    label: String,
    model: String,
    reasoning_effort: String,
    latest: CodexRadarModelIqLatest,
    #[serde(default)]
    recent_days: Vec<CodexRadarModelIqLatest>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarModelIqLatest {
    date: String,
    score: f64,
    status: String,
    passed: i64,
    average_cost_usd: f64,
    model: Option<String>,
    reasoning_effort: Option<String>,
    tasks: Option<i64>,
    valid_tasks: Option<i64>,
    total_tokens: Option<i64>,
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    wall_seconds: Option<i64>,
    average_task_seconds: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarIntelligenceResponse {
    schema: i64,
    #[serde(rename = "type")]
    response_type: String,
    source_updated_at: String,
    points: Vec<CodexRadarIntelligenceRawPoint>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarIntelligenceRawPoint {
    model: String,
    effort: String,
    iq: f64,
    #[serde(deserialize_with = "deserialize_integral_i64")]
    passed: i64,
    #[serde(deserialize_with = "deserialize_integral_i64")]
    valid_tasks: i64,
    average_price_usd: Option<f64>,
    average_minutes: Option<f64>,
    combined_cost_index: Option<f64>,
    total_runs: i64,
    latest_graded_at: String,
}

/// 兼容上游把整数计数写成 `210.0`，但拒绝真实小数以保持计数语义。
fn deserialize_integral_i64<'de, D>(deserializer: D) -> std::result::Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let number = serde_json::Number::deserialize(deserializer)?;
    if let Some(value) = number.as_i64() {
        return Ok(value);
    }
    if let Some(value) = number.as_u64() {
        return i64::try_from(value)
            .map_err(|_| de::Error::custom(format!("Codex Radar 计数超出 i64 范围: {number}")));
    }

    let value = number.to_string();
    let Some((integer, fraction)) = value.split_once('.') else {
        return Err(de::Error::custom(format!(
            "Codex Radar 计数必须是整数: {value}"
        )));
    };
    if !fraction.chars().all(|digit| digit == '0') {
        return Err(de::Error::custom(format!(
            "Codex Radar 计数必须是整数: {value}"
        )));
    }

    integer
        .parse::<i64>()
        .map_err(|_| de::Error::custom(format!("Codex Radar 计数超出 i64 范围: {value}")))
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsResponse {
    schema: i64,
    source_updated_at: String,
    recommendations: Vec<CodexRadarInsightsRecommendationGroup>,
    degradation_alerts: CodexRadarInsightsDegradationGroup,
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsRecommendationGroup {
    key: String,
    title: String,
    rule: String,
    items: Vec<CodexRadarInsightsRecommendationItem>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsRecommendationItem {
    model: String,
    effort: String,
    iq: f64,
    average_cost_usd: Option<f64>,
    average_duration_minutes: Option<f64>,
    slot: Option<String>,
    #[serde(default)]
    trend_48h: Vec<CodexRadarInsightsRawTrendPoint>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsDegradationGroup {
    rule: String,
    items: Vec<CodexRadarInsightsDegradationAlert>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsDegradationAlert {
    model: String,
    effort: String,
    #[serde(alias = "iq")]
    current_iq: f64,
    average_iq_24h: Option<f64>,
    average_iq_48h: Option<f64>,
    degradation_12h_iq: Option<f64>,
    from_24h_average_iq: Option<f64>,
    from_48h_average_iq: Option<f64>,
    degradation_severity_score: Option<f64>,
    #[serde(default)]
    trend_48h: Vec<CodexRadarInsightsRawTrendPoint>,
}

#[derive(Debug, Deserialize)]
struct CodexRadarInsightsRawTrendPoint {
    timestamp: String,
    iq: f64,
    samples: Option<i64>,
}

pub async fn get_codex_radar_model_iq(ctx: &AppContext) -> Result<CodexRadarModelIqPayload> {
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    resolve_codex_radar_model_iq_fetch(&ctx.db, fetch_codex_radar_model_iq(use_system_proxy).await)
}

pub async fn get_codex_radar_intelligence(
    ctx: &AppContext,
) -> Result<CodexRadarIntelligencePayload> {
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    resolve_codex_radar_intelligence_fetch(
        &ctx.db,
        fetch_codex_radar_intelligence(use_system_proxy).await,
    )
}

pub async fn get_codex_radar_fast(ctx: &AppContext) -> Result<CodexRadarFastRadarPayload> {
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    resolve_codex_radar_fast_fetch(&ctx.db, fetch_codex_radar_fast(use_system_proxy).await)
}

/// 读取上游场景推荐与降智预警，并在失败时回退独立本地快照。
pub async fn get_codex_radar_insights(
    ctx: &AppContext,
    force: bool,
) -> Result<CodexRadarInsightsPayload> {
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    resolve_codex_radar_insights_fetch(
        &ctx.db,
        fetch_codex_radar_insights(force, use_system_proxy).await,
    )
}

fn resolve_codex_radar_model_iq_fetch(
    db: &Database,
    result: Result<CodexRadarModelIqPayload>,
) -> Result<CodexRadarModelIqPayload> {
    match result {
        Ok(payload) => {
            repositories::upsert_codex_radar_model_iq_cache(
                db,
                &CodexRadarModelIqCacheRecord {
                    payload_json: serde_json::to_string(&payload)
                        .context("序列化 Codex Radar IQ 缓存失败")?,
                    source_updated_at: payload.source_updated_at.clone(),
                    fetched_at: payload.fetched_at.clone(),
                    last_error: None,
                },
            )
            .context("保存 Codex Radar IQ 缓存失败")?;
            Ok(payload)
        }
        Err(error) => {
            let error_message = error.to_string();
            let Some(cache) = repositories::find_codex_radar_model_iq_cache(db)
                .context("读取 Codex Radar IQ 缓存失败")?
            else {
                return Err(error);
            };

            repositories::update_codex_radar_model_iq_cache_error(db, Some(&error_message))
                .context("记录 Codex Radar IQ 刷新错误失败")?;
            let payload = build_cached_payload(cache, Some(error_message))?;
            // 旧版 current.json Top 5 总会持有 status，不能作为智力效率快照的 stale 回退。
            if payload.items.iter().any(|entry| entry.status.is_some()) {
                return Err(error);
            }
            Ok(payload)
        }
    }
}

fn resolve_codex_radar_insights_fetch(
    db: &Database,
    result: Result<CodexRadarInsightsPayload>,
) -> Result<CodexRadarInsightsPayload> {
    match result {
        Ok(payload) => {
            repositories::upsert_codex_radar_insights_cache(
                db,
                &CodexRadarInsightsCacheRecord {
                    payload_json: serde_json::to_string(&payload)
                        .context("序列化 Codex Radar 推荐预警缓存失败")?,
                    source_updated_at: payload.source_updated_at.clone(),
                    fetched_at: payload.fetched_at.clone(),
                    last_error: None,
                },
            )
            .context("保存 Codex Radar 推荐预警缓存失败")?;
            Ok(payload)
        }
        Err(error) => {
            let error_message = error.to_string();
            let Some(cache) = repositories::find_codex_radar_insights_cache(db)
                .context("读取 Codex Radar 推荐预警缓存失败")?
            else {
                return Err(error);
            };

            repositories::update_codex_radar_insights_cache_error(db, Some(&error_message))
                .context("记录 Codex Radar 推荐预警刷新错误失败")?;
            build_cached_insights_payload(cache, Some(error_message))
        }
    }
}

async fn fetch_codex_radar_model_iq(use_system_proxy: bool) -> Result<CodexRadarModelIqPayload> {
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(Duration::from_secs(CODEX_RADAR_REQUEST_TIMEOUT_SECS))
        .build()
        .context("初始化 Codex Radar IQ 请求客户端失败")?;
    let raw = fetch_codex_radar_json(
        &client,
        CODEX_RADAR_INTELLIGENCE_URL,
        "Codex Radar 智力效率",
    )
    .await?;
    let intelligence = serde_json::from_str::<CodexRadarIntelligenceResponse>(&raw)
        .map_err(|error| anyhow!("解析 Codex Radar 智力效率响应失败: {error}"))?;

    build_model_iq_payload_from_intelligence(intelligence, now_storage_timestamp())
}

async fn fetch_codex_radar_intelligence(
    use_system_proxy: bool,
) -> Result<CodexRadarIntelligencePayload> {
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(Duration::from_secs(CODEX_RADAR_REQUEST_TIMEOUT_SECS))
        .build()
        .context("初始化 Codex Radar 智力效率请求客户端失败")?;
    let (current_raw, intelligence_raw) = tokio::try_join!(
        fetch_codex_radar_json(&client, CODEX_RADAR_CURRENT_URL, "Codex Radar IQ"),
        fetch_codex_radar_json(
            &client,
            CODEX_RADAR_INTELLIGENCE_URL,
            "Codex Radar 智力效率"
        ),
    )?;
    let current = serde_json::from_str::<CodexRadarCurrentResponse>(&current_raw)
        .map_err(|error| anyhow!("解析 Codex Radar IQ 响应失败: {error}"))?;
    let intelligence = serde_json::from_str::<CodexRadarIntelligenceResponse>(&intelligence_raw)
        .map_err(|error| anyhow!("解析 Codex Radar 智力效率响应失败: {error}"))?;

    build_intelligence_payload(current, intelligence, now_storage_timestamp())
}

async fn fetch_codex_radar_fast(use_system_proxy: bool) -> Result<CodexRadarFastRadarPayload> {
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(Duration::from_secs(CODEX_RADAR_REQUEST_TIMEOUT_SECS))
        .build()
        .context("初始化 Codex Radar Fast 请求客户端失败")?;
    let html = client
        .get(CODEX_RADAR_HOME_URL)
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
        .context("请求 Codex Radar Fast 数据失败")?
        .error_for_status()
        .context("Codex Radar Fast 页面返回失败状态")?
        .text()
        .await
        .context("读取 Codex Radar Fast 页面正文失败")?;

    build_fast_radar_payload(&html, now_storage_timestamp())
}

async fn fetch_codex_radar_insights(
    force: bool,
    use_system_proxy: bool,
) -> Result<CodexRadarInsightsPayload> {
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(Duration::from_secs(CODEX_RADAR_REQUEST_TIMEOUT_SECS))
        .build()
        .context("初始化 Codex Radar 推荐预警请求客户端失败")?;
    let url = codex_radar_insights_url(force);
    let raw = fetch_codex_radar_json(&client, url, "Codex Radar 推荐预警").await?;
    let response = serde_json::from_str::<CodexRadarInsightsResponse>(&raw)
        .map_err(|error| anyhow!("解析 Codex Radar 推荐预警响应失败: {error}"))?;

    build_insights_payload(response, now_storage_timestamp())
}

fn codex_radar_insights_url(force: bool) -> &'static str {
    if force {
        CODEX_RADAR_INSIGHTS_REFRESH_URL
    } else {
        CODEX_RADAR_INSIGHTS_URL
    }
}

async fn fetch_codex_radar_json(
    client: &reqwest::Client,
    url: &str,
    source_name: &str,
) -> Result<String> {
    client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .with_context(|| format!("请求 {source_name} 数据失败"))?
        .error_for_status()
        .with_context(|| format!("{source_name} 接口返回失败状态"))?
        .text()
        .await
        .with_context(|| format!("读取 {source_name} 响应正文失败"))
}

fn build_insights_payload(
    response: CodexRadarInsightsResponse,
    fetched_at: String,
) -> Result<CodexRadarInsightsPayload> {
    if response.schema != CODEX_RADAR_INSIGHTS_SCHEMA {
        bail!("Codex Radar 推荐预警 schema 不受支持: {}", response.schema);
    }
    let source_updated_at = required_text(
        Some(response.source_updated_at.as_str()),
        "Codex Radar 推荐预警缺少更新时间",
    )?
    .to_string();
    let degradation_rule = required_text(
        Some(response.degradation_alerts.rule.as_str()),
        "Codex Radar 降智预警缺少规则说明",
    )?
    .to_string();

    let recommendations = response
        .recommendations
        .into_iter()
        .map(build_insights_recommendation_group)
        .collect::<Result<Vec<_>>>()?;
    let degradation_alerts = response
        .degradation_alerts
        .items
        .into_iter()
        .map(build_insights_degradation_alert)
        .collect::<Result<Vec<_>>>()?;

    Ok(CodexRadarInsightsPayload {
        recommendations,
        degradation_rule,
        degradation_alerts,
        source_updated_at,
        fetched_at,
        last_error: None,
        is_stale: false,
    })
}

fn build_insights_recommendation_group(
    group: CodexRadarInsightsRecommendationGroup,
) -> Result<CodexRadarRecommendationGroup> {
    let key =
        required_text(Some(group.key.as_str()), "Codex Radar 站长推荐场景缺少 key")?.to_string();
    let title = required_text(
        Some(group.title.as_str()),
        "Codex Radar 站长推荐场景缺少标题",
    )?
    .to_string();
    let rule = required_text(
        Some(group.rule.as_str()),
        "Codex Radar 站长推荐场景缺少规则说明",
    )?
    .to_string();
    let normalized_group_key = normalize_insights_id_segment(&key);
    let items = group
        .items
        .into_iter()
        .map(|item| build_insights_recommendation_item(&normalized_group_key, item))
        .collect::<Result<Vec<_>>>()?;

    Ok(CodexRadarRecommendationGroup {
        key,
        title,
        rule,
        items,
    })
}

fn build_insights_recommendation_item(
    group_key: &str,
    item: CodexRadarInsightsRecommendationItem,
) -> Result<CodexRadarRecommendationItem> {
    let model = required_text(
        Some(item.model.as_str()),
        "Codex Radar 站长推荐条目缺少 model",
    )?
    .to_string();
    let reasoning_effort = required_text(
        Some(item.effort.as_str()),
        "Codex Radar 站长推荐条目缺少 effort",
    )?
    .to_string();
    validate_insights_finite(item.iq, "站长推荐 IQ")?;
    validate_optional_insights_finite(item.average_cost_usd, "站长推荐平均费用")?;
    validate_optional_insights_finite(item.average_duration_minutes, "站长推荐平均耗时")?;
    let trend = build_insights_trend(item.trend_48h, "站长推荐趋势")?;

    Ok(CodexRadarRecommendationItem {
        id: format!(
            "{group_key}:{}:{}",
            normalize_insights_id_segment(&model),
            normalize_insights_id_segment(&reasoning_effort)
        ),
        model,
        reasoning_effort,
        score: item.iq,
        average_cost_usd: item.average_cost_usd,
        average_minutes: item.average_duration_minutes,
        slot: normalize_optional_text(item.slot),
        trend,
    })
}

fn build_insights_degradation_alert(
    alert: CodexRadarInsightsDegradationAlert,
) -> Result<CodexRadarDegradationAlert> {
    let model = required_text(
        Some(alert.model.as_str()),
        "Codex Radar 降智预警条目缺少 model",
    )?
    .to_string();
    let reasoning_effort = required_text(
        Some(alert.effort.as_str()),
        "Codex Radar 降智预警条目缺少 effort",
    )?
    .to_string();
    validate_insights_finite(alert.current_iq, "降智预警当前 IQ")?;
    for (value, field) in [
        (alert.average_iq_24h, "降智预警 24 小时平均 IQ"),
        (alert.average_iq_48h, "降智预警 48 小时平均 IQ"),
        (alert.degradation_12h_iq, "降智预警 12 小时下降量"),
        (alert.from_24h_average_iq, "降智预警 24 小时均值降幅"),
        (alert.from_48h_average_iq, "降智预警 48 小时均值降幅"),
        (alert.degradation_severity_score, "降智预警严重度"),
    ] {
        validate_optional_insights_finite(value, field)?;
    }
    let trend = build_insights_trend(alert.trend_48h, "降智预警趋势")?;

    Ok(CodexRadarDegradationAlert {
        id: format!(
            "{}:{}",
            normalize_insights_id_segment(&model),
            normalize_insights_id_segment(&reasoning_effort)
        ),
        model,
        reasoning_effort,
        score: alert.current_iq,
        average_24h_score: alert.average_iq_24h,
        average_48h_score: alert.average_iq_48h,
        drop_12h: alert.degradation_12h_iq,
        drop_from_24h_average: alert.from_24h_average_iq,
        drop_from_48h_average: alert.from_48h_average_iq,
        severity_score: alert.degradation_severity_score,
        trend,
    })
}

fn build_insights_trend(
    points: Vec<CodexRadarInsightsRawTrendPoint>,
    source_name: &str,
) -> Result<Vec<CodexRadarInsightsTrendPoint>> {
    points
        .into_iter()
        .map(|point| {
            let observed_at = required_text(
                Some(point.timestamp.as_str()),
                &format!("Codex Radar {source_name}缺少时间"),
            )?
            .to_string();
            validate_insights_finite(point.iq, &format!("{source_name} IQ"))?;
            Ok(CodexRadarInsightsTrendPoint {
                observed_at,
                score: point.iq,
                samples: point.samples,
            })
        })
        .collect()
}

fn normalize_insights_id_segment(value: &str) -> String {
    value
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn validate_insights_finite(value: f64, field: &str) -> Result<()> {
    if value.is_finite() {
        Ok(())
    } else {
        bail!("Codex Radar 推荐预警包含无效{field}")
    }
}

fn validate_optional_insights_finite(value: Option<f64>, field: &str) -> Result<()> {
    match value {
        Some(value) => validate_insights_finite(value, field),
        None => Ok(()),
    }
}

fn build_model_iq_payload_from_intelligence(
    intelligence: CodexRadarIntelligenceResponse,
    fetched_at: String,
) -> Result<CodexRadarModelIqPayload> {
    if intelligence.schema != CODEX_RADAR_INTELLIGENCE_SCHEMA {
        bail!(
            "Codex Radar 智力效率 schema 不受支持: {}",
            intelligence.schema
        );
    }
    if intelligence.response_type != CODEX_RADAR_INTELLIGENCE_TYPE {
        bail!(
            "Codex Radar 智力效率响应类型不受支持: {}",
            intelligence.response_type
        );
    }
    if intelligence.source_updated_at.trim().is_empty() {
        bail!("Codex Radar 智力效率缺少更新时间");
    }

    let mut items = intelligence
        .points
        .into_iter()
        .map(build_model_iq_entry_from_intelligence_point)
        .collect::<Result<Vec<_>>>()?;
    items.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.passed.cmp(&left.passed))
            .then_with(|| left.average_cost_usd.total_cmp(&right.average_cost_usd))
            .then_with(|| left.id.cmp(&right.id))
    });
    items.truncate(5);

    if items.is_empty() {
        bail!("Codex Radar IQ 没有可展示的模型测评数据");
    }

    Ok(CodexRadarModelIqPayload {
        items,
        source_updated_at: intelligence.source_updated_at,
        fetched_at,
        last_error: None,
        is_stale: false,
    })
}

fn build_model_iq_entry_from_intelligence_point(
    point: CodexRadarIntelligenceRawPoint,
) -> Result<CodexRadarModelIqEntry> {
    let point = build_efficiency_point(point)?;
    let average_cost_usd = point
        .average_cost_usd
        .ok_or_else(|| anyhow!("Codex Radar IQ 档位 {} 缺少平均费用", point.id))?;

    Ok(CodexRadarModelIqEntry {
        id: point.id,
        label: point.label,
        model: point.model,
        reasoning_effort: point.reasoning_effort,
        score: point.score,
        passed: point.passed,
        average_cost_usd,
        status: None,
        observed_at: point.observed_at,
    })
}

fn resolve_codex_radar_intelligence_fetch(
    db: &Database,
    result: Result<CodexRadarIntelligencePayload>,
) -> Result<CodexRadarIntelligencePayload> {
    match result {
        Ok(payload) => {
            repositories::upsert_codex_radar_intelligence_cache(
                db,
                &CodexRadarIntelligenceCacheRecord {
                    payload_json: serde_json::to_string(&payload)
                        .context("序列化 Codex Radar 智力效率缓存失败")?,
                    source_updated_at: payload.source_updated_at.clone(),
                    fetched_at: payload.fetched_at.clone(),
                    last_error: None,
                },
            )
            .context("保存 Codex Radar 智力效率缓存失败")?;
            Ok(payload)
        }
        Err(error) => {
            let error_message = error.to_string();
            let Some(cache) = repositories::find_codex_radar_intelligence_cache(db)
                .context("读取 Codex Radar 智力效率缓存失败")?
            else {
                return Err(error);
            };

            repositories::update_codex_radar_intelligence_cache_error(db, Some(&error_message))
                .context("记录 Codex Radar 智力效率刷新错误失败")?;
            build_cached_intelligence_payload(cache, Some(error_message))
        }
    }
}

fn resolve_codex_radar_fast_fetch(
    db: &Database,
    result: Result<CodexRadarFastRadarPayload>,
) -> Result<CodexRadarFastRadarPayload> {
    match result {
        Ok(payload) => {
            repositories::upsert_codex_radar_fast_cache(
                db,
                &CodexRadarFastCacheRecord {
                    payload_json: serde_json::to_string(&payload)
                        .context("序列化 Codex Radar Fast 缓存失败")?,
                    source_updated_at: payload.source_updated_at.clone(),
                    fetched_at: payload.fetched_at.clone(),
                    last_error: None,
                },
            )
            .context("保存 Codex Radar Fast 缓存失败")?;
            Ok(payload)
        }
        Err(error) => {
            let error_message = error.to_string();
            let Some(cache) = repositories::find_codex_radar_fast_cache(db)
                .context("读取 Codex Radar Fast 缓存失败")?
            else {
                return Err(error);
            };

            repositories::update_codex_radar_fast_cache_error(db, Some(&error_message))
                .context("记录 Codex Radar Fast 刷新错误失败")?;
            build_cached_fast_radar_payload(cache, Some(error_message))
        }
    }
}

fn build_intelligence_payload(
    current: CodexRadarCurrentResponse,
    intelligence: CodexRadarIntelligenceResponse,
    fetched_at: String,
) -> Result<CodexRadarIntelligencePayload> {
    if current.schema_version != CODEX_RADAR_SCHEMA_VERSION {
        bail!(
            "Codex Radar IQ schema_version 不受支持: {}",
            current.schema_version
        );
    }
    if current.response_type != CODEX_RADAR_PUBLIC_SUMMARY_TYPE {
        bail!("Codex Radar IQ 响应类型不受支持: {}", current.response_type);
    }
    if intelligence.schema != CODEX_RADAR_INTELLIGENCE_SCHEMA {
        bail!(
            "Codex Radar 智力效率 schema 不受支持: {}",
            intelligence.schema
        );
    }
    if intelligence.response_type != CODEX_RADAR_INTELLIGENCE_TYPE {
        bail!(
            "Codex Radar 智力效率响应类型不受支持: {}",
            intelligence.response_type
        );
    }
    if intelligence.source_updated_at.trim().is_empty() {
        bail!("Codex Radar 智力效率缺少更新时间");
    }

    let CodexRadarModelIqSummary {
        latest,
        comparisons,
        recent_days,
        ..
    } = current.model_iq;
    let root_model =
        required_text(latest.model.as_deref(), "Codex Radar IQ 主档位缺少 model")?.to_string();
    let root_reasoning_effort = required_text(
        latest.reasoning_effort.as_deref(),
        "Codex Radar IQ 主档位缺少 reasoning_effort",
    )?
    .to_string();
    let mut detail_items = vec![build_intelligence_detail_item(
        build_entry_id(&root_model, &root_reasoning_effort),
        format_model_label(&root_model, &root_reasoning_effort),
        root_model,
        root_reasoning_effort,
        latest,
        recent_days,
    )?];

    for (comparison_id, comparison) in comparisons {
        let model = required_text(
            Some(comparison.model.as_str()),
            "Codex Radar IQ 对比档位缺少 model",
        )?
        .to_string();
        let reasoning_effort = required_text(
            Some(comparison.reasoning_effort.as_str()),
            "Codex Radar IQ 对比档位缺少 reasoning_effort",
        )?
        .to_string();
        let id = if comparison_id.trim().is_empty() {
            build_entry_id(&model, &reasoning_effort)
        } else {
            comparison_id
        };
        let label = if comparison.label.trim().is_empty() {
            format_model_label(&model, &reasoning_effort)
        } else {
            comparison.label
        };
        detail_items.push(build_intelligence_detail_item(
            id,
            label,
            model,
            reasoning_effort,
            comparison.latest,
            comparison.recent_days,
        )?);
    }
    detail_items.sort_by(compare_intelligence_detail_items);
    if detail_items.is_empty() {
        bail!("Codex Radar 智力效率没有可展示的详细档位");
    }

    let mut efficiency_points = intelligence
        .points
        .into_iter()
        .map(build_efficiency_point)
        .collect::<Result<Vec<_>>>()?;
    efficiency_points.sort_by(compare_efficiency_points);
    if efficiency_points.is_empty() {
        bail!("Codex Radar 智力效率没有可展示的模型档位");
    }

    Ok(CodexRadarIntelligencePayload {
        efficiency_points,
        detail_items,
        source_updated_at: intelligence.source_updated_at,
        fetched_at,
        last_error: None,
        is_stale: false,
    })
}

fn build_fast_radar_payload(html: &str, fetched_at: String) -> Result<CodexRadarFastRadarPayload> {
    let section = extract_tag_element_with_attribute(html, "section", r#"id="fast-radar""#)
        .context("Codex Radar Fast 页面缺少 fast-radar 区块")?;
    let header = extract_first_tag_element_with_class(section, "div", "fast-radar-head")?;
    let source_updated_at = extract_first_tag_text(header, "em", "Codex Radar Fast 缺少更新时间")?;
    let head_copy = extract_first_tag_text(header, "span", "Codex Radar Fast 缺少成本说明")?;
    let cost_multiplier = parse_first_number(&head_copy, "Codex Radar Fast 成本倍数")?;

    let summary = extract_first_tag_element_with_class(section, "div", "fast-radar-summary")?;
    let summary_values = extract_tag_texts(summary, "strong")?;
    if summary_values.len() != 3 {
        bail!(
            "Codex Radar Fast 汇总指标数量不受支持: {}",
            summary_values.len()
        );
    }
    let summary = CodexRadarFastRadarSummary {
        cost_multiplier,
        e2e_multiplier: parse_first_number(&summary_values[0], "Codex Radar Fast 体感加速")?,
        ttft_delta_seconds: parse_first_number(&summary_values[1], "Codex Radar Fast 首字延迟")?,
        tps_multiplier: parse_first_number(&summary_values[2], "Codex Radar Fast Token 生成速度")?,
    };

    let mut items = Vec::new();
    for row in extract_tag_elements_with_class(section, "div", "fast-radar-row")? {
        if tag_element_has_class(row, "fast-radar-row-head")? {
            continue;
        }
        let model_container = extract_first_tag_element_with_class(row, "div", "fast-radar-model")?;
        let model =
            extract_first_tag_text(model_container, "strong", "Codex Radar Fast 缺少模型名")?;
        let e2e = parse_fast_radar_metric(row, "fast-radar-metric-e2e", "E2E")?;
        let ttft = parse_fast_radar_metric(row, "fast-radar-metric-ttft", "TTFT")?;
        let tps = parse_fast_radar_metric(row, "fast-radar-metric-tps", "TPS")?;

        items.push(CodexRadarFastRadarItem {
            model,
            standard_e2e_seconds: e2e.standard,
            fast_e2e_seconds: e2e.fast,
            e2e_multiplier: parse_first_number(&e2e.label, "Codex Radar Fast E2E 倍数")?,
            standard_ttft_seconds: ttft.standard,
            fast_ttft_seconds: ttft.fast,
            ttft_change_label: ttft.label,
            standard_tps: tps.standard,
            fast_tps: tps.fast,
            tps_multiplier: parse_first_number(&tps.label, "Codex Radar Fast TPS 倍数")?,
        });
    }
    if items.is_empty() {
        bail!("Codex Radar Fast 没有可展示的模型数据");
    }

    Ok(CodexRadarFastRadarPayload {
        summary,
        items,
        source_updated_at,
        fetched_at,
        last_error: None,
        is_stale: false,
    })
}

fn build_efficiency_point(
    point: CodexRadarIntelligenceRawPoint,
) -> Result<CodexRadarIntelligenceEfficiencyPoint> {
    let model = point.model.trim();
    let reasoning_effort = point.effort.trim();
    if model.is_empty() || reasoning_effort.is_empty() || point.latest_graded_at.trim().is_empty() {
        bail!("Codex Radar 智力效率档位缺少模型、强度或观测时间");
    }
    validate_finite(point.iq, "IQ")?;
    validate_optional_finite(point.average_price_usd, "平均费用")?;
    validate_optional_finite(point.average_minutes, "平均耗时")?;
    validate_optional_finite(point.combined_cost_index, "综合成本指数")?;

    Ok(CodexRadarIntelligenceEfficiencyPoint {
        id: build_entry_id(model, reasoning_effort),
        label: format_model_label(model, reasoning_effort),
        model: model.to_string(),
        reasoning_effort: reasoning_effort.to_string(),
        score: point.iq,
        passed: point.passed,
        valid_tasks: point.valid_tasks,
        average_cost_usd: point.average_price_usd,
        average_minutes: point.average_minutes,
        combined_cost_index: point.combined_cost_index,
        total_runs: point.total_runs,
        observed_at: point.latest_graded_at,
    })
}

fn build_intelligence_detail_item(
    id: String,
    label: String,
    model: String,
    reasoning_effort: String,
    latest: CodexRadarModelIqLatest,
    history: Vec<CodexRadarModelIqLatest>,
) -> Result<CodexRadarIntelligenceDetailItem> {
    if latest.date.trim().is_empty() || latest.status.trim().is_empty() {
        bail!("Codex Radar 智力效率详细档位 {id} 缺少观测时间或状态");
    }
    validate_finite(latest.score, "IQ")?;
    validate_finite(latest.average_cost_usd, "平均费用")?;
    validate_optional_finite(latest.average_task_seconds, "平均任务耗时")?;
    let history = history
        .into_iter()
        .map(build_intelligence_history_point)
        .collect::<Result<Vec<_>>>()?;

    Ok(CodexRadarIntelligenceDetailItem {
        id,
        label,
        model,
        reasoning_effort,
        score: latest.score,
        status: latest.status,
        passed: latest.passed,
        tasks: latest.tasks,
        valid_tasks: latest.valid_tasks,
        average_cost_usd: Some(latest.average_cost_usd),
        total_tokens: latest.total_tokens,
        input_tokens: latest.input_tokens,
        cached_input_tokens: latest.cached_input_tokens,
        output_tokens: latest.output_tokens,
        wall_seconds: latest.wall_seconds,
        average_task_seconds: latest.average_task_seconds,
        observed_at: latest.date,
        history,
    })
}

fn build_intelligence_history_point(
    point: CodexRadarModelIqLatest,
) -> Result<CodexRadarIntelligenceHistoryPoint> {
    if point.date.trim().is_empty() {
        bail!("Codex Radar 智力效率历史点缺少观测时间");
    }
    validate_finite(point.score, "历史 IQ")?;
    validate_finite(point.average_cost_usd, "历史平均费用")?;
    validate_optional_finite(point.average_task_seconds, "历史平均任务耗时")?;

    Ok(CodexRadarIntelligenceHistoryPoint {
        observed_at: point.date,
        score: point.score,
        passed: point.passed,
        tasks: point.tasks,
        total_tokens: point.total_tokens,
        input_tokens: point.input_tokens,
        cached_input_tokens: point.cached_input_tokens,
        output_tokens: point.output_tokens,
        wall_seconds: point.wall_seconds,
        average_cost_usd: Some(point.average_cost_usd),
        average_task_seconds: point.average_task_seconds,
    })
}

fn build_cached_intelligence_payload(
    cache: CodexRadarIntelligenceCacheRecord,
    last_error: Option<String>,
) -> Result<CodexRadarIntelligencePayload> {
    let mut payload = serde_json::from_str::<CodexRadarIntelligencePayload>(&cache.payload_json)
        .map_err(|error| anyhow!("解析 Codex Radar 智力效率缓存失败: {error}"))?;
    payload.source_updated_at = cache.source_updated_at;
    payload.fetched_at = cache.fetched_at;
    payload.last_error = last_error.or(cache.last_error);
    payload.is_stale = payload.last_error.is_some();
    Ok(payload)
}

fn build_cached_fast_radar_payload(
    cache: CodexRadarFastCacheRecord,
    last_error: Option<String>,
) -> Result<CodexRadarFastRadarPayload> {
    let mut payload = serde_json::from_str::<CodexRadarFastRadarPayload>(&cache.payload_json)
        .map_err(|error| anyhow!("解析 Codex Radar Fast 缓存失败: {error}"))?;
    payload.source_updated_at = cache.source_updated_at;
    payload.fetched_at = cache.fetched_at;
    payload.last_error = last_error.or(cache.last_error);
    payload.is_stale = payload.last_error.is_some();
    Ok(payload)
}

fn build_cached_insights_payload(
    cache: CodexRadarInsightsCacheRecord,
    last_error: Option<String>,
) -> Result<CodexRadarInsightsPayload> {
    let mut payload = serde_json::from_str::<CodexRadarInsightsPayload>(&cache.payload_json)
        .map_err(|error| anyhow!("解析 Codex Radar 推荐预警缓存失败: {error}"))?;
    payload.source_updated_at = cache.source_updated_at;
    payload.fetched_at = cache.fetched_at;
    payload.last_error = last_error.or(cache.last_error);
    payload.is_stale = payload.last_error.is_some();
    Ok(payload)
}

struct FastRadarMetric {
    standard: f64,
    fast: f64,
    label: String,
}

fn parse_fast_radar_metric(
    row: &str,
    class_name: &str,
    metric_name: &str,
) -> Result<FastRadarMetric> {
    let metric = extract_first_tag_element_with_class(row, "div", class_name)
        .with_context(|| format!("Codex Radar Fast 缺少 {metric_name} 指标"))?;
    let range = extract_first_tag_text(
        metric,
        "span",
        &format!("Codex Radar Fast {metric_name} 缺少标准/Fast 对比"),
    )?;
    let label = extract_first_tag_text(
        metric,
        "strong",
        &format!("Codex Radar Fast {metric_name} 缺少变化标签"),
    )?;
    let (standard, fast) = parse_number_pair(&range, metric_name)?;

    Ok(FastRadarMetric {
        standard,
        fast,
        label,
    })
}

fn parse_number_pair(value: &str, field: &str) -> Result<(f64, f64)> {
    let values = parse_numbers(value);
    if values.len() != 2 {
        bail!("Codex Radar Fast {field} 对比格式不受支持: {value}");
    }
    Ok((values[0], values[1]))
}

fn parse_first_number(value: &str, field: &str) -> Result<f64> {
    parse_numbers(value)
        .into_iter()
        .next()
        .filter(|value| value.is_finite())
        .ok_or_else(|| anyhow!("Codex Radar Fast {field} 缺少有效数值: {value}"))
}

fn parse_numbers(value: &str) -> Vec<f64> {
    let mut numbers = Vec::new();
    let mut token = String::new();
    let mut flush = |token: &mut String| {
        if token.chars().any(|character| character.is_ascii_digit()) {
            if let Ok(number) = token.parse::<f64>() {
                if number.is_finite() {
                    numbers.push(number);
                }
            }
        }
        token.clear();
    };

    for character in value.chars() {
        if character.is_ascii_digit() || character == '.' || (character == '-' && token.is_empty())
        {
            token.push(character);
        } else {
            flush(&mut token);
        }
    }
    flush(&mut token);
    numbers
}

fn extract_tag_element_with_attribute<'a>(
    source: &'a str,
    tag: &str,
    attribute: &str,
) -> Result<&'a str> {
    let mut cursor = 0;
    while let Some(start) = find_next_open_tag(source, tag, cursor) {
        let opening_end = source[start..]
            .find('>')
            .map(|offset| start + offset)
            .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中 {tag} 标签未闭合"))?;
        if source[start..=opening_end].contains(attribute) {
            return extract_tag_element_at(source, start, tag);
        }
        cursor = opening_end + 1;
    }
    bail!("Codex Radar Fast HTML 中找不到 {tag} 标签属性 {attribute}")
}

fn extract_first_tag_element_with_class<'a>(
    source: &'a str,
    tag: &str,
    class_name: &str,
) -> Result<&'a str> {
    extract_tag_elements_with_class(source, tag, class_name)?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中找不到 .{class_name}"))
}

fn extract_tag_elements_with_class<'a>(
    source: &'a str,
    tag: &str,
    class_name: &str,
) -> Result<Vec<&'a str>> {
    let mut elements = Vec::new();
    let mut cursor = 0;
    while let Some(start) = find_next_open_tag(source, tag, cursor) {
        let element = extract_tag_element_at(source, start, tag)?;
        if tag_element_has_class(element, class_name)? {
            cursor = start + element.len();
            elements.push(element);
        } else {
            let opening_end = source[start..]
                .find('>')
                .map(|offset| start + offset)
                .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中 {tag} 标签未闭合"))?;
            cursor = opening_end + 1;
        }
    }
    Ok(elements)
}

fn tag_element_has_class(element: &str, class_name: &str) -> Result<bool> {
    let opening_end = element
        .find('>')
        .ok_or_else(|| anyhow!("Codex Radar Fast HTML 标签未闭合"))?;
    let opening_tag = &element[..=opening_end];
    let Some(class_start) = opening_tag.find("class=\"") else {
        return Ok(false);
    };
    let class_value = &opening_tag[class_start + "class=\"".len()..];
    let Some(class_end) = class_value.find('"') else {
        bail!("Codex Radar Fast HTML class 属性未闭合");
    };
    Ok(class_value[..class_end]
        .split_ascii_whitespace()
        .any(|value| value == class_name))
}

fn extract_tag_texts(source: &str, tag: &str) -> Result<Vec<String>> {
    let mut texts = Vec::new();
    let mut cursor = 0;
    while let Some(start) = find_next_open_tag(source, tag, cursor) {
        let element = extract_tag_element_at(source, start, tag)?;
        texts.push(strip_html_tags(element));
        cursor = start + element.len();
    }
    Ok(texts)
}

fn extract_first_tag_text(source: &str, tag: &str, message: &str) -> Result<String> {
    extract_tag_texts(source, tag)?
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!(message.to_string()))
}

fn strip_html_tags(value: &str) -> String {
    let mut text = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(character),
            _ => {}
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_tag_element_at<'a>(source: &'a str, start: usize, tag: &str) -> Result<&'a str> {
    let opening_end = source[start..]
        .find('>')
        .map(|offset| start + offset)
        .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中 {tag} 标签未闭合"))?;
    let mut cursor = opening_end + 1;
    let mut depth = 1;

    while depth > 0 {
        let next_open = find_next_open_tag(source, tag, cursor);
        let next_close = find_next_close_tag(source, tag, cursor);
        match (next_open, next_close) {
            (_, None) => bail!("Codex Radar Fast HTML 中 {tag} 标签未闭合"),
            (Some(open), Some(close)) if open < close => {
                let nested_open_end = source[open..]
                    .find('>')
                    .map(|offset| open + offset)
                    .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中 {tag} 标签未闭合"))?;
                if !source[open..=nested_open_end].trim_end().ends_with("/>") {
                    depth += 1;
                }
                cursor = nested_open_end + 1;
            }
            (_, Some(close)) => {
                let close_end = source[close..]
                    .find('>')
                    .map(|offset| close + offset)
                    .ok_or_else(|| anyhow!("Codex Radar Fast HTML 中 {tag} 闭合标签未完成"))?;
                depth -= 1;
                cursor = close_end + 1;
            }
        }
    }

    Ok(&source[start..cursor])
}

fn find_next_open_tag(source: &str, tag: &str, cursor: usize) -> Option<usize> {
    find_next_tag(source, &format!("<{tag}"), cursor)
}

fn find_next_close_tag(source: &str, tag: &str, cursor: usize) -> Option<usize> {
    find_next_tag(source, &format!("</{tag}"), cursor)
}

fn find_next_tag(source: &str, marker: &str, mut cursor: usize) -> Option<usize> {
    while let Some(offset) = source[cursor..].find(marker) {
        let start = cursor + offset;
        let next = source.as_bytes().get(start + marker.len()).copied();
        if matches!(next, Some(byte) if byte.is_ascii_whitespace() || byte == b'>' || byte == b'/')
        {
            return Some(start);
        }
        cursor = start + marker.len();
    }
    None
}

fn compare_efficiency_points(
    left: &CodexRadarIntelligenceEfficiencyPoint,
    right: &CodexRadarIntelligenceEfficiencyPoint,
) -> std::cmp::Ordering {
    left.model
        .cmp(&right.model)
        .then_with(|| {
            effort_sort_key(&left.reasoning_effort).cmp(&effort_sort_key(&right.reasoning_effort))
        })
        .then_with(|| left.id.cmp(&right.id))
}

fn compare_intelligence_detail_items(
    left: &CodexRadarIntelligenceDetailItem,
    right: &CodexRadarIntelligenceDetailItem,
) -> std::cmp::Ordering {
    left.model
        .cmp(&right.model)
        .then_with(|| {
            effort_sort_key(&left.reasoning_effort).cmp(&effort_sort_key(&right.reasoning_effort))
        })
        .then_with(|| left.id.cmp(&right.id))
}

fn effort_sort_key(value: &str) -> (u8, &str) {
    let rank = match value.to_ascii_lowercase().as_str() {
        "low" => 0,
        "medium" => 1,
        "high" => 2,
        "xhigh" => 3,
        "max" => 4,
        "ultra" => 5,
        _ => 6,
    };
    (rank, value)
}

fn validate_finite(value: f64, field: &str) -> Result<()> {
    if value.is_finite() {
        Ok(())
    } else {
        bail!("Codex Radar 智力效率包含无效{field}")
    }
}

fn validate_optional_finite(value: Option<f64>, field: &str) -> Result<()> {
    match value {
        Some(value) => validate_finite(value, field),
        None => Ok(()),
    }
}

fn build_cached_payload(
    cache: CodexRadarModelIqCacheRecord,
    last_error: Option<String>,
) -> Result<CodexRadarModelIqPayload> {
    let mut payload = serde_json::from_str::<CodexRadarModelIqPayload>(&cache.payload_json)
        .map_err(|error| anyhow!("解析 Codex Radar IQ 缓存失败: {error}"))?;
    payload.source_updated_at = cache.source_updated_at;
    payload.fetched_at = cache.fetched_at;
    payload.last_error = last_error.or(cache.last_error);
    payload.is_stale = payload.last_error.is_some();
    Ok(payload)
}

fn required_text<'a>(value: Option<&'a str>, message: &str) -> Result<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!(message.to_string()))
}

fn build_entry_id(model: &str, reasoning_effort: &str) -> String {
    format!("{model}:{reasoning_effort}")
}

fn format_model_label(model: &str, reasoning_effort: &str) -> String {
    let mut parts = model.split('-');
    let family = match (parts.next(), parts.next()) {
        (Some(prefix), Some(version)) if prefix.eq_ignore_ascii_case("gpt") => {
            format!("GPT-{version}")
        }
        _ => model.to_string(),
    };
    let variant = parts.map(title_case_segment).collect::<Vec<_>>().join(" ");
    if variant.is_empty() {
        format!("{family} {reasoning_effort}")
    } else {
        format!("{family} {variant} {reasoning_effort}")
    }
}

fn title_case_segment(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_db() -> Database {
        let db_path = std::env::temp_dir().join(format!(
            "input-panel-codex-radar-service-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let _ = db.connect().expect("init sqlite");
        db
    }

    fn cached_payload() -> CodexRadarModelIqPayload {
        CodexRadarModelIqPayload {
            items: vec![CodexRadarModelIqEntry {
                id: "gpt-5.6-sol:max".into(),
                label: "GPT-5.6 Sol max".into(),
                model: "gpt-5.6-sol".into(),
                reasoning_effort: "max".into(),
                score: 106.3,
                passed: 79,
                average_cost_usd: 9.44,
                status: None,
                observed_at: "2026-07-21T18:07:02+08:00".into(),
            }],
            source_updated_at: "2026-07-21T18:07:02+08:00".into(),
            fetched_at: "2026-07-21T18:10:00+08:00".into(),
            last_error: None,
            is_stale: false,
        }
    }

    fn cached_intelligence_payload() -> CodexRadarIntelligencePayload {
        CodexRadarIntelligencePayload {
            efficiency_points: vec![CodexRadarIntelligenceEfficiencyPoint {
                id: "gpt-5.6-sol:max".into(),
                label: "GPT-5.6 Sol max".into(),
                model: "gpt-5.6-sol".into(),
                reasoning_effort: "max".into(),
                score: 101.8,
                passed: 76,
                valid_tasks: 112,
                average_cost_usd: Some(9.27),
                average_minutes: Some(35.42),
                combined_cost_index: Some(8.74),
                total_runs: 328,
                observed_at: "2026-07-22T08:16:45+08:00".into(),
            }],
            detail_items: vec![],
            source_updated_at: "2026-07-22T08:16:45+08:00".into(),
            fetched_at: "2026-07-22T08:18:00+08:00".into(),
            last_error: None,
            is_stale: false,
        }
    }

    fn intelligence_point(
        model: &str,
        effort: &str,
        iq: f64,
        passed: i64,
        average_price_usd: f64,
    ) -> CodexRadarIntelligenceRawPoint {
        CodexRadarIntelligenceRawPoint {
            model: model.into(),
            effort: effort.into(),
            iq,
            passed,
            valid_tasks: 112,
            average_price_usd: Some(average_price_usd),
            average_minutes: Some(20.0),
            combined_cost_index: Some(average_price_usd),
            total_runs: 112,
            latest_graded_at: "2026-07-31T07:11:00+08:00".into(),
        }
    }

    fn intelligence_response_fixture(passed: &str, valid_tasks: &str) -> String {
        format!(
            r#"
            {{
              "schema": 2,
              "type": "distributed_intelligence_efficiency",
              "source_updated_at": "2026-08-13T09:07:46+00:00",
              "points": [
                {{
                  "model": "gpt-5.6-sol",
                  "effort": "low",
                  "iq": 75.0,
                  "passed": {passed},
                  "valid_tasks": {valid_tasks},
                  "average_price_usd": 2.047978,
                  "average_minutes": 11.83,
                  "combined_cost_index": 8.74,
                  "total_runs": 1537,
                  "latest_graded_at": "2026-08-13T09:07:46+00:00"
                }}
              ]
            }}
            "#
        )
    }

    fn cached_fast_radar_payload() -> CodexRadarFastRadarPayload {
        CodexRadarFastRadarPayload {
            summary: CodexRadarFastRadarSummary {
                cost_multiplier: 2.5,
                e2e_multiplier: 1.208,
                ttft_delta_seconds: -2.28,
                tps_multiplier: 1.440,
            },
            items: vec![CodexRadarFastRadarItem {
                model: "Sol".into(),
                standard_e2e_seconds: 50.22,
                fast_e2e_seconds: 41.71,
                e2e_multiplier: 1.204,
                standard_ttft_seconds: 13.96,
                fast_ttft_seconds: 16.92,
                ttft_change_label: "慢 21.2%".into(),
                standard_tps: 57.33,
                fast_tps: 83.91,
                tps_multiplier: 1.464,
            }],
            source_updated_at: "7月22日10:09更新".into(),
            fetched_at: "2026-07-22T08:18:00+08:00".into(),
            last_error: None,
            is_stale: false,
        }
    }

    fn cached_insights_payload() -> CodexRadarInsightsPayload {
        CodexRadarInsightsPayload {
            recommendations: vec![CodexRadarRecommendationGroup {
                key: "daily_development".into(),
                title: "日常开发".into(),
                rule: "优先平衡 IQ、成本和耗时".into(),
                items: vec![CodexRadarRecommendationItem {
                    id: "daily_development:gpt-5.5:xhigh".into(),
                    model: "gpt-5.5".into(),
                    reasoning_effort: "xhigh".into(),
                    score: 95.1,
                    average_cost_usd: Some(5.9),
                    average_minutes: Some(25.0),
                    slot: Some("primary".into()),
                    trend: vec![],
                }],
            }],
            degradation_rule: "12 小时 IQ 下降达到上游门槛".into(),
            degradation_alerts: vec![],
            source_updated_at: "2026-07-29T20:38:00+08:00".into(),
            fetched_at: "2026-07-29 20:39:00".into(),
            last_error: None,
            is_stale: false,
        }
    }

    fn insights_response_fixture() -> &'static str {
        r#"
        {
          "schema": 1,
          "source_updated_at": "2026-07-29T20:38:00+08:00",
          "recommendations": [
            {
              "key": "daily_development",
              "title": "日常开发",
              "rule": "优先平衡 IQ、成本和耗时",
              "items": [{
                "model": "gpt-5.5",
                "effort": "xhigh",
                "iq": 95.1,
                "average_cost_usd": 5.9,
                "average_duration_minutes": 25,
                "slot": "primary",
                "trend_48h": [{
                  "timestamp": "2026-07-29T18:00:00+08:00",
                  "iq": 94.8,
                  "samples": 12
                }]
              }]
            },
            {
              "key": "hard_problems",
              "title": "复杂问题",
              "rule": "优先 IQ",
              "items": [{
                "model": "gpt-5.6-sol",
                "effort": "max",
                "iq": 106.3,
                "average_cost_usd": null,
                "average_duration_minutes": null,
                "slot": null
              }]
            },
            {
              "key": "background_automation",
              "title": "后台自动化",
              "rule": "优先成本",
              "items": [{
                "model": "gpt-5.6-terra",
                "effort": "low",
                "iq": 44.2
              }]
            },
            {
              "key": "lobster_tasks",
              "title": "龙虾任务",
              "rule": "优先稳定性",
              "items": [{
                "model": "gpt-5.5",
                "effort": "medium",
                "iq": 88.4
              }]
            }
          ],
          "degradation_alerts": {
            "rule": "12 小时 IQ 下降达到上游门槛",
            "items": []
          }
        }
        "#
    }

    fn fast_radar_html_fixture() -> &'static str {
        r#"
        <section class="fast-radar" id="fast-radar" aria-label="Fast 雷达">
          <div class="fast-radar-head">
            <div><h2>Fast 雷达 <em>7月22日10:09更新</em></h2></div>
            <span>从标准改成 Fast，以 2.5 倍的成本到底快了多少？</span>
          </div>
          <div class="fast-radar-summary" aria-label="Fast 模式速览">
            <div><span>体感加速</span><strong>⚡️1.208 倍</strong></div>
            <div><span>首字延迟减少</span><strong>-2.28 秒</strong></div>
            <div><span>Token 生成速度加速</span><strong>⚡️1.440 倍</strong></div>
          </div>
          <div class="fast-radar-table" role="table">
            <div class="fast-radar-row fast-radar-row-head" role="row"><span>模型</span></div>
            <div class="fast-radar-row" role="row">
              <div class="fast-radar-model"><i aria-hidden="true"></i><strong>Sol</strong></div>
              <div class="fast-radar-metric fast-radar-metric-e2e"><span>50.22s → 41.71s</span><strong>⚡️1.204×</strong></div>
              <div class="fast-radar-metric fast-radar-metric-ttft is-regression"><span>13.96s → 16.92s</span><strong>慢 21.2%</strong></div>
              <div class="fast-radar-metric fast-radar-metric-tps"><span>57.33 → 83.91</span><strong>⚡️1.464×</strong></div>
            </div>
            <div class="fast-radar-row" role="row">
              <div class="fast-radar-model"><i aria-hidden="true"></i><strong>Terra</strong></div>
              <div class="fast-radar-metric fast-radar-metric-e2e"><span>53.24s → 41.31s</span><strong>⚡️1.289×</strong></div>
              <div class="fast-radar-metric fast-radar-metric-ttft"><span>14.65s → 11.07s</span><strong>快 24.4%</strong></div>
              <div class="fast-radar-metric fast-radar-metric-tps"><span>55.09 → 72.09</span><strong>⚡️1.309×</strong></div>
            </div>
          </div>
        </section>
        "#
    }

    #[test]
    fn builds_top_five_from_intelligence_points_and_keeps_the_page_iq_value() {
        let response = CodexRadarIntelligenceResponse {
            schema: 2,
            response_type: CODEX_RADAR_INTELLIGENCE_TYPE.into(),
            source_updated_at: "2026-07-31T07:25:33+08:00".into(),
            points: vec![
                intelligence_point("gpt-5.6-sol", "max", 103.1, 77, 9.14),
                intelligence_point("gpt-5.6-terra", "ultra", 97.8, 73, 14.06),
                intelligence_point("gpt-5.6-sol", "xhigh", 93.75, 70, 6.5183),
                intelligence_point("gpt-5.5", "xhigh", 92.4, 69, 5.88),
                intelligence_point("gpt-5.6-luna", "max", 91.1, 68, 2.32),
                intelligence_point("gpt-5.6-sol", "high", 88.4, 66, 5.38),
            ],
        };

        let payload =
            build_model_iq_payload_from_intelligence(response, "2026-07-31T09:38:25+08:00".into())
                .expect("build payload");

        assert_eq!(payload.items.len(), 5);
        assert_eq!(payload.items[0].id, "gpt-5.6-sol:max");
        assert_eq!(payload.items[1].id, "gpt-5.6-terra:ultra");
        let sol_xhigh = payload
            .items
            .iter()
            .find(|item| item.id == "gpt-5.6-sol:xhigh")
            .expect("Sol xhigh is in the top five");
        assert_eq!(sol_xhigh.score, 93.75);
        assert_eq!(sol_xhigh.average_cost_usd, 6.5183);
        assert_eq!(sol_xhigh.status, None);
        assert_eq!(payload.source_updated_at, "2026-07-31T07:25:33+08:00");
        assert!(!payload.is_stale);
    }

    #[test]
    fn accepts_integral_float_counters_from_intelligence_snapshot() {
        let integer_fixture = intelligence_response_fixture("210", "420");
        let integer_response =
            serde_json::from_str::<CodexRadarIntelligenceResponse>(&integer_fixture)
                .expect("parse integer counters");
        assert_eq!(integer_response.points[0].passed, 210);
        assert_eq!(integer_response.points[0].valid_tasks, 420);

        let fixture = intelligence_response_fixture("210.0", "420.0");
        let response = serde_json::from_str::<CodexRadarIntelligenceResponse>(&fixture)
            .expect("parse integral float counters");
        assert_eq!(response.points[0].passed, 210);
        assert_eq!(response.points[0].valid_tasks, 420);

        let payload = build_model_iq_payload_from_intelligence(
            serde_json::from_str(&fixture).expect("parse Model IQ source"),
            "2026-08-14T12:30:00+08:00".into(),
        )
        .expect("build Model IQ payload");
        assert_eq!(payload.items[0].passed, 210);
    }

    #[test]
    fn rejects_non_integral_or_invalid_intelligence_counters() {
        for (passed, valid_tasks) in [
            ("210.5", "420.0"),
            ("210.0", "420.5"),
            ("-9223372036854775809.0", "420.0"),
            ("9223372036854775808.0", "420.0"),
            (r#""210""#, "420.0"),
        ] {
            let fixture = intelligence_response_fixture(passed, valid_tasks);
            assert!(
                serde_json::from_str::<CodexRadarIntelligenceResponse>(&fixture).is_err(),
                "expected {passed}/{valid_tasks} to be rejected"
            );
        }
    }

    #[test]
    fn maps_insights_in_upstream_order_and_accepts_empty_alerts_and_optional_metrics() {
        let response =
            serde_json::from_str::<CodexRadarInsightsResponse>(insights_response_fixture())
                .expect("parse insights fixture");

        let payload = build_insights_payload(response, "2026-07-29 20:39:00".into())
            .expect("build insights payload");

        assert_eq!(
            payload
                .recommendations
                .iter()
                .map(|group| group.key.as_str())
                .collect::<Vec<_>>(),
            vec![
                "daily_development",
                "hard_problems",
                "background_automation",
                "lobster_tasks"
            ]
        );
        assert_eq!(
            payload.recommendations[0].items[0].id,
            "daily_development:gpt-5.5:xhigh"
        );
        assert_eq!(
            payload.recommendations[0].items[0].trend[0].samples,
            Some(12)
        );
        assert_eq!(payload.recommendations[1].items[0].average_cost_usd, None);
        assert_eq!(payload.recommendations[2].items[0].average_minutes, None);
        assert!(payload.degradation_alerts.is_empty());
        assert!(!payload.is_stale);
    }

    #[test]
    fn maps_degradation_alert_metrics_without_reordering() {
        let response = serde_json::from_str::<CodexRadarInsightsResponse>(
            r#"
            {
              "schema": 1,
              "source_updated_at": "2026-07-29T20:38:00+08:00",
              "recommendations": [],
              "degradation_alerts": {
                "rule": "12 小时 IQ 下降达到上游门槛",
                "items": [{
                  "model": "gpt-5.6-sol",
                  "effort": "max",
                  "current_iq": 92.4,
                  "average_iq_24h": 101.5,
                  "average_iq_48h": 103.2,
                  "degradation_12h_iq": 8.7,
                  "from_24h_average_iq": 9.1,
                  "from_48h_average_iq": 10.8,
                  "degradation_severity_score": 0.87,
                  "trend_48h": [{
                    "timestamp": "2026-07-29T18:00:00+08:00",
                    "iq": 92.4,
                    "samples": 9
                  }]
                }]
              }
            }
            "#,
        )
        .expect("parse alert fixture");

        let payload = build_insights_payload(response, "2026-07-29 20:39:00".into())
            .expect("build alert payload");
        let alert = &payload.degradation_alerts[0];

        assert_eq!(alert.id, "gpt-5.6-sol:max");
        assert_eq!(alert.score, 92.4);
        assert_eq!(alert.average_24h_score, Some(101.5));
        assert_eq!(alert.drop_12h, Some(8.7));
        assert_eq!(alert.severity_score, Some(0.87));
        assert_eq!(alert.trend[0].samples, Some(9));
    }

    #[test]
    fn rejects_insights_schema_and_required_text_failures() {
        let mut schema_error =
            serde_json::from_str::<CodexRadarInsightsResponse>(insights_response_fixture())
                .expect("parse insights fixture");
        schema_error.schema = 2;
        assert!(
            build_insights_payload(schema_error, "2026-07-29 20:39:00".into())
                .expect_err("schema must be rejected")
                .to_string()
                .contains("schema 不受支持")
        );

        let mut missing_title =
            serde_json::from_str::<CodexRadarInsightsResponse>(insights_response_fixture())
                .expect("parse insights fixture");
        missing_title.recommendations[0].title = "  ".into();
        assert!(
            build_insights_payload(missing_title, "2026-07-29 20:39:00".into())
                .expect_err("blank title must be rejected")
                .to_string()
                .contains("缺少标题")
        );
    }

    #[test]
    fn saves_fresh_insights_and_preserves_a_stale_snapshot_after_failure() {
        let db = build_test_db();
        let fresh = cached_insights_payload();

        let saved = resolve_codex_radar_insights_fetch(&db, Ok(fresh.clone()))
            .expect("fresh insights should be saved");
        assert!(!saved.is_stale);
        let record = repositories::find_codex_radar_insights_cache(&db)
            .expect("read fresh cache")
            .expect("fresh cache exists");
        assert_eq!(record.source_updated_at, fresh.source_updated_at);

        let stale = resolve_codex_radar_insights_fetch(
            &db,
            Err(anyhow::anyhow!("Codex Radar 推荐预警暂时不可用")),
        )
        .expect("cached insights should remain available");
        assert_eq!(stale.recommendations[0].items[0].score, 95.1);
        assert!(stale.is_stale);
        assert_eq!(
            stale.last_error.as_deref(),
            Some("Codex Radar 推荐预警暂时不可用")
        );
    }

    #[test]
    fn returns_original_insights_error_without_a_snapshot_and_selects_force_url() {
        let db = build_test_db();
        let error = resolve_codex_radar_insights_fetch(
            &db,
            Err(anyhow::anyhow!("Codex Radar 推荐预警首次请求失败")),
        )
        .expect_err("first insights failure must remain an error");

        assert_eq!(error.to_string(), "Codex Radar 推荐预警首次请求失败");
        assert_eq!(codex_radar_insights_url(false), CODEX_RADAR_INSIGHTS_URL);
        assert_eq!(
            codex_radar_insights_url(true),
            CODEX_RADAR_INSIGHTS_REFRESH_URL
        );
    }

    #[test]
    fn rejects_an_unexpected_intelligence_schema() {
        let mut response = CodexRadarIntelligenceResponse {
            schema: 2,
            response_type: CODEX_RADAR_INTELLIGENCE_TYPE.into(),
            source_updated_at: "2026-07-31T07:25:33+08:00".into(),
            points: vec![intelligence_point("gpt-5.6-sol", "max", 103.1, 77, 9.14)],
        };
        response.schema = 9;

        let error =
            build_model_iq_payload_from_intelligence(response, "2026-07-31T09:38:25+08:00".into())
                .expect_err("schema must be rejected");

        assert!(error.to_string().contains("智力效率 schema 不受支持"));
    }

    #[test]
    fn returns_the_original_fetch_error_when_no_snapshot_exists() {
        let db = build_test_db();

        let error =
            resolve_codex_radar_model_iq_fetch(&db, Err(anyhow::anyhow!("Codex Radar 暂时不可用")))
                .expect_err("first failure must remain an error");

        assert_eq!(error.to_string(), "Codex Radar 暂时不可用");
        assert!(repositories::find_codex_radar_model_iq_cache(&db)
            .expect("read cache")
            .is_none());
    }

    #[test]
    fn retains_a_cached_snapshot_when_the_next_fetch_fails() {
        let db = build_test_db();
        let cached = cached_payload();
        repositories::upsert_codex_radar_model_iq_cache(
            &db,
            &CodexRadarModelIqCacheRecord {
                payload_json: serde_json::to_string(&cached).expect("serialize cache fixture"),
                source_updated_at: cached.source_updated_at.clone(),
                fetched_at: cached.fetched_at.clone(),
                last_error: None,
            },
        )
        .expect("seed cache");

        let payload =
            resolve_codex_radar_model_iq_fetch(&db, Err(anyhow::anyhow!("Codex Radar 暂时不可用")))
                .expect("cached snapshot must be returned");

        assert_eq!(payload.items.len(), 1);
        assert_eq!(payload.items[0].id, cached.items[0].id);
        assert_eq!(payload.items[0].score, cached.items[0].score);
        assert!(payload.is_stale);
        assert_eq!(
            payload.last_error.as_deref(),
            Some("Codex Radar 暂时不可用")
        );
        let record = repositories::find_codex_radar_model_iq_cache(&db)
            .expect("read cache")
            .expect("cache exists");
        assert_eq!(record.last_error.as_deref(), Some("Codex Radar 暂时不可用"));
    }

    #[test]
    fn rejects_a_legacy_current_json_cache_when_refresh_fails() {
        let db = build_test_db();
        let mut legacy = cached_payload();
        legacy.items[0].status = Some("green".into());
        repositories::upsert_codex_radar_model_iq_cache(
            &db,
            &CodexRadarModelIqCacheRecord {
                payload_json: serde_json::to_string(&legacy).expect("serialize legacy cache"),
                source_updated_at: legacy.source_updated_at.clone(),
                fetched_at: legacy.fetched_at.clone(),
                last_error: None,
            },
        )
        .expect("seed legacy cache");

        let error =
            resolve_codex_radar_model_iq_fetch(&db, Err(anyhow::anyhow!("Codex Radar 暂时不可用")))
                .expect_err("legacy current.json cache must not be returned");

        assert_eq!(error.to_string(), "Codex Radar 暂时不可用");
        let record = repositories::find_codex_radar_model_iq_cache(&db)
            .expect("read cache")
            .expect("cache exists");
        assert_eq!(record.last_error.as_deref(), Some("Codex Radar 暂时不可用"));
    }

    #[test]
    fn parses_the_fast_radar_summary_and_model_comparisons_from_the_authorized_page() {
        let payload = build_fast_radar_payload(
            fast_radar_html_fixture(),
            "2026-07-22T10:12:00+08:00".into(),
        )
        .expect("parse Fast radar fixture");

        assert_eq!(payload.source_updated_at, "7月22日10:09更新");
        assert_eq!(payload.summary.cost_multiplier, 2.5);
        assert_eq!(payload.summary.e2e_multiplier, 1.208);
        assert_eq!(payload.items.len(), 2);
        assert_eq!(payload.items[0].model, "Sol");
        assert_eq!(payload.items[0].fast_e2e_seconds, 41.71);
        assert_eq!(payload.items[0].ttft_change_label, "慢 21.2%");
        assert_eq!(payload.items[1].tps_multiplier, 1.309);
    }

    #[test]
    fn retains_a_cached_fast_radar_snapshot_when_the_page_fetch_fails() {
        let db = build_test_db();
        let cached = cached_fast_radar_payload();
        repositories::upsert_codex_radar_fast_cache(
            &db,
            &CodexRadarFastCacheRecord {
                payload_json: serde_json::to_string(&cached).expect("serialize Fast cache fixture"),
                source_updated_at: cached.source_updated_at.clone(),
                fetched_at: cached.fetched_at.clone(),
                last_error: None,
            },
        )
        .expect("seed Fast cache");

        let payload = resolve_codex_radar_fast_fetch(
            &db,
            Err(anyhow::anyhow!("Codex Radar Fast 暂时不可用")),
        )
        .expect("cached Fast snapshot must be returned");

        assert!(payload.is_stale);
        assert_eq!(payload.items[0].model, "Sol");
        assert_eq!(
            payload.last_error.as_deref(),
            Some("Codex Radar Fast 暂时不可用")
        );
    }

    #[test]
    fn builds_full_efficiency_points_and_keeps_token_details_separate() {
        let current = serde_json::from_str::<CodexRadarCurrentResponse>(
            r#"
            {
              "schema_version": "2.0",
              "type": "public_summary",
              "model_iq": {
                "updated_at": "2026-07-22T08:16:45+08:00",
                "latest": {
                  "date": "2026-07-22T08:16:45+08:00",
                  "score": 101.8,
                  "status": "green",
                  "passed": 76,
                  "tasks": 112,
                  "valid_tasks": 112,
                  "total_tokens": 1440495393,
                  "input_tokens": 1434292308,
                  "cached_input_tokens": 1403734016,
                  "output_tokens": 6203085,
                  "wall_seconds": 239036,
                  "average_cost_usd": 9.27,
                  "average_task_seconds": 2125.2,
                  "model": "gpt-5.6-sol",
                  "reasoning_effort": "max"
                },
                "recent_days": [{
                  "date": "2026-07-22T04:16:45+08:00",
                  "score": 100.4,
                  "status": "green",
                  "passed": 75,
                  "tasks": 112,
                  "total_tokens": 1400000000,
                  "input_tokens": 1390000000,
                  "cached_input_tokens": 1360000000,
                  "output_tokens": 6100000,
                  "wall_seconds": 230000,
                  "average_cost_usd": 9.10,
                  "average_task_seconds": 2100
                }],
                "comparisons": {
                  "gpt_56_terra_low": {
                    "label": "GPT-5.6 Terra low",
                    "model": "gpt-5.6-terra",
                    "reasoning_effort": "low",
                    "latest": {
                      "date": "2026-07-22T08:02:07+08:00",
                      "score": 44.2,
                      "status": "red",
                      "passed": 33,
                      "tasks": 112,
                      "average_cost_usd": 0.55
                    },
                    "recent_days": []
                  }
                }
              }
            }
            "#,
        )
        .expect("parse current fixture");
        let intelligence = serde_json::from_str::<CodexRadarIntelligenceResponse>(
            r#"
            {
              "schema": 2,
              "type": "distributed_intelligence_efficiency",
              "source_updated_at": "2026-07-22T08:16:45+08:00",
              "points": [
                {
                  "model": "gpt-5.6-sol",
                  "effort": "max",
                  "iq": 101.8,
                  "passed": 210.0,
                  "valid_tasks": 420.0,
                  "average_price_usd": 9.27,
                  "average_minutes": 35.42,
                  "combined_cost_index": 8.74,
                  "total_runs": 328,
                  "latest_graded_at": "2026-07-22T08:16:45+08:00"
                },
                {
                  "model": "gpt-5.6-terra",
                  "effort": "ultra",
                  "iq": 100.4,
                  "passed": 75.0,
                  "valid_tasks": 112.0,
                  "average_price_usd": 13.60,
                  "average_minutes": 42.21,
                  "combined_cost_index": 21.90,
                  "total_runs": 288,
                  "latest_graded_at": "2026-07-22T07:57:18+08:00"
                }
              ]
            }
            "#,
        )
        .expect("parse intelligence fixture");

        let payload =
            build_intelligence_payload(current, intelligence, "2026-07-22T08:18:00+08:00".into())
                .expect("build intelligence payload");

        assert_eq!(payload.efficiency_points.len(), 2);
        assert_eq!(payload.detail_items.len(), 2);
        let sol = payload
            .detail_items
            .iter()
            .find(|item| item.model == "gpt-5.6-sol")
            .expect("Sol detail");
        assert_eq!(sol.total_tokens, Some(1_440_495_393));
        assert_eq!(sol.history.len(), 1);
        let terra_ultra = payload
            .efficiency_points
            .iter()
            .find(|item| item.reasoning_effort == "ultra")
            .expect("Terra ultra efficiency point");
        assert_eq!(terra_ultra.average_cost_usd, Some(13.60));
        let sol_efficiency = payload
            .efficiency_points
            .iter()
            .find(|item| item.model == "gpt-5.6-sol")
            .expect("Sol efficiency point");
        assert_eq!(sol_efficiency.passed, 210);
        assert_eq!(sol_efficiency.valid_tasks, 420);
        let terra_detail = payload
            .detail_items
            .iter()
            .find(|item| item.model == "gpt-5.6-terra")
            .expect("Terra detail");
        assert_eq!(terra_detail.total_tokens, None);
    }

    #[test]
    fn retains_cached_intelligence_snapshot_when_an_upstream_source_fails() {
        let db = build_test_db();
        let cached = cached_intelligence_payload();
        repositories::upsert_codex_radar_intelligence_cache(
            &db,
            &CodexRadarIntelligenceCacheRecord {
                payload_json: serde_json::to_string(&cached).expect("serialize cache fixture"),
                source_updated_at: cached.source_updated_at.clone(),
                fetched_at: cached.fetched_at.clone(),
                last_error: None,
            },
        )
        .expect("seed intelligence cache");

        let payload = resolve_codex_radar_intelligence_fetch(
            &db,
            Err(anyhow::anyhow!("Codex Radar 智力效率暂时不可用")),
        )
        .expect("cached intelligence snapshot must be returned");

        assert_eq!(payload.efficiency_points.len(), 1);
        assert!(payload.is_stale);
        assert_eq!(
            payload.last_error.as_deref(),
            Some("Codex Radar 智力效率暂时不可用")
        );
    }
}
