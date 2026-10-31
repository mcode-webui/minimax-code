// The installed Mini App inventory, and what it must not include.
//
// Two properties are under test, and the second matters as much as the first:
//
//   * a local Mini App the person **disabled** is still installed, so a management
//     surface can show it and offer to enable it — the enabled-only projection that
//     activation and publication use must keep excluding it, or a disabled package
//     would become startable;
//   * an ordinary plugin is **not** a Mini App. `capabilities.appCount` counts a
//     package's `apps` references, which are a different contribution from
//     `miniapp`, so a listing built on that count would misclassify plugins. The
//     identification here reads the `miniapp` contribution itself.
//
// The snapshot is a literal rather than a scanned package tree: what is being
// pinned is the projection's rule, not the scanner.

import { describe, expect, it } from "vitest";

import {
  listEnabledMiniAppDefinitions,
  listInstalledMiniAppDefinitions,
} from "../../../src/service/plugin-system/plugin/runtime/miniapp/candidate.js";
import type { PluginSnapshot } from "../../../src/service/plugin-system/plugin/runtime/snapshot-builder.js";

/** A package that contributes a Mini App, or one that does not. */
function plugin(
  name: string,
  options: { readonly source?: "LOCAL" | "OFFICIAL"; readonly miniapp?: boolean } = {},
) {
  const source = options.source ?? "LOCAL";
  return {
    name,
    source,
    rootPath: `/packages/${name}`,
    contentDigest: `digest-${name}`,
    ...(options.miniapp === false
      ? {}
      : {
          miniapp: {
            contentDigest: `miniapp-digest-${name}`,
            clientDigest: `client-digest-${name}`,
            nodeDigest: `node-digest-${name}`,
            surface: { path: "/dashboard" },
            runtime: { lifecycle: "on-demand", entry: "server/index.js" },
            mcpEndpoints: [],
          },
        }),
  };
}

function snapshot(input: {
  readonly official?: readonly ReturnType<typeof plugin>[];
  readonly local?: readonly { readonly plugin: ReturnType<typeof plugin>; readonly enabled: boolean }[];
}): PluginSnapshot {
  return {
    revision: "fixture",
    officialPackages: (input.official ?? []).map((entry) => ({
      name: entry.name,
      rootPath: entry.rootPath,
      contentDigest: entry.contentDigest,
      plugin: entry,
    })),
    localPlugins: (input.local ?? []).map((entry) => ({
      name: entry.plugin.name,
      rootPath: entry.plugin.rootPath,
      contentDigest: entry.plugin.contentDigest,
      source: entry.plugin.source,
      enabled: entry.enabled,
      plugin: entry.plugin,
    })),
    enabledPlugins: [],
    skills: [],
    mcpServers: [],
    diagnostics: [],
    turnCapabilities: {},
  } as unknown as PluginSnapshot;
}

describe("the installed Mini App inventory", () => {
  const cases = snapshot({
    official: [plugin("official.app", { source: "OFFICIAL" })],
    local: [
      // Installed and startable.
      { plugin: plugin("local.enabled"), enabled: true },
      // Installed and disabled: the row the catalogue has to be able to enable.
      { plugin: plugin("local.disabled"), enabled: false },
      // Installed, but not a Mini App at all.
      { plugin: plugin("local.ordinary", { miniapp: false }), enabled: true },
    ],
  });

  it("lists a disabled local Mini App, marked disabled", () => {
    const installed = listInstalledMiniAppDefinitions(cases);
    expect(installed.map((definition) => [definition.candidate.pluginId, definition.enabled])).toEqual([
      ["local.disabled", false],
      ["local.enabled", true],
      ["official.app", true],
    ]);
  });

  it("does not turn an ordinary plugin into a Mini App", () => {
    const installed = listInstalledMiniAppDefinitions(cases);
    expect(installed.map((definition) => definition.candidate.pluginId)).not.toContain("local.ordinary");
  });

  it("keeps the startable projection free of a disabled package", () => {
    // Activation, publication and the runtime projection all read this one, so a
    // disabled Mini App appearing here would become startable.
    const enabled = listEnabledMiniAppDefinitions(cases);
    expect(enabled.map((definition) => definition.candidate.pluginId)).toEqual([
      "local.enabled",
      "official.app",
    ]);
  });

  it("reads the same package as a Mini App in both projections", () => {
    // One walk behind both, so a package cannot be a Mini App for one listing and
    // not for the other.
    const installed = new Set(
      listInstalledMiniAppDefinitions(cases).map((definition) => definition.candidate.pluginId),
    );
    for (const definition of listEnabledMiniAppDefinitions(cases)) {
      expect(installed.has(definition.candidate.pluginId)).toBe(true);
    }
  });
});
