use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::contracts::StoredSession;
use super::Database;

pub fn save_session(db: &Database, account_id: &str, session: &StoredSession) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO sessions (account_id, access_token, refresh_token, token_type, cookie_jar_json, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(account_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           token_type = excluded.token_type,
           cookie_jar_json = excluded.cookie_jar_json,
           saved_at = excluded.saved_at",
        params![
            account_id,
            session.access_token,
            session.refresh_token,
            session.token_type,
            session.cookie_jar_json,
            session.saved_at
        ],
    )?;
    Ok(())
}

pub fn load_session(db: &Database, account_id: &str) -> Result<Option<StoredSession>> {
    let conn = db.connect()?;
    let session = conn
        .query_row(
            "SELECT saved_at, access_token, refresh_token, token_type, cookie_jar_json FROM sessions WHERE account_id = ?1",
            params![account_id],
            |row| {
                Ok(StoredSession {
                    saved_at: row.get(0)?,
                    access_token: row.get(1)?,
                    refresh_token: row.get(2)?,
                    token_type: row.get(3)?,
                    cookie_jar_json: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(session)
}

pub fn remove_session(db: &Database, account_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute("DELETE FROM sessions WHERE account_id = ?1", params![account_id])?;
    Ok(())
}
