use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use crate::contracts::{
    AccountRecord, AccountSnapshot, SiteRecord, StoredCredential, StoredSession, StoredState,
};
use crate::domain::usage_history::merge_request_history;

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

pub fn save_snapshot(db: &Database, account_id: &str, snapshot: &AccountSnapshot) -> Result<()> {
    let conn = db.connect()?;
    let previous_history = conn
        .query_row(
            "SELECT snapshot_json FROM account_snapshots WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|raw| serde_json::from_str::<AccountSnapshot>(&raw).ok())
        .map(|item| item.request_history)
        .unwrap_or_default();

    let merged_snapshot = AccountSnapshot {
        request_history: merge_request_history(
            &previous_history,
            &snapshot.recent_usage,
            &snapshot.fetched_at,
        ),
        ..snapshot.clone()
    };
    let snapshot_json = serde_json::to_string(&merged_snapshot)?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO account_snapshots (account_id, fetched_at, last_error, snapshot_json, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4)
         ON CONFLICT(account_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           last_error = NULL,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at",
        params![account_id, merged_snapshot.fetched_at, snapshot_json, now],
    )?;

    conn.execute("DELETE FROM usage_history WHERE account_id = ?1", params![account_id])?;
    for row in &merged_snapshot.request_history {
        let row_json = serde_json::to_string(row)?;
        conn.execute(
            "INSERT INTO usage_history (account_id, usage_id, first_seen_at, last_seen_at, is_latest, row_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                account_id,
                row.id,
                row.first_seen_at,
                row.last_seen_at,
                if row.is_latest { 1 } else { 0 },
                row_json
            ],
        )?;
    }

    Ok(())
}

pub fn save_error(db: &Database, account_id: &str, message: &str) -> Result<()> {
    let conn = db.connect()?;
    let snapshot_json = conn
        .query_row(
            "SELECT snapshot_json FROM account_snapshots WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| "{\"fetchedAt\":\"\",\"online\":false,\"siteName\":\"\",\"siteUrl\":\"\",\"accountLabel\":\"\",\"balance\":0,\"currency\":\"USD\",\"stats\":{\"totalApiKeys\":0,\"activeApiKeys\":0,\"todayRequests\":0,\"totalRequests\":0,\"todayActualCost\":0,\"totalActualCost\":0,\"todayCost\":0,\"totalCost\":0,\"todayTokens\":0,\"totalTokens\":0,\"todayInputTokens\":0,\"todayOutputTokens\":0,\"averageDurationMs\":0,\"byPlatform\":[]},\"usageSummary\":{\"totalRequests\":0,\"totalTokens\":0,\"totalInputTokens\":0,\"totalOutputTokens\":0,\"totalActualCost\":0,\"totalCost\":0,\"averageDurationMs\":0},\"recentUsage\":[],\"requestHistory\":[],\"trend\":[],\"keys\":[],\"subscriptions\":[],\"alerts\":[]}".to_string());
    conn.execute(
        "INSERT INTO account_snapshots (account_id, fetched_at, last_error, snapshot_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id) DO UPDATE SET
           last_error = excluded.last_error,
           updated_at = excluded.updated_at",
        params![account_id, Utc::now().to_rfc3339(), message, snapshot_json, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn clear_error(db: &Database, account_id: &str) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "UPDATE account_snapshots SET last_error = NULL, updated_at = ?2 WHERE account_id = ?1",
        params![account_id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

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

pub fn find_account(db: &Database, account_id: &str) -> Result<Option<AccountRecord>> {
    let state = read_state(db)?;
    Ok(state.accounts.into_iter().find(|item| item.id == account_id))
}

pub fn find_site(db: &Database, site_id: &str) -> Result<Option<SiteRecord>> {
    let state = read_state(db)?;
    Ok(state.sites.into_iter().find(|item| item.id == site_id))
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

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::Utc;

    use super::*;
    use crate::contracts::{SiteRecord, StoredCredential, StoredSession};
    use crate::infrastructure::files::AppPaths;

    #[test]
    fn persists_site_account_credential_and_session_in_sqlite() {
        let root = std::env::temp_dir().join(format!("api-token-sqlite-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("create config dir");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init db");

        let site = SiteRecord {
            id: "site-1".into(),
            name: "AI INPUT".into(),
            base_url: "https://ai.input.im".into(),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        insert_site(&db, &site).expect("insert site");

        let account = AccountRecord {
            id: "account-1".into(),
            site_id: site.id.clone(),
            label: "主账号".into(),
            email: "demo@example.com".into(),
            balance_warning: -1.0,
            last_login_at: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        insert_account(&db, &account).expect("insert account");

        save_credential(
            &db,
            &StoredCredential {
                account_id: account.id.clone(),
                email: account.email.clone(),
                password: "Secr3t!@#".into(),
                saved_at: Utc::now().to_rfc3339(),
            },
        )
        .expect("save credential");
        save_session(
            &db,
            &account.id,
            &StoredSession {
                saved_at: Utc::now().to_rfc3339(),
                access_token: Some("access-1".into()),
                refresh_token: Some("refresh-1".into()),
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");

        let loaded_credential = load_credential(&db, &account.id)
            .expect("load credential")
            .expect("credential exists");
        let loaded_session = load_session(&db, &account.id)
            .expect("load session")
            .expect("session exists");
        let state = read_state(&db).expect("read state");

        assert_eq!(loaded_credential.password, "Secr3t!@#");
        assert_eq!(loaded_session.access_token.as_deref(), Some("access-1"));
        assert_eq!(state.sites.len(), 1);
        assert_eq!(state.accounts.len(), 1);

        fs::remove_dir_all(root).ok();
    }
}
