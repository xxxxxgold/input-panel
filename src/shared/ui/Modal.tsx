import { X } from "lucide-react";
import type { ReactNode } from "react";

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
  return (
    <div className="modal-backdrop" onClick={onClose}>
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
