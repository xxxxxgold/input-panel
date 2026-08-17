import type { DesktopUiPrefs, DesktopUiPrefsPatch } from "../../types";

export const DESKTOP_UI_PREFS_DEBOUNCE_MS = 180;

export type DesktopUiPrefsField = keyof DesktopUiPrefsPatch;
export type DesktopUiPrefsSavePhase = "idle" | "saving" | "failed";

export type DesktopUiPrefsSaveState = {
  phase: DesktopUiPrefsSavePhase;
  pendingFields: DesktopUiPrefsField[];
  savingFields: DesktopUiPrefsField[];
  failedFields: DesktopUiPrefsField[];
  error: string | null;
  lastSavedAt: number | null;
};

export type DesktopUiPrefsSaveResult =
  | { ok: true; prefs: DesktopUiPrefs }
  | { ok: false; prefs: DesktopUiPrefs; error: string };

export type DesktopUiPrefsQueueSnapshot = {
  optimisticPrefs: DesktopUiPrefs;
  confirmedPrefs: DesktopUiPrefs;
  saveState: DesktopUiPrefsSaveState;
};

type SaveTransport = (patch: DesktopUiPrefsPatch) => Promise<DesktopUiPrefs>;

type QueueOptions = {
  initialPrefs: DesktopUiPrefs;
  normalize: (prefs: DesktopUiPrefs) => DesktopUiPrefs;
  persistPatch: SaveTransport;
  onSnapshot: (snapshot: DesktopUiPrefsQueueSnapshot) => void;
  onConfirmed?: (prefs: DesktopUiPrefs) => void;
  debounceMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

type EnqueueOptions = {
  debounce?: boolean;
  transport?: SaveTransport;
};

type AcceptConfirmedOptions = {
  persistToBrowser?: boolean;
  markSaved?: boolean;
};

type FieldOperation = {
  field: DesktopUiPrefsField;
  value: DesktopUiPrefs[DesktopUiPrefsField];
  revision: number;
  readyAt: number;
  phase: "pending" | "saving" | "failed";
  error: string | null;
  transport?: SaveTransport;
};

type SaveWaiter = {
  revisions: Map<DesktopUiPrefsField, number>;
  resolve: (result: DesktopUiPrefsSaveResult) => void;
};

export type DesktopUiPrefsSaveQueue = {
  acceptConfirmed: (prefs: DesktopUiPrefs, options?: AcceptConfirmedOptions) => void;
  enqueue: (patch: DesktopUiPrefsPatch, options?: EnqueueOptions) => Promise<DesktopUiPrefsSaveResult>;
  retryFailed: (fields?: DesktopUiPrefsField[]) => void;
  getOptimisticPrefs: () => DesktopUiPrefs;
  getConfirmedPrefs: () => DesktopUiPrefs;
  dispose: () => void;
};

function getPatchFields(patch: DesktopUiPrefsPatch): DesktopUiPrefsField[] {
  return (Object.keys(patch) as DesktopUiPrefsField[]).filter(
    (field) => patch[field] !== undefined
  );
}

function errorMessage(cause: unknown) {
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  return "设置保存失败，请重试。";
}

export function createDesktopUiPrefsSaveQueue(options: QueueOptions): DesktopUiPrefsSaveQueue {
  const debounceMs = options.debounceMs ?? DESKTOP_UI_PREFS_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));

  let confirmedPrefs = options.normalize(options.initialPrefs);
  let revision = 0;
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedAt: number | null = null;
  const operations = new Map<DesktopUiPrefsField, FieldOperation>();
  const waiters: SaveWaiter[] = [];

  function getOptimisticPrefs() {
    const next = { ...confirmedPrefs };
    for (const operation of operations.values()) {
      (next as Record<string, unknown>)[operation.field] = operation.value;
    }
    return options.normalize(next);
  }

  function currentSaveState(): DesktopUiPrefsSaveState {
    const pendingFields: DesktopUiPrefsField[] = [];
    const savingFields: DesktopUiPrefsField[] = [];
    const failedFields: DesktopUiPrefsField[] = [];
    let error: string | null = null;

    for (const operation of operations.values()) {
      if (operation.phase === "pending") {
        pendingFields.push(operation.field);
      } else if (operation.phase === "saving") {
        savingFields.push(operation.field);
      } else {
        failedFields.push(operation.field);
        error ??= operation.error;
      }
    }

    return {
      phase:
        failedFields.length > 0
          ? "failed"
          : pendingFields.length > 0 || savingFields.length > 0 || active
            ? "saving"
            : "idle",
      pendingFields,
      savingFields,
      failedFields,
      error,
      lastSavedAt
    };
  }

  function emitSnapshot() {
    if (disposed) {
      return;
    }
    options.onSnapshot({
      optimisticPrefs: getOptimisticPrefs(),
      confirmedPrefs,
      saveState: currentSaveState()
    });
  }

  function settleWaiters() {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const failed = [...waiter.revisions].find(([field, targetRevision]) => {
        const operation = operations.get(field);
        return (
          operation?.phase === "failed"
          && operation.revision >= targetRevision
        );
      });
      if (failed) {
        const operation = operations.get(failed[0]);
        waiters.splice(index, 1);
        waiter.resolve({
          ok: false,
          prefs: getOptimisticPrefs(),
          error: operation?.error ?? "设置保存失败，请重试。"
        });
        continue;
      }

      const waiting = [...waiter.revisions].some(([field]) => operations.has(field));
      if (!waiting) {
        waiters.splice(index, 1);
        waiter.resolve({ ok: true, prefs: confirmedPrefs });
      }
    }
  }

  function clearScheduledFlush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function scheduleFlush() {
    if (disposed || active) {
      return;
    }
    clearScheduledFlush();
    const pending = [...operations.values()].filter((operation) => operation.phase === "pending");
    if (pending.length === 0) {
      return;
    }
    const earliestReadyAt = Math.min(...pending.map((operation) => operation.readyAt));
    const delayMs = Math.max(0, earliestReadyAt - now());
    timer = setTimer(() => {
      timer = null;
      void flushReadyOperations();
    }, delayMs);
  }

  async function flushReadyOperations() {
    if (disposed || active) {
      return;
    }

    const currentTime = now();
    const ready = [...operations.values()]
      .filter((operation) => operation.phase === "pending" && operation.readyAt <= currentTime)
      .sort((left, right) => left.revision - right.revision);
    if (ready.length === 0) {
      scheduleFlush();
      return;
    }

    const customOperation = ready.find((operation) => operation.transport);
    const selected = customOperation
      ? ready.filter((operation) => operation.transport === customOperation.transport)
      : ready.filter((operation) => !operation.transport);
    const patch: DesktopUiPrefsPatch = {};
    const sentRevisions = new Map<DesktopUiPrefsField, number>();
    for (const operation of selected) {
      (patch as Record<string, unknown>)[operation.field] = operation.value;
      sentRevisions.set(operation.field, operation.revision);
      operation.phase = "saving";
      operation.error = null;
    }

    active = true;
    emitSnapshot();
    const transport = customOperation?.transport ?? options.persistPatch;
    try {
      confirmedPrefs = options.normalize(await transport(patch));
      lastSavedAt = now();
      options.onConfirmed?.(confirmedPrefs);
      for (const [field, sentRevision] of sentRevisions) {
        const current = operations.get(field);
        if (current?.revision === sentRevision) {
          operations.delete(field);
        }
      }
    } catch (cause) {
      const message = errorMessage(cause);
      for (const [field, sentRevision] of sentRevisions) {
        const current = operations.get(field);
        if (current?.revision === sentRevision) {
          current.phase = "failed";
          current.error = message;
        }
      }
    } finally {
      active = false;
      emitSnapshot();
      settleWaiters();
      scheduleFlush();
    }
  }

  function acceptConfirmed(prefs: DesktopUiPrefs, acceptOptions: AcceptConfirmedOptions = {}) {
    confirmedPrefs = options.normalize(prefs);
    if (acceptOptions.markSaved) {
      lastSavedAt = now();
    }
    if (acceptOptions.persistToBrowser) {
      options.onConfirmed?.(confirmedPrefs);
    }
    emitSnapshot();
    settleWaiters();
  }

  function enqueue(
    patch: DesktopUiPrefsPatch,
    enqueueOptions: EnqueueOptions = {}
  ): Promise<DesktopUiPrefsSaveResult> {
    if (disposed) {
      return Promise.resolve({
        ok: false,
        prefs: getOptimisticPrefs(),
        error: "设置保存队列已关闭。"
      });
    }

    const fields = getPatchFields(patch);
    if (fields.length === 0) {
      return Promise.resolve({ ok: true, prefs: getOptimisticPrefs() });
    }

    const next = { ...getOptimisticPrefs() };
    for (const field of fields) {
      (next as Record<string, unknown>)[field] = patch[field];
    }
    const normalized = options.normalize(next);
    const readyAt = now() + (enqueueOptions.debounce ? debounceMs : 0);
    const revisions = new Map<DesktopUiPrefsField, number>();
    for (const field of fields) {
      revision += 1;
      revisions.set(field, revision);
      operations.set(field, {
        field,
        value: normalized[field],
        revision,
        readyAt,
        phase: "pending",
        error: null,
        transport: enqueueOptions.transport
      });
    }

    emitSnapshot();
    scheduleFlush();
    return new Promise((resolve) => {
      waiters.push({ revisions, resolve });
      settleWaiters();
    });
  }

  function retryFailed(fields?: DesktopUiPrefsField[]) {
    const filter = fields ? new Set(fields) : null;
    let changed = false;
    for (const operation of operations.values()) {
      if (operation.phase !== "failed" || (filter && !filter.has(operation.field))) {
        continue;
      }
      operation.phase = "pending";
      operation.error = null;
      operation.readyAt = now();
      changed = true;
    }
    if (changed) {
      emitSnapshot();
      scheduleFlush();
    }
  }

  function dispose() {
    disposed = true;
    clearScheduledFlush();
    const prefs = getOptimisticPrefs();
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ ok: false, prefs, error: "设置保存队列已关闭。" });
    }
  }

  return {
    acceptConfirmed,
    enqueue,
    retryFailed,
    getOptimisticPrefs,
    getConfirmedPrefs: () => confirmedPrefs,
    dispose
  };
}
