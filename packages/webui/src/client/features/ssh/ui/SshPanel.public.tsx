// The published surface of the SSH business.
//
// The shell is a peer of this business and may only import what the business publishes, and a
// published module may not re-export another module's symbol — so the panel lives here and is
// published as itself rather than through a forwarding file.
//
// Split in two on purpose. `SshPanelView` is a pure render of a snapshot, so a test can pin every
// branch — the host rows, the two empty states, the project rows, the terminal — through
// `renderToStaticMarkup` without a DOM (there is no jsdom in this package). `SshPanel` is the thin
// part that subscribes to the owner and reads once when it opens.
//
// The panel is a surface of its own: it does not assume which page hosts it. The settings page's
// `连接` tab and the 远程 page's `SSH` entry both mount this one component.
import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";

import type {
  WebuiSshConnection,
  WebuiSshDiscoveredHost,
  WebuiSshProject,
} from "../../../../shared/contracts/ssh.js";
import type {
  WebuiSshSnapshot,
  WebuiSshTerminalSnapshot,
} from "../application/ssh-owner.js";
import type { createWebuiSshOwner } from "../application/ssh-owner.js";
import {
  webuiSshDiscoveredHostRows,
  webuiSshDiscoveryEmptyText,
  webuiSshHostRows,
  webuiSshProjectRows,
  WEBUI_SSH_LOADING_TEXT,
  WEBUI_SSH_NO_CONNECTIONS_TEXT,
} from "../projection/ssh-panel.js";
import { SshHostForm } from "./ssh-host-form.js";
import { SshProjectForm } from "./ssh-project-form.js";
import { SshTerminalView } from "./ssh-terminal-view.js";
import { ContentPage } from "../../../ui/content-page.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

export interface SshPanelViewProps {
  readonly snapshot: WebuiSshSnapshot;
  readonly terminal: WebuiSshTerminalSnapshot;
  /** The host form, when it is open. */
  readonly hostForm?: ReactNode;
  /** The project form, when it is open. */
  readonly projectForm?: ReactNode;
  /** The discovered-host picker, when it is open. */
  readonly discoveredHosts?: ReactNode;
  /** A message from the last action: what a removal took with it, or why an action failed. */
  readonly notice?: string;
  readonly onRefresh: () => void;
  readonly onAddHost: () => void;
  readonly onToggleHost: (connection: WebuiSshConnection) => void;
  readonly onProbeHost: (connection: WebuiSshConnection) => void;
  readonly onRemoveHost: (connection: WebuiSshConnection) => void;
  readonly onDiscoverHosts: () => void;
  readonly onAddProject: () => void;
  readonly onRemoveProject: (project: WebuiSshProject) => void;
  readonly onOpenTerminal: (connection: WebuiSshConnection) => void;
  readonly onCloseTerminal: () => void;
  readonly onTerminalInput: (data: string) => void;
  /** The host whose removal is asking for confirmation. */
  readonly confirmingRemove?: string;
  readonly onRequestRemove: (connection: WebuiSshConnection) => void;
  readonly onCancelRemove: () => void;
}

export function SshPanelView(props: SshPanelViewProps): ReactElement {
  const hostRows = webuiSshHostRows(props.snapshot.connections);
  const projectRows = webuiSshProjectRows(props.snapshot.projects);
  const discoveryEmpty = webuiSshDiscoveryEmptyText(props.snapshot.discovery);
  // "No host at all" is only true of a successful read: a failed one is not empty, and saying so
  // would invite the person to add a host they may already have.
  const showEmpty =
    hostRows.length === 0 && props.snapshot.status === "ready" && props.snapshot.projects.length === 0;

  return (
    <ContentPage
      ariaLabel="SSH"
      dataAttributes={{ "data-webui-component": "ssh-panel" }}
      title="SSH"
      actions={
        <>
          <WebuiButton variant="outline" size="inline" data-webui-ssh-new-host="true"
            onClick={props.onAddHost}

          >
            添加主机
          </WebuiButton>
          <WebuiButton variant="outline" size="inline" data-webui-ssh-new-project="true"
            onClick={props.onAddProject}

          >
            添加项目
          </WebuiButton>
          <WebuiButton variant="outline-highlight" size="inline" data-webui-ssh-discover="true"
            onClick={props.onDiscoverHosts}

          >
            发现主机
          </WebuiButton>
          <WebuiButton variant="outline-highlight" size="inline" data-webui-ssh-refresh="true"
            onClick={props.onRefresh}

          >
            刷新
          </WebuiButton>
        </>
      }
    >
        {props.hostForm}
        {props.projectForm}
        {props.discoveredHosts}
        {props.notice === undefined
          ? null
          : <p data-webui-ssh-notice="true" className="mb-3 text-sm text-text_default_secondary">
            {props.notice}
          </p>}
        {props.snapshot.status === "error" && props.snapshot.error
          ? <p data-webui-ssh-error="true" className="mb-3 text-sm text-text_default_secondary">
            {props.snapshot.error}
          </p>
          : null}
        {props.snapshot.status === "loading" && hostRows.length === 0
          ? <p data-webui-ssh-loading="true" className="text-sm text-text_default_tertiary">
            {WEBUI_SSH_LOADING_TEXT}
          </p>
          : null}
        {showEmpty
          ? <p data-webui-ssh-empty="true" className="text-sm text-text_default_tertiary">
            {WEBUI_SSH_NO_CONNECTIONS_TEXT}
          </p>
          : null}
        <WebuiStack as="ul" gap="small">
          {hostRows.map((row) => (
            <li
              key={row.alias}
              data-webui-ssh-host={row.alias}
              className="rounded-[8px] border border-border_default px-3 py-2"
            >
              <WebuiInline gap="medium" justify="between">
                <span className="text-sm font-medium text-text_default_primary">{row.displayName}</span>
                <span
                  data-webui-ssh-status={row.alias}
                  className="text-xs text-text_default_tertiary"
                >
                  {row.statusLabel}
                </span>
              </WebuiInline>
              <p className="mt-1 font-mono text-xs text-text_default_secondary">{row.endpointLabel}</p>
              {row.errorLabel === undefined
                ? null
                : <p data-webui-ssh-host-error={row.alias} className="mt-0.5 text-xs text-text_default_tertiary">
                  {row.errorLabel}
                </p>}
              <WebuiInline gap="small" className="mt-2">
                <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-toggle={row.alias}
                  onClick={() => {
                    const connection = props.snapshot.connections.find((item) => item.alias === row.alias);
                    if (connection) props.onToggleHost(connection);
                  }}

                >
                  {row.enabled ? "停用" : "启用"}
                </WebuiButton>
                <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-probe={row.alias}
                  onClick={() => {
                    const connection = props.snapshot.connections.find((item) => item.alias === row.alias);
                    if (connection) props.onProbeHost(connection);
                  }}

                >
                  探测
                </WebuiButton>
                <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-terminal={row.alias}
                  onClick={() => {
                    const connection = props.snapshot.connections.find((item) => item.alias === row.alias);
                    if (connection) props.onOpenTerminal(connection);
                  }}

                >
                  打开终端
                </WebuiButton>
                {props.confirmingRemove === row.alias
                  ? <>
                    <WebuiButton variant="outline" size="inline-tiny" data-webui-ssh-remove-confirm={row.alias}
                      onClick={() => {
                        const connection = props.snapshot.connections.find((item) => item.alias === row.alias);
                        if (connection) props.onRemoveHost(connection);
                      }}

                    >
                      确认删除
                    </WebuiButton>
                    <WebuiButton variant="quiet-subtle" size="inline-tiny" data-webui-ssh-remove-cancel={row.alias}
                      onClick={props.onCancelRemove}

                    >
                      取消
                    </WebuiButton>
                  </>
                  : <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-remove={row.alias}
                    onClick={() => {
                      const connection = props.snapshot.connections.find((item) => item.alias === row.alias);
                      if (connection) props.onRequestRemove(connection);
                    }}

                  >
                    删除
                  </WebuiButton>}
              </WebuiInline>
            </li>
          ))}
        </WebuiStack>
        {projectRows.length === 0
          ? null
          : <WebuiStack as="ul" gap="small" className="mt-3">
            {projectRows.map((row) => (
              <li
                key={row.id}
                data-webui-ssh-project={row.id}
                className="rounded-[8px] border border-border_default px-3 py-2"
              >
                <WebuiInline gap="medium" justify="between">
                  <span className="text-sm font-medium text-text_default_primary">{row.displayName}</span>
                  <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-project-remove={row.id}
                    onClick={() => {
                      const project = props.snapshot.projects.find((item) => item.id === row.id);
                      if (project) props.onRemoveProject(project);
                    }}

                  >
                    删除
                  </WebuiButton>
                </WebuiInline>
                <p className="mt-1 font-mono text-xs text-text_default_secondary">
                  {row.alias} · {row.path}
                </p>
              </li>
            ))}
          </WebuiStack>}
        {discoveryEmpty
          ? <p data-webui-ssh-discovery-empty="true" className="mt-3 text-xs text-text_default_tertiary">
            {discoveryEmpty}
          </p>
          : null}
        <SshTerminalView
          terminal={props.terminal}
          onInput={props.onTerminalInput}
          onClose={props.onCloseTerminal}
        />
      </ContentPage>
  );
}

/**
 * The published panel.
 *
 * The owner is the only thing it needs: the panel reads the snapshot, subscribes to the owner's
 * changes and turns the person's clicks into the owner's calls. Which page hosts it is not the
 * panel's business.
 */
export interface SshPanelProps {
  readonly owner: ReturnType<typeof createWebuiSshOwner>;
}

export function SshPanel(props: SshPanelProps): ReactElement {
  const snapshot = useSyncExternalStore(
    props.owner.subscribe,
    props.owner.getSnapshot,
    props.owner.getSnapshot,
  );
  const terminal = useSyncExternalStore(
    props.owner.subscribe,
    props.owner.getTerminalSnapshot,
    props.owner.getTerminalSnapshot,
  );
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [discoveredOpen, setDiscoveredOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState<string | undefined>(undefined);
  const [pickedHost, setPickedHost] = useState<WebuiSshDiscoveredHost | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void props.owner.load();
  }, [props.owner]);

  const terminalId = terminal.terminalId;
  useEffect(() => props.owner.watchTerminal(), [props.owner, terminalId]);

  return (
    <SshPanelView
      snapshot={snapshot}
      terminal={terminal}
      {...(hostFormOpen
        ? {
            hostForm: (
              <SshHostForm
                {...(pickedHost
                  ? {
                      initial: {
                        alias: pickedHost.alias,
                        ...(pickedHost.hostname === undefined ? {} : { hostname: pickedHost.hostname }),
                        ...(pickedHost.user === undefined ? {} : { user: pickedHost.user }),
                        ...(pickedHost.port === undefined ? {} : { port: pickedHost.port }),
                        ...(pickedHost.identityFile === undefined
                          ? {}
                          : { identityFile: pickedHost.identityFile }),
                      },
                    }
                  : {})}
                onCancel={() => setHostFormOpen(false)}
                error={error}
                onSubmit={(request) => {
                  void props.owner.saveConnection(request).then((answer) => {
                    if (answer.ok) {
                      setHostFormOpen(false);
                      setError(undefined);
                      setNotice(
                        answer.probe && answer.probe.status !== "connected"
                          ? `已保存，但探测失败：${answer.probe.detail ?? answer.probe.status}`
                          : "已保存。",
                      );
                      return;
                    }
                    setError(answer.message);
                  });
                }}
              />
            ),
          }
        : {})}
      {...(projectFormOpen
        ? {
            projectForm: (
              <SshProjectForm
                hosts={snapshot.connections}
                error={error}
                onBrowse={(alias, path) => props.owner.listDirectories(alias, path)}
                onCancel={() => setProjectFormOpen(false)}
                onSubmit={(request) => {
                  void props.owner.saveProject(request).then((answer) => {
                    if (answer.ok) {
                      setProjectFormOpen(false);
                      setError(undefined);
                      setNotice("已保存项目。");
                      return;
                    }
                    setError(answer.message);
                  });
                }}
              />
            ),
          }
        : {})}
      {...(discoveredOpen
        ? {
            discoveredHosts: (
              <div
                data-webui-ssh-discovered="true"
                className="rounded-[8px] border border-border_default px-3 py-2"
              >
                <p className="text-xs text-text_default_tertiary">~/.ssh/config 中的主机</p>
                {webuiSshDiscoveredHostRows(snapshot.discovery).length === 0
                  ? <p className="mt-1 text-xs text-text_default_tertiary">
                    {webuiSshDiscoveryEmptyText(snapshot.discovery) ?? ""}
                  </p>
                  : <WebuiStack as="ul" gap="micro" className="mt-1">
                    {webuiSshDiscoveredHostRows(snapshot.discovery).map((row) => (
                      <li key={row.alias}>
                        <WebuiButton variant="quiet-highlight" size="inline-tiny" data-webui-ssh-discovered-host={row.alias}
                          onClick={() => {
                            const host = snapshot.discovery?.hosts.find((item) => item.alias === row.alias);
                            if (!host) return;
                            setPickedHost(host);
                            setDiscoveredOpen(false);
                            setHostFormOpen(true);
                            setNotice(`已选择 ${host.alias}，请确认后保存。`);
                          }}
                          className="w-full truncate text-left font-mono"
                        >
                          {row.alias} · {row.endpointLabel}
                        </WebuiButton>
                      </li>
                    ))}
                  </WebuiStack>}
              </div>
            ),
          }
        : {})}
      {...(notice === undefined ? {} : { notice })}
      onRefresh={() => void props.owner.load()}
      onAddHost={() => {
        setError(undefined);
        setHostFormOpen(true);
      }}
      onToggleHost={(connection) => {
        void props.owner.setEnabled(connection.alias, !connection.enabled).then((answer) => {
          setNotice(answer.ok ? undefined : answer.message);
        });
      }}
      onProbeHost={(connection) => {
        void props.owner.probeConnection(connection.alias).then((answer) => {
          if (!answer.ok) {
            setNotice(answer.message);
            return;
          }
          setNotice(
            answer.probe?.status === "connected"
              ? `${connection.alias} 探测成功。`
              : `${connection.alias} 探测失败：${answer.probe?.detail ?? answer.probe?.status ?? "未知原因"}`,
          );
        });
      }}
      onRemoveHost={(connection) => {
        setConfirmingRemove(undefined);
        void props.owner.removeConnection(connection.alias).then((answer) => {
          if (!answer.ok) {
            setNotice(answer.message);
            return;
          }
          const removed = answer.removedProjectIds ?? [];
          setNotice(
            removed.length === 0
              ? `已删除 ${connection.alias}。`
              : `已删除 ${connection.alias}，同时移除了 ${String(removed.length)} 个项目。`,
          );
        });
      }}
      onDiscoverHosts={() => {
        setDiscoveredOpen(true);
        void props.owner.loadDiscovery();
      }}
      onAddProject={() => {
        setError(undefined);
        setProjectFormOpen(true);
      }}
      onRemoveProject={(project) => {
        void props.owner.removeProject(project.id).then((answer) => {
          setNotice(answer.ok ? `已删除项目 ${project.displayName}。` : answer.message);
        });
      }}
      onOpenTerminal={(connection) => {
        void props.owner.openTerminal(connection.alias).then((answer) => {
          setNotice(answer.ok ? undefined : answer.message);
        });
      }}
      onCloseTerminal={() => void props.owner.closeTerminal()}
      onTerminalInput={(data) => void props.owner.writeTerminal(data)}
      {...(confirmingRemove === undefined ? {} : { confirmingRemove })}
      onRequestRemove={(connection) => setConfirmingRemove(connection.alias)}
      onCancelRemove={() => setConfirmingRemove(undefined)}
    />
  );
}
