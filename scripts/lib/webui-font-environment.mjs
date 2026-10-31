// The pinned font environment for the WebUI browser gate.
//
// The visual baselines compare pixels, so the glyph rasterization has to be
// reproducible rather than ambient. A runner's installed fonts are not that:
// the set changes with the CI image, the gate's `playwright install --with-deps`
// pulls a different font package set over time, and the host's fontconfig
// decides whether text is drawn with LCD subpixel fringes or grayscale
// antialiasing. Any of those changes moves thousands of pixels without a
// single line of WebUI source changing.
//
// So the gate does not read the host's fonts. This module writes a fontconfig
// that exposes only the font files committed under
// `packages/webui/test/browser/fonts/`, and the browser is launched with
// `FONTCONFIG_FILE` pointing at it. The result is that the gate draws the
// same glyphs, from the same files, with the same rasterization settings,
// whatever the machine underneath happens to have installed.
//
// The alias list covers the client font stack in
// `packages/webui/tailwind.config.cjs`: every name the CSS asks for is
// redirected to a committed face, so a host font that happens to share a name
// cannot leak into the rendering.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WEBUI_FONT_DIRECTORY = "packages/webui/test/browser/fonts";
export const WEBUI_SANS_FONT = "NotoSansCJKsc-Regular-subset.otf";
export const WEBUI_MONO_FONT = "NotoSansMonoCJKsc-Regular-subset.otf";

/**
 * The CSS font stack the client declares, in order. `sans-serif` and
 * `monospace` are the generic families the stack ends on; the rest are the
 * concrete names that precede them. Each one is aliased to a committed face.
 */
const SANS_ALIASES = [
  "HarmonyOS Sans",
  "Segoe UI",
  "SF Pro Display",
  "-apple-system",
  "BlinkMacSystemFont",
  "Roboto",
  "Oxygen",
  "Ubuntu",
  "Cantarell",
  "Open Sans",
  "Helvetica Neue",
  "sans-serif",
  "HarmonyOS Sans SC",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft Yahei UI",
  "Microsoft Yahei",
  "Source Han Sans CN",
];

const MONO_ALIASES = [
  "Hack",
  "ui-monospace",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "Consolas",
  "HarmonyOS Sans SC",
  "PingFang SC",
  "monospace",
];

const SANS_FAMILY = "Noto Sans CJK SC";
const MONO_FAMILY = "Noto Sans Mono CJK SC";

function alias(family, target) {
  return [
    "  <alias>",
    `    <family>${family}</family>`,
    `    <prefer><family>${target}</family></prefer>`,
    "  </alias>",
  ].join("\n");
}

/**
 * The fontconfig the browser runs under.
 *
 * `rgba=none` selects grayscale antialiasing. LCD subpixel rendering colors
 * the glyph edges, and the fringe color depends on the display's subpixel
 * layout and on the host's fontconfig version, so it is the least portable
 * part of text rendering. Grayscale antialiasing keeps the glyph shapes and
 * drops that dependency.
 */
export function renderFontConfig({ fontDirectory, cacheDirectory }) {
  const aliases = [
    ...SANS_ALIASES.map((family) => alias(family, SANS_FAMILY)),
    ...MONO_ALIASES.map((family) => alias(family, MONO_FAMILY)),
  ];
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    "<fontconfig>",
    `  <dir>${fontDirectory}</dir>`,
    `  <cachedir>${cacheDirectory}</cachedir>`,
    ...aliases,
    "  <match target=\"font\">",
    '    <edit name="antialias" mode="assign"><bool>true</bool></edit>',
    '    <edit name="hinting" mode="assign"><bool>true</bool></edit>',
    '    <edit name="rgba" mode="assign"><const>none</const></edit>',
    "  </match>",
    "</fontconfig>",
    "",
  ].join("\n");
}

/**
 * Writes the fontconfig and returns the environment the browser must run
 * under. The cache directory lives outside the repository so a gate run does
 * not leave build residue in the checkout.
 */
export function prepareFontEnvironment(root, { cacheDirectory }) {
  const fontDirectory = path.join(root, WEBUI_FONT_DIRECTORY);
  const resolvedCache = path.join(cacheDirectory, "fontconfig");
  mkdirSync(resolvedCache, { recursive: true });
  const configPath = path.join(resolvedCache, "fonts.conf");
  writeFileSync(
    configPath,
    renderFontConfig({ fontDirectory, cacheDirectory: resolvedCache }),
  );
  return { env: { FONTCONFIG_FILE: configPath }, configPath, fontDirectory };
}