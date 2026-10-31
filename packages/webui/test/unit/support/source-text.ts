// Reading a module's source as text, for the assertions that can only be made
// that way.
//
// This package's Vitest environment is `node` with no DOM, so several
// behaviours are structurally unreachable here: no effect runs, so a control
// that needs fetched data never renders. Those tests read the component instead,
// and the ones that matter most are *structural* claims no runtime assertion can
// make — "exactly one definition of this hook, and exactly one call site", which
// is how a cleaned-up duplication is kept from creeping back.
//
// `squashWhitespace` is what keeps those claims about structure rather than
// about formatting. A pattern like `/\) && view === "market"/` describes one
// line of formatted source; run a formatter over that file and the same
// behaviour re-wraps across two lines and the test goes red for nothing. Every
// run of whitespace becomes one space first, so the claim survives a re-wrap.

import { readFileSync } from "node:fs";

/** The text of a module under `src/client`, given a path relative to it. */
export function readWebuiSource(relativePath: string): string {
  return readFileSync(new URL(`../../../src/client/${relativePath}`, import.meta.url), "utf8");
}

/** Every run of whitespace as a single space, so re-wrapping cannot break a match. */
export function squashWhitespace(source: string): string {
  return source.replace(/\s+/gu, " ");
}
