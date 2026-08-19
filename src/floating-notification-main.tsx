import React from "react";
import ReactDOM from "react-dom/client";

import { FloatingNotificationWindowRoot } from "./app/FloatingNotificationWindowRoot";
import "./styles-floating.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloatingNotificationWindowRoot />
  </React.StrictMode>
);
