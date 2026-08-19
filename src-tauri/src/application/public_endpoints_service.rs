use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use reqwest::Url;
use serde::Deserialize;
use std::sync::OnceLock;
use tokio::task::JoinSet;

use crate::contracts::{PublicEndpointRecord, SitePublicEndpointsPayload, SiteRecord};
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories::{self, SitePublicEndpointCacheRecord};
use crate::infrastructure::upstream_http_client::upstream_http_client_builder;

use super::AppContext;

const SETTINGS_PUBLIC_PATH: &str = "/api/v1/settings/public";
const SETTINGS_PUBLIC_TIMEOUT_SECS: u64 = 10;
const SETTINGS_PUBLIC_TIMEZONE: &str = "Asia/Shanghai";
const PUBLIC_ENDPOINT_PING_TIMEOUT_SECS: u64 = 5;
static DIRECT_PUBLIC_ENDPOINT_PING_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SYSTEM_PROXY_PUBLIC_ENDPOINT_PING_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct SettingsPublicEnvelope {
    code: Option<i64>,
    message: Option<String>,
    data: Option<SettingsPublicData>,
}

#[derive(Debug, Deserialize)]
struct SettingsPublicData {
    api_base_url: Option<String>,
    #[serde(default)]
    custom_endpoints: Vec<PublicEndpointRecord>,
}

pub fn get_site_public_endpoints(
    ctx: &AppContext,
    site_id: &str,
) -> Result<Option<SitePublicEndpointsPayload>> {
    let site = load_site(ctx, site_id)?;
    let Some(cache) = repositories::find_site_public_endpoint_cache(&ctx.db, site_id)? else {
        return Ok(None);
    };
    Ok(Some(build_site_public_endpoints_payload(&site, cache)))
}

pub async fn sync_site_public_endpoints(
    ctx: &AppContext,
    site_id: &str,
) -> Result<SitePublicEndpointsPayload> {
    let site = load_site(ctx, site_id)?;
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;

    match fetch_upstream_public_settings(&site, use_system_proxy).await {
        Ok(settings) => {
            let api_base_url =
                normalize_default_api_base_url(settings.api_base_url.as_deref(), &site.base_url);
            let custom_endpoints = normalize_custom_endpoints(settings.custom_endpoints);
            let fetched_at = now_storage_timestamp();

            repositories::upsert_site_public_endpoint_cache(
                &ctx.db,
                &SitePublicEndpointCacheRecord {
                    site_id: site.id.clone(),
                    api_base_url,
                    custom_endpoints_json: serde_json::to_string(&custom_endpoints)
                        .context("序列化站点公共端点缓存失败")?,
                    fetched_at,
                    last_error: None,
                },
            )?;
        }
        Err(error) => {
            repositories::update_site_public_endpoint_cache_error(
                &ctx.db,
                site_id,
                Some(&error.to_string()),
            )?;

            if let Some(cache) = repositories::find_site_public_endpoint_cache(&ctx.db, site_id)? {
                return Ok(build_site_public_endpoints_payload(&site, cache));
            }

            return Err(error);
        }
    }

    let cache = repositories::find_site_public_endpoint_cache(&ctx.db, site_id)?
        .ok_or_else(|| anyhow!("站点公共端点缓存未写入。"))?;
    Ok(build_site_public_endpoints_payload(&site, cache))
}

pub async fn ping_site_public_endpoints(
    ctx: &AppContext,
    site_id: &str,
) -> Result<SitePublicEndpointsPayload> {
    let payload = match get_site_public_endpoints(ctx, site_id)? {
        Some(cached) => cached,
        None => sync_site_public_endpoints(ctx, site_id).await?,
    };
    let use_system_proxy = ctx
        .runtime_coordination
        .get_upstream_network_config()
        .await?
        .use_system_proxy;
    let endpoints = probe_public_endpoints(payload.endpoints, use_system_proxy).await?;
    Ok(SitePublicEndpointsPayload {
        endpoints,
        ..payload
    })
}

fn load_site(ctx: &AppContext, site_id: &str) -> Result<SiteRecord> {
    repositories::find_site(&ctx.db, site_id)?.ok_or_else(|| anyhow!("站点不存在。"))
}

fn build_site_public_endpoints_payload(
    site: &SiteRecord,
    cache: SitePublicEndpointCacheRecord,
) -> SitePublicEndpointsPayload {
    let custom_endpoints =
        serde_json::from_str::<Vec<PublicEndpointRecord>>(&cache.custom_endpoints_json)
            .unwrap_or_default();

    SitePublicEndpointsPayload {
        site_id: site.id.clone(),
        site_name: site.name.clone(),
        api_base_url: cache.api_base_url.clone(),
        endpoints: build_display_public_endpoints(&cache.api_base_url, custom_endpoints),
        fetched_at: cache.fetched_at,
        last_error: cache.last_error,
    }
}

fn build_display_public_endpoints(
    api_base_url: &str,
    custom_endpoints: Vec<PublicEndpointRecord>,
) -> Vec<PublicEndpointRecord> {
    let mut endpoints = vec![PublicEndpointRecord {
        name: "默认API".into(),
        endpoint: api_base_url.trim().to_string(),
        description: "当前站点默认入口".into(),
        ping_latency_ms: None,
        ping_status_code: None,
        ping_checked_at: None,
        ping_error: None,
    }];
    endpoints.extend(custom_endpoints);
    endpoints
}

fn normalize_default_api_base_url(api_base_url: Option<&str>, fallback: &str) -> String {
    let candidate = api_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    candidate.trim_end_matches('/').to_string()
}

fn normalize_custom_endpoints(input: Vec<PublicEndpointRecord>) -> Vec<PublicEndpointRecord> {
    input
        .into_iter()
        .filter_map(|item| {
            let endpoint = item.endpoint.trim().trim_end_matches('/').to_string();
            if endpoint.is_empty() {
                return None;
            }

            let name = if item.name.trim().is_empty() {
                endpoint.clone()
            } else {
                item.name.trim().to_string()
            };

            Some(PublicEndpointRecord {
                name,
                endpoint,
                description: item.description.trim().to_string(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            })
        })
        .collect()
}

async fn probe_public_endpoints(
    input: Vec<PublicEndpointRecord>,
    use_system_proxy: bool,
) -> Result<Vec<PublicEndpointRecord>> {
    if input.is_empty() {
        return Ok(Vec::new());
    }

    let client = public_endpoint_ping_client(use_system_proxy)?;

    let mut probes = JoinSet::new();
    let total = input.len();
    for (index, endpoint) in input.into_iter().enumerate() {
        let client = client.clone();
        probes.spawn(async move { (index, probe_public_endpoint(client, endpoint).await) });
    }

    let mut results = vec![None; total];
    while let Some(joined) = probes.join_next().await {
        let (index, record) = joined.context("等待公共入口探测结果失败")?;
        results[index] = Some(record);
    }

    Ok(results.into_iter().flatten().collect())
}

async fn probe_public_endpoint(
    client: reqwest::Client,
    mut endpoint: PublicEndpointRecord,
) -> PublicEndpointRecord {
    let started_at = std::time::Instant::now();
    let checked_at = Utc::now().to_rfc3339();

    match client
        .head(endpoint.endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
    {
        Ok(response) => {
            endpoint.ping_latency_ms = Some(elapsed_millis_i64(started_at));
            endpoint.ping_status_code = Some(response.status().as_u16());
            endpoint.ping_checked_at = Some(checked_at);
            endpoint.ping_error = None;
        }
        Err(error) => {
            endpoint.ping_latency_ms = None;
            endpoint.ping_status_code = None;
            endpoint.ping_checked_at = Some(checked_at);
            endpoint.ping_error = Some(normalize_ping_error(&error));
        }
    }

    endpoint
}

fn public_endpoint_ping_client(use_system_proxy: bool) -> Result<reqwest::Client> {
    let shared = if use_system_proxy {
        &SYSTEM_PROXY_PUBLIC_ENDPOINT_PING_CLIENT
    } else {
        &DIRECT_PUBLIC_ENDPOINT_PING_CLIENT
    };
    if let Some(client) = shared.get() {
        return Ok(client.clone());
    }

    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(std::time::Duration::from_secs(
            PUBLIC_ENDPOINT_PING_TIMEOUT_SECS,
        ))
        .redirect(reqwest::redirect::Policy::none())
        .tcp_nodelay(true)
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .build()
        .context("初始化公共入口探测客户端失败")?;

    let _ = shared.set(client.clone());
    Ok(client)
}

fn elapsed_millis_i64(started_at: std::time::Instant) -> i64 {
    let elapsed = started_at.elapsed().as_millis();
    i64::try_from(elapsed).unwrap_or(i64::MAX)
}

fn normalize_ping_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "请求超时".into();
    }
    if error.is_connect() {
        return "连接失败".into();
    }

    let message = error.to_string();
    if message.trim().is_empty() {
        "探测失败".into()
    } else {
        message
    }
}

async fn fetch_upstream_public_settings(
    site: &SiteRecord,
    use_system_proxy: bool,
) -> Result<SettingsPublicData> {
    let client = upstream_http_client_builder(use_system_proxy)
        .timeout(std::time::Duration::from_secs(SETTINGS_PUBLIC_TIMEOUT_SECS))
        .build()
        .context("初始化站点公共端点请求客户端失败")?;

    let url = build_settings_public_url(&site.base_url)
        .with_context(|| format!("构建站点公共端点地址失败: {}", site.base_url))?;

    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .with_context(|| format!("请求 {} 站点公共端点失败", site.name))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "请求 {} 站点公共端点失败: HTTP {}{}",
            site.name,
            status,
            extract_response_tail(&body)
        ));
    }

    let envelope = response
        .json::<SettingsPublicEnvelope>()
        .await
        .with_context(|| format!("解析 {} 站点公共端点返回失败", site.name))?;

    if envelope.code.unwrap_or(0) != 0 {
        return Err(anyhow!(
            "{}",
            envelope
                .message
                .unwrap_or_else(|| format!("{} 站点公共端点接口返回异常", site.name))
        ));
    }

    envelope
        .data
        .ok_or_else(|| anyhow!("{} 站点公共端点返回为空。", site.name))
}

fn build_settings_public_url(base_url: &str) -> Result<Url> {
    let mut url = Url::parse(&format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        SETTINGS_PUBLIC_PATH
    ))?;
    url.query_pairs_mut()
        .append_pair("timezone", SETTINGS_PUBLIC_TIMEZONE);
    Ok(url)
}

fn extract_response_tail(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let preview = trimmed.chars().take(120).collect::<String>();
    format!(" · {}", preview)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::{http::StatusCode, routing::head, Router};

    use super::{
        build_display_public_endpoints, normalize_custom_endpoints, normalize_default_api_base_url,
        probe_public_endpoint,
    };
    use crate::contracts::PublicEndpointRecord;
    use crate::test_support::TestAxumServer;

    #[test]
    fn build_display_public_endpoints_prepends_default_api() {
        let endpoints = build_display_public_endpoints(
            "https://ai.input.im",
            vec![PublicEndpointRecord {
                name: "Cloudflare".into(),
                endpoint: "https://input.codes".into(),
                description: "国际优化".into(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            }],
        );

        assert_eq!(endpoints[0].name, "默认API");
        assert_eq!(endpoints[0].endpoint, "https://ai.input.im");
        assert_eq!(endpoints[0].ping_latency_ms, None);
        assert_eq!(endpoints[1].name, "Cloudflare");
    }

    #[test]
    fn normalize_custom_endpoints_trims_and_skips_blank_endpoint() {
        let endpoints = normalize_custom_endpoints(vec![
            PublicEndpointRecord {
                name: "  Veilx  ".into(),
                endpoint: " https://ai.input.im/ ".into(),
                description: " 回国优化 ".into(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            },
            PublicEndpointRecord {
                name: "missing".into(),
                endpoint: "   ".into(),
                description: String::new(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            },
        ]);

        assert_eq!(
            endpoints,
            vec![PublicEndpointRecord {
                name: "Veilx".into(),
                endpoint: "https://ai.input.im".into(),
                description: "回国优化".into(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            }]
        );
    }

    #[test]
    fn normalize_default_api_base_url_falls_back_to_site_base_url() {
        assert_eq!(
            normalize_default_api_base_url(Some(" https://input.codes/ "), "https://ai.input.im"),
            "https://input.codes"
        );
        assert_eq!(
            normalize_default_api_base_url(Some("   "), "https://ai.input.im/"),
            "https://ai.input.im"
        );
    }

    #[tokio::test]
    async fn probe_public_endpoint_records_latency_and_status_code() {
        let server = TestAxumServer::start(|_| {
            Router::new().route("/", head(|| async { StatusCode::NO_CONTENT }))
        })
        .await;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let record = probe_public_endpoint(
            client,
            PublicEndpointRecord {
                name: "默认API".into(),
                endpoint: server.base_url().to_string(),
                description: "当前站点默认入口".into(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            },
        )
        .await;

        server.shutdown().await;

        assert_eq!(record.ping_status_code, Some(204));
        assert!(record.ping_latency_ms.is_some());
        assert!(record.ping_checked_at.is_some());
        assert_eq!(record.ping_error, None);
    }

    #[tokio::test]
    async fn probe_public_endpoint_marks_connection_failure() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .build()
            .unwrap();
        let record = probe_public_endpoint(
            client,
            PublicEndpointRecord {
                name: "坏地址".into(),
                endpoint: "http://127.0.0.1:9".into(),
                description: String::new(),
                ping_latency_ms: None,
                ping_status_code: None,
                ping_checked_at: None,
                ping_error: None,
            },
        )
        .await;

        assert_eq!(record.ping_latency_ms, None);
        assert_eq!(record.ping_status_code, None);
        assert!(record.ping_checked_at.is_some());
        assert!(record.ping_error.is_some());
    }
}
