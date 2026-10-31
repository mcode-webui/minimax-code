// The remote terminal view.
//
// The output is plain text in a fixed-width block: the browser has no terminal emulator here, and
// the panel shows what the remote side printed rather than pretending to be one. The input is one
// field, and Enter sends a carriage return, which is what a shell expects.
import { useState, type ReactElement } from "react";

import type { WebuiSshTerminalSnapshot } from "../application/ssh-owner.js";
import { WEBUI_SSH_NO_TERMINAL_TEXT } from "../projection/ssh-panel.js";
import { WebuiButton } from "../../../ui/button.js";

export interface SshTerminalViewProps {
  readonly terminal: WebuiSshTerminalSnapshot;
  readonly onInput: (data: string) => void;
  readonly onClose: () => void;
}

export function SshTerminalView(props: SshTerminalViewProps): ReactElement {
  const [input, setInput] = useState("");
  const open = props.terminal.status !== "closed" && Boolean(props.terminal.terminalId);

  const send = (): void => {
    if (!input) return;
    props.onInput(`${input}\r`);
    setInput("");
  };

  return (
    <section
      aria-label="远程终端"
      data-webui-component="ssh-terminal"
      className="mt-3 rounded-[8px] border border-border_default"
    >
      <header className="flex items-center justify-between border-b-[0.5px] border-border_default px-3 py-1.5">
        <span className="text-xs text-text_default_tertiary">
          {props.terminal.alias ?? ""}
          {props.terminal.error ? ` · ${props.terminal.error}` : ""}
        </span>
        <WebuiButton variant="quiet-highlight" size="inline-tiny" data-webui-ssh-terminal-close="true"
          onClick={props.onClose}

        >
          关闭终端
        </WebuiButton>
      </header>
      <pre
        data-webui-ssh-terminal-output="true"
        className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-text_default_primary"
      >
        {props.terminal.output || (open ? "" : WEBUI_SSH_NO_TERMINAL_TEXT)}
      </pre>
      {open
        ? <div className="flex items-center gap-2 border-t-[0.5px] border-border_default px-3 py-1.5">
          <input
            type="text"
            aria-label="终端输入"
            data-webui-ssh-terminal-input="true"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            className="flex-1 bg-transparent font-mono text-xs text-text_default_primary outline-none"
          />
          <WebuiButton variant="outline-secondary" size="inline-tiny" data-webui-ssh-terminal-send="true"
            onClick={send}

          >
            发送
          </WebuiButton>
        </div>
        : null}
    </section>
  );
}
