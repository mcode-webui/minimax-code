/**
 * Child entry point for the runner's real-process exit cases.
 *
 * This file is executed as a child process (`tsx <this file>`) by
 * `test/unit/miniapp/host-runner.test.ts`; it is deliberately not a Vitest suite, so it lives with
 * the package's test helpers rather than under a suite path. It mirrors the shipped package's harness of the same
 * path: start the real runner and let it own the parent IPC channel.
 */
import { runMiniAppHostRunner } from '../../src/service/miniapp/process/node-runtime/host-runner.js';

runMiniAppHostRunner();
