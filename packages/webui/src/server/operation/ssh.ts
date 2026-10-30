// The SSH wire operations.
//
// Fifteen operations: the saved hosts, the hosts in `~/.ssh/config`, the projects rooted on a host,
// the remote folder browser and the remote terminal. They belong in one file because they are one
// domain and one client business.
//
// Each validator checks the shape a browser may send — the identity a mutation names, the fields a
// form fills — and never learns the runtime's model: the runtime's own records stay inside the
// service and the harness adapter converts them.
//
// A password is a field like any other here, with one rule: it is accepted on the way in and never
// echoed back. Nothing in this file writes it, logs it or returns it.
import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  CLOSE_SSH_TERMINAL_OPERATION_NAME,
  DISCOVER_SSH_HOSTS_OPERATION_NAME,
  LIST_SSH_CONNECTIONS_OPERATION_NAME,
  LIST_SSH_DIRECTORIES_OPERATION_NAME,
  LIST_SSH_PROJECTS_OPERATION_NAME,
  OPEN_SSH_TERMINAL_OPERATION_NAME,
  PROBE_SSH_CONNECTION_OPERATION_NAME,
  REMOVE_SSH_CONNECTION_OPERATION_NAME,
  REMOVE_SSH_PROJECT_OPERATION_NAME,
  RESIZE_SSH_TERMINAL_OPERATION_NAME,
  SAVE_SSH_CONNECTION_OPERATION_NAME,
  SAVE_SSH_PROJECT_OPERATION_NAME,
  SET_SSH_CONNECTION_ENABLED_OPERATION_NAME,
  WATCH_SSH_TERMINAL_OPERATION_NAME,
  WRITE_SSH_TERMINAL_OPERATION_NAME,
} from "../../shared/operation-names.js";
import type {
  WebuiSshConnection,
  WebuiSshDiscovery,
  WebuiSshEndpoint,
  WebuiSshEndpointKind,
  WebuiSshListDirectoriesRequest,
  WebuiSshListDirectoriesResult,
  WebuiSshProbeResult,
  WebuiSshProject,
  WebuiSshProjectRequest,
  WebuiSshProjectResult,
  WebuiSshRemoveResult,
  WebuiSshSaveConnectionRequest,
  WebuiSshSaveConnectionResult,
  WebuiSshSetEnabledRequest,
  WebuiSshTerminalSession,
} from "../../shared/contracts/ssh.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import { invalidBody, requireNonEmptyString, requireRecord } from "./operation-contract.js";

const ENDPOINT_KINDS: readonly WebuiSshEndpointKind[] = ["manual", "ssh_config"];

/** An operation that takes no body at all. */
function noBody(operation: string, body: unknown): WebuiOperationValidation<undefined> {
  return body === undefined
    ? { ok: true, body: undefined }
    : {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `${operation} does not accept a body`,
      };
}

/** A field that may be absent, and is a string when it is there. */
type OptionalText =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: string };

function optionalText(value: unknown, field: string): OptionalText {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${field}必须是字符串。` };
  return { ok: true, value };
}

/** The endpoint a host form fills. */
function readEndpoint(value: unknown): WebuiSshEndpoint | { readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "endpoint必须是对象。" };
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(ENDPOINT_KINDS as readonly string[]).includes(kind)) {
    return { error: "endpoint.kind必须是manual或ssh_config。" };
  }
  const host = optionalText(record.host, "endpoint.host");
  if (!host.ok) return host;
  const username = optionalText(record.username, "endpoint.username");
  if (!username.ok) return username;
  const identityFile = optionalText(record.identityFile, "endpoint.identityFile");
  if (!identityFile.ok) return identityFile;
  const alias = optionalText(record.alias, "endpoint.alias");
  if (!alias.ok) return alias;
  const port = record.port;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port))) {
    return { error: "endpoint.port必须是整数。" };
  }
  return {
    kind: kind as WebuiSshEndpointKind,
    ...(host.value === undefined ? {} : { host: host.value }),
    ...(port === undefined ? {} : { port: port as number }),
    ...(username.value === undefined ? {} : { username: username.value }),
    ...(identityFile.value === undefined ? {} : { identityFile: identityFile.value }),
    ...(alias.value === undefined ? {} : { alias: alias.value }),
  };
}

export const listSshConnectionsOperation: WebuiOperation<
  undefined,
  readonly WebuiSshConnection[]
> = {
  name: LIST_SSH_CONNECTIONS_OPERATION_NAME,
  validate: (body) => noBody(LIST_SSH_CONNECTIONS_OPERATION_NAME, body),
};

export const saveSshConnectionOperation: WebuiOperation<
  WebuiSshSaveConnectionRequest,
  WebuiSshSaveConnectionResult
> = {
  name: SAVE_SSH_CONNECTION_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(SAVE_SSH_CONNECTION_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(SAVE_SSH_CONNECTION_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    const displayName = optionalText(record.body.displayName, "displayName");
    if (!displayName.ok) return invalidBody(displayName.error);
    const password = optionalText(record.body.password, "password");
    if (!password.ok) return invalidBody(password.error);
    const enabled = record.body.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return invalidBody(`${SAVE_SSH_CONNECTION_OPERATION_NAME} enabled必须是布尔值。`);
    }
    const endpoint = readEndpoint(record.body.endpoint);
    if ("error" in endpoint) return invalidBody(endpoint.error);
    return {
      ok: true,
      body: {
        alias,
        endpoint,
        ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
        ...(password.value === undefined ? {} : { password: password.value }),
        ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
      },
    };
  },
};

export const setSshConnectionEnabledOperation: WebuiOperation<
  WebuiSshSetEnabledRequest,
  WebuiSshSaveConnectionResult
> = {
  name: SET_SSH_CONNECTION_ENABLED_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(SET_SSH_CONNECTION_ENABLED_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(SET_SSH_CONNECTION_ENABLED_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    const enabled = record.body.enabled;
    if (typeof enabled !== "boolean") {
      return invalidBody(`${SET_SSH_CONNECTION_ENABLED_OPERATION_NAME} enabled必须是布尔值。`);
    }
    return { ok: true, body: { alias, enabled } };
  },
};

export const removeSshConnectionOperation: WebuiOperation<
  { readonly alias: string },
  WebuiSshRemoveResult
> = {
  name: REMOVE_SSH_CONNECTION_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(REMOVE_SSH_CONNECTION_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(REMOVE_SSH_CONNECTION_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    return { ok: true, body: { alias } };
  },
};

export const discoverSshHostsOperation: WebuiOperation<undefined, WebuiSshDiscovery> = {
  name: DISCOVER_SSH_HOSTS_OPERATION_NAME,
  validate: (body) => noBody(DISCOVER_SSH_HOSTS_OPERATION_NAME, body),
};

export const probeSshConnectionOperation: WebuiOperation<
  { readonly alias: string },
  WebuiSshProbeResult
> = {
  name: PROBE_SSH_CONNECTION_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(PROBE_SSH_CONNECTION_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(PROBE_SSH_CONNECTION_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    return { ok: true, body: { alias } };
  },
};

export const listSshDirectoriesOperation: WebuiOperation<
  WebuiSshListDirectoriesRequest,
  WebuiSshListDirectoriesResult
> = {
  name: LIST_SSH_DIRECTORIES_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(LIST_SSH_DIRECTORIES_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(LIST_SSH_DIRECTORIES_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    const path = optionalText(record.body.path, "path");
    if (!path.ok) return invalidBody(path.error);
    return {
      ok: true,
      body: { alias, ...(path.value === undefined ? {} : { path: path.value }) },
    };
  },
};

export const listSshProjectsOperation: WebuiOperation<undefined, readonly WebuiSshProject[]> = {
  name: LIST_SSH_PROJECTS_OPERATION_NAME,
  validate: (body) => noBody(LIST_SSH_PROJECTS_OPERATION_NAME, body),
};

export const saveSshProjectOperation: WebuiOperation<
  WebuiSshProjectRequest,
  WebuiSshProjectResult
> = {
  name: SAVE_SSH_PROJECT_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(SAVE_SSH_PROJECT_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(SAVE_SSH_PROJECT_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    const path = requireNonEmptyString(SAVE_SSH_PROJECT_OPERATION_NAME, record.body, "path");
    if (typeof path !== "string") return path;
    const id = optionalText(record.body.id, "id");
    if (!id.ok) return invalidBody(id.error);
    const displayName = optionalText(record.body.displayName, "displayName");
    if (!displayName.ok) return invalidBody(displayName.error);
    return {
      ok: true,
      body: {
        alias,
        path,
        ...(id.value === undefined ? {} : { id: id.value }),
        ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
      },
    };
  },
};

export const removeSshProjectOperation: WebuiOperation<
  { readonly id: string },
  WebuiSshProjectResult
> = {
  name: REMOVE_SSH_PROJECT_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(REMOVE_SSH_PROJECT_OPERATION_NAME, body);
    if (!record.ok) return record;
    const id = requireNonEmptyString(REMOVE_SSH_PROJECT_OPERATION_NAME, record.body, "id");
    if (typeof id !== "string") return id;
    return { ok: true, body: { id } };
  },
};

export const openSshTerminalOperation: WebuiOperation<
  { readonly alias: string; readonly path?: string },
  WebuiSshTerminalSession
> = {
  name: OPEN_SSH_TERMINAL_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(OPEN_SSH_TERMINAL_OPERATION_NAME, body);
    if (!record.ok) return record;
    const alias = requireNonEmptyString(OPEN_SSH_TERMINAL_OPERATION_NAME, record.body, "alias");
    if (typeof alias !== "string") return alias;
    const path = optionalText(record.body.path, "path");
    if (!path.ok) return invalidBody(path.error);
    return {
      ok: true,
      body: { alias, ...(path.value === undefined ? {} : { path: path.value }) },
    };
  },
};

export const writeSshTerminalOperation: WebuiOperation<
  { readonly terminalId: string; readonly data: string },
  { readonly accepted: boolean }
> = {
  name: WRITE_SSH_TERMINAL_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(WRITE_SSH_TERMINAL_OPERATION_NAME, body);
    if (!record.ok) return record;
    const terminalId = requireNonEmptyString(WRITE_SSH_TERMINAL_OPERATION_NAME, record.body, "terminalId");
    if (typeof terminalId !== "string") return terminalId;
    const data = record.body.data;
    if (typeof data !== "string") {
      return invalidBody(`${WRITE_SSH_TERMINAL_OPERATION_NAME} data必须是字符串。`);
    }
    return { ok: true, body: { terminalId, data } };
  },
};

export const resizeSshTerminalOperation: WebuiOperation<
  { readonly terminalId: string; readonly cols: number; readonly rows: number },
  { readonly accepted: boolean }
> = {
  name: RESIZE_SSH_TERMINAL_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(RESIZE_SSH_TERMINAL_OPERATION_NAME, body);
    if (!record.ok) return record;
    const terminalId = requireNonEmptyString(RESIZE_SSH_TERMINAL_OPERATION_NAME, record.body, "terminalId");
    if (typeof terminalId !== "string") return terminalId;
    const cols = record.body.cols;
    const rows = record.body.rows;
    if (typeof cols !== "number" || !Number.isInteger(cols) || cols <= 0) {
      return invalidBody(`${RESIZE_SSH_TERMINAL_OPERATION_NAME} cols必须是正整数。`);
    }
    if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) {
      return invalidBody(`${RESIZE_SSH_TERMINAL_OPERATION_NAME} rows必须是正整数。`);
    }
    return { ok: true, body: { terminalId, cols, rows } };
  },
};

export const closeSshTerminalOperation: WebuiOperation<
  { readonly terminalId: string },
  { readonly accepted: boolean }
> = {
  name: CLOSE_SSH_TERMINAL_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(CLOSE_SSH_TERMINAL_OPERATION_NAME, body);
    if (!record.ok) return record;
    const terminalId = requireNonEmptyString(CLOSE_SSH_TERMINAL_OPERATION_NAME, record.body, "terminalId");
    if (typeof terminalId !== "string") return terminalId;
    return { ok: true, body: { terminalId } };
  },
};

export const watchSshTerminalOperation: WebuiOperation<
  { readonly terminalId: string },
  unknown
> = {
  name: WATCH_SSH_TERMINAL_OPERATION_NAME,
  validate: (body) => {
    const record = requireRecord(WATCH_SSH_TERMINAL_OPERATION_NAME, body);
    if (!record.ok) return record;
    const terminalId = requireNonEmptyString(WATCH_SSH_TERMINAL_OPERATION_NAME, record.body, "terminalId");
    if (typeof terminalId !== "string") return terminalId;
    return { ok: true, body: { terminalId } };
  },
};
