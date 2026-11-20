import { useEffect, useId, useState, type ReactElement } from "react";
import type {
  DesignAction,
  DesignDocument,
  DesignMedia,
  DesignNode,
  DesignState,
} from "../../../../shared/contracts/design.js";
import {
  WebuiDropdown,
  type WebuiDropdownAnchorRect,
} from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import {
  WebuiCheckbox,
  WebuiField,
  WebuiSelectMenu,
  WebuiTextInput,
} from "../../../ui/field.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import {
  records,
  strings,
  designCreatedNodeIds,
  type DesignProductPlacement,
} from "../projection/design-view.js";
import { runDesignImageTool } from "../bindings/use-design.js";
import { DesignClipPanel } from "./DesignClipPanel.js";

export interface DesignToolSelection {
  readonly nodeId: string;
  readonly toolKey: string;
  readonly anchor: WebuiDropdownAnchorRect;
}
export function DesignToolPanel({
  selection,
  data,
  document,
  onClose,
  onAction,
  assetUrl,
  mediaElement,
  onProducts,
}: {
  readonly selection?: DesignToolSelection;
  readonly data: DesignState;
  readonly document?: DesignDocument;
  readonly onClose: () => void;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly assetUrl: (url: string) => string;
  readonly mediaElement?: HTMLMediaElement | null;
  readonly onProducts: (input: DesignProductPlacement) => Promise<void>;
}): ReactElement {
  const uid = useId(),
    { dom } = useWebuiBrowserCapabilities();
  const node = document?.nodes.find((item) => item.id === selection?.nodeId);
  const tool = records(data.capabilities.tools).find(
    (item) => item.key === selection?.toolKey,
  );
  const [params, setParams] = useState<Readonly<Record<string, unknown>>>(() =>
    Object.fromEntries(
      records(tool?.params).map((item) => [String(item.key), item.default]),
    ),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useWebuiToastError(error);
  useEffect(() => {
    if (selection) {
      setParams(
        Object.fromEntries(
          records(tool?.params).map((item) => [String(item.key), item.default]),
        ),
      );
      setError(undefined);
    }
  }, [selection?.nodeId, selection?.toolKey]);
  const sourceNodes: readonly DesignNode[] =
    node && document
      ? [
          node,
          ...document.connections
            .filter((line) => line.toNodeId === node.id)
            .map((line) =>
              document.nodes.find((item) => item.id === line.fromNodeId),
            )
            .filter((item): item is DesignNode => Boolean(item)),
        ]
      : [];
  const sources: DesignMedia[] = [];
  for (const source of sourceNodes)
    for (const media of source.metadata.output.media)
      if (!sources.some((item) => item.url === media.url)) sources.push(media);
  const apply = async (values: Readonly<Record<string, unknown>>) => {
    if (!node || !tool) return;
    setBusy(true);
    setError(undefined);
    try {
      const created: string[] = [];
      if (tool.key === "gridSplit" || tool.key === "crop") {
        const media = node.metadata.output.media[0];
        if (!media) throw new Error("这个节点还没有素材");
        const products = await runDesignImageTool(
          dom,
          assetUrl(media.url),
          tool.key,
          values,
        );
        for (const product of products) {
          const result = await onAction({
            type: "publish",
            ...product,
            sourceNodeId: node.id,
          });
          if (!result) throw new Error("处理结果未保存");
          created.push(...designCreatedNodeIds(result));
        }
      } else {
        const result = await onAction({
          type: "media_tool",
          tool: String(tool.key),
          sources,
          params: values,
          sourceNodeId: node.id,
        });
        if (!result) throw new Error("工具未启动，请查看画布错误提示。");
        created.push(...designCreatedNodeIds(result));
      }
      if (created.length)
        await onProducts({
          ids: created,
          sourceNodeId: node.id,
          ...(tool.key === "gridSplit"
            ? {
                columns: Math.min(
                  8,
                  Math.max(1, Math.round(Number(values.cols) || 1)),
                ),
                tile: true,
              }
            : {}),
        });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const clip = tool?.ui === "clip",
    media = node?.metadata.output.media[0];
  return (
    <WebuiDropdown
      managed
      open={Boolean(selection && node && tool)}
      onOpen={() => undefined}
      onClose={onClose}
      anchorRect={() =>
        selection?.anchor ?? { left: 0, top: 0, width: 0, height: 0 }
      }
      managedLayerId={uid}
      role="dialog"
      ariaLabel={String(tool?.label ?? "媒体工具")}
      side="bottom"
      align={clip ? "center" : "start"}
      collision="flip"
      className={`webui-design-tool-panel${clip ? " webui-design-tool-panel-clip" : ""}`}
    >
      <div className="webui-design-panel-title">
        {String(tool?.label ?? "媒体工具")}
      </div>
      <p className="webui-design-muted">{String(tool?.desc ?? "")}</p>
      {clip && media ? (
        <DesignClipPanel
          media={media}
          assetUrl={assetUrl}
          mediaElement={mediaElement}
          onCancel={onClose}
          onApply={(range) => apply(range)}
        />
      ) : (
        <>
          {records(tool?.params).some((item) => item.type === "multi") ? (
            <p className="webui-design-muted">
              每选一个参数值跑一次生成，每个值一张图。
            </p>
          ) : null}
          {records(tool?.params).map((parameter) => {
            const key = String(parameter.key);
            return (
              <WebuiField
                key={key}
                label={String(parameter.label ?? key)}
                control={(field) =>
                  parameter.type === "multi" ? (
                    <div
                      className="webui-design-tool-multiselect"
                      id={field.id}
                    >
                      {strings(parameter.options).map((value) => (
                        <label key={value}>
                          <WebuiCheckbox
                            checked={strings(params[key]).includes(value)}
                            onChange={(event) =>
                              setParams({
                                ...params,
                                [key]: event.target.checked
                                  ? [...strings(params[key]), value]
                                  : strings(params[key]).filter(
                                      (item) => item !== value,
                                    ),
                              })
                            }
                          />
                          <span>{value}</span>
                        </label>
                      ))}
                    </div>
                  ) : parameter.type === "select" ? (
                    <WebuiSelectMenu
                      {...field}
                      labelId={field.id.replace(/-control$/u, "-label")}
                      value={String(params[key] ?? parameter.default ?? "")}
                      options={strings(parameter.options).map((value) => ({
                        value,
                        label: value,
                      }))}
                      onChange={(value) =>
                        setParams({ ...params, [key]: value })
                      }
                    />
                  ) : (
                    <WebuiTextInput
                      {...field}
                      type={parameter.type === "number" ? "number" : "text"}
                      value={String(params[key] ?? parameter.default ?? "")}
                      min={
                        typeof parameter.min === "number"
                          ? parameter.min
                          : undefined
                      }
                      max={
                        typeof parameter.max === "number"
                          ? parameter.max
                          : undefined
                      }
                      step={
                        typeof parameter.step === "number"
                          ? parameter.step
                          : undefined
                      }
                      onChange={(event) =>
                        setParams({
                          ...params,
                          [key]:
                            parameter.type === "number"
                              ? Number(event.target.value)
                              : event.target.value,
                        })
                      }
                    />
                  )
                }
              />
            );
          })}
          {!records(tool?.params).length ? (
            <p className="webui-design-muted">这个工具不需要参数。</p>
          ) : null}
          <div className="webui-design-node-actions">
            <WebuiButton
              variant="primary"
              size="inline-dense"
              disabled={busy}
              onClick={() => apply(params)}
            >
              应用
            </WebuiButton>
            <WebuiButton
              variant="plain"
              size="inline-dense"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </WebuiButton>
          </div>
        </>
      )}
    </WebuiDropdown>
  );
}
