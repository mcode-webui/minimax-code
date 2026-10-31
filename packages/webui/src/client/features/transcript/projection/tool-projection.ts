// Tool call projection — derive the user-facing labels and stats from the
// raw tool-call records the wire hands the client.
//
// The wire shape is loose: the runtime uses both camelCase and snake_case
// keys, and either `result` / `output` / `error` may carry the rendered
// output. These readers normalise the variety so the React layer can just
// render what it gets. The view-model stat (`webuiActivitySummary`) decides
// what header to draw for the activity group.

/** Best-effort extraction of the rendered tool result. Accepts the runtime's
 *  multiple key spellings and JSON-serialises object payloads so the panel
 *  always has something to show. */
export function toolCallResultText(
  tool: Record<string, unknown>,
): string | undefined {
  const value =
    tool.tool_call_result_data ??
    tool.toolCallResultData ??
    tool.result ??
    tool.output;
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function toolCallErrorText(tool: Record<string, unknown>): string | undefined {
  const value = tool.error ?? tool.tool_call_error ?? tool.toolCallError;
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Normalised tool name — accepts both camelCase and snake_case spellings
 *  and falls back to `"tool"` so the renderer never has to special-case a
 *  missing name. */
export function toolCallName(tool: Record<string, unknown>): string {
  const value =
    tool.tool_call_name ??
    tool.toolCallName ??
    tool.tool_name ??
    tool.toolName ??
    tool.name;
  return typeof value === "string" && value.trim() ? value.trim() : "tool";
}

/** User-facing label for the tool row. Maps the common English tool names
 *  to the Chinese copy the transcript shows; for anything else it falls back
 *  to a normalised display of the raw name. */
export function toolCallLabel(tool: Record<string, unknown>): string {
  const name = toolCallName(tool);
  const normalized = name.toLowerCase();
  const labels: Readonly<Record<string, string>> = {
    bash: "终端",
    shell: "执行命令",
    execute: "执行命令",
    execute_command: "执行命令",
    read: "读取文件",
    read_file: "读取文件",
    write: "写入文件",
    write_file: "写入文件",
    edit: "编辑文件",
    edit_file: "编辑文件",
    str_replace: "编辑文件",
    grep: "搜索文件",
    find: "查找文件",
    ls: "列出文件",
    web: "网页抓取",
    web_search: "网页搜索",
    webfetch: "网页抓取",
    web_fetch: "网页抓取",
    task: "任务",
    todo_write: "todowrite",
    todowrite: "todowrite",
  };
  return WEBUI_DESKTOP_TOOL_DISPLAY_LABELS[normalized] ?? labels[normalized] ?? "工具";
}

/** Pretty-printed JSON of the tool input arguments, or the raw string when
 *  the input was passed as a string. */
export function toolCallInputText(
  tool: Record<string, unknown>,
): string | undefined {
  const value =
    tool.tool_call_args ??
    tool.toolCallArgs ??
    tool.tool_call_args_json ??
    tool.toolCallArgsJson ??
    tool.input ??
    tool.args;
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/** Read-file calls expose their resource path in the tool row summary. */
export function toolCallResourcePath(tool: Record<string, unknown>): string | undefined {
  const name = toolCallName(tool).toLowerCase();
  if (name !== "read" && name !== "read_file") return undefined;
  const candidates = [tool.tool_call_args, tool.toolCallArgs, tool.tool_call_args_json, tool.toolCallArgsJson, tool.input, tool.args];
  for (const candidate of candidates) {
    let parsed: unknown = candidate;
    if (typeof candidate === "string") {
      try { parsed = JSON.parse(candidate) as unknown; } catch { parsed = candidate; }
    }
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    for (const key of ["file_path", "filePath", "path", "location"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

export type WebuiToolCallStatus = "pending" | "running" | "completed" | "error" | "cancelled" | "unknown";

export type WebuiDesktopToolIcon = "command" | "file" | "code" | "search" | "web" | "browser" | "logo" | "memory" | "image" | "video" | "music" | "combine" | "task" | "bot" | "goal" | "tool" | "thinking";

/** Icon category identifiers for the tool rows. */
export const WEBUI_DESKTOP_TOOL_ICON_GROUPS: Readonly<Record<WebuiDesktopToolIcon, readonly string[]>> = {
  command: ["bash", "python", "python3", "shell", "command", "terminal"],
  file: ["read", "read_file", "ls", "find", "glob", "read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates", "deliver_asset", "archon.asset.deliver"],
  code: ["write", "write_file", "edit", "str_replace", "file_edit", "apply_patch"],
  search: ["grep", "search", "tool_search"],
  web: ["web", "webfetch", "web_fetch", "web_search", "website_deploy"],
  browser: ["mcp_browser", "browser", "archon.browser.call", "browser_open"],
  logo: ["mavis", "matrix_mcp", "mcp_call", "archon.mcp.call"],
  memory: ["memory"],
  image: ["images_understand", "image_synthesize", "images_search_and_download", "image_reverse_search", "generate_image", "matrix_generate_image", "describe_image", "view_image", "image_query"],
  video: ["submit_video_generation", "query_video_generation", "gen_videos", "batch_text_to_video", "batch_image_to_video", "videos_understand", "video_generation"],
  music: ["get_voice_list", "batch_text_to_audio", "batch_text_to_music", "synthesize_speech", "batch_synthesize_speech", "audios_understand", "transcribe_audio", "music_generation", "audio_generation"],
  combine: ["parallel"],
  task: ["ask_user", "task", "task_query", "task_output", "task_stop", "update_plan", "exitplanmode", "todo_write", "todowrite", "request_user_input"],
  bot: ["archon.communication.send", "spawn_agent", "delegate_task", "send_input", "wait_agent", "resume_agent", "close_agent"],
  goal: ["create_goal", "update_goal", "get_goal"],
  tool: ["web_view", "communicate"],
  thinking: [],
};

/** Chinese `tool_call.display` values, keyed by
 * the tool ids/aliases the runtime exposes. */
export const WEBUI_DESKTOP_TOOL_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  bash: "终端", terminal: "终端", command: "终端", shell: "终端",
  python: "Python", python3: "Python", read: "读取文件", read_file: "读取文件",
  read_image: "读取图片", read_skill_file: "读取 Skill {{name}}.md", ls: "列出目录", list_files: "列出目录",
  write: "写入文件", write_file: "写入文件", edit: "编辑文件", str_replace: "编辑文件",
  find: "查找文件", find_files: "查找文件", glob: "查找文件", grep: "搜索", search: "搜索",
  web_search: "网页搜索", web: "网页抓取", webfetch: "网页抓取", web_fetch: "网页抓取",
  matrix_mcp: "处理媒体", mcp_call: "MCP 工具", "archon.mcp.call": "MCP 工具",
  browser: "浏览器", mcp_browser: "浏览器", "archon.browser.call": "浏览器", deliver_asset: "交付文件",
  "archon.asset.deliver": "交付文件", "archon.communication.send": "发送消息",
  website_deploy: "部署网站", mavis: "MiniMax Code", memory: "读取与保存记忆",
  images_understand: "理解图片", image_understanding: "理解图片", understanding_images: "理解图片",
  image_synthesize: "生成图片", generate_image: "生成图片", matrix_generate_image: "生成图片", image_generation: "生成图片",
  images_search_and_download: "搜索并下载图片", image_search: "搜索图片", image_reverse_search: "以图搜图",
  image_source_lookup: "查找图片来源", submit_video_generation: "生成视频", query_video_generation: "查询视频进度",
  check_video_progress: "查询视频进度", gen_videos: "生成视频", batch_text_to_video: "批量生成视频",
  batch_generate_videos: "批量生成视频", batch_image_to_video: "图片生成视频", videos_understand: "理解视频",
  video_understanding: "理解视频", video_generation: "生成视频", get_voice_list: "查看可用音色",
  batch_text_to_audio: "批量语音合成", batch_text_to_music: "生成音乐", synthesize_speech: "文字转语音",
  batch_synthesize_speech: "批量文字转语音", audios_understand: "理解音频内容", audio_understanding: "理解音频",
  transcribe_audio: "音频转文字", ask_user: "用户确认", user_confirmation: "用户确认", task: "任务",
  task_query: "任务进度", task_progress: "任务进度", task_output: "任务结果", task_result: "任务结果",
  task_stop: "任务终止", stop_task: "任务终止", tool_search: "查找工具", find_tools: "查找工具",
  create_goal: "目标创建", update_goal: "目标更新", get_goal: "目标读取",
};

export function toolCallIconCategory(tool: Record<string, unknown>): WebuiDesktopToolIcon {
  const rawName = toolCallName(tool);
  const name = rawName.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (name === "thinking" || name === "think" || name.includes("thinking")) return "thinking";
  if (name === "browser" || name === "archon.browser.call" || name.startsWith("browser_")) return "browser";
  if (["find files", "finding files", "found files", "查找文件"].includes(rawName.toLowerCase())) return "file";
  if ((name === "read" || name === "read_file") && typeof tool.input === "object" && tool.input !== null) {
    const args = tool.input as Record<string, unknown>;
    const path = args.file_path ?? args.filePath ?? args.path;
    if (typeof path === "string" && /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/iu.test(path)) return "image";
  }
  if (name === "matrix_mcp" && typeof tool.input === "object" && tool.input !== null) {
    const input = tool.input as Record<string, unknown>;
    const capability = input.tool;
    if (typeof capability === "string" && capability.includes("describe_images")) return "image";
  }
  for (const [icon, names] of Object.entries(WEBUI_DESKTOP_TOOL_ICON_GROUPS) as [WebuiDesktopToolIcon, readonly string[]][]) {
    if (names.includes(name)) return icon;
  }
  return name.startsWith("mcp:") || name.includes("__mcp__") ? "logo" : "tool";
}

/** Normalize the lifecycle vocabulary while accepting runtime spellings. */
export function toolCallStatus(tool: Record<string, unknown>): WebuiToolCallStatus {
  const raw = tool.status ?? tool.tool_call_status ?? tool.toolCallStatus;
  if (typeof raw === "number") {
    // 1/2/3 map to running/completed/error explicitly; Preparing, Prepared and
    // other non-terminal stages fall back to pending.
    switch (raw) {
      case 1: return "running";
      case 2: return "completed";
      case 3: return "error";
      case 4: case 5: return "pending";
      default: return "unknown";
    }
  }
  if (typeof raw !== "string") return "unknown";
  switch (raw.toLowerCase()) {
    case "pending": case "queued": return "pending";
    case "running": case "in_progress": case "in-progress": return "running";
    case "done": case "completed": case "success": case "succeeded": return "completed";
    case "error": case "failed": return "error";
    case "cancelled": case "canceled": case "interrupted": return "cancelled";
    default: return "unknown";
  }
}

export function toolCallStatusLabel(status: WebuiToolCallStatus): string | undefined {
  switch (status) {
    case "pending": return "等待中";
    case "running": return "运行中";
    case "completed": return "已完成";
    case "error": return "失败";
    case "cancelled": return "已取消";
    default: return undefined;
  }
}

const WEBUI_EDIT_TOOL_LABELS: ReadonlySet<string> = new Set([
  "写入文件",
  "编辑文件",
]);

/** True when the tool is one of the file-mutating edit/write tools. Used to
 *  decide whether the renderer should show the diff stat card or the simple
 *  tool-row fallback. */
export function isWebuiEditTool(tool: Record<string, unknown>): boolean {
  return WEBUI_EDIT_TOOL_LABELS.has(toolCallLabel(tool));
}

/** Best-effort file name + `+N/-N` stat for an edit tool, derived from the
 *  tool input and result. Used to populate the fallback diff card when the
 *  authoritative diff facade is unavailable. */
export function webuiEditFileStat(tool: Record<string, unknown>): {
  readonly name?: string;
  readonly added: number;
  readonly deleted: number;
} {
  const input = toolCallInputText(tool) ?? "";
  const result = toolCallResultText(tool) ?? "";
  let path: unknown;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      path = record.file_path ?? record.filePath ?? record.path ?? record.file;
    }
  } catch {
    if (/^[\w./~-]+\.[\w]+$/u.test(input.trim())) path = input.trim();
  }
  const name =
    typeof path === "string" && path.trim()
      ? (path.split(/[\\/]/u).pop() ?? path.trim())
      : undefined;
  let added = 0;
  let deleted = 0;
  for (const line of result.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { ...(name ? { name } : {}), added, deleted };
}

/** Summary label for the activity-group header. Picks one of the
 *  Chinese-phrased headers based on what every tool in the group is
 *  doing, so e.g. three `bash` calls render as "执行 3 条命令". */
export function webuiActivitySummary(
  tools: readonly Record<string, unknown>[],
): string {
  const categories = tools.map(toolCallIconCategory);
  if (categories.every((category) => category === "command")) return `执行 ${tools.length} 条命令`;
  if (categories.every((category) => category === "file")) return `查看 ${tools.length} 个文件`;
  if (categories.every((category) => category === "code"))
    return `修改 ${tools.length} 个文件`;
  return `执行 ${tools.length} 个操作`;
}
