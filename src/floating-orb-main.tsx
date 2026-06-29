import React from "react";
import ReactDOM from "react-dom/client";

import { FloatingWindowRoot } from "./app/FloatingWindowRoot";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloatingWindowRoot />
  </React.StrictMode>
);
