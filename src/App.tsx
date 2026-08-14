import { Suspense, lazy } from "react";

import { MainWindowApp } from "./app/MainWindowApp";
import { getCurrentWindowLabel } from "./app/window-label";

const FloatingWindowRoot = lazy(async () => {
  const module = await import("./app/FloatingWindowRoot");
  return { default: module.FloatingWindowRoot };
});

const FloatingPanelWindowRoot = lazy(async () => {
  const module = await import("./app/FloatingPanelWindowRoot");
  return { default: module.FloatingPanelWindowRoot };
});

const FloatingNotificationWindowRoot = lazy(async () => {
  const module = await import("./app/FloatingNotificationWindowRoot");
  return { default: module.FloatingNotificationWindowRoot };
});

export default function App() {
  const label = getCurrentWindowLabel();
  if (label === "floating") {
    return (
      <Suspense fallback={null}>
        <FloatingWindowRoot />
      </Suspense>
    );
  }
  if (label === "floating-panel") {
    return (
      <Suspense fallback={null}>
        <FloatingPanelWindowRoot />
      </Suspense>
    );
  }
  if (label === "floating-notification") {
    return (
      <Suspense fallback={null}>
        <FloatingNotificationWindowRoot />
      </Suspense>
    );
  }
  return <MainWindowApp />;
}
