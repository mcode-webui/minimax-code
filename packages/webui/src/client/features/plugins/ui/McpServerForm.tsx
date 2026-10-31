// The MCP server form unit.
//
// This form used to live as thirteen `useState` calls in `PluginCatalogue`, handed
// to the dialog as thirteen values and thirteen setters, with the save logic —
// the config assembly, the two JSON<->form translations, and every validation
// message — in the catalogue component as well. So the catalogue owned three
// unrelated forms' drafts, and the dialog knew nothing about MCP while receiving
// every MCP field.
//
// The draft is local here, where it is edited and where it is validated. What
// leaves this unit is an intent: a named command with the fields that command
// declares, which is what the owner's typed surface accepts. The rules are the
// ones the component carried, unchanged — same transports, same validation, same
// messages.

import { useState, type ReactElement } from "react";

import {
  readWebuiPluginRow as read,
  type WebuiPluginRow as Row,
} from "../contracts/plugin-rows.js";
import type { WebuiPluginIntent } from "../contracts/plugin-actions.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiDialogActions } from "../../../ui/dialog.js";
import { WebuiField, WebuiSelect, WebuiTextarea, WebuiTextInput } from "../../../ui/field.js";
import { ToggleSwitch } from "../../../ui/ToggleSwitch.js";
import { FeedbackError } from "../../../ui/feedback.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

export interface McpServerFormProps {
  /** The server being edited, or `undefined` for a new one. */
  readonly editing: Row | undefined;
  /** Run one command and report whether it succeeded. */
  readonly onSubmit: (intent: WebuiPluginIntent) => Promise<boolean>;
  readonly onClose: () => void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A JSON object of strings, or undefined for a blank draft. */
function parseRecord(value: string, label: string): Row | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label}必须是有效 JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label}必须是字符串键值对象`);
  }
  return parsed as Row;
}

/**
 * One server out of a pasted JSON document.
 *
 * Two shapes are accepted and they mean different things: a document whose root
 * *is* a server config (it carries `transport`), and a map of name → config,
 * optionally wrapped in `mcpServers`. Both are what the settings docs show, so
 * the form accepts both rather than picking one.
 */
function serverFromJson(
  source: string,
  fallbackName: string,
  fallbackEnabled: boolean,
): { name: string; enabled: boolean; config: Row } {
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("JSON 配置必须是对象");
  const root = parsed as Row;
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Row)
      : root;
  let name = fallbackName.trim();
  let rawConfig: Row;
  if (typeof servers.transport === "string") {
    if (typeof servers.name === "string") name = servers.name;
    rawConfig = servers;
  } else {
    const entries = Object.entries(servers);
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      !entry ||
      !entry[1] ||
      typeof entry[1] !== "object" ||
      Array.isArray(entry[1])
    ) {
      throw new Error("请提供单个 server 配置，或只包含一个 server 的 mcpServers 对象");
    }
    name = entry[0];
    rawConfig = entry[1] as Row;
  }
  if (!name) throw new Error("请填写 Server 名称");
  const { enabled, ...configWithName } = rawConfig;
  const config = { ...configWithName };
  delete config.name;
  return {
    name,
    enabled: typeof enabled === "boolean" ? enabled : fallbackEnabled,
    config,
  };
}

export function McpServerForm({ editing, onSubmit, onClose }: McpServerFormProps): ReactElement {
  const initialConfig = (
    editing?.config && typeof editing.config === "object" ? editing.config : {}
  ) as Row;
  const initialName = read(editing ?? {}, "name");

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(
    read(initialConfig, "description") || read(editing ?? {}, "description"),
  );
  const [transport, setTransport] = useState(
    read(initialConfig, "transport", "type") || "stdio",
  );
  const [command, setCommand] = useState(read(initialConfig, "command"));
  const [args, setArgs] = useState(
    Array.isArray(initialConfig.args) ? initialConfig.args.join(" ") : "",
  );
  const [url, setUrl] = useState(read(initialConfig, "url"));
  const [enabled, setEnabled] = useState(editing?.enabled !== false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [env, setEnv] = useState(JSON.stringify(initialConfig.env ?? {}, null, 2));
  const [headers, setHeaders] = useState(JSON.stringify(initialConfig.headers ?? {}, null, 2));
  const [timeoutMs, setTimeoutMs] = useState(
    typeof initialConfig.timeoutMs === "number" ? String(initialConfig.timeoutMs) : "",
  );
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState(() =>
    JSON.stringify(
      {
        [initialName || "my-mcp-server"]: {
          ...initialConfig,
          enabled: editing?.enabled !== false,
        },
      },
      null,
      2,
    ),
  );
  // Form-level messages only. Whether the runtime is reachable at all is the
  // owner's answer to report, and a mutation failure is its own state — the
  // three are not the same thing and must not collapse into one string.
  const [localError, setLocalError] = useState("");

  /** Form fields → one server config, validating as it goes. */
  const configFromForm = (): Row => {
    const parsedTimeout = timeoutMs.trim() ? Number(timeoutMs) : undefined;
    if (
      parsedTimeout !== undefined &&
      (!Number.isSafeInteger(parsedTimeout) || parsedTimeout <= 0)
    ) {
      throw new Error("超时必须是正整数（毫秒）");
    }
    const envRecord = transport === "stdio" ? parseRecord(env, "环境变量") : undefined;
    const headerRecord = transport === "stdio" ? undefined : parseRecord(headers, "请求头");
    return {
      transport,
      description,
      ...(parsedTimeout ? { timeoutMs: parsedTimeout } : {}),
      ...(transport === "stdio"
        ? {
            command,
            args: args.split(/\s+/u).filter(Boolean),
            ...(envRecord ? { env: envRecord } : {}),
          }
        : { url, ...(headerRecord ? { headers: headerRecord } : {}) }),
    };
  };

  /** Form fields → the JSON the other mode shows. */
  const jsonFromForm = (): string => {
    const config = configFromForm();
    config.enabled = enabled;
    return JSON.stringify({ [name.trim() || "my-mcp-server"]: config }, null, 2);
  };

  const toForm = () => {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("JSON 配置必须是对象");
      const root = parsed as Row;
      const servers =
        root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
          ? (root.mcpServers as Row)
          : root;
      let nextName = name.trim();
      let config: Row;
      if (typeof servers.transport === "string") {
        config = servers;
        if (typeof servers.name === "string") nextName = servers.name;
      } else {
        const entries = Object.entries(servers);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          !entry ||
          !entry[1] ||
          typeof entry[1] !== "object" ||
          Array.isArray(entry[1])
        ) {
          throw new Error("表单模式一次只能编辑一个 server");
        }
        nextName = entry[0];
        config = entry[1] as Row;
      }
      setName(nextName);
      setTransport(read(config, "transport", "type") || "stdio");
      setCommand(read(config, "command"));
      setArgs(Array.isArray(config.args) ? config.args.join(" ") : "");
      setUrl(read(config, "url"));
      setDescription(read(config, "description"));
      setEnabled(config.enabled !== false);
      setEnv(JSON.stringify(config.env ?? {}, null, 2));
      setHeaders(JSON.stringify(config.headers ?? {}, null, 2));
      setTimeoutMs(typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "");
      setJsonMode(false);
      setLocalError("");
    } catch (cause) {
      setLocalError(message(cause));
    }
  };

  const toJson = () => {
    try {
      setJson(jsonFromForm());
      setJsonMode(true);
      setLocalError("");
    } catch (cause) {
      setLocalError(message(cause));
    }
  };

  const save = async () => {
    let serverName = name.trim();
    let serverEnabled = enabled;
    let config: Row;
    if (jsonMode) {
      try {
        const draft = serverFromJson(json, name, enabled);
        serverName = draft.name;
        serverEnabled = draft.enabled;
        config = draft.config;
      } catch (cause) {
        setLocalError(message(cause));
        return;
      }
    } else {
      try {
        config = configFromForm();
      } catch (cause) {
        setLocalError(message(cause));
        return;
      }
    }

    const saved = editing
      ? await onSubmit({ kind: "updateMcpServer", name: serverName, config })
      : await onSubmit({ kind: "createMcpServer", name: serverName, config, enabled: serverEnabled });
    if (!saved) return;
    // Editing a server whose enabled flag moved is one user intent that needs
    // two commands: the config update does not carry the flag.
    if (editing && editing.enabled !== serverEnabled) {
      if (!(await onSubmit({ kind: "setMcpServerEnabled", name: serverName, enabled: serverEnabled })))
        return;
    }
    onClose();
  };

  const isStdio = transport === "stdio";
  const isTimeoutValid = !timeoutMs.trim() || (Number.isSafeInteger(Number(timeoutMs)) && Number(timeoutMs) > 0);
  const isConnectionValid = isStdio
    ? command.trim().length > 0
    : (() => {
        try {
          const parsed = new URL(url.trim());
          return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
        } catch {
          return false;
        }
      })();
  const isJsonValid = (() => {
    try {
      const draft = serverFromJson(json, name, enabled);
      const draftTransport = read(draft.config, "transport");
      const endpointValid = draftTransport === "stdio"
        ? read(draft.config, "command").trim().length > 0
        : (() => {
            try {
              const parsed = new URL(read(draft.config, "url").trim());
              return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
            } catch {
              return false;
            }
          })();
      return draft.name.trim().length > 0 && endpointValid;
    } catch {
      return false;
    }
  })();
  const canSave = jsonMode
    ? isJsonValid
    : name.trim().length > 0 && isConnectionValid && isTimeoutValid;

  return (
    <div className="webui-mcp-form">
      <div className="webui-mcp-mode">
        <WebuiButton variant={jsonMode ? "plain" : "surface"} size="compact" aria-pressed={!jsonMode} onClick={() => (jsonMode ? toForm() : undefined)}>
          表单
        </WebuiButton>
        <WebuiButton variant={jsonMode ? "surface" : "plain"} size="compact" aria-pressed={jsonMode} onClick={() => (jsonMode ? undefined : toJson())}>
          JSON
        </WebuiButton>
      </div>
      {jsonMode ? (
          <WebuiTextarea
          aria-label="MCP 配置 JSON"
          value={json}
          onChange={(event) => setJson(event.currentTarget.value)}
        />
      ) : (
        <div className="webui-mcp-form-fields">
          <WebuiField
            label="名称"
            required
            control={(props) => (
              <WebuiTextInput {...props} required value={name} onChange={(event) => setName(event.currentTarget.value)} />
            )}
          />
          <WebuiField
            label="传输方式"
            control={(props) => (
              <WebuiSelect {...props} value={transport} onChange={(event) => setTransport(event.currentTarget.value)}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="streamable-http">streamable-http</option>
                <option value="sse">sse</option>
              </WebuiSelect>
            )}
          />
          {isStdio ? (
            <>
              <WebuiField
                label="命令"
                required
                control={(props) => (
                  <WebuiTextInput {...props} required value={command} onChange={(event) => setCommand(event.currentTarget.value)} />
                )}
              />
              <WebuiField
                label="参数"
                control={(props) => (
                  <WebuiTextInput {...props} value={args} onChange={(event) => setArgs(event.currentTarget.value)} />
                )}
              />
            </>
          ) : (
            <WebuiField
              label="地址"
              required
              control={(props) => (
                <WebuiTextInput {...props} required value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
              )}
            />
          )}
          <WebuiField
            label="描述"
            className="webui-mcp-form-full-row"
            control={(props) => (
              <WebuiTextInput {...props} value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
            )}
          />
          <WebuiInline gap="medium" justify="between" className="webui-mcp-enabled">
            <WebuiStack gap="micro" className="webui-mcp-enabled-copy">
              <span className="webui-mcp-enabled-title">启用</span>
              <span className="webui-mcp-enabled-hint">允许 MiniMax Code 使用此服务。</span>
            </WebuiStack>
            <ToggleSwitch label="启用 MCP server" checked={enabled} onChange={setEnabled} />
          </WebuiInline>
          <WebuiButton variant="outline-secondary" size="compact" className="webui-mcp-advanced-button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
            高级
          </WebuiButton>
          {advancedOpen ? (
            <>
              {isStdio ? (
                <WebuiField
                  label="环境变量"
                  control={(props) => (
                    <WebuiTextarea {...props} value={env} onChange={(event) => setEnv(event.currentTarget.value)} />
                  )}
                />
              ) : (
                <WebuiField
                  label="请求头"
                  control={(props) => (
                    <WebuiTextarea {...props} value={headers} onChange={(event) => setHeaders(event.currentTarget.value)} />
                  )}
                />
              )}
              <WebuiField
                label="超时（毫秒）"
                control={(props) => (
                  <WebuiTextInput
                    {...props}
                    value={timeoutMs}
                    onChange={(event) => setTimeoutMs(event.currentTarget.value)}
                  />
                )}
              />
            </>
          ) : null}
        </div>
      )}
      {localError ? <FeedbackError message={localError} /> : null}
      <WebuiDialogActions>
        <WebuiButton variant="secondary" size="dialog" onClick={onClose}>
          取消
        </WebuiButton>
        <WebuiButton variant="primary" size="dialog" disabled={!canSave} onClick={() => void save()}>
          {editing ? "保存" : "添加服务器"}
        </WebuiButton>
      </WebuiDialogActions>
    </div>
  );
}
