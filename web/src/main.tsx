// Mount the screen.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./screen/App.tsx";
import "./ui/weave.css"; // the weave theme (his word, 2026-11-18); base.css and flip.css are the look before it, no longer loaded

const el = document.getElementById("root");
if (el === null) throw new Error("no #root to mount the screen on");
createRoot(el).render(<StrictMode><App /></StrictMode>);
