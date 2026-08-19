use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::infrastructure::sqlite::Database;

#[derive(Debug, Clone)]
pub struct CodexRadarFastCacheRecord {
    pub payload_json: String,
    pub source_updated_at: String,
    pub fetched_at: String,
    pub last_error: Option<String>,
}

pub fn find_codex_radar_fast_cache(db: &Database) -> Result<Option<CodexRadarFastCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT payload_json, source_updated_at, fetched_at, last_error
             FROM codex_radar_fast_cache
             WHERE id = 1",
            [],
            |row| {
                Ok(CodexRadarFastCacheRecord {
                    payload_json: row.get(0)?,
                    source_updated_at: row.get(1)?,
                    fetched_at: row.get(2)?,
                    last_error: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn upsert_codex_radar_fast_cache(
    db: &Database,
    record: &CodexRadarFastCacheRecord,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO codex_radar_fast_cache (
            id, payload_json, source_updated_at, fetched_at, last_error
         ) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            payload_json = excluded.payload_json,
            source_updated_at = excluded.source_updated_at,
            fetched_at = excluded.fetched_at,
            last_error = excluded.last_error",
        params![
            record.payload_json,
            record.source_updated_at,
            record.fetched_at,
            record.last_error,
        ],
    )?;
    Ok(())
}

pub fn update_codex_radar_fast_cache_error(db: &Database, last_error: Option<&str>) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE codex_radar_fast_cache
         SET last_error = ?1
         WHERE id = 1",
        params![last_error],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_db() -> Database {
        let db_path = std::env::temp_dir().join(format!(
            "input-panel-codex-radar-fast-cache-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(db_path);
        let _ = db.connect().expect("init sqlite");
        db
    }

    #[test]
    fn upserts_the_singleton_snapshot_and_retains_refresh_error() {
        let db = build_test_db();
        upsert_codex_radar_fast_cache(
            &db,
            &CodexRadarFastCacheRecord {
                payload_json: r#"{\"items\":[]}"#.into(),
                source_updated_at: "7月22日10:09更新".into(),
                fetched_at: "2026-07-22T08:18:00+08:00".into(),
                last_error: None,
            },
        )
        .expect("write cache");

        update_codex_radar_fast_cache_error(&db, Some("上游暂时不可用")).expect("record error");

        let record = find_codex_radar_fast_cache(&db)
            .expect("read cache")
            .expect("cache exists");
        assert_eq!(record.payload_json, r#"{\"items\":[]}"#);
        assert_eq!(record.last_error.as_deref(), Some("上游暂时不可用"));
    }
}
