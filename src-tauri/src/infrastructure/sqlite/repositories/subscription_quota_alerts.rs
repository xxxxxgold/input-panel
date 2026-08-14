use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension, Row, Transaction};

use crate::contracts::{
    SubscriptionIdentityKind, SubscriptionQuotaAlertRule, SubscriptionQuotaAlertThresholdMode,
    SubscriptionQuotaAlertWindowKind,
};
use crate::infrastructure::sqlite::Database;

pub const DEFAULT_SUBSCRIPTION_QUOTA_ALERT_PERCENT: f64 = 98.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionQuotaAlertSubjectInput {
    pub account_id: String,
    pub subscription_key: String,
    pub identity_kind: SubscriptionIdentityKind,
    pub group_id: Option<i64>,
    pub upstream_subscription_id: Option<String>,
    pub fallback_identity: Option<String>,
    pub name_snapshot: String,
    pub platform_snapshot: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionQuotaAlertSubjectRecord {
    pub subject_id: String,
    pub account_id: String,
    pub subscription_key: String,
    pub identity_kind: SubscriptionIdentityKind,
    pub group_id: Option<i64>,
    pub upstream_subscription_id: Option<String>,
    pub fallback_identity: Option<String>,
    pub name_snapshot: String,
    pub platform_snapshot: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionQuotaAlertConfigRecord {
    pub subject_id: String,
    pub rule: SubscriptionQuotaAlertRule,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionQuotaAlertWindowState {
    Armed,
    Triggered,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionQuotaAlertWindowStateRecord {
    pub subject_id: String,
    pub window_kind: SubscriptionQuotaAlertWindowKind,
    pub config_revision: i64,
    pub period_key: Option<String>,
    pub state: SubscriptionQuotaAlertWindowState,
    pub trigger_sequence: i64,
    pub last_current: Option<f64>,
    pub last_limit: Option<f64>,
    pub last_event_id: Option<String>,
    pub last_evaluated_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionQuotaAlertDeliveryStatus {
    Pending,
    Delivering,
    Sent,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionQuotaAlertChannel {
    Business,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSubscriptionQuotaAlertEvent {
    pub id: String,
    pub subject_id: String,
    pub dedupe_key: String,
    pub config_revision: i64,
    pub triggered_windows_json: String,
    pub payload_json: String,
    pub business_status: SubscriptionQuotaAlertDeliveryStatus,
    pub windows_status: SubscriptionQuotaAlertDeliveryStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionQuotaAlertEventRecord {
    pub id: String,
    pub subject_id: String,
    pub dedupe_key: String,
    pub config_revision: i64,
    pub triggered_windows_json: String,
    pub payload_json: String,
    pub business_status: SubscriptionQuotaAlertDeliveryStatus,
    pub windows_status: SubscriptionQuotaAlertDeliveryStatus,
    pub business_attempts: i64,
    pub windows_attempts: i64,
    pub business_next_attempt_at: Option<String>,
    pub windows_next_attempt_at: Option<String>,
    pub business_lease_id: Option<String>,
    pub windows_lease_id: Option<String>,
    pub business_lease_until: Option<String>,
    pub windows_lease_until: Option<String>,
    pub business_last_error: Option<String>,
    pub windows_last_error: Option<String>,
    pub created_at: String,
    pub business_sent_at: Option<String>,
    pub windows_sent_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedSubscriptionQuotaAlertChannel {
    pub event_id: String,
    pub account_id: String,
    pub subscription_name: String,
    pub dedupe_key: String,
    pub payload_json: String,
    pub lease_id: String,
    pub attempt: i64,
    pub channel: SubscriptionQuotaAlertChannel,
}

/// 返回服务端权威默认规则，不会在配置表中创建记录。
pub fn default_subscription_quota_alert_rule() -> SubscriptionQuotaAlertRule {
    SubscriptionQuotaAlertRule {
        enabled: true,
        threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
        threshold_value: DEFAULT_SUBSCRIPTION_QUOTA_ALERT_PERCENT,
        revision: 0,
    }
}

/// 按稳定别名解析提醒对象；出现更强身份时保留 subject_id 并升级 canonical key。
pub fn resolve_subscription_quota_alert_subject(
    db: &Database,
    input: &SubscriptionQuotaAlertSubjectInput,
    now: &str,
) -> Result<SubscriptionQuotaAlertSubjectRecord> {
    validate_subject_input(input)?;
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;

    let existing =
        find_subject_by_key_in_transaction(&tx, &input.account_id, &input.subscription_key)?;
    let existing = match existing {
        Some(record) => Some(record),
        None => {
            if let Some(group_id) = input.group_id {
                find_unique_subject_by_alias(
                    &tx,
                    &input.account_id,
                    "group_id",
                    &group_id.to_string(),
                )?
            } else {
                None
            }
        }
    };

    let existing = match existing {
        Some(record) => Some(record),
        None => {
            if let Some(upstream_id) = input.upstream_subscription_id.as_deref() {
                find_unique_subject_by_alias(
                    &tx,
                    &input.account_id,
                    "upstream_subscription_id",
                    upstream_id,
                )?
            } else {
                None
            }
        }
    };
    let existing = match existing {
        Some(record) => Some(record),
        None => {
            if let Some(fallback_identity) = input.fallback_identity.as_deref() {
                find_unique_subject_by_alias(
                    &tx,
                    &input.account_id,
                    "fallback_identity",
                    fallback_identity,
                )?
            } else {
                None
            }
        }
    };

    let subject_id = if let Some(existing) = existing {
        let should_promote =
            identity_strength(&input.identity_kind) >= identity_strength(&existing.identity_kind);
        let subscription_key = if should_promote {
            input.subscription_key.as_str()
        } else {
            existing.subscription_key.as_str()
        };
        let identity_kind = if should_promote {
            &input.identity_kind
        } else {
            &existing.identity_kind
        };
        tx.execute(
            "UPDATE subscription_quota_alert_subjects
             SET subscription_key = ?2,
                 identity_kind = ?3,
                 group_id = COALESCE(group_id, ?4),
                 upstream_subscription_id = COALESCE(upstream_subscription_id, ?5),
                 fallback_identity = COALESCE(fallback_identity, ?6),
                 name_snapshot = ?7,
                 platform_snapshot = ?8,
                 updated_at = ?9
             WHERE subject_id = ?1",
            params![
                &existing.subject_id,
                subscription_key,
                identity_kind_to_str(identity_kind),
                input.group_id,
                &input.upstream_subscription_id,
                &input.fallback_identity,
                &input.name_snapshot,
                &input.platform_snapshot,
                now,
            ],
        )
        .context("无法升级订阅额度提醒对象身份")?;
        existing.subject_id
    } else {
        let subject_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO subscription_quota_alert_subjects (
                subject_id, account_id, subscription_key, identity_kind, group_id,
                upstream_subscription_id, fallback_identity, name_snapshot, platform_snapshot,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                &subject_id,
                &input.account_id,
                &input.subscription_key,
                identity_kind_to_str(&input.identity_kind),
                input.group_id,
                &input.upstream_subscription_id,
                &input.fallback_identity,
                &input.name_snapshot,
                &input.platform_snapshot,
                now,
            ],
        )
        .context("无法创建订阅额度提醒对象")?;
        subject_id
    };

    let subject = find_subject_by_id_in_transaction(&tx, &subject_id)?
        .context("订阅额度提醒对象保存后不存在")?;
    tx.commit()?;
    Ok(subject)
}

pub fn find_subscription_quota_alert_subject_by_key(
    db: &Database,
    account_id: &str,
    subscription_key: &str,
) -> Result<Option<SubscriptionQuotaAlertSubjectRecord>> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT subject_id, account_id, subscription_key, identity_kind, group_id,
                upstream_subscription_id, fallback_identity, name_snapshot, platform_snapshot,
                created_at, updated_at
         FROM subscription_quota_alert_subjects
         WHERE account_id = ?1 AND subscription_key = ?2",
        params![account_id, subscription_key],
        subject_from_row,
    )
    .optional()
    .map_err(Into::into)
}

pub fn find_subscription_quota_alert_config(
    db: &Database,
    subject_id: &str,
) -> Result<Option<SubscriptionQuotaAlertConfigRecord>> {
    let conn = db.connect()?;
    find_config_in_connection(&conn, subject_id)
}

/// 保存自定义规则；只有 effective 值变化时才推进 revision。
pub fn upsert_subscription_quota_alert_config(
    db: &Database,
    subject_id: &str,
    enabled: bool,
    threshold_mode: &SubscriptionQuotaAlertThresholdMode,
    threshold_value: f64,
    now: &str,
) -> Result<SubscriptionQuotaAlertConfigRecord> {
    validate_threshold(threshold_mode, threshold_value)?;
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let existing = find_config_in_transaction(&tx, subject_id)?;
    let effective = existing
        .as_ref()
        .map(|record| record.rule.clone())
        .unwrap_or_else(default_subscription_quota_alert_rule);
    let unchanged = effective.enabled == enabled
        && effective.threshold_mode == *threshold_mode
        && effective.threshold_value == threshold_value;

    if let Some(existing) = existing.as_ref().filter(|_| unchanged) {
        tx.commit()?;
        return Ok(existing.clone());
    }

    let revision = if unchanged {
        effective.revision
    } else {
        effective.revision.saturating_add(1)
    };
    tx.execute(
        "INSERT INTO subscription_quota_alert_configs (
            subject_id, enabled, threshold_mode, threshold_value, revision, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(subject_id) DO UPDATE SET
            enabled = excluded.enabled,
            threshold_mode = excluded.threshold_mode,
            threshold_value = excluded.threshold_value,
            revision = excluded.revision,
            updated_at = excluded.updated_at",
        params![
            subject_id,
            i64::from(enabled),
            threshold_mode_to_str(threshold_mode),
            threshold_value,
            revision,
            now,
        ],
    )
    .context("无法保存订阅额度提醒配置")?;
    let saved =
        find_config_in_transaction(&tx, subject_id)?.context("订阅额度提醒配置保存后不存在")?;
    tx.commit()?;
    Ok(saved)
}

pub fn list_subscription_quota_alert_configs(
    db: &Database,
    account_id: &str,
) -> Result<Vec<(String, SubscriptionQuotaAlertRule)>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT subjects.subscription_key, configs.enabled, configs.threshold_mode,
                configs.threshold_value, configs.revision
         FROM subscription_quota_alert_configs AS configs
         JOIN subscription_quota_alert_subjects AS subjects
           ON subjects.subject_id = configs.subject_id
         WHERE subjects.account_id = ?1
         ORDER BY subjects.subscription_key ASC",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let threshold_mode: String = row.get(2)?;
        Ok((
            row.get(0)?,
            SubscriptionQuotaAlertRule {
                enabled: row.get::<_, i64>(1)? > 0,
                threshold_mode: parse_threshold_mode(&threshold_mode),
                threshold_value: row.get(3)?,
                revision: row.get(4)?,
            },
        ))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_subscription_quota_alert_window_states(
    db: &Database,
    subject_id: &str,
) -> Result<Vec<SubscriptionQuotaAlertWindowStateRecord>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT subject_id, window_kind, config_revision, period_key, state,
                trigger_sequence, last_current, last_limit, last_event_id,
                last_evaluated_at, updated_at
         FROM subscription_quota_alert_window_states
         WHERE subject_id = ?1
         ORDER BY CASE window_kind WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END",
    )?;
    let rows = stmt.query_map(params![subject_id], window_state_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// 将窗口状态转换和对应提醒事件放在同一个 SQLite 事务中提交。
pub fn commit_subscription_quota_alert_evaluation(
    db: &Database,
    states: &[SubscriptionQuotaAlertWindowStateRecord],
    event: Option<&NewSubscriptionQuotaAlertEvent>,
) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    for state in states {
        tx.execute(
            "INSERT INTO subscription_quota_alert_window_states (
                subject_id, window_kind, config_revision, period_key, state,
                trigger_sequence, last_current, last_limit, last_event_id,
                last_evaluated_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(subject_id, window_kind) DO UPDATE SET
                config_revision = excluded.config_revision,
                period_key = excluded.period_key,
                state = excluded.state,
                trigger_sequence = excluded.trigger_sequence,
                last_current = excluded.last_current,
                last_limit = excluded.last_limit,
                last_event_id = excluded.last_event_id,
                last_evaluated_at = excluded.last_evaluated_at,
                updated_at = excluded.updated_at",
            params![
                &state.subject_id,
                window_kind_to_str(state.window_kind),
                state.config_revision,
                &state.period_key,
                window_state_to_str(state.state),
                state.trigger_sequence,
                state.last_current,
                state.last_limit,
                &state.last_event_id,
                &state.last_evaluated_at,
                &state.updated_at,
            ],
        )?;
    }
    if let Some(event) = event {
        tx.execute(
            "INSERT INTO subscription_quota_alert_events (
                id, subject_id, dedupe_key, config_revision, triggered_windows_json,
                payload_json, business_status, windows_status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                &event.id,
                &event.subject_id,
                &event.dedupe_key,
                event.config_revision,
                &event.triggered_windows_json,
                &event.payload_json,
                delivery_status_to_str(event.business_status),
                delivery_status_to_str(event.windows_status),
                &event.created_at,
                &event.updated_at,
            ],
        )
        .context("无法持久化订阅额度提醒事件")?;
    }
    tx.commit()?;
    Ok(())
}

pub fn find_subscription_quota_alert_event(
    db: &Database,
    event_id: &str,
) -> Result<Option<SubscriptionQuotaAlertEventRecord>> {
    let conn = db.connect()?;
    conn.query_row(
        &format!(
            "SELECT {} FROM subscription_quota_alert_events WHERE id = ?1",
            event_select_columns("subscription_quota_alert_events")
        ),
        params![event_id],
        event_from_row,
    )
    .optional()
    .map_err(Into::into)
}

/// 原子认领一个到期通道；并发 dispatcher 只能有一个获得有效 lease。
pub fn claim_due_subscription_quota_alert_channel(
    db: &Database,
    channel: SubscriptionQuotaAlertChannel,
    account_id: Option<&str>,
    now: &str,
    lease_id: &str,
    lease_until: &str,
) -> Result<Option<ClaimedSubscriptionQuotaAlertChannel>> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let columns = channel_columns(channel);
    let account_filter = if account_id.is_some() {
        "AND subjects.account_id = ?2"
    } else {
        "AND ?2 IS NULL"
    };
    let sql = format!(
        "SELECT events.id, subjects.account_id, subjects.name_snapshot,
                events.dedupe_key, events.payload_json
         FROM subscription_quota_alert_events AS events
         JOIN subscription_quota_alert_subjects AS subjects
           ON subjects.subject_id = events.subject_id
         WHERE events.completed_at IS NULL
           {account_filter}
           AND (
             (events.{status} = 'pending'
               AND (events.{next_attempt} IS NULL OR events.{next_attempt} <= ?1))
             OR
             (events.{status} = 'delivering'
               AND events.{lease_until} IS NOT NULL AND events.{lease_until} <= ?1)
           )
         ORDER BY events.created_at ASC, events.id ASC
         LIMIT 1",
        status = columns.status,
        next_attempt = columns.next_attempt,
        lease_until = columns.lease_until,
    );
    let candidate = tx
        .query_row(&sql, params![now, account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .optional()?;
    let Some((event_id, claimed_account_id, subscription_name, dedupe_key, payload_json)) =
        candidate
    else {
        tx.commit()?;
        return Ok(None);
    };

    let update_sql = format!(
        "UPDATE subscription_quota_alert_events
         SET {status} = 'delivering',
             {attempts} = {attempts} + 1,
             {lease_id_column} = ?2,
             {lease_until} = ?3,
             updated_at = ?1
         WHERE id = ?4
           AND completed_at IS NULL
           AND (
             ({status} = 'pending' AND ({next_attempt} IS NULL OR {next_attempt} <= ?1))
             OR
             ({status} = 'delivering' AND {lease_until} IS NOT NULL AND {lease_until} <= ?1)
           )",
        status = columns.status,
        attempts = columns.attempts,
        lease_id_column = columns.lease_id,
        lease_until = columns.lease_until,
        next_attempt = columns.next_attempt,
    );
    if tx.execute(&update_sql, params![now, lease_id, lease_until, &event_id])? != 1 {
        tx.commit()?;
        return Ok(None);
    }
    let attempt_sql = format!(
        "SELECT {} FROM subscription_quota_alert_events WHERE id = ?1",
        columns.attempts
    );
    let attempt = tx.query_row(&attempt_sql, params![&event_id], |row| row.get(0))?;
    tx.commit()?;
    Ok(Some(ClaimedSubscriptionQuotaAlertChannel {
        event_id,
        account_id: claimed_account_id,
        subscription_name,
        dedupe_key,
        payload_json,
        lease_id: lease_id.to_string(),
        attempt,
        channel,
    }))
}

pub fn mark_subscription_quota_alert_channel_sent(
    db: &Database,
    event_id: &str,
    channel: SubscriptionQuotaAlertChannel,
    lease_id: &str,
    sent_at: &str,
) -> Result<bool> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let columns = channel_columns(channel);
    let sql = format!(
        "UPDATE subscription_quota_alert_events
         SET {status} = 'sent', {lease_id_column} = NULL, {lease_until} = NULL,
             {last_error} = NULL, {sent_at_column} = ?1, updated_at = ?1
         WHERE id = ?2 AND {status} = 'delivering' AND {lease_id_column} = ?3",
        status = columns.status,
        lease_id_column = columns.lease_id,
        lease_until = columns.lease_until,
        last_error = columns.last_error,
        sent_at_column = columns.sent_at,
    );
    let updated = tx.execute(&sql, params![sent_at, event_id, lease_id])? == 1;
    if updated {
        mark_event_completed_if_terminal(&tx, event_id, sent_at)?;
    }
    tx.commit()?;
    Ok(updated)
}

pub fn mark_subscription_quota_alert_channel_failed(
    db: &Database,
    event_id: &str,
    channel: SubscriptionQuotaAlertChannel,
    lease_id: &str,
    error: &str,
    next_attempt_at: &str,
    updated_at: &str,
) -> Result<bool> {
    let conn = db.connect()?;
    let columns = channel_columns(channel);
    let sql = format!(
        "UPDATE subscription_quota_alert_events
         SET {status} = 'pending', {lease_id_column} = NULL, {lease_until} = NULL,
             {last_error} = ?1, {next_attempt} = ?2, updated_at = ?3
         WHERE id = ?4 AND {status} = 'delivering' AND {lease_id_column} = ?5",
        status = columns.status,
        lease_id_column = columns.lease_id,
        lease_until = columns.lease_until,
        last_error = columns.last_error,
        next_attempt = columns.next_attempt,
    );
    Ok(conn.execute(
        &sql,
        params![error, next_attempt_at, updated_at, event_id, lease_id],
    )? == 1)
}

pub fn prune_completed_subscription_quota_alert_events_before(
    db: &Database,
    cutoff: &str,
) -> Result<usize> {
    let conn = db.connect()?;
    Ok(conn.execute(
        "DELETE FROM subscription_quota_alert_events
         WHERE completed_at IS NOT NULL AND completed_at < ?1",
        params![cutoff],
    )?)
}

fn validate_subject_input(input: &SubscriptionQuotaAlertSubjectInput) -> Result<()> {
    if input.account_id.trim().is_empty()
        || input.subscription_key.trim().is_empty()
        || input.name_snapshot.trim().is_empty()
    {
        bail!("订阅额度提醒对象身份不完整。");
    }
    match input.identity_kind {
        SubscriptionIdentityKind::Group if input.group_id.is_none() => {
            bail!("分组订阅身份缺少 group_id。")
        }
        SubscriptionIdentityKind::Upstream if input.upstream_subscription_id.is_none() => {
            bail!("上游订阅身份缺少原始 ID。")
        }
        SubscriptionIdentityKind::Fallback if input.fallback_identity.is_none() => {
            bail!("回退订阅身份缺少 fallback identity。")
        }
        _ => Ok(()),
    }
}

fn validate_threshold(
    mode: &SubscriptionQuotaAlertThresholdMode,
    threshold_value: f64,
) -> Result<()> {
    if !threshold_value.is_finite() || threshold_value <= 0.0 {
        bail!("订阅额度提醒阈值必须是有限正数。");
    }
    if matches!(mode, SubscriptionQuotaAlertThresholdMode::UsagePercent) && threshold_value > 100.0
    {
        bail!("订阅额度百分比提醒阈值不能超过 100。")
    }
    Ok(())
}

fn find_subject_by_key_in_transaction(
    tx: &Transaction<'_>,
    account_id: &str,
    subscription_key: &str,
) -> Result<Option<SubscriptionQuotaAlertSubjectRecord>> {
    tx.query_row(
        "SELECT subject_id, account_id, subscription_key, identity_kind, group_id,
                upstream_subscription_id, fallback_identity, name_snapshot, platform_snapshot,
                created_at, updated_at
         FROM subscription_quota_alert_subjects
         WHERE account_id = ?1 AND subscription_key = ?2",
        params![account_id, subscription_key],
        subject_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn find_subject_by_id_in_transaction(
    tx: &Transaction<'_>,
    subject_id: &str,
) -> Result<Option<SubscriptionQuotaAlertSubjectRecord>> {
    tx.query_row(
        "SELECT subject_id, account_id, subscription_key, identity_kind, group_id,
                upstream_subscription_id, fallback_identity, name_snapshot, platform_snapshot,
                created_at, updated_at
         FROM subscription_quota_alert_subjects WHERE subject_id = ?1",
        params![subject_id],
        subject_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn find_unique_subject_by_alias(
    tx: &Transaction<'_>,
    account_id: &str,
    column: &str,
    value: &str,
) -> Result<Option<SubscriptionQuotaAlertSubjectRecord>> {
    debug_assert!(matches!(
        column,
        "group_id" | "upstream_subscription_id" | "fallback_identity"
    ));
    let predicate = if column == "group_id" {
        "group_id = CAST(?2 AS INTEGER)"
    } else {
        match column {
            "upstream_subscription_id" => "upstream_subscription_id = ?2",
            _ => "fallback_identity = ?2",
        }
    };
    let sql = format!(
        "SELECT subject_id, account_id, subscription_key, identity_kind, group_id,
                upstream_subscription_id, fallback_identity, name_snapshot, platform_snapshot,
                created_at, updated_at
         FROM subscription_quota_alert_subjects
         WHERE account_id = ?1 AND {predicate}
         ORDER BY created_at ASC LIMIT 2"
    );
    let mut stmt = tx.prepare(&sql)?;
    let rows = stmt.query_map(params![account_id, value], subject_from_row)?;
    let records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    if records.len() > 1 {
        bail!("订阅额度提醒身份别名存在歧义，拒绝自动合并。");
    }
    Ok(records.into_iter().next())
}

fn subject_from_row(row: &Row<'_>) -> rusqlite::Result<SubscriptionQuotaAlertSubjectRecord> {
    let identity_kind: String = row.get(3)?;
    Ok(SubscriptionQuotaAlertSubjectRecord {
        subject_id: row.get(0)?,
        account_id: row.get(1)?,
        subscription_key: row.get(2)?,
        identity_kind: parse_identity_kind(&identity_kind),
        group_id: row.get(4)?,
        upstream_subscription_id: row.get(5)?,
        fallback_identity: row.get(6)?,
        name_snapshot: row.get(7)?,
        platform_snapshot: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn find_config_in_connection(
    conn: &rusqlite::Connection,
    subject_id: &str,
) -> Result<Option<SubscriptionQuotaAlertConfigRecord>> {
    conn.query_row(
        "SELECT subject_id, enabled, threshold_mode, threshold_value, revision, created_at, updated_at
         FROM subscription_quota_alert_configs WHERE subject_id = ?1",
        params![subject_id],
        config_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn find_config_in_transaction(
    tx: &Transaction<'_>,
    subject_id: &str,
) -> Result<Option<SubscriptionQuotaAlertConfigRecord>> {
    tx.query_row(
        "SELECT subject_id, enabled, threshold_mode, threshold_value, revision, created_at, updated_at
         FROM subscription_quota_alert_configs WHERE subject_id = ?1",
        params![subject_id],
        config_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn config_from_row(row: &Row<'_>) -> rusqlite::Result<SubscriptionQuotaAlertConfigRecord> {
    let threshold_mode: String = row.get(2)?;
    Ok(SubscriptionQuotaAlertConfigRecord {
        subject_id: row.get(0)?,
        rule: SubscriptionQuotaAlertRule {
            enabled: row.get::<_, i64>(1)? > 0,
            threshold_mode: parse_threshold_mode(&threshold_mode),
            threshold_value: row.get(3)?,
            revision: row.get(4)?,
        },
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn window_state_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<SubscriptionQuotaAlertWindowStateRecord> {
    let window_kind: String = row.get(1)?;
    let state: String = row.get(4)?;
    Ok(SubscriptionQuotaAlertWindowStateRecord {
        subject_id: row.get(0)?,
        window_kind: parse_window_kind(&window_kind),
        config_revision: row.get(2)?,
        period_key: row.get(3)?,
        state: parse_window_state(&state),
        trigger_sequence: row.get(5)?,
        last_current: row.get(6)?,
        last_limit: row.get(7)?,
        last_event_id: row.get(8)?,
        last_evaluated_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn event_select_columns(prefix: &str) -> String {
    format!(
        "{prefix}.id, {prefix}.subject_id, {prefix}.dedupe_key, {prefix}.config_revision,
         {prefix}.triggered_windows_json, {prefix}.payload_json,
         {prefix}.business_status, {prefix}.windows_status,
         {prefix}.business_attempts, {prefix}.windows_attempts,
         {prefix}.business_next_attempt_at, {prefix}.windows_next_attempt_at,
         {prefix}.business_lease_id, {prefix}.windows_lease_id,
         {prefix}.business_lease_until, {prefix}.windows_lease_until,
         {prefix}.business_last_error, {prefix}.windows_last_error,
         {prefix}.created_at, {prefix}.business_sent_at, {prefix}.windows_sent_at,
         {prefix}.completed_at, {prefix}.updated_at"
    )
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<SubscriptionQuotaAlertEventRecord> {
    let business_status: String = row.get(6)?;
    let windows_status: String = row.get(7)?;
    Ok(SubscriptionQuotaAlertEventRecord {
        id: row.get(0)?,
        subject_id: row.get(1)?,
        dedupe_key: row.get(2)?,
        config_revision: row.get(3)?,
        triggered_windows_json: row.get(4)?,
        payload_json: row.get(5)?,
        business_status: parse_delivery_status(&business_status),
        windows_status: parse_delivery_status(&windows_status),
        business_attempts: row.get(8)?,
        windows_attempts: row.get(9)?,
        business_next_attempt_at: row.get(10)?,
        windows_next_attempt_at: row.get(11)?,
        business_lease_id: row.get(12)?,
        windows_lease_id: row.get(13)?,
        business_lease_until: row.get(14)?,
        windows_lease_until: row.get(15)?,
        business_last_error: row.get(16)?,
        windows_last_error: row.get(17)?,
        created_at: row.get(18)?,
        business_sent_at: row.get(19)?,
        windows_sent_at: row.get(20)?,
        completed_at: row.get(21)?,
        updated_at: row.get(22)?,
    })
}

struct ChannelColumns {
    status: &'static str,
    attempts: &'static str,
    next_attempt: &'static str,
    lease_id: &'static str,
    lease_until: &'static str,
    last_error: &'static str,
    sent_at: &'static str,
}

fn channel_columns(channel: SubscriptionQuotaAlertChannel) -> ChannelColumns {
    match channel {
        SubscriptionQuotaAlertChannel::Business => ChannelColumns {
            status: "business_status",
            attempts: "business_attempts",
            next_attempt: "business_next_attempt_at",
            lease_id: "business_lease_id",
            lease_until: "business_lease_until",
            last_error: "business_last_error",
            sent_at: "business_sent_at",
        },
        SubscriptionQuotaAlertChannel::Windows => ChannelColumns {
            status: "windows_status",
            attempts: "windows_attempts",
            next_attempt: "windows_next_attempt_at",
            lease_id: "windows_lease_id",
            lease_until: "windows_lease_until",
            last_error: "windows_last_error",
            sent_at: "windows_sent_at",
        },
    }
}

fn mark_event_completed_if_terminal(
    tx: &Transaction<'_>,
    event_id: &str,
    completed_at: &str,
) -> Result<()> {
    tx.execute(
        "UPDATE subscription_quota_alert_events
         SET completed_at = COALESCE(completed_at, ?1), updated_at = ?1
         WHERE id = ?2
           AND business_status IN ('sent', 'unsupported')
           AND windows_status IN ('sent', 'unsupported')",
        params![completed_at, event_id],
    )?;
    Ok(())
}

fn identity_strength(value: &SubscriptionIdentityKind) -> u8 {
    match value {
        SubscriptionIdentityKind::Group => 3,
        SubscriptionIdentityKind::Upstream => 2,
        SubscriptionIdentityKind::Fallback => 1,
    }
}

fn identity_kind_to_str(value: &SubscriptionIdentityKind) -> &'static str {
    match value {
        SubscriptionIdentityKind::Group => "group",
        SubscriptionIdentityKind::Upstream => "upstream",
        SubscriptionIdentityKind::Fallback => "fallback",
    }
}

fn parse_identity_kind(value: &str) -> SubscriptionIdentityKind {
    match value {
        "group" => SubscriptionIdentityKind::Group,
        "upstream" => SubscriptionIdentityKind::Upstream,
        _ => SubscriptionIdentityKind::Fallback,
    }
}

fn threshold_mode_to_str(value: &SubscriptionQuotaAlertThresholdMode) -> &'static str {
    match value {
        SubscriptionQuotaAlertThresholdMode::AmountUsd => "amount_usd",
        SubscriptionQuotaAlertThresholdMode::UsagePercent => "usage_percent",
    }
}

fn parse_threshold_mode(value: &str) -> SubscriptionQuotaAlertThresholdMode {
    match value {
        "amount_usd" => SubscriptionQuotaAlertThresholdMode::AmountUsd,
        _ => SubscriptionQuotaAlertThresholdMode::UsagePercent,
    }
}

fn window_kind_to_str(value: SubscriptionQuotaAlertWindowKind) -> &'static str {
    match value {
        SubscriptionQuotaAlertWindowKind::Daily => "daily",
        SubscriptionQuotaAlertWindowKind::Weekly => "weekly",
        SubscriptionQuotaAlertWindowKind::Monthly => "monthly",
    }
}

fn parse_window_kind(value: &str) -> SubscriptionQuotaAlertWindowKind {
    match value {
        "weekly" => SubscriptionQuotaAlertWindowKind::Weekly,
        "monthly" => SubscriptionQuotaAlertWindowKind::Monthly,
        _ => SubscriptionQuotaAlertWindowKind::Daily,
    }
}

fn window_state_to_str(value: SubscriptionQuotaAlertWindowState) -> &'static str {
    match value {
        SubscriptionQuotaAlertWindowState::Armed => "armed",
        SubscriptionQuotaAlertWindowState::Triggered => "triggered",
    }
}

fn parse_window_state(value: &str) -> SubscriptionQuotaAlertWindowState {
    match value {
        "triggered" => SubscriptionQuotaAlertWindowState::Triggered,
        _ => SubscriptionQuotaAlertWindowState::Armed,
    }
}

fn delivery_status_to_str(value: SubscriptionQuotaAlertDeliveryStatus) -> &'static str {
    match value {
        SubscriptionQuotaAlertDeliveryStatus::Pending => "pending",
        SubscriptionQuotaAlertDeliveryStatus::Delivering => "delivering",
        SubscriptionQuotaAlertDeliveryStatus::Sent => "sent",
        SubscriptionQuotaAlertDeliveryStatus::Unsupported => "unsupported",
    }
}

fn parse_delivery_status(value: &str) -> SubscriptionQuotaAlertDeliveryStatus {
    match value {
        "delivering" => SubscriptionQuotaAlertDeliveryStatus::Delivering,
        "sent" => SubscriptionQuotaAlertDeliveryStatus::Sent,
        "unsupported" => SubscriptionQuotaAlertDeliveryStatus::Unsupported,
        _ => SubscriptionQuotaAlertDeliveryStatus::Pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{AccountRecord, SiteRecord};
    use crate::infrastructure::sqlite::repositories;

    struct TestDatabase {
        db: Database,
        path: std::path::PathBuf,
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                self.path.with_extension("db-wal"),
                self.path.with_extension("db-shm"),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn build_test_db() -> TestDatabase {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tmp");
        std::fs::create_dir_all(&root).expect("create workspace tmp");
        let path = root.join(format!(
            "subscription-quota-alert-repository-{}.db",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(path.clone());
        let _ = db.connect().expect("initialize sqlite");
        repositories::insert_site(
            &db,
            &SiteRecord {
                id: "site-1".into(),
                name: "测试站点".into(),
                base_url: "https://example.test".into(),
                created_at: "2026-08-04 00:00:00".into(),
                updated_at: "2026-08-04 00:00:00".into(),
                ..SiteRecord::default()
            },
        )
        .expect("insert site");
        repositories::insert_account(
            &db,
            &AccountRecord {
                id: "account-1".into(),
                site_id: "site-1".into(),
                label: "测试账号".into(),
                email: "quota@example.test".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-08-04 00:00:00".into(),
                updated_at: "2026-08-04 00:00:00".into(),
            },
        )
        .expect("insert account");
        TestDatabase { db, path }
    }

    fn fallback_subject_input() -> SubscriptionQuotaAlertSubjectInput {
        SubscriptionQuotaAlertSubjectInput {
            account_id: "account-1".into(),
            subscription_key: "fallback:v1:openai|default|plan".into(),
            identity_kind: SubscriptionIdentityKind::Fallback,
            group_id: None,
            upstream_subscription_id: None,
            fallback_identity: Some("fallback:v1:openai|default|plan".into()),
            name_snapshot: "Plan".into(),
            platform_snapshot: Some("openai".into()),
        }
    }

    #[test]
    fn missing_config_uses_virtual_default_without_creating_a_row() {
        let fixture = build_test_db();
        let subject = resolve_subscription_quota_alert_subject(
            &fixture.db,
            &fallback_subject_input(),
            "2026-08-04 00:00:00",
        )
        .expect("resolve subject");

        assert_eq!(
            default_subscription_quota_alert_rule(),
            SubscriptionQuotaAlertRule {
                enabled: true,
                threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
                threshold_value: 98.0,
                revision: 0,
            }
        );
        assert!(
            find_subscription_quota_alert_config(&fixture.db, &subject.subject_id)
                .expect("read config")
                .is_none()
        );
        assert!(
            list_subscription_quota_alert_configs(&fixture.db, "account-1")
                .expect("list config")
                .is_empty()
        );
    }

    #[test]
    fn config_revision_changes_only_when_effective_rule_changes() {
        let fixture = build_test_db();
        let subject = resolve_subscription_quota_alert_subject(
            &fixture.db,
            &fallback_subject_input(),
            "2026-08-04 00:00:00",
        )
        .expect("resolve subject");

        let explicit_default = upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::UsagePercent,
            98.0,
            "2026-08-04 00:00:01",
        )
        .expect("materialize default");
        assert_eq!(explicit_default.rule.revision, 0);
        let custom = upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::AmountUsd,
            25.0,
            "2026-08-04 00:00:02",
        )
        .expect("save custom");
        assert_eq!(custom.rule.revision, 1);
        let repeated = upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::AmountUsd,
            25.0,
            "2026-08-04 00:00:03",
        )
        .expect("repeat custom");
        assert_eq!(repeated.rule.revision, 1);
        let disabled = upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            false,
            &SubscriptionQuotaAlertThresholdMode::AmountUsd,
            25.0,
            "2026-08-04 00:00:04",
        )
        .expect("disable");
        assert_eq!(disabled.rule.revision, 2);
        let reenabled = upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::AmountUsd,
            25.0,
            "2026-08-04 00:00:05",
        )
        .expect("reenable");
        assert_eq!(reenabled.rule.revision, 3);
    }

    #[test]
    fn stronger_group_identity_preserves_subject_and_configuration() {
        let fixture = build_test_db();
        let fallback = resolve_subscription_quota_alert_subject(
            &fixture.db,
            &fallback_subject_input(),
            "2026-08-04 00:00:00",
        )
        .expect("resolve fallback");
        upsert_subscription_quota_alert_config(
            &fixture.db,
            &fallback.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::UsagePercent,
            90.0,
            "2026-08-04 00:00:01",
        )
        .expect("save config");

        let promoted = resolve_subscription_quota_alert_subject(
            &fixture.db,
            &SubscriptionQuotaAlertSubjectInput {
                account_id: "account-1".into(),
                subscription_key: "group:42".into(),
                identity_kind: SubscriptionIdentityKind::Group,
                group_id: Some(42),
                upstream_subscription_id: None,
                fallback_identity: fallback.fallback_identity.clone(),
                name_snapshot: "Plan renamed".into(),
                platform_snapshot: Some("openai".into()),
            },
            "2026-08-04 00:00:02",
        )
        .expect("promote subject");

        assert_eq!(promoted.subject_id, fallback.subject_id);
        assert_eq!(promoted.subscription_key, "group:42");
        assert_eq!(promoted.identity_kind, SubscriptionIdentityKind::Group);
        assert_eq!(
            find_subscription_quota_alert_config(&fixture.db, &promoted.subject_id)
                .expect("read preserved config")
                .expect("config exists")
                .rule
                .threshold_value,
            90.0
        );
    }

    #[test]
    fn event_channels_are_claimed_and_completed_independently() {
        let fixture = build_test_db();
        let subject = resolve_subscription_quota_alert_subject(
            &fixture.db,
            &fallback_subject_input(),
            "2026-08-04 00:00:00",
        )
        .expect("resolve subject");
        let event = NewSubscriptionQuotaAlertEvent {
            id: "event-1".into(),
            subject_id: subject.subject_id.clone(),
            dedupe_key: "subscription-quota:event-1".into(),
            config_revision: 0,
            triggered_windows_json: "[]".into(),
            payload_json: "{\"id\":\"event-1\"}".into(),
            business_status: SubscriptionQuotaAlertDeliveryStatus::Pending,
            windows_status: SubscriptionQuotaAlertDeliveryStatus::Pending,
            created_at: "2026-08-04 00:00:01".into(),
            updated_at: "2026-08-04 00:00:01".into(),
        };
        commit_subscription_quota_alert_evaluation(&fixture.db, &[], Some(&event))
            .expect("insert event");

        let business = claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Business,
            Some("account-1"),
            "2026-08-04 00:00:02",
            "lease-business",
            "2026-08-04 00:01:02",
        )
        .expect("claim business")
        .expect("business due");
        assert_eq!(business.attempt, 1);
        assert!(claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Business,
            Some("account-1"),
            "2026-08-04 00:00:03",
            "lease-duplicate",
            "2026-08-04 00:01:03",
        )
        .expect("concurrent claim")
        .is_none());
        assert!(mark_subscription_quota_alert_channel_sent(
            &fixture.db,
            "event-1",
            SubscriptionQuotaAlertChannel::Business,
            "lease-business",
            "2026-08-04 00:00:04",
        )
        .expect("mark business sent"));

        let _windows = claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Windows,
            None,
            "2026-08-04 00:00:05",
            "lease-windows",
            "2026-08-04 00:01:05",
        )
        .expect("claim windows")
        .expect("windows due");
        assert!(mark_subscription_quota_alert_channel_sent(
            &fixture.db,
            "event-1",
            SubscriptionQuotaAlertChannel::Windows,
            "lease-windows",
            "2026-08-04 00:00:06",
        )
        .expect("mark windows sent"));

        let stored = find_subscription_quota_alert_event(&fixture.db, "event-1")
            .expect("read event")
            .expect("event exists");
        assert_eq!(
            stored.business_status,
            SubscriptionQuotaAlertDeliveryStatus::Sent
        );
        assert_eq!(
            stored.windows_status,
            SubscriptionQuotaAlertDeliveryStatus::Sent
        );
        assert_eq!(stored.completed_at.as_deref(), Some("2026-08-04 00:00:06"));
    }
}
