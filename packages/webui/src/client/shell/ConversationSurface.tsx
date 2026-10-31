import type { ReactElement, ReactNode } from "react";
import { WebuiIconHomeBrand } from "./icons.js";
import { GreetingSkeleton } from "../features/transcript/ui/TranscriptSkeletons.js";
import { WebuiWorkspacePanelControls } from "../features/workspace/ui/WorkspacePanelControls.js";
import { WebuiInline, WebuiStack } from "../ui/layout-primitives.js";

/** Conversation column layout; Shell supplies already-owned feature surfaces and named navigation actions. */
export function ConversationSurface(props: {
  readonly home: boolean;
  readonly sessionId?: string;
  readonly title?: string;
  readonly greetingPending: boolean;
  readonly progressOpen: boolean;
  /** Whether the window is wide enough for the progress panel to be open at all. */
  readonly progressPanelAvailable: boolean;
  readonly workspacePanelOpen: boolean;
  /** The rail's toggle and the search button. The shell owns them; the header row places them. */
  readonly headerTools?: ReactNode;
  readonly onOpenBrowser: () => void;
  readonly onToggleProgress: () => void;
  readonly usageBanner?: ReactNode;
  readonly connectionStatus: ReactNode;
  readonly composerAndTranscript: ReactNode;
  readonly progressPanel: ReactNode;
  readonly workspacePanel?: ReactElement;
}): ReactElement {
  return <>
    <WebuiStack className="webui-conversation-column relative h-full min-w-0 flex-1">
      <div className="pointer-events-none absolute inset-x-0 top-6 z-[60] flex justify-center" data-webui-busy-banner-slot="true" />
      {/*
       * The header row: the rail's toggle, the search button, the session
       * title, and the panel controls.
       *
       * The toggle and the search button used to float over the window in an
       * absolutely positioned strip of their own, and the title carried a
       * second literal to clear them. Two numbers describing one geometry,
       * and they disagreed — in the rail's drawer form the strip still sat
       * where the rail's column used to be, on top of the title (ADR 0025).
       *
       * In a row there is nothing to disagree about. The title starts after
       * the buttons because the buttons are before it, and it gives way by
       * truncating.
       */}
      <div className="webui-session-header" data-webui-session-header="true">
        <div className="webui-session-header-tools">{props.headerTools}</div>
        <span className="webui-session-title" data-webui-session-title="true">{props.title ?? ""}</span>
        <div className="webui-session-header-actions">
          {!props.home ? <WebuiWorkspacePanelControls
            browserPanelOpen={props.workspacePanelOpen}
            progressPanelOpen={props.progressOpen}
            progressPanelAvailable={props.progressPanelAvailable}
            onOpenBrowser={props.onOpenBrowser}
            onToggleProgressPanel={props.onToggleProgress}
          /> : null}
        </div>
      </div>
      <div
        className={props.home
          ? "flex min-h-0 w-full flex-1 flex-col items-center relative overflow-hidden"
          : `flex min-h-0 w-full flex-1 flex-col items-center relative overflow-hidden pt-spacing_24 ${props.progressOpen ? "webui-session-has-progress-panel" : ""}`}
        data-webui-home-content={props.home ? "true" : "false"}
        data-webui-session-layout={!props.home ? "true" : undefined}
      >
        {props.home ? <div aria-hidden="true" className="h-[clamp(96px,24vh,240px)] w-full shrink" /> : null}
        <WebuiStack gap="small" align="center" className={props.home
          ? "w-full max-w-[743px] shrink-0 px-4"
          : "webui-session-layout flex-1"}>
          {props.home ? (props.greetingPending ? <GreetingSkeleton /> : <WebuiStack gap="small" align="center" className="text-center [@media(max-height:300px)]:hidden">
            <div className="group/avatar relative size-[94px] flex-shrink-0"><div className="webui-hero-avatar relative h-full w-full overflow-visible rounded-full bg-bg_grouped_tertiary"><WebuiInline as="span" justify="center" className="absolute inset-0 overflow-hidden rounded-full"><WebuiIconHomeBrand className="h-full w-full" /></WebuiInline></div></div>
            <h1 className="text-[28px] font-medium leading-tight text-text_default_primary">MiniMax Code Web，让工作更简单。</h1>
          </WebuiStack>) : null}
          {props.usageBanner}
          {props.connectionStatus}
          <div className={props.home ? "contents" : "webui-session-scroll-viewport flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden"} data-webui-session-scroll={props.home ? undefined : "true"}>
            {props.composerAndTranscript}
            {!props.home ? <div className="webui-session-bottom-padding w-full shrink-0" data-testid="message-bottom-padding" data-webui-session-bottom-padding="true" /> : null}
          </div>
        </WebuiStack>
      </div>
    </WebuiStack>
    {!props.home ? props.progressPanel : null}
    {!props.home ? props.workspacePanel : null}
  </>;
}
