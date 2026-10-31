// The agent form unit.
//
// Its four draft fields used to be four `useState` calls in `PluginCatalogue`,
// seeded by `beginAgent` there and handed to the dialog as values and setters.
// The draft now belongs to the form; what leaves it is one typed intent.

import { useState, type ReactElement } from "react";

import {
  readWebuiPluginRow as read,
  type WebuiPluginRow as Row,
} from "../contracts/plugin-rows.js";
import type { WebuiPluginIntent } from "../contracts/plugin-actions.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField } from "../../../ui/field.js";

export interface AgentFormProps {
  readonly editing: Row | undefined;
  readonly onSubmit: (intent: WebuiPluginIntent) => Promise<boolean>;
  /** Present only when the runtime exposes agent chat. */
  readonly onChatWithAgent?: (name: string) => Promise<void>;
  readonly onClose: () => void;
}

export function AgentForm({
  editing,
  onSubmit,
  onChatWithAgent,
  onClose,
}: AgentFormProps): ReactElement {
  const [name, setName] = useState(
    read(editing ?? {}, "name", "displayName", "display_name"),
  );
  const [description, setDescription] = useState(read(editing ?? {}, "description"));
  const [prompt, setPrompt] = useState(read(editing ?? {}, "systemPrompt", "system_prompt"));
  const [model, setModel] = useState(read(editing ?? {}, "model"));

  const save = async () => {
    const trimmed = name.trim();
    const saved = await onSubmit(
      editing
        ? {
            kind: "updateAgent",
            // The agent's name is its identity on the server, so an update
            // addresses the stored name. Editing the field does not rename it —
            // a rename is a different intent, and silently folding it into the
            // update would target whichever agent matched the new name.
            name: read(editing, "name", "pluginName", "plugin_name", "pluginId", "displayName", "display_name"),
            displayName: trimmed,
            description: description.trim(),
            systemPrompt: prompt,
          }
        : {
            kind: "createAgent",
            name: trimmed,
            displayName: trimmed,
            description: description.trim(),
            systemPrompt: prompt,
            // The chosen model travels in the definition, not in the agent's
            // own fields — an edit never carries one, so this is create-only.
            initialDefinition: {
              name: trimmed,
              description: description.trim(),
              systemPrompt: prompt,
              ...(model.trim() ? { model: model.trim() } : {}),
            },
          },
    );
    if (saved) onClose();
  };

  return (
    <div className="webui-plugin-form webui-agent-form">
      <WebuiField
        label="名称"
        control={(props) => (
          <input {...props} className="w-full" value={name} onChange={(event) => setName(event.currentTarget.value)} />
        )}
      />
      <WebuiField
        label="描述"
        control={(props) => (
          <input {...props} className="w-full" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
        )}
      />
      <WebuiField
        className="wide"
        label="系统提示词"
        control={(props) => (
          <textarea {...props} className="w-full" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} />
        )}
      />
      {/* The model belongs to the initial definition, which only a new agent
          sends; an edit updates the agent's fields and leaves it alone. */}
      {editing ? null : (
        <WebuiField
          label="模型"
          control={(props) => (
            <input {...props} className="w-full" value={model} onChange={(event) => setModel(event.currentTarget.value)} />
          )}
        />
      )}
      <div className="webui-agent-form-actions">
        {editing && onChatWithAgent ? (
          <WebuiButton variant="surface" size="panel" onClick={() => void onChatWithAgent(name)}>
            对话
          </WebuiButton>
        ) : null}
        <WebuiButton variant="surface" size="panel" onClick={onClose}>
          取消
        </WebuiButton>
        <WebuiButton variant="surface" size="panel" onClick={() => void save()}>
          保存
        </WebuiButton>
      </div>
    </div>
  );
}
