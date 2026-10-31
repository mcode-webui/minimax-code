// The acceptance record.
//
// Two tickets ask for a recorded result rather than a claim: the browser
// version, the operating system, the settings that were enabled, and what was
// observed. A matrix written by hand drifts from what the suites actually did,
// so the suites write the record while they run and the published matrix is
// written from it.
//
// The file is workspace material, not a published document: the published
// matrix is `packages/webui/docs/browser-use/09-acceptance-record.md`, and it
// says which run it was written from.
//
// The records live under the plan that asked for them, in that plan's
// `complete/` directory, so a second plan's records cannot land on top of this
// one's.
//
// One file per suite. A suite replaces its own file on the first record of a
// run, so a re-run cannot leave a case behind from the previous one, and the
// suites cannot overwrite each other's records.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { resolve } from "node:path";

/** What one acceptance case observed. */
export interface AcceptanceObservation {
  /** The surface the case ran on. */
  readonly surface: string;
  /** The browser the case drove. */
  readonly browser: string;
  /** The browser's own version string. */
  readonly browserVersion: string;
  /** Which entry the case went through. */
  readonly entry: "development" | "packaged";
  /** The case's name. */
  readonly case: string;
  /**
   * The configuration the case ran under.
   *
   * Read from the host where the host knows it: the switch states come from
   * the bridge's own snapshot, so the record says what was in force rather
   * than what the test intended. The switches the bridge does not carry are
   * named as such.
   *
   * A function is read **after** the case body has run, so the record
   * describes the state the observation was made in rather than the state the
   * case started in.
   */
  readonly settings:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  /** What was observed. */
  readonly observed: string;
  /** Whether the case held. */
  readonly result: "pass" | "fail";
}

/** One recorded run. */
export interface AcceptanceRecord extends AcceptanceObservation {
  /** When the case ran. */
  readonly at: string;
  /** The operating system the case ran on. */
  readonly os: string;
  /** The suite the case belongs to. */
  readonly suite: string;
}

/**
 * The plans that record acceptance results, and the directory each one owns.
 *
 * A record is read as evidence **for the plan that asked for it**, so the
 * directory is named rather than defaulted: a suite that recorded into a plan
 * it does not belong to would have its cases published as somebody else's.
 * Two plans are recording today — the browser-use programme and the
 * workspace browser tab model that amends it.
 */
const PLAN_DIRECTORIES = {
  "browser-use": "../../../../.plan/browser-use/complete",
  "workspace-browser-tab": "../../../../.plan/workspace-browser-tab/complete",
} as const;

/**
 * The record files as the checkout had them.
 *
 * A record file is **tracked**: the plan's `complete/` directory is where the
 * accepted evidence lives, and the file in the checkout is the record of the
 * run that was accepted. A run rewrites it — every record carries the time
 * and the machine it ran on — so the working tree is dirty once the suite is
 * over.
 *
 * That dirt is not a source change, and the release packaging refuses to run
 * with a dirty tree ("Packaging requires a clean committed working tree"), so
 * on CI the run puts the files back when it is over.
 *
 * Locally the records stay: they are what the run just produced, and the
 * published matrix is written from them. A suite that recorded into a file
 * the checkout does not have leaves no file behind either.
 */
const originals = new Map<string, string | null>();

/** Remembers a record file's content the first time the run writes to it. */
function rememberOriginal(path: string): void {
  if (originals.has(path)) return;
  originals.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
}

/**
 * Puts the record files back the way the checkout had them.
 *
 * On CI. A record file is tracked, so a run leaves the working tree dirty —
 * every record carries the time and the machine it ran on — and the release
 * packaging refuses to run with a dirty tree ("Packaging requires a clean
 * committed working tree"). That dirt is the run's own timestamps, not a
 * source change, so the suite puts the files back when it is done.
 *
 * Locally the records stay: they are what the run just produced, and the
 * published matrix is written from them.
 */
export function restoreAcceptanceRecords(): void {
  if (process.env.CI !== "true") return;
  for (const [path, content] of originals) {
    if (content === null) {
      rmSync(path, { force: true });
      continue;
    }
    writeFileSync(path, content, "utf8");
  }
  originals.clear();
}

/** A plan whose acceptance results are recorded. */
export type WebuiAcceptancePlan = keyof typeof PLAN_DIRECTORIES;

/** The records of one plan: one file per suite, under that plan's `complete/`. */
export interface AcceptanceRecords {
  /** Empties one suite's file, at the start of a run. */
  beginSuite(suite: string): void;
  /** Writes one record for a suite. */
  record(suite: string, observation: AcceptanceObservation): void;
  /** Runs one case and records what it observed. */
  observe(
    suite: string,
    observation: Omit<AcceptanceObservation, "result">,
    body: () => Promise<void>,
  ): Promise<void>;
}

/**
 * The records of one plan.
 *
 * Each plan gets its own `started` set as well as its own directory: which
 * suites have written a record is a question about a plan's directory, not
 * about the process.
 */
export function acceptanceRecordsFor(plan: WebuiAcceptancePlan): AcceptanceRecords {
  const recordDir = resolve(new URL(PLAN_DIRECTORIES[plan], import.meta.url).pathname);
  /** The suites of this plan that have written a record in this process. */
  const started = new Set<string>();

  /**
   * Start a suite's record.
   *
   * The suite's file is emptied here, at the start of the run, rather than on
   * its first record: a run that fails during setup — the extension does not
   * build, the browser does not start — would otherwise leave the **previous**
   * run's cases in place, and the file would then read as a pass for cases
   * that never ran.
   */
  function beginSuite(suite: string): void {
    mkdirSync(recordDir, { recursive: true });
    const path = resolve(recordDir, `${suite}.acceptance.json`);
    rememberOriginal(path);
    writeFileSync(path, "[]\n", "utf8");
    started.add(suite);
  }

  /**
   * Write one record for a suite.
   *
   * The suite's file is replaced on its first record of the process, so a
   * second run of the same suite starts from an empty file rather than
   * appending to the previous run's cases.
   */
  function record(suite: string, observation: AcceptanceObservation): void {
    const written: AcceptanceRecord = {
      ...observation,
      at: new Date().toISOString(),
      os: `${process.platform} ${release()}`,
      suite,
    };
    mkdirSync(recordDir, { recursive: true });
    const path = resolve(recordDir, `${suite}.acceptance.json`);
    rememberOriginal(path);
    if (!started.has(suite)) {
      started.add(suite);
      writeFileSync(path, "[]\n", "utf8");
    }
    const existing = readRecords(path);
    existing.push(written);
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  }

  /**
   * Run one acceptance case and record what it observed.
   *
   * A failed case is recorded as a failure before the error is re-thrown: a
   * record that only holds the passing cases is a record of what was supposed
   * to happen, which is not what was asked for.
   */
  async function observe(
    suite: string,
    observation: Omit<AcceptanceObservation, "result">,
    body: () => Promise<void>,
  ): Promise<void> {
    const settings = (): Readonly<Record<string, unknown>> =>
      typeof observation.settings === "function"
        ? observation.settings()
        : observation.settings;
    try {
      await body();
      record(suite, { ...observation, settings: settings(), result: "pass" });
    } catch (error) {
      record(suite, {
        ...observation,
        settings: settings(),
        result: "fail",
        observed: `${observation.observed} — failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      throw error;
    }
  }

  return { beginSuite, record, observe };
}

/**
 * The browser-use programme's records.
 *
 * Those suites call the module-level names below, which is what keeps them
 * writing into that plan's own `complete/` unchanged; a suite of a later plan
 * asks for its own records instead.
 */
const browserUseRecords = acceptanceRecordsFor("browser-use");

export const beginAcceptanceSuite = browserUseRecords.beginSuite;
export const recordAcceptance = browserUseRecords.record;
export const observeAcceptance = browserUseRecords.observe;

function readRecords(path: string): AcceptanceRecord[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AcceptanceRecord[]) : [];
  } catch {
    return [];
  }
}
