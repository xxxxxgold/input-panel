use anyhow::Result;

use crate::contracts::{SubscriptionQuotaWindow, SubscriptionRecord, SubscriptionSummaryPayload};
use crate::infrastructure::sqlite::repositories;

use super::{
    data_center_service, resource_coordinator::LiveResourceKind, subscription_quota_alert_service,
    subscription_switch_service, upstream_service::UpstreamRequestPolicy, AppContext,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionSnapshotOrigin {
    Scheduler,
    PageRead,
    CoreSync,
    FullSync,
    ConfigSave,
    PostSwitch,
}

impl SubscriptionSnapshotOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scheduler => "scheduler",
            Self::PageRead => "page_read",
            Self::CoreSync => "core_sync",
            Self::FullSync => "full_sync",
            Self::ConfigSave => "config_save",
            Self::PostSwitch => "post_switch",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscriptionProcessingCapabilities {
    pub evaluate_quota_alerts: bool,
    pub evaluate_switch_rules: bool,
    /// 历史字段名保留以兼容现有额度事件列；桌面系统通知在 Windows 和 macOS 均可用。
    pub windows_notifications_supported: bool,
}

impl SubscriptionProcessingCapabilities {
    pub fn desktop(evaluate_switch_rules: bool) -> Self {
        Self {
            evaluate_quota_alerts: true,
            evaluate_switch_rules,
            windows_notifications_supported: cfg!(any(target_os = "windows", target_os = "macos")),
        }
    }

    pub fn headless(evaluate_switch_rules: bool) -> Self {
        Self {
            evaluate_quota_alerts: false,
            evaluate_switch_rules,
            windows_notifications_supported: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubscriptionSnapshotProcessingReport {
    pub quota_alert_event_ids: Vec<String>,
    pub quota_alert_error: Option<String>,
    pub switch_evaluation_count: usize,
    pub switch_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SubscriptionSnapshotOutcome {
    pub subscriptions: Vec<SubscriptionRecord>,
    pub processing: SubscriptionSnapshotProcessingReport,
}

/// 获取一份完整订阅快照，并把同一个 Vec 显式交给额度提醒和候补链消费者。
pub async fn refresh_and_process(
    ctx: &AppContext,
    account_id: &str,
    force: bool,
    policy: UpstreamRequestPolicy,
    origin: SubscriptionSnapshotOrigin,
    capabilities: SubscriptionProcessingCapabilities,
) -> Result<SubscriptionSnapshotOutcome> {
    let subscriptions = ctx
        .live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::Subscriptions,
            force,
            || async { data_center_service::fetch_subscriptions(ctx, account_id, policy).await },
        )
        .await?;
    let processing = process_successful_snapshot(
        ctx,
        account_id,
        &subscriptions,
        force,
        policy,
        origin,
        capabilities,
    )
    .await;
    Ok(SubscriptionSnapshotOutcome {
        subscriptions,
        processing,
    })
}

/// 处理调用方已经成功取得的 snapshot；消费者失败只进入 report 和日志。
pub async fn process_successful_snapshot(
    ctx: &AppContext,
    account_id: &str,
    subscriptions: &[SubscriptionRecord],
    force: bool,
    policy: UpstreamRequestPolicy,
    origin: SubscriptionSnapshotOrigin,
    capabilities: SubscriptionProcessingCapabilities,
) -> SubscriptionSnapshotProcessingReport {
    let mut report = SubscriptionSnapshotProcessingReport::default();
    let switch_rules_enabled = if capabilities.evaluate_switch_rules {
        match repositories::has_enabled_subscription_switch_rules(&ctx.db, account_id) {
            Ok(enabled) => enabled,
            Err(error) => {
                log::warn!(
                    "[subscription-snapshot] origin={} account={} switch rule lookup failed: {}",
                    origin.as_str(),
                    account_id,
                    error
                );
                report.switch_error = Some(error.to_string());
                false
            }
        }
    } else {
        false
    };
    // `/subscriptions` 可能不返回额度窗口，而 `/subscriptions/summary` 才包含每日真实用量。
    // 额度提醒与候补切换必须消费同一份补齐额度后的快照。
    let quota_aware_subscriptions = if capabilities.evaluate_quota_alerts || switch_rules_enabled {
        Some(build_quota_alert_subscriptions(ctx, account_id, subscriptions, force, policy).await)
    } else {
        None
    };

    if capabilities.evaluate_quota_alerts {
        let quota_alert_subscriptions = match quota_aware_subscriptions.as_ref() {
            Some(Ok(subscriptions)) => subscriptions.as_slice(),
            Some(Err(error)) => {
                log::warn!(
                    "[subscription-snapshot] origin={} account={} quota summary fetch failed; using raw quota windows: {}",
                    origin.as_str(),
                    account_id,
                    error
                );
                subscriptions
            }
            None => subscriptions,
        };
        match subscription_quota_alert_service::evaluate_subscription_quota_alerts(
            ctx,
            account_id,
            quota_alert_subscriptions,
            capabilities.windows_notifications_supported,
        )
        .await
        {
            Ok(quota_report) => report.quota_alert_event_ids = quota_report.event_ids,
            Err(error) => {
                log::warn!(
                    "[subscription-snapshot] origin={} account={} quota evaluator failed: {}",
                    origin.as_str(),
                    account_id,
                    error
                );
                report.quota_alert_error = Some(error.to_string());
            }
        }
    }

    if switch_rules_enabled {
        if let Some(Err(error)) = quota_aware_subscriptions.as_ref() {
            log::warn!(
                "[subscription-snapshot] origin={} account={} switch evaluator skipped because quota summary fetch failed: {}",
                origin.as_str(),
                account_id,
                error
            );
            report.switch_error = Some(format!("订阅摘要读取失败，已跳过候补链评估: {error}"));
            return report;
        }
        let switch_subscriptions = quota_aware_subscriptions
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .map(Vec::as_slice)
            .unwrap_or(subscriptions);
        match subscription_switch_service::evaluate_subscription_switch_rules_with_snapshot(
            ctx,
            account_id,
            switch_subscriptions,
        )
        .await
        {
            Ok(results) => report.switch_evaluation_count = results.len(),
            Err(error) => {
                log::warn!(
                    "[subscription-snapshot] origin={} account={} switch evaluator failed: {}",
                    origin.as_str(),
                    account_id,
                    error
                );
                report.switch_error = Some(error.to_string());
            }
        }
    }
    report
}

/// 构造额度提醒与候补切换共同使用的每日额度快照。
async fn build_quota_alert_subscriptions(
    ctx: &AppContext,
    account_id: &str,
    subscriptions: &[SubscriptionRecord],
    force: bool,
    policy: UpstreamRequestPolicy,
) -> Result<Vec<SubscriptionRecord>> {
    if subscriptions.is_empty() {
        return Ok(subscriptions.to_vec());
    }

    let summary = ctx
        .live_resources
        .get_or_fetch(
            account_id,
            LiveResourceKind::SubscriptionSummary,
            force,
            || async {
                data_center_service::fetch_subscription_summary(ctx, account_id, policy).await
            },
        )
        .await?;
    Ok(merge_subscription_summary_daily_windows(
        subscriptions,
        &summary,
    ))
}

/// 摘要只拥有每日金额；weekly/monthly 及订阅身份始终保留原始快照。
pub(crate) fn merge_subscription_summary_daily_windows(
    subscriptions: &[SubscriptionRecord],
    summary: &SubscriptionSummaryPayload,
) -> Vec<SubscriptionRecord> {
    subscriptions
        .iter()
        .cloned()
        .map(|mut subscription| {
            let Some(group_id) = subscription.group_id else {
                return subscription;
            };
            let Some(summary_record) = summary
                .subscriptions
                .iter()
                .find(|record| record.group_id == group_id)
            else {
                return subscription;
            };
            if !summary_record.daily_used_usd.is_finite()
                || !summary_record.daily_limit_usd.is_finite()
                || summary_record.daily_limit_usd <= 0.0
            {
                return subscription;
            }

            subscription.daily = Some(SubscriptionQuotaWindow {
                current: summary_record.daily_used_usd,
                limit: summary_record.daily_limit_usd,
                window_start: subscription.daily.and_then(|window| window.window_start),
            });
            subscription
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{SubscriptionIdentityKind, SubscriptionSummaryRecord};

    fn subscription() -> SubscriptionRecord {
        SubscriptionRecord {
            id: "subscription-5".into(),
            subscription_key: "group:5".into(),
            identity_kind: SubscriptionIdentityKind::Group,
            identity_ambiguous: false,
            upstream_subscription_id: Some("subscription-5".into()),
            fallback_identity: "fallback:v1:openai|codex-plus|quarter".into(),
            group_id: Some(5),
            name: "CodeX Plus 季度".into(),
            status: "active".into(),
            group_name: Some("CodeX Plus 季度".into()),
            platform: Some("openai".into()),
            expires_at: None,
            daily: None,
            weekly: Some(SubscriptionQuotaWindow {
                current: 25.0,
                limit: 100.0,
                window_start: Some("weekly-window".into()),
            }),
            monthly: Some(SubscriptionQuotaWindow {
                current: 50.0,
                limit: 200.0,
                window_start: Some("monthly-window".into()),
            }),
        }
    }

    fn summary(daily_used_usd: f64, daily_limit_usd: f64) -> SubscriptionSummaryPayload {
        SubscriptionSummaryPayload {
            active_count: 1,
            total_used_usd: daily_used_usd,
            subscriptions: vec![SubscriptionSummaryRecord {
                id: 5,
                group_id: 5,
                group_name: "CodeX Plus 季度".into(),
                status: "active".into(),
                daily_used_usd,
                daily_limit_usd,
                weekly_used_usd: 0.0,
                monthly_used_usd: 0.0,
                expires_at: None,
            }],
        }
    }

    #[test]
    fn summary_daily_window_fills_missing_raw_quota_without_changing_other_windows() {
        let merged =
            merge_subscription_summary_daily_windows(&[subscription()], &summary(295.79, 500.0));

        let record = &merged[0];
        let daily = record.daily.as_ref().expect("summary daily window");
        assert_eq!(daily.current, 295.79);
        assert_eq!(daily.limit, 500.0);
        assert_eq!(record.weekly.as_ref().expect("weekly").current, 25.0);
        assert_eq!(record.monthly.as_ref().expect("monthly").current, 50.0);
        assert_eq!(record.subscription_key, "group:5");
    }

    #[test]
    fn invalid_summary_daily_window_keeps_raw_window() {
        let mut raw = subscription();
        raw.daily = Some(SubscriptionQuotaWindow {
            current: 20.0,
            limit: 100.0,
            window_start: Some("raw-window".into()),
        });

        let merged = merge_subscription_summary_daily_windows(&[raw], &summary(295.79, 0.0));
        let daily = merged[0].daily.as_ref().expect("raw daily window");
        assert_eq!(daily.current, 20.0);
        assert_eq!(daily.limit, 100.0);
        assert_eq!(daily.window_start.as_deref(), Some("raw-window"));
    }

    #[test]
    fn desktop_capabilities_enable_system_notifications_on_supported_desktop_platforms() {
        let desktop = SubscriptionProcessingCapabilities::desktop(false);
        assert_eq!(
            desktop.windows_notifications_supported,
            cfg!(any(target_os = "windows", target_os = "macos"))
        );
        assert!(
            !SubscriptionProcessingCapabilities::headless(false).windows_notifications_supported
        );
    }
}
