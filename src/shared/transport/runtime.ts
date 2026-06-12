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
