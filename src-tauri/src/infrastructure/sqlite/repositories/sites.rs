use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};

use crate::contracts::SiteRecord;
use crate::infrastructure::sqlite::Database;

pub fn insert_site(db: &Database, site: &SiteRecord) -> Result<()> {
    let mut conn = db.connect()?;
    let transaction = conn.transaction()?;
    transaction.execute(
        "INSERT INTO sites (
            id, name, base_url, failover_cooldown_seconds, retry_count_per_address,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            site.id,
            site.name,
            site.base_url,
            i64::from(site.failover_cooldown_seconds),
            i64::from(site.retry_count_per_address),
            site.created_at,
            site.updated_at
        ],
    )?;
    replace_fallback_base_urls(&transaction, site)?;
    transaction.commit()?;
    Ok(())
}

pub fn update_site(db: &Database, site: &SiteRecord) -> Result<()> {
    let mut conn = db.connect()?;
    let transaction = conn.transaction()?;
    transaction.execute(
        "UPDATE sites
         SET name = ?2,
             base_url = ?3,
             failover_cooldown_seconds = ?4,
             retry_count_per_address = ?5,
             updated_at = ?6
         WHERE id = ?1",
        params![
            site.id,
            site.name,
            site.base_url,
            i64::from(site.failover_cooldown_seconds),
            i64::from(site.retry_count_per_address),
            site.updated_at
        ],
    )?;
    replace_fallback_base_urls(&transaction, site)?;
    transaction.commit()?;
    Ok(())
}

pub fn delete_site(db: &Database, site_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute("DELETE FROM sites WHERE id = ?1", params![site_id])?;
    Ok(())
}

pub fn find_site(db: &Database, site_id: &str) -> Result<Option<SiteRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT
            s.id, s.name, s.base_url, s.failover_cooldown_seconds,
            s.retry_count_per_address, s.created_at, s.updated_at, f.base_url
         FROM sites s
         LEFT JOIN site_fallback_base_urls f ON f.site_id = s.id
         WHERE s.id = ?1
         ORDER BY f.position ASC",
    )?;
    let rows = stmt.query_map(params![site_id], read_joined_site_row)?;
    Ok(collect_joined_sites(rows)?.pop())
}

pub fn list_sites(db: &Database) -> Result<Vec<SiteRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT
            s.id, s.name, s.base_url, s.failover_cooldown_seconds,
            s.retry_count_per_address, s.created_at, s.updated_at, f.base_url
         FROM sites s
         LEFT JOIN site_fallback_base_urls f ON f.site_id = s.id
         ORDER BY s.created_at ASC, s.id ASC, f.position ASC",
    )?;
    let rows = stmt.query_map([], read_joined_site_row)?;
    collect_joined_sites(rows)
}

fn replace_fallback_base_urls(conn: &Connection, site: &SiteRecord) -> Result<()> {
    conn.execute(
        "DELETE FROM site_fallback_base_urls WHERE site_id = ?1",
        params![site.id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT INTO site_fallback_base_urls (site_id, position, base_url)
         VALUES (?1, ?2, ?3)",
    )?;
    for (position, base_url) in site.fallback_base_urls.iter().enumerate() {
        stmt.execute(params![site.id, position as i64, base_url])?;
    }
    Ok(())
}

type JoinedSiteRow = (
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    Option<String>,
);

fn read_joined_site_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JoinedSiteRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn collect_joined_sites<I>(rows: I) -> Result<Vec<SiteRecord>>
where
    I: Iterator<Item = rusqlite::Result<JoinedSiteRow>>,
{
    let mut sites = Vec::new();
    for row in rows {
        let (id, name, base_url, cooldown, retry_count, created_at, updated_at, fallback) = row?;
        let is_new_site = sites
            .last()
            .map(|site: &SiteRecord| site.id != id)
            .unwrap_or(true);
        if is_new_site {
            sites.push(SiteRecord {
                id,
                name,
                base_url,
                fallback_base_urls: Vec::new(),
                failover_cooldown_seconds: positive_u32(cooldown, "failover_cooldown_seconds")?,
                retry_count_per_address: non_negative_u32(retry_count, "retry_count_per_address")?,
                created_at,
                updated_at,
            });
        }
        if let Some(fallback) = fallback {
            sites
                .last_mut()
                .expect("joined site row must create a parent first")
                .fallback_base_urls
                .push(fallback);
        }
    }
    Ok(sites)
}

fn positive_u32(value: i64, column: &str) -> Result<u32> {
    let value =
        u32::try_from(value).map_err(|_| anyhow!("站点配置字段 {column} 超出可表示范围。"))?;
    if value == 0 {
        return Err(anyhow!("站点配置字段 {column} 必须大于 0。"));
    }
    Ok(value)
}

fn non_negative_u32(value: i64, column: &str) -> Result<u32> {
    u32::try_from(value).map_err(|_| anyhow!("站点配置字段 {column} 超出可表示范围。"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn test_database(label: &str) -> (Database, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "input-panel-sites-{label}-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(path.clone());
        drop(db.connect().expect("initialize site test database"));
        (db, path)
    }

    fn site(id: &str, fallbacks: &[&str]) -> SiteRecord {
        SiteRecord {
            id: id.to_string(),
            name: format!("site-{id}"),
            base_url: format!("https://{id}.example.test"),
            fallback_base_urls: fallbacks.iter().map(|value| (*value).to_string()).collect(),
            failover_cooldown_seconds: 75,
            retry_count_per_address: 0,
            created_at: "2026-08-10 10:00:00".to_string(),
            updated_at: "2026-08-10 10:00:00".to_string(),
        }
    }

    fn cleanup(path: PathBuf) {
        for candidate in [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            let _ = fs::remove_file(candidate);
        }
    }

    #[test]
    fn site_configuration_round_trips_with_ordered_fallbacks() {
        let (db, path) = test_database("round-trip");
        let expected = site(
            "primary",
            &["https://fallback-a.test", "https://fallback-b.test"],
        );

        insert_site(&db, &expected).expect("insert site aggregate");

        let actual = find_site(&db, &expected.id)
            .expect("find site aggregate")
            .expect("site exists");
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.base_url, expected.base_url);
        assert_eq!(actual.fallback_base_urls, expected.fallback_base_urls);
        assert_eq!(actual.failover_cooldown_seconds, 75);
        assert_eq!(actual.retry_count_per_address, 0);
        drop(db);
        cleanup(path);
    }

    #[test]
    fn duplicate_fallback_rolls_back_parent_insert() {
        let (db, path) = test_database("insert-rollback");
        let duplicate = site("duplicate", &["https://same.test", "https://same.test"]);

        insert_site(&db, &duplicate).expect_err("duplicate child should reject aggregate");

        assert!(find_site(&db, &duplicate.id)
            .expect("query rolled-back parent")
            .is_none());
        drop(db);
        cleanup(path);
    }

    #[test]
    fn failed_update_preserves_previous_parent_and_children() {
        let (db, path) = test_database("update-rollback");
        let original = site("stable", &["https://fallback.test"]);
        insert_site(&db, &original).expect("insert original site");
        let mut invalid = original.clone();
        invalid.name = "changed".to_string();
        invalid.fallback_base_urls = vec![
            "https://duplicate.test".to_string(),
            "https://duplicate.test".to_string(),
        ];

        update_site(&db, &invalid).expect_err("duplicate child should roll back update");

        let actual = find_site(&db, &original.id)
            .expect("find preserved site")
            .expect("site exists");
        assert_eq!(actual.name, original.name);
        assert_eq!(actual.fallback_base_urls, original.fallback_base_urls);
        drop(db);
        cleanup(path);
    }

    #[test]
    fn delete_site_cascades_to_fallback_rows() {
        let (db, path) = test_database("delete-cascade");
        let record = site("delete", &["https://fallback.test"]);
        insert_site(&db, &record).expect("insert site");

        delete_site(&db, &record.id).expect("delete site");

        let conn = db.connect().expect("connect after delete");
        let fallback_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM site_fallback_base_urls WHERE site_id = ?1",
                params![record.id],
                |row| row.get(0),
            )
            .expect("count fallback rows");
        assert_eq!(fallback_count, 0);
        drop(conn);
        drop(db);
        cleanup(path);
    }
}
