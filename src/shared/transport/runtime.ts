import { invoke } from "@tauri-apps/api/core";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
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

export async function accountProxyRequest<T>(
  accountId: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  payload?: unknown
) {
  if (isTauriRuntime()) {
    return invoke<T>("account_proxy_request", {
      accountId,
      path,
      method,
      payload
    });
  }
  return request<T>(`/api/accounts/${accountId}/proxy`, {
    method: "POST",
    body: JSON.stringify({
      path,
      method,
      payload
    })
  });
}
