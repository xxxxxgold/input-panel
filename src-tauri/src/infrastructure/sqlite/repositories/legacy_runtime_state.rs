use anyhow::Result;
use rusqlite::params;

use crate::contracts::{AccountCacheView, UsageRow};

use crate::infrastructure::sqlite::Database;

pub(crate) fn load_all_legacy_cache_views(
    db: &Database,
) -> Result<std::collections::HashMap<String, AccountCacheView>> {
    let conn = db.connect()?;
    let mut cache_views = std::collections::HashMap::new();

    if has_table(&conn, "account_snapshots")? {
        let mut stmt = conn.prepare(
            "SELECT account_id, snapshot_json, last_error FROM account_snapshots ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let snapshot_json: String = row.get(1)?;
            let cache_view: AccountCacheView = serde_json::from_str(&snapshot_json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            Ok((account_id, cache_view))
        })?;

        for row in rows {
            let (account_id, cache_view) = row?;
            cache_views.insert(account_id, cache_view);
        }
    }

    Ok(cache_views)
}

pub(crate) fn load_legacy_usage_rows(db: &Database, account_id: &str) -> Result<Vec<UsageRow>> {
    let conn = db.connect()?;
    if !has_table(&conn, "usage_history")? {
        return Ok(load_all_legacy_cache_views(db)?
            .remove(account_id)
            .map(|cache_view| cache_view.recent_usage)
            .unwrap_or_default());
    }
    let mut stmt =
        conn.prepare("SELECT row_json FROM usage_history WHERE account_id = ?1 ORDER BY last_seen_at DESC")?;
    let rows = stmt.query_map(params![account_id], |row| row.get::<_, String>(0))?;
    let history_rows = rows
        .filter_map(|raw| raw.ok())
        .filter_map(|raw| serde_json::from_str::<UsageRow>(&raw).ok())
        .collect::<Vec<_>>();
    if !history_rows.is_empty() {
        return Ok(history_rows);
    }

    let cache_view = load_all_legacy_cache_views(db)?.remove(account_id);
    Ok(cache_view.map(|item| item.recent_usage).unwrap_or_default())
}

fn has_table(conn: &rusqlite::Connection, table_name: &str) -> Result<bool> {
    let exists = conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        params![table_name],
        |_row| Ok(()),
    );
    match exists {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(error.into()),
    }
}


