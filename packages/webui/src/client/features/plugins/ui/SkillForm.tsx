// The skill form unit.
//
// A skill is created, never edited in place: the one command this form can reach
// is `createSkill`. Its two draft fields were two `useState` calls in
// `PluginCatalogue`, and its name came from the same box the agent form uses —
// which is why the two forms shared a field they had no reason to share.

import { useState, type ReactElement } from "react";

import type { WebuiPluginIntent } from "../contracts/plugin-actions.js";
import { WebuiButton } from "../../../ui/button.js";

export interface SkillFormProps {
  readonly onSubmit: (intent: WebuiPluginIntent) => Promise<boolean>;
  readonly onClose: () => void;
}

export function SkillForm({ onSubmit, onClose }: SkillFormProps): ReactElement {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  const save = async () => {
    const created = await onSubmit({
      kind: "createSkill",
      name: name.trim(),
      description: description.trim(),
      content,
    });
    // Only a created skill clears the draft: a rejected one is still the user's
    // work, and throwing it away would make a failed save look like a reset.
    if (created) {
      setName("");
      setDescription("");
      setContent("");
      onClose();
    }
  };

  return (
    <div className="webui-plugin-form webui-skill-form">
      <label>
        <span>名称</span>
        <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        <span>描述</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <label className="wide">
        <span>内容</span>
        <textarea value={content} onChange={(event) => setContent(event.currentTarget.value)} />
      </label>
      <div className="webui-agent-form-actions">
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
