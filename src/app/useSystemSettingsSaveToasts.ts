import { useEffect, useRef } from "react";

import type {
  DesktopUiPrefsField,
  DesktopUiPrefsSaveState
} from "../features/desktop-ui/prefs-save-queue";
import { formatAppErrorMessage } from "../shared/lib/error-display";
import { useMonitorStore } from "../store/monitor-store";

const DESKTOP_UI_PREF_FIELD_LABELS: Partial<Record<DesktopUiPrefsField, string>> = {
  theme: "主题",
  launchMode: "默认启动模式",
  openFloatingInMainMode: "主窗口悬浮窗",
  keepFloatingPanelVisible: "悬浮快捷菜单",
  floatingPanelOpacity: "悬浮窗透明度",
  floatingNotificationDurationMs: "消息显示时长",
  floatingNotificationDensity: "消息密度",
  floatingNotificationMaxVisible: "消息最大显示数",
  floatingNotificationSoundVolume: "提示音音量",
  closeBehavior: "关闭行为",
  autoRefreshEnabled: "前端自动刷新总开关",
  autoRefreshServiceStatusEnabled: "服务状态与公开端点刷新",
  autoRefreshIntervalSeconds: "服务状态与公开端点间隔",
  autoRefreshCoreEnabled: "核心总览刷新",
  autoRefreshCoreIntervalSeconds: "核心总览间隔",
  autoRefreshKeysEnabled: "密钥刷新",
  autoRefreshKeysIntervalSeconds: "密钥间隔",
  autoRefreshUsageEnabled: "用量刷新",
  autoRefreshUsageIntervalSeconds: "用量间隔",
  overviewAccountRuntimeTimeoutMs: "总览单账号超时",
  completedTaskRetentionMinutes: "已完成任务保留时间"
};

const SETTINGS_SAVED_TOAST = {
  tone: "success" as const,
  title: "保存成功",
  message: "系统设置已保存。"
};

function describeDesktopUiFields(fields: DesktopUiPrefsField[]) {
  return fields.map((field) => DESKTOP_UI_PREF_FIELD_LABELS[field] ?? field).join("、");
}

/**
 * 将系统设置的终态反馈投递到主窗口 Toast, 不写入消息盒子或业务通知通道。
 */
export function useSystemSettingsSaveToasts({
  desktopUiSaveState,
  retryDesktopUiPrefs,
  schedulerConfigSaving,
  schedulerSaveError,
  retrySchedulerConfigSave,
  runtimeCoordinationConfigSaving,
  runtimeCoordinationSaveError,
  retryRuntimeCoordinationConfigSave,
  upstreamNetworkConfigSaving,
  upstreamNetworkSaveError,
  retryUpstreamNetworkConfigSave
}: {
  desktopUiSaveState: DesktopUiPrefsSaveState;
  retryDesktopUiPrefs: () => void;
  schedulerConfigSaving: boolean;
  schedulerSaveError: string | null;
  retrySchedulerConfigSave: () => void;
  runtimeCoordinationConfigSaving: boolean;
  runtimeCoordinationSaveError: string | null;
  retryRuntimeCoordinationConfigSave: () => void;
  upstreamNetworkConfigSaving: boolean;
  upstreamNetworkSaveError: string | null;
  retryUpstreamNetworkConfigSave: () => void;
}) {
  const pushToast = useMonitorStore((state) => state.pushToast);
  const previousDesktopSaveStateRef = useRef(desktopUiSaveState);
  const previousSchedulerSaveRef = useRef({
    saving: schedulerConfigSaving,
    error: schedulerSaveError
  });
  const previousRuntimeCoordinationSaveRef = useRef({
    saving: runtimeCoordinationConfigSaving,
    error: runtimeCoordinationSaveError
  });
  const previousUpstreamNetworkSaveRef = useRef({
    saving: upstreamNetworkConfigSaving,
    error: upstreamNetworkSaveError
  });
  const retryDesktopUiPrefsRef = useRef(retryDesktopUiPrefs);
  const retrySchedulerConfigSaveRef = useRef(retrySchedulerConfigSave);
  const retryRuntimeCoordinationConfigSaveRef = useRef(retryRuntimeCoordinationConfigSave);
  const retryUpstreamNetworkConfigSaveRef = useRef(retryUpstreamNetworkConfigSave);
  retryDesktopUiPrefsRef.current = retryDesktopUiPrefs;
  retrySchedulerConfigSaveRef.current = retrySchedulerConfigSave;
  retryRuntimeCoordinationConfigSaveRef.current = retryRuntimeCoordinationConfigSave;
  retryUpstreamNetworkConfigSaveRef.current = retryUpstreamNetworkConfigSave;

  useEffect(() => {
    const previous = previousDesktopSaveStateRef.current;
    previousDesktopSaveStateRef.current = desktopUiSaveState;

    const failedFieldsChanged =
      previous.failedFields.join("|") !== desktopUiSaveState.failedFields.join("|");
    if (
      desktopUiSaveState.phase === "failed" &&
      (previous.phase !== "failed" ||
        previous.error !== desktopUiSaveState.error ||
        failedFieldsChanged)
    ) {
      const failedFields = describeDesktopUiFields(desktopUiSaveState.failedFields);
      const fieldMessage = failedFields ? `以下设置尚未保存: ${failedFields}。` : "";
      pushToast({
        tone: "error",
        title: "保存失败",
        message: `${fieldMessage}${formatAppErrorMessage(desktopUiSaveState.error)}`,
        action: {
          label: "重试保存",
          onClick: () => retryDesktopUiPrefsRef.current()
        }
      });
      return;
    }

    if (
      desktopUiSaveState.lastSavedAt !== null &&
      desktopUiSaveState.lastSavedAt !== previous.lastSavedAt
    ) {
      pushToast(SETTINGS_SAVED_TOAST);
    }
  }, [desktopUiSaveState, pushToast]);

  useEffect(() => {
    const previous = previousSchedulerSaveRef.current;
    previousSchedulerSaveRef.current = {
      saving: schedulerConfigSaving,
      error: schedulerSaveError
    };

    if (
      !schedulerConfigSaving &&
      schedulerSaveError &&
      (previous.saving || previous.error !== schedulerSaveError)
    ) {
      pushToast({
        tone: "error",
        title: "保存失败",
        message: `后端自动同步设置保存失败: ${formatAppErrorMessage(schedulerSaveError)}`,
        action: {
          label: "重试保存",
          onClick: () => retrySchedulerConfigSaveRef.current()
        }
      });
      return;
    }

    if (previous.saving && !schedulerConfigSaving && !schedulerSaveError) {
      pushToast(SETTINGS_SAVED_TOAST);
    }
  }, [pushToast, schedulerConfigSaving, schedulerSaveError]);

  useEffect(() => {
    const previous = previousRuntimeCoordinationSaveRef.current;
    previousRuntimeCoordinationSaveRef.current = {
      saving: runtimeCoordinationConfigSaving,
      error: runtimeCoordinationSaveError
    };

    if (
      !runtimeCoordinationConfigSaving &&
      runtimeCoordinationSaveError &&
      (previous.saving || previous.error !== runtimeCoordinationSaveError)
    ) {
      pushToast({
        tone: "error",
        title: "保存失败",
        message: `共享请求协调设置保存失败: ${formatAppErrorMessage(runtimeCoordinationSaveError)}`,
        action: {
          label: "重试保存",
          onClick: () => retryRuntimeCoordinationConfigSaveRef.current()
        }
      });
      return;
    }

    if (
      previous.saving &&
      !runtimeCoordinationConfigSaving &&
      !runtimeCoordinationSaveError
    ) {
      pushToast(SETTINGS_SAVED_TOAST);
    }
  }, [pushToast, runtimeCoordinationConfigSaving, runtimeCoordinationSaveError]);

  useEffect(() => {
    const previous = previousUpstreamNetworkSaveRef.current;
    previousUpstreamNetworkSaveRef.current = {
      saving: upstreamNetworkConfigSaving,
      error: upstreamNetworkSaveError
    };

    if (
      !upstreamNetworkConfigSaving &&
      upstreamNetworkSaveError &&
      (previous.saving || previous.error !== upstreamNetworkSaveError)
    ) {
      pushToast({
        tone: "error",
        title: "保存失败",
        message: `上游网络设置保存失败: ${formatAppErrorMessage(upstreamNetworkSaveError)}`,
        action: {
          label: "重试保存",
          onClick: () => retryUpstreamNetworkConfigSaveRef.current()
        }
      });
      return;
    }

    if (
      previous.saving &&
      !upstreamNetworkConfigSaving &&
      !upstreamNetworkSaveError
    ) {
      pushToast(SETTINGS_SAVED_TOAST);
    }
  }, [pushToast, upstreamNetworkConfigSaving, upstreamNetworkSaveError]);
}
