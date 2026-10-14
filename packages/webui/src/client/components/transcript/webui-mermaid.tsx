// webui-mermaid.tsx — Mermaid diagram rendering for the transcript.
//
// SPEC-C's acceptance table carries a "markdown-图表(mmd) 通过" row, but the
// source had zero Mermaid support: a ```mermaid fence fell through to the
// plain code path, so a model-drawn flowchart or sequence diagram arrived as
// an unreadable blob of text. This file closes that row the same way the
// renderer's other two languages already work — katex owns the math fences,
// highlight.js owns the registered code languages, and Mermaid owns its own
// fence word.
//
// Three deliberate choices, all driven by the acceptance contract:
//
//   1. `mermaid` is loaded with a dynamic `import()` and never referenced
//      statically. The package is large, and the transcript shows a Mermaid
//      fence only occasionally, so it must not sit in the main chunk. The
//      import happens on the first fence that actually needs it.
//   2. Rendering is imperative (`mermaid.render`), not declarative
//      (`<pre class="mermaid">` + `mermaid.run`). `run()` swaps the DOM
//      itself and renders its own error box on a bad diagram; `render()`
//      rejects, which is what lets every failure — invalid syntax, an empty
//      body, a thrown render, a hung render — fall back to the plain fence
//      this component would have produced before Mermaid existed.
//   3. The component is split into a pure presentational block
//      (`WebuiMermaidBlock`) and a thin effectful wrapper (`WebuiMermaid`).
//      The webui suite runs in Node with `renderToStaticMarkup`, which never
//      runs effects, so the block carries each state as a plain prop and the
//      wrapper only wires the async render into it. The same split
//      `components/workspace/ReviewSettingsPage.tsx` uses.
//
// Security: the SVG is injected with `dangerouslySetInnerHTML`, as katex and
// highlight.js output already are in `markdown.tsx`. Mermaid is initialised
// with `securityLevel: "strict"`, which is also its default, so the markup it
// returns carries no external references.

import { useEffect, useState, type ReactElement } from "react";

/** The fence language words that select the Mermaid branch, compared lower-cased. */
const MERMAID_FENCE_LANGUAGES = new Set(["mermaid", "mmd"]);

/**
 * How long a single `mermaid.render` may take before the diagram is abandoned
 * for the plain-fence fallback. Generous on purpose: the browser suite renders
 * the real library on CI hardware, and a tight budget turns a slow machine
 * into a red build rather than a diagram.
 */
export const WEBUI_MERMAID_RENDER_TIMEOUT_MS = 10_000;

/**
 * Whether a fence tag names the Mermaid diagram language. The caller passes
 * the fence's first language word (see `codeFenceLanguage` in `markdown.tsx`,
 * which already strips trailing attributes such as `title="a.mmd"`), so a
 * ```mermaid title="a.mmd"``` fence is recognised the same as a bare one.
 * Comparison is case-insensitive because fence tags are conventionally lower
 * case but nothing enforces it.
 */
export function isWebuiMermaidFence(language: string | undefined): boolean {
  return language !== undefined && MERMAID_FENCE_LANGUAGES.has(language.toLowerCase());
}

/** Mermaid is configured once per document; `initialize` is not cheap to repeat. */
let mermaidConfigured = false;

/** Mermaid hands every render a DOM id; a monotonic counter keeps them unique. */
let diagramSequence = 0;

type MermaidModule = typeof import("mermaid");

async function loadMermaid(): Promise<MermaidModule> {
  const module = await import("mermaid");
  if (!mermaidConfigured) {
    // `startOnLoad: false` matters: the default scans the document for
    // `.mermaid` elements on import, which would race the first explicit
    // render. Nothing in this component uses that class, so the scan is
    // disabled outright.
    module.default.initialize({ startOnLoad: false, securityLevel: "strict" });
    mermaidConfigured = true;
  }
  return module;
}

export interface WebuiMermaidRenderOptions {
  /**
   * Override for {@link WEBUI_MERMAID_RENDER_TIMEOUT_MS}. Exists so a test can
   * drive the timeout path with a real clock instead of faking one; production
   * callers never pass it.
   */
  readonly timeoutMs?: number;
}

/**
 * Render one Mermaid diagram body to an SVG string.
 *
 * Rejects — rather than returning a fallback — on every failure so the caller
 * decides what the user sees: an empty body, invalid syntax, a thrown render
 * and a render that outlives the timeout all end here. The empty-body check
 * runs before the dynamic import so an empty fence never pulls the library
 * down the wire.
 */
export async function renderWebuiMermaidSvg(text: string, options?: WebuiMermaidRenderOptions): Promise<string> {
  if (text.trim() === "") throw new Error("webui-mermaid: empty diagram body");
  const mermaid = (await loadMermaid()).default;
  diagramSequence += 1;
  const diagramId = `webui-mermaid-${diagramSequence}`;
  const timeoutMs = options?.timeoutMs ?? WEBUI_MERMAID_RENDER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      mermaid.render(diagramId, text),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`webui-mermaid: render timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return result.svg;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What the fence currently shows. See {@link WebuiMermaidBlock}. */
export type WebuiMermaidState =
  | { readonly status: "pending" }
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "failed" };

export interface WebuiMermaidBlockProps {
  readonly state: WebuiMermaidState;
  /** The fence body, verbatim. */
  readonly text: string;
  /** The fence tag as marked reported it, attributes included. */
  readonly lang: string | undefined;
}

/**
 * The fence's markup for each state, with no effect of its own:
 *
 *   pending — the `webui-mermaid` container holding the raw diagram text. The
 *     container is present from the first paint, so a slow chunk load shows
 *     the source rather than an empty box, and the unit suite can assert the
 *     container without ever running an effect.
 *   rendered — the same container with Mermaid's SVG inside it.
 *   failed — the plain fence, byte for byte: a `webui-code-block` wrapper, a
 *     `pre`, a `code` carrying the original text, and no gutter, because a
 *     Mermaid fence never shows line numbers in any of its states. This is
 *     the markup the fence had before Mermaid existed, minus the gutter.
 */
export function WebuiMermaidBlock({ state, text, lang }: WebuiMermaidBlockProps): ReactElement {
  if (state.status === "rendered") {
    return (
      <div className="webui-mermaid" data-webui-mermaid-state="rendered" dangerouslySetInnerHTML={{ __html: state.svg }} />
    );
  }
  if (state.status === "failed") {
    return (
      <div className="webui-code-block">
        <pre>
          <code data-language={lang}>{text}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="webui-mermaid" data-webui-mermaid-state="pending">
      <pre>{text}</pre>
    </div>
  );
}

export interface WebuiMermaidProps {
  /** The fence body, verbatim. */
  readonly text: string;
  /** The fence tag as marked reported it, attributes included. */
  readonly lang: string | undefined;
}

/**
 * The effectful half: renders the diagram once per body and repaints the block
 * with the outcome. `cancelled` guards the state updates so a fence that
 * unmounts mid-render — a session switch, a trimmed transcript — writes
 * nothing. The dependency is the body alone: a re-render with the same text
 * must not re-run the library.
 */
export function WebuiMermaid({ text, lang }: WebuiMermaidProps): ReactElement {
  const [state, setState] = useState<WebuiMermaidState>({ status: "pending" });
  useEffect(() => {
    let cancelled = false;
    renderWebuiMermaidSvg(text)
      .then((svg) => {
        if (!cancelled) setState({ status: "rendered", svg });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return <WebuiMermaidBlock state={state} text={text} lang={lang} />;
}
