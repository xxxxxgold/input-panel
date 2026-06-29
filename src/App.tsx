import { FloatingWindowRoot } from "./app/FloatingWindowRoot";
import { FloatingPanelWindowRoot } from "./app/FloatingPanelWindowRoot";
import { MainWindowApp } from "./app/MainWindowApp";
import { getCurrentWindowLabel } from "./app/window-label";

export default function App() {
  const label = getCurrentWindowLabel();
  if (label === "floating") {
    return <FloatingWindowRoot />;
  }
  if (label === "floating-panel") {
    return <FloatingPanelWindowRoot />;
  }
  return <MainWindowApp />;
}
