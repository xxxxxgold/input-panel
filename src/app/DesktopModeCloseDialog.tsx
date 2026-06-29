import { Modal } from "../shared/ui/Modal";
import type { CloseBehavior } from "../types";

export function DesktopModeCloseDialog({
  onClose,
  onExit,
  onSwitchToFloating
}: {
  onClose: () => void;
  onExit: (remember: CloseBehavior | null) => void;
  onSwitchToFloating: (remember: CloseBehavior | null) => void;
}) {
  return (
    <Modal
      title="关闭主窗口"
      onClose={onClose}
      closeText={null}
      footer={
        <div className="desktop-mode-dialog-footer">
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="ghost-button" onClick={() => onExit(null)}>
            仅退出一次
          </button>
          <button className="ghost-button" onClick={() => onExit("exit_app")}>
            退出并记住
          </button>
          <button className="primary-button" onClick={() => onSwitchToFloating(null)}>
            仅切换一次
          </button>
          <button className="primary-button" onClick={() => onSwitchToFloating("switch_to_floating")}>
            切换并记住
          </button>
        </div>
      }
    >
      <div className="stack-list">
        <p className="modal-hint">
          你当前处于主窗口模式。可以直接退出程序，也可以隐藏主窗口并进入悬浮窗模式继续常驻托盘。
        </p>
      </div>
    </Modal>
  );
}
