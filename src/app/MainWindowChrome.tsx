import { emitTo } from "@tauri-apps/api/event";
import { lazy, memo, Suspense, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { ToastHost } from "./ToastHost";
import { WindowChrome } from "./WindowChrome";
import {
  selectMainWindowNotificationState
} from "./main-window-store-selectors";
import type { AlertInboxItem, NotificationInboxItem } from "../features/overview/components/AlertInboxModal";
import {
  buildServiceStatusTestNotification,
  sendAppNotification
} from "../features/service-status/notifications";
import { isTauriRuntime } from "../shared/transport/runtime";
import {
  ERROR_TOAST_DURATION_MS,
  INFO_TOAST_DURATION_MS,
  useMonitorStore
} from "../store/monitor-store";
import type { AccountRuntime, OverviewPayload, SiteRecord } from "../types";

const AlertInboxModal = lazy(async () => ({
  default: (await import("../features/overview/components/AlertInboxModal")).AlertInboxModal
}));

function buildMainWindowInboxItems({
  overviewAlerts,
  accounts,
  sites,
  appNotifications,
  dismissedOverviewAlertIds
}: {
  overviewAlerts: OverviewPayload["alerts"];
  accounts: AccountRuntime[];
  sites: SiteRecord[];
  appNotifications: ReturnType<typeof selectMainWindowNotificationState>["appNotifications"];
  dismissedOverviewAlertIds: string[];
}) {
  const alertInboxItems: AlertInboxItem[] = overviewAlerts
    .filter((alert) => !dismissedOverviewAlertIds.includes(alert.id))
    .map((alert) => {
      const account = accounts.find((item) => item.id === alert.accountId) ?? null;
      const site = sites.find((item) => item.id === alert.siteId) ?? account?.site ?? null;
      return {
        ...alert,
        accountLabel: account?.label ?? null,
        siteName: site?.name ?? null
      };
    });

  return [
    ...appNotifications.map((item) => ({
      notificationKey: `service-status:${item.id}`,
      source: "service-status" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      models: item.models
    })),
    ...alertInboxItems.map((item) => ({
      notificationKey: `overview-alert:${item.id}`,
      source: "overview-alert" as const,
      id: item.id,
      severity: item.severity,
      title: item.title,
      detail: item.detail,
      createdAt: item.createdAt,
      siteName: item.siteName,
      accountLabel: item.accountLabel
    }))
  ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()) as NotificationInboxItem[];
}

function useMainWindowInbox() {
  const notificationState = useMonitorStore(useShallow(selectMainWindowNotificationState));
  return useMemo(
    () => buildMainWindowInboxItems({
      overviewAlerts: notificationState.overviewAlerts,
      accounts: notificationState.accounts,
      sites: notificationState.sites,
      appNotifications: notificationState.appNotifications,
      dismissedOverviewAlertIds: notificationState.dismissedOverviewAlertIds
    }),
    [notificationState]
  );
}

export const MainWindowToastLayer = memo(function MainWindowToastLayer() {
  const toasts = useMonitorStore((state) => state.toasts);
  const dismissToast = useMonitorStore((state) => state.dismissToast);
  return (
    <div className="main-window-toast-layer">
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
});

export const MainWindowNotificationChrome = memo(function MainWindowNotificationChrome({
  title,
  logoSrc,
  onOpenProfile,
  onCloseTopbarPeekPanels,
  onAlertInboxOpenChange
}: {
  title: string;
  logoSrc: string;
  onOpenProfile: () => void;
  onCloseTopbarPeekPanels: () => void;
  onAlertInboxOpenChange: (open: boolean) => void;
}) {
  const inboxItems = useMainWindowInbox();
  const readNotificationKeys = useMonitorStore((state) => state.readNotificationKeys);
  const unreadInboxItems = inboxItems.filter((item) => !readNotificationKeys.includes(item.notificationKey));
  const latestUnreadInboxItem = unreadInboxItems[0] ?? null;

  function handleTestNotification(kind: "down" | "recovered") {
    const notification = buildServiceStatusTestNotification(kind);
    const monitorStore = useMonitorStore.getState();
    monitorStore.pushAppNotification(notification);
    void sendAppNotification(notification);
    const toastPayload = {
      tone: kind === "down" ? "error" : "info",
      message: notification.title,
      durationMs: kind === "down" ? ERROR_TOAST_DURATION_MS : INFO_TOAST_DURATION_MS
    } as const;
    monitorStore.pushToast(toastPayload);
    if (isTauriRuntime()) {
      void emitTo("floating-panel", "floating-panel-toast", toastPayload);
    }
  }

  function handleOpenAlertInbox() {
    onCloseTopbarPeekPanels();
    useMonitorStore.getState().markNotificationsRead(inboxItems.map((item) => item.notificationKey));
    onAlertInboxOpenChange(true);
  }

  return (
    <WindowChrome
      title={title}
      logoSrc={logoSrc}
      alertCount={inboxItems.length}
      latestUnreadAlertSeverity={latestUnreadInboxItem?.severity ?? null}
      onTriggerTestNotification={handleTestNotification}
      onOpenProfile={onOpenProfile}
      onOpenAlerts={handleOpenAlertInbox}
    />
  );
});

export const MainWindowAlertInbox = memo(function MainWindowAlertInbox({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inboxItems = useMainWindowInbox();

  function handleAcknowledgeInboxItem(item: NotificationInboxItem) {
    const monitorStore = useMonitorStore.getState();
    if (item.source === "service-status") {
      monitorStore.dismissAppNotification(item.id);
    } else {
      monitorStore.acknowledgeOverviewAlert(item.id);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <AlertInboxModal
        items={inboxItems}
        onClose={() => onOpenChange(false)}
        onAcknowledge={handleAcknowledgeInboxItem}
      />
    </Suspense>
  );
});
