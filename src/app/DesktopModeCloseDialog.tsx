import { useState } from "react";

import { Modal } from "../shared/ui/Modal";
import type { CloseBehavior } from "../types";

type RememberedCloseBehavior = Exclude<CloseBehavior, "ask">;

export function resolveRememberedCloseBehavior(
  rememberChoice: boolean,
  behavior: RememberedCloseBehavior
): RememberedCloseBehavior | null {
  return rememberChoice ? behavior : null;
}

export function DesktopModeCloseDialog({
  onClose,
  onExit,
  onSwitchToFloating
}: {
  onClose: () => void;
  onExit: (remember: CloseBehavior | null) => void;
  onSwitchToFloating: (remember: CloseBehavior | null) => void;
}) {
  const [rememberChoice, setRememberChoice] = useState(false);

  return (
    <Modal
      title="关闭主窗口"
      onClose={onClose}
      closeText={null}
      footer={
        <div className="desktop-mode-dialog-footer">
          <label className="desktop-mode-dialog-remember">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(event) => setRememberChoice(event.target.checked)}
            />
            <span>记住本次选择</span>
          </label>
          <div className="desktop-mode-dialog-actions">
            <button
              className="primary-button"
              onClick={() =>
                onSwitchToFloating(
                  resolveRememberedCloseBehavior(rememberChoice, "switch_to_floating")
                )
              }
            >
              最小化
            </button>
            <button
              className="ghost-button"
              onClick={() =>
                onExit(resolveRememberedCloseBehavior(rememberChoice, "exit_app"))
              }
            >
              退出应用
            </button>
          </div>
        </div>
      }
    >
      <div className="stack-list">
        <p className="modal-hint">
          你当前处于主窗口模式。可以直接退出应用，也可以最小化主窗口并进入悬浮窗模式继续常驻托盘。
        </p>
      </div>
    </Modal>
  );
}
