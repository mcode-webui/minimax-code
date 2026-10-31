// Result codecs for the operations whose answers drive production decisions.
//
// The wire layer used to resolve a response with `frame.body as
// OperationSpec[K]["response"]`. The envelope around it was validated — version,
// kind, identity — but the *body* was an assertion: a syntactically valid frame
// carrying a wrong or half-shaped body entered business state as though it were
// the declared result, and the first thing that noticed was whichever surface
// happened to read the missing field.
//
// These codecs are the bounded repair. A codec is declared only where a
// production decision reads the answer: a provider test's `ok`/`status`, the
// handshake's version, the permission mode, a session mutation's `success`, the
// plugin action's payload. Everything else keeps its declared type and is not
// double-validated here — see `decodeWebuiOperationResult` for what an operation
// with no codec means.
//
// Three rules keep this from becoming a schema framework:
//
//   * **Pure and open.** A codec reads the fields the client consumes, keeps
//     every other field it was given, and never rejects an unknown extra. Error
//     codes stay open strings for forward compatibility, so an unfamiliar code is
//     part of the answer rather than a malformed frame.
//   * **Bounded to the consumed facts.** It answers "are the fields this client
//     branches on present and of the right kind", not "is this the complete
//     upstream object". Tightening to a closed shape would break the extension
//     fields the runtime is allowed to add.
//   * **One place.** The failure is a `WebuiWireError` with the stable
//     `invalid_envelope` code, raised where the value crosses the boundary, so a
//     caller sees a wire refusal instead of a downstream `TypeError`.

import { WebuiErrorCode, WebuiWireError } from "./envelope.js";
import type { WebuiSkillEntry } from "./contracts/models.js";
import type { WebuiVersionInfo } from "./contracts/version.js";
import type {
  WebuiCapabilityManifest,
  WebuiCapabilityState,
} from "./capability-manifest.js";
import type { OperationSpec, WebuiUnaryOperationName } from "./operation-names.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The refusal a body that cannot be the declared result earns. */
function malformed(operation: string, detail: string): WebuiWireError {
  return new WebuiWireError(
    WebuiErrorCode.invalidEnvelope,
    `${operation} returned a body that does not match its declared result: ${detail}`,
  );
}

/**
 * One provider outcome, as far as the client's own decisions read it.
 *
 * `ok`/`success` decide success, `code` is the refusal's stable half, `status` is
 * the cache status a test reports, and `models` is a list. All four are optional
 * because the runtime's three provider operations spell their verdict
 * differently; what is required here is only that each of them, *when present*, is
 * of the declared kind.
 */
function providerOutcome(operation: string) {
  return (body: unknown): unknown => {
    if (Array.isArray(body) || typeof body === "string") return body;
    if (!isRecord(body)) throw malformed(operation, "the body is not an object");
    for (const field of ["ok", "success"] as const) {
      const value = body[field];
      if (value !== undefined && typeof value !== "boolean") {
        throw malformed(operation, `\`${field}\` is ${typeof value}, not a boolean`);
      }
    }
    const code = body.code;
    if (code !== undefined && typeof code !== "string") {
      throw malformed(operation, "`code` is not a string");
    }
    const status = body.status;
    if (status !== undefined && !isRecord(status) && !Array.isArray(status)) {
      throw malformed(operation, "`status` is neither an object nor a list");
    }
    const models = body.models;
    if (models !== undefined && !Array.isArray(models)) {
      throw malformed(operation, "`models` is not a list");
    }
    return body;
  };
}

function permissionMode(operation: string) {
  return (body: unknown): unknown => {
    if (typeof body === "string") return body;
    if (isRecord(body) && (typeof body.mode === "string" || body.mode === undefined)) return body;
    throw malformed(operation, "the body is neither a mode string nor an object carrying one");
  };
}

/**
 * The declared codecs.
 *
 * A missing entry is a deliberate statement, not an oversight: the operation's
 * result is not read field-by-field by any production decision, so its declared
 * type is the whole contract. Adding a codec is how a new consumed fact becomes
 * validated at the boundary.
 */
export type WebuiOperationResultCodecs = {
  readonly [K in WebuiUnaryOperationName]?: (body: unknown) => OperationSpec[K]["response"];
};


/**
 * The handshake's capability manifest, as it survives the wire.
 *
 * Reconstructed rather than passed through, because the two halves have different
 * rules. The **family names** are open: a newer service may advertise one this build
 * has never heard of, and dropping it would make the next version's manifest
 * unreadable here. The **states** are a closed set, so an entry carrying a state this
 * build does not know is left out rather than failing the handshake — an additive
 * field must not be able to break an older client's boot.
 *
 * Dropping the field entirely was the bug: the service sent a manifest, this codec
 * rebuilt the body without it, and every consumer downstream saw a service that had
 * declared nothing.
 */
function readCapabilityManifest(
  value: unknown,
): { readonly capabilities: WebuiCapabilityManifest } | undefined {
  if (!isRecord(value)) return undefined;
  const capabilities: Record<string, WebuiCapabilityState> = {};
  for (const [name, state] of Object.entries(value)) {
    if (state === "supported" || state === "absent" || state === "not-ready") {
      capabilities[name] = state;
    }
  }
  return { capabilities };
}

export const webuiOperationResultCodecs: WebuiOperationResultCodecs = {
  version: (body) => {
    if (!isRecord(body)) throw malformed("version", "the body is not an object");
    const { version, protocolVersion, dataDir, capabilities } = body;
    if (typeof version !== "string") throw malformed("version", "`version` is not a string");
    if (typeof protocolVersion !== "number") {
      throw malformed("version", "`protocolVersion` is not a number");
    }
    return {
      version,
      protocolVersion,
      ...(typeof dataDir === "string" ? { dataDir } : {}),
      ...(readCapabilityManifest(capabilities) ?? {}),
    };
  },
  getMiniMaxModelSource: (body) => {
    if (body === "token_plan" || body === "minimax_api_key") return body;
    throw malformed("getMiniMaxModelSource", "the body is not a known model source");
  },
  setMiniMaxModelSource: (body) => {
    if (body === "token_plan" || body === "minimax_api_key") return body;
    throw malformed("setMiniMaxModelSource", "the body is not a known model source");
  },
  getPermissionMode: permissionMode("getPermissionMode"),
  setPermissionMode: permissionMode("setPermissionMode"),
  cancelAccountLogin: (body) => {
    if (isRecord(body) && body.ok === true) return { ok: true };
    throw malformed("cancelAccountLogin", "the body does not carry `ok: true`");
  },
  signOut: (body) => {
    if (isRecord(body) && body.success === true) return { success: true };
    throw malformed("signOut", "the body does not carry `success: true`");
  },
  archiveSession: (body) => {
    if (body === undefined) return {};
    if (isRecord(body) && (body.success === undefined || typeof body.success === "boolean")) {
      return typeof body.success === "boolean" ? { success: body.success } : {};
    }
    throw malformed("archiveSession", "the body does not carry an optional boolean `success`");
  },
  deleteSession: (body) => {
    if (body === undefined) return {};
    if (isRecord(body) && (body.success === undefined || typeof body.success === "boolean")) {
      return typeof body.success === "boolean" ? { success: body.success } : {};
    }
    throw malformed("deleteSession", "the body does not carry an optional boolean `success`");
  },
  selectModel: (body) => {
    // The composer branches on this flag, so its shape is checked here rather
    // than trusted and read with a cast at the call site.
    if (!isRecord(body) || (body.success !== undefined && typeof body.success !== "boolean")) {
      throw malformed("selectModel", "the body does not carry an optional boolean `success`");
    }
    return typeof body.success === "boolean" ? { success: body.success } : {};
  },
  createUserModelProvider: providerOutcome("createUserModelProvider"),
  updateUserModelProvider: providerOutcome("updateUserModelProvider"),
  deleteUserModelProvider: providerOutcome("deleteUserModelProvider"),
  testUserModelProvider: providerOutcome("testUserModelProvider"),
  testUserModel: providerOutcome("testUserModel"),
  discoverUserModelsCandidate: providerOutcome("discoverUserModelsCandidate"),
  saveUserModelProviderCandidate: providerOutcome("saveUserModelProviderCandidate"),
  testUserModelCandidate: providerOutcome("testUserModelCandidate"),
  upsertMiniMaxApiKey: providerOutcome("upsertMiniMaxApiKey"),
  refreshModels: providerOutcome("refreshModels"),
  startCodexOAuthLogin: providerOutcome("startCodexOAuthLogin"),
  cancelCodexOAuthLogin: providerOutcome("cancelCodexOAuthLogin"),
  listProviderPresets: (body) => {
    if (body === undefined) return [];
    if (!Array.isArray(body)) throw malformed("listProviderPresets", "the body is not a list");
    return body.filter(isRecord);
  },
  listSkills: (body) => {
    if (!isRecord(body) || !Array.isArray(body.skills)) {
      throw malformed("listSkills", "the body does not carry a `skills` list");
    }
    return { skills: body.skills.filter(isRecord) as unknown as readonly WebuiSkillEntry[] };
  },
  pluginManagement: (body) => {
    if (isRecord(body)) return body;
    throw malformed("pluginManagement", "the body is not an object");
  },
};

/**
 * Validate one unary response body against the codec declared for its operation.
 *
 * An operation with no codec returns its body unchanged: its declared type is the
 * contract, and no production decision reads a field the codec would have to
 * check. The distinction is deliberate and visible — a new consumed field is
 * added here, and until it is, the boundary is explicit about not judging it.
 */
export function decodeWebuiOperationResult<K extends WebuiUnaryOperationName>(
  operation: K,
  body: unknown,
): OperationSpec[K]["response"] {
  const codec = webuiOperationResultCodecs[operation];
  if (!codec) return body as OperationSpec[K]["response"];
  return (codec as (value: unknown) => OperationSpec[K]["response"])(body);
}

/** Whether an operation's result is validated at the boundary. */
export function hasWebuiOperationResultCodec(operation: WebuiUnaryOperationName): boolean {
  return webuiOperationResultCodecs[operation] !== undefined;
}
