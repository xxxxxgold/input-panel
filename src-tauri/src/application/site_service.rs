use anyhow::Result;
use chrono::Utc;

use crate::contracts::{SiteInput, SiteRecord};
use crate::infrastructure::sqlite::repositories;

use super::AppContext;

pub fn create_site(ctx: &AppContext, payload: SiteInput) -> Result<SiteRecord> {
    let now = Utc::now().to_rfc3339();
    let site = SiteRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: payload.name.trim().to_string(),
        base_url: payload.base_url.trim().to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    repositories::insert_site(&ctx.db, &site)?;
    Ok(site)
}

pub fn update_site(
    ctx: &AppContext,
    site_id: &str,
    name: Option<String>,
    base_url: Option<String>,
) -> Result<SiteRecord> {
    let mut site = repositories::find_site(&ctx.db, site_id)?
        .ok_or_else(|| anyhow::anyhow!("站点不存在。"))?;
    if let Some(name) = name {
        site.name = name.trim().to_string();
    }
    if let Some(base_url) = base_url {
        site.base_url = base_url.trim().to_string();
    }
    site.updated_at = Utc::now().to_rfc3339();
    repositories::update_site(&ctx.db, &site)?;
    Ok(site)
}

pub fn remove_site(ctx: &AppContext, site_id: &str) -> Result<bool> {
    repositories::delete_site(&ctx.db, site_id)?;
    Ok(true)
}
