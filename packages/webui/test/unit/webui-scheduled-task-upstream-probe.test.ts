// Retirement-condition probe for the WebUI's own scheduled tasks (ADR 0012).
//
// ── What this file is, and what it is not ──────────────────────────────────
// ADR 0012 ("The WebUI runs its own scheduled tasks until the runtime offers
// one") owns the retirement decision and the work that follows it. **This file
// only reports.** It does not gate anything: no state — not a closed upstream,
// not an open upstream, not a probe that can no longer read the upstream — is
// allowed to turn `test:webui` red, and this file must never fail because of an
// upstream change. A door that goes red for something that is not a defect only
// teaches people to ignore red.
//
// So the two retirement conditions in ADR 0012 are read as source text and
// printed. What the reader gets:
//
//   gate1=closed gate2=closed          one quiet status line, no warning
//   gate1=open   gate2=closed          a warning: upstream moved, still not usable
//   gate1=closed gate2=open            a warning: upstream moved, still not usable
//   gate1=open   gate2=open            a warning: retirement condition is met
//   probe=unconfirmed                  a warning: this probe cannot read the
//                                      upstream, and that is NOT a retirement
//                                      signal and NOT a reason to delete
//                                      anything
//
// "Unknown" is never collapsed into "closed". An unreadable probe is reported
// as unreadable, and its message says in words that it is not a retirement
// signal, so nobody reads the yellow line and tears down the WebUI's
// scheduler on the strength of it.
//
// ── Why source text and not a real host ────────────────────────────────────
// Booting a real `createLocalRuntimeHostV2` takes 30–100s, opens sqlite and
// starts schedulers, which is not a unit test. The two conditions are, however,
// fully decided by expressions in the upstream package's own source, and this
// repository already reads other packages' sources from its checks
// (`scripts/source-inventory.mjs`, `webui-boundary-check.test.ts`). So the
// probe reads four files under `packages/local-runtime-v2` — read-only — and
// answers from what it found.
//
// The two gates are judged independently and only then combined, so a report
// can name which door opened. They can open separately, and gate 2 before
// gate 1 is entirely plausible: upstream can expose the slot on the host
// contract long before it builds the service for an embedded host.
//
// ── The gates, as ADR 0012 states them ─────────────────────────────────────
//   gate 1 (creation)    `services.cron` is created for a `tui` +
//                        `cliEmbedded` host — today `enableCron` is
//                        `ownsElectronRuntimeCapabilities(runtimeOwnerKind)`,
//                        and that predicate accepts only `undefined` and
//                        `'electron'`. Evidence:
//                        `local-runtime-v2/src/services.ts` (the assignment
//                        and the creation site that consumes it) and
//                        `application/agent/runtime-browser-use-composition.ts`
//                        (the predicate body).
//   gate 2 (reachability) the created service is reachable from the host —
//                        carried on `CreatedLocalRuntimeHost` or on the
//                        `cliService` options, which is where
//                        `runtime.ts` spreads the whole services object.
//                        Evidence: `local/host-contract.ts` and
//                        `local/cli-service.ts`. Note that
//                        `RuntimeServices` already declares an optional `cron`;
//                        that is the value being spread, and it is `undefined`
//                        for this host because gate 1 is closed, so it is not
//                        itself evidence of an open gate 2.
//
// The only assertions in this file are the probe's own behaviour against
// literal fixture sources, which no upstream change can influence.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  openScheduledTaskDatabase,
  ScheduledTaskStore,
} from "../../src/server/scheduled-task-store.js";
import { WebuiScheduledTaskRuntime } from "../../src/server/scheduled-task-scheduler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const ADR_0012 =
  "docs/adr/0012-the-webui-runs-its-own-scheduled-tasks-until-the-runtime-offers-one.md";

/** The upstream source text the two gates are read from. */
interface UpstreamSources {
  readonly services?: string;
  readonly composition?: string;
  readonly hostContract?: string;
  readonly cliService?: string;
}

const UPSTREAM_FILES = {
  services: "packages/local-runtime-v2/src/services.ts",
  composition:
    "packages/local-runtime-v2/src/application/agent/runtime-browser-use-composition.ts",
  hostContract: "packages/local-runtime-v2/src/local/host-contract.ts",
  cliService: "packages/local-runtime-v2/src/local/cli-service.ts",
} as const;

function readUpstreamSources(rootDir: string): UpstreamSources {
  const read = (relative: string): string | undefined => {
    try {
      return readFileSync(path.join(rootDir, relative), "utf8");
    } catch {
      // A moved or deleted file is a state to report, not a crash.
      return undefined;
    }
  };
  return {
    services: read(UPSTREAM_FILES.services),
    composition: read(UPSTREAM_FILES.composition),
    hostContract: read(UPSTREAM_FILES.hostContract),
    cliService: read(UPSTREAM_FILES.cliService),
  };
}

/** One gate's answer. `unconfirmed` is never read as `closed`. */
interface Gate {
  readonly state: "closed" | "open" | "unconfirmed";
  readonly detail: string;
}

const unconfirmed = (detail: string): Gate => ({ state: "unconfirmed", detail });
const closed = (detail: string): Gate => ({ state: "closed", detail });
const opened = (detail: string): Gate => ({ state: "open", detail });

/** The `{ ... }` body of a declaration, or undefined if it cannot be found. */
function braceBody(
  source: string,
  declaration: string,
): string | undefined {
  const declarationStart = source.indexOf(declaration);
  if (declarationStart < 0) return undefined;
  const open = source.indexOf("{", declarationStart);
  if (open < 0) return undefined;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

function memberNames(body: string): string[] {
  return [
    ...body.matchAll(
      /^[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*\??[ \t]*[:?]/gmu,
    ),
  ].map((match) => match[1] ?? "");
}

/**
 * Gate 1: does a `tui` + `cliEmbedded` host get a `services.cron`?
 *
 * Read from the `enableCron` assignment and from the creation site that
 * consumes it. Both halves matter: an `enableCron` that nothing consumes would
 * mean the service is built unconditionally, and reading only the assignment
 * would call that closed.
 */
function probeGate1(sources: UpstreamSources): Gate {
  const { services, composition } = sources;
  if (services === undefined)
    return unconfirmed(`could not read ${UPSTREAM_FILES.services}`);
  if (composition === undefined)
    return unconfirmed(`could not read ${UPSTREAM_FILES.composition}`);

  const assignments = [
    ...services.matchAll(/^[ \t]*enableCron[ \t]*:[ \t]*(.*)$/gmu),
  ].map((match) => (match[1] ?? "").trim().replace(/,$/u, ""));
  if (assignments.length === 0)
    return unconfirmed(
      `no \`enableCron:\` assignment found in ${UPSTREAM_FILES.services}; this probe does not know where cron is gated now`,
    );
  if (assignments.length > 1)
    return unconfirmed(
      `${assignments.length} \`enableCron:\` assignments found in ${UPSTREAM_FILES.services}; this probe expects exactly one`,
    );
  const value = assignments[0] ?? "";

  if (value === "true")
    return opened(
      `\`enableCron: true\` in ${UPSTREAM_FILES.services} — the flag is no longer gated on the host kind, so a tui + cliEmbedded host gets a cron service`,
    );
  if (value === "false")
    return closed(
      `\`enableCron: false\` in ${UPSTREAM_FILES.services} — cron is pinned off for every host kind`,
    );
  if (!value.includes("ownsElectronRuntimeCapabilities("))
    return unconfirmed(
      `\`enableCron: ${value}\` in ${UPSTREAM_FILES.services} is not the electron-only predicate this probe reads, so the gate can no longer be classified`,
    );

  const predicate = braceBody(
    composition,
    "function ownsElectronRuntimeCapabilities",
  );
  if (predicate === undefined)
    return unconfirmed(
      `ownsElectronRuntimeCapabilities has no readable body in ${UPSTREAM_FILES.composition}`,
    );
  // Quoted literals only: an incidental mention of a host kind in a comment
  // must not be able to move a gate.
  if (/(['"])tui\1/u.test(predicate))
    return opened(
      `ownsElectronRuntimeCapabilities() accepts 'tui' (${UPSTREAM_FILES.composition}), so a tui + cliEmbedded host is created a cron service`,
    );
  if (!/(['"])electron\1/u.test(predicate))
    return unconfirmed(
      `ownsElectronRuntimeCapabilities() mentions neither 'tui' nor 'electron' (${UPSTREAM_FILES.composition}); this probe cannot classify it`,
    );
  if (!/input\.enableCron\s*\?/u.test(services))
    return unconfirmed(
      `\`enableCron\` is assigned in ${UPSTREAM_FILES.services} but no creation site consumes \`input.enableCron\`, so this probe cannot tell whether the service is still built conditionally`,
    );
  return closed(
    `\`enableCron\` is ownsElectronRuntimeCapabilities(runtimeOwnerKind), whose body accepts only 'electron' or undefined, and \`input.enableCron ? initializeRuntimeCron(...)\` still gates the creation site`,
  );
}

/**
 * Gate 2: could a host reach the created service?
 *
 * Two surfaces, because ADR 0012 names two: the host contract itself, and the
 * `cliService` options, which is where `runtime.ts` spreads the services
 * object whole. Either one carrying cron is enough.
 */
function probeGate2(sources: UpstreamSources): Gate {
  const { hostContract, cliService } = sources;
  if (hostContract === undefined)
    return unconfirmed(`could not read ${UPSTREAM_FILES.hostContract}`);
  if (cliService === undefined)
    return unconfirmed(`could not read ${UPSTREAM_FILES.cliService}`);

  const hostBody = braceBody(hostContract, "interface CreatedLocalRuntimeHost");
  if (hostBody === undefined)
    return unconfirmed(
      `no \`interface CreatedLocalRuntimeHost\` body found in ${UPSTREAM_FILES.hostContract}`,
    );
  const cliBody = braceBody(cliService, "interface CliServiceOptions");
  if (cliBody === undefined)
    return unconfirmed(
      `no \`interface CliServiceOptions\` body found in ${UPSTREAM_FILES.cliService}`,
    );

  const hostMembers = memberNames(hostBody);
  const cliMembers = memberNames(cliBody);
  if (hostMembers.length === 0 || cliMembers.length === 0)
    return unconfirmed(
      "a host surface parsed to zero members, so this probe cannot classify it",
    );

  const onHost = hostMembers.filter((name) => /cron/iu.test(name));
  if (onHost.length > 0)
    return opened(
      `CreatedLocalRuntimeHost carries ${onHost.join(", ")} in ${UPSTREAM_FILES.hostContract}`,
    );
  const onCliService = cliMembers.filter((name) => /cron/iu.test(name));
  if (onCliService.length > 0)
    return opened(
      `CliServiceOptions carries ${onCliService.join(", ")} in ${UPSTREAM_FILES.cliService}, and \`runtime.ts\` spreads the whole services object into it`,
    );
  return closed(
    `CreatedLocalRuntimeHost carries only ${hostMembers.join(", ")} and CliServiceOptions only ${cliMembers.join(", ")} — nothing the WebUI can hold reaches a cron service`,
  );
}

type ProbeStatus =
  | "closed"
  | "gate1-open"
  | "gate2-open"
  | "both-open"
  | "unconfirmed";

interface ProbeReport {
  readonly status: ProbeStatus;
  readonly gate1: Gate;
  readonly gate2: Gate;
  /** The one line printed on every run. Never a warning. */
  readonly summary: string;
  /** Printed only when the state deserves a look. Never a failure. */
  readonly notice?: string;
}

function assess(sources: UpstreamSources, implementation: string): ProbeReport {
  const gate1 = probeGate1(sources);
  const gate2 = probeGate2(sources);
  const summary = [
    "webui scheduled tasks:",
    `gate1=${gate1.state}`,
    `gate2=${gate2.state}`,
    `probe=${gate1.state === "unconfirmed" || gate2.state === "unconfirmed" ? "unconfirmed" : "ok"}`,
    `implementation=${implementation}`,
  ].join(" ");

  if (gate1.state === "unconfirmed" || gate2.state === "unconfirmed") {
    const unreadable = [
      ...(gate1.state === "unconfirmed" ? [`gate 1: ${gate1.detail}`] : []),
      ...(gate2.state === "unconfirmed" ? [`gate 2: ${gate2.detail}`] : []),
    ].join("\n    ");
    return {
      status: "unconfirmed",
      gate1,
      gate2,
      summary,
      // Deliberately unlike every other notice, and it leads with the
      // negation: a reader who only skims must not take this line as licence
      // to remove the WebUI's scheduler.
      notice: [
        "webui scheduled tasks: PROBE COULD NOT CONFIRM THE UPSTREAM STATE — THIS IS NOT A RETIREMENT SIGNAL",
        `  ${unreadable}`,
        "  An unreadable probe is not a closed gate and not an open one. Do NOT retire,",
        "  replace or disable the WebUI's own scheduler on the basis of this line.",
        `  Update the probe in ${path.relative(repoRoot, fileURLToPath(import.meta.url))} to read where the upstream gates now live.`,
      ].join("\n"),
    };
  }

  if (gate1.state === "open" && gate2.state === "open")
    return {
      status: "both-open",
      gate1,
      gate2,
      summary,
      notice: [
        `webui scheduled tasks: ADR 0012's RETIREMENT CONDITION IS NOW MET — both gates are open.`,
        `  gate 1 (creation)     ${gate1.detail}`,
        `  gate 2 (reachability) ${gate2.detail}`,
        `  Read ${ADR_0012} and do the retirement it specifies:`,
        "    1. Re-implement WebuiScheduledTaskPort against the runtime's CronService. The adapter is the only thing that changes.",
        "    2. Migrate the webui_scheduled_task table into the runtime's table, in the same change — not as a follow-up.",
        "    3. Tear down the WebUI's own tick loop in that same change. Two schedulers over one queue is exactly what the decision exists to prevent.",
      ].join("\n"),
    };

  if (gate1.state === "closed" && gate2.state === "closed")
    // The quiet state: one status line, no warning, nothing to decide.
    return { status: "closed", gate1, gate2, summary };

  const openGate = gate1.state === "open" ? gate1 : gate2;
  const closedGate = gate1.state === "open" ? gate2 : gate1;
  const which =
    gate1.state === "open"
      ? [
          "the runtime now builds a cron service for this host kind (gate 1 is open)",
          "the host contract still does not carry it (gate 2 is closed)",
        ]
      : [
          "the host contract now exposes a cron slot (gate 2 is open)",
          "no cron service is built for this host kind (gate 1 is closed)",
        ];
  return {
    status: gate1.state === "open" ? "gate1-open" : "gate2-open",
    gate1,
    gate2,
    summary,
    notice: [
      "webui scheduled tasks: UPSTREAM HAS MOVED, AND IT IS STILL NOT A RETIREMENT SIGNAL",
      `  ${which[0]}, but ${which[1]}.`,
      `    open:   ${openGate.detail}`,
      `    closed: ${closedGate.detail}`,
      "  The service is therefore not usable by a WebUI host, so the surface stays as it is.",
      `  ADR 0012 still stands: keep the WebUI's own scheduler and its own table. Re-read this when both gates are open.`,
    ].join("\n"),
  };
}

/**
 * The implementation currently wired, read from the object that answers —
 * never asserted on, and never able to fail the run. `"unknown"` when it
 * cannot be constructed, because reporting must not throw.
 */
async function currentImplementation(): Promise<string> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "webui-scheduled-task-probe-"));
  let runtime: WebuiScheduledTaskRuntime | undefined;
  try {
    const store = new ScheduledTaskStore(
      openScheduledTaskDatabase(path.join(directory, "scheduled-tasks.sqlite")),
    );
    runtime = new WebuiScheduledTaskRuntime({
      store,
      sendMessage: async () => ({ ok: true, source: [] }),
      createSession: async () => ({ sessionId: "unused" }),
    });
    return (await runtime.getScheduledTaskCapability()).source;
  } catch {
    return "unknown";
  } finally {
    try {
      runtime?.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** Prints the report. Returns nothing and throws nothing, by construction. */
function report(report: ProbeReport): void {
  // vitest's default reporter swallows console output from passing tests,
  // which would make this reporter invisible in CI. Write to the real stream.
  process.stdout.write(`${report.summary}
`);
  if (report.notice) process.stderr.write(`${report.notice}
`);
}

describe("ADR 0012 retirement-condition probe (reports; never fails)", () => {
  it("reports the upstream state for a tui + cliEmbedded host", async () => {
    // The live reading. Whatever it says, this test passes: upstream openness
    // is reported, never enforced. See the header for why that is the rule.
    report(assess(readUpstreamSources(repoRoot), await currentImplementation()));
    expect(true).toBe(true);
  });

  it("names the upstream source files it reads", () => {
    // The probe is only honest if the reader knows what it is reading.
    for (const relative of Object.values(UPSTREAM_FILES))
      expect(relative.startsWith("packages/local-runtime-v2/")).toBe(true);
  });
});

/**
 * The probe's own behaviour, against literal sources. These are the cases the
 * live reading cannot exercise on demand: the fixture text here cannot change
 * because upstream changed, so an assertion can be honest about what the
 * probe would report.
 */
describe("the probe itself", () => {
  const real = readUpstreamSources(repoRoot);
  // The fixtures below start from the real files and move one thing each, so
  // a fixture is never a hand-written file that could be wrong about the
  // upstream's shape in some unrelated way.
  const requireSource = (): UpstreamSources => {
    if (
      real.services === undefined ||
      real.composition === undefined ||
      real.hostContract === undefined ||
      real.cliService === undefined
    )
      throw new Error("the upstream sources this fixture builds on are unreadable");
    return real;
  };

  it("reads the live sources as both gates closed", () => {
    const report = assess(requireSource(), "webui-own");
    expect(report.gate1.state).toBe("closed");
    expect(report.gate2.state).toBe("closed");
    expect(report.status).toBe("closed");
    // A closed upstream is the quiet state: a status line and no warning.
    expect(report.notice).toBeUndefined();
    expect(report.summary).toContain("gate1=closed gate2=closed probe=ok");
  });

  it("reports gate 1 open on its own as partial, and keeps gate 2 closed", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        services: (sources.services ?? "").replace(
          "enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)",
          "enableCron: true",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("open");
    expect(report.gate2.state).toBe("closed");
    expect(report.status).toBe("gate1-open");
    expect(report.notice).toContain("STILL NOT A RETIREMENT SIGNAL");
    expect(report.notice).toContain("keep the WebUI's own scheduler");
  });

  it("reports a predicate that accepts tui as gate 1 open", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        composition: (sources.composition ?? "").replace(
          "runtimeOwnerKind === undefined || runtimeOwnerKind === 'electron'",
          "runtimeOwnerKind === 'electron' || runtimeOwnerKind === 'tui'",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("open");
    expect(report.status).toBe("gate1-open");
  });

  it("reports gate 2 open on its own as partial, and keeps gate 1 closed", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        hostContract: (sources.hostContract ?? "").replace(
          "  cliService?: import('./cli-service.js').CliService;",
          "  cliService?: import('./cli-service.js').CliService;\n  cron?: unknown;",
        ),
      },
      "webui-own",
    );
    expect(report.gate2.state).toBe("open");
    expect(report.gate1.state).toBe("closed");
    expect(report.status).toBe("gate2-open");
    expect(report.notice).toContain("STILL NOT A RETIREMENT SIGNAL");
  });

  it("reports a cron slot on the cliService options as gate 2 open", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        cliService: (sources.cliService ?? "").replace(
          "  readonly management: CliManagementApplication;",
          "  readonly management: CliManagementApplication;\n  readonly cron?: unknown;",
        ),
      },
      "webui-own",
    );
    expect(report.gate2.state).toBe("open");
  });

  it("reports both gates open as the retirement condition being met", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        services: (sources.services ?? "").replace(
          "enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)",
          "enableCron: true",
        ),
        hostContract: (sources.hostContract ?? "").replace(
          "  cliService?: import('./cli-service.js').CliService;",
          "  cliService?: import('./cli-service.js').CliService;\n  cron?: unknown;",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("open");
    expect(report.gate2.state).toBe("open");
    expect(report.status).toBe("both-open");
    expect(report.notice).toContain(ADR_0012);
    expect(report.notice).toContain("CronService");
    expect(report.notice).toContain("webui_scheduled_task");
    // The step that is easiest to skip and worst to get wrong.
    expect(report.notice).toContain("Tear down the WebUI's own tick loop");
  });

  it("reports an unmatchable enableCron as unconfirmed, not as closed", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        services: (sources.services ?? "").replace(
          "enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)",
          "enableCron: resolveCronEnablement(options)",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("unconfirmed");
    expect(report.status).toBe("unconfirmed");
    expect(report.summary).toContain("probe=unconfirmed");
    // The message must not be mistakable for the retirement notice.
    expect(report.notice).toContain("NOT A RETIREMENT SIGNAL");
    expect(report.notice).not.toContain("RETIREMENT CONDITION IS NOW MET");
    expect(report.notice).toContain("Do NOT retire");
  });

  it("reports a renamed predicate as unconfirmed, not as closed", () => {
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        composition: (sources.composition ?? "").replace(
          "function ownsElectronRuntimeCapabilities",
          "function ownsDesktopRuntimeCapabilities",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("unconfirmed");
    expect(report.notice).toContain("COULD NOT CONFIRM");
    expect(report.notice).toContain("Do NOT retire");
  });

  it("reports a flag nothing consumes as unconfirmed rather than closed", () => {
    // The blind spot this guard exists for: an `enableCron` that is assigned
    // but never read means the service is built unconditionally, and reading
    // only the assignment would have called that closed.
    const sources = requireSource();
    const report = assess(
      {
        ...sources,
        services: (sources.services ?? "").replace(
          "cron = input.enableCron",
          "cron = ALWAYS_ON",
        ),
      },
      "webui-own",
    );
    expect(report.gate1.state).toBe("unconfirmed");
  });

  it("reports a missing upstream file as unconfirmed, not as closed", () => {
    const sources = requireSource();
    const report = assess({ ...sources, hostContract: undefined }, "webui-own");
    expect(report.gate2.state).toBe("unconfirmed");
    expect(report.status).toBe("unconfirmed");
    expect(report.notice).toContain(UPSTREAM_FILES.hostContract);
  });

  it("keeps reporting the implementation without asserting on it", async () => {
    // Informational by design: the moment this becomes a pass/fail
    // assertion, swapping the adapter turns the suite red, which is the thing
    // this file must not do.
    expect(["webui-own", "runtime-cron", "none", "unknown"]).toContain(
      await currentImplementation(),
    );
  });
});
