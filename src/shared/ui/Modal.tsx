import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "../lib/motion";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']"
].join(",");

const modalStack: HTMLElement[] = [];

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true"
  );
}

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
  closeText = "关闭",
  hideCloseButton = false
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
  /** 隐藏标题栏关闭按钮时，仍保留 Esc、遮罩和 onClose 行为。 */
  hideCloseButton?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(prefersReducedMotion);
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (prefersReducedMotion) {
      setEntered(true);
      return;
    }

    setEntered(false);
    const timerId = window.setTimeout(() => setEntered(true), 16);
    return () => window.clearTimeout(timerId);
  }, [prefersReducedMotion]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    modalStack.push(card);

    const focusTimerId = window.setTimeout(() => {
      const initialFocus = card.querySelector<HTMLElement>("[autofocus]")
        ?? getFocusableElements(card)[0]
        ?? card;
      initialFocus.focus({ preventScroll: true });
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== card) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableElements(card);
      if (focusableElements.length === 0) {
        event.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      const focusOutsideDialog = !(activeElement instanceof Node) || !card.contains(activeElement);

      if (event.shiftKey && (activeElement === firstElement || focusOutsideDialog)) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === lastElement || focusOutsideDialog)) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimerId);
      document.removeEventListener("keydown", handleKeyDown);
      const stackIndex = modalStack.lastIndexOf(card);
      if (stackIndex >= 0) {
        modalStack.splice(stackIndex, 1);
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      className={`modal-backdrop ${entered ? "modal-visible" : "modal-hidden"}`.trim()}
      onClick={onClose}
      data-motion={prefersReducedMotion ? "reduced" : "full"}
    >
      <div
        ref={cardRef}
        className={`modal-card ${size === "wide" ? "wide" : ""} ${className ?? ""}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={`modal-header ${headerClassName ?? ""}`.trim()}>
          <h3 id={titleId}>{title}</h3>
          {!hideCloseButton ? (
            <button
              type="button"
              className="modal-close-button"
              onClick={onClose}
              aria-label={closeText ?? "关闭"}
            >
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </header>
        <div className={`modal-body ${bodyClassName ?? ""}`.trim()}>{children}</div>
        {(footer || onSubmit) && (
          <footer className={`modal-footer ${footerClassName ?? ""}`.trim()}>
            {footer ?? (
              <>
                <button type="button" className="ghost-button" onClick={onClose}>
                  取消
                </button>
                <button type="button" className="primary-button" onClick={onSubmit}>
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
