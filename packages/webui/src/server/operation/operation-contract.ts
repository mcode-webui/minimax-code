import { WebuiErrorCode, type WebuiErrorCodeValue } from "../../shared/envelope.js";
import type {
  WebuiSendMessageResult,
  WebuiWatchEventsResult,
} from "../../shared/contracts/stream.js";

export interface WebuiOperationContext {
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface WebuiOperationResult<Body> {
  readonly body: Body;
}

export interface WebuiOperationStreamResult {
  readonly stream: WebuiSendMessageResult | WebuiWatchEventsResult;
}

export type WebuiOperationHandler<Body, ResultBody = Body> = (
  context: WebuiOperationContext,
  body: Body,
) =>
  | Promise<WebuiOperationResult<ResultBody> | WebuiOperationStreamResult>
  | WebuiOperationResult<ResultBody>
  | WebuiOperationStreamResult;

export interface WebuiOperation<Body = unknown, ResultBody = Body> {
  readonly name: string;
  readonly validate: (body: unknown) => WebuiOperationValidation<Body>;
  /**
   * Opt this stream operation into the acknowledgement frame. Off by
   * default: the data streams (`sendMessage`, `resumeSession`,
   * `watchTerminal`) keep their original wire shape — a consumer that
   * expects only `event` frames is unaffected. Only an operation that needs
   * to tell "accepted" from "still connecting" sets this, which today is
   * the event watcher: it is the one stream with no payload of its own to
   * observe.
   */
  readonly acknowledgesStream?: boolean;
}

export type WebuiOperationValidation<Body> =
  | { readonly ok: true; readonly body: Body }
  | {
      readonly ok: false;
      readonly code: WebuiErrorCodeValue;
      readonly message: string;
    };

export type ValidationFailure = {
  readonly ok: false;
  readonly code: typeof WebuiErrorCode.invalidBody;
  readonly message: string;
};

export function invalidBody(message: string): ValidationFailure {
  return { ok: false, code: WebuiErrorCode.invalidBody, message };
}

export function requireRecord(
  operation: string,
  body: unknown,
): { readonly ok: true; readonly body: Record<string, unknown> } | ValidationFailure {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? { ok: true, body: body as Record<string, unknown> }
    : invalidBody(`${operation} body must be an object`);
}

export function requireNonEmptyString(
  operation: string,
  body: Record<string, unknown>,
  key: string,
): string | ValidationFailure {
  const value = body[key];
  return typeof value === "string" && value.trim() !== ""
    ? value
    : invalidBody(`${operation} body requires a non-empty ${key}`);
}

export interface WebuiOperationRegistryEntry {
  readonly operation: WebuiOperation;
  readonly handle: WebuiOperationHandler<unknown>;
}

export interface WebuiOperationRegistration<Body = unknown, ResultBody = Body> {
  readonly operation: WebuiOperation<Body, ResultBody>;
  readonly handle: (
    context: WebuiOperationContext,
    body: Body,
  ) =>
    | Promise<WebuiOperationResult<ResultBody> | WebuiOperationStreamResult>
    | WebuiOperationResult<ResultBody>
    | WebuiOperationStreamResult;
}
