import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

/**
 * Who holds a Mini App, recorded beside the endpoint that proves it.
 *
 * The binding is the truth and this record is the explanation: a live owner holds its endpoint, and the
 * operating system releases that binding when the owner dies. So a record whose endpoint nobody holds is
 * stale by definition, whatever its timestamp says.
 */
export interface MiniAppOwnerIdentity {
  readonly client: string;
  readonly pid: number;
  readonly startedAtMs: number;
}

export type MiniAppOwnerAcquisition =
  | { readonly kind: 'acquired'; release(): Promise<void> }
  | { readonly kind: 'held'; readonly owner?: MiniAppOwnerIdentity };

export interface AcquireMiniAppOwnerInput {
  /** The Mini App's own directory in the shared data directory. */
  readonly pluginDataDir: string;
  readonly pluginId: string;
  readonly identity: Omit<MiniAppOwnerIdentity, 'pid' | 'startedAtMs'>;
  readonly nowMs?: () => number;
  readonly platform?: NodeJS.Platform;
}

const SOCKET_FILE = 'owner.sock';
const RECORD_FILE = 'owner.json';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\mcode-miniapp-owner-';

/** A socket file on POSIX, a named pipe on Windows — named from the plugin id, never from the directory. */
export function resolveMiniAppOwnerEndpoint(
  pluginDataDir: string,
  pluginId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256').update(pluginId).digest('hex').slice(0, 16);
    return `${WINDOWS_PIPE_PREFIX}${digest}`;
  }
  return path.join(pluginDataDir, SOCKET_FILE);
}

/**
 * Takes ownership of one Mini App, or reports who holds it.
 *
 * A failed bind means somebody is listening; an unheld socket file means a previous owner died without
 * cleaning up. The two are told apart by trying to connect: a refused connection proves the file is a
 * leftover, and only then is it removed. Nothing is unlinked before the first bind attempt, because that
 * would steal a live owner's endpoint.
 */
export async function acquireMiniAppOwner(
  input: AcquireMiniAppOwnerInput,
): Promise<MiniAppOwnerAcquisition> {
  const nowMs = input.nowMs ?? Date.now;
  const platform = input.platform ?? process.platform;
  const endpoint = resolveMiniAppOwnerEndpoint(input.pluginDataDir, input.pluginId, platform);
  if (platform !== 'win32') await mkdir(input.pluginDataDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = net.createServer((socket) => socket.destroy());
    const bound = await bind(server, endpoint);
    if (bound) {
      const identity: MiniAppOwnerIdentity = {
        client: input.identity.client,
        pid: process.pid,
        startedAtMs: nowMs(),
      };
      await writeOwnerRecord(input.pluginDataDir, identity);
      let released = false;
      return {
        kind: 'acquired',
        async release() {
          if (released) return;
          released = true;
          await close(server);
          await rm(endpoint, { force: true });
          await rm(path.join(input.pluginDataDir, RECORD_FILE), { force: true });
        },
      };
    }
    if (attempt === 0 && (await isLeftoverEndpoint(endpoint))) {
      await rm(endpoint, { force: true });
      continue;
    }
    const owner = await readMiniAppOwnerIdentity(input.pluginDataDir);
    return { kind: 'held', ...(owner ? { owner } : {}) };
  }
  const owner = await readMiniAppOwnerIdentity(input.pluginDataDir);
  return { kind: 'held', ...(owner ? { owner } : {}) };
}

function bind(server: net.Server, endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      server.close();
      if (error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

/** True only when the endpoint exists and nothing answers on it. */
function isLeftoverEndpoint(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    const finish = (leftover: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(leftover);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT');
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function writeOwnerRecord(
  pluginDataDir: string,
  identity: MiniAppOwnerIdentity,
): Promise<void> {
  try {
    await writeFile(
      path.join(pluginDataDir, RECORD_FILE),
      `${JSON.stringify(identity)}\n`,
      'utf8',
    );
  } catch {
    // The binding already proves ownership; a record that cannot be written changes nothing.
  }
}

export async function readMiniAppOwnerIdentity(
  pluginDataDir: string,
): Promise<MiniAppOwnerIdentity | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(pluginDataDir, RECORD_FILE), 'utf8')) as unknown;
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as MiniAppOwnerIdentity).client === 'string' &&
      typeof (raw as MiniAppOwnerIdentity).pid === 'number'
    ) {
      return raw as MiniAppOwnerIdentity;
    }
  } catch {
    // An absent or unreadable record still leaves the endpoint answering for the owner.
  }
  return undefined;
}
