use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};

use crate::contracts::AccountSnapshot;
use crate::domain::usage_history::merge_request_history;
use super::Database;

pub fn save_snapshot(db: &Database, account_id: &str, snapshot: &AccountSnapshot) -> Result<()> {
    let conn = db.connect()?;
    let previous_json: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM account_snapshots WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let previous_history = previous_json
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
    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM account_snapshots WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let snapshot_json = snapshot_json.unwrap_or_else(|| "{\"fetchedAt\":\"\",\"online\":false,\"siteName\":\"\",\"siteUrl\":\"\",\"accountLabel\":\"\",\"balance\":0,\"currency\":\"USD\",\"stats\":{\"totalApiKeys\":0,\"activeApiKeys\":0,\"todayRequests\":0,\"totalRequests\":0,\"todayActualCost\":0,\"totalActualCost\":0,\"todayCost\":0,\"totalCost\":0,\"todayTokens\":0,\"totalTokens\":0,\"todayInputTokens\":0,\"todayOutputTokens\":0,\"averageDurationMs\":0,\"byPlatform\":[]},\"usageSummary\":{\"totalRequests\":0,\"totalTokens\":0,\"totalInputTokens\":0,\"totalOutputTokens\":0,\"totalActualCost\":0,\"totalCost\":0,\"averageDurationMs\":0},\"recentUsage\":[],\"requestHistory\":[],\"trend\":[],\"keys\":[],\"subscriptions\":[],\"alerts\":[]}".to_string());
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
