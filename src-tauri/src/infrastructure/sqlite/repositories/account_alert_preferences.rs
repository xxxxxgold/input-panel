use anyhow::Result;
use rusqlite::{params, OptionalExtension, Transaction};

use crate::contracts::AccountRecord;
use crate::infrastructure::sqlite::Database;

/// 账号级订阅额度提醒总开关在一次保存中的状态变化。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionQuotaAlertPreferenceTransition {
    Unchanged,
    Disabled,
    Enabled,
}

/// 同一条查询中读取余额哨兵和额度总开关，避免并发保存时观察到混合状态。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccountAlertPreferencesSnapshot {
    pub balance_warning: f64,
    pub subscription_quota_alerts_enabled: bool,
}

/// 返回账号提醒偏好的单一 SQLite 快照；旧账号缺少偏好行时仍默认开启订阅额度提醒。
pub fn find_account_alert_preferences(
    db: &Database,
    account_id: &str,
) -> Result<Option<AccountAlertPreferencesSnapshot>> {
    let conn = db.connect()?;
    conn.query_row(
        "SELECT accounts.balance_warning,
                COALESCE(account_alert_preferences.subscription_quota_alerts_enabled, 1)
         FROM accounts
         LEFT JOIN account_alert_preferences
           ON account_alert_preferences.account_id = accounts.id
         WHERE accounts.id = ?1",
        params![account_id],
        |row| {
            Ok(AccountAlertPreferencesSnapshot {
                balance_warning: row.get(0)?,
                subscription_quota_alerts_enabled: row.get::<_, i64>(1)? != 0,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// 读取账号级订阅额度提醒的有效值；旧账号缺少偏好行时默认启用。
pub fn subscription_quota_alerts_enabled(db: &Database, account_id: &str) -> Result<Option<bool>> {
    Ok(find_account_alert_preferences(db, account_id)?
        .map(|preferences| preferences.subscription_quota_alerts_enabled))
}

/// 创建账号和提醒偏好必须同一事务提交，避免新账号出现半配置状态。
pub fn insert_account_with_alert_preferences(
    db: &Database,
    account: &AccountRecord,
    subscription_quota_alerts_enabled: bool,
) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute(
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
            account.updated_at,
        ],
    )?;
    upsert_preferences(
        &tx,
        &account.id,
        subscription_quota_alerts_enabled,
        &account.updated_at,
    )?;
    tx.commit()?;
    Ok(())
}

/// 原子更新账号字段、账号级偏好和相关额度提醒队列状态。
pub fn update_account_with_alert_preferences(
    db: &Database,
    account: &AccountRecord,
    subscription_quota_alerts_enabled: bool,
) -> Result<SubscriptionQuotaAlertPreferenceTransition> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let previous_enabled = subscription_quota_alerts_enabled_in_transaction(&tx, &account.id)?;

    tx.execute(
        "UPDATE accounts
         SET site_id = ?2, label = ?3, email = ?4, balance_warning = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            account.id,
            account.site_id,
            account.label,
            account.email,
            account.balance_warning,
            account.updated_at,
        ],
    )?;
    upsert_preferences(
        &tx,
        &account.id,
        subscription_quota_alerts_enabled,
        &account.updated_at,
    )?;

    let transition = match (previous_enabled, subscription_quota_alerts_enabled) {
        (true, false) => SubscriptionQuotaAlertPreferenceTransition::Disabled,
        (false, true) => SubscriptionQuotaAlertPreferenceTransition::Enabled,
        _ => SubscriptionQuotaAlertPreferenceTransition::Unchanged,
    };
    if !matches!(
        transition,
        SubscriptionQuotaAlertPreferenceTransition::Unchanged
    ) {
        clear_subscription_quota_alert_window_states(&tx, &account.id)?;
    }
    if matches!(
        transition,
        SubscriptionQuotaAlertPreferenceTransition::Disabled
    ) {
        terminate_pending_subscription_quota_alert_channels(&tx, &account.id, &account.updated_at)?;
    }

    tx.commit()?;
    Ok(transition)
}

fn subscription_quota_alerts_enabled_in_transaction(
    tx: &Transaction<'_>,
    account_id: &str,
) -> Result<bool> {
    let value = tx
        .query_row(
            "SELECT subscription_quota_alerts_enabled
             FROM account_alert_preferences
             WHERE account_id = ?1",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(value.map_or(true, |enabled| enabled != 0))
}

fn upsert_preferences(
    tx: &Transaction<'_>,
    account_id: &str,
    subscription_quota_alerts_enabled: bool,
    updated_at: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO account_alert_preferences (
            account_id, subscription_quota_alerts_enabled, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(account_id) DO UPDATE SET
            subscription_quota_alerts_enabled = excluded.subscription_quota_alerts_enabled,
            updated_at = excluded.updated_at",
        params![
            account_id,
            if subscription_quota_alerts_enabled {
                1_i64
            } else {
                0_i64
            },
            updated_at,
        ],
    )?;
    Ok(())
}

fn clear_subscription_quota_alert_window_states(
    tx: &Transaction<'_>,
    account_id: &str,
) -> Result<()> {
    tx.execute(
        "DELETE FROM subscription_quota_alert_window_states
         WHERE subject_id IN (
            SELECT subject_id
            FROM subscription_quota_alert_subjects
            WHERE account_id = ?1
         )",
        params![account_id],
    )?;
    Ok(())
}

fn terminate_pending_subscription_quota_alert_channels(
    tx: &Transaction<'_>,
    account_id: &str,
    updated_at: &str,
) -> Result<()> {
    tx.execute(
        "UPDATE subscription_quota_alert_events
         SET business_status = CASE
                WHEN business_status IN ('pending', 'delivering') THEN 'unsupported'
                ELSE business_status
             END,
             windows_status = CASE
                WHEN windows_status IN ('pending', 'delivering') THEN 'unsupported'
                ELSE windows_status
             END,
             business_next_attempt_at = NULL,
             windows_next_attempt_at = NULL,
             business_lease_id = NULL,
             windows_lease_id = NULL,
             business_lease_until = NULL,
             windows_lease_until = NULL,
             business_last_error = NULL,
             windows_last_error = NULL,
             updated_at = ?1
         WHERE completed_at IS NULL
           AND subject_id IN (
             SELECT subject_id
             FROM subscription_quota_alert_subjects
             WHERE account_id = ?2
           )",
        params![updated_at, account_id],
    )?;
    tx.execute(
        "UPDATE subscription_quota_alert_events
         SET completed_at = COALESCE(completed_at, ?1), updated_at = ?1
         WHERE completed_at IS NULL
           AND business_status IN ('sent', 'unsupported')
           AND windows_status IN ('sent', 'unsupported')
           AND subject_id IN (
             SELECT subject_id
             FROM subscription_quota_alert_subjects
             WHERE account_id = ?2
           )",
        params![updated_at, account_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        AccountRecord, SiteRecord, SubscriptionIdentityKind, SubscriptionQuotaAlertThresholdMode,
        SubscriptionQuotaAlertWindowKind,
    };
    use crate::infrastructure::sqlite::repositories::{
        self, NewSubscriptionQuotaAlertEvent, SubscriptionQuotaAlertChannel,
        SubscriptionQuotaAlertDeliveryStatus, SubscriptionQuotaAlertSubjectInput,
        SubscriptionQuotaAlertWindowState, SubscriptionQuotaAlertWindowStateRecord,
    };

    struct TestDatabase {
        db: Database,
        path: std::path::PathBuf,
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            // 先释放连接池中的 SQLite 句柄，Windows 才能删除测试数据库文件。
            let _ = self.db.invalidate_pool();
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
            "account-alert-preferences-repository-{}.db",
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
                created_at: "2026-08-19 00:00:00".into(),
                updated_at: "2026-08-19 00:00:00".into(),
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
                email: "alerts@example.test".into(),
                balance_warning: -1.0,
                last_login_at: None,
                created_at: "2026-08-19 00:00:00".into(),
                updated_at: "2026-08-19 00:00:00".into(),
            },
        )
        .expect("insert legacy account");
        TestDatabase { db, path }
    }

    fn subject_input() -> SubscriptionQuotaAlertSubjectInput {
        SubscriptionQuotaAlertSubjectInput {
            account_id: "account-1".into(),
            subscription_key: "group:42".into(),
            identity_kind: SubscriptionIdentityKind::Group,
            group_id: Some(42),
            upstream_subscription_id: Some("subscription-1".into()),
            fallback_identity: Some("fallback:v1:openai|main|pro".into()),
            name_snapshot: "Pro".into(),
            platform_snapshot: Some("openai".into()),
        }
    }

    fn pending_event(id: &str, subject_id: &str) -> NewSubscriptionQuotaAlertEvent {
        NewSubscriptionQuotaAlertEvent {
            id: id.into(),
            subject_id: subject_id.into(),
            dedupe_key: format!("subscription-quota:{id}"),
            config_revision: 1,
            triggered_windows_json: "[]".into(),
            payload_json: format!(r#"{{"id":"{id}"}}"#),
            business_status: SubscriptionQuotaAlertDeliveryStatus::Pending,
            windows_status: SubscriptionQuotaAlertDeliveryStatus::Pending,
            created_at: "2026-08-19 00:00:01".into(),
            updated_at: "2026-08-19 00:00:01".into(),
        }
    }

    fn disable_alerts(fixture: &TestDatabase) -> SubscriptionQuotaAlertPreferenceTransition {
        let mut account = repositories::find_account(&fixture.db, "account-1")
            .expect("find account")
            .expect("account exists");
        account.updated_at = "2026-08-19 00:00:10".into();
        update_account_with_alert_preferences(&fixture.db, &account, false)
            .expect("disable subscription quota alerts")
    }

    #[test]
    fn legacy_account_without_preference_row_defaults_to_enabled() {
        let fixture = build_test_db();

        let preferences = find_account_alert_preferences(&fixture.db, "account-1")
            .expect("read legacy preference")
            .expect("legacy account exists");
        assert_eq!(preferences.balance_warning, -1.0);
        assert!(preferences.subscription_quota_alerts_enabled);
        assert_eq!(
            subscription_quota_alerts_enabled(&fixture.db, "account-1")
                .expect("read default preference"),
            Some(true)
        );
    }

    #[test]
    fn deleted_account_has_no_effective_alert_preference() {
        let fixture = build_test_db();

        repositories::delete_account(&fixture.db, "account-1").expect("delete account");

        assert!(find_account_alert_preferences(&fixture.db, "account-1")
            .expect("read deleted account")
            .is_none());
        assert_eq!(
            subscription_quota_alerts_enabled(&fixture.db, "account-1")
                .expect("read deleted preference"),
            None
        );
    }

    #[test]
    fn updating_alert_preferences_preserves_a_newer_login_timestamp() {
        let fixture = build_test_db();
        let mut stale_account = repositories::find_account(&fixture.db, "account-1")
            .expect("find account")
            .expect("account exists");
        stale_account.balance_warning = 3.0;
        stale_account.updated_at = "2026-08-19 00:00:10".into();

        repositories::touch_account_last_login(
            &fixture.db,
            "account-1",
            "2026-08-19 00:00:05",
            "2026-08-19 00:00:05",
        )
        .expect("record login timestamp");
        update_account_with_alert_preferences(&fixture.db, &stale_account, false)
            .expect("save account alert preferences");

        let saved = repositories::find_account(&fixture.db, "account-1")
            .expect("find saved account")
            .expect("saved account exists");
        assert_eq!(saved.balance_warning, 3.0);
        assert_eq!(saved.last_login_at.as_deref(), Some("2026-08-19 00:00:05"));
    }

    #[test]
    fn test_database_cleanup_releases_sqlite_files() {
        let path = {
            let fixture = build_test_db();
            fixture.path.clone()
        };

        assert!(!path.exists(), "测试夹具退出后不应残留 SQLite 数据库");
        assert!(
            !path.with_extension("db-wal").exists(),
            "测试夹具退出后不应残留 SQLite WAL 文件"
        );
        assert!(
            !path.with_extension("db-shm").exists(),
            "测试夹具退出后不应残留 SQLite SHM 文件"
        );
    }

    #[test]
    fn disabling_alerts_terminates_unsent_channels_and_preserves_sent_history() {
        let fixture = build_test_db();
        let subject = repositories::resolve_subscription_quota_alert_subject(
            &fixture.db,
            &subject_input(),
            "2026-08-19 00:00:00",
        )
        .expect("resolve subject");
        let saved_rule = repositories::upsert_subscription_quota_alert_config(
            &fixture.db,
            &subject.subject_id,
            true,
            &SubscriptionQuotaAlertThresholdMode::UsagePercent,
            90.0,
            "2026-08-19 00:00:01",
        )
        .expect("save rule");
        let state = SubscriptionQuotaAlertWindowStateRecord {
            subject_id: subject.subject_id.clone(),
            window_kind: SubscriptionQuotaAlertWindowKind::Daily,
            config_revision: saved_rule.rule.revision,
            period_key: Some("2026-08-19".into()),
            state: SubscriptionQuotaAlertWindowState::Triggered,
            trigger_sequence: 1,
            last_current: Some(90.0),
            last_limit: Some(100.0),
            last_event_id: Some("event-pending".into()),
            last_evaluated_at: "2026-08-19 00:00:01".into(),
            updated_at: "2026-08-19 00:00:01".into(),
        };
        repositories::commit_subscription_quota_alert_evaluation(
            &fixture.db,
            &[state],
            Some(&pending_event("event-pending", &subject.subject_id)),
        )
        .expect("write pending event");
        repositories::commit_subscription_quota_alert_evaluation(
            &fixture.db,
            &[],
            Some(&pending_event("event-delivering", &subject.subject_id)),
        )
        .expect("write delivering event");

        let delivering = repositories::claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Business,
            Some("account-1"),
            "2026-08-19 00:00:02",
            "lease-delivering",
            "2026-08-19 00:01:02",
        )
        .expect("claim delivering event")
        .expect("business channel claimed");
        let sent_claim = repositories::claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Business,
            Some("account-1"),
            "2026-08-19 00:00:03",
            "lease-sent",
            "2026-08-19 00:01:03",
        )
        .expect("claim sent event")
        .expect("second business channel claimed");
        assert!(repositories::mark_subscription_quota_alert_channel_sent(
            &fixture.db,
            &sent_claim.event_id,
            SubscriptionQuotaAlertChannel::Business,
            "lease-sent",
            "2026-08-19 00:00:04",
        )
        .expect("mark delivery sent"));

        assert_eq!(
            disable_alerts(&fixture),
            SubscriptionQuotaAlertPreferenceTransition::Disabled
        );
        assert_eq!(
            subscription_quota_alerts_enabled(&fixture.db, "account-1")
                .expect("read disabled preference"),
            Some(false)
        );
        assert!(repositories::list_subscription_quota_alert_window_states(
            &fixture.db,
            &subject.subject_id,
        )
        .expect("read cleared window state")
        .is_empty());
        assert_eq!(
            repositories::find_subscription_quota_alert_config(&fixture.db, &subject.subject_id)
                .expect("read preserved config")
                .expect("config exists")
                .rule,
            saved_rule.rule
        );

        let pending =
            repositories::find_subscription_quota_alert_event(&fixture.db, &delivering.event_id)
                .expect("read delivering event")
                .expect("delivering event exists");
        assert_eq!(
            pending.business_status,
            SubscriptionQuotaAlertDeliveryStatus::Unsupported
        );
        assert_eq!(
            pending.windows_status,
            SubscriptionQuotaAlertDeliveryStatus::Unsupported
        );
        let sent =
            repositories::find_subscription_quota_alert_event(&fixture.db, &sent_claim.event_id)
                .expect("read sent event")
                .expect("sent event exists");
        assert_eq!(
            sent.business_status,
            SubscriptionQuotaAlertDeliveryStatus::Sent
        );
        assert_eq!(
            sent.windows_status,
            SubscriptionQuotaAlertDeliveryStatus::Unsupported
        );
        assert!(sent.completed_at.is_some());
        assert!(repositories::claim_due_subscription_quota_alert_channel(
            &fixture.db,
            SubscriptionQuotaAlertChannel::Windows,
            Some("account-1"),
            "2026-08-19 00:00:11",
            "lease-after-disable",
            "2026-08-19 00:01:11",
        )
        .expect("disabled account claim")
        .is_none());
    }
}
