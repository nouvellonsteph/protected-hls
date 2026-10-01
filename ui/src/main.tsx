import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@cloudflare/kumo/styles/standalone";
import "./styles.css";
import { App } from "./App";
import { isPart2Path } from "./demo-helpers";

document.title = isPart2Path(window.location.pathname)
  ? "Live HLS Origin | Cloudflare"
  : "Protected HLS Delivery | Cloudflare";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
