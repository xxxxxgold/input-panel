import {
  Activity,
  AlertCircle,
  LoaderCircle,
  RefreshCw,
  TimerReset
} from "lucide-react";

import { formatAppErrorMessage } from "../../../shared/lib/error-display";
import type {
  SiteFailoverAddressStatus,
  SiteFailoverAddressStatusKind,
  SiteFailoverStatusPayload,
  SiteRecord
} from "../../../types";
import {
  getSiteCooldownRemainingSeconds,
  isSiteFailoverStatusForSite,
  resolveSiteAddressStatusKind
} from "../site-config-draft";
import type { SiteFailoverAddressAction } from "../useSiteFailoverStatus";

export function SiteFailoverStatusPanel({
  site,
  status,
  loading,
  error,
  nowMs,
  addressActions,
  onRefresh,
  onClearCooldown
}: {
  site: SiteRecord;
  status: SiteFailoverStatusPayload | null;
  loading: boolean;
  error: string | null;
  nowMs: number;
  addressActions: Record<string, SiteFailoverAddressAction>;
  onRefresh: () => Promise<void>;
  onClearCooldown: (baseUrl: string) => Promise<void>;
}) {
  const currentStatus = isSiteFailoverStatusForSite(status, site) ? status : null;
  const clearCooldownInFlight = Object.values(addressActions).some((action) => action.clearing);
  const allAddressesCooling = currentStatus
    && currentStatus.addresses.length > 0
    && currentStatus.addresses.every(
      (address) => resolveSiteAddressStatusKind(address, nowMs) === "cooling"
    );
  const earliestRetrySeconds = allAddressesCooling
    ? Math.min(
        ...currentStatus.addresses.map((address) =>
          getSiteCooldownRemainingSeconds(address, nowMs)
        )
      )
    : null;

  return (
    <section
      className="site-failover-status-panel"
      aria-labelledby="site-failover-status-heading"
      aria-busy={loading || clearCooldownInFlight}
    >
      <div className="site-failover-status-head">
        <div className="site-failover-status-title">
          <span className="site-failover-status-icon" aria-hidden="true">
            <Activity size={16} />
          </span>
          <div>
            <h3 id="site-failover-status-heading">故障转移状态</h3>
            <p>实时地址运行状态</p>
          </div>
        </div>
        <button
          type="button"
          className="mini-button site-failover-refresh-button"
          onClick={() => void onRefresh()}
          disabled={loading}
          title="刷新故障转移状态"
          aria-label="刷新故障转移状态"
        >
          <RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <div className="site-failover-status-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>
            {currentStatus ? "状态刷新失败，已保留最近一次实时快照：" : "实时状态读取失败："}
            {formatAppErrorMessage(error)}
          </span>
          <button type="button" className="inline-text-button" onClick={() => void onRefresh()}>
            重试
          </button>
        </div>
      )}

      {allAddressesCooling && earliestRetrySeconds !== null && (
        <div className="site-failover-all-cooling" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>所有地址冷却中，最早 {earliestRetrySeconds} 秒后可重试</span>
        </div>
      )}

      {currentStatus ? (
        <div className="site-failover-address-list" role="list">
          {currentStatus.addresses.map((address, index) => {
            const addressStatus = resolveSiteAddressStatusKind(address, nowMs);
            const remainingSeconds = getSiteCooldownRemainingSeconds(address, nowMs);
            const action = addressActions[address.baseUrl];
            const label = describeAddress(address, index, currentStatus.addresses);
            const statusText = describeAddressStatus(addressStatus, remainingSeconds);

            return (
              <div className="site-failover-address-row" role="listitem" key={address.baseUrl}>
                <div className="site-failover-address-identity">
                  <span className="site-failover-address-kind">{label}</span>
                  <span className="site-failover-address-url" title={address.baseUrl}>{address.baseUrl}</span>
                </div>
                <span className={`site-failover-status-pill is-${addressStatus}`}>
                  {statusText}
                </span>
                {addressStatus === "cooling" && (
                  <button
                    type="button"
                    className="inline-text-button site-failover-clear-button"
                    onClick={() => void onClearCooldown(address.baseUrl)}
                    disabled={clearCooldownInFlight || action?.clearing}
                    aria-label={`解除${label}冷却`}
                  >
                    {action?.clearing ? (
                      <LoaderCircle size={14} className="spin" aria-hidden="true" />
                    ) : (
                      <TimerReset size={14} aria-hidden="true" />
                    )}
                    {action?.clearing ? "解除中" : "解除冷却"}
                  </button>
                )}
                {action?.error && (
                  <p className="site-failover-address-error" role="alert">
                    {formatAppErrorMessage(action.error)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : loading ? (
        <div className="site-failover-status-placeholder" aria-live="polite">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          <span>正在读取实时状态</span>
        </div>
      ) : !error ? (
        <div className="site-failover-status-placeholder">暂未读取实时状态</div>
      ) : null}
    </section>
  );
}

function describeAddress(
  address: SiteFailoverAddressStatus,
  index: number,
  addresses: SiteFailoverAddressStatus[]
) {
  if (address.kind === "primary") {
    return "主地址";
  }
  const fallbackIndex = addresses
    .slice(0, index + 1)
    .filter((candidate) => candidate.kind === "fallback")
    .length;
  return `备用地址 ${fallbackIndex}`;
}

function describeAddressStatus(status: SiteFailoverAddressStatusKind, remainingSeconds: number) {
  if (status === "active") {
    return "当前使用";
  }
  if (status === "cooling") {
    return `冷却中 ${remainingSeconds}s`;
  }
  return "待检测";
}
