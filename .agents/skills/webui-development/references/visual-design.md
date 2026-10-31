# Visual implementation and verification

For adding or styling components, start with [Component design system](component-design-system.md): it defines the immediate token choices, scales, reuse recipes and interaction states. This reference covers implementation mechanics and verification. Read `packages/webui/docs/design/design-language.md` and the actual component/CSS for affected details. Existing code contains older aliases and newer semantic-token styles; do not promote incidental legacy declarations into new design rules.

## Optional page context

Ordinary component development does not require loading these screenshots. Consult them when page context or a layout comparison helps; use the component design system to choose styles. If consulting images, open the originals rather than inferring appearance from filenames. These built-client synthetic-fixture captures are 1440 × 900, device scale 1, Chinese locale and reduced motion; they cover only the pictured states.

| Surface | Light | Dark | Use as reference for |
| --- | --- | --- | --- |
| New task | [Home light](visuals/home-light.png) | [Home dark](visuals/home-dark.png) | Quiet rail, welcome anchor, whitespace, composer/workspace grouping |
| Existing conversation | [Conversation light](visuals/conversation-light.png) | [Conversation dark](visuals/conversation-dark.png) | Title, scroll/composer arrangement, progress side panel and density |
| General settings | [Settings light](visuals/settings-light.png) | [Settings dark](visuals/settings-dark.png) | Navigation groups, form rows, cards, switches, theme selector and hierarchy |

Capture provenance is in [capture-manifest.json](visuals/capture-manifest.json). A capture is a dated example, not a pixel contract or an assertion that every existing contrast choice is correct. Synthetic empty model catalogues and disabled controls are fixture states; preserve the real component's enabled behavior. Use screenshots from the user's requested baseline when supplied, and explicitly distinguish them from these fixtures.

## Read the actual design system

Source anchors below are under `packages/webui/`.

| Concern | Source | Implementation guidance |
| --- | --- | --- |
| Primitive ramps, spacing/radius/type scales, semantic states | `src/client/styles/tokens.css` | Use semantic colors for meaning/state; inspect both `.light` and `.dark` values |
| Utility vocabulary and font stacks | `tailwind.config.cjs` | Token utilities coexist with stock numeric utilities; ensure the chosen class actually generates |
| Single stylesheet and global behavior | `src/client/styles/index.css` | Import business CSS here; keep one compiled stylesheet, including KaTeX |
| Frame, shared menus, geometry | `src/client/styles/shell.css`, `src/client/shell/WebuiClientFoundationApp.tsx` | Shell/layout authority is the live assembly, not the mostly transparent `ArchonShell` wrapper |
| Welcome and conversation columns | `src/client/shell/ConversationSurface.tsx` | Home and session are different layouts, not a shared fixed-height mockup |
| Composer | `src/client/features/composer/ui/composer.css` and neighboring TSX | Preserve anchored menus, card, toolbar, queue/permission states and input behavior |
| Settings rows and controls | `features/settings/ui/settings.css`, `SettingsModal.public.tsx`, `settings-atoms.tsx` | Full settings surface has its own navigation; retain selected/disabled states |
| Messages/code/diffs | `features/transcript/ui/transcript.css`, `transcript-widgets.css`, `markdown.public.tsx` | Preserve readable column, line numbers, copy/actions, file refs and math |
| Domain surfaces | `features/{sessions,models,plugins,interactions,workspace,account,goal}/ui/*.css` | Place business styles with that business; use shared primitives for shared behavior |
| Form primitives and icons | `src/client/ui/form-atoms.tsx`, `ToggleSwitch.tsx`, `ContextMenu.tsx`, `shell/icons.tsx`, `@tabler/icons-react` | Reuse the existing Tabler icon vocabulary and control primitives; do not hand-draw interface glyphs or add another icon library |

In rows using abbreviated `features/…`, the full prefix is `src/client/`.

For a general appearance row, the actual `GenericPage`, `Appearance`, `SettingRow`, `Section` and `Divider` are in `SettingsModal.public.tsx`. `settings-atoms.tsx` serves other settings affordances; do not assume similarly named atoms own this row. Theme preference currently uses local React state, injected storage and DOM effects in that component, with `resolveThemePreference` as a pure projection. Follow this specific persistence seam for a local appearance preference; application-owned remote settings are a different workflow. A new local preference does not automatically require a server operation or global owner.

## Visual continuity decisions

- **Hierarchy:** restrained neutral surfaces, a slightly darker rail, quiet borders and separators, rounded controls, sparse accent blue. Use stronger contrast for the primary action and primary text; secondary metadata should recede without disappearing.
- **Layout:** desktop is a two-column frame with collapsible/resizable rail. The observed default rail is 240px at 1440px; treat its actual state/constraints as authority rather than making an “18%” prose description a fixed rule. Home centers a welcome and approximately 743px outer content region; session layout uses its own scroll viewport and optional side panels.
- **Typography:** sans uses HarmonyOS/Segoe UI/SF/system/CJK fallbacks; mono uses Hack/system monospace. No new web-font load is implied. Named sizes include `text-body-base` (14/22px) and `text-caption-base` (12/18px); use the neighbor's established hierarchy rather than shrinking everything to fit.
- **Composer:** large rounded card, soft shadow, low-contrast edge, attachment/permission controls and model/send actions. Disabled and active send states differ; a screenshot's empty-draft button is not the universal color specification.
- **Settings and lists:** group related rows on a shared elevated/grouped surface, keep labels/descriptions aligned, align trailing controls, and maintain consistent row target sizes. Settings pages are not all modals visually merely because the component is named `SettingsModal`.
- **States:** specify focus, hover, press, selected, inactive/disabled, busy, validation/error, empty and success when the control needs them. Availability is rendered from owner/capability outcomes; do not imitate working controls with decorative placeholders.

For a new surface, state which existing surface supplies typography, geometry and controls. If intentional differences are needed, connect each to a user requirement. Visual freedom remains available for a requested redesign; the current system is the default reference, not a ban on change.

## CSS mechanics that matter

Use names such as `bg-bg_default_primary`, `text-text_default_secondary`, `border-border_default`, `rounded-radius_12`, `gap-spacing_8` and `shadow-shadow_default`, or `var(--semantic_token)` inside business CSS. Keep compound/state rules in `@layer components`. Literal geometry is acceptable where the scale has no suitable value; do not invent a parallel color system.

Tailwind scans source literals. Runtime-built classes need full-name maps or a deliberate safelist entry. Test the compiled output: a class present in TSX or CSS input may have been purged. Arbitrary-value utilities can rewrite underscores inside custom-property names; named component CSS is safer for complex token-based shadows. `test/unit/webui-design-tokens.test.ts` checks token closure and named compiled classes.

Cascade changes require comparing effective declarations, including specificity, ordering, media/container context and utilities. A later block is not automatically the winning rule. Keep feature imports in `styles/index.css` in their intended order.

Global thin scrollbars and scoped stable gutters live in `styles/index.css`. Do not apply gutter reservation to all elements: inline SVG's overflow can collapse its paint area. Preserve horizontal-only opt-outs. Use `min-w-0`/`min-h-0` and actual scroll ownership to handle long content, not global overflow hiding.

Respect `prefers-reduced-motion`; shared controls use a quiet short response curve and shell animations reduce under the preference. Existing overlay positioning helpers in `projection/common/` and outside-close bindings are better starting points than another ad hoc window listener. Inspect clipping, viewport edges, stacking and keyboard/focus behavior in the browser.

Markdown is parsed with marked tokens and rendered through React/KaTeX with registered highlight.js languages. Keep math in that pipeline; do not scan the DOM with KaTeX auto-render or import a second stylesheet. Inspect escaping/link/file-reference contracts before touching raw content handling.

## Visual acceptance

Build current CSS/client, then exercise the requested state and inspect screenshots. For affected surfaces compare both themes, ordinary and constrained viewport sizes, long names/content, scrolling, open overlays, focus/keyboard use, disabled/busy/error states and reduced motion as appropriate. Choose a task-relevant matrix rather than requiring every unrelated screen on every change. DOM/SSR asserts content; computed styles and screenshots establish layout/appearance.

For reusable reference captures after a successful `pnpm build:webui`:

```bash
node .agents/skills/webui-development/scripts/capture-visuals.mjs /path/to/minimax-code /path/outside/repository/visual-reference
```

The helper serves only the existing build and repository synthetic fixture on its own ephemeral loopback port, starts its own headless browser, and closes both. It never rebuilds, uses an existing live app, or talks to a real provider. Its static resource serving includes bundled assets/fonts so previews are visible; this is capture tooling, not a replacement for the official guarded browser suite. Review page errors and the manifest. Refresh skill baseline PNGs deliberately, never use snapshot replacement to hide a regression.

New assets require provenance/license review and the source inventory. Prefer current local marks/illustrations in `src/client/assets/`; inspect originals before adapting them. Keep a source→destination filename manifest for added assets per the package guide.
