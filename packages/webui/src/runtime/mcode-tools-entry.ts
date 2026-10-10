#!/usr/bin/env node
import { configureWebuiMcodeToolsChildEnvironment } from "./mcode-tools-environment.js";

configureWebuiMcodeToolsChildEnvironment();
const embeddedEntry = new URL("./embedded/mcode-tools/cli.mjs", import.meta.url);
await import(embeddedEntry.href);
