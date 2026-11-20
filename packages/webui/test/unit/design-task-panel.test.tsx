import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DesignTaskPanel } from "../../src/client/features/design/ui/DesignTaskPanel.js";
import type { DesignState } from "../../src/shared/contracts/design.js";

const request = {
  id: "question-1",
  sessionId: "session-1",
  createdAt: 1,
  mode: "questionnaire",
  steps: [
    {
      id: "design-choice",
      question: "请选择这次本地 Design 任务的处理方式",
      selectionMode: "multiple",
      options: [
        { id: "keep", label: "保留当前素材" },
        { id: "review", label: "先检查结果" },
      ],
    },
  ],
};

const state = {
  documents: [],
  templates: [],
  capabilities: {},
  models: [],
  defaultModelKey: null,
  library: [],
  mediaStatus: { available: true },
  tasks: [
    {
      id: "r_question",
      nodeId: "n_question",
      status: "waiting-question",
      mode: "text",
      log: ["等待你的回答"],
      pendingQuestion: { requestId: "question-1", sessionId: "session-1", mode: "questionnaire", request },
    },
    {
      id: "r_permission",
      nodeId: "n_permission",
      status: "running",
      mode: "text",
      log: ["等待你的批准：bash"],
      pendingPermission: {
        requestId: "permission-1",
        sessionId: "session-1",
        toolName: "bash",
        reason: "synthetic reason",
      },
    },
  ],
} as unknown as DesignState;

describe("native Design task panel requests", () => {
  it("renders a real questionnaire and a permission request instead of an empty progress row", () => {
    const html = renderToStaticMarkup(
      <DesignTaskPanel data={state} onAction={vi.fn(async () => undefined)} />,
    );
    expect(html).toContain("运行进度");
    expect(html).toContain("Agent 需要你的确认");
    expect(html).toContain("请选择这次本地 Design 任务的处理方式");
    expect(html).toContain("保留当前素材");
    expect(html).toContain("需要你的批准");
    expect(html).toContain("工具「bash」请求执行权限");
    expect(html).toContain("允许一次");
    expect(html).toContain("拒绝");
  });
});
