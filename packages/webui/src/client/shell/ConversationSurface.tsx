import { useRef, type ReactElement, type ReactNode } from "react";
import { HomeOctoCameo } from "./HomeOctoCameo.js";
import { WebuiIconHomeBrand } from "./icons.js";
import { WebuiWorkspacePanelControls } from "../features/workspace/ui/WorkspacePanelControls.js";
import { WebuiInline, WebuiStack } from "../ui/layout-primitives.js";
import { WebuiMotionSlot, WebuiSkeletonProjection } from "../ui/page.js";

/** Conversation column layout; Shell supplies already-owned feature surfaces and named navigation actions. */
export function ConversationSurface(props: {
  readonly home: boolean;
  readonly sessionId?: string;
  readonly title?: string;
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
  const heroRef = useRef<HTMLDivElement | null>(null);
  return (
    <WebuiSkeletonProjection>
      <>
        <WebuiStack className="webui-conversation-column relative h-full min-w-0 flex-1">
          <div
            className="pointer-events-none absolute inset-x-0 top-6 z-[60] flex justify-center"
            data-webui-busy-banner-slot="true"
          />
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
          <div
            className="webui-session-header"
            data-webui-session-header="true"
          >
            <div className="webui-session-header-tools">
              {props.headerTools}
            </div>
            <span
              className="webui-session-title"
              data-webui-session-title="true"
            >
              {props.title ?? ""}
            </span>
            <div className="webui-session-header-actions">
              {!props.home ? (
                <WebuiWorkspacePanelControls
                  browserPanelOpen={props.workspacePanelOpen}
                  progressPanelOpen={props.progressOpen}
                  progressPanelAvailable={props.progressPanelAvailable}
                  onOpenBrowser={props.onOpenBrowser}
                  onToggleProgressPanel={props.onToggleProgress}
                />
              ) : null}
            </div>
          </div>
          <WebuiMotionSlot kind="panel-layout">
            <div
              className={
                props.home
                  ? "flex min-h-0 w-full flex-1 flex-col items-center relative isolate overflow-hidden"
                  : `flex min-h-0 w-full flex-1 flex-col items-center relative overflow-hidden pt-spacing_24 ${props.progressOpen ? "webui-session-has-progress-panel" : ""}`
              }
              data-webui-home-content={props.home ? "true" : "false"}
              data-webui-session-layout={!props.home ? "true" : undefined}
            >
              {props.home ? <HomeOctoCameo heroRef={heroRef} /> : null}
              {props.home ? (
                <div
                  aria-hidden="true"
                  className="min-h-spacing_24 w-full flex-1"
                />
              ) : null}
              <WebuiStack
                gap={props.home ? "none" : "small"}
                align="center"
                className={
                  props.home
                    ? "w-full max-w-[743px] shrink-0 px-4"
                    : "webui-session-layout flex-1"
                }
              >
                {props.home ? (
                  <div
                    ref={heroRef}
                    className="webui-home-hero w-full [@media(max-height:300px)]:hidden"
                  >
                    <WebuiStack gap="small" align="center">
                      <div className="webui-home-avatar group/avatar relative flex-shrink-0">
                        <div className="webui-hero-avatar relative h-full w-full overflow-visible rounded-full bg-bg_grouped_tertiary">
                          <WebuiInline
                            as="span"
                            justify="center"
                            className="absolute inset-0 overflow-hidden rounded-full"
                          >
                            <WebuiIconHomeBrand className="h-full w-full" />
                          </WebuiInline>
                        </div>
                      </div>
                      <h1 className="webui-home-tagline mt-spacing_8 w-full text-text_default_primary">
                        <span className="inline-block">让灵感自由生长，</span>
                        <wbr />
                        <span className="inline-block">让创造触手可及</span>
                      </h1>
                    </WebuiStack>
                  </div>
                ) : null}
                {props.usageBanner}
                {props.connectionStatus}
                <div
                  className={
                    props.home
                      ? "contents"
                      : "webui-session-scroll-viewport flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden"
                  }
                  data-webui-session-scroll={props.home ? undefined : "true"}
                >
                  {props.composerAndTranscript}
                  {!props.home ? (
                    <div
                      className="webui-session-bottom-padding w-full shrink-0"
                      data-testid="message-bottom-padding"
                      data-webui-session-bottom-padding="true"
                    />
                  ) : null}
                </div>
              </WebuiStack>
              {props.home ? (
                <div
                  aria-hidden="true"
                  className="min-h-spacing_24 w-full flex-1"
                />
              ) : null}
            </div>
          </WebuiMotionSlot>
        </WebuiStack>
        {!props.home ? props.progressPanel : null}
        {!props.home ? props.workspacePanel : null}
      </>
    </WebuiSkeletonProjection>
  );
}
