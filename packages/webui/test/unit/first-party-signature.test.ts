// The first-party request signature (U19).
//
// Three call sites used to build this triple inline — the matrix quota POST,
// the matrix account-identity GET and the daily check-in request — with the
// salt copied out three times and `md5` declared privately in two files. They
// now share `runtime/signing.ts`, and this file pins the rule so the next
// caller can be added without re-deriving it.
//
// The values are recomputed here from the documented rule rather than copied
// from a previous run: a hard-coded digest would pin today's md5 of today's
// string and would still pass if the rule changed shape.
//
// The salt is the one value this file does restate, on purpose: it is a wire
// constant a coordinated server rollout has to move, so an accidental edit to
// it should go red here as well as in `signing.ts`. Everything else is derived.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { md5Hex, webuiFirstPartySignatureHeaders } from "../../src/runtime/signing.js";

const md5 = (value: string): string =>
  createHash("md5").update(value).digest("hex");

describe("webuiFirstPartySignatureHeaders", () => {
  it("hashes the path and the request time into yy", () => {
    const nowMs = 1_700_000_000_123;
    const headers = webuiFirstPartySignatureHeaders({
      pathWithSearch: "/v1/user/info?tz=8",
      nowMs,
    });
    expect(headers.yy).toBe(
      md5(`%2Fv1%2Fuser%2Finfo%3Ftz%3D8_{}${md5(String(nowMs))}ooui`),
    );
  });

  it("reports the timestamp in seconds", () => {
    expect(
      webuiFirstPartySignatureHeaders({ pathWithSearch: "/", nowMs: 1_700_000_000_123 })[
        "x-timestamp"
      ],
    ).toBe("1700000000");
  });

  it("signs the body when there is one, and the empty string when there is not", () => {
    const salt = "I*7Cf%WZ#S&%1RlZJ&C2";
    const second = "1700000000";
    const body = '{"a":1}';

    expect(
      webuiFirstPartySignatureHeaders({
        pathWithSearch: "/",
        nowMs: 1_700_000_000_000,
        body,
      })["x-signature"],
    ).toBe(md5(`${second}${salt}${body}`));

    expect(
      webuiFirstPartySignatureHeaders({ pathWithSearch: "/", nowMs: 1_700_000_000_000 })[
        "x-signature"
      ],
    ).toBe(md5(`${second}${salt}`));
  });

  it("distinguishes a bodyless request from one that sends an empty body", () => {
    // The asymmetry is the protocol's. `yy` signs the literal `{}` that a
    // bodyless request still carries server-side, while `x-signature` signs
    // nothing; an explicitly empty body is a body, so both sign it as `""`.
    // Collapsing the two cases would change the bytes the endpoints check.
    const nowMs = 1_700_000_000_000;
    const stamp = md5(String(nowMs));
    const bodyless = webuiFirstPartySignatureHeaders({ pathWithSearch: "/x", nowMs });
    const emptyBody = webuiFirstPartySignatureHeaders({
      pathWithSearch: "/x",
      nowMs,
      body: "",
    });

    expect(bodyless.yy).toBe(md5(`%2Fx_{}${stamp}ooui`));
    expect(emptyBody.yy).toBe(md5(`%2Fx_${stamp}ooui`));
    expect(bodyless["x-signature"]).toBe(emptyBody["x-signature"]);
  });

  it("changes the signature when the body changes", () => {
    const base = { pathWithSearch: "/x", nowMs: 1_700_000_000_000 };
    expect(
      webuiFirstPartySignatureHeaders({ ...base, body: '{"a":1}' })["x-signature"],
    ).not.toBe(
      webuiFirstPartySignatureHeaders({ ...base, body: '{"a":2}' })["x-signature"],
    );
  });

  it("keeps md5Hex a plain hex digest", () => {
    expect(md5Hex("")).toBe(md5(""));
    expect(md5Hex("abc")).toMatch(/^[0-9a-f]{32}$/u);
  });
});
