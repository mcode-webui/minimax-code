// The project form: a remote folder, and the browser that picks it.
//
// The folder is picked on the remote machine, one directory at a time: the runtime lists one
// remote directory and the browser walks up and down through them. Nothing is mounted and nothing
// is copied — the project is a path on the far side.
import { useState, type ReactElement } from "react";

import type { WebuiSshConnection, WebuiSshProjectRequest } from "../../../../shared/contracts/ssh.js";
import type { WebuiSshDirectoryListing } from "../application/ssh-owner.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiSelect, WebuiTextInput } from "../../../ui/field.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

export interface SshProjectFormProps {
  readonly hosts: readonly WebuiSshConnection[];
  readonly onSubmit: (request: WebuiSshProjectRequest) => void;
  readonly onCancel: () => void;
  /** Lists one remote directory. */
  readonly onBrowse: (alias: string, path?: string) => Promise<WebuiSshDirectoryListing>;
  readonly error?: string;
}

/** The parent of a remote path, or the root when there is none. */
function parentPath(path: string): string {
  if (!path.startsWith("/")) return "/";
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function SshProjectForm(props: SshProjectFormProps): ReactElement {
  const [alias, setAlias] = useState(props.hosts[0]?.alias ?? "");
  const [path, setPath] = useState("/");
  const [displayName, setDisplayName] = useState("");
  const [listing, setListing] = useState<WebuiSshDirectoryListing | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);

  const browse = async (target: string): Promise<void> => {
    if (!alias) return;
    setBrowsing(true);
    try {
      const answer = await props.onBrowse(alias, target);
      if (answer.ok) {
        setListing(answer);
        setPath(answer.path);
      } else {
        setListing({ ok: false, message: answer.message });
      }
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <form
      aria-label="添加 SSH 项目"
      data-webui-component="ssh-project-form"
      className="rounded-[8px] border border-border_default px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit({ alias, path, ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }) });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <WebuiField
          label="主机"
          control={(controlProps) => (
            <WebuiSelect
              {...controlProps}
              controlSize="compact"
              data-webui-ssh-project-host="true"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
            >
              {props.hosts.map((host) => (
                <option key={host.alias} value={host.alias}>
                  {host.displayName || host.alias}
                </option>
              ))}
            </WebuiSelect>
          )}
        />
        <WebuiField
          label="名称"
          control={(controlProps) => (
            <WebuiTextInput
              {...controlProps}
              controlSize="compact"
              type="text"
              data-webui-ssh-project-name="true"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="mt-0.5"
            />
          )}
        />
        <WebuiField
          className="col-span-2"
          label="远端目录"
          control={(controlProps) => (
            <WebuiInline gap="small" className="mt-0.5 w-full">
              <WebuiTextInput
                {...controlProps}
                controlSize="compact"
                type="text"
                data-webui-ssh-project-path="true"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className="flex-1"
              />
              <WebuiButton variant="outline-secondary" size="inline-dense" data-webui-ssh-project-browse="true"
                onClick={() => void browse(path)}
                disabled={browsing || !alias}
                className="disabled:opacity-50"
              >
                浏览
              </WebuiButton>
            </WebuiInline>
          )}
        />
      </div>
      {listing
        ? listing.ok
          ? (
            <div data-webui-ssh-project-listing="true" className="mt-2 rounded-[6px] border-[0.5px] border-border_default p-2">
            <WebuiInline justify="between">
              <span className="font-mono text-xs text-text_default_secondary">{listing.path}</span>
              <WebuiButton variant="quiet-secondary" size="inline-tiny" data-webui-ssh-project-up="true"
                onClick={() => void browse(parentPath(listing.path))}

              >
                上一级
              </WebuiButton>
            </WebuiInline>
            {listing.entries.length === 0
              ? <p className="mt-1 text-xs text-text_default_tertiary">这个目录里没有条目。</p>
              : <WebuiStack as="ul" gap="micro" className="mt-1 max-h-40 overflow-y-auto">
                {listing.entries.map((entry) => (
                  <li key={entry.path}>
                    <WebuiButton variant="quiet-highlight" size="inline-tiny" data-webui-ssh-project-entry={entry.path}
                      onClick={() => {
                        if (entry.kind === "directory") void browse(entry.path);
                        else setPath(entry.path);
                      }}
                      className="w-full truncate text-left font-mono"
                    >
                      {entry.kind === "directory" ? `${entry.name}/` : entry.name}
                    </WebuiButton>
                  </li>
                ))}
              </WebuiStack>}
            </div>
          )
          : (
            <p data-webui-ssh-project-listing-error="true" className="mt-2 text-xs text-text_default_secondary">
              {listing.message}
            </p>
          )
        : null}
      {props.error
        ? <p data-webui-ssh-project-error="true" className="mt-2 text-xs text-text_default_secondary">
          {props.error}
        </p>
        : null}
      <WebuiInline gap="small" className="mt-2">
        <WebuiButton variant="outline" size="inline-dense" type="submit"
          data-webui-ssh-project-submit="true"

        >
          保存
        </WebuiButton>
        <WebuiButton variant="quiet-secondary" size="inline-dense" data-webui-ssh-project-cancel="true"
          onClick={props.onCancel}

        >
          取消
        </WebuiButton>
      </WebuiInline>
    </form>
  );
}
