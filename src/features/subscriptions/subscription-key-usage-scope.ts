/**
 * 将账号、订阅、关联 Key 与日期窗口组合为稳定的请求缓存边界。
 */
export function buildSubscriptionKeyUsageScopeKey(input: {
  accountId: string | null;
  subscriptionId: string;
  subscriptionKey: string;
  relatedKeyIdsSignature: string;
  startDate: string;
  endDate: string;
}) {
  return JSON.stringify(input);
}
