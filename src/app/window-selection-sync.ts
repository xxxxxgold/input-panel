export const WINDOW_SELECTION_STORAGE_KEY = "input-panel.window-selection";

export interface WindowSelectionState {
  selectedSiteId: string | null;
  selectedAccountId: string | null;
}

export interface WindowSelectionSyncPayload extends WindowSelectionState {
  revision: number;
}

/** 用单调 revision 阻止旧事件和迟到水合覆盖最新窗口选择。 */
export function createWindowSelectionEventTracker() {
  let eventVersion = 0;
  let highestEventRevision = 0;

  return {
    captureVersion: () => eventVersion,
    acceptRevision(revision: number) {
      if (
        !Number.isSafeInteger(revision)
        || revision <= highestEventRevision
      ) {
        return false;
      }

      highestEventRevision = revision;
      eventVersion += 1;
      return true;
    },
    isCurrent: (capturedVersion: number) => eventVersion === capturedVersion
  };
}

export type WindowSelectionResolutionState =
  | "empty"
  | "resolving"
  | "retryable-error"
  | "resolved";

export interface WindowSelectionResolution {
  state: WindowSelectionResolutionState;
  message: string | null;
}

export function hasSameWindowSelectionIdentity(
  left: WindowSelectionState,
  right: WindowSelectionState
) {
  return left.selectedSiteId === right.selectedSiteId
    && left.selectedAccountId === right.selectedAccountId;
}

export function resolveSelectedSiteAccountFallback(input: {
  selectedSiteId: string | null;
  selectedAccountId: string | null;
  accounts: Array<{ id: string; siteId: string }>;
}) {
  if (!input.selectedSiteId) {
    return input.selectedAccountId;
  }

  const selectedAccount = input.accounts.find((account) => account.id === input.selectedAccountId);
  if (selectedAccount && selectedAccount.siteId !== input.selectedSiteId) {
    return input.accounts.find((account) => account.siteId === input.selectedSiteId)?.id ?? null;
  }

  if (input.selectedAccountId) {
    // A newly created account may not yet exist in the stale overview that preceded its creation.
    return input.selectedAccountId;
  }

  return input.accounts.find((account) => account.siteId === input.selectedSiteId)?.id ?? null;
}

export async function persistAndBroadcastWindowSelection(input: {
  selection: WindowSelectionState;
  revision: number;
  persist: (selection: WindowSelectionState) => Promise<unknown>;
  broadcast: (payload: WindowSelectionSyncPayload) => Promise<unknown>;
  reportError: (stage: "persist" | "broadcast", cause: unknown) => void;
}) {
  let persisted = true;
  try {
    await input.persist(input.selection);
  } catch (cause) {
    persisted = false;
    input.reportError("persist", cause);
  }

  try {
    await input.broadcast({
      ...input.selection,
      revision: input.revision
    });
  } catch (cause) {
    input.reportError("broadcast", cause);
  }

  return { persisted };
}

export function createWindowSelectionSyncQueue(input: {
  initialRevision?: number;
  persist: (selection: WindowSelectionState) => Promise<unknown>;
  broadcast: (payload: WindowSelectionSyncPayload) => Promise<unknown>;
  reportError: (stage: "persist" | "broadcast", cause: unknown) => void;
}) {
  let queue: Promise<{ persisted: boolean }> = Promise.resolve({ persisted: true });
  const revisionSeed = input.initialRevision ?? Date.now() * 1_000;
  // 时间种子保证主窗口重建后 revision 不会重新从 1 开始。
  let revision = Number.isSafeInteger(revisionSeed) && revisionSeed >= 0 ? revisionSeed : 0;

  const enqueue = (selection: WindowSelectionState) => {
    const nextRevision = ++revision;
    const task = () =>
      persistAndBroadcastWindowSelection({
        selection,
        revision: nextRevision,
        persist: input.persist,
        broadcast: input.broadcast,
        reportError: input.reportError
      });

    // Continue after an unexpected task failure so a newer selection cannot be starved.
    queue = queue.then(task, task);
    return queue;
  };

  return {
    enqueue,
    flush: () => queue
  };
}

export function createFloatingPanelSelectionCoordinator(input: {
  subscribe: (listener: (payload: WindowSelectionSyncPayload) => void) => Promise<() => void>;
  readPersisted: () => Promise<WindowSelectionState>;
  applySelection: (selection: WindowSelectionState) => void;
  isPanelDataActive: () => boolean;
  refreshOverview: (selection: WindowSelectionState) => Promise<boolean | void>;
  updateResolution?: (resolution: WindowSelectionResolution) => void;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  reportError: (stage: "hydrate" | "refresh", cause: unknown) => void;
}) {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const eventTracker = createWindowSelectionEventTracker();
  let selectionVersion = 0;
  let lastRefreshedSelectionVersion = 0;
  let refreshingSelectionVersion: number | null = null;
  let hasResolvedSelection = false;
  let currentSelection: WindowSelectionState = {
    selectedSiteId: null,
    selectedAccountId: null
  };
  const retryDelaysMs = input.retryDelaysMs ?? [80, 240];
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  }));

  const updateResolution = (
    state: WindowSelectionResolutionState,
    message: string | null = null
  ) => {
    input.updateResolution?.({ state, message });
  };

  const refreshIfActive = async (options?: { preserveResolvedState?: boolean }) => {
    const preserveResolvedState = options?.preserveResolvedState ?? false;
    if (
      disposed
      || !input.isPanelDataActive()
      || lastRefreshedSelectionVersion === selectionVersion
      || refreshingSelectionVersion === selectionVersion
    ) {
      return false;
    }

    const refreshVersion = selectionVersion;
    const refreshSelection = currentSelection;
    refreshingSelectionVersion = refreshVersion;
    if (!preserveResolvedState) {
      updateResolution("resolving");
    }
    let lastCause: unknown;
    try {
      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
        if (attempt > 0) {
          await wait(retryDelaysMs[attempt - 1]);
        }
        if (
          disposed
          || selectionVersion !== refreshVersion
          || !input.isPanelDataActive()
        ) {
          return false;
        }

        let refreshed = false;
        try {
          refreshed = (await input.refreshOverview(refreshSelection)) !== false;
        } catch (cause) {
          lastCause = cause;
        }

        if (disposed || selectionVersion !== refreshVersion) {
          return false;
        }
        if (refreshed) {
          lastRefreshedSelectionVersion = refreshVersion;
          hasResolvedSelection = true;
          updateResolution(refreshSelection.selectedAccountId ? "resolved" : "empty");
          return true;
        }
      }

      if (lastCause !== undefined) {
        input.reportError("refresh", lastCause);
      }
      if (!preserveResolvedState) {
        updateResolution("retryable-error", "当前账号暂时无法确认，请点击刷新重试。");
      }
      return false;
    } finally {
      if (refreshingSelectionVersion === refreshVersion) {
        refreshingSelectionVersion = null;
      }
    }
  };

  const apply = (selection: WindowSelectionState) => {
    const isSameResolvedAccount = hasResolvedSelection
      && selection.selectedAccountId !== null
      && hasSameWindowSelectionIdentity(currentSelection, selection);
    selectionVersion += 1;
    currentSelection = selection;
    if (isSameResolvedAccount) {
      void refreshIfActive({ preserveResolvedState: true });
      return;
    }
    updateResolution("resolving");
    input.applySelection(selection);
    void refreshIfActive();
  };

  return {
    async start() {
      const cleanup = await input.subscribe((payload) => {
        if (disposed) {
          return;
        }

        if (!eventTracker.acceptRevision(payload.revision)) {
          return;
        }

        apply({
          selectedSiteId: payload.selectedSiteId ?? null,
          selectedAccountId: payload.selectedAccountId ?? null
        });
      });
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;

      const hydrationEventVersion = eventTracker.captureVersion();
      try {
        const selection = await input.readPersisted();
        if (!disposed && eventTracker.isCurrent(hydrationEventVersion)) {
          apply({
            selectedSiteId: selection.selectedSiteId ?? null,
            selectedAccountId: selection.selectedAccountId ?? null
          });
        }
      } catch (cause) {
        if (!disposed) {
          input.reportError("hydrate", cause);
        }
      }
    },
    refreshIfActive,
    dispose() {
      disposed = true;
      unlisten?.();
    }
  };
}

export function readWindowSelection(): WindowSelectionState {
  if (typeof window === "undefined") {
    return {
      selectedSiteId: null,
      selectedAccountId: null
    };
  }

  try {
    const raw = window.localStorage.getItem(WINDOW_SELECTION_STORAGE_KEY);
    if (!raw) {
      return {
        selectedSiteId: null,
        selectedAccountId: null
      };
    }
    const parsed = JSON.parse(raw) as Partial<WindowSelectionState>;
    return {
      selectedSiteId: parsed.selectedSiteId ?? null,
      selectedAccountId: parsed.selectedAccountId ?? null
    };
  } catch {
    return {
      selectedSiteId: null,
      selectedAccountId: null
    };
  }
}

export function writeWindowSelection(selection: WindowSelectionState) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WINDOW_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 浏览器存储失败时不阻断主工作台继续运行。
  }
}
