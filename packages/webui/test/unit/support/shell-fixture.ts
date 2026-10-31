// The shell element a host must render: the assembled application wrapping it.
//
// The shell renders what the assembly built and constructs nothing of its own,
// so a markup fixture has to hand it an application the same way
// production does. `sessionStore` in the properties is consumed as the
// *assembly's* store rather than passed down — the shell reads the store off the
// application it was given, so a fixture that seeds a store seeds the assembly.

import { createElement } from "react";
import type { ReactElement } from "react";

import { WebuiApplicationProvider } from "../../../src/client/bindings/application-context.js";
import { WebuiClientFoundationApp } from "../../../src/client/shell/WebuiClientFoundationApp.js";
import type { WebuiSessionStore } from "../../../src/client/application/session-store.js";
import { createWebuiPortSlices } from "../../../src/client/application/port-slices.js";
import type { WebuiPortSliceSource } from "../../../src/client/application/port-slices.js";
import { createWebuiApplicationFixture } from "./application-fixture.js";
import type { ApplicationFixtureOptions } from "./application-fixture.js";

export function shellElement(
  properties: Record<string, unknown>,
  options: ApplicationFixtureOptions = {},
): ReactElement {
  const { sessionStore, transport, ...rest } = properties as {
    readonly sessionStore?: WebuiSessionStore;
    readonly transport?: WebuiPortSliceSource;
    readonly [key: string]: unknown;
  };
  const store = sessionStore ?? options.store;
  // A fixture that hands the shell a transport-shaped bag means it as the
  // assembly's port slices — the shell cuts nothing and holds no transport of
  // its own, so it goes in through the same door production uses.
  const slices = options.slices ?? createWebuiPortSlices(transport ?? {});
  return createElement(WebuiApplicationProvider, {
    application: createWebuiApplicationFixture({
      ...options,
      ...(store ? { store } : {}),
      slices,
      // The same bag drives the substrate's capability slice, which is
      // derived from the port: wiring the slices alone told the substrate that
      // no host capability existed at all.
      turnCapabilities: options.turnCapabilities ?? transport ?? {},
    }),
    children: createElement(WebuiClientFoundationApp, rest as never),
  });
}
