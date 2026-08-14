import React from "react";
import ReactDOM from "react-dom/client";

import { FloatingPanelWindowRoot } from "./app/FloatingPanelWindowRoot";
import "./styles-floating.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloatingPanelWindowRoot />
  </React.StrictMode>
);
