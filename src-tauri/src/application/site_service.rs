use std::collections::HashSet;

use crate::contracts::{SiteInput, SitePatchInput, SiteRecord};
use crate::domain::site_url::canonicalize_site_base_url;
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories;
use anyhow::Result;

use super::AppContext;

pub fn create_site(ctx: &AppContext, payload: SiteInput) -> Result<SiteRecord> {
    let now = now_storage_timestamp();
    let site = validate_site(SiteRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: payload.name,
        base_url: payload.base_url,
        fallback_base_urls: payload.fallback_base_urls,
        failover_cooldown_seconds: payload.failover_cooldown_seconds,
        max_attempts_per_address: payload.max_attempts_per_address,
        created_at: now.clone(),
        updated_at: now,
    })?;
    repositories::insert_site(&ctx.db, &site)?;
    Ok(site)
}

pub fn update_site(ctx: &AppContext, site_id: &str, payload: SitePatchInput) -> Result<SiteRecord> {
    let mut site = repositories::find_site(&ctx.db, site_id)?
        .ok_or_else(|| anyhow::anyhow!("站点不存在。"))?;
    if let Some(name) = payload.name {
        site.name = name;
    }
    if let Some(base_url) = payload.base_url {
        site.base_url = base_url;
    }
    if let Some(fallback_base_urls) = payload.fallback_base_urls {
        site.fallback_base_urls = fallback_base_urls;
    }
    if let Some(failover_cooldown_seconds) = payload.failover_cooldown_seconds {
        site.failover_cooldown_seconds = failover_cooldown_seconds;
    }
    if let Some(max_attempts_per_address) = payload.max_attempts_per_address {
        site.max_attempts_per_address = max_attempts_per_address;
    }
    site.updated_at = now_storage_timestamp();
    let site = validate_site(site)?;
    repositories::update_site(&ctx.db, &site)?;
    Ok(site)
}

pub fn remove_site(ctx: &AppContext, site_id: &str) -> Result<bool> {
    repositories::delete_site(&ctx.db, site_id)?;
    Ok(true)
}

fn validate_site(mut site: SiteRecord) -> Result<SiteRecord> {
    site.name = site.name.trim().to_string();
    if site.name.is_empty() {
        anyhow::bail!("站点名称不能为空。");
    }
    if site.fallback_base_urls.len() > 10 {
        anyhow::bail!("每个站点最多只能配置 10 个备用地址。");
    }
    if site.failover_cooldown_seconds == 0 {
        anyhow::bail!("冷却时长必须大于 0 秒。");
    }
    if site.max_attempts_per_address == 0 {
        anyhow::bail!("每个地址最大访问次数必须大于 0。");
    }

    site.base_url = canonicalize_site_base_url(&site.base_url)?;
    let mut seen = HashSet::with_capacity(site.fallback_base_urls.len() + 1);
    seen.insert(site.base_url.clone());
    let mut fallbacks = Vec::with_capacity(site.fallback_base_urls.len());
    for fallback in site.fallback_base_urls {
        let fallback = canonicalize_site_base_url(&fallback)?;
        if !seen.insert(fallback.clone()) {
            anyhow::bail!("主地址和备用地址不能重复。");
        }
        fallbacks.push(fallback);
    }
    site.fallback_base_urls = fallbacks;
    Ok(site)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_site() -> SiteRecord {
        SiteRecord {
            name: " Test Site ".to_string(),
            base_url: "HTTPS://Example.Test:443/api/".to_string(),
            fallback_base_urls: vec![" https://Fallback.Test/ ".to_string()],
            failover_cooldown_seconds: 60,
            max_attempts_per_address: 1,
            ..SiteRecord::default()
        }
    }

    #[test]
    fn validation_canonicalizes_site_configuration() {
        let site = validate_site(valid_site()).expect("validate site");
        assert_eq!(site.name, "Test Site");
        assert_eq!(site.base_url, "https://example.test/api");
        assert_eq!(site.fallback_base_urls, vec!["https://fallback.test"]);
    }

    #[test]
    fn validation_rejects_duplicate_and_excess_fallbacks() {
        let mut duplicate = valid_site();
        duplicate.fallback_base_urls = vec!["https://example.test/api/".to_string()];
        assert!(validate_site(duplicate).is_err());

        let mut excessive = valid_site();
        excessive.fallback_base_urls = (0..11)
            .map(|index| format!("https://fallback-{index}.test"))
            .collect();
        assert!(validate_site(excessive).is_err());
    }

    #[test]
    fn validation_requires_positive_numeric_configuration() {
        let mut zero_cooldown = valid_site();
        zero_cooldown.failover_cooldown_seconds = 0;
        assert!(validate_site(zero_cooldown).is_err());

        let mut zero_attempts = valid_site();
        zero_attempts.max_attempts_per_address = 0;
        assert!(validate_site(zero_attempts).is_err());
    }
}
