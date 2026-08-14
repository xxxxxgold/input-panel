import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent
} from "react";

import type { DatabaseStorageStatus } from "../../types";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function canRestoreFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) {
    return !element.disabled;
  }
  return true;
}

export function DatabaseMigrationConfirmDialog({
  status,
  targetDirectory,
  migrationLoading,
  migrationError,
  onCancel,
  onConfirm
}: {
  status: DatabaseStorageStatus;
  targetDirectory: string;
  migrationLoading: boolean;
  migrationError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const busyStatusRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const storageCard = previouslyFocused?.closest<HTMLElement>(
      ".system-settings-card--database-storage"
    ) ?? null;
    confirmButtonRef.current?.focus();
    return () => {
      if (canRestoreFocus(previouslyFocused)) {
        previouslyFocused.focus();
        return;
      }
      const migrationResult = storageCard?.querySelector<HTMLElement>(
        "[data-database-storage-migration-result]"
      );
      if (canRestoreFocus(migrationResult)) {
        migrationResult.focus();
        return;
      }
      storageCard?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    };
  }, []);

  useEffect(() => {
    if (migrationLoading) {
      busyStatusRef.current?.focus();
    }
  }, [migrationLoading]);

  useEffect(() => {
    if (migrationError) {
      errorRef.current?.focus();
    }
  }, [migrationError]);

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !migrationLoading) {
      onCancel();
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!migrationLoading) {
        onCancel();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
    );
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-backdrop modal-visible database-storage-migration-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className={`modal-card database-storage-migration-dialog ${migrationLoading ? "is-busy" : ""}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={migrationLoading}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="modal-header">
          <h3 id={titleId}>确认迁移数据库</h3>
          <button
            type="button"
            className="modal-close-button"
            aria-label="关闭迁移确认"
            onClick={onCancel}
            disabled={migrationLoading}
          >
            <X size={18} />
          </button>
        </header>
        <div className="modal-body database-storage-migration-dialog-body">
          <div className="database-storage-confirmation">
            <p id={descriptionId}>当前数据库会以 SQLite 一致快照迁移，源数据库文件会保留。</p>
            <dl>
              <div>
                <dt>当前数据库</dt>
                <dd>{status.currentDatabasePath}</dd>
              </div>
              <div>
                <dt>目标目录</dt>
                <dd>{targetDirectory}</dd>
              </div>
            </dl>
            <p>
              {status.runtimeScope === "desktop"
                ? "迁移完成后需要重启桌面应用。"
                : "迁移完成后需要重启 Rust 后端。"}
            </p>
            {migrationLoading && (
              <p ref={busyStatusRef} className="database-storage-migration-busy" role="status" tabIndex={-1}>
                数据库迁移正在进行，完成前不能关闭此窗口。
              </p>
            )}
            {migrationError && (
              <div
                ref={errorRef}
                className="database-storage-message database-storage-message--error"
                role="alert"
                tabIndex={-1}
              >
                {migrationError}
              </div>
            )}
          </div>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="ghost-button"
            onClick={onCancel}
            disabled={migrationLoading}
          >
            取消
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            className="inline-text-button"
            onClick={onConfirm}
            disabled={migrationLoading}
          >
            {migrationLoading ? "正在迁移..." : "确认迁移"}
          </button>
        </footer>
      </div>
    </div>
  );
}
