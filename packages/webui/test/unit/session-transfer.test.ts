// Download-name rules for an exported session.
//
// This file used to hold 28 contract tests over the transfer format itself --
// the on-disk canonical reader, the cursor walk, the payload builder. All of
// that moved into the runtime's `SessionTransferApplication`, which is the
// only layer that can read both storage layers without loss, and it is tested
// there. What is left here is the one decision that is genuinely the WebUI's:
// what the browser should call the file.

import { describe, expect, it } from "vitest";
import { webuiSessionTransferFileName } from "../../src/server/session-transfer.js";

const AT = "2026-10-03T04:42:59.970Z";
// `:` and `-` are stripped; the `T` separator and the fractional part are
// dropped after the first `.`, so the stamp is `20261003T044259`.
const STAMP = "20261003T044259";

describe("webuiSessionTransferFileName", () => {
  it("names the file after the session and stamps the export time", () => {
    expect(webuiSessionTransferFileName("mvs_1", { title: "Fix the parser" }, AT)).toBe(
      `Fix the parser-${STAMP}.transfer.json`,
    );
  });

  it("falls back through agent name to session id", () => {
    expect(webuiSessionTransferFileName("mvs_1", { title: "   ", agentName: "mavis" }, AT)).toBe(
      `mavis-${STAMP}.transfer.json`,
    );
    expect(webuiSessionTransferFileName("mvs_1", {}, AT)).toBe(`mvs_1-${STAMP}.transfer.json`);
  });

  it("replaces characters a filesystem would reject", () => {
    const name = webuiSessionTransferFileName("mvs_1", { title: 'a/b\\c:d*e?f"g<h>i|j' }, AT);
    expect(name).toBe(`a_b_c_d_e_f_g_h_i_j-${STAMP}.transfer.json`);
  });

  it("strips control characters rather than emitting them into a path", () => {
    const name = webuiSessionTransferFileName("mvs_1", { title: "a\u0000b\u001Fc\u007Fd" }, AT);
    expect(name).toBe(`a b c d-${STAMP}.transfer.json`);
  });

  it("collapses whitespace and drops trailing dots and spaces", () => {
    expect(webuiSessionTransferFileName("mvs_1", { title: "  a   b  ...  " }, AT)).toBe(
      `a b-${STAMP}.transfer.json`,
    );
  });

  it("falls back to the session id when a title has no alphanumeric content", () => {
    // `***` is legal but useless: every export would collide on one name.
    expect(webuiSessionTransferFileName("mvs_1", { title: "***" }, AT)).toBe(
      `mvs_1-${STAMP}.transfer.json`,
    );
    expect(webuiSessionTransferFileName("mvs_1", { title: "..." }, AT)).toBe(
      `mvs_1-${STAMP}.transfer.json`,
    );
  });

  it("keeps non-latin titles, and truncates over-long ones", () => {
    expect(webuiSessionTransferFileName("mvs_1", { title: "解析器修复" }, AT)).toBe(
      `解析器修复-${STAMP}.transfer.json`,
    );
    const long = webuiSessionTransferFileName("mvs_1", { title: "x".repeat(400) }, AT);
    expect(long).toBe(`${"x".repeat(120)}-${STAMP}.transfer.json`);
  });

  it("applies the alphanumerics check after truncation, not before", () => {
    // 130 dashes then letters: the letters sit past the 120-char cap, so what
    // survives truncation has no alphanumerics and the name falls back to the
    // session id. Checking before truncating would keep a 120-dash name that
    // is different from nothing -- and identical for every such title.
    const name = webuiSessionTransferFileName("mvs_1", { title: "-".repeat(130) + "abc" }, AT);
    expect(name).toBe(`mvs_1-${STAMP}.transfer.json`);
  });
});
