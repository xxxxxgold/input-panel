import { describe, expect, it } from "vitest";

import {
  buildAutoRefreshWatcherKey,
  getAutoRefreshResourceForNav,
  resolveAutoRefreshGroupPolicy,
  resolveAutoRefreshIntervalSecondsForScope,
  resolveAutoRefreshScope,
  resolveAutoRefreshScopeForResource,
  resolveServiceStatusAutoRefreshPolicy,
  shouldRefreshSwitchRulesOnSettingsOpen,
  shouldAutoRefreshSelectedAccountData
} from "../src/app/refresh-policy";
import {
  filterExpiredSyncTasks,
  getNextSyncTaskExpirationDelay,
  isSyncTaskExpired,
  mergeAccountSyncStatusesIntoTasks
} from "../src/app/sync-task-records";
import type { SyncTaskCenterTask } from "../src/app/SyncTaskCenter";
import type { AccountRuntime, AccountSyncStatusRecord, DesktopUiPrefs } from "../src/types";

const prefs: DesktopUiPrefs = {
  version: 1,
  completedTaskRetentionMinutes: 1,
  launchMode: "main",
  openFloatingInMainMode: true,
  keepFloatingPanelVisible: false,
  floatingPanelOpacity: 0.82,
  closeBehavior: "ask",
  autoRefreshEnabled: true,
  autoRefreshIntervalSeconds: 9,
  autoRefreshServiceStatusEnabled: true,
  autoRefreshCoreEnabled: true,
  autoRefreshCoreIntervalSeconds: 11,
  autoRefreshKeysEnabled: false,
  autoRefreshKeysIntervalSeconds: 13,
  autoRefreshUsageEnabled: true,
  autoRefreshUsageIntervalSeconds: 15,
  overviewAccountRuntimeTimeoutMs: 4500,
  theme: "titan-noir"
};

const selectedAccount: AccountRuntime = {
  id: "acc-1",
  siteId: "site-1",
  label: "主账号",
  email: "demo@example.com",
  balanceWarning: 10,
  createdAt: "2026-06-18T00:00:00Z",
  updatedAt: "2026-06-18T00:00:00Z",
  sessionState: "ready"
};

function createSyncTask(
  state: SyncTaskCenterTask["state"],
  finishedAt: string | null,
  id = `task-${state}`
): SyncTaskCenterTask {
  return {
    id,
    accountId: "account-1",
    accountLabel: "主账号",
    scope: "full",
    state,
    startedAt: "2026-08-20T00:00:00.000Z",
    finishedAt,
    itemCount: 0,
    error: null,
    failure: null,
    recoveredAt: null,
    progress: null
  };
}

function createSyncStatus(
  overrides: Partial<AccountSyncStatusRecord> = {}
): AccountSyncStatusRecord {
  return {
    accountId: "account-1",
    scope: "full",
    state: "running",
    lastAttemptAt: "2026-08-20T00:00:00.000Z",
    lastSuccessAt: null,
    lastError: null,
    itemCount: 0,
    ...overrides
  };
}

describe("refresh-policy grouped auto refresh", () => {
  it("maps page navs into grouped refresh scopes", () => {
    expect(resolveAutoRefreshScope("overview")).toBe("core");
    expect(resolveAutoRefreshScope("subscriptions")).toBe("core");
    expect(resolveAutoRefreshScope("keys")).toBe("keys");
    expect(resolveAutoRefreshScope("usage")).toBe("usage");
    expect(resolveAutoRefreshScope("modelStats")).toBe("usage");
    expect(resolveAutoRefreshScope("trends")).toBe("usage");
    expect(resolveAutoRefreshScope("settings")).toBe("none");
    expect(resolveAutoRefreshScope("alerts")).toBe("none");
    expect(resolveAutoRefreshScope("systemSettings")).toBe("none");
  });

  it("uses one resource mapping for navigation and grouped policy", () => {
    expect(getAutoRefreshResourceForNav("overview")).toBe("overview");
    expect(getAutoRefreshResourceForNav("subscriptions")).toBe("subscriptions");
    expect(getAutoRefreshResourceForNav("keys")).toBe("keys");
    expect(getAutoRefreshResourceForNav("serviceStatus")).toBe("serviceStatus");
    expect(getAutoRefreshResourceForNav("alerts")).toBeNull();
    expect(resolveAutoRefreshScopeForResource("overview")).toBe("core");
    expect(resolveAutoRefreshScopeForResource("subscriptions")).toBe("core");
    expect(resolveAutoRefreshScopeForResource("keys")).toBe("keys");
    expect(resolveAutoRefreshScopeForResource("usage")).toBe("usage");
    expect(resolveAutoRefreshScopeForResource("settings")).toBe("none");
  });

  it("keeps each grouped interval independent and service status separate", () => {
    expect(resolveAutoRefreshGroupPolicy(prefs, "core")).toEqual({
      enabled: true,
      intervalMs: 11_000
    });
    expect(resolveAutoRefreshGroupPolicy(prefs, "keys")).toEqual({
      enabled: false,
      intervalMs: 13_000
    });
    expect(resolveAutoRefreshGroupPolicy(prefs, "usage")).toEqual({
      enabled: true,
      intervalMs: 15_000
    });
    expect(resolveServiceStatusAutoRefreshPolicy({
      ...prefs,
      autoRefreshEnabled: false
    })).toEqual({
      enabled: false,
      intervalMs: 9_000
    });
    expect(resolveServiceStatusAutoRefreshPolicy({
      ...prefs,
      autoRefreshServiceStatusEnabled: false
    })).toEqual({
      enabled: false,
      intervalMs: 9_000
    });
  });

  it("uses the interval configured for each refresh group", () => {
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "core")).toBe(11);
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "keys")).toBe(13);
    expect(resolveAutoRefreshIntervalSecondsForScope(prefs, "usage")).toBe(15);
  });

  it("blocks auto refresh when the current group is disabled", () => {
    expect(
      shouldAutoRefreshSelectedAccountData({
        nav: "keys",
        autoRefreshEnabled: true,
        pageVisible: true,
        selectedAccount,
        prefs
      })
    ).toBe(false);
  });

  it("allows auto refresh when the current group is enabled", () => {
    expect(
      shouldAutoRefreshSelectedAccountData({
        nav: "usage",
        autoRefreshEnabled: true,
        pageVisible: true,
        selectedAccount,
        prefs
      })
    ).toBe(true);
  });

  it("changes the watcher key when readiness or usage refresh config changes", () => {
    const readyKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount,
      prefs
    });
    const relabeledKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount: {
        ...selectedAccount,
        label: "副账号"
      },
      prefs
    });
    const expiredKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount: {
        ...selectedAccount,
        sessionState: "expired"
      },
      prefs
    });
    const usageDisabledKey = buildAutoRefreshWatcherKey({
      nav: "usage",
      pageVisible: true,
      selectedAccount,
      prefs: {
        ...prefs,
        autoRefreshUsageEnabled: false
      }
    });

    expect(relabeledKey).toBe(readyKey);
    expect(expiredKey).not.toBe(readyKey);
    expect(usageDisabledKey).not.toBe(readyKey);
  });

  it("refreshes switch rules on settings open when account data is not from today", () => {
    expect(
      shouldRefreshSwitchRulesOnSettingsOpen({
        nav: "settings",
        pageVisible: true,
        selectedAccount,
        fetchedAt: "2026-07-01T23:50:00+08:00",
        now: new Date("2026-07-02T00:05:00+08:00")
      })
    ).toBe(true);
    expect(
      shouldRefreshSwitchRulesOnSettingsOpen({
        nav: "settings",
        pageVisible: true,
        selectedAccount,
        fetchedAt: "2026-07-02T00:05:00+08:00",
        now: new Date("2026-07-02T08:05:00+08:00")
      })
    ).toBe(false);
  });
});

describe("completed sync task retention", () => {
  const finishedAt = "2026-08-20T00:00:00.000Z";
  const oneMinuteLater = Date.parse("2026-08-20T00:01:00.000Z");

  it("expires every terminal state by a valid finishedAt while preserving running and invalid records", () => {
    const tasks = [
      createSyncTask("succeeded", finishedAt, "succeeded"),
      createSyncTask("failed", finishedAt, "failed"),
      createSyncTask("interrupted", finishedAt, "interrupted"),
      createSyncTask("running", finishedAt, "running"),
      createSyncTask("failed", null, "missing-finished-at"),
      createSyncTask("succeeded", "not-a-timestamp", "invalid-finished-at")
    ];

    expect(isSyncTaskExpired(tasks[0], 1, oneMinuteLater)).toBe(true);
    expect(isSyncTaskExpired(tasks[3], 1, oneMinuteLater)).toBe(false);
    expect(filterExpiredSyncTasks(tasks, 1, oneMinuteLater).map((task) => task.id)).toEqual([
      "running",
      "missing-finished-at",
      "invalid-finished-at"
    ]);
  });

  it("recalculates immediately when the retention is shortened and schedules the next valid expiry", () => {
    const task = createSyncTask("succeeded", finishedAt);
    const thirtySecondsLater = Date.parse("2026-08-20T00:00:30.000Z");

    expect(filterExpiredSyncTasks([task], 2, oneMinuteLater)).toEqual([task]);
    expect(filterExpiredSyncTasks([task], 1, oneMinuteLater)).toEqual([]);
    expect(getNextSyncTaskExpirationDelay([task], 1, thirtySecondsLater)).toBe(30_000);
    expect(getNextSyncTaskExpirationDelay([createSyncTask("running", finishedAt)], 1, thirtySecondsLater)).toBeNull();
  });

  it("does not revive an expired polled run but keeps a distinct new run", () => {
    const expired = createSyncStatus({
      runId: "run-expired",
      state: "failed",
      finishedAt,
      lastError: "同步失败。"
    });
    const fresh = createSyncStatus({ runId: "run-fresh", state: "running" });

    const expiredPoll = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [],
      previousStatuses: [],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      now: oneMinuteLater
    });
    const freshPoll = mergeAccountSyncStatusesIntoTasks({
      previousTasks: expiredPoll,
      previousStatuses: [expired],
      statuses: [fresh],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      now: oneMinuteLater
    });

    expect(expiredPoll).toEqual([]);
    expect(freshPoll).toMatchObject([
      { id: "account-1:full:run-fresh", state: "running" }
    ]);
  });

  it("keeps an auto-removed run hidden after the retention time is extended", () => {
    const expired = createSyncStatus({
      runId: "run-expired",
      state: "failed",
      finishedAt,
      lastError: "同步失败。"
    });
    const suppressedTaskFinishedAt = new Map<string, string>();

    const afterOneMinute = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [],
      previousStatuses: [],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      onExpiredTask: (taskId, taskFinishedAt) => suppressedTaskFinishedAt.set(taskId, taskFinishedAt),
      now: oneMinuteLater
    });
    const afterExtension = mergeAccountSyncStatusesIntoTasks({
      previousTasks: afterOneMinute,
      previousStatuses: [expired],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 2,
      suppressedTaskFinishedAt,
      now: oneMinuteLater
    });

    expect(afterOneMinute).toEqual([]);
    expect(suppressedTaskFinishedAt).toEqual(new Map([
      ["account-1:full:run-expired", finishedAt]
    ]));
    expect(afterExtension).toEqual([]);
  });

  it("does not revive an expired run when a later terminal payload omits finishedAt", () => {
    const expired = createSyncStatus({
      runId: "run-expired",
      state: "failed",
      finishedAt,
      lastError: "同步失败。"
    });
    const suppressedTaskFinishedAt = new Map<string, string>();
    const afterExpiry = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [],
      previousStatuses: [],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      onExpiredTask: (taskId, taskFinishedAt) => suppressedTaskFinishedAt.set(taskId, taskFinishedAt),
      now: oneMinuteLater
    });

    const afterIncompletePoll = mergeAccountSyncStatusesIntoTasks({
      previousTasks: afterExpiry,
      previousStatuses: [expired],
      statuses: [{ ...expired, finishedAt: null }],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 2,
      suppressedTaskFinishedAt,
      now: oneMinuteLater
    });

    expect(afterIncompletePoll).toEqual([]);
  });

  it("allows a new legacy running task after its expired scope fallback was suppressed", () => {
    const expired = createSyncStatus({
      runId: null,
      state: "failed",
      finishedAt,
      lastError: "同步失败。"
    });
    const suppressedTaskFinishedAt = new Map<string, string>();
    const afterExpiry = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [],
      previousStatuses: [],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      onExpiredTask: (taskId, taskFinishedAt) => suppressedTaskFinishedAt.set(taskId, taskFinishedAt),
      now: oneMinuteLater
    });
    const newLegacyRun = createSyncStatus({ runId: null, state: "running" });
    const afterNewRun = mergeAccountSyncStatusesIntoTasks({
      previousTasks: afterExpiry,
      previousStatuses: [expired],
      statuses: [newLegacyRun],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 2,
      suppressedTaskFinishedAt,
      onNewLegacyTask: (taskId) => suppressedTaskFinishedAt.delete(taskId),
      now: oneMinuteLater
    });

    expect(afterNewRun).toMatchObject([
      { id: "account-1:full", state: "running" }
    ]);
    expect(suppressedTaskFinishedAt).toEqual(new Map());
  });

  it("keeps a suppressed legacy task hidden when a later payload has an invalid finishedAt", () => {
    const expired = createSyncStatus({
      runId: null,
      state: "failed",
      finishedAt,
      lastError: "同步失败。"
    });
    const suppressedTaskFinishedAt = new Map<string, string>();
    const afterExpiry = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [],
      previousStatuses: [],
      statuses: [expired],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      onExpiredTask: (taskId, taskFinishedAt) => suppressedTaskFinishedAt.set(taskId, taskFinishedAt),
      now: oneMinuteLater
    });

    const afterInvalidPoll = mergeAccountSyncStatusesIntoTasks({
      previousTasks: afterExpiry,
      previousStatuses: [expired],
      statuses: [{ ...expired, finishedAt: "not-a-timestamp" }],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 2,
      suppressedTaskFinishedAt,
      onNewLegacyTask: (taskId) => suppressedTaskFinishedAt.delete(taskId),
      now: oneMinuteLater
    });

    expect(afterInvalidPoll).toEqual([]);
    expect(suppressedTaskFinishedAt).toEqual(new Map([
      ["account-1:full", finishedAt]
    ]));
  });

  it("never uses a replacement run's finishedAt for an interrupted run", () => {
    const running = createSyncTask("running", null, "account-1:full:run-a");
    const replacement = createSyncStatus({
      runId: "run-b",
      state: "failed",
      finishedAt: "2026-08-20T00:10:00.000Z",
      lastError: "新任务失败。"
    });

    const tasks = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [running],
      previousStatuses: [],
      statuses: [replacement],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 1,
      now: oneMinuteLater
    });

    expect(tasks).toContainEqual(expect.objectContaining({
      id: "account-1:full:run-a",
      state: "interrupted",
      finishedAt: null
    }));
  });

  it("retains a known terminal finishedAt when a same-run status update omits it", () => {
    const task = createSyncTask("failed", finishedAt, "account-1:full:run-a");
    const incomplete = createSyncStatus({
      runId: "run-a",
      state: "failed",
      finishedAt: null,
      lastError: "同步失败。"
    });

    const tasks = mergeAccountSyncStatusesIntoTasks({
      previousTasks: [task],
      previousStatuses: [],
      statuses: [incomplete],
      accountId: "account-1",
      accountLabel: "主账号",
      completedTaskRetentionMinutes: 2,
      now: oneMinuteLater
    });

    expect(tasks).toContainEqual(expect.objectContaining({
      id: "account-1:full:run-a",
      finishedAt
    }));
  });
});
