// The browser authorization owner.
//
// The four switches have one owner, and it is this one. The panel used to own
// them because the panel was the only surface that showed them; moving the
// switches to the Settings page would otherwise have left two answers to "is
// Edge authorized" — one in the panel, one in the settings page — and the
// panel would have gone on showing the old one after the settings page changed
// it.
//
// The owner reads the authorization once and publishes it. A write is an
// optimistic preview followed by the host's answer, because a switch that waits
// for a round trip reads as a switch that did not move.
//
// The rules it keeps are the ones `browser-commands.ts` already states: a change
// names one switch and touches one field, so the four stay independent, and a
// refused write rolls back to the value the host last confirmed.

import { createWebuiSnapshotStore } from "../../../application/snapshot-store.js";
import {
  normalizeWebuiBrowserAuthorization,
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  type WebuiBrowserAuthorization,
} from "../../../../shared/contracts/browser.js";
import type {
  BrowserPort,
  WebuiBrowserAuthorizationToggle,
  WebuiBrowserInstallationKeyResult,
} from "../contracts/browser-port.js";
import type { WebuiBridgeBrowserSurface } from "../../../../shared/contracts/browser.js";
import {
  applyWebuiBrowserAuthorizationChange,
  webuiBrowserAuthorizationChange,
} from "./browser-commands.js";

/**
 * The slice of the browser port this owner needs.
 *
 * A slice rather than the whole port, so the owner says which three calls it
 * depends on: a read, a write, and the installation-key read. The panel's own
 * port stays out of this owner's reach.
 */
export type WebuiBrowserAuthorizationPortSlice = Pick<
  BrowserPort,
  "getBrowserAuthorization" | "setBrowserAuthorization" | "getBrowserInstallationKey"
>;

/**
 * What the owner publishes.
 *
 * `status` is the distinction that matters: `idle` means *never read*, which is
 * not the same as "read and every switch is off". A switch with no baseline is
 * disabled rather than rendered off, because an off switch says "the host says
 * this is off" and there is no host to have said so.
 */
export interface WebuiBrowserAuthorizationState {
  /** The four switches, off until a read says otherwise. */
  readonly authorization: WebuiBrowserAuthorization;
  readonly status: "idle" | "ready" | "error";
  /** The last failure, when the last read or write failed. */
  readonly error?: string;
  /** A write is in flight; the switches are held still until it lands. */
  readonly pending: boolean;
  /** Whether the host wires the write at all. */
  readonly canWrite: boolean;
  /** Whether the host wires the installation-key read at all. */
  readonly canReadInstallationKey: boolean;
}

/** The owner a surface reads the switches through. */
export interface WebuiBrowserAuthorizationOwner {
  readonly getSnapshot: () => WebuiBrowserAuthorizationState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the authorization from the host. Safe to call more than once. */
  readonly load: () => Promise<void>;
  /** Moves one switch and reconciles with the host's answer. */
  readonly toggle: (toggle: WebuiBrowserAuthorizationToggle) => Promise<void>;
  /** Reads one browser's bridge installation key. */
  readonly readInstallationKey: (request: {
    readonly surface: WebuiBridgeBrowserSurface;
  }) => Promise<WebuiBrowserInstallationKeyResult>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The owner itself.
 *
 * The port is optional in every member, because a host may wire the browser
 * family partially or not at all. The owner reports that as `canWrite` and
 * `canReadInstallationKey` rather than pretending the capability exists.
 */
export function createWebuiBrowserAuthorizationOwner(deps: {
  readonly port: WebuiBrowserAuthorizationPortSlice;
}): WebuiBrowserAuthorizationOwner {
  const { port } = deps;
  const { getSnapshot, subscribe, set } = createWebuiSnapshotStore<WebuiBrowserAuthorizationState>({
    authorization: WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
    status: "idle",
    pending: false,
    canWrite: port.setBrowserAuthorization !== undefined,
    canReadInstallationKey: port.getBrowserInstallationKey !== undefined,
  });

  // The read in flight, so two surfaces that mount together cause one read.
  let loading: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    if (loading) return loading;
    const read = port.getBrowserAuthorization;
    if (!read) {
      // A host that does not wire the browser family has not said the switches
      // are off; it has said nothing at all, which stays `idle`.
      return;
    }
    loading = (async () => {
      try {
        const authorization = await read();
        // A host that answers with a partial record has not authorized the
        // missing parts, and a switch whose state is `undefined` is a switch
        // nobody has said anything about. The shared rule reads both as off.
        set((current) => ({
          ...current,
          authorization: normalizeWebuiBrowserAuthorization(authorization),
          status: "ready",
          error: undefined,
        }));
      } catch (error) {
        set((current) => ({ ...current, status: "error", error: describe(error) }));
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  };

  const toggle = async (toggle: WebuiBrowserAuthorizationToggle): Promise<void> => {
    const write = port.setBrowserAuthorization;
    if (!write) return;
    if (getSnapshot().pending) return;

    const change = webuiBrowserAuthorizationChange(toggle);
    const confirmed = getSnapshot().authorization;
    set((current) => ({
      ...current,
      authorization: applyWebuiBrowserAuthorizationChange(current.authorization, change),
      pending: true,
      error: undefined,
    }));
    try {
      const authorization = await write(change);
      set((current) => ({
        ...current,
        authorization: normalizeWebuiBrowserAuthorization(authorization),
        status: "ready",
        pending: false,
      }));
    } catch (error) {
      // The write was refused, so the last value the host confirmed is still the
      // truth. Rolling back to it is honest; keeping the preview would not be.
      set((current) => ({
        ...current,
        authorization: confirmed,
        status: "ready",
        pending: false,
        error: describe(error),
      }));
    }
  };

  const readInstallationKey = async (request: {
    readonly surface: WebuiBridgeBrowserSurface;
  }): Promise<WebuiBrowserInstallationKeyResult> => {
    const read = port.getBrowserInstallationKey;
    if (!read) {
      return { present: false, surface: request.surface, reason: "not_provisioned" };
    }
    return read(request);
  };

  return { getSnapshot, subscribe, load, toggle, readInstallationKey };
}
