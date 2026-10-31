// The host form: add a host by hand, or take one from `~/.ssh/config`.
//
// The two kinds are the runtime's own: `manual` is a host, a port, a user and a key typed in;
// `ssh_config` is an alias from the config file, which the runtime resolves through OpenSSH.
//
// The password field is a one-shot: it is handed to the host for the first handshake and is not
// kept in the browser.
import { useState, type ReactElement } from "react";

import type { WebuiSshSaveConnectionRequest } from "../../../../shared/contracts/ssh.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiRadio, WebuiTextInput } from "../../../ui/field.js";
import { WebuiInline } from "../../../ui/layout-primitives.js";

export interface SshHostFormProps {
  readonly onSubmit: (request: WebuiSshSaveConnectionRequest) => void;
  readonly onCancel: () => void;
  /** The host the person picked in the discovered list, if any. */
  readonly initial?: {
    readonly alias: string;
    readonly hostname?: string;
    readonly user?: string;
    readonly port?: number;
    readonly identityFile?: string;
  };
  readonly error?: string;
  readonly busy?: boolean;
}

export function SshHostForm(props: SshHostFormProps): ReactElement {
  const initial = props.initial;
  const [kind, setKind] = useState<"manual" | "ssh_config">(initial ? "ssh_config" : "manual");
  const [alias, setAlias] = useState(initial?.alias ?? "");
  const [displayName, setDisplayName] = useState("");
  const [host, setHost] = useState(initial?.hostname ?? "");
  const [port, setPort] = useState(initial?.port ? String(initial.port) : "");
  const [username, setUsername] = useState(initial?.user ?? "");
  const [identityFile, setIdentityFile] = useState(initial?.identityFile ?? "");
  const [password, setPassword] = useState("");

  const submit = (): void => {
    const portNumber = port.trim() === "" ? undefined : Number.parseInt(port.trim(), 10);
    const request: WebuiSshSaveConnectionRequest = {
      alias: alias.trim(),
      ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }),
      endpoint:
        kind === "ssh_config"
          ? {
              kind: "ssh_config",
              alias: alias.trim(),
              ...(host.trim() === "" ? {} : { host: host.trim() }),
              ...(portNumber === undefined || Number.isNaN(portNumber) ? {} : { port: portNumber }),
              ...(username.trim() === "" ? {} : { username: username.trim() }),
              ...(identityFile.trim() === "" ? {} : { identityFile: identityFile.trim() }),
            }
          : {
              kind: "manual",
              host: host.trim(),
              ...(portNumber === undefined || Number.isNaN(portNumber) ? {} : { port: portNumber }),
              ...(username.trim() === "" ? {} : { username: username.trim() }),
              ...(identityFile.trim() === "" ? {} : { identityFile: identityFile.trim() }),
            },
      ...(password === "" ? {} : { password }),
    };
    props.onSubmit(request);
  };

  return (
    <form
      aria-label="添加 SSH 主机"
      data-webui-component="ssh-host-form"
      className="rounded-[8px] border border-border_default px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <WebuiInline gap="medium">
        <WebuiInline as="label" gap="tight" className="text-xs text-text_default_secondary">
          <WebuiRadio
            name="webui-ssh-kind"
            data-webui-ssh-kind="manual"
            checked={kind === "manual"}
            onChange={() => setKind("manual")}
          />
          手动填写
        </WebuiInline>
        <WebuiInline as="label" gap="tight" className="text-xs text-text_default_secondary">
          <WebuiRadio
            name="webui-ssh-kind"
            data-webui-ssh-kind="ssh_config"
            checked={kind === "ssh_config"}
            onChange={() => setKind("ssh_config")}
          />
          来自 ~/.ssh/config
        </WebuiInline>
      </WebuiInline>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <WebuiField
          className="col-span-2"
          label="别名"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="alias"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          className="col-span-2"
          label="显示名称"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          label="主机"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          label="端口"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="port"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          label="用户名"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          label="私钥文件"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-field="identityFile"
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          className="col-span-2"
          label="密码（仅用于第一次握手，不会保存在浏览器里）"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="password"
              data-webui-ssh-field="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
      </div>
      {props.error
        ? <p data-webui-ssh-form-error="true" className="mt-2 text-xs text-text_default_secondary">
          {props.error}
        </p>
        : null}
      <WebuiInline gap="small" className="mt-2">
        <WebuiButton variant="outline" size="inline-dense" type="submit"
          data-webui-ssh-form-submit="true"
          disabled={props.busy}
        >
          保存
        </WebuiButton>
        <WebuiButton variant="quiet-secondary" size="inline-dense" data-webui-ssh-form-cancel="true"
          onClick={props.onCancel}

        >
          取消
        </WebuiButton>
      </WebuiInline>
    </form>
  );
}
