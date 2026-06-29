use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::contracts::AccountRecord;
use crate::infrastructure::sqlite::Database;

pub fn insert_account(db: &Database, account: &AccountRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO accounts (id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            account.id,
            account.site_id,
            account.label,
            account.email,
            account.balance_warning,
            account.last_login_at,
            account.created_at,
            account.updated_at
        ],
    )?;
    Ok(())
}

pub fn update_account(db: &Database, account: &AccountRecord) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE accounts
         SET site_id = ?2, label = ?3, email = ?4, balance_warning = ?5, last_login_at = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            account.id,
            account.site_id,
            account.label,
            account.email,
            account.balance_warning,
            account.last_login_at,
            account.updated_at
        ],
    )?;
    Ok(())
}

pub fn delete_account(db: &Database, account_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])?;
    Ok(())
}

pub fn find_account(db: &Database, account_id: &str) -> Result<Option<AccountRecord>> {
    let conn = db.connect()?;
    let account = conn
        .query_row(
            "SELECT id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at FROM accounts WHERE id = ?1",
            params![account_id],
            |row| {
                Ok(AccountRecord {
                    id: row.get(0)?,
                    site_id: row.get(1)?,
                    label: row.get(2)?,
                    email: row.get(3)?,
                    balance_warning: row.get(4)?,
                    last_login_at: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(account)
}

pub fn list_account_ids(db: &Database) -> Result<Vec<String>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare("SELECT id FROM accounts ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row?);
    }
    Ok(ids)
}

