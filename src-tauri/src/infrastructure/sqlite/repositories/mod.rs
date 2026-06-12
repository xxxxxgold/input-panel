pub mod accounts;
pub mod credentials;
pub mod sessions;
pub mod settings;
pub mod sites;
pub mod snapshots;
pub mod usage_history;

pub use accounts::*;
pub use credentials::*;
pub use sessions::*;
pub use settings::*;
pub use sites::*;
pub use snapshots::*;
pub use usage_history::*;

use anyhow::Result;

use crate::contracts::{AccountRecord, AccountSnapshot, SiteRecord, StoredState};

use super::Database;

pub fn read_state(db: &Database) -> Result<StoredState> {
    let conn = db.connect()?;
    let mut state = StoredState::default();

    {
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, created_at, updated_at FROM sites ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SiteRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        for row in rows {
            state.sites.push(row?);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT id, site_id, label, email, balance_warning, last_login_at, created_at, updated_at FROM accounts ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
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
        })?;
        for row in rows {
            state.accounts.push(row?);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, snapshot_json, last_error FROM account_snapshots ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let snapshot_json: String = row.get(1)?;
            let last_error: Option<String> = row.get(2)?;
            let snapshot: AccountSnapshot = serde_json::from_str(&snapshot_json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            Ok((account_id, snapshot, last_error))
        })?;

        for row in rows {
            let (account_id, snapshot, last_error) = row?;
            state.snapshots.insert(account_id.clone(), snapshot);
            state.errors.insert(account_id, last_error);
        }
    }

    {
        let mut stmt =
            conn.prepare("SELECT id FROM accounts WHERE id NOT IN (SELECT account_id FROM account_snapshots)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            state.errors.entry(row?).or_insert(None);
        }
    }

    Ok(state)
}
