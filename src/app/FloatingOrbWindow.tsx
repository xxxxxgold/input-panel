import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import floatingOrbAvatar from "../assets/floating-orb-avatar.png";
import {
  openMainWindow,
  positionFloatingPanel,
  setFloatingPanelVisible,
  showFloatingContextMenu
} from "../features/desktop-ui/client";
import {
  computeOrbPosition,
  computePanelWindowPosition,
  FLOATING_ORB_SIZE,
  resolveFloatingDock,
  type FloatingPanelKey,
  type FloatingWorkArea
} from "./floating-layout";
import { isTauriRuntime } from "../shared/transport/runtime";

type FloatingPanelSelectPayload = {
  panel: FloatingPanelKey;
};

type FloatingPanelHoverPayload = {
  hovering: boolean;
};

type FloatingContextActionPayload = {
  action: "toggle-panel" | "open-main";
};

type FloatingNativePanelVisibilityPayload = {
  visible: boolean;
};

function getDefaultWorkArea(): FloatingWorkArea {
  if (typeof window === "undefined") {
    return { x: 0, y: 0, width: 1280, height: 720 };
  }
  return {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };
}

async function ensurePanelWindow() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await WebviewWindow.getByLabel("floating-panel");
    if (existing) {
      return existing;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }
  throw new Error("floating-panel window not ready");
}

async function ignoreWindowMutation(task: Promise<unknown>) {
  try {
    await task;
  } catch {
    // 某些 Windows/Tauri 组合下窗口属性调用会偶发失败, 不能阻断后续初始化链路。
  }
}

export function FloatingOrbWindow({ keepPanelVisible = false }: { keepPanelVisible?: boolean }) {
  const nativeFloatingInput = isTauriRuntime();
  const [dock, setDock] = useState<"left" | "right">("right");
  const [workArea, setWorkArea] = useState<FloatingWorkArea>(getDefaultWorkArea);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<FloatingPanelKey>("overview");
  const [dragging, setDragging] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const panelHoveringRef = useRef(false);
  const dockRef = useRef<"left" | "right">("right");
  const workAreaRef = useRef<FloatingWorkArea>(getDefaultWorkArea());
  const activePanelRef = useRef<FloatingPanelKey>("overview");
  const menuOpenRef = useRef(false);
  const draggingRef = useRef(false);
  const pointerSessionRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startWindowX: number;
    startWindowY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    dockRef.current = dock;
  }, [dock]);

  useEffect(() => {
    workAreaRef.current = workArea;
  }, [workArea]);

  useEffect(() => {
    activePanelRef.current = activePanel;
  }, [activePanel]);

  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);

  useEffect(() => {
    if (nativeFloatingInput) {
      return;
    }

    if (keepPanelVisible) {
      clearHideTimer();
      setMenuOpenState(true);
      void openPanelWindow();
      return;
    }

    if (!panelHoveringRef.current && !draggingRef.current) {
      setMenuOpenState(false);
      void closePanelWindow();
    }
  }, [keepPanelVisible, nativeFloatingInput]);

  function setMenuOpenState(next: boolean) {
    menuOpenRef.current = next;
    setMenuOpen(next);
  }

  function setDraggingState(next: boolean) {
    draggingRef.current = next;
    setDragging(next);
  }

  function markDock(next: "left" | "right") {
    if (dockRef.current === next) {
      return;
    }
    dockRef.current = next;
    setDock(next);
  }

  function markWorkArea(next: FloatingWorkArea) {
    const current = workAreaRef.current;
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return;
    }
    workAreaRef.current = next;
    setWorkArea(next);
  }

  function beginNativePointerSession(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    // WebView2 owns the renderer HWND, so its pointerdown is the reliable edge for
    // the native poller to start tracking a short click or a drag that exits the orb.
    void invoke("begin_floating_native_pointer_session").catch(() => undefined);
  }

  function handleHoverOpen() {
    if (nativeFloatingInput || keepPanelVisible) {
      return;
    }
    clearHideTimer();
    setMenuOpenState(true);
    void openPanelWindow();
  }

  useEffect(() => {
    document.title = "Input悬浮图标";
    document.documentElement.classList.add("floating-orb-root");
    document.body.classList.add("floating-window-body");
    document.body.classList.add("floating-orb-window-body");
    document.getElementById("root")?.classList.add("floating-orb-root");
    return () => {
      document.title = "Input悬浮图标";
      document.documentElement.classList.remove("floating-orb-root");
      document.body.classList.remove("floating-window-body");
      document.body.classList.remove("floating-orb-window-body");
      document.getElementById("root")?.classList.remove("floating-orb-root");
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenMoved: (() => void) | undefined;
    let unlistenPanelSelect: (() => void) | undefined;
    let unlistenPanelHover: (() => void) | undefined;
    let unlistenContextAction: (() => void) | undefined;
    let unlistenNativePanelVisibility: (() => void) | undefined;

    async function setup() {
      const appWindow = getCurrentWindow();
      if (!nativeFloatingInput) {
        await ignoreWindowMutation(appWindow.setSize(new LogicalSize(FLOATING_ORB_SIZE, FLOATING_ORB_SIZE)));
      }
      await ignoreWindowMutation(appWindow.setDecorations(false));
      await ignoreWindowMutation(appWindow.setResizable(false));
      await ignoreWindowMutation(appWindow.setAlwaysOnTop(true));
      await ignoreWindowMutation(appWindow.setShadow(false));

      const monitor = await currentMonitor();
      const nextWorkArea =
        monitor != null
          ? {
              x: monitor.workArea.position.x,
              y: monitor.workArea.position.y,
              width: monitor.workArea.size.width,
              height: monitor.workArea.size.height
            }
          : workAreaRef.current;
      if (active) {
        markWorkArea(nextWorkArea);
      }
      const position = await appWindow.outerPosition();
      const nextDock = resolveFloatingDock(position.x + FLOATING_ORB_SIZE / 2, nextWorkArea);
      if (active) {
        markDock(nextDock);
      }

      if (!nativeFloatingInput) {
        window.setTimeout(() => {
          void ignoreWindowMutation(appWindow.setSize(new LogicalSize(FLOATING_ORB_SIZE, FLOATING_ORB_SIZE)));
        }, 160);
      }

      await ensurePanelWindow();

      if (!nativeFloatingInput) {
        unlistenMoved = await appWindow.onMoved(async ({ payload }) => {
          if (!active) {
            return;
          }
          const monitor = await currentMonitor();
          const nextWorkArea = monitor
            ? {
                x: monitor.workArea.position.x,
                y: monitor.workArea.position.y,
                width: monitor.workArea.size.width,
                height: monitor.workArea.size.height
              }
            : workAreaRef.current;
          markWorkArea(nextWorkArea);
          const ballCenterX = payload.x + FLOATING_ORB_SIZE / 2;
          const nextDock = resolveFloatingDock(ballCenterX, nextWorkArea);
          markDock(nextDock);
        });
      }

      unlistenPanelSelect = await listen<FloatingPanelSelectPayload>(
        "floating-panel-select",
        ({ payload }) => {
          if (!active) {
            return;
          }
          setActivePanel(payload.panel);
          setMenuOpenState(true);
        },
        { target: { kind: "WebviewWindow", label: "floating" } }
      );

      if (!nativeFloatingInput) {
        unlistenPanelHover = await listen<FloatingPanelHoverPayload>(
          "floating-panel-hover",
          ({ payload }) => {
            if (!active) {
              return;
            }
            panelHoveringRef.current = payload.hovering;
            if (payload.hovering) {
              clearHideTimer();
              setMenuOpenState(true);
            } else if (!draggingRef.current && !keepPanelVisible) {
              scheduleHideMenu();
            }
          },
          { target: { kind: "WebviewWindow", label: "floating" } }
        );
      }

      unlistenContextAction = await listen<FloatingContextActionPayload>(
        "floating-orb-context-action",
        ({ payload }) => {
          if (!active) {
            return;
          }
          if (payload.action === "toggle-panel") {
            clearHideTimer();
            if (keepPanelVisible) {
              setMenuOpenState(true);
              void openPanelWindow();
              return;
            }
            if (menuOpenRef.current) {
              setMenuOpenState(false);
              void closePanelWindow();
            } else {
              setMenuOpenState(true);
              void openPanelWindow();
            }
            return;
          }
          if (payload.action === "open-main") {
            void handleOpenMainFromContext();
          }
        },
        { target: { kind: "WebviewWindow", label: "floating" } }
      );

      unlistenNativePanelVisibility = await listen<FloatingNativePanelVisibilityPayload>(
        "floating-native-panel-visibility",
        async ({ payload }) => {
          if (!active) {
            return;
          }
          if (payload.visible) {
            await syncWorkAreaAndDock();
          }
          setMenuOpenState(keepPanelVisible ? true : payload.visible);
        },
        { target: { kind: "WebviewWindow", label: "floating" } }
      );
    }

    void setup();

    return () => {
      active = false;
      unlistenMoved?.();
      unlistenPanelSelect?.();
      unlistenPanelHover?.();
      unlistenContextAction?.();
      unlistenNativePanelVisibility?.();
    };
  }, [keepPanelVisible, nativeFloatingInput]);

  useEffect(() => {
    if (nativeFloatingInput) {
      return;
    }
    void syncPanelWindow();
  }, [activePanel, dock, menuOpen, nativeFloatingInput, workArea]);

  async function syncPanelWindow() {
    if (nativeFloatingInput) {
      return;
    }
    const panelWindow = await ensurePanelWindow();
    const appWindow = getCurrentWindow();
    const orbPosition = await appWindow.outerPosition();
    const panelPosition = computePanelWindowPosition({
      dock: dockRef.current,
      orbX: orbPosition.x,
      orbY: orbPosition.y,
      workArea: workAreaRef.current
    });

    if (nativeFloatingInput) {
      await positionFloatingPanel({
        x: panelPosition.x,
        y: panelPosition.y
      });

      if (menuOpen) {
        await setFloatingPanelVisible(true);
      }
    }

    await emitTo("floating-panel", "floating-panel-sync", {
      dock: dockRef.current,
      x: panelPosition.x,
      y: panelPosition.y,
      menuVisible: menuOpenRef.current,
      activePanel: activePanelRef.current
    });

    if (!menuOpenRef.current) {
      await closePanelWindow(panelWindow);
    }
  }

  async function closePanelWindow(existingPanelWindow?: WebviewWindow) {
    if (nativeFloatingInput) {
      return;
    }
    const panelWindow = existingPanelWindow ?? (await ensurePanelWindow());
    if (nativeFloatingInput) {
      await setFloatingPanelVisible(false);
    }
    await emitTo("floating-panel", "floating-panel-hide");
    await ignoreWindowMutation(panelWindow.hide());
  }

  async function openPanelWindow(nextPanel: FloatingPanelKey = activePanelRef.current) {
    if (nativeFloatingInput) {
      return;
    }
    const panelWindow = await ensurePanelWindow();
    const appWindow = getCurrentWindow();
    const orbPosition = await appWindow.outerPosition();
    const panelPosition = computePanelWindowPosition({
      dock: dockRef.current,
      orbX: orbPosition.x,
      orbY: orbPosition.y,
      workArea: workAreaRef.current
    });

    const syncPayload = {
      dock: dockRef.current,
      x: panelPosition.x,
      y: panelPosition.y,
      menuVisible: true,
      activePanel: nextPanel
    };

    if (nativeFloatingInput) {
      await positionFloatingPanel({
        x: panelPosition.x,
        y: panelPosition.y
      });
    }
    await panelWindow.show();
    if (nativeFloatingInput) {
      await setFloatingPanelVisible(true);
    }
    await emitTo("floating-panel", "floating-panel-sync", syncPayload);
    window.setTimeout(() => {
      void emitTo("floating-panel", "floating-panel-sync", syncPayload);
    }, 220);
  }

  function clearHideTimer() {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }

  function scheduleHideMenu() {
    if (nativeFloatingInput || keepPanelVisible) {
      return;
    }
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(async () => {
      if (panelHoveringRef.current) {
        return;
      }
      setMenuOpenState(false);
      await closePanelWindow();
    }, 220);
  }

  async function syncWorkAreaAndDock() {
    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    const nextWorkArea =
      monitor != null
        ? {
            x: monitor.workArea.position.x,
            y: monitor.workArea.position.y,
            width: monitor.workArea.size.width,
            height: monitor.workArea.size.height
          }
        : workAreaRef.current;
    markWorkArea(nextWorkArea);
    const position = await appWindow.outerPosition();
    const nextDock = resolveFloatingDock(position.x + FLOATING_ORB_SIZE / 2, nextWorkArea);
    markDock(nextDock);
    return { position, nextWorkArea, nextDock };
  }

  async function snapToEdge() {
    const { position, nextWorkArea, nextDock } = await syncWorkAreaAndDock();
    const snapped = computeOrbPosition({
      dock: nextDock,
      workArea: nextWorkArea,
      x: position.x,
      y: position.y
    });
    await getCurrentWindow().setPosition(new LogicalPosition(snapped.x, snapped.y));
    setDock(nextDock);
  }

  async function handleOpenMainFromContext() {
    setMenuOpenState(false);
    await closePanelWindow();
    if (nativeFloatingInput) {
      void openMainWindow("overview");
    }
  }

  async function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    clearHideTimer();
    const appWindow = getCurrentWindow();
    const position = await appWindow.outerPosition();
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWindowX: position.x,
      startWindowY: position.y,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  async function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - session.startClientX;
    const deltaY = event.clientY - session.startClientY;
    if (!session.moved && Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) {
      return;
    }
    if (!session.moved) {
      session.moved = true;
      setDraggingState(true);
      setMenuOpenState(false);
      await closePanelWindow();
    }
    await getCurrentWindow().setPosition(
      new LogicalPosition(session.startWindowX + deltaX, session.startWindowY + deltaY)
    );
  }

  async function finishPointerSession(
    event: React.PointerEvent<HTMLButtonElement>,
    cancelled: boolean
  ) {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }
    pointerSessionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const moved = session.moved;
    setDraggingState(false);
    if (moved) {
      await snapToEdge();
      return;
    }
    if (cancelled) {
      return;
    }
    if (keepPanelVisible) {
      setMenuOpenState(true);
      await openPanelWindow();
      return;
    }
    if (menuOpenRef.current) {
      setMenuOpenState(false);
      await closePanelWindow();
    } else {
      setMenuOpenState(true);
      await openPanelWindow();
    }
  }

  async function handleContextMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    clearHideTimer();
    setMenuOpenState(true);
    await openPanelWindow();
    if (nativeFloatingInput) {
      await showFloatingContextMenu({
        x: event.screenX,
        y: event.screenY
      });
    }
  }

  return (
    <main
      className={`floating-orb-stage dock-${dock} ${menuOpen ? "menu-open" : "menu-collapsed"} ${dragging ? "dragging" : ""}`}
      onMouseEnter={nativeFloatingInput ? undefined : handleHoverOpen}
      onMouseLeave={
        nativeFloatingInput
          ? undefined
          : () => {
              if (!keepPanelVisible && !draggingRef.current && !panelHoveringRef.current) {
                scheduleHideMenu();
              }
            }
      }
    >
      <button
        ref={buttonRef}
        type="button"
        className={`floating-orb-button ${menuOpen ? "menu-open" : ""} ${dragging ? "dragging" : ""}`.trim()}
        draggable={false}
        onMouseEnter={nativeFloatingInput ? undefined : handleHoverOpen}
        onPointerDown={
          nativeFloatingInput ? beginNativePointerSession : (event) => void handlePointerDown(event)
        }
        onPointerMove={nativeFloatingInput ? undefined : (event) => void handlePointerMove(event)}
        onPointerUp={nativeFloatingInput ? undefined : (event) => void finishPointerSession(event, false)}
        onPointerCancel={nativeFloatingInput ? undefined : (event) => void finishPointerSession(event, true)}
        onContextMenu={nativeFloatingInput ? undefined : (event) => void handleContextMenu(event)}
        onDragStart={(event) => {
          event.preventDefault();
        }}
        aria-label="打开悬浮快捷菜单"
      >
        <img
          src={floatingOrbAvatar}
          alt=""
          className="floating-orb-logo"
          draggable={false}
          onDragStart={(event) => {
            event.preventDefault();
          }}
        />
      </button>
    </main>
  );
}
