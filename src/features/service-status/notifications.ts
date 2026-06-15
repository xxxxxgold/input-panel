import { sendNotification as sendTauriNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

import { isTauriRuntime } from "../../shared/transport/runtime";
import type { ServiceStatusPayload } from "../../types";

export type AppNotificationSeverity = "critical" | "success" | "info";
export type AppNotificationSource = "overview-alert" | "service-status";
export type AppNotificationKind =
  | "overview-alert"
  | "service-status-down"
  | "service-status-recovered"
  | "service-status-test-down"
  | "service-status-test-recovered";

export interface AppNotificationItem {
  id: string;
  source: AppNotificationSource;
  severity: AppNotificationSeverity;
  kind: AppNotificationKind;
  title: string;
  detail: string;
  createdAt: string;
  dedupeKey: string;
  models?: string[];
}

export type ServiceStatusHealthState = "healthy" | "degraded";

export interface ServiceStatusIssue {
  signature: string;
  message: string;
  failingModels: string[];
}

export interface ServiceStatusTransitionEvent {
  kind: "down" | "recovered";
  title: string;
  detail: string;
  dedupeKey: string;
  severity: AppNotificationSeverity;
  createdAt: string;
  models: string[];
}

export function describeServiceStatusIssue(status: ServiceStatusPayload | null): ServiceStatusIssue | null {
  if (!status) {
    return null;
  }

  const failingServices = status.services.filter((service) => service.last && !service.last.ok);
  if (failingServices.length === 0) {
    if (!status.allOk) {
      return {
        signature: "unknown-service-status-failure",
        message: "服务状态自动刷新发现异常, 请打开服务状态查看详情。",
        failingModels: []
      };
    }
    return null;
  }

  const signature = failingServices
    .map((service) => `${service.model}:${normalizeFailureReason(service.last?.error)}`)
    .sort()
    .join("|");
  const failingModels = failingServices.map((service) => service.model);

  if (failingServices.length === 1) {
    const service = failingServices[0];
    const reason = service.last?.error?.trim();
    return {
      signature,
      failingModels,
      message: reason
        ? `服务状态自动刷新发现异常: ${service.model} 探测失败, ${reason}`
        : `服务状态自动刷新发现异常: ${service.model} 探测失败`
    };
  }

  const names = failingServices.slice(0, 2).map((service) => service.model).join(", ");
  const scope = failingServices.length > 2 ? `${names} 等 ${failingServices.length} 个模型` : names;
  return {
    signature,
    failingModels,
    message: `服务状态自动刷新发现异常: ${scope} 探测失败`
  };
}

export function resolveServiceStatusHealthState(status: ServiceStatusPayload | null): ServiceStatusHealthState {
  return describeServiceStatusIssue(status) ? "degraded" : "healthy";
}

export function buildServiceStatusTransitionEvent(options: {
  previousHealth: ServiceStatusHealthState;
  nextStatus: ServiceStatusPayload;
  createdAt?: string;
}): ServiceStatusTransitionEvent | null {
  const issue = describeServiceStatusIssue(options.nextStatus);
  const nextHealth = issue ? "degraded" : "healthy";
  if (options.previousHealth === nextHealth) {
    return null;
  }

  const createdAt = options.createdAt ?? new Date().toISOString();
  if (nextHealth === "degraded") {
    const models = issue?.failingModels ?? [];
    return {
      kind: "down",
      title: "检测到服务状态不可用",
      detail: issue?.message ?? "服务状态自动刷新发现异常, 请打开服务状态查看详情。",
      dedupeKey: `service-status:down:${issue?.signature ?? "unknown"}:${createdAt}`,
      severity: "critical",
      createdAt,
      models
    };
  }

  return {
    kind: "recovered",
    title: "检测到服务状态恢复正常",
    detail: issue?.message ?? buildRecoveryDetail(options.nextStatus),
    dedupeKey: `service-status:recovered:${createdAt}`,
    severity: "success",
    createdAt,
    models: []
  };
}

export function buildServiceStatusNotificationRecord(event: ServiceStatusTransitionEvent): AppNotificationItem {
  return {
    id: crypto.randomUUID(),
    source: "service-status",
    severity: event.severity,
    kind: event.kind === "down" ? "service-status-down" : "service-status-recovered",
    title: event.title,
    detail: event.detail,
    createdAt: event.createdAt,
    dedupeKey: event.dedupeKey,
    models: event.models
  };
}

export function buildServiceStatusTestNotification(kind: "down" | "recovered"): AppNotificationItem {
  const createdAt = new Date().toISOString();
  if (kind === "down") {
    return {
      id: crypto.randomUUID(),
      source: "service-status",
      severity: "critical",
      kind: "service-status-test-down",
      title: "测试通知: 检测到服务状态不可用",
      detail: "这是一条手动触发的异常测试通知, 用于验证系统通知和消息盒子链路。",
      createdAt,
      dedupeKey: `service-status:test-down:${createdAt}`,
      models: ["gpt-5.5"]
    };
  }

  return {
    id: crypto.randomUUID(),
    source: "service-status",
    severity: "success",
    kind: "service-status-test-recovered",
    title: "测试通知: 检测到服务状态恢复正常",
    detail: "这是一条手动触发的恢复测试通知, 用于验证系统通知和消息盒子链路。",
    createdAt,
    dedupeKey: `service-status:test-recovered:${createdAt}`,
    models: []
  };
}

export async function sendAppNotification(notification: Pick<AppNotificationItem, "title" | "detail">) {
  try {
    if (isTauriRuntime()) {
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === "granted";
      }
      if (granted) {
        sendTauriNotification({
          title: notification.title,
          body: notification.detail
        });
      }
      return;
    }

    if (typeof window === "undefined" || typeof Notification === "undefined") {
      return;
    }

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission === "granted") {
      new Notification(notification.title, {
        body: notification.detail
      });
    }
  } catch {
    // 权限拒绝或桌面通知失败时, 只保留应用内消息与 toast, 不打断主流程。
  }
}

function buildRecoveryDetail(status: ServiceStatusPayload) {
  const total = status.services.length;
  if (total === 0) {
    return "服务状态自动刷新检测到所有服务已恢复正常。";
  }
  return `服务状态自动刷新检测到 ${total} 个模型当前均已恢复正常。`;
}

function normalizeFailureReason(reason?: string | null) {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "probe_failed";
}
