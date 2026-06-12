use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::contracts::StoredCredential;
use super::Database;

pub fn save_credential(db: &Database, credential: &StoredCredential) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO credentials (account_id, email, password, saved_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account_id) DO UPDATE SET
           email = excluded.email,
           password = excluded.password,
           saved_at = excluded.saved_at",
        params![
            credential.account_id,
            credential.email,
            credential.password,
            credential.saved_at
        ],
    )?;
    Ok(())
}

pub fn load_credential(db: &Database, account_id: &str) -> Result<Option<StoredCredential>> {
    let conn = db.connect()?;
    let credential = conn
        .query_row(
            "SELECT account_id, email, password, saved_at FROM credentials WHERE account_id = ?1",
            params![account_id],
            |row| {
                Ok(StoredCredential {
                    account_id: row.get(0)?,
                    email: row.get(1)?,
                    password: row.get(2)?,
                    saved_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(credential)
}

pub fn remove_credential(db: &Database, account_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute("DELETE FROM credentials WHERE account_id = ?1", params![account_id])?;
    Ok(())
}
