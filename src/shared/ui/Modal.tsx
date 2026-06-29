import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "../lib/motion";

export function Modal({
  title,
  children,
  onClose,
  onSubmit,
  submitText,
  footer,
  size = "default",
  className,
  bodyClassName,
  footerClassName,
  headerClassName,
  closeText = "关闭"
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitText?: string;
  footer?: ReactNode;
  size?: "default" | "wide";
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  headerClassName?: string;
  closeText?: string | null;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(prefersReducedMotion);

  useEffect(() => {
    if (prefersReducedMotion) {
      setEntered(true);
      return;
    }

    setEntered(false);
    const timerId = window.setTimeout(() => setEntered(true), 16);
    return () => window.clearTimeout(timerId);
  }, [prefersReducedMotion]);

  return (
    <div
      className={`modal-backdrop ${entered ? "modal-visible" : "modal-hidden"}`.trim()}
      onClick={onClose}
      data-motion={prefersReducedMotion ? "reduced" : "full"}
    >
      <div
        className={`modal-card ${size === "wide" ? "wide" : ""} ${className ?? ""}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={`modal-header ${headerClassName ?? ""}`.trim()}>
          <h3>{title}</h3>
          {closeText === null ? (
            <button className="modal-close-button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          ) : (
            <button className="inline-text-button" onClick={onClose}>
              {closeText}
            </button>
          )}
        </header>
        <div className={`modal-body ${bodyClassName ?? ""}`.trim()}>{children}</div>
        {(footer || onSubmit) && (
          <footer className={`modal-footer ${footerClassName ?? ""}`.trim()}>
            {footer ?? (
              <>
                <button className="ghost-button" onClick={onClose}>
                  取消
                </button>
                <button className="primary-button" onClick={onSubmit}>
                  {submitText}
                </button>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
