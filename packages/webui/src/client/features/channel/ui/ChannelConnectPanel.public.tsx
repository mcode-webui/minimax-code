// The published surface of the 接入 IM pane.
//
// The shell is a peer of this business and may only import what the business publishes, and a
// published module may not re-export another module's symbol — so the pane lives here and is
// published as itself rather than through a forwarding file.
//
// Split in two on purpose. `ChannelConnectPanelView` is a pure render of a snapshot, so a test can
// pin every branch — the rows, the empty state, the load failure, the sections the runtime has no
// route behind — through `renderToStaticMarkup` without a DOM (there is no jsdom in this
// package). `ChannelConnectPanel` is the thin part that subscribes to the owner and reads once
// when it opens.
//
// The pane is a bot list plus a detail pane, the way Desktop's 接入 IM tab is: a 220px list column
// with one row per bound IM client (a status dot, the platform's icon, the client's name and the
// platform's label) and, beside it, the selected client's sections. A section the runtime has no
// route behind is rendered with Desktop's own copy and marked as not wired, never as if it
// worked.
import {
  IconBrandTelegram,
  IconBrandWechat,
  IconMessageCircle,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useEffect, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";

import type {
  WebuiChannelConnectRequest,
  WebuiChannelMessageFilterRequest,
} from "../../../../shared/contracts/channel.js";
import type { createWebuiChannelOwner, WebuiChannelSnapshot } from "../application/channel-owner.js";
import {
  WEBUI_CHANNEL_EMPTY_TEXT,
  WEBUI_CHANNEL_FILTER_MODE_FULL,
  WEBUI_CHANNEL_FILTER_MODE_RESULT,
  WEBUI_CHANNEL_LOADING_TEXT,
  WEBUI_CHANNEL_NOT_WIRED,
  WEBUI_CHANNEL_SECTION_AGENT,
  WEBUI_CHANNEL_SECTION_AGENT_DESCRIPTION,
  WEBUI_CHANNEL_SECTION_BIND_QR,
  WEBUI_CHANNEL_SECTION_BIND_QR_DESCRIPTION,
  WEBUI_CHANNEL_SECTION_BIND_QR_HINT,
  WEBUI_CHANNEL_SECTION_BIND_QR_REFRESH,
  WEBUI_CHANNEL_SECTION_DELETE,
  WEBUI_CHANNEL_SECTION_DELETE_ACTION,
  WEBUI_CHANNEL_SECTION_DELETE_DESCRIPTION,
  WEBUI_CHANNEL_SECTION_FILTER,
  WEBUI_CHANNEL_SECTION_FILTER_DESCRIPTION,
  WEBUI_CHANNEL_SECTION_WORKSPACE,
  WEBUI_CHANNEL_SECTION_WORKSPACE_DESCRIPTION,
  WEBUI_CHANNEL_SECTION_WORKSPACE_EMPTY,
  WEBUI_CHANNEL_STATE_BOUND,
  webuiChannelConfigLabel,
  webuiChannelFilterModeLabel,
  webuiChannelRows,
  type WebuiChannelRow,
} from "../projection/channel-panel.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiTextInput } from "../../../ui/field.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

export interface ChannelConnectPanelProps {
  readonly owner: ReturnType<typeof createWebuiChannelOwner>;
}

export interface ChannelConnectPanelViewProps {
  readonly snapshot: WebuiChannelSnapshot;
  readonly onSelect: (name: string) => void;
  readonly onBind: (request: WebuiChannelConnectRequest) => void;
  readonly onUnbind: (name: string) => void;
  readonly onUpdateFilter: (request: WebuiChannelMessageFilterRequest) => void;
  /** Whether the bind form is open. */
  readonly binding: boolean;
  readonly onOpenBinding: () => void;
  readonly onCloseBinding: () => void;
}

/** The platform's icon. Feishu has no brand glyph in the icon set, so it gets a neutral one. */
function platformIcon(platform: string): ReactNode {
  if (platform === "wechat") {
    return <IconBrandWechat aria-hidden="true" size={20} stroke={1.5} />;
  }
  if (platform === "telegram") {
    return <IconBrandTelegram aria-hidden="true" size={20} stroke={1.5} />;
  }
  return <IconMessageCircle aria-hidden="true" size={20} stroke={1.5} />;
}

/** One section of the detail pane, in Desktop's shape: a title, a description and its content. */
function DetailSection(props: {
  readonly title: string;
  readonly description: string;
  readonly testId: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <section
      className="flex min-h-[72px] items-center justify-between gap-6 border-t-[0.5px] border-border_default py-3"
      data-webui-channel-section={props.testId}
    >
      <div className="min-w-0">
        <p className="text-sm leading-5 text-text_default_primary">{props.title}</p>
        <p className="mt-1 text-xs leading-4 text-text_default_secondary">{props.description}</p>
      </div>
      <WebuiInline gap="small" className="shrink-0">{props.children}</WebuiInline>
    </section>
  );
}

/** The marker for a section the runtime has no route behind. */
function NotWired(): ReactElement {
  return (
    <span
      data-webui-channel-not-wired="true"
      className="rounded-[6px] border border-border_default px-2 py-1 text-xs text-text_default_tertiary"
    >
      {WEBUI_CHANNEL_NOT_WIRED}
    </span>
  );
}

/**
 * The bind form.
 *
 * It binds through the runtime's credential path (the channel bridge's `connect` route), because
 * that is the bind this repository's runtime serves. The QR path Desktop uses has no route here,
 * and the pane says so rather than offering a scan that cannot happen.
 */
function ChannelBindForm(props: {
  readonly onSubmit: (request: WebuiChannelConnectRequest) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  return (
    <form
      data-webui-channel-bind-form="true"
      className="flex flex-col gap-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === "") return;
        props.onSubmit({
          name: name.trim(),
          ...(appId.trim() === "" ? {} : { appId: appId.trim() }),
          ...(appSecret === "" ? {} : { appSecret }),
        });
      }}
    >
      <p className="text-sm leading-5 text-text_default_primary">绑定机器人</p>
      <WebuiField
        label="客户端名称"
        control={(props) => (
          <WebuiTextInput
            {...props}
            data-webui-channel-bind-name="true"
            controlSize="compact"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      />
      <WebuiField
        label="飞书 App ID"
        control={(props) => (
          <WebuiTextInput
            {...props}
            data-webui-channel-bind-app-id="true"
            controlSize="compact"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
          />
        )}
      />
      <WebuiField
        label="飞书 App Secret"
        control={(props) => (
          <WebuiTextInput
            {...props}
            data-webui-channel-bind-app-secret="true"
            controlSize="compact"
            type="password"
            value={appSecret}
            onChange={(event) => setAppSecret(event.target.value)}
          />
        )}
      />
      <p className="text-xs leading-4 text-text_default_tertiary">
        {WEBUI_CHANNEL_SECTION_BIND_QR} · {WEBUI_CHANNEL_SECTION_BIND_QR_HINT}
      </p>
      <WebuiInline gap="small">
        <WebuiButton variant="outline" size="inline" type="submit"
          data-webui-channel-bind-submit="true"

        >
          绑定
        </WebuiButton>
        <WebuiButton variant="quiet-highlight" size="inline" data-webui-channel-bind-cancel="true"
          onClick={props.onCancel}

        >
          取消
        </WebuiButton>
      </WebuiInline>
    </form>
  );
}

/** The selected client's four sections, plus the message filter the runtime does route. */
function ChannelDetail(props: {
  readonly row: WebuiChannelRow;
  readonly snapshot: WebuiChannelSnapshot;
  readonly onUnbind: (name: string) => void;
  readonly onUpdateFilter: (request: WebuiChannelMessageFilterRequest) => void;
}): ReactElement {
  const filter = props.snapshot.filter;
  const filterKey = props.row.name;
  return (
    <>
      <DetailSection
        testId="binding"
        title={WEBUI_CHANNEL_STATE_BOUND}
        description={`${props.row.platformLabel} · ${props.row.agentLabel}`}
      >
        <WebuiStack gap="tight" align="end" className="text-right">
          <span className="text-xs leading-4 text-text_default_secondary">
            {WEBUI_CHANNEL_SECTION_BIND_QR} · {WEBUI_CHANNEL_SECTION_BIND_QR_DESCRIPTION}
          </span>
          <span className="text-xs leading-4 text-text_default_tertiary">
            {WEBUI_CHANNEL_SECTION_BIND_QR_HINT}
          </span>
          <WebuiButton variant="outline" size="inline-dense" disabled
            data-webui-channel-bind-refresh="true"
            className="text-text_default_tertiary"
          >
            <IconRefresh aria-hidden="true" size={14} stroke={1.5} />
            {WEBUI_CHANNEL_SECTION_BIND_QR_REFRESH}
          </WebuiButton>
          <NotWired />
        </WebuiStack>
      </DetailSection>

      <DetailSection
        testId="agent"
        title={WEBUI_CHANNEL_SECTION_AGENT}
        description={WEBUI_CHANNEL_SECTION_AGENT_DESCRIPTION}
      >
        <span
          data-webui-channel-config="true"
          className="text-xs text-text_default_secondary"
        >
          {props.row.agentLabel} · {webuiChannelConfigLabel(props.snapshot.config)}
        </span>
        <NotWired />
      </DetailSection>

      <DetailSection
        testId="workspace"
        title={WEBUI_CHANNEL_SECTION_WORKSPACE}
        description={WEBUI_CHANNEL_SECTION_WORKSPACE_DESCRIPTION}
      >
        <span className="text-xs text-text_default_secondary">
          {WEBUI_CHANNEL_SECTION_WORKSPACE_EMPTY}
        </span>
        <NotWired />
      </DetailSection>

      <DetailSection
        testId="filter"
        title={WEBUI_CHANNEL_SECTION_FILTER}
        description={WEBUI_CHANNEL_SECTION_FILTER_DESCRIPTION}
      >
        <WebuiInline gap="small">
          <WebuiButton variant="outline" size="inline-dense" data-webui-channel-filter-mode="result"
            aria-pressed={filter?.mode !== "full"}
            onClick={() =>
              props.onUpdateFilter({
                agent: filterKey,
                filter: { mode: "result", includeToolSummary: filter?.includeToolSummary === true },
              })
            }

          >
            {WEBUI_CHANNEL_FILTER_MODE_RESULT}
          </WebuiButton>
          <WebuiButton variant="outline" size="inline-dense" data-webui-channel-filter-mode="full"
            aria-pressed={filter?.mode === "full"}
            onClick={() =>
              props.onUpdateFilter({
                agent: filterKey,
                filter: { mode: "full", includeToolSummary: filter?.includeToolSummary === true },
              })
            }

          >
            {WEBUI_CHANNEL_FILTER_MODE_FULL}
          </WebuiButton>
        </WebuiInline>
        <span className="text-xs text-text_default_secondary">
          {filter === undefined ? "" : webuiChannelFilterModeLabel(filter.mode)}
        </span>
      </DetailSection>

      <DetailSection
        testId="delete"
        title={WEBUI_CHANNEL_SECTION_DELETE}
        description={WEBUI_CHANNEL_SECTION_DELETE_DESCRIPTION}
      >
        <WebuiButton variant="outline" size="inline" data-webui-channel-unbind="true"
          onClick={() => props.onUnbind(props.row.name)}
          className="text-text_status_error"
        >
          {WEBUI_CHANNEL_SECTION_DELETE_ACTION}
        </WebuiButton>
      </DetailSection>
    </>
  );
}

export function ChannelConnectPanelView(props: ChannelConnectPanelViewProps): ReactElement {
  const rows = webuiChannelRows(props.snapshot.clients, props.snapshot.selectedName);
  const selected = rows.find((row) => row.selected);
  // "No IM client is bound" is only true of a *successful* empty read: a failed one is not empty,
  // and saying so would invite the reader to bind a client they may already have.
  const showEmpty = rows.length === 0 && props.snapshot.status === "ready";
  return (
    <WebuiInline
      align="stretch"
      justify="center"
      data-webui-component="channel-connect-panel"
      className="h-full min-h-0 w-full overflow-hidden px-6 py-10"
    >
      <WebuiInline as="main" gap="medium" align="start" className="mx-auto h-full min-w-0 w-full max-w-[912px]">
        <aside
          className="h-full min-h-0 w-[220px] shrink-0 overflow-y-auto overscroll-contain"
          data-webui-component="channel-connection-list"
        >
          <WebuiStack gap="hairline">
            {rows.map((row) => (
              <WebuiButton
                variant="selectable-row"
                size="regular"
                key={row.name}
                aria-pressed={row.selected}
                data-webui-channel-row={row.name}
                onClick={() => props.onSelect(row.name)}
                className="flex h-[62px] w-full items-center gap-2 rounded-lg py-2.5 pl-2 pr-3"
              >
                <span
                  className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-text_default_tertiary"
                  aria-hidden="true"
                ></span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                  {platformIcon(row.platform)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-medium leading-5 text-text_default_primary">
                    {row.name}
                  </span>
                  <span className="truncate text-[13px] leading-[18px] text-text_default_secondary">
                    {row.platformLabel}
                  </span>
                </span>
              </WebuiButton>
            ))}
          </WebuiStack>
          <WebuiButton
            variant="quiet-secondary"
            size="inline"
            data-webui-channel-new="true"
            onClick={props.onOpenBinding}
            className="mt-2 flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left"
          >
            <IconPlus aria-hidden="true" size={16} stroke={1.5} />
            新 Bot
          </WebuiButton>
          {props.snapshot.status === "loading" ? (
            <p className="mt-2 text-xs text-text_default_tertiary">{WEBUI_CHANNEL_LOADING_TEXT}</p>
          ) : null}
          {props.snapshot.error === undefined ? null : (
            <p
              data-webui-channel-error="true"
              className="mt-2 text-xs leading-4 text-text_status_error"
            >
              {props.snapshot.error}
            </p>
          )}
          {props.snapshot.actionError === undefined ? null : (
            <p
              data-webui-channel-action-error="true"
              className="mt-2 text-xs leading-4 text-text_status_error"
            >
              {props.snapshot.actionError}
            </p>
          )}
        </aside>

        <section
          className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          data-webui-component="channel-connection-detail"
        >
          {props.binding ? (
            <ChannelBindForm onSubmit={props.onBind} onCancel={props.onCloseBinding} />
          ) : selected === undefined ? (
            showEmpty ? (
              <p className="py-3 text-sm text-text_default_secondary">{WEBUI_CHANNEL_EMPTY_TEXT}</p>
            ) : null
          ) : (
            <ChannelDetail
              row={selected}
              snapshot={props.snapshot}
              onUnbind={props.onUnbind}
              onUpdateFilter={props.onUpdateFilter}
            />
          )}
        </section>
      </WebuiInline>
    </WebuiInline>
  );
}

export function ChannelConnectPanel(props: ChannelConnectPanelProps): ReactElement {
  const snapshot = useSyncExternalStore(
    props.owner.subscribe,
    props.owner.getSnapshot,
    props.owner.getSnapshot,
  );
  const [binding, setBinding] = useState(false);

  useEffect(() => {
    void props.owner.load();
    return props.owner.startRefreshing();
  }, [props.owner]);

  return (
    <ChannelConnectPanelView
      snapshot={snapshot}
      onSelect={(name) => void props.owner.select(name)}
      onBind={(request) => {
        void props.owner.connect(request).then((result) => {
          if (result.ok) setBinding(false);
        });
      }}
      onUnbind={(name) => {
        void props.owner.disconnect({ name, clearCredentials: true });
      }}
      onUpdateFilter={(request) => void props.owner.updateMessageFilter(request)}
      binding={binding}
      onOpenBinding={() => setBinding(true)}
      onCloseBinding={() => setBinding(false)}
    />
  );
}
