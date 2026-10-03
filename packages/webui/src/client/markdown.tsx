import { marked, type Token } from "marked";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import ini from "highlight.js/lib/languages/ini";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import {
  createElement,
  Fragment,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { parseWebuiMessageFileReference } from "./projection/message-file-reference.js";

// The same `highlight.js/lib/core` registration `components/WorkspacePanels.tsx`
// performs for the file viewer — the full `highlight.js` bundle is never
// imported, and `registerLanguage` is idempotent, so the two callers share one
// core instance.
const MARKDOWN_CODE_LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown: markdownLanguage,
  python,
  rust,
  toml: ini,
  typescript,
  xml,
  yaml,
} as const;
for (const [name, language] of Object.entries(MARKDOWN_CODE_LANGUAGES)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
}

/** The language word of a fence tag, or `undefined` when there is none. */
function codeFenceLanguage(lang: string | undefined): string | undefined {
  // marked keeps everything after the backticks, so a ```ts title="a.ts"``` fence
  // arrives as `ts title="a.ts"`.
  const name = lang?.trim().split(/\s+/u)[0];
  return name || undefined;
}

/** hljs markup for a fence body, or `undefined` to take the plain path. */
function highlightCodeFence(text: string, language: string | undefined): string | undefined {
  if (!language || !hljs.getLanguage(language)) return undefined;
  try {
    const value = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The line numbers a fence body warrants, in document order. */
function codeFenceGutter(text: string): number[] {
  if (text.trim() === "") return [];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  // SPEC-C C-2 asks for no gutter on a one-line body that ends without a
  // newline, so a single entry is not a gutter.
  return lines.length > 1 ? lines.map((_line, index) => index + 1) : [];
}

marked.use({
  extensions: [
    {
      name: "webuiMath",
      level: "inline",
      start(source) {
        const index = source.search(/\$\$?|\\\(/u);
        return index >= 0 ? index : undefined;
      },
      tokenizer(source) {
        const match = source.match(/^(\$\$?)([\s\S]+?)\1/u);
        if (!match) return undefined;
        const delimiter = match[1];
        const body = match[2];
        if (delimiter === undefined || body === undefined) return undefined;
        // A single dollar is inline math only. It cannot cross a line or
        // attach to a number, so ordinary prose such as "$5 and $10" stays
        // prose. Display math keeps the existing multiline behaviour.
        if (
          delimiter === "$" &&
          (body.includes("\n") || /^\d/u.test(body))
        )
          return undefined;
        return {
          type: "webuiMath",
          raw: match[0],
          text: body,
          display: delimiter === "$$",
        } as Token & { readonly display: boolean };
      },
    },
    {
      // A narrow fallback for Desktop's file references. Some stored
      // messages carry `[name](/absolute/workspace/path)` as literal text
      // instead of a Markdown link token; recognize that exact file-link
      // shape before marked's generic inline tokenizers.
      name: "webuiFileReference",
      level: "inline",
      start(source) {
        const index = source.search(/\[[^\]\n]+\]\((?:\/|[A-Za-z]:[\\/])/u);
        return index >= 0 ? index : undefined;
      },
      tokenizer(source) {
        const match = source.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)/u);
        if (!match) return undefined;
        return { type: "webuiFileReference", raw: match[0], text: match[1], href: match[2] } as Token & { readonly text: string; readonly href: string };
      },
    },
  ],
});

export function isSafeWebuiMarkdownHref(href: string): boolean {
  const value = href.trim();
  if (value.startsWith("#")) return true;
  if (value.startsWith("//")) return false;
  if (/^(?:https?|mailto):/iu.test(value)) return true;
  return !/^[a-z][a-z\d+.-]*:/iu.test(value);
}

function fileReferenceAnchor(key: string, value: string, reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>, onOpenFile: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void, showIcon = true): ReactElement {
  const name = reference.path.split("/").at(-1) ?? reference.path;
  const extension = name.split(".").at(-1)?.toLowerCase();
  const icon = extension === "py" ? "🐍" : ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "") ? "🖼️" : ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? "") ? "📘" : "📄";
  return <a key={key} className="webui-message-file-link" href={value} title={reference.path} data-webui-file-reference={reference.path} onClick={(event) => { event.preventDefault(); onOpenFile(reference); }}>{showIcon ? <span aria-hidden="true">{icon}</span> : null}<span>{name}</span></a>;
}

function inline(tokens: readonly Token[] | undefined, onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void, workspaceDir?: string, lexBareText = true): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "strong")
      return <strong key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</strong>;
    if (token.type === "em") return <em key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</em>;
    if (token.type === "codespan") {
      const reference = onOpenFile ? parseWebuiMessageFileReference(token.text, workspaceDir) : undefined;
      return reference
        ? fileReferenceAnchor(key, token.text, reference, onOpenFile!)
        : <code key={key}>{token.text}</code>;
    }
    if (token.type === "webuiMath") {
      const math = token as Token & { readonly text: string; readonly display: boolean };
      try {
        return (
          <span
            key={key}
            className={math.display ? "webui-math webui-math-block" : "webui-math"}
            dangerouslySetInnerHTML={{ __html: katex.renderToString(math.text, { displayMode: math.display }) }}
          />
        );
      } catch {
        return <code key={key}>{math.raw}</code>;
      }
    }
    if (token.type === "link") {
      const fileReference = onOpenFile ? parseWebuiMessageFileReference(token.href, workspaceDir) : undefined;
      const extension = fileReference?.path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
      const fileIcon = extension === "py" ? "🐍" : ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "") ? "🖼️" : ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? "") ? "📘" : "📄";
      const previousToken = tokens?.[index - 1];
      const hasExistingIcon = previousToken?.type === "text" && (previousToken as Token & { readonly text: string }).text.trim() === fileIcon;
      return isSafeWebuiMarkdownHref(token.href) ? (
        fileReference ? fileReferenceAnchor(key, token.href, fileReference, onOpenFile!, !hasExistingIcon) : <a key={key} href={token.href} rel="noreferrer">
          {/* The label was tokenized by marked already. Re-lexing it here would
              re-emit an autolink inside this anchor — `<a>` inside `<a>`. */}
          {inline(token.tokens, onOpenFile, workspaceDir, false)}
        </a>
      ) : (
        <Fragment key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</Fragment>
      );
    }
    if (token.type === "webuiFileReference") {
      const file = token as Token & { readonly text: string; readonly href: string };
      const reference = onOpenFile ? parseWebuiMessageFileReference(file.href, workspaceDir) : undefined;
      return reference
        ? fileReferenceAnchor(key, file.href, reference, onOpenFile!)
        : <span key={key}>{file.text}</span>;
    }
    if (token.type === "br") return <br key={key} />;
    if (token.type === "text") {
      if (token.tokens) return <Fragment key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</Fragment>;
      // `marked.lexer` leaves inline children un-tokenized inside some list
      // and blockquote shapes. Tokenize that text here so links, code spans,
      // emphasis, math and the Desktop file-reference extension render the
      // same way regardless of their containing block.
      if (lexBareText) {
        const parsedInline = marked.Lexer.lexInline(token.text, marked.defaults);
        if (parsedInline.length !== 1 || parsedInline[0]?.type !== "text" || parsedInline[0]?.raw !== (token.raw ?? token.text))
          return <Fragment key={key}>{inline(parsedInline, onOpenFile, workspaceDir, false)}</Fragment>;
      }
      if (!onOpenFile) return token.text;
      const parts: ReactNode[] = [];
      // A path cannot start with a `.`: a match immediately after one is the
      // tail of a dotted host (`https://example.com/pkg/index.ts`), and the
      // URL as a whole is not a reference — `parseWebuiMessageFileReference`
      // returns undefined for it. Excluding `.` keeps the scanner from slicing
      // the URL before the parser ever sees one.
      const expression = /(?<![\w/.:])(?:[A-Za-z]:[\\/][\w@.+-]+(?:[\\/][\w@.+-]+)*|\/(?:[\w@.+-]+\/)*[\w@.+-]+|(?:\.\.?\/)?[\w@.+-]+(?:\/[\w@.+-]+)*)\.[A-Za-z0-9_-]+(?::\d+(?:-\d+)?)?/gu;
      let cursor = 0;
      for (const match of token.text.matchAll(expression)) {
        const start = match.index ?? 0;
        const text = match[0];
        const reference = parseWebuiMessageFileReference(text, workspaceDir);
        if (!reference || !(/\//u.test(reference.path) || /\.(?:[cm]?[jt]sx?|html|css|json|md|ya?ml|toml|rs|py|go|java|kt|sh)$/iu.test(reference.path))) continue;
        if (start > cursor) parts.push(token.text.slice(cursor, start));
        parts.push(fileReferenceAnchor(`${key}-file-${start}`, text, reference, onOpenFile));
        cursor = start + text.length;
      }
      if (cursor === 0) return token.text;
      if (cursor < token.text.length) parts.push(token.text.slice(cursor));
      return <Fragment key={key}>{parts}</Fragment>;
    }
    return (
      <Fragment key={key}>
        {"text" in token && typeof token.text === "string"
          ? token.text
          : token.raw}
      </Fragment>
    );
  });
}

function blocks(tokens: readonly Token[] | undefined, onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void, workspaceDir?: string): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "paragraph")
      return <p key={key}>{inline(token.tokens, onOpenFile, workspaceDir)}</p>;
    if (token.type === "heading")
      return createElement(`h${token.depth}`, { key }, ...inline(token.tokens, onOpenFile, workspaceDir));
    if (token.type === "code" && token.lang?.toLowerCase() === "math") {
      try {
        return (
          <span
            key={key}
            className="webui-math webui-math-block"
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(token.text, { displayMode: true }),
            }}
          />
        );
      } catch {
        return <pre key={key}>{token.text}</pre>;
      }
    }
    if (token.type === "code") {
      const language = codeFenceLanguage(token.lang);
      const highlighted = highlightCodeFence(token.text, language);
      const gutter = codeFenceGutter(token.text);
      return (
        <div key={key} className={gutter.length > 0 ? "webui-code-block webui-code-block--numbered" : "webui-code-block"}>
          {gutter.length > 0 ? (
            <ol className="webui-code-gutter" aria-hidden="true">
              {gutter.map((lineNumber) => (
                <li key={lineNumber}>{lineNumber}</li>
              ))}
            </ol>
          ) : null}
          <pre>
            <code
              className={highlighted === undefined ? undefined : `hljs language-${language}`}
              data-language={token.lang ?? undefined}
              {...(highlighted === undefined ? {} : { dangerouslySetInnerHTML: { __html: highlighted } })}
            >
              {highlighted === undefined ? token.text : undefined}
            </code>
          </pre>
        </div>
      );
    }
    if (token.type === "table") {
      type Align = "left" | "right" | "center" | null | undefined;
      const table = token as {
        header: Array<{ text: string; tokens?: Token[]; align?: Align }>;
        rows: Array<Array<{ text: string; tokens?: Token[]; align?: Align }>>;
        align?: Align[];
      };
      const cellAlign = (
        cell: { align?: Align },
        index: number,
      ): CSSProperties | undefined => {
        const value = cell.align ?? table.align?.[index];
        return value ? { textAlign: value } : undefined;
      };
      return (
        <div key={key} className="webui-table-shell">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={cellAlign(cell, index)}>
                    {inline(cell.tokens, onOpenFile, workspaceDir)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={cellAlign(cell, cellIndex)}>
                    {inline(cell.tokens, onOpenFile, workspaceDir)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (token.type === "blockquote")
      return <blockquote key={key}>{blocks(token.tokens, onOpenFile, workspaceDir)}</blockquote>;
    if (token.type === "list") {
      const items = token.items as Array<{ tokens: Token[] }>;
      return token.ordered ? (
        <ol key={key}>
          {items.map((item, i) => (
            <li key={i}>{blocks(item.tokens, onOpenFile, workspaceDir)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key}>
          {items.map((item, i) => (
            <li key={i}>{blocks(item.tokens, onOpenFile, workspaceDir)}</li>
          ))}
        </ul>
      );
    }
    if (token.type === "hr") return <hr key={key} />;
    if (token.type === "space") return <br key={key} />;
    if (token.type === "text") {
      const inlineTokens = token.tokens ?? marked.Lexer.lexInline(token.text, marked.defaults);
      return <p key={key}>{inline(inlineTokens, onOpenFile, workspaceDir)}</p>;
    }
    return (
      <p key={key}>
        {"text" in token && typeof token.text === "string"
          ? token.text
          : token.raw}
      </p>
    );
  });
}

export function WebuiMarkdown({ source, onOpenFile, workspaceDir }: {
  readonly source: string;
  readonly onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void;
  readonly workspaceDir?: string;
}): ReactElement {
  let tokens: Token[];
  try {
    const fileBullet = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?[^\n]*?)\[([^\]\n]+)\]\s*\r?\n\s*\(((?:\/[^\r\n()]+)|(?:[A-Za-z]:[\\/][^\r\n()]+))\)[ \t]*(?:[—-][ \t]*([^\r\n]+)|\r?\n\s*[—-]\s*([^\r\n]+))?/gmu;
    const normalizedSource = source.replace(fileBullet, (_match, prefix: string, name: string, path: string, inlineCaption?: string, nextLineCaption?: string) => `${prefix}[${name}](${path.trim()})${inlineCaption || nextLineCaption ? ` — ${(inlineCaption ?? nextLineCaption)?.trim()}` : ""}`);
    tokens = marked.lexer(normalizedSource);
  } catch {
    tokens = [{ type: "text", raw: source, text: source }];
  }
  return (
    <div data-webui-markdown="true" className="matrix-markdown webui-markdown">
      {blocks(tokens, onOpenFile, workspaceDir)}
    </div>
  );
}
