import type { MonitorToast } from "../shared/state/monitor-store";

export function ToastHost({
  toasts,
  onDismiss
}: {
  toasts: MonitorToast[];
  onDismiss: (toastId: string) => void;
}) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className={`toast-card ${toast.tone}${toast.loading ? " loading" : ""}`}
          onClick={() => onDismiss(toast.id)}
        >
          <strong>{toast.loading ? "处理中" : toast.tone === "error" ? "错误" : "提示"}</strong>
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
