// One Chrome DevTools Protocol connection.
//
// The repository speaks CDP as raw JSON-RPC over a `ws` WebSocket rather than
// through a typed DevTools client package: there is no such package in the
// dependency set, and the protocol surface Browser Use needs is small enough
// that hand-rolling the correlation is cheaper than taking on a dependency
// whose only job would be to wrap the same socket.
//
// Three properties matter more than features here:
//
//   * **Correlation.** Responses carry an `id`; the connection pairs them with
//     the request that is waiting for them. Events carry no id and go to the
//     listeners instead.
//   * **Bounded commands.** Every command has a deadline. A command that runs
//     out of time rejects with `browser_operation_timeout` rather than hanging
//     the caller forever.
//   * **Cancellation.** A command whose signal aborts rejects with
//     `browser_operation_cancelled`. The distinction matters: a cancelled
//     command did not happen, a timed-out command may still be running in the
//     browser, and only the second kind may require the connection to be reset.

import WebSocket from "ws";

import { browserOperationError } from "../errors.js";

/**
 * How long a single CDP command may take before it is abandoned.
 *
 * The budget is a guard against a wedged browser, not a performance target: a
 * command that runs out of time rejects instead of hanging the caller
 * forever. It has to be generous enough for a browser that is *busy* rather
 * than broken, because the two are the same thing from here.
 *
 * On a loaded machine — a CI runner with three cores, where the WebUI suite
 * drives a browser while an Agent turn is still streaming — the browser
 * answers a page open in about half a minute and a pointer dispatch in
 * seconds. The old fifteen-second budget turned that slowness into a
 * failure: the open was abandoned halfway, so the panel never received a
 * frame and the person saw an empty browser instead of a slow one.
 */
export const WEBUI_BROWSER_CDP_COMMAND_TIMEOUT_MS = 60_000;

/**
 * How long an input command may take.
 *
 * An input command is answered by the browser without waiting for the page to
 * do anything, so it gets a shorter budget than the commands that wait for
 * the browser to work on the page. A person is waiting for a click to land.
 */
export const WEBUI_BROWSER_CDP_INPUT_TIMEOUT_MS = 30_000;

/** How long the WebSocket handshake may take. */
export const WEBUI_BROWSER_CDP_HANDSHAKE_TIMEOUT_MS = 10_000;

/** One CDP event. */
export interface WebuiBrowserCdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

/** A listener for CDP events. */
export type WebuiBrowserCdpEventListener = (event: WebuiBrowserCdpEvent) => void;

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort: () => void;
}

/**
 * One browser-level CDP connection.
 *
 * "Browser-level" means the socket is the browser's endpoint, not a page's.
 * Page-scoped commands are addressed by passing the session id that
 * `Target.attachToTarget` returned; browser-scoped commands (creating a
 * target, listing targets) are sent without one.
 */
export class WebuiBrowserCdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Set<WebuiBrowserCdpEventListener>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => this.#handleMessage(raw.toString()));
    socket.on("close", () => this.#failAll("browser_provider_unavailable", "The DevTools connection closed."));
    socket.on("error", (error: Error) =>
      this.#failAll("browser_provider_unavailable", `The DevTools connection failed: ${error.message}`),
    );
  }

  /** Opens a connection to a DevTools endpoint. */
  static async connect(
    endpoint: string,
    timeoutMs = WEBUI_BROWSER_CDP_HANDSHAKE_TIMEOUT_MS,
  ): Promise<WebuiBrowserCdpConnection> {
    const socket = new WebSocket(endpoint, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(
          browserOperationError(
            "browser_operation_timeout",
            "The DevTools connection handshake timed out.",
            true,
          ),
        );
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(
          browserOperationError(
            "browser_provider_unavailable",
            `The DevTools connection failed: ${error.message}`,
            true,
          ),
        );
      });
    });
    return new WebuiBrowserCdpConnection(socket);
  }

  /**
   * Sends one command and awaits its answer.
   *
   * The session id addresses a page; without one the command goes to the
   * browser itself.
   */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The DevTools connection is closed.",
        true,
      );
    }
    if (options.signal?.aborted) {
      throw browserOperationError(
        "browser_operation_cancelled",
        "The browser operation was cancelled.",
      );
    }
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          browserOperationError(
            "browser_operation_timeout",
            `The DevTools command "${method}" timed out.`,
            true,
          ),
        );
      }, options.timeoutMs ?? WEBUI_BROWSER_CDP_COMMAND_TIMEOUT_MS);

      const onAbort = () => {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(
          browserOperationError(
            "browser_operation_cancelled",
            "The browser operation was cancelled.",
          ),
        );
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanupAbort: () => options.signal?.removeEventListener("abort", onAbort),
      });

      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(
          browserOperationError(
            "browser_provider_failed",
            `The DevTools command "${method}" could not be sent: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  /** Subscribes to CDP events. The returned function unsubscribes. */
  onEvent(listener: WebuiBrowserCdpEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Closes the connection and fails every command still waiting. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll("browser_provider_unavailable", "The DevTools connection closed.");
    try {
      this.#socket.close();
    } catch {
      // A socket that is already gone needs no closing.
    }
  }

  #handleMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      const error = message.error as { message?: string } | undefined;
      if (error) {
        pending.reject(
          browserOperationError(
            "browser_provider_failed",
            error.message ?? "The DevTools command failed.",
          ),
        );
        return;
      }
      pending.resolve(message.result ?? {});
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (!method) return;
    const event: WebuiBrowserCdpEvent = {
      method,
      params: (message.params as Record<string, unknown> | undefined) ?? {},
      ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws must not take the connection down with it.
      }
    }
  }

  #failAll(code: "browser_provider_unavailable", message: string): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(browserOperationError(code, message, true));
    }
  }
}
