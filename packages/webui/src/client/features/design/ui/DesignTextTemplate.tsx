import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  DesignNode,
  DesignState,
} from "../../../../shared/contracts/design.js";
import {
  WebuiField,
  WebuiSelectMenu,
  WebuiTextInput,
} from "../../../ui/field.js";
import { WebuiButton } from "../../../ui/button.js";
import { records } from "../projection/design-view.js";
import type { DesignOwner } from "../application/design-owner.js";

export function DesignTextTemplate({
  node,
  data,
  onPatch,
  registerPendingEdit,
  onPendingChange,
}: {
  readonly node: DesignNode;
  readonly data: DesignState;
  readonly onPatch: (
    metadata: Readonly<Record<string, unknown>>,
  ) => Promise<DesignState | undefined>;
  readonly registerPendingEdit?: DesignOwner["registerPendingEdit"];
  readonly onPendingChange?: (pending: boolean) => void;
}): ReactElement {
  const templates = records(data.capabilities.templates);
  const template = templates.find(
    (item) => item.id === (node.metadata.templateId ?? "custom"),
  );
  const fields = records(template?.fields);
  const [values, setValues] = useState(node.metadata.templateVars ?? {});
  const draft = useRef(values),
    base = useRef(node),
    live = useRef(true),
    pending = useRef(false);
  const latest = useRef({ onPatch, onPendingChange });
  latest.current = { onPatch, onPendingChange };
  const flush = async () => {
    if (!pending.current) return live.current;
    const captured = draft.current;
    const result = await latest.current.onPatch({ templateVars: captured });
    const committed = result?.document?.nodes.find(
      (item) => item.id === node.id,
    );
    if (committed) base.current = committed;
    live.current = Boolean(result && committed);
    if (result && captured === draft.current) {
      pending.current = false;
      latest.current.onPendingChange?.(false);
    }
    return live.current;
  };
  const flusher = useRef(flush);
  flusher.current = flush;
  useEffect(
    () =>
      registerPendingEdit?.(
        () => flusher.current(),
        () =>
          pending.current
            ? {
                nodeId: node.id,
                baseNode: base.current,
                patch: { metadata: { templateVars: draft.current } },
              }
            : undefined,
        (edit) => {
          if (edit.patch.metadata?.templateVars === draft.current) {
            pending.current = false;
            latest.current.onPendingChange?.(false);
          }
        },
      ),
    [registerPendingEdit, node.id],
  );
  useEffect(
    () => () => {
      void flusher.current();
    },
    [],
  );
  useEffect(() => {
    const next = node.metadata.templateVars ?? {};
    draft.current = next;
    setValues(next);
  }, [node.metadata.templateId]);
  const preview = fields
    .map((field) =>
      String(values[String(field.key)] ?? field.default ?? "").trim(),
    )
    .filter(Boolean)
    .join("，");
  return (
    <div className="webui-design-text-template" data-canvas-no-zoom="true">
      <WebuiField
        label="品类模板"
        control={(field) => (
          <WebuiSelectMenu
            {...field}
            labelId={field.id.replace(/-control$/u, "-label")}
            value={node.metadata.templateId ?? "custom"}
            options={templates.map((item) => ({
              value: String(item.id),
              label: String(item.label),
            }))}
            onChange={(templateId) => {
              void flush().then(() =>
                onPatch({ templateId, templateVars: {} }),
              );
            }}
          />
        )}
      />
      {template && template.id !== "custom" ? (
        <>
          <p className="webui-design-muted">{String(template.desc ?? "")}</p>
          {fields.map((item) => (
            <WebuiField
              key={String(item.key)}
              label={String(item.label)}
              control={(field) => (
                <WebuiTextInput
                  {...field}
                  value={String(values[String(item.key)] ?? item.default ?? "")}
                  onChange={(event) => {
                    if (!pending.current) base.current = node;
                    pending.current = true;
                    latest.current.onPendingChange?.(true);
                    const next = {
                      ...draft.current,
                      [String(item.key)]: event.target.value,
                    };
                    draft.current = next;
                    setValues(next);
                  }}
                  onBlur={() => {
                    void flush();
                  }}
                />
              )}
            />
          ))}
          <div className="webui-design-template-preview">
            <span>预览</span>
            <b>{preview || "（未填写）"}</b>
          </div>
          <WebuiButton
            variant="plain"
            size="inline-tiny"
            onClick={() =>
              onPatch({
                prompt: preview,
                segments: preview ? [{ type: "text", text: preview }] : [],
                mentions: [],
              }).then(() => undefined)
            }
          >
            应用到文本
          </WebuiButton>
        </>
      ) : null}
    </div>
  );
}
