import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "../../shared/transport/runtime";
import type {
  ServiceStatusMonitorNotificationEvent,
  ServiceStatusPayload
} from "../../types";

export type AppNotificationSeverity = "critical" | "success" | "info";
export type AppNotificationSource = "overview-alert" | "service-status";
export type AppNotificationKind =
  | "overview-alert"
  | "service-status-down"
  | "service-status-recovered"
  | "service-status-monitor-unavailable"
  | "service-status-monitor-recovered"
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
  kind: "down" | "recovered" | "monitor-unavailable" | "monitor-recovered";
  title: string;
  detail: string;
  dedupeKey: string;
  severity: AppNotificationSeverity;
  createdAt: string;
  models: string[];
}

export interface ServiceStatusModelHealth {
  available: boolean;
  lastProbeTs: number;
  lastError: string | null;
}

export type ServiceStatusModelHealthMap = Map<string, ServiceStatusModelHealth>;

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
        ? `${service.model} 当前无法使用, 请打开服务状态查看详情`
        : `${service.model} 当前无法使用, 请打开服务状态查看详情`
    };
  }

  const names = failingServices.slice(0, 2).map((service) => service.model).join(", ");
  const scope = failingServices.length > 2 ? `${names} 等 ${failingServices.length} 个模型` : names;
  return {
    signature,
    failingModels,
    message: `${scope} 当前无法使用, 请打开服务状态查看详情`
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
      dedupeKey: `service-status:down:${issue?.signature ?? "unknown"}`,
      severity: "critical",
      createdAt,
      models
    };
  }

  return {
    kind: "recovered",
    title: "检测到服务状态恢复正常",
    detail: issue?.message ?? buildRecoveryDetail(options.nextStatus),
    dedupeKey: "service-status:recovered",
    severity: "success",
    createdAt,
    models: []
  };
}

export function buildServiceStatusModelHealthMap(
  status: ServiceStatusPayload
): ServiceStatusModelHealthMap {
  return new Map(
    status.services.map((service) => [
      service.model,
      {
        available: service.last?.ok ?? false,
        lastProbeTs: service.last?.ts ?? status.generatedAt,
        lastError: normalizeOptionalFailureReason(service.last?.error)
      }
    ])
  );
}

/**
 * 按模型维护切换基线，避免整体仍处于异常时漏掉其他模型的新故障或恢复。
 */
export function buildServiceStatusModelTransitionEvents(options: {
  previousModels: ServiceStatusModelHealthMap | null;
  nextStatus: ServiceStatusPayload;
  notifyInitialFailures?: boolean;
  createdAt?: string;
}) {
  const nextModels = buildServiceStatusModelHealthMap(options.nextStatus);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const events: ServiceStatusTransitionEvent[] = [];

  for (const [model, current] of nextModels) {
    const previous = options.previousModels?.get(model);
    const becameUnavailable = !current.available
      && (previous ? previous.available : options.notifyInitialFailures === true);
    const recovered = current.available && previous?.available === false;

    if (becameUnavailable) {
      events.push({
        kind: "down",
        title: `${model} 服务不可用`,
        detail: current.lastError
          ? `${model} 当前无法使用: ${current.lastError}`
          : `${model} 当前无法使用, 请打开服务状态查看详情。`,
        dedupeKey: `service-status:model-down:${model}:${current.lastProbeTs}`,
        severity: "critical",
        createdAt,
        models: [model]
      });
    } else if (recovered) {
      events.push({
        kind: "recovered",
        title: `${model} 服务已恢复`,
        detail: `${model} 当前已恢复正常。`,
        dedupeKey: `service-status:model-recovered:${model}:${current.lastProbeTs}`,
        severity: "success",
        createdAt,
        models: [model]
      });
    }
  }

  if (options.nextStatus.allOk && options.previousModels) {
    for (const [model, previous] of options.previousModels) {
      if (!previous.available && !nextModels.has(model)) {
        events.push({
          kind: "recovered",
          title: `${model} 服务已恢复`,
          detail: `${model} 已不再出现在异常服务列表中。`,
          dedupeKey: `service-status:model-recovered:${model}:${options.nextStatus.generatedAt}`,
          severity: "success",
          createdAt,
          models: [model]
        });
      }
    }
  }

  return { events, nextModels };
}

export function buildServiceStatusMonitorUnavailableEvent(
  failedAt: string,
  detail: string
): ServiceStatusTransitionEvent {
  return {
    kind: "monitor-unavailable",
    title: "模型状态监控暂时不可用",
    detail,
    dedupeKey: `service-status:monitor-unavailable:${failedAt}`,
    severity: "critical",
    createdAt: failedAt,
    models: []
  };
}

export function buildServiceStatusMonitorRecoveredEvent(
  recoveredAt = new Date().toISOString()
): ServiceStatusTransitionEvent {
  return {
    kind: "monitor-recovered",
    title: "模型状态监控已恢复",
    detail: "Input 服务状态读取已恢复, 后台监控正在正常运行。",
    dedupeKey: `service-status:monitor-recovered:${recoveredAt}`,
    severity: "success",
    createdAt: recoveredAt,
    models: []
  };
}

export function buildServiceStatusNotificationRecord(event: ServiceStatusTransitionEvent): AppNotificationItem {
  return {
    id: crypto.randomUUID(),
    source: "service-status",
    severity: event.severity,
    kind: resolveServiceStatusNotificationKind(event.kind),
    title: event.title,
    detail: event.detail,
    createdAt: event.createdAt,
    dedupeKey: event.dedupeKey,
    models: event.models
  };
}

export function buildNativeServiceStatusNotificationRecord(
  event: ServiceStatusMonitorNotificationEvent
): AppNotificationItem {
  const kindByNativeEvent = {
    modelDown: "service-status-down",
    modelRecovered: "service-status-recovered",
    monitorUnavailable: "service-status-monitor-unavailable",
    monitorRecovered: "service-status-monitor-recovered"
  } as const;

  return {
    id: event.id,
    source: "service-status",
    severity: event.severity,
    kind: kindByNativeEvent[event.kind],
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

export async function sendAppNotification(notification: AppNotificationItem) {
  if (isTauriRuntime()) {
    try {
      await invoke("enqueue_floating_notification", {
        payload: {
          id: notification.id,
          dedupeKey: notification.dedupeKey,
          title: notification.title,
          level: notification.severity,
          source: notification.source,
          createdAt: notification.createdAt,
          content: notification.detail,
          model: notification.models?.length
            ? { label: notification.models.join(", ") }
            : null
        }
      });
    } catch {
      // 气泡窗口失败不应阻断消息盒子或系统通知。
    }
  }

  try {
    if (isTauriRuntime()) {
      await invoke("send_service_status_system_notification", {
        title: notification.title,
        body: notification.detail
      });
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
        body: notification.detail,
        silent: true
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

function normalizeOptionalFailureReason(reason?: string | null) {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveServiceStatusNotificationKind(
  kind: ServiceStatusTransitionEvent["kind"]
): AppNotificationKind {
  switch (kind) {
    case "down":
      return "service-status-down";
    case "recovered":
      return "service-status-recovered";
    case "monitor-unavailable":
      return "service-status-monitor-unavailable";
    case "monitor-recovered":
      return "service-status-monitor-recovered";
  }
}
