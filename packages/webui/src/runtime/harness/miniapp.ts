// The Mini App cell of the harness port.
//
// The runtime owns the Mini App lifecycle — it starts the process, installs the
// loopback guard and issues the credential that guard demands — so this adapter
// forwards and converts, never decides. Two conversions happen here and they
// happen for different reasons:
//
//   * the catalogue row becomes an independently owned WebUI DTO, so a runtime
//     field this wire does not publish cannot leak into a response by being
//     spread;
//   * the launch becomes `WebuiMiniAppLaunch`, which adds the credential header
//     the runtime's own type does not carry. The header name is imported from the
//     shared contract the runtime installs its guard with
//     (`@mavis/shared/miniapp-surface`), not spelled here: a copy is a second
//     authority on which header the guard reads.
//
// The whole launch object is server-only. Nothing in it reaches the browser; the
// server hands it to `startMiniAppProxy`, which injects the credential on the way
// out and answers the client with its own URL.
import {
  MINIAPP_LOOPBACK_TOKEN_HEADER,
  type MiniAppSurfaceSummary,
} from "@mavis/shared/miniapp-surface";

import {
  MINIAPP_CAPABILITY_ABSENT,
  type WebuiHarnessPort,
  type WebuiMiniAppLaunch,
} from "../port.js";
import type {
  WebuiRuntimeCliService,
  WebuiRuntimeHostHandle,
} from "./host-contract.js";
import { requireCliService } from "./requirements.js";
import { WebuiCapabilityUnavailableError } from "../../shared/envelope.js";
import type { WebuiMiniAppSummary } from "../../shared/contracts/miniapp.js";

/** The launch the runtime hands back, as much of it as this adapter reads. */
interface RuntimeMiniAppLaunch {
  readonly miniApp: MiniAppSurfaceSummary;
  readonly launch: {
    readonly origin: string;
    readonly surfacePath: string;
    readonly runId: string;
    readonly credential: string;
  };
}

/**
 * The three facade members, or one refusal.
 *
 * One capability, so a host that has any two of them is a broken host rather than
 * a host with a partial Mini App surface: the facade composes all three from the
 * same application cell.
 */
function requireMiniApps(host: WebuiRuntimeHostHandle): Required<
  Pick<WebuiRuntimeCliService, "listMiniApps" | "openMiniApp" | "stopMiniApp">
> & { readonly listInstalledMiniApps?: WebuiRuntimeCliService["listInstalledMiniApps"] } {
  const cliService = requireCliService(host);
  const { listMiniApps, openMiniApp, stopMiniApp, listInstalledMiniApps } = cliService;
  if (!listMiniApps || !openMiniApp || !stopMiniApp)
    throw new WebuiCapabilityUnavailableError(MINIAPP_CAPABILITY_ABSENT);
  // The runtime's members read `this.options`, so the receiver has to be the
  // service they were destructured from — not this wrapper.
  return {
    listMiniApps: () => listMiniApps.call(cliService),
    ...(listInstalledMiniApps
      ? { listInstalledMiniApps: () => listInstalledMiniApps.call(cliService) }
      : {}),
    openMiniApp: (request) => openMiniApp.call(cliService, request),
    stopMiniApp: (request) => stopMiniApp.call(cliService, request),
  };
}

/**
 * The publishable half of a catalogue row.
 *
 * Field by field rather than by spread: the runtime's summary is free to grow a
 * field that is not meant for a renderer, and a spread would publish it the day it
 * lands.
 */
export function toWebuiMiniAppSummary(
  summary: MiniAppSurfaceSummary,
): WebuiMiniAppSummary {
  return {
    pluginId: summary.pluginId,
    ...(summary.source !== undefined ? { source: summary.source } : {}),
    ...(summary.enabled !== undefined ? { enabled: summary.enabled } : {}),
    ...(summary.displayName !== undefined ? { displayName: summary.displayName } : {}),
    ...(summary.description !== undefined ? { description: summary.description } : {}),
    ...(summary.iconUrl !== undefined ? { iconUrl: summary.iconUrl } : {}),
    runtime: {
      kind: summary.runtime.kind,
      status: summary.runtime.status,
      ...(summary.runtime.errorCode !== undefined
        ? { errorCode: summary.runtime.errorCode }
        : {}),
      ...(summary.runtime.ownership !== undefined
        ? { ownership: summary.runtime.ownership }
        : {}),
      ...(summary.runtime.ownerClient !== undefined
        ? { ownerClient: summary.runtime.ownerClient }
        : {}),
    },
  };
}

/**
 * The launch, with the header its credential is read from.
 *
 * `credentialHeader` is the one field this conversion adds, and it is added here
 * because this is the only layer that may hold both the credential and the
 * contract the guard was installed with.
 */
export function toWebuiMiniAppLaunch(
  result: RuntimeMiniAppLaunch,
): WebuiMiniAppLaunch {
  return {
    miniApp: toWebuiMiniAppSummary(result.miniApp),
    launch: {
      origin: result.launch.origin,
      surfacePath: result.launch.surfacePath,
      runId: result.launch.runId,
      credential: result.launch.credential,
      credentialHeader: MINIAPP_LOOPBACK_TOKEN_HEADER,
    },
  };
}

export function createMiniAppAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "listMiniApps" | "openMiniApp" | "stopMiniApp"> {
  return {
    async listMiniApps() {
      // The installed read when the host has one: it also answers for a Mini App
      // the person disabled, which is the row the catalogue offers to enable. A
      // host that predates it answers with the startable set alone.
      const capabilities = requireMiniApps(host);
      const { miniApps } = capabilities.listInstalledMiniApps
        ? await capabilities.listInstalledMiniApps()
        : await capabilities.listMiniApps();
      return { miniApps: miniApps.map(toWebuiMiniAppSummary) };
    },

    async openMiniApp(request) {
      return toWebuiMiniAppLaunch(await requireMiniApps(host).openMiniApp(request));
    },

    async stopMiniApp(request) {
      await requireMiniApps(host).stopMiniApp(request);
    },
  };
}
