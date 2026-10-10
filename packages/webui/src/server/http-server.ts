// HTTP listener lifecycle for the loopback service: create the Node HTTP
// server, bind it to the loopback address and resolve once it is listening,
// and close it. Split from `service.ts` (plan section 7.1) with no behaviour
// change — the listen/close order and the non-TCP-socket guard are the ones
// the service wrote before.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export function createHttpListener(factory: (() => Server) | undefined): Server {
  const create = factory ?? (() => createServer());
  return create();
}

/**
 * Bind the server and resolve once it is listening. Resolves with the port the
 * kernel actually allocated so tests can reach it.
 */
export function listenHttpServer(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("WebUI service bound to a non-TCP socket");
        resolve((address as AddressInfo).port);
      } catch (error) {
        reject(error);
      }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeHttpListener(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
