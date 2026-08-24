use std::collections::HashMap;

use anyhow::{bail, Context, Result};

use crate::contracts::{
    SubscriptionQuotaAlertConfig, SubscriptionQuotaAlertEventPayload, SubscriptionQuotaAlertRule,
    SubscriptionQuotaAlertSettingsPayload, SubscriptionQuotaAlertThresholdMode,
    SubscriptionQuotaAlertTriggeredWindow, SubscriptionQuotaAlertUpsertInput,
    SubscriptionQuotaAlertWindowKind, SubscriptionQuotaWindow, SubscriptionRecord,
};
use crate::infrastructure::datetime::now_storage_timestamp;
use crate::infrastructure::sqlite::repositories::{
    self, NewSubscriptionQuotaAlertEvent, SubscriptionQuotaAlertDeliveryStatus,
    SubscriptionQuotaAlertSubjectInput, SubscriptionQuotaAlertWindowState,
    SubscriptionQuotaAlertWindowStateRecord,
};

use super::AppContext;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubscriptionQuotaAlertEvaluationReport {
    pub event_ids: Vec<String>,
    pub skipped_ambiguous_subscription_keys: Vec<String>,
}

/// 读取账号的稀疏 override；未配置订阅由 defaultRule 提供权威 98% 规则。
pub async fn query_subscription_quota_alerts(
    ctx: &AppContext,
    account_id: &str,
) -> Result<SubscriptionQuotaAlertSettingsPayload> {
    let overrides = repositories::list_subscription_quota_alert_configs(&ctx.db, account_id)?
        .into_iter()
        .map(|(subscription_key, rule)| SubscriptionQuotaAlertConfig {
            subscription_key,
            rule,
        })
        .collect();
    Ok(SubscriptionQuotaAlertSettingsPayload {
        default_rule: repositories::default_subscription_quota_alert_rule(),
        overrides,
    })
}

/// 在已取得的账号订阅快照中校验归属并保存配置，不会自行再次读取 subscriptions。
pub(crate) async fn upsert_subscription_quota_alert_with_snapshot(
    ctx: &AppContext,
    account_id: &str,
    payload: SubscriptionQuotaAlertUpsertInput,
    subscriptions: &[SubscriptionRecord],
) -> Result<SubscriptionQuotaAlertConfig> {
    validate_rule_input(
        payload.enabled,
        &payload.threshold_mode,
        payload.threshold_value,
    )?;
    let _gate = ctx
        .live_resources
        .acquire_subscription_quota_alert_account_gate(account_id)
        .await;
    let subscription = subscriptions
        .iter()
        .find(|subscription| subscription.subscription_key == payload.subscription_key)
        .context("当前账号不存在对应订阅，无法保存额度提醒配置。")?;
    if subscription.identity_ambiguous {
        bail!("当前订阅缺少可唯一识别的稳定身份，无法保存独立额度提醒配置。");
    }
    let now = now_storage_timestamp();
    let subject = repositories::resolve_subscription_quota_alert_subject(
        &ctx.db,
        &subject_input(account_id, subscription),
        &now,
    )?;
    let saved = repositories::upsert_subscription_quota_alert_config(
        &ctx.db,
        &subject.subject_id,
        payload.enabled,
        &payload.threshold_mode,
        payload.threshold_value,
        &now,
    )?;
    Ok(SubscriptionQuotaAlertConfig {
        subscription_key: subject.subscription_key,
        rule: saved.rule,
    })
}

/// 对同一份完整订阅快照执行三窗口状态机；只持久化事件，不依赖 AppHandle。
pub async fn evaluate_subscription_quota_alerts(
    ctx: &AppContext,
    account_id: &str,
    subscriptions: &[SubscriptionRecord],
    system_notifications_supported: bool,
) -> Result<SubscriptionQuotaAlertEvaluationReport> {
    let _gate = ctx
        .live_resources
        .acquire_subscription_quota_alert_account_gate(account_id)
        .await;
    if !repositories::subscription_quota_alerts_enabled(&ctx.db, account_id)?.unwrap_or(false) {
        return Ok(SubscriptionQuotaAlertEvaluationReport::default());
    }
    evaluate_under_gate(
        ctx,
        account_id,
        subscriptions,
        system_notifications_supported,
    )
}

fn evaluate_under_gate(
    ctx: &AppContext,
    account_id: &str,
    subscriptions: &[SubscriptionRecord],
    system_notifications_supported: bool,
) -> Result<SubscriptionQuotaAlertEvaluationReport> {
    let now = now_storage_timestamp();
    let mut report = SubscriptionQuotaAlertEvaluationReport::default();
    for subscription in subscriptions {
        if subscription.identity_ambiguous {
            log::warn!(
                "[subscription-quota-alert] 账号 {account_id} 的订阅身份 {} 存在歧义，已跳过状态写入",
                subscription.subscription_key
            );
            report
                .skipped_ambiguous_subscription_keys
                .push(subscription.subscription_key.clone());
            continue;
        }
        let subject = repositories::resolve_subscription_quota_alert_subject(
            &ctx.db,
            &subject_input(account_id, subscription),
            &now,
        )?;
        let rule =
            repositories::find_subscription_quota_alert_config(&ctx.db, &subject.subject_id)?
                .map(|record| record.rule)
                .unwrap_or_else(repositories::default_subscription_quota_alert_rule);
        if !rule.enabled {
            continue;
        }
        let existing = repositories::list_subscription_quota_alert_window_states(
            &ctx.db,
            &subject.subject_id,
        )?
        .into_iter()
        .map(|state| (state.window_kind, state))
        .collect::<HashMap<_, _>>();

        let mut evaluations = Vec::new();
        for (kind, window) in [
            (
                SubscriptionQuotaAlertWindowKind::Daily,
                subscription.daily.as_ref(),
            ),
            (
                SubscriptionQuotaAlertWindowKind::Weekly,
                subscription.weekly.as_ref(),
            ),
            (
                SubscriptionQuotaAlertWindowKind::Monthly,
                subscription.monthly.as_ref(),
            ),
        ] {
            if let Some(evaluation) = evaluate_window(
                &subject.subject_id,
                kind,
                window,
                existing.get(&kind),
                &rule,
                &now,
            ) {
                evaluations.push(evaluation);
            }
        }

        let newly_triggered = evaluations
            .iter()
            .filter_map(|evaluation| evaluation.triggered_window.clone())
            .collect::<Vec<_>>();
        let event = if newly_triggered.is_empty() {
            None
        } else {
            let event_id = uuid::Uuid::new_v4().to_string();
            for evaluation in evaluations.iter_mut().filter(|item| item.newly_triggered) {
                evaluation.state.last_event_id = Some(event_id.clone());
            }
            let dedupe_key = format!("subscription-quota:{event_id}");
            let payload = SubscriptionQuotaAlertEventPayload {
                id: event_id.clone(),
                dedupe_key: dedupe_key.clone(),
                account_id: account_id.to_string(),
                subscription_key: subject.subscription_key.clone(),
                subscription_name: subscription.name.clone(),
                threshold_mode: rule.threshold_mode.clone(),
                threshold_value: rule.threshold_value,
                config_revision: rule.revision,
                triggered_windows: newly_triggered.clone(),
                created_at: now.clone(),
            };
            report.event_ids.push(event_id.clone());
            Some(NewSubscriptionQuotaAlertEvent {
                id: event_id,
                subject_id: subject.subject_id.clone(),
                dedupe_key,
                config_revision: rule.revision,
                triggered_windows_json: serde_json::to_string(&newly_triggered)
                    .context("无法序列化订阅额度触发窗口")?,
                payload_json: serde_json::to_string(&payload)
                    .context("无法序列化订阅额度提醒事件")?,
                business_status: SubscriptionQuotaAlertDeliveryStatus::Pending,
                windows_status: if system_notifications_supported {
                    SubscriptionQuotaAlertDeliveryStatus::Pending
                } else {
                    SubscriptionQuotaAlertDeliveryStatus::Unsupported
                },
                created_at: now.clone(),
                updated_at: now.clone(),
            })
        };
        let states = evaluations
            .into_iter()
            .map(|evaluation| evaluation.state)
            .collect::<Vec<_>>();
        repositories::commit_subscription_quota_alert_evaluation(&ctx.db, &states, event.as_ref())?;
    }
    Ok(report)
}

struct WindowEvaluation {
    state: SubscriptionQuotaAlertWindowStateRecord,
    newly_triggered: bool,
    triggered_window: Option<SubscriptionQuotaAlertTriggeredWindow>,
}

fn evaluate_window(
    subject_id: &str,
    kind: SubscriptionQuotaAlertWindowKind,
    window: Option<&SubscriptionQuotaWindow>,
    existing: Option<&SubscriptionQuotaAlertWindowStateRecord>,
    rule: &SubscriptionQuotaAlertRule,
    now: &str,
) -> Option<WindowEvaluation> {
    let window = window?;
    let (reached, limit, usage_percent) = match rule.threshold_mode {
        SubscriptionQuotaAlertThresholdMode::UsagePercent => {
            if !window.current.is_finite() || !window.limit.is_finite() || window.limit <= 0.0 {
                return None;
            }
            let usage_percent = (window.current / window.limit) * 100.0;
            if !usage_percent.is_finite() {
                return None;
            }
            (
                usage_percent >= rule.threshold_value,
                Some(window.limit),
                Some(usage_percent),
            )
        }
        SubscriptionQuotaAlertThresholdMode::AmountUsd => {
            if !window.current.is_finite() {
                return None;
            }
            let limit = window.limit.is_finite().then_some(window.limit);
            let usage_percent = limit
                .filter(|limit| *limit > 0.0)
                .map(|limit| (window.current / limit) * 100.0)
                .filter(|value| value.is_finite());
            (window.current >= rule.threshold_value, limit, usage_percent)
        }
    };
    let observed_period = window
        .window_start
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let config_changed = existing.is_none_or(|state| state.config_revision != rule.revision);
    let period_changed = observed_period.as_ref().is_some_and(|period| {
        existing
            .and_then(|state| state.period_key.as_ref())
            .is_none_or(|previous| previous != period)
    });
    let was_armed =
        existing.is_none_or(|state| state.state == SubscriptionQuotaAlertWindowState::Armed);
    let newly_triggered = reached && (config_changed || period_changed || was_armed);
    let trigger_sequence =
        existing.map_or(0, |state| state.trigger_sequence) + i64::from(newly_triggered);
    let state = if reached {
        SubscriptionQuotaAlertWindowState::Triggered
    } else {
        SubscriptionQuotaAlertWindowState::Armed
    };
    let period_key =
        observed_period.or_else(|| existing.and_then(|state| state.period_key.clone()));
    Some(WindowEvaluation {
        state: SubscriptionQuotaAlertWindowStateRecord {
            subject_id: subject_id.to_string(),
            window_kind: kind,
            config_revision: rule.revision,
            period_key,
            state,
            trigger_sequence,
            last_current: Some(window.current),
            last_limit: limit,
            last_event_id: existing.and_then(|state| state.last_event_id.clone()),
            last_evaluated_at: now.to_string(),
            updated_at: now.to_string(),
        },
        newly_triggered,
        triggered_window: newly_triggered.then(|| SubscriptionQuotaAlertTriggeredWindow {
            kind,
            current: window.current,
            limit,
            window_start: window.window_start.clone(),
            usage_percent,
        }),
    })
}

fn subject_input(
    account_id: &str,
    subscription: &SubscriptionRecord,
) -> SubscriptionQuotaAlertSubjectInput {
    SubscriptionQuotaAlertSubjectInput {
        account_id: account_id.to_string(),
        subscription_key: subscription.subscription_key.clone(),
        identity_kind: subscription.identity_kind.clone(),
        group_id: subscription.group_id,
        upstream_subscription_id: subscription.upstream_subscription_id.clone(),
        fallback_identity: Some(subscription.fallback_identity.clone()),
        name_snapshot: subscription.name.clone(),
        platform_snapshot: subscription.platform.clone(),
    }
}

fn validate_rule_input(
    _enabled: bool,
    mode: &SubscriptionQuotaAlertThresholdMode,
    threshold_value: f64,
) -> Result<()> {
    if !threshold_value.is_finite() || threshold_value <= 0.0 {
        bail!("订阅额度提醒阈值必须是大于 0 的有限数字。");
    }
    if matches!(mode, SubscriptionQuotaAlertThresholdMode::UsagePercent) && threshold_value > 100.0
    {
        bail!("订阅额度百分比提醒阈值不能超过 100%。");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::Mutex;

    use super::*;
    use crate::application::context::SyncTaskHandle;
    use crate::application::resource_coordinator::ResourceCoordinator;
    use crate::application::subscription_snapshot_service::merge_subscription_summary_daily_windows;
    use crate::contracts::{
        AccountRecord, SiteRecord, SubscriptionSummaryPayload, SubscriptionSummaryRecord,
    };
    use crate::infrastructure::files::AppPaths;
    use crate::infrastructure::sqlite::Database;

    struct TestContext {
        ctx: AppContext,
        root: std::path::PathBuf,
    }

    impl Drop for TestContext {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn build_context() -> TestContext {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("tmp")
            .join(format!(
                "subscription-quota-alert-service-{}",
                uuid::Uuid::new_v4()
            ));
        let paths = AppPaths::from_root(root.clone());
        paths.ensure().expect("ensure test paths");
        let db = Database::new(paths.db_path.clone());
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
        TestContext {
            ctx: AppContext {
                runtime_coordination: crate::application::runtime_coordination_service::RuntimeCoordinationService::from_paths_for_test(&paths)
                    .expect("initialize test runtime coordination"),
                paths,
                db,
                sync_tasks: Arc::new(Mutex::new(HashMap::<String, Arc<SyncTaskHandle>>::new())),
                live_resources: ResourceCoordinator::default(),
                native_notifications_enabled: false,
            },
            root,
        }
    }

    fn window(current: f64, limit: f64, start: &str) -> SubscriptionQuotaWindow {
        SubscriptionQuotaWindow {
            current,
            limit,
            window_start: Some(start.into()),
        }
    }

    fn subscription(
        daily: Option<SubscriptionQuotaWindow>,
        weekly: Option<SubscriptionQuotaWindow>,
        monthly: Option<SubscriptionQuotaWindow>,
    ) -> SubscriptionRecord {
        SubscriptionRecord {
            id: "subscription-1".into(),
            subscription_key: "group:42".into(),
            identity_kind: crate::contracts::SubscriptionIdentityKind::Group,
            identity_ambiguous: false,
            upstream_subscription_id: Some("subscription-1".into()),
            fallback_identity: "fallback:v1:openai|main|pro".into(),
            group_id: Some(42),
            name: "Pro".into(),
            status: "active".into(),
            group_name: Some("Main".into()),
            platform: Some("openai".into()),
            expires_at: None,
            daily,
            weekly,
            monthly,
        }
    }

    #[tokio::test]
    async fn default_rule_triggers_at_exactly_98_and_suppresses_continuous_high() {
        let fixture = build_context();
        let subscriptions = vec![subscription(
            Some(window(98.0, 100.0, "2026-08-04")),
            None,
            None,
        )];

        let first =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true)
                .await
                .expect("evaluate first high");
        assert_eq!(first.event_ids.len(), 1);
        let repeated =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true)
                .await
                .expect("evaluate repeated high");
        assert!(repeated.event_ids.is_empty());
    }

    #[tokio::test]
    async fn summary_daily_window_triggers_saved_59_percent_rule_when_raw_window_is_missing() {
        let fixture = build_context();
        let raw_subscriptions = vec![subscription(None, None, None)];
        let saved = upsert_subscription_quota_alert_with_snapshot(
            &fixture.ctx,
            "account-1",
            SubscriptionQuotaAlertUpsertInput {
                subscription_key: "group:42".into(),
                enabled: true,
                threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
                threshold_value: 59.0,
            },
            &raw_subscriptions,
        )
        .await
        .expect("save 59 percent rule");
        assert_eq!(saved.rule.revision, 1);

        let summary = SubscriptionSummaryPayload {
            active_count: 1,
            total_used_usd: 295.79,
            subscriptions: vec![SubscriptionSummaryRecord {
                id: 42,
                group_id: 42,
                group_name: "Main".into(),
                status: "active".into(),
                daily_used_usd: 295.79,
                daily_limit_usd: 500.0,
                weekly_used_usd: 0.0,
                monthly_used_usd: 0.0,
                expires_at: None,
            }],
        };
        let alert_subscriptions =
            merge_subscription_summary_daily_windows(&raw_subscriptions, &summary);

        let report = evaluate_subscription_quota_alerts(
            &fixture.ctx,
            "account-1",
            &alert_subscriptions,
            true,
        )
        .await
        .expect("evaluate summary daily window");
        assert_eq!(report.event_ids.len(), 1);

        let event = repositories::find_subscription_quota_alert_event(
            &fixture.ctx.db,
            &report.event_ids[0],
        )
        .expect("read event")
        .expect("event exists");
        let payload =
            serde_json::from_str::<SubscriptionQuotaAlertEventPayload>(&event.payload_json)
                .expect("parse event payload");
        assert_eq!(payload.triggered_windows.len(), 1);
        assert_eq!(
            payload.triggered_windows[0].kind,
            SubscriptionQuotaAlertWindowKind::Daily
        );
        assert!(
            (payload.triggered_windows[0]
                .usage_percent
                .expect("daily percentage")
                - 59.158)
                .abs()
                < 0.001
        );
    }

    #[tokio::test]
    async fn three_high_windows_merge_into_one_event_in_fixed_order() {
        let fixture = build_context();
        let subscriptions = vec![subscription(
            Some(window(98.0, 100.0, "daily")),
            Some(window(49.0, 50.0, "weekly")),
            Some(window(196.0, 200.0, "monthly")),
        )];

        let report =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true)
                .await
                .expect("evaluate windows");
        assert_eq!(report.event_ids.len(), 1);
        let event = repositories::find_subscription_quota_alert_event(
            &fixture.ctx.db,
            &report.event_ids[0],
        )
        .expect("read event")
        .expect("event exists");
        let payload =
            serde_json::from_str::<SubscriptionQuotaAlertEventPayload>(&event.payload_json)
                .expect("parse event payload");
        assert_eq!(
            payload
                .triggered_windows
                .iter()
                .map(|window| window.kind)
                .collect::<Vec<_>>(),
            [
                SubscriptionQuotaAlertWindowKind::Daily,
                SubscriptionQuotaAlertWindowKind::Weekly,
                SubscriptionQuotaAlertWindowKind::Monthly,
            ]
        );
    }

    #[tokio::test]
    async fn below_threshold_and_new_period_rearm_triggered_window() {
        let fixture = build_context();
        let high = vec![subscription(
            Some(window(99.0, 100.0, "period-1")),
            None,
            None,
        )];
        assert_eq!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &high, true)
                .await
                .expect("first high")
                .event_ids
                .len(),
            1
        );
        let below = vec![subscription(
            Some(window(97.0, 100.0, "period-1")),
            None,
            None,
        )];
        assert!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &below, true)
                .await
                .expect("rearm below")
                .event_ids
                .is_empty()
        );
        assert_eq!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &high, true)
                .await
                .expect("second high")
                .event_ids
                .len(),
            1
        );
        let next_period = vec![subscription(
            Some(window(99.0, 100.0, "period-2")),
            None,
            None,
        )];
        assert_eq!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &next_period, true,)
                .await
                .expect("new period high")
                .event_ids
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn config_revision_re_evaluates_current_snapshot_but_identical_save_does_not() {
        let fixture = build_context();
        let subscriptions = vec![subscription(
            Some(window(60.0, 100.0, "period-1")),
            None,
            None,
        )];
        assert!(evaluate_subscription_quota_alerts(
            &fixture.ctx,
            "account-1",
            &subscriptions,
            true,
        )
        .await
        .expect("default below")
        .event_ids
        .is_empty());
        let input = SubscriptionQuotaAlertUpsertInput {
            subscription_key: "group:42".into(),
            enabled: true,
            threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
            threshold_value: 50.0,
        };
        let first = upsert_subscription_quota_alert_with_snapshot(
            &fixture.ctx,
            "account-1",
            input.clone(),
            &subscriptions,
        )
        .await
        .expect("save changed config");
        assert_eq!(first.rule.revision, 1);
        assert_eq!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true,)
                .await
                .expect("evaluate changed config")
                .event_ids
                .len(),
            1
        );
        let repeated = upsert_subscription_quota_alert_with_snapshot(
            &fixture.ctx,
            "account-1",
            input,
            &subscriptions,
        )
        .await
        .expect("repeat config");
        assert_eq!(repeated.rule.revision, 1);
        assert!(evaluate_subscription_quota_alerts(
            &fixture.ctx,
            "account-1",
            &subscriptions,
            true,
        )
        .await
        .expect("evaluate identical config")
        .event_ids
        .is_empty());
    }

    #[tokio::test]
    async fn ambiguous_identity_is_skipped_without_materializing_state() {
        let fixture = build_context();
        let mut ambiguous = subscription(Some(window(100.0, 100.0, "period-1")), None, None);
        ambiguous.identity_ambiguous = true;
        let report =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &[ambiguous], true)
                .await
                .expect("skip ambiguous");
        assert!(report.event_ids.is_empty());
        assert_eq!(report.skipped_ambiguous_subscription_keys, ["group:42"]);
        assert!(repositories::find_subscription_quota_alert_subject_by_key(
            &fixture.ctx.db,
            "account-1",
            "group:42",
        )
        .expect("read subject")
        .is_none());
    }

    #[tokio::test]
    async fn account_level_preference_blocks_evaluation_and_reenable_preserves_subscription_rule() {
        let fixture = build_context();
        let subscriptions = vec![subscription(
            Some(window(95.0, 100.0, "period-1")),
            None,
            None,
        )];
        let saved = upsert_subscription_quota_alert_with_snapshot(
            &fixture.ctx,
            "account-1",
            SubscriptionQuotaAlertUpsertInput {
                subscription_key: "group:42".into(),
                enabled: true,
                threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
                threshold_value: 90.0,
            },
            &subscriptions,
        )
        .await
        .expect("save per-subscription rule");
        let subject = repositories::find_subscription_quota_alert_subject_by_key(
            &fixture.ctx.db,
            "account-1",
            "group:42",
        )
        .expect("find subject")
        .expect("subject exists");

        let mut account = repositories::find_account(&fixture.ctx.db, "account-1")
            .expect("find account")
            .expect("account exists");
        account.updated_at = "2026-08-19 00:00:00".into();
        assert_eq!(
            repositories::update_account_with_alert_preferences(&fixture.ctx.db, &account, false)
                .expect("disable account-level alerts"),
            repositories::SubscriptionQuotaAlertPreferenceTransition::Disabled
        );
        assert!(evaluate_subscription_quota_alerts(
            &fixture.ctx,
            "account-1",
            &subscriptions,
            true,
        )
        .await
        .expect("evaluate disabled account")
        .event_ids
        .is_empty());
        assert!(repositories::list_subscription_quota_alert_window_states(
            &fixture.ctx.db,
            &subject.subject_id,
        )
        .expect("read no states")
        .is_empty());
        assert_eq!(
            repositories::find_subscription_quota_alert_config(
                &fixture.ctx.db,
                &subject.subject_id
            )
            .expect("read preserved config")
            .expect("config exists")
            .rule,
            saved.rule
        );

        account.updated_at = "2026-08-19 00:00:01".into();
        assert_eq!(
            repositories::update_account_with_alert_preferences(&fixture.ctx.db, &account, true)
                .expect("reenable account-level alerts"),
            repositories::SubscriptionQuotaAlertPreferenceTransition::Enabled
        );
        assert_eq!(
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true)
                .await
                .expect("evaluate reenabled account")
                .event_ids
                .len(),
            1
        );
        assert!(evaluate_subscription_quota_alerts(
            &fixture.ctx,
            "account-1",
            &subscriptions,
            true,
        )
        .await
        .expect("evaluate continuous high usage")
        .event_ids
        .is_empty());
    }

    #[tokio::test]
    async fn concurrent_evaluators_create_only_one_event() {
        let fixture = build_context();
        let subscriptions = vec![subscription(
            Some(window(100.0, 100.0, "period-1")),
            None,
            None,
        )];
        let left =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true);
        let right =
            evaluate_subscription_quota_alerts(&fixture.ctx, "account-1", &subscriptions, true);
        let (left, right) = tokio::join!(left, right);
        let event_count = left.expect("left evaluator").event_ids.len()
            + right.expect("right evaluator").event_ids.len();
        assert_eq!(event_count, 1);
    }
}
