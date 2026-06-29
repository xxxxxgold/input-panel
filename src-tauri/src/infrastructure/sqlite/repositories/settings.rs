use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::infrastructure::sqlite::Database;

pub fn set_setting(db: &Database, key: &str, value: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_setting(db: &Database, key: &str) -> Result<Option<String>> {
    let conn = db.connect()?;
    let value = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value)
}

