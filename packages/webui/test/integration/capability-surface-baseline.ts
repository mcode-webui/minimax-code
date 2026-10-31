/**
 * The capability surface a WebUI turn must offer the model.
 *
 * This file is the reviewed baseline of what the `webui` owner row hands to
 * the model: the built-in skills in the rendered catalog, and the tools in the
 * tool table — the native ones and the ones an MCP server contributes.
 *
 * It is a frozen snapshot on purpose. Deriving the expectation from the
 * implementation would make the gate tautological: dropping a registration
 * would drop the expectation with it. A snapshot fails when a capability
 * disappears, and any change to it shows up as a reviewable diff.
 *
 * THE SNAPSHOT WAS TAKEN UNDER
 * ----------------------------
 * A real host, booted in an isolated data directory with:
 *
 *   - `MAVIS_BUILD_ENV=test` and `MAVIS_REGION=en` — the region decides
 *     which built-in skills are offered (`x-link-reader` is disabled in the
 *     CN region), so the gate pins it instead of inheriting the machine's.
 *   - `skills.external.enabled=false` — the external skill roots scan the
 *     user's home and the workspace tree, so a machine with skills installed
 *     in `~/.agents/skills` would otherwise change what this gate sees.
 *   - `beta.mcodeTools=true` — `mcode-tools-master` is behind that switch.
 *   - one synthetic MCP server (`mcp-capability-fixture-server.mjs`), so the
 *     MCP part of the surface is earned through a real stdio server.
 *
 * A different configuration has a different surface; this one is the contract.
 *
 * THREE BUILT-IN SKILLS ARE DELIBERATELY ABSENT
 * ---------------------------------------------
 * They are gated by conditions this configuration does not meet, so they are
 * not part of the pinned surface. If a later change turns one of them on for
 * this client, the gate fails on the extra entry — which is the point: the
 * change has to be deliberate.
 *
 *   - `cu-desktop` — needs the Computer Use mode.
 *   - `control-in-app-browser` — needs the browser-use tooling.
 *   - `resume-codex` — offered to the `cli` capability profile only.
 */
export interface CapabilitySurfaceBaseline {
  /** The skill ids the rendered `<available_skills>` catalog must carry. */
  readonly skills: readonly string[];
  /** The tool names the model request must carry. */
  readonly tools: readonly string[];
}

export const CAPABILITY_SURFACE_BASELINE: CapabilitySurfaceBaseline = {
  skills: [
    "code-review",
    "create-agent",
    "deep-research",
    "deploy-website",
    "docx",
    "edit-deployed-website",
    "init",
    "lark-tools",
    "llm-call",
    "mavis",
    "mavis-doctor",
    "mcode-tools-master",
    "miniapp-creator",
    "minimax-code-product",
    "pdf",
    "plugin-creator",
    "pptx",
    "skill-creator",
    "skill-refiner",
    "visual-page",
    "x-link-reader",
    "xlsx",
  ],
  tools: [
    "ask_user",
    "bash",
    "edit",
    "get_goal",
    "glob",
    "grep",
    "mavis",
    "mcp__capability-fixture__capability_probe",
    "mcp_invoke",
    "memory",
    "miniapp",
    "read",
    "request_feature_enable",
    "skill",
    "task",
    "task_append",
    "task_output",
    "task_query",
    "task_stop",
    "todowrite",
    "update_goal",
    "web_fetch",
    "web_search",
    "website_deploy",
    "write",
  ],
};
