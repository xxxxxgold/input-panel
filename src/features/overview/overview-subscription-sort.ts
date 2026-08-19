import type { SubscriptionRecord } from "../../types";

export function sortOverviewSubscriptionsByUsage(subscriptions: SubscriptionRecord[]) {
  return subscriptions
    .map((subscription, sourceIndex) => ({
      subscription,
      sourceIndex,
      usageRatio: resolveOverviewSubscriptionUsageRatio(subscription)
    }))
    .sort((left, right) => {
      const usageDifference = right.usageRatio - left.usageRatio;
      return usageDifference !== 0 ? usageDifference : left.sourceIndex - right.sourceIndex;
    })
    .map(({ subscription }) => subscription);
}

function resolveOverviewSubscriptionUsageRatio(subscription: SubscriptionRecord) {
  const quotaWindow = [subscription.daily, subscription.weekly, subscription.monthly]
    .find((windowValue) => windowValue && Number.isFinite(windowValue.limit) && windowValue.limit > 0);

  if (!quotaWindow) {
    return 0;
  }

  const current = Number.isFinite(quotaWindow.current) ? Math.max(0, quotaWindow.current) : 0;
  return current / quotaWindow.limit;
}
