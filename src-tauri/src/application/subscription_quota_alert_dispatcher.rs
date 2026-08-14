use anyhow::{anyhow, bail, Context, Result};
use chrono::{Duration, Utc};
use tauri::{AppHandle, Manager};

use crate::contracts::{
    SubscriptionQuotaAlertEventPayload, SubscriptionQuotaAlertThresholdMode,
    SubscriptionQuotaAlertTriggeredWindow, SubscriptionQuotaAlertWindowKind,
};
use crate::infrastructure::datetime::{format_storage_timestamp, now_storage_timestamp};
use crate::infrastructure::sqlite::repositories::{
    self, ClaimedSubscriptionQuotaAlertChannel, SubscriptionQuotaAlertChannel,
};

const DELIVERY_LEASE_SECONDS: i64 = 30;
const MAX_CHANNELS_PER_FLUSH: usize = 100;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubscriptionQuotaAlertDispatchReport {
    pub business_sent: usize,
    pub windows_sent: usize,
    pub failed: usize,
}

/// 投递当前到期的额度事件通道；单通道外部失败只更新该通道退避状态。
pub async fn flush_due(
    app: &AppHandle,
    account_id: Option<&str>,
) -> Result<SubscriptionQuotaAlertDispatchReport> {
    let ctx = app.state::<super::AppContext>();
    let mut report = SubscriptionQuotaAlertDispatchReport::default();
    flush_channel(
        app,
        &ctx,
        account_id,
        SubscriptionQuotaAlertChannel::Business,
        &mut report,
    )?;
    flush_channel(
        app,
        &ctx,
        account_id,
        SubscriptionQuotaAlertChannel::Windows,
        &mut report,
    )?;
    Ok(report)
}

fn flush_channel(
    app: &AppHandle,
    ctx: &super::AppContext,
    account_id: Option<&str>,
    channel: SubscriptionQuotaAlertChannel,
    report: &mut SubscriptionQuotaAlertDispatchReport,
) -> Result<()> {
    for _ in 0..MAX_CHANNELS_PER_FLUSH {
        let now = Utc::now();
        let now_storage = format_storage_timestamp(now);
        let lease_until = format_storage_timestamp(now + Duration::seconds(DELIVERY_LEASE_SECONDS));
        let lease_id = uuid::Uuid::new_v4().to_string();
        let Some(claim) = repositories::claim_due_subscription_quota_alert_channel(
            &ctx.db,
            channel,
            account_id,
            &now_storage,
            &lease_id,
            &lease_until,
        )?
        else {
            break;
        };
        let dispatch_result = match channel {
            SubscriptionQuotaAlertChannel::Business => dispatch_business(app, ctx, &claim),
            SubscriptionQuotaAlertChannel::Windows => dispatch_windows(app, &claim),
        };
        match dispatch_result {
            Ok(()) => {
                if !repositories::mark_subscription_quota_alert_channel_sent(
                    &ctx.db,
                    &claim.event_id,
                    channel,
                    &claim.lease_id,
                    &now_storage_timestamp(),
                )? {
                    bail!("订阅额度提醒投递完成后 lease 已失效。");
                }
                match channel {
                    SubscriptionQuotaAlertChannel::Business => report.business_sent += 1,
                    SubscriptionQuotaAlertChannel::Windows => report.windows_sent += 1,
                }
            }
            Err(error) => {
                let next_attempt_at = format_storage_timestamp(
                    Utc::now() + Duration::seconds(retry_delay_seconds(claim.attempt)),
                );
                let error_message = sanitize_delivery_error(&error.to_string());
                repositories::mark_subscription_quota_alert_channel_failed(
                    &ctx.db,
                    &claim.event_id,
                    channel,
                    &claim.lease_id,
                    &error_message,
                    &next_attempt_at,
                    &now_storage_timestamp(),
                )?;
                report.failed += 1;
                log::warn!(
                    "[subscription-quota-alert] event={} channel={:?} attempt={} delivery failed: {}",
                    claim.event_id,
                    channel,
                    claim.attempt,
                    error_message
                );
            }
        }
    }
    Ok(())
}

fn dispatch_business(
    app: &AppHandle,
    ctx: &super::AppContext,
    claim: &ClaimedSubscriptionQuotaAlertChannel,
) -> Result<()> {
    let event = decode_claimed_event(claim)?;
    let content = format_event_content(&event);
    let account_label = repositories::find_account(&ctx.db, &claim.account_id)?
        .map(|account| account.label)
        .unwrap_or_else(|| claim.account_id.clone());
    let payload = crate::FloatingNotificationPayload {
        id: event.id,
        dedupe_key: event.dedupe_key,
        channel: crate::FloatingNotificationChannel::Business,
        title: format!("{} 额度达到提醒阈值", event.subscription_name),
        level: "warning".into(),
        source: "subscription-quota".into(),
        created_at: event.created_at,
        content,
        account: Some(crate::FloatingNotificationReference {
            id: Some(claim.account_id.clone()),
            label: account_label,
        }),
        site: None,
        model: None,
        usage: None,
    };
    crate::enqueue_floating_notification(app, payload)
        .map(|_| ())
        .map_err(|error| anyhow!(error))
}

fn dispatch_windows(app: &AppHandle, claim: &ClaimedSubscriptionQuotaAlertChannel) -> Result<()> {
    let event = decode_claimed_event(claim)?;
    let title = format!("{} 额度提醒", event.subscription_name);
    let body = format_event_content(&event);
    #[cfg(target_os = "windows")]
    {
        crate::infrastructure::windows_notification::show_windows_notification(
            app,
            &title,
            &body,
            crate::infrastructure::windows_notification::NativeNotificationNavigation::Subscriptions,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body);
        bail!("当前平台不支持 Windows 通知。")
    }
}

fn decode_claimed_event(
    claim: &ClaimedSubscriptionQuotaAlertChannel,
) -> Result<SubscriptionQuotaAlertEventPayload> {
    let event = serde_json::from_str::<SubscriptionQuotaAlertEventPayload>(&claim.payload_json)
        .context("无法解析订阅额度提醒事件")?;
    if event.id != claim.event_id || event.dedupe_key != claim.dedupe_key {
        bail!("订阅额度提醒事件持久身份不一致。");
    }
    Ok(event)
}

fn format_event_content(event: &SubscriptionQuotaAlertEventPayload) -> String {
    let threshold = match event.threshold_mode {
        SubscriptionQuotaAlertThresholdMode::UsagePercent => {
            format!("达到 {}%", format_number(event.threshold_value))
        }
        SubscriptionQuotaAlertThresholdMode::AmountUsd => {
            format!("达到 ${}", format_number(event.threshold_value))
        }
    };
    let windows = event
        .triggered_windows
        .iter()
        .map(format_triggered_window)
        .collect::<Vec<_>>()
        .join("，");
    format!("{threshold}；{windows}")
}

fn format_triggered_window(window: &SubscriptionQuotaAlertTriggeredWindow) -> String {
    let label = match window.kind {
        SubscriptionQuotaAlertWindowKind::Daily => "每日",
        SubscriptionQuotaAlertWindowKind::Weekly => "每周",
        SubscriptionQuotaAlertWindowKind::Monthly => "每月",
    };
    match (window.usage_percent, window.limit) {
        (Some(percent), Some(limit)) => format!(
            "{label} {}% (${} / ${})",
            format_number(percent),
            format_number(window.current),
            format_number(limit),
        ),
        _ => format!("{label} ${}", format_number(window.current)),
    }
}

fn format_number(value: f64) -> String {
    let rendered = format!("{value:.2}");
    rendered
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn retry_delay_seconds(attempt: i64) -> i64 {
    let shift = attempt.saturating_sub(1).clamp(0, 5) as u32;
    (15_i64.saturating_mul(1_i64 << shift)).min(300)
}

fn sanitize_delivery_error(error: &str) -> String {
    error.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> SubscriptionQuotaAlertEventPayload {
        SubscriptionQuotaAlertEventPayload {
            id: "event-1".into(),
            dedupe_key: "subscription-quota:event-1".into(),
            account_id: "account-1".into(),
            subscription_key: "group:42".into(),
            subscription_name: "Pro".into(),
            threshold_mode: SubscriptionQuotaAlertThresholdMode::UsagePercent,
            threshold_value: 98.0,
            config_revision: 0,
            triggered_windows: vec![SubscriptionQuotaAlertTriggeredWindow {
                kind: SubscriptionQuotaAlertWindowKind::Daily,
                current: 98.25,
                limit: Some(100.0),
                window_start: Some("2026-08-04".into()),
                usage_percent: Some(98.25),
            }],
            created_at: "2026-08-04 00:00:00".into(),
        }
    }

    #[test]
    fn event_content_names_threshold_window_and_current_value() {
        assert_eq!(
            format_event_content(&event()),
            "达到 98%；每日 98.25% ($98.25 / $100)"
        );
    }

    #[test]
    fn retry_delay_is_exponential_and_capped() {
        assert_eq!(retry_delay_seconds(1), 15);
        assert_eq!(retry_delay_seconds(2), 30);
        assert_eq!(retry_delay_seconds(3), 60);
        assert_eq!(retry_delay_seconds(9), 300);
    }
}
