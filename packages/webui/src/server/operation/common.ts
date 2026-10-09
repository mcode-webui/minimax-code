import { WebuiErrorCode } from "../envelope.js";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { invalidBody, requireNonEmptyString, requireRecord } from "./operation-contract.js";
import type { WebuiOperationValidation } from "./operation-contract.js";
import type { WebuiPermissionDecision } from "../../shared/contracts/interactions.js";
import type { WebuiSessionLookupRequest } from "../../shared/contracts/session.js";
export function validateSessionIdBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<WebuiSessionLookupRequest> {
  const record = requireRecord(operation, body);
  if (!record.ok) return record;
  const id = requireNonEmptyString(operation, record.body, "id");
  if (typeof id !== "string") return id;
  return { ok: true, body: { id } };
}


/**
 * The one rule every working directory on the wire has to satisfy.
 *
 * A browser cannot produce an absolute path for a picked folder, so this
 * is what keeps a bare directory name out of a session's cwd. Both
 * `createSession` and the project picker's directory walk go through
 * here so the two entry points reject the same inputs with the same
 * wording. The value must already be trimmed.
 */
export function validateAbsoluteDirectory(
  operation: string,
  field: string,
  value: string,
): WebuiOperationValidation<string> {
  if (!value)
    return invalidBody(`${operation} ${field} must not be empty`);
  if (!isAbsolute(value))
    return invalidBody(`${operation} ${field} must be an absolute path`);
  try {
    if (!statSync(value).isDirectory())
      return invalidBody(`${operation} ${field} must be an existing directory`);
  } catch {
    return invalidBody(`${operation} ${field} must be an existing directory`);
  }
  return { ok: true, body: value };
}


export function validateObjectBody(operation: string, body: unknown): WebuiOperationValidation<Record<string, unknown>> {
  return requireRecord(operation, body);
}


export function validateConversationMutationBody(
  operation: string,
  body: unknown,
  required: readonly string[],
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  for (const key of required) {
    const value = requireNonEmptyString(operation, result.body, key);
    if (typeof value !== "string") return value;
  }
  return result;
}


export function validateBooleanField(
  operation: string,
  body: Record<string, unknown>,
  key: string,
): WebuiOperationValidation<Record<string, unknown>> | undefined {
  return body[key] !== undefined && typeof body[key] !== "boolean"
    ? { ok: false, code: WebuiErrorCode.invalidBody, message: `${operation} ${key} must be a boolean` }
    : undefined;
}


export function validateGoalSessionBody(operation: string, body: unknown): WebuiOperationValidation<{ readonly sessionId: string }> {
  const result = validateObjectBody(operation, body);
  if (!result.ok) return result as WebuiOperationValidation<{ readonly sessionId: string }>;
  if (typeof result.body.sessionId !== "string" || !result.body.sessionId.trim())
    return { ok: false, code: WebuiErrorCode.invalidBody, message: `${operation} body requires a non-empty sessionId` };
  return { ok: true, body: { sessionId: result.body.sessionId } };
}


export function validateOptionalObjectBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  if (body === undefined) return { ok: true, body: {} };
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${operation} body must be an object`,
    };
  return { ok: true, body: body as Record<string, unknown> };
}


export function validateNamedSessionBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<{
  readonly name: string;
  readonly sessionId: string;
}> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${operation} body must be an object`,
    };
  const candidate = body as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const sessionId =
    typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
  if (!name || !sessionId)
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${operation} body requires name and sessionId`,
    };
  return { ok: true, body: { name, sessionId } };
}


export function validatePermissionDecision(
  value: unknown,
): value is WebuiPermissionDecision {
  return value === "allowOnce" || value === "allowAlways" || value === "deny";
}
