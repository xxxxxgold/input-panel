export type ScopedResourceStatus = "idle" | "loading" | "success" | "error";

export type ScopedResourceEntry<T> = {
  hasSnapshot: boolean;
  data: T | undefined;
  status: ScopedResourceStatus;
  initialLoading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: number | null;
  requestId: number;
};

export type ScopedLoadResult<T> =
  | {
      status: "success";
      data: T;
      entry: ScopedResourceEntry<T>;
    }
  | {
      status: "error";
      error: Error;
      entry: ScopedResourceEntry<T>;
    }
  | {
      status: "cancelled";
      entry: ScopedResourceEntry<T>;
    };

export type ScopedResourceLoadOptions = {
  force?: boolean;
};

export type ScopedResourceCacheOptions = {
  maxEntries?: number;
  now?: () => number;
};

const DEFAULT_MAX_ENTRIES = 160;

function toError(cause: unknown) {
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(typeof cause === "string" && cause.trim() ? cause : "请求失败");
}

export function buildScopedResourceKey(resource: string, identity: unknown = null) {
  const normalizedResource = resource.trim();
  if (!normalizedResource) {
    throw new Error("资源缓存键必须包含资源类型。");
  }
  return `${normalizedResource}:${stableSerialize(identity)}`;
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

function normalizeStableValue(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeStableValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeStableValue(record[key])])
    );
  }
  return value;
}

export class ScopedResourceCache<T> {
  private readonly entries = new Map<string, ScopedResourceEntry<T>>();
  private readonly versions = new Map<string, number>();
  private readonly inFlight = new Map<string, {
    token: symbol;
    promise: Promise<ScopedLoadResult<T>>;
  }>();
  private readonly listeners = new Set<() => void>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ScopedResourceCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError("maxEntries 必须是正整数。");
    }
  }

  get(key: string): ScopedResourceEntry<T> {
    const entry = this.entries.get(key);
    if (entry) {
      this.touch(key, entry);
      return entry;
    }
    return this.emptyEntry(key);
  }

  peek(key: string): ScopedResourceEntry<T> {
    return this.entries.get(key) ?? this.emptyEntry(key);
  }

  setSnapshot(key: string, data: T, updatedAt = this.now()) {
    const requestId = this.nextVersion(key);
    const entry: ScopedResourceEntry<T> = {
      hasSnapshot: true,
      data,
      status: "success",
      initialLoading: false,
      refreshing: false,
      error: null,
      updatedAt,
      requestId
    };
    this.store(key, entry);
    this.inFlight.delete(key);
    this.notify();
    return entry;
  }

  clearError(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.error === null) {
      return;
    }
    this.store(key, { ...entry, error: null, status: entry.hasSnapshot ? "success" : "idle" });
    this.notify();
  }

  invalidate(key: string) {
    this.nextVersion(key);
    this.entries.delete(key);
    this.inFlight.delete(key);
    this.notify();
  }

  cancel(key: string) {
    const current = this.entries.get(key);
    if (!current && !this.inFlight.has(key)) {
      return false;
    }
    const requestId = this.nextVersion(key);
    this.inFlight.delete(key);
    if (current) {
      this.store(key, {
        ...current,
        status: current.hasSnapshot ? "success" : "idle",
        initialLoading: false,
        refreshing: false,
        requestId
      });
    }
    this.notify();
    return true;
  }

  cancelWhere(predicate: (key: string) => boolean) {
    let changed = false;
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (!predicate(key)) {
        continue;
      }
      const current = this.entries.get(key);
      const requestId = this.nextVersion(key);
      this.inFlight.delete(key);
      if (current) {
        this.store(key, {
          ...current,
          status: current.hasSnapshot ? "success" : "idle",
          initialLoading: false,
          refreshing: false,
          requestId
        });
      }
      changed = true;
    }
    if (changed) {
      this.notify();
    }
  }

  invalidateWhere(predicate: (key: string) => boolean) {
    let changed = false;
    for (const key of [...this.entries.keys(), ...this.versions.keys()]) {
      if (!predicate(key)) {
        continue;
      }
      this.nextVersion(key);
      this.entries.delete(key);
      this.inFlight.delete(key);
      changed = true;
    }
    if (changed) {
      this.notify();
    }
  }

  clear() {
    if (this.entries.size === 0 && this.versions.size === 0 && this.inFlight.size === 0) {
      return;
    }
    for (const key of new Set([...this.entries.keys(), ...this.versions.keys(), ...this.inFlight.keys()])) {
      this.nextVersion(key);
    }
    this.entries.clear();
    this.inFlight.clear();
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  load(key: string, loader: () => Promise<T>, options: ScopedResourceLoadOptions = {}) {
    const running = this.inFlight.get(key);
    if (running && !options.force) {
      return running.promise;
    }

    const current = this.entries.get(key) ?? this.emptyEntry(key);
    const requestId = this.nextVersion(key);
    const pending: ScopedResourceEntry<T> = {
      ...current,
      status: current.hasSnapshot ? "success" : "loading",
      initialLoading: !current.hasSnapshot,
      refreshing: current.hasSnapshot,
      error: null,
      requestId
    };
    this.store(key, pending);
    this.notify();

    const token = Symbol(key);
    let request: Promise<T>;
    try {
      request = loader();
    } catch (cause) {
      request = Promise.reject(cause);
    }
    const task: Promise<ScopedLoadResult<T>> = (async () => {
      try {
        const data = await request;
        if (!this.isCurrent(key, requestId)) {
          return { status: "cancelled", entry: this.get(key) };
        }
        const entry: ScopedResourceEntry<T> = {
          hasSnapshot: true,
          data,
          status: "success",
          initialLoading: false,
          refreshing: false,
          error: null,
          updatedAt: this.now(),
          requestId
        };
        this.store(key, entry);
        this.notify();
        return { status: "success", data, entry };
      } catch (cause) {
        const error = toError(cause);
        if (!this.isCurrent(key, requestId)) {
          return { status: "cancelled", entry: this.get(key) };
        }
        const entry: ScopedResourceEntry<T> = {
          ...pending,
          status: "error",
          initialLoading: false,
          refreshing: false,
          error: error.message,
          requestId
        };
        this.store(key, entry);
        this.notify();
        return { status: "error", error, entry };
      } finally {
        if (this.inFlight.get(key)?.token === token) {
          this.inFlight.delete(key);
        }
      }
    })();

    this.inFlight.set(key, { token, promise: task });
    return task;
  }

  private emptyEntry(key: string): ScopedResourceEntry<T> {
    return {
      hasSnapshot: false,
      data: undefined,
      status: "idle",
      initialLoading: false,
      refreshing: false,
      error: null,
      updatedAt: null,
      requestId: this.versions.get(key) ?? 0
    };
  }

  private isCurrent(key: string, requestId: number) {
    return this.versions.get(key) === requestId && this.entries.has(key);
  }

  private nextVersion(key: string) {
    const next = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, next);
    return next;
  }

  private store(key: string, entry: ScopedResourceEntry<T>) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.entries.delete(oldestKey);
      this.nextVersion(oldestKey);
      this.inFlight.delete(oldestKey);
    }
  }

  private touch(key: string, entry: ScopedResourceEntry<T>) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
