import { invoke } from "@tauri-apps/api/core";

import type {
  SyncFailureCategory,
  SyncFailurePayload,
  SyncFailureResponse,
  TransportErrorPayload
} from "../../types";

const inflightReadonlyRequests = new Map<string, Promise<unknown>>();

export class AppRequestError extends Error {
  readonly failure: SyncFailurePayload | null;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAt: string | null;
  readonly retryAfterMs: number | null;
  readonly httpStatus: number | null;

  constructor(message: string, options: {
    failure?: SyncFailurePayload | null;
    status?: number | null;
    code?: string | null;
    retryAt?: string | null;
    retryAfterMs?: number | null;
    httpStatus?: number | null;
  } = {}) {
    super(message);
    this.name = "AppRequestError";
    this.failure = options.failure ?? null;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryAt = options.retryAt ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}

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
    const data: unknown = await response.json().catch(() => null);
    throw requestErrorFromUnknown(data, response.status);
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
    try {
      return await invoke<T>(options.command, options.args);
    } catch (cause) {
      throw requestErrorFromUnknown(cause, null);
    }
  }
  return request<T>(options.url, options.init);
}

/** 将 HTTP/Tauri 的未知 rejection 收敛为统一且可安全展示的请求错误。 */
export function requestErrorFromUnknown(cause: unknown, status: number | null) {
  if (cause instanceof AppRequestError) {
    return cause;
  }
  const transportError = parseTransportErrorPayload(cause);
  if (transportError) {
    return new AppRequestError(transportError.error, {
      status: status ?? transportError.httpStatus ?? null,
      code: transportError.code,
      retryAt: transportError.retryAt ?? null,
      retryAfterMs: transportError.retryAfterMs ?? null,
      httpStatus: transportError.httpStatus ?? status
    });
  }
  const response = parseSyncFailureResponse(cause);
  if (response) {
    return new AppRequestError(response.error || response.failure.message, {
      failure: response.failure,
      status: status ?? response.failure.httpStatus ?? null,
      code: response.failure.code ?? null,
      retryAt: response.failure.retryAt ?? null,
      retryAfterMs: response.failure.retryAfterMs ?? null,
      httpStatus: response.failure.httpStatus ?? status
    });
  }
  if (cause instanceof Error) {
    return cause;
  }
  if (isRecord(cause) && typeof cause.error === "string") {
    return new AppRequestError(cause.error, { status, httpStatus: status });
  }
  if (typeof cause === "string" && cause.trim()) {
    return new AppRequestError(cause, { status, httpStatus: status });
  }
  return new AppRequestError(status == null ? "请求失败。" : `Request failed: ${status}`, {
    status,
    httpStatus: status
  });
}

function parseTransportErrorPayload(value: unknown): TransportErrorPayload | null {
  if (!isRecord(value) || typeof value.error !== "string" || !isErrorCode(value.code)) {
    return null;
  }
  if (
    !isOptionalHttpStatus(value.httpStatus)
    || !isOptionalRetryAt(value.retryAt)
    || !isOptionalNonNegativeInteger(value.retryAfterMs)
  ) {
    return null;
  }

  return {
    error: value.error,
    code: value.code,
    ...(typeof value.httpStatus === "number" ? { httpStatus: value.httpStatus } : {}),
    ...(typeof value.retryAt === "string" ? { retryAt: value.retryAt } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {})
  };
}

function parseSyncFailureResponse(value: unknown): SyncFailureResponse | null {
  if (!isRecord(value) || typeof value.error !== "string" || !isRecord(value.failure)) {
    return null;
  }
  const failure = value.failure;
  if (
    !isSyncFailureCategory(failure.category)
    || typeof failure.message !== "string"
    || typeof failure.retryExhausted !== "boolean"
    || !isOptionalErrorCode(failure.code)
    || !isOptionalHttpStatus(failure.httpStatus)
    || !isOptionalRetryAt(failure.retryAt)
    || !isOptionalNonNegativeInteger(failure.retryAfterMs)
  ) {
    return null;
  }

  const parsedFailure: SyncFailurePayload = {
    category: failure.category,
    message: failure.message,
    retryExhausted: failure.retryExhausted
  };
  if (typeof failure.httpStatus === "number") {
    parsedFailure.httpStatus = failure.httpStatus;
  }
  if (typeof failure.code === "string") {
    parsedFailure.code = failure.code;
  }
  if (typeof failure.retryAt === "string") {
    parsedFailure.retryAt = failure.retryAt;
  }
  if (typeof failure.retryAfterMs === "number") {
    parsedFailure.retryAfterMs = failure.retryAfterMs;
  }

  return {
    error: value.error,
    failure: parsedFailure
  };
}

function isSyncFailureCategory(value: unknown): value is SyncFailureCategory {
  return value === "unauthorized"
    || value === "rate_limited"
    || value === "http"
    || value === "timeout"
    || value === "transport"
    || value === "decode"
    || value === "business"
    || value === "internal";
}

function isOptionalHttpStatus(value: unknown) {
  return value == null
    || (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
}

function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);
}

function isOptionalErrorCode(value: unknown) {
  return value == null || isErrorCode(value);
}

function isOptionalRetryAt(value: unknown) {
  return value == null
    || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value)));
}

function isOptionalNonNegativeInteger(value: unknown) {
  return value == null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
