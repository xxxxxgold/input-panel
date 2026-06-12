import type { AccountRuntime } from "../../types";

export function StatusBadge({ state }: { state: AccountRuntime["sessionState"] }) {
  const label = state === "ready" ? "已连接" : state === "expired" ? "已失效" : "未登录";
  return <span className={`status-pill ${state}`}>{label}</span>;
}
