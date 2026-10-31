// Validate the current WebUI server, runtime and browser build artifacts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBUI_DIST_DIRECTORY, WEBUI_METAFILE_BASENAME } from "./lib/webui-boundary-constants.mjs";
import { checkWebuiBuild } from "./lib/webui-build-check.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metaPath = path.join(root, WEBUI_DIST_DIRECTORY, WEBUI_METAFILE_BASENAME);
  const metafile = JSON.parse(readFileSync(metaPath, "utf8"));
  const count = checkWebuiBuild(root, metafile);
  console.log(`WebUI build boundary passed: ${count} inputs; source/output integrity, required entries and public workspace imports verified.`);
}
