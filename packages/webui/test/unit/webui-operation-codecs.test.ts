// The wire boundary's result decoding, where a body becomes a value business code reads.
//
// The case this file exists for: the handshake's capability manifest is *additive* — the
// service declares what it actually wired — and a codec that reconstructs the body field by
// field dropped it, so every consumer downstream saw a service that had declared nothing.
// A field nobody reads twice is exactly the one a reconstruction loses.

import { describe, expect, it } from "vitest";

import { webuiOperationResultCodecs } from "../../src/shared/operation-codecs.js";

describe("the decoded handshake", () => {
  it("keeps the capability manifest, family names and all", () => {
    const decoded = webuiOperationResultCodecs.version!({
      version: "1.2.3",
      protocolVersion: 7,
      dataDir: "/data",
      capabilities: { terminal: "absent", models: "supported", sessions: "not-ready" },
    });

    expect(decoded).toEqual({
      version: "1.2.3",
      protocolVersion: 7,
      dataDir: "/data",
      capabilities: { terminal: "absent", models: "supported", sessions: "not-ready" },
    });
  });

  it("keeps a family this build has never heard of, and drops a state it cannot read", () => {
    const decoded = webuiOperationResultCodecs.version!({
      version: "2.0.0",
      protocolVersion: 7,
      capabilities: { "some-future-family": "supported", terminal: "invented-state" },
    });

    // The name is open (a newer service may advertise one, and discarding it would make
    // the next version's manifest unreadable here); the state is closed, and an entry
    // carrying one this build does not know is left out rather than failing the boot.
    expect(decoded.capabilities).toEqual({ "some-future-family": "supported" });
  });

  it("omits the field entirely when the service sent none", () => {
    const decoded = webuiOperationResultCodecs.version!({ version: "1.0.0", protocolVersion: 7 });
    // Absent means "an older service", which is a different answer from an empty manifest.
    expect("capabilities" in decoded).toBe(false);
  });
});
