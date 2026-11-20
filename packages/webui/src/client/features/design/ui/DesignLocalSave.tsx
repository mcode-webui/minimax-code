import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  DesignAction,
  DesignExportSource,
  DesignState,
} from "../../../../shared/contracts/design.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiTextInput } from "../../../ui/field.js";
import { record } from "../projection/design-view.js";

export function DesignLocalSave({
  data,
  fileName,
  source,
  onAction,
  onCancel,
  onSaved,
}: {
  readonly data: DesignState;
  readonly fileName: string;
  readonly source: DesignExportSource;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly onCancel: () => void;
  readonly onSaved: (path: string) => void;
}): ReactElement {
  const [path, setPath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!data.exportPlaces) void onAction({ type: "places" });
  }, []);
  useEffect(() => {
    if (data.exportPlaces)
      setPath(
        `${data.exportPlaces.downloads}${data.exportPlaces.sep}${fileName}`,
      );
  }, [data.exportPlaces?.downloads, fileName]);
  const save = async () => {
    if (!path.trim()) {
      setError("没写这个文件要去哪里");
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await onAction({
      type: "export_file",
      path: path.trim(),
      source,
      ...(overwrite ? { overwrite: true } : {}),
    });
    setBusy(false);
    if (typeof record(result?.result).path === "string")
      onSaved(String(record(result?.result).path));
    else setError("未保存，请查看上方错误提示。若文件已存在，可明确选择覆盖。");
  };
  return (
    <div className="webui-design-local-save">
      <p className="webui-design-muted">这个文件会存到本机的哪个位置：</p>
      <WebuiField
        label="保存到哪个位置"
        error={error}
        control={(field) => (
          <WebuiTextInput
            {...field}
            ref={input}
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setOverwrite(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
        )}
      />
      <div className="webui-design-toolbar-group">
        {(
          [
            ["下载文件夹", "downloads"],
            ["桌面", "desktop"],
            ["文档", "documents"],
            ["主目录", "home"],
          ] as const
        ).map(([label, key]) => (
          <WebuiButton
            key={key}
            variant="plain"
            size="inline-tiny"
            disabled={!data.exportPlaces}
            onClick={() => {
              if (data.exportPlaces)
                setPath(
                  `${data.exportPlaces[key]}${data.exportPlaces.sep}${fileName}`,
                );
              setOverwrite(false);
              input.current?.focus({ preventScroll: true });
            }}
          >
            {label}
          </WebuiButton>
        ))}
      </div>
      <div className="webui-design-node-actions">
        <WebuiButton
          variant="primary"
          size="inline-dense"
          disabled={!data.exportPlaces || busy}
          onClick={save}
        >
          存到这儿
        </WebuiButton>
        <WebuiButton variant="plain" size="inline-tiny" onClick={onCancel}>
          取消
        </WebuiButton>
        {error ? (
          <WebuiButton
            variant="danger"
            size="inline-tiny"
            onClick={() => setOverwrite(true)}
            disabled={overwrite}
          >
            {overwrite ? "已明确允许覆盖" : "允许覆盖同名文件"}
          </WebuiButton>
        ) : null}
      </div>
      <small className="webui-design-muted">{fileName}</small>
    </div>
  );
}
