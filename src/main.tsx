import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./i18n";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
void invoke("frontend_ready").catch(() => {});
