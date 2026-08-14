import { Bell, BellOff } from "lucide-react";

import {
  formatDateTimeFull,
  formatPercent,
  formatRemainingDaysLabel
} from "../../../shared/lib/formatters";
import { EmptyState } from "../../../shared/ui/EmptyState";
import {
  getSubscriptionQuotaProgressMeta,
  getSubscriptionStatusPresentation
} from "../../../subscription-view";
import type { SubscriptionQuotaAlertSettingsPayload, SubscriptionRecord } from "../../../types";
import {
  formatSubscriptionQuotaAlertSummary,
  resolveEffectiveSubscriptionQuotaAlertRule
} from "../quota-alert-config";

export function SubscriptionList({
  subscriptions,
  selectedSubscriptionId,
  onSelectSubscription,
  quotaAlertSettings
}: {
  subscriptions: SubscriptionRecord[];
  selectedSubscriptionId?: string | null;
  onSelectSubscription?: (subscription: SubscriptionRecord) => void;
  quotaAlertSettings?: SubscriptionQuotaAlertSettingsPayload | null;
}) {
  if (subscriptions.length === 0) {
    return <EmptyState title="当前没有订阅数据" detail="该账号未返回有效订阅或套餐信息。" compact />;
  }
  const listFallbackPlatform = resolveListFallbackPlatform(subscriptions);
  return (
    <div className="stack-list">
      {subscriptions.map((subscription) => {
        const statusPresentation = getSubscriptionStatusPresentation(subscription.status);
        const interactive = Boolean(onSelectSubscription);
        const resolvedPlatform = resolveSubscriptionPlatform(subscription.platform, listFallbackPlatform);
        const quotaAlertRule = quotaAlertSettings
          ? resolveEffectiveSubscriptionQuotaAlertRule(
              quotaAlertSettings,
              subscription.subscriptionKey
            )
          : null;
        const QuotaAlertIcon = quotaAlertRule?.enabled ? Bell : BellOff;
        const subscriptionMetaLabel = resolveSubscriptionMetaLabel(subscription);
        return (
          <button
            key={subscription.id}
            type="button"
            className={`subscription-card ${interactive ? "subscription-card-button" : ""} ${
              selectedSubscriptionId === subscription.id ? "selected" : ""
            }`.trim()}
            onClick={interactive ? () => onSelectSubscription?.(subscription) : undefined}
            aria-pressed={interactive ? selectedSubscriptionId === subscription.id : undefined}
            aria-label={interactive ? `查看 ${subscription.name} 的订阅详情` : undefined}
          >
            <div className="subscription-card-head">
              <div className="subscription-card-copy">
                <div className="subscription-card-title-row">
                  <div className="subscription-card-title-cluster">
                    <div className="subscription-card-tags">
                      <span className={`subscription-platform-pill ${toPlatformTone(resolvedPlatform)}`}>
                        {formatSubscriptionPlatformLabel(resolvedPlatform)}
                      </span>
                    </div>
                    <strong>{subscription.name}</strong>
                    {quotaAlertRule && (
                      <span
                        className={`subscription-quota-alert-summary ${quotaAlertRule.enabled ? "enabled" : "disabled"}`}
                      >
                        <QuotaAlertIcon aria-hidden="true" size={14} strokeWidth={1.8} />
                        <span>额度提醒 {formatSubscriptionQuotaAlertSummary(quotaAlertRule)}</span>
                      </span>
                    )}
                  </div>
                  <div className="subscription-status-block">
                    <span className={`status-pill ${statusPresentation.tone}`}>
                      {statusPresentation.label}
                    </span>
                  </div>
                </div>
                <div className="subscription-card-meta">
                  {subscriptionMetaLabel && <p>{subscriptionMetaLabel}</p>}
                </div>
              </div>
            </div>
            {renderQuotaWindow("每日额度", subscription.daily, subscription.expiresAt)}
            {renderQuotaWindow("每周额度", subscription.weekly)}
            {renderQuotaWindow("每月额度", subscription.monthly)}
          </button>
        );
      })}
    </div>
  );
}

function toPlatformTone(platform?: string | null) {
  return (normalizePlatformValue(platform) ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function formatSubscriptionPlatformLabel(platform?: string | null) {
  const normalized = normalizePlatformValue(platform);
  if (!normalized) {
    return "未知平台";
  }
  return `${normalized.slice(0, 1).toLocaleUpperCase("en-US")}${normalized.slice(1)}`;
}

function resolveSubscriptionPlatform(
  platform: string | null | undefined,
  listFallbackPlatform: string | null
) {
  return normalizePlatformValue(platform) ?? listFallbackPlatform;
}

function resolveListFallbackPlatform(subscriptions: SubscriptionRecord[]) {
  const distinctPlatforms = Array.from(
    new Set(
      subscriptions
        .map((item) => normalizePlatformValue(item.platform))
        .filter((item): item is string => item !== null)
    )
  );
  return distinctPlatforms.length === 1 ? distinctPlatforms[0] : null;
}

function normalizePlatformValue(platform?: string | null) {
  const trimmed = platform?.trim();
  return trimmed ? trimmed : null;
}

function resolveSubscriptionMetaLabel(subscription: SubscriptionRecord) {
  const groupName = subscription.groupName?.trim();
  const title = subscription.name.trim();

  if (!groupName) {
    return "未分组";
  }

  return groupName === title ? null : groupName;
}

function renderQuotaWindow(
  label: string,
  windowValue:
    | {
        current: number;
        limit: number;
        windowStart?: string | null;
      }
    | null
    | undefined,
  expiresAt?: string | null
) {
  if (!windowValue) return null;
  const progressMeta = getSubscriptionQuotaProgressMeta(windowValue.current, windowValue.limit);
  return (
    <div className="quota-row">
      <div className="bar-label">
        <div className="bar-label-copy">
          <span>{label}</span>
          <small className={`quota-progress-percent ${progressMeta.tone}`}>
            {formatPercent(progressMeta.rawPercent, 1)}
          </small>
        </div>
        <strong>
          ${windowValue.current.toFixed(2)} / ${windowValue.limit.toFixed(2)}
        </strong>
      </div>
      <div className={`bar-track ${progressMeta.tone}`}>
        <div className={`bar-fill ${progressMeta.tone}`} style={{ width: `${progressMeta.percent}%` }} />
      </div>
      {(windowValue.windowStart || (label === "每日额度" && expiresAt)) && (
        <div className="quota-hint-block">
          {windowValue.windowStart && (
            <p className="quota-hint">
              {label}统计起点: {formatDateTimeFull(windowValue.windowStart)}
            </p>
          )}
          {label === "每日额度" && expiresAt && (
            <>
              <p className="quota-hint">到期情况: {formatRemainingDaysLabel(expiresAt)}</p>
              <p className="quota-hint">到期时间: {formatDateTimeFull(expiresAt)}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
