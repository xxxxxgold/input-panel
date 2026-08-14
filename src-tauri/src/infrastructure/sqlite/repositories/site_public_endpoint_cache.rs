use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::infrastructure::sqlite::Database;

#[derive(Debug, Clone)]
pub struct SitePublicEndpointCacheRecord {
    pub site_id: String,
    pub api_base_url: String,
    pub custom_endpoints_json: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
}

pub fn find_site_public_endpoint_cache(
    db: &Database,
    site_id: &str,
) -> Result<Option<SitePublicEndpointCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT site_id, api_base_url, custom_endpoints_json, fetched_at, last_error
             FROM site_public_endpoint_cache
             WHERE site_id = ?1",
            params![site_id],
            |row| {
                Ok(SitePublicEndpointCacheRecord {
                    site_id: row.get(0)?,
                    api_base_url: row.get(1)?,
                    custom_endpoints_json: row.get(2)?,
                    fetched_at: row.get(3)?,
                    last_error: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn upsert_site_public_endpoint_cache(
    db: &Database,
    record: &SitePublicEndpointCacheRecord,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO site_public_endpoint_cache (
            site_id, api_base_url, custom_endpoints_json, fetched_at, last_error
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(site_id) DO UPDATE SET
            api_base_url = excluded.api_base_url,
            custom_endpoints_json = excluded.custom_endpoints_json,
            fetched_at = excluded.fetched_at,
            last_error = excluded.last_error",
        params![
            record.site_id,
            record.api_base_url,
            record.custom_endpoints_json,
            record.fetched_at,
            record.last_error,
        ],
    )?;
    Ok(())
}

pub fn update_site_public_endpoint_cache_error(
    db: &Database,
    site_id: &str,
    last_error: Option<&str>,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE site_public_endpoint_cache
         SET last_error = ?2
         WHERE site_id = ?1",
        params![site_id, last_error],
    )?;
    Ok(())
}
