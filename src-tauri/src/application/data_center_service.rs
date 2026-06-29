use anyhow::Result;
use chrono::{Days, Local, Utc};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;
use std::sync::Arc;

use crate::contracts::{
    AccountSyncStatusPayload, DataCenterState, DataSyncScope, GroupRecord, ManagedKeyRecord,
    PlatformQuotaPayload, DataSyncTrigger, RefreshAccountTaskResponse, RefreshTriggerSource,
    SubscriptionRecord, SubscriptionSummaryPayload, SyncAccountDataInput, TaskRunRecord,
    TaskRunStatus, UsageRow, UserProfileRecord,
};
use crate::infrastructure::sqlite::repositories;
use crate::infrastructure::sub2api::normalizers::{
    normalize_group_record, normalize_items, normalize_managed_key_record, normalize_platform_quotas,
    normalize_profile, normalize_subscription_summary, normalize_usage_row,
};

use super::{account_service, upstream_service, AppContext};

const USAGE_SYNC_WINDOW_DAYS: i64 = 35;
const DATA_CENTER_MIGRATION_DONE_KEY: &str = "data_center_migration_done_v1";
const DATA_CENTER_USAGE_REPAIR_DONE_KEY: &str = "data_center_usage_repair_done_v1";
const DATA_CENTER_SYNC_STATUS_REPAIR_DONE_KEY: &str = "data_center_sync_status_repair_done_v1";

#[derive(Debug, Clone)]
pub struct SyncAccountDataResult {
    pub item_count: i64,
    pub status: AccountSyncStatusPayload,
    pub run: TaskRunRecord,
}

pub async fn sync_account_data(
    ctx: &AppContext,
    account_id: &str,
    input: SyncAccountDataInput,
) -> Result<SyncAccountDataResult> {
    let task_key = format!("{}:{}", account_id, sync_scope_key(&input.scope));
    let mut is_primary = false;
    let task_handle = {
        let mut tasks = ctx.sync_tasks.lock().await;
        if let Some(existing) = tasks.get(&task_key) {
            let existing = Arc::clone(existing);
            {
                let mut state = existing.state.lock().await;
                state.run.join_count += 1;
                repositories::update_task_run(&ctx.db, &state.run)?;
            }
            existing
        } else {
            let run = TaskRunRecord {
                id: Uuid::new_v4().to_string(),
                account_id: account_id.to_string(),
                scope: input.scope.clone(),
                primary_trigger_source: input.trigger_source.clone(),
                status: TaskRunStatus::Running,
                join_count: 0,
                started_at: Utc::now().to_rfc3339(),
                finished_at: None,
                error_message: None,
            };
            repositories::insert_task_run(&ctx.db, &run)?;
            let handle = Arc::new(super::context::SyncTaskHandle {
                state: Mutex::new(super::context::SyncTaskState {
                    run,
                    completed: false,
                    result: None,
                }),
                notify: Notify::new(),
            });
            tasks.insert(task_key.clone(), Arc::clone(&handle));
            is_primary = true;
            handle
        }
    };

    if !is_primary {
        return wait_for_sync_task(task_handle).await;
    }

    let ctx_for_spawn = ctx.clone();
    let account_id_for_spawn = account_id.to_string();
    let input_for_spawn = input.clone();
    let task_key_for_spawn = task_key.clone();
    let task_handle_for_spawn = Arc::clone(&task_handle);
    tokio::spawn(async move {
        let result = run_sync_account_data(&ctx_for_spawn, &account_id_for_spawn, input_for_spawn)
            .await
            .map_err(|error| error.to_string());
        {
            let mut state = task_handle_for_spawn.state.lock().await;
            state.run.status = if result.is_ok() {
                TaskRunStatus::Succeeded
            } else {
                TaskRunStatus::Failed
            };
            state.run.finished_at = Some(Utc::now().to_rfc3339());
            state.run.error_message = result.as_ref().err().cloned();
            state.completed = true;
            state.result = Some(result);
            let _ = repositories::update_task_run(&ctx_for_spawn.db, &state.run);
        }
        task_handle_for_spawn.notify.notify_waiters();
        let mut tasks = ctx_for_spawn.sync_tasks.lock().await;
        tasks.remove(&task_key_for_spawn);
    });

    wait_for_sync_task(task_handle).await
}

async fn wait_for_sync_task(
    task_handle: Arc<super::context::SyncTaskHandle>,
) -> Result<SyncAccountDataResult> {
    loop {
        let maybe_done = {
            let state = task_handle.state.lock().await;
            if state.completed {
                Some((state.result.clone(), state.run.clone()))
            } else {
                None
            }
        };
        if let Some((result, _run)) = maybe_done {
            let status = result
                .expect("completed sync task must have result")
                .map_err(anyhow::Error::msg)?;
            let item_count = status.statuses.iter().map(|item| item.item_count).sum();
            return Ok(SyncAccountDataResult {
                item_count,
                run: _run,
                status,
            });
        }
        task_handle.notify.notified().await;
    }
}

async fn run_sync_account_data(
    ctx: &AppContext,
    account_id: &str,
    input: SyncAccountDataInput,
) -> Result<AccountSyncStatusPayload> {
    match input.scope {
        DataSyncScope::Core => {
            sync_core_scope(ctx, account_id, input.trigger_source).await?;
        }
        DataSyncScope::Keys => {
            sync_keys_scope(ctx, account_id, input.trigger_source).await?;
        }
        DataSyncScope::Usage => {
            sync_usage_scope(ctx, account_id, input.trigger_source, None, None).await?;
        }
        DataSyncScope::Full => {
            tokio::try_join!(
                sync_core_scope(ctx, account_id, input.trigger_source.clone()),
                sync_keys_scope(ctx, account_id, input.trigger_source.clone()),
                sync_usage_scope(ctx, account_id, input.trigger_source, None, None)
            )?;
        }
    }

    get_account_sync_status(ctx, account_id)
}

pub async fn sync_all_accounts(
    ctx: &AppContext,
    input: SyncAccountDataInput,
) -> Result<Vec<(String, SyncAccountDataResult)>> {
    let account_ids = repositories::list_account_ids(&ctx.db)?;
    let mut result = Vec::new();
    for account_id in account_ids {
        let synced = sync_account_data(
            ctx,
            &account_id,
            SyncAccountDataInput {
                scope: input.scope.clone(),
                trigger_source: input.trigger_source.clone(),
            },
        )
        .await?;
        result.push((account_id, synced));
    }
    Ok(result)
}

pub async fn refresh_account(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: RefreshTriggerSource,
) -> Result<RefreshAccountTaskResponse> {
    let sync_trigger_source = match trigger_source {
        RefreshTriggerSource::Manual => DataSyncTrigger::Manual,
        RefreshTriggerSource::StaleAuto => DataSyncTrigger::StaleAuto,
    };
    let sync_result = sync_account_data(
        ctx,
        account_id,
        SyncAccountDataInput {
            scope: DataSyncScope::Full,
            trigger_source: sync_trigger_source,
        },
    )
    .await?;
    let (account, _) = account_service::load_account_site(ctx, account_id)?;
    let runtime = account_service::wrap_runtime(ctx, account, None, None)?;
    Ok(RefreshAccountTaskResponse {
        account: runtime,
        run: sync_result.run,
    })
}

pub async fn refresh_all_accounts(ctx: &AppContext) -> Result<()> {
    sync_all_accounts(
        ctx,
        SyncAccountDataInput {
            scope: DataSyncScope::Full,
            trigger_source: DataSyncTrigger::Manual,
        },
    )
    .await?;
    Ok(())
}

fn sync_scope_key(scope: &DataSyncScope) -> &'static str {
    match scope {
        DataSyncScope::Core => "core",
        DataSyncScope::Keys => "keys",
        DataSyncScope::Usage => "usage",
        DataSyncScope::Full => "full",
    }
}

pub fn get_account_sync_status(ctx: &AppContext, account_id: &str) -> Result<AccountSyncStatusPayload> {
    Ok(AccountSyncStatusPayload {
        account_id: account_id.to_string(),
        statuses: repositories::get_account_sync_statuses(&ctx.db, account_id)?,
    })
}

pub fn read_data_center_state(ctx: &AppContext) -> Result<DataCenterState> {
    repositories::read_data_center_state(&ctx.db)
}

pub fn migrate_legacy_runtime_state(ctx: &AppContext) -> Result<()> {
    if repositories::get_setting(&ctx.db, DATA_CENTER_MIGRATION_DONE_KEY)?
        .as_deref()
        == Some("1")
    {
        return Ok(());
    }
    let current = repositories::read_data_center_state(&ctx.db)?;
    let legacy_cache_views = repositories::load_all_legacy_cache_views(&ctx.db)?;
    for account in &current.accounts {
        if !current.profiles.contains_key(&account.id) {
            if let Some(cache_view) = legacy_cache_views.get(&account.id) {
                let profile = UserProfileRecord {
                    id: 0,
                    email: account.email.clone(),
                    username: None,
                    avatar_url: None,
                    role: "user".into(),
                    balance: cache_view.balance,
                    concurrency: 0,
                    status: if cache_view.online { "active".into() } else { "unknown".into() },
                    last_active_at: Some(cache_view.fetched_at.clone()),
                    created_at: Some(account.created_at.clone()),
                    updated_at: Some(account.updated_at.clone()),
                    total_recharged: None,
                    rpm_limit: None,
                    balance_notify_enabled: Some(account.balance_warning >= 0.0),
                    balance_notify_threshold_type: Some("fixed".into()),
                    balance_notify_threshold: Some(account.balance_warning.max(0.0)),
                    balance_notify_extra_emails: Some(Vec::new()),
                    identities: std::collections::HashMap::new(),
                    auth_bindings: std::collections::HashMap::new(),
                    identity_bindings: std::collections::HashMap::new(),
                };
                repositories::save_profile_cache(&ctx.db, &account.id, &profile, &cache_view.fetched_at)?;
                repositories::save_subscription_summary_cache(
                    &ctx.db,
                    &account.id,
                    &derive_subscription_summary(&cache_view.subscriptions),
                    &cache_view.fetched_at,
                )?;
                repositories::replace_subscription_cache(
                    &ctx.db,
                    &account.id,
                    &cache_view.subscriptions,
                    &cache_view.fetched_at,
                )?;
                let managed_keys = cache_view
                    .keys
                    .iter()
                    .cloned()
                    .map(|key| ManagedKeyRecord {
                        key,
                        api_key_id: None,
                        raw_key: None,
                        user_id: None,
                        ip_whitelist: None,
                        ip_blacklist: None,
                        window5h_start: None,
                        window1d_start: None,
                        window7d_start: None,
                    })
                    .collect::<Vec<_>>();
                repositories::replace_key_cache(&ctx.db, &account.id, &managed_keys, &cache_view.fetched_at)?;
            }
        }
    }

    repositories::set_setting(&ctx.db, DATA_CENTER_MIGRATION_DONE_KEY, "1")?;
    Ok(())
}

pub fn repair_usage_cache_from_legacy(ctx: &AppContext) -> Result<()> {
    if repositories::get_setting(&ctx.db, DATA_CENTER_USAGE_REPAIR_DONE_KEY)?
        .as_deref()
        == Some("1")
    {
        return Ok(());
    }

    let current = repositories::read_data_center_state(&ctx.db)?;
    let seeded_accounts = current
        .usage_rows
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let now = Utc::now().to_rfc3339();

    for account in &current.accounts {
        if seeded_accounts.contains(&account.id) {
            continue;
        }
        let rows = repositories::load_legacy_usage_rows(&ctx.db, &account.id)?;
        if rows.is_empty() {
            continue;
        }
        let _ = repositories::merge_usage_row_cache(&ctx.db, &account.id, &rows, &now)?;
    }

    repositories::set_setting(&ctx.db, DATA_CENTER_USAGE_REPAIR_DONE_KEY, "1")?;
    Ok(())
}

pub fn repair_sync_status_from_cache(ctx: &AppContext) -> Result<()> {
    if repositories::get_setting(&ctx.db, DATA_CENTER_SYNC_STATUS_REPAIR_DONE_KEY)?
        .as_deref()
        == Some("1")
    {
        return Ok(());
    }

    let state = repositories::read_data_center_state(&ctx.db)?;
    for account in &state.accounts {
        let existing = state
            .sync_statuses
            .get(&account.id)
            .cloned()
            .unwrap_or_default();

        if existing.iter().all(|item| item.scope != DataSyncScope::Core) {
            let profile = state.profiles.get(&account.id);
            let quotas = state.platform_quotas.get(&account.id);
            let subscriptions = state.subscriptions.get(&account.id);
            let summary = state.subscription_summaries.get(&account.id);
            let has_core_cache = profile.is_some()
                || quotas.is_some()
                || subscriptions.is_some_and(|rows| !rows.is_empty())
                || summary.is_some();

            if has_core_cache {
                let last_success_at = [
                    profile.map(|record| record.updated_at.clone()),
                    quotas.map(|record| record.updated_at.clone()),
                    subscriptions.and_then(|rows| rows.iter().map(|record| record.updated_at.clone()).max()),
                    summary.map(|record| record.updated_at.clone()),
                ]
                .into_iter()
                .flatten()
                .max();

                if let Some(last_success_at) = last_success_at {
                    let item_count = profile.map(|_| 1_i64).unwrap_or(0)
                        + quotas.map(|record| record.payload.platform_quotas.len() as i64).unwrap_or(0)
                        + subscriptions.map(|rows| rows.len() as i64).unwrap_or(0)
                        + summary
                            .map(|record| record.payload.subscriptions.len() as i64)
                            .unwrap_or(0);
                    repositories::update_account_sync_status(
                        &ctx.db,
                        &repositories::build_sync_status_record(
                            &account.id,
                            DataSyncScope::Core,
                            crate::contracts::AccountSyncState::Succeeded,
                            Some(last_success_at.clone()),
                            Some(last_success_at),
                            None,
                            item_count,
                        ),
                    )?;
                }
            }
        }

        if existing.iter().all(|item| item.scope != DataSyncScope::Keys) {
            let groups = state.groups.get(&account.id);
            let keys = state.keys.get(&account.id);
            let has_key_cache = groups.is_some_and(|rows| !rows.is_empty()) || keys.is_some_and(|rows| !rows.is_empty());

            if has_key_cache {
                let last_success_at = [
                    groups.and_then(|rows| rows.iter().map(|record| record.updated_at.clone()).max()),
                    keys.and_then(|rows| rows.iter().map(|record| record.updated_at.clone()).max()),
                ]
                .into_iter()
                .flatten()
                .max();

                if let Some(last_success_at) = last_success_at {
                    repositories::update_account_sync_status(
                        &ctx.db,
                        &repositories::build_sync_status_record(
                            &account.id,
                            DataSyncScope::Keys,
                            crate::contracts::AccountSyncState::Succeeded,
                            Some(last_success_at.clone()),
                            Some(last_success_at),
                            None,
                            groups.map(|rows| rows.len() as i64).unwrap_or(0)
                                + keys.map(|rows| rows.len() as i64).unwrap_or(0),
                        ),
                    )?;
                }
            }
        }

        if existing.iter().all(|item| item.scope != DataSyncScope::Usage) {
            let usage_rows = state.usage_rows.get(&account.id);
            if let Some(rows) = usage_rows.filter(|rows| !rows.is_empty()) {
                if let Some(last_success_at) = rows.iter().map(|record| record.updated_at.clone()).max() {
                    repositories::update_account_sync_status(
                        &ctx.db,
                        &repositories::build_sync_status_record(
                            &account.id,
                            DataSyncScope::Usage,
                            crate::contracts::AccountSyncState::Succeeded,
                            Some(last_success_at.clone()),
                            Some(last_success_at),
                            None,
                            rows.len() as i64,
                        ),
                    )?;
                }
            }
        }
    }

    repositories::set_setting(&ctx.db, DATA_CENTER_SYNC_STATUS_REPAIR_DONE_KEY, "1")?;
    Ok(())
}

pub async fn sync_core_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
) -> Result<()> {
    repositories::mark_sync_running(&ctx.db, account_id, DataSyncScope::Core)?;
    let result = async {
        let (account, site) = account_service::load_account_site(ctx, account_id)?;
        let _ = site;

        let (profile, quotas, subscriptions, summary) = tokio::join!(
            fetch_profile(ctx, &account.id),
            fetch_platform_quotas(ctx, &account.id),
            fetch_subscriptions(ctx, &account.id),
            fetch_subscription_summary(ctx, &account.id),
        );
        let profile = profile?;
        let quotas = quotas?;
        let subscriptions = subscriptions.unwrap_or_default();
        let summary = summary.unwrap_or_else(|_| derive_subscription_summary(&subscriptions));

        let now = Utc::now().to_rfc3339();
        repositories::save_profile_cache(&ctx.db, &account.id, &profile, &now)?;
        repositories::save_platform_quota_cache(&ctx.db, &account.id, &quotas, &now)?;
        repositories::replace_subscription_cache(&ctx.db, &account.id, &subscriptions, &now)?;
        repositories::save_subscription_summary_cache(&ctx.db, &account.id, &summary, &now)?;
        let item_count =
            1 + quotas.platform_quotas.len() as i64 + subscriptions.len() as i64 + summary.subscriptions.len() as i64;
        repositories::mark_sync_finished(&ctx.db, &account.id, DataSyncScope::Core, item_count, None)?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        repositories::mark_sync_finished(
            &ctx.db,
            account_id,
            DataSyncScope::Core,
            0,
            Some(error.to_string()),
        )?;
        return Err(error);
    }

    let _ = trigger_source;
    Ok(())
}

pub async fn sync_keys_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
) -> Result<()> {
    repositories::mark_sync_running(&ctx.db, account_id, DataSyncScope::Keys)?;
    let result = async {
        let (account, site) = account_service::load_account_site(ctx, account_id)?;
        let _ = site;

        let (groups, keys) = tokio::join!(
            fetch_groups(ctx, &account.id),
            fetch_keys(ctx, &account.id),
        );
        let groups = groups?;
        let keys = keys?;

        let now = Utc::now().to_rfc3339();
        repositories::replace_group_cache(&ctx.db, &account.id, &groups, &now)?;
        repositories::replace_key_cache(&ctx.db, &account.id, &keys, &now)?;
        repositories::mark_sync_finished(
            &ctx.db,
            &account.id,
            DataSyncScope::Keys,
            (groups.len() + keys.len()) as i64,
            None,
        )?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        repositories::mark_sync_finished(
            &ctx.db,
            account_id,
            DataSyncScope::Keys,
            0,
            Some(error.to_string()),
        )?;
        return Err(error);
    }

    let _ = trigger_source;
    Ok(())
}

pub async fn sync_usage_scope(
    ctx: &AppContext,
    account_id: &str,
    trigger_source: DataSyncTrigger,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<()> {
    repositories::mark_sync_running(&ctx.db, account_id, DataSyncScope::Usage)?;
    let is_default_window = start_date.is_none() && end_date.is_none();
    let result = async {
        let (account, site) = account_service::load_account_site(ctx, account_id)?;
        let _ = site;

        println!("[DEBUG] sync_usage_scope start: account={}, start_date={:?}, end_date={:?}", account.id, start_date, end_date);
        let usage_rows = fetch_usage_rows_incremental(
            ctx,
            &account.id,
            start_date.clone(),
            end_date.clone(),
        )
        .await?;
        println!("[DEBUG] sync_usage_scope fetched: {} rows", usage_rows.len());
        if !usage_rows.is_empty() {
            println!("[DEBUG] first row created_at: {:?}", usage_rows[0].created_at);
            println!("[DEBUG] last row created_at: {:?}", usage_rows.last().unwrap().created_at);
        }
        let now = Utc::now().to_rfc3339();
        let merged_count = repositories::merge_usage_row_cache(&ctx.db, &account.id, &usage_rows, &now)?;
        println!("[DEBUG] sync_usage_scope merged: {} rows", merged_count);
        if is_default_window {
            let cutoff = (Local::now() - Days::new(USAGE_SYNC_WINDOW_DAYS as u64)).date_naive().to_string();
            repositories::prune_usage_row_cache_before(&ctx.db, &account.id, &cutoff)?;
        }
        repositories::mark_sync_finished(
            &ctx.db,
            &account.id,
            DataSyncScope::Usage,
            merged_count,
            None,
        )?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        repositories::mark_sync_finished(
            &ctx.db,
            account_id,
            DataSyncScope::Usage,
            0,
            Some(error.to_string()),
        )?;
        return Err(error);
    }

    let _ = trigger_source;
    Ok(())
}

async fn fetch_profile(ctx: &AppContext, account_id: &str) -> Result<UserProfileRecord> {
    let raw = upstream_service::account_upstream_request(ctx, account_id, "/api/v1/user/profile", "GET", None).await?;
    Ok(normalize_profile(&raw))
}

async fn fetch_platform_quotas(ctx: &AppContext, account_id: &str) -> Result<PlatformQuotaPayload> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/user/platform-quotas",
        "GET",
        None,
    )
    .await
    .unwrap_or_else(|_| serde_json::json!({ "platform_quotas": [] }));
    Ok(normalize_platform_quotas(&raw))
}

async fn fetch_subscription_summary(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionSummaryPayload> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/subscriptions/summary",
        "GET",
        None,
    )
    .await?;
    Ok(normalize_subscription_summary(&raw))
}

async fn fetch_groups(ctx: &AppContext, account_id: &str) -> Result<Vec<GroupRecord>> {
    let raw = upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/groups/available",
        "GET",
        None,
    )
    .await
    .unwrap_or_else(|_| serde_json::json!({ "items": [] }));
    Ok(normalize_items(&raw)
        .iter()
        .map(normalize_group_record)
        .collect())
}

async fn fetch_keys(ctx: &AppContext, account_id: &str) -> Result<Vec<ManagedKeyRecord>> {
    let mut page = 1_i64;
    let mut rows = Vec::new();
    loop {
        let raw = upstream_service::account_upstream_request(
            ctx,
            account_id,
            &format!("/api/v1/keys?page={page}&page_size=100"),
            "GET",
            None,
        )
        .await?;
        let next = normalize_items(&raw)
            .iter()
            .map(normalize_managed_key_record)
            .collect::<Vec<_>>();
        if next.is_empty() {
            break;
        }
        rows.extend(next);
        let total_pages = raw
            .get("pages")
            .and_then(|value| value.as_i64())
            .or_else(|| raw.get("pagination").and_then(|value| value.get("pages")).and_then(|value| value.as_i64()))
            .unwrap_or(page);
        if page >= total_pages {
            break;
        }
        page += 1;
    }
    Ok(rows)
}

async fn fetch_usage_rows_incremental(
    ctx: &AppContext,
    account_id: &str,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<UsageRow>> {
    let default_end = Local::now().date_naive().to_string();
    let default_start = (Local::now() - Days::new(USAGE_SYNC_WINDOW_DAYS as u64))
        .date_naive()
        .to_string();
    let start = start_date.unwrap_or(default_start);
    let end = end_date.unwrap_or(default_end);
    let mut page = 1_i64;
    let mut rows = Vec::new();
    const MAX_PAGES: i64 = 10; // 最多翻页10页，防止无限翻页
    const PAGE_SIZE: i64 = 500;

    loop {
        let raw = upstream_service::account_upstream_request(
            ctx,
            account_id,
            &format!("/api/v1/usage?page={page}&page_size={PAGE_SIZE}&start_date={start}&end_date={end}&sort=-created_at"),
            "GET",
            None,
        )
        .await?;
        let next = normalize_items(&raw)
            .iter()
            .map(normalize_usage_row)
            .collect::<Vec<_>>();
        let batch_size = next.len() as i64;
        if next.is_empty() {
            break;
        }
        rows.extend(next);
        // 如果返回的记录数少于 PAGE_SIZE，说明这是最后一页
        // 如果返回满页，继续翻页（最多到 MAX_PAGES）
        if batch_size < PAGE_SIZE || page >= MAX_PAGES {
            break;
        }
        page += 1;
    }
    Ok(rows)
}

async fn fetch_subscriptions(
    ctx: &AppContext,
    account_id: &str,
) -> Result<Vec<SubscriptionRecord>> {
    let raw = match upstream_service::account_upstream_request(
        ctx,
        account_id,
        "/api/v1/subscriptions",
        "GET",
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(_) => {
            upstream_service::account_upstream_request(
                ctx,
                account_id,
                "/api/v1/subscriptions/active",
                "GET",
                None,
            )
            .await?
        }
    };
    Ok(normalize_items(&raw)
        .into_iter()
        .map(|item| SubscriptionRecord {
            id: item
                .get("id")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            group_id: item.get("group_id").and_then(|value| value.as_i64()),
            name: item
                .get("group")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| item.get("name").and_then(|value| value.as_str()).map(ToString::to_string))
                .unwrap_or_else(|| "Subscription".into()),
            status: item
                .get("status")
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| "unknown".into()),
            group_name: item
                .get("group")
                .and_then(|value| value.get("name"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| item.get("group_name").and_then(|value| value.as_str()).map(ToString::to_string)),
            platform: item
                .get("group")
                .and_then(|value| value.get("platform"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
                .or_else(|| item.get("platform").and_then(|value| value.as_str()).map(ToString::to_string)),
            expires_at: item.get("expires_at").and_then(|value| value.as_str()).map(ToString::to_string),
            daily: quota_window(&item, "daily"),
            weekly: quota_window(&item, "weekly"),
            monthly: quota_window(&item, "monthly"),
        })
        .collect())
}

fn quota_window(item: &serde_json::Value, key: &str) -> Option<crate::contracts::SubscriptionQuotaWindow> {
    let node = item.get(key)?;
    let current = node.get("current")?.as_f64()?;
    let limit = node.get("limit")?.as_f64()?;
    Some(crate::contracts::SubscriptionQuotaWindow {
        current,
        limit,
        window_start: node
            .get("window_start")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
    })
}

fn derive_subscription_summary(subscriptions: &[SubscriptionRecord]) -> SubscriptionSummaryPayload {
    let rows = subscriptions
        .iter()
        .map(|item| crate::contracts::SubscriptionSummaryRecord {
            id: item
                .id
                .strip_prefix("summary-")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0),
            group_id: item.group_id.unwrap_or(0),
            group_name: item
                .group_name
                .clone()
                .unwrap_or_else(|| item.name.clone()),
            status: item.status.clone(),
            daily_used_usd: item.daily.as_ref().map(|value| value.current).unwrap_or(0.0),
            daily_limit_usd: item.daily.as_ref().map(|value| value.limit).unwrap_or(0.0),
            weekly_used_usd: item.weekly.as_ref().map(|value| value.current).unwrap_or(0.0),
            monthly_used_usd: item.monthly.as_ref().map(|value| value.current).unwrap_or(0.0),
            expires_at: item.expires_at.clone(),
        })
        .collect::<Vec<_>>();
    SubscriptionSummaryPayload {
        active_count: rows.iter().filter(|item| item.status == "active").count() as i64,
        total_used_usd: rows.iter().map(|item| item.daily_used_usd).sum(),
        subscriptions: rows,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    use axum::{routing::get, Json, Router};
    use chrono::{Days, Local};
    use serde_json::json;
    use tokio::sync::Mutex;

    use super::{
        get_account_sync_status, refresh_account, repair_sync_status_from_cache,
        repair_usage_cache_from_legacy, sync_account_data, sync_usage_scope,
    };
    use crate::application::{context::SyncTaskHandle, AppContext};
    use crate::contracts::{
        AccountRecord, AccountSyncState, DataSyncScope, DataSyncTrigger, ManagedKeyRecord,
        RefreshTriggerSource, SiteRecord, StoredSession, SubscriptionRecord,
        SubscriptionSummaryPayload, SyncAccountDataInput, UsageRow, UserProfileRecord,
    };
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::{repositories, Database};

    #[tokio::test]
    async fn same_account_same_scope_joins_single_flight_run() {
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));

        let app = {
            let group_hits = Arc::clone(&group_hits);
            let key_hits = Arc::clone(&key_hits);
            Router::new()
                .route(
                    "/api/v1/groups/available",
                    get(move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": 1,
                                        "name": "默认分组",
                                        "platform": "openai",
                                        "rate_multiplier": 1.0
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(120)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-1",
                                        "group_id": 1,
                                        "name": "主 Key",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-1",
            "site-1",
            "主账号",
        );

        let input = SyncAccountDataInput {
            scope: DataSyncScope::Keys,
            trigger_source: DataSyncTrigger::Manual,
        };

        let (first, second) = tokio::join!(
            sync_account_data(&ctx, "account-1", input.clone()),
            sync_account_data(&ctx, "account-1", input)
        );

        let first = first.expect("first sync result");
        let second = second.expect("second sync result");
        assert_eq!(first.status.account_id, "account-1");
        assert_eq!(second.status.account_id, "account-1");
        assert_eq!(group_hits.load(Ordering::SeqCst), 1);
        assert_eq!(key_hits.load(Ordering::SeqCst), 1);

        let conn = ctx.db.connect().expect("open sqlite");
        let (count, join_count, status): (i64, i64, String) = conn
            .query_row(
                "SELECT COUNT(*), MAX(join_count), MAX(status) FROM task_runs WHERE account_id = ?1 AND scope = 'keys'",
                rusqlite::params!["account-1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query task runs");
        assert_eq!(count, 1);
        assert_eq!(join_count, 1);
        assert_eq!(status, "succeeded");
    }

    #[tokio::test]
    async fn full_sync_marks_core_keys_and_usage_statuses() {
        let app = Router::new()
            .route(
                "/api/v1/user/profile",
                get(|| async {
                    Json(json!({
                        "email": "demo@example.com",
                        "balance": 12.5
                    }))
                }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get(|| async { Json(json!({ "platform_quotas": [] })) }),
            )
            .route(
                "/api/v1/subscriptions",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "sub-1",
                                "name": "月度订阅",
                                "status": "active",
                                "platform": "openai"
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get(|| async {
                    Json(json!({
                        "active_count": 1,
                        "total_used_usd": 3.2,
                        "subscriptions": []
                    }))
                }),
            )
            .route(
                "/api/v1/groups/available",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": 1,
                                "name": "默认分组",
                                "platform": "openai",
                                "rate_multiplier": 1.0
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/keys",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "key-1",
                                "group_id": 1,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai"
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/usage",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "usage-1",
                                "created_at": "2026-06-28T08:00:00+08:00",
                                "model": "gpt-5.4",
                                "actual_cost": 1.2,
                                "total_cost": 1.2,
                                "input_tokens": 100,
                                "output_tokens": 50,
                                "total_tokens": 150
                            }
                        ]
                    }))
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-2",
            "site-2",
            "副账号",
        );

        sync_account_data(
            &ctx,
            "account-2",
            SyncAccountDataInput {
                scope: DataSyncScope::Full,
                trigger_source: DataSyncTrigger::Manual,
            },
        )
        .await
        .expect("full sync");

        let status = get_account_sync_status(&ctx, "account-2").expect("sync status");
        assert_eq!(status.statuses.len(), 3);
        for scope in [DataSyncScope::Core, DataSyncScope::Keys, DataSyncScope::Usage] {
            let record = status
                .statuses
                .iter()
                .find(|item| item.scope == scope)
                .expect("scope status exists");
            assert_eq!(record.state, AccountSyncState::Succeeded);
            assert!(record.last_success_at.is_some());
        }
    }

    #[tokio::test]
    async fn same_account_different_scopes_do_not_share_run() {
        let group_hits = Arc::new(AtomicUsize::new(0));
        let key_hits = Arc::new(AtomicUsize::new(0));
        let usage_hits = Arc::new(AtomicUsize::new(0));

        let app = {
            let group_hits = Arc::clone(&group_hits);
            let key_hits = Arc::clone(&key_hits);
            let usage_hits = Arc::clone(&usage_hits);
            Router::new()
                .route(
                    "/api/v1/groups/available",
                    get(move || {
                        let group_hits = Arc::clone(&group_hits);
                        async move {
                            group_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": 1,
                                        "name": "默认分组",
                                        "platform": "openai",
                                        "rate_multiplier": 1.0
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/keys",
                    get(move || {
                        let key_hits = Arc::clone(&key_hits);
                        async move {
                            key_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": "key-1",
                                        "group_id": 1,
                                        "name": "主 Key",
                                        "status": "active",
                                        "platform": "openai"
                                    }
                                ]
                            }))
                        }
                    }),
                )
                .route(
                    "/api/v1/usage",
                    get(move || {
                        let usage_hits = Arc::clone(&usage_hits);
                        async move {
                            usage_hits.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            Json(json!({
                                "items": [
                                    {
                                        "id": "usage-1",
                                        "created_at": "2026-06-28T08:00:00+08:00",
                                        "model": "gpt-5.4",
                                        "actual_cost": 0.6,
                                        "total_cost": 0.6,
                                        "input_tokens": 50,
                                        "output_tokens": 20,
                                        "total_tokens": 70
                                    }
                                ]
                            }))
                        }
                    }),
                )
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-3",
            "site-3",
            "第三账号",
        );

        let (keys_result, usage_result) = tokio::join!(
            sync_account_data(
                &ctx,
                "account-3",
                SyncAccountDataInput {
                    scope: DataSyncScope::Keys,
                    trigger_source: DataSyncTrigger::Manual,
                },
            ),
            sync_account_data(
                &ctx,
                "account-3",
                SyncAccountDataInput {
                    scope: DataSyncScope::Usage,
                    trigger_source: DataSyncTrigger::Manual,
                },
            )
        );

        keys_result.expect("keys sync result");
        usage_result.expect("usage sync result");

        assert_eq!(group_hits.load(Ordering::SeqCst), 1);
        assert_eq!(key_hits.load(Ordering::SeqCst), 1);
        assert_eq!(usage_hits.load(Ordering::SeqCst), 1);

        let conn = ctx.db.connect().expect("open sqlite");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task_runs WHERE account_id = ?1",
                rusqlite::params!["account-3"],
                |row| row.get(0),
            )
            .expect("query task run count");
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn post_write_records_trigger_source_on_task_run() {
        let app = Router::new()
            .route(
                "/api/v1/groups/available",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": 1,
                                "name": "默认分组",
                                "platform": "openai",
                                "rate_multiplier": 1.0
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/api/v1/keys",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "key-1",
                                "group_id": 1,
                                "name": "主 Key",
                                "status": "active",
                                "platform": "openai"
                            }
                        ]
                    }))
                }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4",
            "site-4",
            "第四账号",
        );

        sync_account_data(
            &ctx,
            "account-4",
            SyncAccountDataInput {
                scope: DataSyncScope::Keys,
                trigger_source: DataSyncTrigger::PostWrite,
            },
        )
        .await
        .expect("post write sync");

        let conn = ctx.db.connect().expect("open sqlite");
        let source: String = conn
            .query_row(
                "SELECT primary_trigger_source FROM task_runs WHERE account_id = ?1 AND scope = 'keys'",
                rusqlite::params!["account-4"],
                |row| row.get(0),
            )
            .expect("query trigger source");
        assert_eq!(source, "post_write");
    }

    #[tokio::test]
    async fn custom_range_usage_sync_keeps_rows_outside_default_window() {
        let old_day = (Local::now() - Days::new(50)).date_naive().to_string();
        let app = Router::new().route(
            "/api/v1/usage",
            get({
                let old_day = old_day.clone();
                move || {
                    let old_day = old_day.clone();
                    async move {
                        Json(json!({
                            "items": [
                                {
                                    "id": "usage-old-1",
                                    "created_at": format!("{old_day}T08:00:00+08:00"),
                                    "model": "gpt-5.4",
                                    "actual_cost": 2.4,
                                    "total_cost": 2.4,
                                    "input_tokens": 120,
                                    "output_tokens": 80,
                                    "total_tokens": 200
                                }
                            ]
                        }))
                    }
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4b",
            "site-4b",
            "历史账号",
        );

        sync_usage_scope(
            &ctx,
            "account-4b",
            DataSyncTrigger::Manual,
            Some(old_day.clone()),
            Some(old_day.clone()),
        )
        .await
        .expect("custom range usage sync");

        let state = repositories::read_data_center_state(&ctx.db).expect("read state");
        let usage_rows = state
            .usage_rows
            .get("account-4b")
            .cloned()
            .unwrap_or_default();
        assert_eq!(usage_rows.len(), 1);
        assert_eq!(usage_rows[0].row.id, "usage-old-1");
        assert!(usage_rows[0].occurred_at.starts_with(&old_day));
    }

    #[tokio::test]
    async fn refresh_account_wrapper_returns_account_and_full_run() {
        let app = Router::new()
            .route(
                "/api/v1/user/profile",
                get(|| async {
                    Json(json!({
                        "email": "demo@example.com",
                        "balance": 18.0
                    }))
                }),
            )
            .route(
                "/api/v1/user/platform-quotas",
                get(|| async { Json(json!({ "platform_quotas": [] })) }),
            )
            .route(
                "/api/v1/subscriptions",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/subscriptions/summary",
                get(|| async {
                    Json(json!({
                        "active_count": 0,
                        "total_used_usd": 0.0,
                        "subscriptions": []
                    }))
                }),
            )
            .route(
                "/api/v1/groups/available",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/keys",
                get(|| async { Json(json!({ "items": [] })) }),
            )
            .route(
                "/api/v1/usage",
                get(|| async { Json(json!({ "items": [] })) }),
            );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve test app");
        });

        let ctx = build_test_context();
        seed_account(
            &ctx,
            &format!("http://{address}"),
            "account-4c",
            "site-4c",
            "刷新账号",
        );

        let result = refresh_account(&ctx, "account-4c", RefreshTriggerSource::Manual)
            .await
            .expect("refresh account wrapper");

        assert_eq!(result.account.account.id, "account-4c");
        assert_eq!(result.account.session_state, "ready");
        assert_eq!(result.run.scope, DataSyncScope::Full);
        assert_eq!(result.run.primary_trigger_source, DataSyncTrigger::Manual);
        assert_eq!(result.run.status, crate::contracts::TaskRunStatus::Succeeded);
    }

    #[test]
    fn repairs_missing_sync_status_from_existing_cache() {
        let ctx = build_test_context();
        seed_account(
            &ctx,
            "http://127.0.0.1:16661",
            "account-5",
            "site-5",
            "迁移账号",
        );

        let updated_at = "2026-06-11T00:21:00+08:00";
        repositories::save_profile_cache(
            &ctx.db,
            "account-5",
            &UserProfileRecord {
                id: 1,
                email: "demo@example.com".into(),
                username: None,
                avatar_url: None,
                role: "user".into(),
                balance: 42.5,
                concurrency: 1,
                status: "active".into(),
                last_active_at: Some(updated_at.into()),
                created_at: Some(updated_at.into()),
                updated_at: Some(updated_at.into()),
                total_recharged: None,
                rpm_limit: None,
                balance_notify_enabled: Some(false),
                balance_notify_threshold_type: None,
                balance_notify_threshold: None,
                balance_notify_extra_emails: Some(Vec::new()),
                identities: std::collections::HashMap::new(),
                auth_bindings: std::collections::HashMap::new(),
                identity_bindings: std::collections::HashMap::new(),
            },
            updated_at,
        )
        .expect("save profile cache");
        repositories::replace_subscription_cache(
            &ctx.db,
            "account-5",
            &[SubscriptionRecord {
                id: "mock-sub-1".into(),
                group_id: None,
                name: "Mock Annual".into(),
                status: "active".into(),
                group_name: Some("Mock Annual".into()),
                platform: Some("openai".into()),
                expires_at: Some("2027-06-06T00:00:00+08:00".into()),
                daily: Some(crate::contracts::SubscriptionQuotaWindow {
                    current: 1.5,
                    limit: 50.0,
                    window_start: Some("2026-06-06T00:00:00+08:00".into()),
                }),
                weekly: None,
                monthly: None,
            }],
            updated_at,
        )
        .expect("save subscription cache");
        repositories::save_subscription_summary_cache(
            &ctx.db,
            "account-5",
            &SubscriptionSummaryPayload {
                active_count: 1,
                total_used_usd: 1.5,
                subscriptions: vec![],
            },
            updated_at,
        )
        .expect("save subscription summary cache");
        repositories::replace_key_cache(
            &ctx.db,
            "account-5",
            &[ManagedKeyRecord {
                key: crate::contracts::KeyRecord {
                    id: "mock-key".into(),
                    group_id: None,
                    name: "mock-key".into(),
                    status: "active".into(),
                    platform: Some("openai".into()),
                    group_name: Some("Mock Group".into()),
                    expires_at: None,
                    last_used_at: Some("2026-06-06T00:15:00+08:00".into()),
                    quota: None,
                    quota_used: None,
                    rate_limit5h: None,
                    rate_limit1d: None,
                    rate_limit7d: None,
                    usage5h: None,
                    usage1d: None,
                    usage7d: None,
                },
                api_key_id: None,
                raw_key: None,
                user_id: None,
                ip_whitelist: None,
                ip_blacklist: None,
                window5h_start: None,
                window1d_start: None,
                window7d_start: None,
            }],
            updated_at,
        )
        .expect("save key cache");
        repositories::merge_usage_row_cache(
            &ctx.db,
            "account-5",
            &[UsageRow {
                id: "usage-1".into(),
                api_key_id: None,
                created_at: "2026-06-06T00:16:00+08:00".into(),
                model: "gpt-4.1-mini".into(),
                reasoning_effort: None,
                endpoint: Some("/responses".into()),
                upstream_endpoint: None,
                actual_cost: 0.5,
                total_cost: 0.5,
                input_tokens: 200,
                output_tokens: 300,
                input_cost: None,
                output_cost: None,
                cache_creation_tokens: Some(0),
                cache_read_tokens: Some(0),
                cache_creation_cost: None,
                cache_read_cost: None,
                total_tokens: 500,
                first_token_ms: None,
                duration_ms: Some(2222),
                billing_mode: None,
                request_type: None,
                stream: None,
                billing_type: None,
                rate_multiplier: None,
                user_agent: None,
                api_key_name: Some("mock-key".into()),
                platform: Some("openai".into()),
                subscription_name: Some("Mock Annual".into()),
                group_name: Some("Mock Group".into()),
                subscription_type: None,
            }],
            updated_at,
        )
        .expect("save usage cache");

        repair_sync_status_from_cache(&ctx).expect("repair sync status");

        let status = get_account_sync_status(&ctx, "account-5").expect("sync status");
        assert_eq!(status.statuses.len(), 3);
        assert!(status.statuses.iter().any(|item| item.scope == DataSyncScope::Core));
        assert!(status.statuses.iter().any(|item| item.scope == DataSyncScope::Keys));
        assert!(status.statuses.iter().any(|item| item.scope == DataSyncScope::Usage));
        assert!(status
            .statuses
            .iter()
            .all(|item| item.state == AccountSyncState::Succeeded));
    }

    #[test]
    fn repairs_missing_usage_cache_from_legacy_rows() {
        let ctx = build_test_context();
        seed_account(
            &ctx,
            "http://127.0.0.1:16661",
            "account-6",
            "site-6",
            "旧用量账号",
        );

        let conn = ctx.db.connect().expect("open sqlite");
        conn.execute(
            "CREATE TABLE usage_history (
                account_id TEXT NOT NULL,
                row_json TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            )",
            [],
        )
        .expect("create legacy usage_history");
        conn.execute(
            "INSERT INTO usage_history (account_id, row_json, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                "account-6",
                serde_json::to_string(&UsageRow {
                    id: "legacy-usage-1".into(),
                    api_key_id: Some(1),
                    created_at: "2026-06-06T00:16:00+08:00".into(),
                    model: "gpt-4.1-mini".into(),
                    reasoning_effort: None,
                    endpoint: Some("/responses".into()),
                    upstream_endpoint: None,
                    actual_cost: 0.5,
                    total_cost: 0.5,
                    input_tokens: 200,
                    output_tokens: 300,
                    input_cost: None,
                    output_cost: None,
                    cache_creation_tokens: Some(0),
                    cache_read_tokens: Some(0),
                    cache_creation_cost: None,
                    cache_read_cost: None,
                    total_tokens: 500,
                    first_token_ms: None,
                    duration_ms: Some(2222),
                    billing_mode: None,
                    request_type: None,
                    stream: None,
                    billing_type: None,
                    rate_multiplier: None,
                    user_agent: None,
                    api_key_name: Some("legacy-key".into()),
                    platform: Some("openai".into()),
                    subscription_name: Some("Legacy Plan".into()),
                    group_name: Some("Legacy Group".into()),
                    subscription_type: None,
                })
                .expect("serialize legacy usage row"),
                "2026-06-06T00:16:00+08:00",
                "2026-06-06T00:16:00+08:00"
            ],
        )
        .expect("insert legacy usage row");
        drop(conn);

        repair_usage_cache_from_legacy(&ctx).expect("repair usage cache");

        let state = repositories::read_data_center_state(&ctx.db).expect("read repaired state");
        let usage_rows = state
            .usage_rows
            .get("account-6")
            .cloned()
            .unwrap_or_default();
        assert_eq!(usage_rows.len(), 1);
        assert_eq!(usage_rows[0].row.id, "legacy-usage-1");
        assert_eq!(usage_rows[0].row.total_tokens, 500);
    }

    fn build_test_context() -> AppContext {
        let root = std::env::temp_dir().join(format!(
            "api-token-dc-tests-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = AppPaths::from_root(root);
        paths.ensure().expect("ensure app paths");
        let db = Database::new(paths.db_path.clone());
        let _ = db.connect().expect("init sqlite");
        AppContext {
            paths,
            db,
            sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
        }
    }

    fn seed_account(
        ctx: &AppContext,
        base_url: &str,
        account_id: &str,
        site_id: &str,
        label: &str,
    ) {
        repositories::insert_site(
            &ctx.db,
            &SiteRecord {
                id: site_id.into(),
                name: "Test Site".into(),
                base_url: base_url.into(),
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &ctx.db,
            &AccountRecord {
                id: account_id.into(),
                site_id: site_id.into(),
                label: label.into(),
                email: "demo@example.com".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-06-28T00:00:00Z".into(),
                updated_at: "2026-06-28T00:00:00Z".into(),
            },
        )
        .expect("insert account");
        repositories::save_session(
            &ctx.db,
            account_id,
            &StoredSession {
                saved_at: "2026-06-28T00:00:00Z".into(),
                access_token: Some("token".into()),
                refresh_token: None,
                token_type: Some("bearer".into()),
                cookie_jar_json: None,
            },
        )
        .expect("save session");
    }
}

