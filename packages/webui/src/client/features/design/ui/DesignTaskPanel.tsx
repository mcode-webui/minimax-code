import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  DesignAction,
  DesignDocument,
  DesignState,
} from "../../../../shared/contracts/design.js";
import {
  panelClosed,
  panelIsShown,
  panelTasks,
} from "../../../../shared/design/run-watch.mjs";
import { WebuiButton } from "../../../ui/button.js";
import { record, strings } from "../projection/design-view.js";
import { DesignQuestionnaire } from "./DesignQuestionnaire.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";

export interface DesignTaskPanelProps {
  readonly data: DesignState;
  readonly document?: DesignDocument;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly openSession?: (sessionId: string) => void;
}
const active = (status: string) =>
  ["running", "waiting-question", "queued"].includes(status);
/** Persistent canvas progress surface; source task-panel title intent uses native shared controls. */
export function DesignTaskPanel({
  data,
  document,
  onAction,
  openSession,
}: DesignTaskPanelProps): ReactElement | null {
  const [closed, setClosed] = useState(false),
    [now, setNow] = useState(() => Date.now());
  const known = useRef(new Set(data.tasks.map((task) => task.id)));
  useEffect(() => {
    const started = data.tasks.some(
      (task) => active(task.status) && !known.current.has(task.id),
    );
    known.current = new Set(data.tasks.map((task) => task.id));
    if (started)
      setClosed((value) =>
        panelClosed({ closed: value, event: "run-started" }),
      );
    setNow(Date.now());
  }, [data.tasks]);
  useEffect(() => {
    setClosed(false);
  }, [document?.id]);
  const tasks = panelTasks(data.tasks, { now });
  useEffect(() => {
    if (!tasks.length) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [now, tasks.length]);
  if (!panelIsShown({ closed, tasks })) return null;
  return (
    <aside
      className="webui-design-task-panel"
      aria-label="运行进度"
      data-canvas-no-zoom="true"
    >
      <header className="webui-design-task-panel-title">
        <strong>运行进度</strong>
        <WebuiButton
          variant="quiet-action"
          size="inline-tiny"
          onClick={() =>
            setClosed((value) =>
              panelClosed({ closed: value, event: "put-away" }),
            )
          }
        >
          收起
        </WebuiButton>
      </header>
      <FeedbackLiveRegion className="webui-design-task-panel-items">
        {tasks.map((task) => {
          const permission = record(task.pendingPermission),
            question = record(task.pendingQuestion);
          const session =
            typeof task.sessionId === "string"
              ? task.sessionId
              : typeof question.sessionId === "string"
                ? question.sessionId
                : undefined;
          const seconds =
            active(task.status) && typeof task.startedAt === "number"
              ? Math.max(0, Math.round((now - task.startedAt) / 1000))
              : Math.round((task.elapsedMs ?? 0) / 1000);
          return (
            <section
              className="webui-design-task-panel-item"
              key={task.id}
              data-design-task={task.id}
            >
              <div className="webui-design-task-panel-head">
                <strong>
                  {document?.nodes.find((node) => node.id === task.nodeId)
                    ?.title ??
                    task.nodeId ??
                    "运行"}
                </strong>
                <span>{seconds}s</span>
              </div>
              {task.runner === "connector" && active(task.status) ? (
                <p className="webui-design-task-panel-line">
                  连接器：
                  {task.providerStatus === "submitted"
                    ? "已提交，等待生成"
                    : task.providerStatus || "提交中"}
                </p>
              ) : null}
              {strings(task.log)
                .slice(-4)
                .map((line, index) => (
                  <p className="webui-design-task-panel-line" key={index}>
                    {line}
                  </p>
                ))}
              {task.error &&
              !strings(task.log).some((line) => line.includes(task.error!)) ? (
                <p className="webui-design-task-panel-error">{task.error}</p>
              ) : null}
              <div className="webui-design-task-panel-actions">
                {active(task.status) ? (
                  <WebuiButton
                    variant="quiet-action"
                    size="inline-tiny"
                    onClick={() =>
                      onAction({ type: "cancel", taskId: task.id }).then(
                        () => undefined,
                      )
                    }
                  >
                    取消
                  </WebuiButton>
                ) : null}
                {session && openSession ? (
                  <WebuiButton
                    variant="quiet-action"
                    size="inline-tiny"
                    onClick={() => openSession(session)}
                  >
                    在对话里打开
                  </WebuiButton>
                ) : null}
              </div>
              {typeof permission.requestId === "string" ? (
                <div className="webui-design-task-request">
                  <strong>需要你的批准</strong>
                  <p>
                    工具「{String(permission.toolName ?? "工具")}
                    」请求执行权限。{String(permission.reason ?? "")}
                  </p>
                  <div className="webui-design-task-panel-actions">
                    <WebuiButton
                      variant="accent"
                      size="inline-tiny"
                      onClick={() =>
                        onAction({
                          type: "permission",
                          taskId: task.id,
                          requestId: permission.requestId as string,
                          decision: "allowOnce",
                        }).then(() => undefined)
                      }
                    >
                      允许一次
                    </WebuiButton>
                    <WebuiButton
                      variant="quiet-action"
                      size="inline-tiny"
                      onClick={() =>
                        onAction({
                          type: "permission",
                          taskId: task.id,
                          requestId: permission.requestId as string,
                          decision: "deny",
                        }).then(() => undefined)
                      }
                    >
                      拒绝
                    </WebuiButton>
                  </div>
                </div>
              ) : null}
              {typeof question.requestId === "string" ? (
                <div className="webui-design-task-request">
                  <strong>Agent 需要你的确认</strong>
                  <DesignQuestionnaire
                    key={`${task.id}:${question.requestId}`}
                    request={question.request}
                    onAnswer={(answers) =>
                      onAction({
                        type: "answer",
                        taskId: task.id,
                        requestId: question.requestId as string,
                        answers,
                      }).then(() => undefined)
                    }
                    onOpenChat={
                      session && openSession
                        ? () => openSession(session)
                        : undefined
                    }
                  />
                </div>
              ) : null}
            </section>
          );
        })}
      </FeedbackLiveRegion>
    </aside>
  );
}
