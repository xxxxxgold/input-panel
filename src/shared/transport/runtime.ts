import { invoke } from "@tauri-apps/api/core";

const inflightReadonlyRequests = new Map<string, Promise<unknown>>();

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  if (shouldDeduplicateReadonlyRequest(init)) {
    const requestKey = buildReadonlyRequestKey(input, init);
    const inflight = inflightReadonlyRequests.get(requestKey) as Promise<T> | undefined;
    if (inflight) {
      return inflight;
    }

    const pending = performRequest<T>(input, init).finally(() => {
      inflightReadonlyRequests.delete(requestKey);
    });
    inflightReadonlyRequests.set(requestKey, pending as Promise<unknown>);
    return pending;
  }

  return performRequest<T>(input, init);
}

async function performRequest<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function shouldDeduplicateReadonlyRequest(init?: RequestInit) {
  return resolveRequestMethod(init) === "GET" && !init?.signal;
}

function buildReadonlyRequestKey(input: RequestInfo, init?: RequestInit) {
  return `${resolveRequestMethod(init)} ${resolveRequestUrl(input)}`;
}

function resolveRequestMethod(init?: RequestInit) {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveRequestUrl(input: RequestInfo) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export async function desktopOrHttp<T>(options: {
  command: string;
  args?: Record<string, unknown>;
  url: string;
  init?: RequestInit;
}) {
  if (isTauriRuntime()) {
    return invoke<T>(options.command, options.args);
  }
  return request<T>(options.url, options.init);
}
