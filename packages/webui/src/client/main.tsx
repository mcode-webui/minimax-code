// Client entry for the WebUI package. The first version is a foundation
// only; the browser code mounts a placeholder root that records its
// presence so later tickets can replace it without changing the entry point
// the build graph sees.

import { createRoot, type Root } from "react-dom/client";
import { WebuiClientFoundationApp } from "./app.js";

declare const document: {
  getElementById(elementId: string): HTMLElement | null;
};

const rootElement = document.getElementById("webui-root");
if (!rootElement) throw new Error("WebUI mount node #webui-root is missing");
const root: Root = createRoot(rootElement);
root.render(<WebuiClientFoundationApp label="webui-foundation" />);

export { WebuiClientFoundationApp } from "./app.js";
