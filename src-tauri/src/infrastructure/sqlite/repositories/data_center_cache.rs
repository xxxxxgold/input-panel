use anyhow::Result;
use chrono::{Days, NaiveDate, Utc};
use rusqlite::{params, OptionalExtension};

use crate::contracts::{
    AccountGroupCacheRecord, AccountKeyCacheRecord, AccountPlatformQuotaCacheRecord,
    AccountProfileCacheRecord, AccountSubscriptionCacheRecord,
    AccountSubscriptionSummaryCacheRecord, AccountSyncState, AccountSyncStatusRecord,
    AccountUsageRowCacheRecord, DataCenterState, DataSyncScope, GroupRecord, ManagedKeyRecord,
    PaginatedResult, PlatformQuotaPayload, StoredSession, SubscriptionRecord,
    SubscriptionSummaryPayload, UsageRow, UserProfileRecord,
};

use crate::infrastructure::sqlite::Database;

pub fn save_profile_cache(
    db: &Database,
    account_id: &str,
    payload: &UserProfileRecord,
    updated_at: &str,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO account_profile_cache (account_id, payload_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at",
        params![account_id, serde_json::to_string(payload)?, updated_at],
    )?;
    Ok(())
}

pub fn save_platform_quota_cache(
    db: &Database,
    account_id: &str,
    payload: &PlatformQuotaPayload,
    updated_at: &str,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO account_platform_quota_cache (account_id, payload_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at",
        params![account_id, serde_json::to_string(payload)?, updated_at],
    )?;
    Ok(())
}

pub fn replace_subscription_cache(
    db: &Database,
    account_id: &str,
    rows: &[SubscriptionRecord],
    updated_at: &str,
) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM account_subscription_cache WHERE account_id = ?1",
        params![account_id],
    )?;
    for row in rows {
        tx.execute(
            "INSERT INTO account_subscription_cache (account_id, subscription_id, row_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![account_id, row.id, serde_json::to_string(row)?, updated_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn save_subscription_summary_cache(
    db: &Database,
    account_id: &str,
    payload: &SubscriptionSummaryPayload,
    updated_at: &str,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO account_subscription_summary_cache (account_id, payload_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at",
        params![account_id, serde_json::to_string(payload)?, updated_at],
    )?;
    Ok(())
}

pub fn replace_group_cache(
    db: &Database,
    account_id: &str,
    rows: &[GroupRecord],
    updated_at: &str,
) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM account_group_cache WHERE account_id = ?1",
        params![account_id],
    )?;
    for row in rows {
        tx.execute(
            "INSERT INTO account_group_cache (account_id, group_id, row_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![account_id, row.id, serde_json::to_string(row)?, updated_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn replace_key_cache(
    db: &Database,
    account_id: &str,
    rows: &[ManagedKeyRecord],
    updated_at: &str,
) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM account_key_cache WHERE account_id = ?1",
        params![account_id],
    )?;
    for row in rows {
        tx.execute(
            "INSERT INTO account_key_cache (account_id, key_id, row_json, updated_at, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                account_id,
                row.key.id,
                serde_json::to_string(row)?,
                updated_at,
                updated_at,
                updated_at
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn merge_usage_row_cache(
    db: &Database,
    account_id: &str,
    rows: &[UsageRow],
    updated_at: &str,
) -> Result<i64> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let mut count = 0_i64;
    for row in rows {
        let existing_first_seen_at = tx
            .query_row(
                "SELECT first_seen_at FROM account_usage_row_cache
                 WHERE account_id = ?1 AND usage_id = ?2 AND occurred_at = ?3",
                params![account_id, row.id, row.created_at],
                |record| record.get::<_, String>(0),
            )
            .optional()?;
        tx.execute(
            "INSERT INTO account_usage_row_cache (
                account_id, usage_id, api_key_id, occurred_at, row_json, updated_at, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, usage_id, occurred_at) DO UPDATE SET
                api_key_id = excluded.api_key_id,
                row_json = excluded.row_json,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at",
            params![
                account_id,
                row.id,
                row.api_key_id,
                row.created_at,
                serde_json::to_string(row)?,
                updated_at,
                existing_first_seen_at.unwrap_or_else(|| updated_at.to_string()),
                updated_at
            ],
        )?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

pub fn prune_usage_row_cache_before(
    db: &Database,
    account_id: &str,
    min_occurred_at: &str,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "DELETE FROM account_usage_row_cache WHERE account_id = ?1 AND occurred_at < ?2",
        params![account_id, min_occurred_at],
    )?;
    Ok(())
}

pub fn update_account_sync_status(
    db: &Database,
    record: &AccountSyncStatusRecord,
) -> Result<()> {
    let conn = db.connect()?;
    conn.execute(
        "INSERT INTO account_sync_status (
            account_id, scope, state, last_attempt_at, last_success_at, last_error, item_count
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(account_id, scope) DO UPDATE SET
            state = excluded.state,
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = excluded.last_success_at,
            last_error = excluded.last_error,
            item_count = excluded.item_count",
        params![
            record.account_id,
            sync_scope_to_str(&record.scope),
            sync_state_to_str(&record.state),
            record.last_attempt_at,
            record.last_success_at,
            record.last_error,
            record.item_count
        ],
    )?;
    Ok(())
}

pub fn get_account_sync_statuses(
    db: &Database,
    account_id: &str,
) -> Result<Vec<AccountSyncStatusRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT account_id, scope, state, last_attempt_at, last_success_at, last_error, item_count
         FROM account_sync_status
         WHERE account_id = ?1
         ORDER BY scope ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        Ok(AccountSyncStatusRecord {
            account_id: row.get(0)?,
            scope: parse_sync_scope(&row.get::<_, String>(1)?),
            state: parse_sync_state(&row.get::<_, String>(2)?),
            last_attempt_at: row.get(3)?,
            last_success_at: row.get(4)?,
            last_error: row.get(5)?,
            item_count: row.get(6)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn get_profile_cache(
    db: &Database,
    account_id: &str,
) -> Result<Option<AccountProfileCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT account_id, payload_json, updated_at
             FROM account_profile_cache
             WHERE account_id = ?1",
            params![account_id],
            |row| {
                let payload_json: String = row.get(1)?;
                Ok(AccountProfileCacheRecord {
                    account_id: row.get(0)?,
                    payload: parse_json_column(payload_json)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn get_platform_quota_cache(
    db: &Database,
    account_id: &str,
) -> Result<Option<AccountPlatformQuotaCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT account_id, payload_json, updated_at
             FROM account_platform_quota_cache
             WHERE account_id = ?1",
            params![account_id],
            |row| {
                let payload_json: String = row.get(1)?;
                Ok(AccountPlatformQuotaCacheRecord {
                    account_id: row.get(0)?,
                    payload: parse_json_column(payload_json)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn get_subscription_summary_cache(
    db: &Database,
    account_id: &str,
) -> Result<Option<AccountSubscriptionSummaryCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT account_id, payload_json, updated_at
             FROM account_subscription_summary_cache
             WHERE account_id = ?1",
            params![account_id],
            |row| {
                let payload_json: String = row.get(1)?;
                Ok(AccountSubscriptionSummaryCacheRecord {
                    account_id: row.get(0)?,
                    payload: parse_json_column(payload_json)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn list_subscription_cache(
    db: &Database,
    account_id: &str,
) -> Result<Vec<AccountSubscriptionCacheRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT account_id, subscription_id, row_json, updated_at
         FROM account_subscription_cache
         WHERE account_id = ?1
         ORDER BY updated_at DESC, subscription_id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let row_json: String = row.get(2)?;
        Ok(AccountSubscriptionCacheRecord {
            account_id: row.get(0)?,
            subscription_id: row.get(1)?,
            row: parse_json_column(row_json)?,
            updated_at: row.get(3)?,
        })
    })?;
    collect_rows(rows)
}

pub fn list_group_cache(
    db: &Database,
    account_id: &str,
) -> Result<Vec<AccountGroupCacheRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT account_id, group_id, row_json, updated_at
         FROM account_group_cache
         WHERE account_id = ?1
         ORDER BY updated_at DESC, group_id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let row_json: String = row.get(2)?;
        Ok(AccountGroupCacheRecord {
            account_id: row.get(0)?,
            group_id: row.get(1)?,
            row: parse_json_column(row_json)?,
            updated_at: row.get(3)?,
        })
    })?;
    collect_rows(rows)
}

pub fn list_key_cache(
    db: &Database,
    account_id: &str,
) -> Result<Vec<AccountKeyCacheRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT account_id, key_id, row_json, updated_at, first_seen_at, last_seen_at
         FROM account_key_cache
         WHERE account_id = ?1
         ORDER BY updated_at DESC, key_id ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let row_json: String = row.get(2)?;
        Ok(AccountKeyCacheRecord {
            account_id: row.get(0)?,
            key_id: row.get(1)?,
            row: parse_json_column(row_json)?,
            updated_at: row.get(3)?,
            first_seen_at: row.get(4)?,
            last_seen_at: row.get(5)?,
        })
    })?;
    collect_rows(rows)
}

pub fn find_key_cache(
    db: &Database,
    account_id: &str,
    key_id: &str,
) -> Result<Option<AccountKeyCacheRecord>> {
    let conn = db.connect()?;
    let record = conn
        .query_row(
            "SELECT account_id, key_id, row_json, updated_at, first_seen_at, last_seen_at
             FROM account_key_cache
             WHERE account_id = ?1 AND key_id = ?2",
            params![account_id, key_id],
            |row| {
                let row_json: String = row.get(2)?;
                Ok(AccountKeyCacheRecord {
                    account_id: row.get(0)?,
                    key_id: row.get(1)?,
                    row: parse_json_column(row_json)?,
                    updated_at: row.get(3)?,
                    first_seen_at: row.get(4)?,
                    last_seen_at: row.get(5)?,
                })
            },
        )
        .optional()?;
    Ok(record)
}

pub fn list_usage_row_cache(
    db: &Database,
    account_id: &str,
    api_key_id: Option<i64>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<Vec<AccountUsageRowCacheRecord>> {
    let conn = db.connect()?;
    let (start_bound, end_exclusive) = usage_range_query_bounds(start_date, end_date);
    let mut stmt = conn.prepare(
        "SELECT account_id, usage_id, occurred_at, row_json, updated_at, first_seen_at, last_seen_at
         FROM account_usage_row_cache
         WHERE account_id = ?1
           AND (?2 IS NULL OR api_key_id = ?2)
           AND (?3 IS NULL OR occurred_at >= ?3)
           AND (?4 IS NULL OR occurred_at < ?4)
         ORDER BY occurred_at DESC, usage_id DESC",
    )?;
    let rows = stmt.query_map(
        params![account_id, api_key_id, start_bound, end_exclusive],
        |row| map_usage_row_cache_record(row),
    )?;
    collect_rows(rows)
}

pub fn list_usage_rows_page(
    db: &Database,
    account_id: &str,
    api_key_id: Option<i64>,
    start_date: Option<&str>,
    end_date: Option<&str>,
    page: i64,
    page_size: i64,
) -> Result<PaginatedResult<UsageRow>> {
    let conn = db.connect()?;
    let safe_page_size = page_size.max(1);
    let safe_page = page.max(1);
    let offset = (safe_page - 1) * safe_page_size;
    let (start_bound, end_exclusive) = usage_range_query_bounds(start_date, end_date);

    let total: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM account_usage_row_cache
         WHERE account_id = ?1
           AND (?2 IS NULL OR api_key_id = ?2)
           AND (?3 IS NULL OR occurred_at >= ?3)
           AND (?4 IS NULL OR occurred_at < ?4)",
        params![account_id, api_key_id, start_bound.clone(), end_exclusive.clone()],
        |row| row.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT row_json
         FROM account_usage_row_cache
         WHERE account_id = ?1
           AND (?2 IS NULL OR api_key_id = ?2)
           AND (?3 IS NULL OR occurred_at >= ?3)
           AND (?4 IS NULL OR occurred_at < ?4)
         ORDER BY occurred_at DESC, usage_id DESC
         LIMIT ?5 OFFSET ?6",
    )?;
    let rows = stmt.query_map(
        params![account_id, api_key_id, start_bound, end_exclusive, safe_page_size, offset],
        |row| {
            let row_json: String = row.get(0)?;
            parse_json_column(row_json)
        },
    )?;
    let items = collect_rows(rows)?;
    let pages = ((total as f64) / safe_page_size as f64).ceil().max(1.0) as i64;
    Ok(PaginatedResult {
        items,
        page: safe_page,
        page_size: safe_page_size,
        total,
        pages,
    })
}

pub fn read_data_center_state(db: &Database) -> Result<DataCenterState> {
    let conn = db.connect()?;
    let mut state = DataCenterState::default();

    {
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, created_at, updated_at FROM sites ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::contracts::SiteRecord {
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
            Ok(crate::contracts::AccountRecord {
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
            "SELECT account_id, access_token, refresh_token, token_type, cookie_jar_json, saved_at FROM sessions",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                StoredSession {
                    access_token: row.get(1)?,
                    refresh_token: row.get(2)?,
                    token_type: row.get(3)?,
                    cookie_jar_json: row.get(4)?,
                    saved_at: row.get(5)?,
                },
            ))
        })?;
        for row in rows {
            let (account_id, session) = row?;
            state.sessions.insert(account_id, session);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, payload_json, updated_at FROM account_profile_cache",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let payload_json: String = row.get(1)?;
            Ok(AccountProfileCacheRecord {
                account_id,
                payload: serde_json::from_str(&payload_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(2)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state.profiles.insert(record.account_id.clone(), record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, payload_json, updated_at FROM account_platform_quota_cache",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let payload_json: String = row.get(1)?;
            Ok(AccountPlatformQuotaCacheRecord {
                account_id,
                payload: serde_json::from_str(&payload_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(2)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .platform_quotas
                .insert(record.account_id.clone(), record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, payload_json, updated_at FROM account_subscription_summary_cache",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let payload_json: String = row.get(1)?;
            Ok(AccountSubscriptionSummaryCacheRecord {
                account_id,
                payload: serde_json::from_str(&payload_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(2)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .subscription_summaries
                .insert(record.account_id.clone(), record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, subscription_id, row_json, updated_at FROM account_subscription_cache ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let subscription_id: String = row.get(1)?;
            let row_json: String = row.get(2)?;
            Ok(AccountSubscriptionCacheRecord {
                account_id,
                subscription_id,
                row: serde_json::from_str(&row_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(3)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .subscriptions
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, group_id, row_json, updated_at FROM account_group_cache ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let group_id: i64 = row.get(1)?;
            let row_json: String = row.get(2)?;
            Ok(AccountGroupCacheRecord {
                account_id,
                group_id,
                row: serde_json::from_str(&row_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(3)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .groups
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, key_id, row_json, updated_at, first_seen_at, last_seen_at
             FROM account_key_cache ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let key_id: String = row.get(1)?;
            let row_json: String = row.get(2)?;
            Ok(AccountKeyCacheRecord {
                account_id,
                key_id,
                row: serde_json::from_str(&row_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(3)?,
                first_seen_at: row.get(4)?,
                last_seen_at: row.get(5)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .keys
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, usage_id, occurred_at, row_json, updated_at, first_seen_at, last_seen_at
             FROM account_usage_row_cache ORDER BY occurred_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let usage_id: String = row.get(1)?;
            let occurred_at: String = row.get(2)?;
            let row_json: String = row.get(3)?;
            Ok(AccountUsageRowCacheRecord {
                account_id,
                usage_id,
                occurred_at,
                row: serde_json::from_str(&row_json)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
                updated_at: row.get(4)?,
                first_seen_at: row.get(5)?,
                last_seen_at: row.get(6)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .usage_rows
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT account_id, scope, state, last_attempt_at, last_success_at, last_error, item_count
             FROM account_sync_status ORDER BY account_id ASC, scope ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AccountSyncStatusRecord {
                account_id: row.get(0)?,
                scope: parse_sync_scope(&row.get::<_, String>(1)?),
                state: parse_sync_state(&row.get::<_, String>(2)?),
                last_attempt_at: row.get(3)?,
                last_success_at: row.get(4)?,
                last_error: row.get(5)?,
                item_count: row.get(6)?,
            })
        })?;
        for row in rows {
            let record = row?;
            state
                .sync_statuses
                .entry(record.account_id.clone())
                .or_default()
                .push(record);
        }
    }

    Ok(state)
}

pub fn build_sync_status_record(
    account_id: &str,
    scope: DataSyncScope,
    state: AccountSyncState,
    last_attempt_at: Option<String>,
    last_success_at: Option<String>,
    last_error: Option<String>,
    item_count: i64,
) -> AccountSyncStatusRecord {
    AccountSyncStatusRecord {
        account_id: account_id.to_string(),
        scope,
        state,
        last_attempt_at,
        last_success_at,
        last_error,
        item_count,
    }
}

pub fn mark_sync_running(
    db: &Database,
    account_id: &str,
    scope: DataSyncScope,
) -> Result<AccountSyncStatusRecord> {
    let now = Utc::now().to_rfc3339();
    let existing = get_account_sync_statuses(db, account_id)?
        .into_iter()
        .find(|item| item.scope == scope);
    let record = build_sync_status_record(
        account_id,
        scope,
        AccountSyncState::Running,
        Some(now),
        existing.as_ref().and_then(|item| item.last_success_at.clone()),
        None,
        existing.as_ref().map(|item| item.item_count).unwrap_or(0),
    );
    update_account_sync_status(db, &record)?;
    Ok(record)
}

pub fn mark_sync_finished(
    db: &Database,
    account_id: &str,
    scope: DataSyncScope,
    item_count: i64,
    error: Option<String>,
) -> Result<AccountSyncStatusRecord> {
    let now = Utc::now().to_rfc3339();
    let existing = get_account_sync_statuses(db, account_id)?
        .into_iter()
        .find(|item| item.scope == scope);
    let succeeded = error.is_none();
    let record = build_sync_status_record(
        account_id,
        scope,
        if succeeded {
            AccountSyncState::Succeeded
        } else {
            AccountSyncState::Failed
        },
        Some(now.clone()),
        if succeeded {
            Some(now)
        } else {
            existing.as_ref().and_then(|item| item.last_success_at.clone())
        },
        error,
        item_count,
    );
    update_account_sync_status(db, &record)?;
    Ok(record)
}

fn sync_scope_to_str(scope: &DataSyncScope) -> &'static str {
    match scope {
        DataSyncScope::Core => "core",
        DataSyncScope::Keys => "keys",
        DataSyncScope::Usage => "usage",
        DataSyncScope::Full => "full",
    }
}

fn parse_sync_scope(value: &str) -> DataSyncScope {
    match value {
        "core" => DataSyncScope::Core,
        "keys" => DataSyncScope::Keys,
        "usage" => DataSyncScope::Usage,
        _ => DataSyncScope::Full,
    }
}

fn sync_state_to_str(state: &AccountSyncState) -> &'static str {
    match state {
        AccountSyncState::Idle => "idle",
        AccountSyncState::Running => "running",
        AccountSyncState::Succeeded => "succeeded",
        AccountSyncState::Failed => "failed",
    }
}

fn parse_sync_state(value: &str) -> AccountSyncState {
    match value {
        "running" => AccountSyncState::Running,
        "succeeded" => AccountSyncState::Succeeded,
        "failed" => AccountSyncState::Failed,
        _ => AccountSyncState::Idle,
    }
}

fn usage_range_query_bounds(
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> (Option<String>, Option<String>) {
    let start_bound = start_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let end_exclusive = end_date
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.checked_add_days(Days::new(1)))
                .map(|date| date.to_string())
                .unwrap_or_else(|| format!("{value}~"))
        });
    (start_bound, end_exclusive)
}

fn map_usage_row_cache_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AccountUsageRowCacheRecord> {
    let row_json: String = row.get(3)?;
    Ok(AccountUsageRowCacheRecord {
        account_id: row.get(0)?,
        usage_id: row.get(1)?,
        occurred_at: row.get(2)?,
        row: parse_json_column(row_json)?,
        updated_at: row.get(4)?,
        first_seen_at: row.get(5)?,
        last_seen_at: row.get(6)?,
    })
}

fn parse_json_column<T>(value: String) -> rusqlite::Result<T>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_str(&value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn collect_rows<T, F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<T>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

