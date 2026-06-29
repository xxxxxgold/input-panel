use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::contracts::SiteRecord;
use crate::infrastructure::sqlite::Database;

pub fn insert_site(db: &Database, site: &SiteRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO sites (id, name, base_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![site.id, site.name, site.base_url, site.created_at, site.updated_at],
    )?;
    Ok(())
}

pub fn update_site(db: &Database, site: &SiteRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE sites SET name = ?2, base_url = ?3, updated_at = ?4 WHERE id = ?1",
        params![site.id, site.name, site.base_url, site.updated_at],
    )?;
    Ok(())
}

pub fn delete_site(db: &Database, site_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute("DELETE FROM sites WHERE id = ?1", params![site_id])?;
    Ok(())
}

pub fn find_site(db: &Database, site_id: &str) -> Result<Option<SiteRecord>> {
    let conn = db.connect()?;
    let site = conn
        .query_row(
            "SELECT id, name, base_url, created_at, updated_at FROM sites WHERE id = ?1",
            params![site_id],
            |row| {
                Ok(SiteRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    base_url: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(site)
}

