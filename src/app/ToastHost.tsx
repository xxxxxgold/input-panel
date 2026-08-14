import { AlertTriangle, CheckCircle2, Info, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

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
      {toasts.map((toast, index) => (
        <ToastCard key={toast.id} toast={toast} index={index} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  index,
  onDismiss
}: {
  toast: MonitorToast;
  index: number;
  onDismiss: (toastId: string) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const progressStyle = {
    "--toast-duration": `${toast.durationMs}ms`
  } as CSSProperties;

  useEffect(() => {
    if (toast.loading) {
      return;
    }
    const timer = window.setTimeout(() => {
      setLeaving(true);
      window.setTimeout(() => onDismiss(toast.id), 220);
    }, toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.durationMs, toast.id, toast.loading, onDismiss]);

  function handleDismiss() {
    setLeaving(true);
    window.setTimeout(() => onDismiss(toast.id), 180);
  }

  function handleAction() {
    onDismiss(toast.id);
    toast.action?.onClick();
  }

  return (
    <section
      className={`toast-card ${toast.tone}${toast.loading ? " loading" : ""}${leaving ? " leaving" : ""}`}
      style={{ animationDelay: `${index * 80}ms` }}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <div className="toast-card-head">
        <div className={`toast-card-icon ${toast.tone}`}>
          {toast.loading ? (
            <LoaderCircle size={16} className="spin" />
          ) : toast.tone === "error" ? (
            <AlertTriangle size={16} />
          ) : toast.tone === "success" ? (
            <CheckCircle2 size={16} />
          ) : (
            <Info size={16} />
          )}
        </div>
        <div className="toast-card-copy">
          <strong>
            {toast.title ?? (toast.loading ? "处理中" : toast.tone === "error" ? "请求失败" : toast.tone === "success" ? "服务已恢复" : "提示")}
          </strong>
          <span>{toast.message}</span>
        </div>
        <div className="toast-card-actions">
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={handleAction}
              aria-label={toast.action.label}
              title={toast.action.label}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button type="button" className="toast-dismiss" onClick={handleDismiss} aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      </div>
      {!toast.loading && (
        <div className="toast-progress-track" aria-hidden="true">
          <div className="toast-progress-bar" style={progressStyle} />
        </div>
      )}
    </section>
  );
}
