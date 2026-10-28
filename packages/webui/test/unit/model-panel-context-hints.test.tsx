/**
 * `WebuiModelPanel` — the context window row's per-option usage hint.
 *
 * The catalog states, for a model whose windows are not billed equally, which
 * window is the heavier choice (`contextWindowOptionHints: { "1000000":
 * "higher_usage" }`), and the server projection passes the fact through. The
 * panel is where the fact becomes a word the person choosing can read: without
 * it, a 1M window that bills differently reads exactly like a 200K one.
 *
 * No DOM framework is allowed here, so the branches are asserted through
 * `renderToStaticMarkup` — the hint is pure markup, so SSR sees all of it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { WebuiModelPanel } from "../../src/client/features/models/ui/ModelPanel.js";
import type { WebuiModelPickerEntry } from "../../src/client/features/models/contracts/model-view.js";

const HINT = "较高用量";

function renderPanel(model: WebuiModelPickerEntry | undefined): string {
  return renderToStaticMarkup(
    createElement(WebuiModelPanel, {
      model,
      draft: {},
      onOpenList: () => undefined,
      onEffortChange: () => undefined,
      onResetEffort: () => undefined,
      onContextLimitChange: () => undefined,
    }),
  );
}

/** The one context-option button for `value`, as markup. */
function option(html: string, value: number): string {
  const match = html.match(
    new RegExp(
      `<button[^>]*data-webui-model-context-option="${value}"[\\s\\S]*?</button>`,
    ),
  );
  // Not a manufactured testid read: the failure message names the option that
  // did not render, which is the fact under test when it is missing.
  expect(match, `context option ${value} rendered`).toBeTruthy();
  return match![0];
}

const WINDOWS: WebuiModelPickerEntry = {
  providerId: "minimax_api",
  modelId: "MiniMax-M3",
  contextWindowOptions: [128_000, 1_000_000],
};

describe("model panel — the context window's usage hint", () => {
  it("marks the window the catalog calls the heavier choice, and only that one", () => {
    const html = renderPanel({
      ...WINDOWS,
      contextWindowOptionHints: { "1000000": "higher_usage" },
    });

    // The hint rides inside its option, as the class that styles it.
    expect(option(html, 1_000_000)).toContain(
      '<span class="webui-model-panel-context-option-hint">较高用量</span>',
    );
    // The ordinary window keeps stating only its size.
    expect(option(html, 128_000)).not.toContain(HINT);
    // Exactly one hint in the whole panel, whatever the row holds.
    expect(html.match(new RegExp(HINT, "gu"))).toHaveLength(1);
  });

  it("renders no hint for a model whose catalog carries none", () => {
    const html = renderPanel(WINDOWS);

    expect(html).toContain('data-webui-model-context-option="128000"');
    expect(html).toContain('data-webui-model-context-option="1000000"');
    expect(html).not.toContain(HINT);
  });

  it("ignores hint values other than the one the wire contract names", () => {
    // The server projection keeps only `higher_usage` entries; the view type
    // is looser than that, so the panel answers the same filter itself rather
    // than printing a value it has no wording for.
    const html = renderPanel({
      ...WINDOWS,
      contextWindowOptionHints: {
        "128000": "lower_usage",
        "1000000": "higher_usage",
      },
    });

    expect(option(html, 128_000)).not.toContain(HINT);
    expect(option(html, 1_000_000)).toContain(HINT);
  });
});
