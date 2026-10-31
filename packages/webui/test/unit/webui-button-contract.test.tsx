import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WebuiButton,
  WebuiButtonLink,
  WebuiIconButton,
  type WebuiButtonSize,
  type WebuiButtonVariant,
} from "../../src/client/ui/button.js";

/* The button contract is a vocabulary, and the two halves of it can drift: a
 * variant the component offers but the stylesheet does not declare renders as
 * an unstyled control, and a stylesheet rule no variant reaches is a rule
 * nothing can rely on. These tests hold the halves together, and they hold
 * the retired appearances gone — the client declared `.webui-button-primary`
 * and `.webui-button-secondary` in one business's stylesheet while four other
 * businesses rendered them, and a gate that watched only two class prefixes
 * let all of that pass. */

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const BUTTON_CSS = repoFile("../../src/client/styles/button.css");

/** Every stylesheet the client ships, so a retired class cannot hide in one. */
const CLIENT_STYLES = (() => {
  const root = fileURLToPath(new URL("../../src/client/", import.meta.url));
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) found.push(full);
    }
  };
  walk(root);
  return found.sort();
})();

const VARIANTS: readonly WebuiButtonVariant[] = [
  "secondary",
  "surface",
  "primary",
  "muted",
  "danger",
  "plain",
  "outline",
  "outline-secondary",
  "outline-highlight",
  "quiet-highlight",
  "quiet-secondary",
  "quiet-subtle",
  "accent",
  "grouped",
];

const SIZES: readonly WebuiButtonSize[] = [
  "regular",
  "compact",
  "header",
  "panel",
  "dialog",
  "inline",
  "inline-dense",
  "inline-tiny",
  "action",
  "pill",
];

describe("the button contract", () => {
  it("declares every class the component renders", () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        const markup = renderToStaticMarkup(
          <WebuiButton variant={variant} size={size}>
            x
          </WebuiButton>,
        );
        const classes = /class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
        expect(classes.length).toBeGreaterThan(0);
        for (const className of classes) {
          expect(BUTTON_CSS, `${className} is rendered but not declared`).toContain(`.${className}`);
        }
      }
    }
  });

  it("renders a button that does not submit by accident", () => {
    const markup = renderToStaticMarkup(<WebuiButton variant="secondary">Save</WebuiButton>);
    expect(markup).toContain('type="button"');
    expect(markup).toContain("webui-mavis-button");
    expect(markup).toContain("webui-mavis-button-gray");
  });

  it("submits when the caller says so", () => {
    const markup = renderToStaticMarkup(
      <WebuiButton variant="primary" type="submit">
        Send
      </WebuiButton>,
    );
    expect(markup).toContain('type="submit"');
  });

  it("keeps the caller's own classes and drops nothing else", () => {
    const markup = renderToStaticMarkup(
      <WebuiButton variant="outline" size="inline" className="webui-own-layout">
        Go
      </WebuiButton>,
    );
    expect(markup).toContain("webui-own-layout");
    expect(markup).toContain("webui-mavis-button-outline");
    expect(markup).toContain("webui-mavis-button-inline");
  });

  it("names an icon-only button", () => {
    const markup = renderToStaticMarkup(
      <WebuiIconButton label="Close">
        <span aria-hidden="true">x</span>
      </WebuiIconButton>,
    );
    expect(markup).toContain('aria-label="Close"');
  });

  it("renders a link that looks like a button as a link", () => {
    const markup = renderToStaticMarkup(
      <WebuiButtonLink variant="grouped" size="pill" href="/docs">
        Docs
      </WebuiButtonLink>,
    );
    expect(markup).toContain("<a ");
    expect(markup).toContain('href="/docs"');
    expect(markup).toContain("webui-mavis-button-grouped");
    expect(markup).toContain("webui-mavis-button-pill");
  });

  it("no longer declares the two appearances one business used to own", () => {
    // `.webui-button-primary` and `.webui-button-secondary` were the accent and
    // the grouped pill, declared in the interactions business's stylesheet and
    // rendered by five businesses. They are the shared contract's now, and no
    // stylesheet declares them any more. The comments that explain the move may
    // still name them, so the rules are what is looked for.
    for (const stylesheet of CLIENT_STYLES) {
      const rules = readFileSync(stylesheet, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
      expect(rules, stylesheet).not.toContain(".webui-button-primary");
      expect(rules, stylesheet).not.toContain(".webui-button-secondary");
    }
  });
});
