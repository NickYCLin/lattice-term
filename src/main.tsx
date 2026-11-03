import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { workbenchWindowId } from "./domain/sqlWorkbench";
import SqlWorkbenchWindow from "./components/connections/SqlWorkbenchWindow";

const workbenchId = workbenchWindowId(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {workbenchId ? <SqlWorkbenchWindow id={workbenchId} /> : <App />}
  </React.StrictMode>,
);
