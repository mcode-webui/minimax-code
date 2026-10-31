// The item dialog: one dialog for three forms.
//
// It used to take eighteen values, eighteen setters and three save callbacks for
// the MCP, agent and skill drafts — thirty-nine props — and rendered each form's
// fields itself. So the component that draws a dialog owned three unrelated
// forms' state, and a change to any one of them edited the catalogue component,
// this component and its prop list together.
//
// The drafts now live in the form units, and this dialog keeps what is actually
// a dialog's job: the chrome, the title, and the three-way choice. What the
// catalogue hands down is one `onSubmit` that runs a typed intent.

import type { ReactElement } from "react";
import { createPortal } from "react-dom";

import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import type { WebuiPluginRow as Row } from "../contracts/plugin-rows.js";
import type { WebuiPluginIntent } from "../contracts/plugin-actions.js";
import { McpServerForm } from "./McpServerForm.js";
import { AgentForm } from "./AgentForm.js";
import { SkillForm } from "./SkillForm.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";

export interface PluginItemDialogProps {
  readonly dialog: "mcp" | "agent" | "skill";
  readonly editing: Row | undefined;
  /** Run one command and report whether it succeeded. */
  readonly onSubmit: (intent: WebuiPluginIntent) => Promise<boolean>;
  readonly onChatWithAgent?: (name: string) => Promise<void>;
  readonly onClose: () => void;
}

const TITLE: Readonly<Record<PluginItemDialogProps["dialog"], string>> = {
  mcp: "MCP Server",
  agent: "Agent",
  skill: "技能",
};

export function PluginItemDialog({
  dialog,
  editing,
  onSubmit,
  onChatWithAgent,
  onClose,
}: PluginItemDialogProps): ReactElement {
  // The plugin editor is a modal layer (ADR 0028 § Overlay coordination): it
  // answers a dismissal, and a press outside it is answered by it rather than by
  // whatever is behind the dialog.
  const layerId = useDialogLayer({ id: "plugin-item-dialog", onClose });
  const { dom } = useWebuiBrowserCapabilities();
  const portalTarget = dom.portalTarget();
  const surface = (
    <div
      className="webui-plugin-backdrop"
    >
      <div
        className={`webui-plugin-dialog${dialog === "mcp" ? " webui-mcp-dialog" : ""}`}
        data-overlay-layer={layerId}
        role="dialog"
        aria-modal="true"
        aria-label={TITLE[dialog]}
      >
        <header className="webui-plugin-dialog-header">
          <strong>
            {editing ? `编辑${TITLE[dialog]}` : `添加${TITLE[dialog]}`}
          </strong>
          <p>
            {dialog === "mcp"
              ? "配置 MiniMax Code 如何连接到这个 server"
              : "配置 MiniMax Code 如何连接到该项"}
          </p>
        </header>
        {dialog === "mcp" ? (
          <McpServerForm editing={editing} onSubmit={onSubmit} onClose={onClose} />
        ) : dialog === "agent" ? (
          <AgentForm
            editing={editing}
            onSubmit={onSubmit}
            {...(onChatWithAgent ? { onChatWithAgent } : {})}
            onClose={onClose}
          />
        ) : (
          <SkillForm onSubmit={onSubmit} onClose={onClose} />
        )}
      </div>
    </div>
  );
  // The dialog is portalled out of the plugin page rather than drawn inside
  // it, so that the page can be a size container: a container confines the
  // fixed-position descendants inside it, and this dialog's scrim is meant to
  // cover the whole viewport rather than the page (ADR 0025).
  return portalTarget ? createPortal(surface, portalTarget) : surface;
}
