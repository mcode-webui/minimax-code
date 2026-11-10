import { marked, type Token } from "marked";
import katex from "katex";
import { isWebuiMermaidFence, WebuiMermaid } from "./webui-mermaid.js";
import { WebuiIconFileForName } from "../../../shell/icons.js";
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
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { parseWebuiMessageFileReference } from "../projection/message-file-reference.js";

// The same `highlight.js/lib/core` registration `components/workspace/WorkspacePanels.tsx`
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

// The inline-code path rule: a path may contain directories, but a
// bare filename is a file reference only when its extension is recognized.
const INLINE_FILE_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cc", "cjs", "clj", "cljs", "cljc", "cmd", "cpp", "cs", "css", "cts", "cxx",
  "dart", "elm", "erl", "ex", "exs", "fish", "fs", "fsi", "fsx", "go", "gradle", "groovy", "h", "handlebars",
  "hbs", "hcl", "hh", "hpp", "hrl", "htm", "html", "java", "jl", "js", "json", "jsx", "kt", "kts", "less",
  "lua", "m", "mjs", "mm", "mts", "nim", "php", "pl", "pm", "proto", "ps1", "py", "pyi", "r", "rb", "rs",
  "sass", "scala", "scss", "sh", "sol", "sql", "svelte", "swift", "tf", "thrift", "toml", "ts", "tsx", "vb",
  "vbs", "vue", "xml", "yaml", "yml", "zig", "zsh",
]);
const INLINE_EXTENSIONLESS_FILE_NAMES = new Set([
  "cmakelists.txt", "dockerfile", "gemfile", "jenkinsfile", "makefile", "rakefile",
]);

function parseInlineFileReference(value: string, workspaceDir?: string): ReturnType<typeof parseWebuiMessageFileReference> {
  const reference = parseWebuiMessageFileReference(value, workspaceDir);
  if (!reference) return undefined;
  const name = reference.path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  const hasExtension = /\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
  return (hasExtension && (reference.path.includes("/") || INLINE_FILE_EXTENSIONS.has(extension) || webuiInlineMediaKind(name) !== undefined)) || INLINE_EXTENSIONLESS_FILE_NAMES.has(name)
    ? reference
    : undefined;
}
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

/**
 * Chinese characters and the punctuation that comes with them.
 *
 * Used to tell prose that merely contains dollars from a formula: a formula
 * is not written in Chinese, so a dollar-delimited run that carries Chinese
 * is prose.
 */
const WEBUI_MATH_CJK_PATTERN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u;

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
        // A run between two dollars that carries Chinese words is prose that
        // happens to contain dollars — a shell variable, a price, a stray
        // symbol. Read as math it swallowed the paragraph, and KaTeX then
        // complained about every Chinese character in it. Math is not written
        // in Chinese, so a body that carries it is not math.
        if (WEBUI_MATH_CJK_PATTERN.test(body)) return undefined;
        return {
          type: "webuiMath",
          raw: match[0],
          text: body,
          display: delimiter === "$$",
        } as Token & { readonly display: boolean };
      },
    },
    {
      // A narrow fallback for file references. Some stored
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

/**
 * The emoji a model writes in front of a file name it links to. The link draws
 * the real file-type glyph, so this is only used to notice that the text
 * already carries the model's own emoji and suppress a second mark.
 */
function fileReferenceEmoji(extension: string | undefined): string {
  if (extension === "py") return "🐍";
  if (["svg", "png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "")) return "🖼️";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? "")) return "📘";
  return "📄";
}

/**
 * Serves the bytes of a workspace file to the reader. Absent when this reader
 * has no such transport, in which case a file link stays just a link.
 */
type WebuiWorkspaceFileUrlBuilder = (path: string) => string;

const WebuiWorkspaceFileUrlContext = createContext<WebuiWorkspaceFileUrlBuilder | undefined>(undefined);

/** Makes file links in its subtree able to draw the picture they point at. */
export function WebuiWorkspaceFileUrlProvider({ build, children }: { readonly build?: WebuiWorkspaceFileUrlBuilder; readonly children: ReactNode }): ReactElement {
  return <WebuiWorkspaceFileUrlContext.Provider value={build}>{children}</WebuiWorkspaceFileUrlContext.Provider>;
}

/** The formats a browser paints on its own, so the transcript can show them. */
type WebuiInlineMediaKind = "image" | "video" | "audio";

const WEBUI_INLINE_MEDIA_KINDS: Readonly<Record<string, WebuiInlineMediaKind>> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "image", mp4: "video", webm: "video", ogv: "video", mov: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio", flac: "audio",
};

export function webuiInlineMediaKind(fileName: string): WebuiInlineMediaKind | undefined {
  const name = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  if (!name.includes(".")) return undefined;
  return WEBUI_INLINE_MEDIA_KINDS[name.split(".").at(-1)?.toLowerCase() ?? ""];
}

/** Failed loads a picture tolerates before it gives up and leaves just the link. */
const MEDIA_LOAD_RETRY_LIMIT = 4;

/** The delay before retry number `failures`, so a burst does not hammer the route. */
const MEDIA_LOAD_RETRY_MS = 800;

function WebuiMessageFileMedia({ kind, path }: { readonly kind: WebuiInlineMediaKind; readonly path: string }): ReactElement | null {
  const build = useContext(WebuiWorkspaceFileUrlContext);
  const url = build?.(path) ?? "";
  // A picture mounts as soon as the turn names the file, which can happen
  // before the write lands: the first request then 404s and, without a retry,
  // that failure was permanent — the reader had to reload the whole page to see
  // a file that had existed a moment after it was first asked for. Each failure
  // re-mounts the element through `token`, a bounded number of times, so a file
  // that never appears costs a few requests and then reads as a plain link.
  const [failures, setFailures] = useState(0);
  const [token, setToken] = useState(0);
  const gaveUp = failures > MEDIA_LOAD_RETRY_LIMIT;
  const loadedPathRef = useRef(url);
  useEffect(() => {
    if (loadedPathRef.current === url) return;
    loadedPathRef.current = url;
    setFailures(0);
    setToken(0);
  }, [url]);
  useEffect(() => {
    if (failures === 0 || gaveUp) return;
    const timer = setTimeout(() => setToken((value) => value + 1), MEDIA_LOAD_RETRY_MS * failures);
    return () => clearTimeout(timer);
  }, [failures, gaveUp]);
  if (!url || gaveUp) return null;
  const name = path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
  const retry = () => setFailures((value) => value + 1);
  // Deliberately not lazy: before the bytes arrive an image has no intrinsic
  // size, so a lazy one lays out at zero height and the viewport check never
  // fires — it would wait for a size it can only get by loading.
  return (
    <span className="webui-message-file-media" data-webui-file-media={kind} data-webui-file-media-attempt={failures}>
      {kind === "video"
        ? <video key={token} src={url} aria-label={name} controls playsInline preload="metadata" onError={retry} />
        : kind === "audio"
          ? <audio key={token} src={url} aria-label={name} controls preload="metadata" onError={retry} />
          : <img key={token} src={url} alt={name} decoding="async" onError={retry} />}
    </span>
  );
}

/**
 * Draws the picture or clip a file reference points at, or nothing when the
 * path is not media or the host cannot serve bytes. Both the link in the prose
 * and the delivered-file row call this, so the decision lives in one place.
 */
export function WebuiFileMedia({ path }: { readonly path: string }): ReactElement | null {
  const kind = webuiInlineMediaKind(path);
  return kind ? <WebuiMessageFileMedia kind={kind} path={path} /> : null;
}

function fileReferenceAnchor(key: string, value: string, reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>, onOpenFile: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void, showIcon = true): ReactElement {
  const name = reference.path.replace(/\\/gu, "/").split("/").at(-1) ?? reference.path;
  return <Fragment key={key}><a className="webui-message-file-link" href={value} title={reference.path} data-webui-file-reference={reference.path} onClick={(event) => { event.preventDefault(); onOpenFile(reference); }}>{showIcon ? <span aria-hidden="true"><WebuiIconFileForName fileName={name} /></span> : null}<span>{name}</span></a><WebuiFileMedia path={reference.path} /></Fragment>;
}

function inline(tokens: readonly Token[] | undefined, onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void, workspaceDir?: string, lexBareText = true): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "strong")
      return <strong key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</strong>;
    if (token.type === "em") return <em key={key}>{inline(token.tokens, onOpenFile, workspaceDir, lexBareText)}</em>;
    if (token.type === "codespan") {
      const reference = onOpenFile ? parseInlineFileReference(token.text, workspaceDir) : undefined;
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
      const fileIcon = fileReferenceEmoji(extension);
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
    if (token.type === "image") {
      const reference = parseWebuiMessageFileReference(token.href, workspaceDir);
      return reference
        ? <WebuiFileMedia key={key} path={reference.path} />
        : <Fragment key={key}>{token.text}</Fragment>;
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
      // emphasis, math and the file-reference extension render the
      // same way regardless of their containing block.
      if (lexBareText) {
        const parsedInline = marked.Lexer.lexInline(token.text, marked.defaults);
        if (parsedInline.length !== 1 || parsedInline[0]?.type !== "text" || parsedInline[0]?.raw !== (token.raw ?? token.text))
          return <Fragment key={key}>{inline(parsedInline, onOpenFile, workspaceDir, false)}</Fragment>;
      }
      // Only explicit Markdown links and recognized inline
      // code spans to file references. Scanning prose here turns identifiers
      // such as SQL table names into false file links.
      return token.text;
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

/**
 * What identifies one block for reuse: its kind and its source text.
 *
 * Two blocks with the same signature render to the same element, because the
 * renderer reads nothing else.
 */
function blockSignature(token: Token): string {
  return `${token.type}\u0000${token.raw ?? ""}`;
}

function blocks(
  tokens: readonly Token[] | undefined,
  onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void,
  workspaceDir?: string,
  reuse?: { readonly signatures: readonly string[]; readonly elements: readonly ReactNode[] },
): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = `${token.type}-${index}`;
    // A block whose source text and kind are unchanged renders to the same
    // element, so the previous rendering is reused rather than rebuilt. The
    // reuse is what keeps a streamed answer affordable: the answer grows by
    // appending, so every block before the one being written is identical
    // between two frames, and re-rendering it cannot change the result.
    // The kind is part of the comparison because the same source text can be
    // a different kind of block once the surrounding text moves.
    const reused = reuse?.elements[index];
    if (reused !== undefined && reuse?.signatures[index] === blockSignature(token)) return reused;
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
    // Mermaid fences branch off before the generic code path: the diagram
    // renders to SVG through `WebuiMermaid`, and every failure there lands
    // back on the plain fence. `codeFenceLanguage` strips the tag's trailing
    // attributes, so `mermaid title="a.mmd"` is recognised the same as a
    // bare `mermaid` tag. No other fence is affected by this branch.
    if (token.type === "code" && isWebuiMermaidFence(codeFenceLanguage(token.lang))) {
      return <WebuiMermaid key={key} text={token.text} lang={token.lang} />;
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

/**
 * The previous rendering of one answer, kept so the next one can reuse the
 * blocks that did not change.
 *
 * It belongs to the component instance rather than to the module: an answer
 * that leaves the transcript must take its elements with it.
 */
interface WebuiMarkdownBlockCache {
  readonly onOpenFile: WebuiMarkdownViewProps["onOpenFile"];
  readonly workspaceDir: string | undefined;
  readonly signatures: readonly string[];
  readonly elements: readonly ReactNode[];
}

interface WebuiMarkdownViewProps {
  readonly source: string;
  readonly streaming?: boolean;
  readonly onOpenFile?: (reference: NonNullable<ReturnType<typeof parseWebuiMessageFileReference>>) => void;
  readonly workspaceDir?: string;
}

function WebuiMarkdownView({ source, onOpenFile, workspaceDir }: WebuiMarkdownViewProps): ReactElement {
  const cacheRef = useRef<WebuiMarkdownBlockCache>();
  let tokens: Token[];
  try {
    const fileBullet = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?[^\n]*?)\[([^\]\n]+)\]\s*\r?\n\s*\(((?:\/[^\r\n()]+)|(?:[A-Za-z]:[\\/][^\r\n()]+))\)[ \t]*(?:[—-][ \t]*([^\r\n]+)|\r?\n\s*[—-]\s*([^\r\n]+))?/gmu;
    const normalizedSource = source.replace(fileBullet, (_match, prefix: string, name: string, path: string, inlineCaption?: string, nextLineCaption?: string) => `${prefix}[${name}](${path.trim()})${inlineCaption || nextLineCaption ? ` — ${(inlineCaption ?? nextLineCaption)?.trim()}` : ""}`);
    tokens = marked.lexer(normalizedSource);
  } catch {
    tokens = [{ type: "text", raw: source, text: source }];
  }
  // The cache only applies to the same reader: a different file-reference
  // handler or workspace changes what a block renders to.
  const cache = cacheRef.current;
  const reusable =
    cache && cache.onOpenFile === onOpenFile && cache.workspaceDir === workspaceDir
      ? cache
      : undefined;
  const signatures = tokens.map(blockSignature);
  const elements = blocks(tokens, onOpenFile, workspaceDir, reusable);
  cacheRef.current = { onOpenFile, workspaceDir, signatures, elements };
  return (
    <div data-webui-markdown="true" className="matrix-markdown webui-markdown">
      {elements}
    </div>
  );
}

const WebuiMarkdownContent = memo(
  WebuiMarkdownView,
  (previous, next) =>
    previous.source === next.source &&
    previous.workspaceDir === next.workspaceDir &&
    previous.onOpenFile === next.onOpenFile,
);

export const WebuiMarkdown = memo(function WebuiMarkdown({ streaming = false, ...props }: WebuiMarkdownViewProps): ReactElement {
  const [paintedSource, setPaintedSource] = useState(props.source);
  const latestSource = useRef(props.source);
  const pendingFrame = useRef<number>();
  latestSource.current = props.source;
  useEffect(() => {
    if (!streaming) {
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
      setPaintedSource(props.source);
    } else if (pendingFrame.current === undefined) {
      // 同一绘制机会内合并网络分片；新分片不重置待执行帧，持续输出也不会饿死渲染。
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = undefined;
        setPaintedSource(latestSource.current);
      });
    }
  }, [props.source, streaming]);
  useEffect(() => () => {
    if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
    pendingFrame.current = undefined;
  }, []);
  // 完成、替换和截断立即显示权威文本，不等待下一次绘制。
  const source = streaming && props.source.startsWith(paintedSource) ? paintedSource : props.source;
  return <WebuiMarkdownContent {...props} source={source} />;
});
