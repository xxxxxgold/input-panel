use anyhow::Result;
use rusqlite::params;

use super::Database;

pub fn load_usage_history(db: &Database, account_id: &str) -> Result<Vec<String>> {
    let conn = db.connect()?;
    let mut stmt =
        conn.prepare("SELECT row_json FROM usage_history WHERE account_id = ?1 ORDER BY last_seen_at DESC")?;
    let rows = stmt.query_map(params![account_id], |row| row.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}
