# Component design system

Read this before adding a WebUI component or changing its appearance. It supplies the immediate choices needed to produce consistent components. Paths below are relative to `packages/webui/`. Current `src/client/styles/tokens.css` defines values; `tailwind.config.cjs` defines available utility mappings. Component recipes below distinguish existing implementations from recommended defaults for new work.

## Design direction

Use restrained neutral surfaces, quiet separators, compact readable text, rounded controls and sparse blue accents. Communicate hierarchy through surface, spacing and text roles. Primary actions use the existing neutral high-contrast treatment; links, selected indicators and switches use accent where their existing recipe does. Adding a component is not an invitation to add a new palette, font, gradient, shadow or icon family. Use the existing Tabler icon library for interface glyphs; do not draw new icons yourself.

For a style modification, retain the component's established size and interaction contract unless the request changes it. For a new component, choose the matching recipe below, then fill its content and behavior. The rules and recipes are the design reference; full-page screenshots are optional context.

## Select colors by purpose

Use semantic tokens in component styles. Primitive ramps such as `gray_500` and `blue_400` define the palette underneath themes; do not use them instead of semantic roles simply because a sampled color looks right. Let `.light`/`.dark` rebind semantics rather than adding per-component theme colors.

| Purpose | CSS token | Tailwind example |
| --- | --- | --- |
| Main canvas/input fill | `--bg_default_primary` | `bg-bg_default_primary` |
| Secondary surface | `--bg_default_secondary` | `bg-bg_default_secondary` |
| Grouped card/surface | `--bg_grouped_secondary` or `--bg_grouped_tertiary` | `bg-bg_grouped_secondary` |
| Floating elevated surface | `--bg_grouped_secondary_elevated` | `bg-bg_grouped_secondary_elevated` |
| Main title/body | `--text_default_primary` | `text-text_default_primary` |
| Description/support text | `--text_default_secondary` | `text-text_default_secondary` |
| Lower emphasis metadata | `--text_default_tertiary` | `text-text_default_tertiary` |
| Accent link/indicator | `--text_default_accent`, `--icon_default_accent` | `text-text_default_accent` |
| Primary/secondary icon | `--icon_default_primary`, `--icon_default_secondary` | `text-icon_default_secondary` |
| Ordinary/subtle separator | `--border_default`, `--border_light` | `border-border_default` |
| Focus/selected outline | `--border_accent` | `border-border_accent` |
| Neutral primary action | `--bg_interaction_primary_default` + `--text_label_primary_default` | `bg-bg_interaction_primary_default text-text_label_primary_default` |
| Secondary action | `--bg_interaction_secondary_default` + `--text_default_primary` | `bg-bg_interaction_secondary_default` |
| Quiet hover/press/selection | `--bg_interaction_tertiary_hover`, `_press`, `_selected` | `hover:bg-bg_interaction_tertiary_hover` |
| Destructive text action | `--text_label_danger_secondary_default` | `text-text_label_danger_secondary_default` |
| Destructive filled action | `--bg_interaction_danger_primary_default` + `--text_label_danger_primary_default` | Match its `_hover`/`_press`/`_inactive` family |
| Error/warning/success surface | `--bg_status_error`, `--bg_status_warning`, `--bg_status_positive` | Pair with corresponding semantic text/icon/border, not color alone |

Choose a background/foreground pair together. Inverted/static text is for the matching contrast surface, not ordinary card labels. Use the same semantic family's state variants; do not darken a hex value manually for hover. Existing `--webui-color-*` aliases and hardcoded legacy declarations are not a second design system to extend.

## Typography and geometry

| Concern | Available scale / preferred starting point |
| --- | --- |
| Fonts | `font-sans` for UI; `font-mono` for code/terminal. Existing HarmonyOS/system/CJK and Hack/system fallbacks remain authoritative |
| Body | `text-body-base`: 14px / 22px; compact form/menu labels often use `--size_14` / `--line_height_20` |
| Caption | `text-caption-base`: 12px / 18px; metadata uses secondary/tertiary text roles |
| Other size tokens | `--size_12/14/16/20/24/32/40/48/64`; use large sizes for actual headings/hero content, not ordinary controls |
| Spacing tokens | `--spacing_0/2/4/6/8/12/16/20/24/32/40/48/64/90/128` |
| Spacing use | 4–8px within an icon/label group; 8–12px between related controls; 12–16px component padding; 20–32px between sections are recommended starting points, adjusted to the existing surface recipe |
| Radius tokens | `--radius_4/8/12/16/20/24/32/full` |
| Radius use | 8px compact controls/inputs; 12px menus/small surfaces; 16–20px larger cards/composer; full for pills/circles. Preserve a reused component's exact recipe |
| Weight | Use existing `font-normal`/`font-medium` utilities (400/500). Baseline `--weight_regular`/`--weight_medium` values contain `px`; do not copy that unit into new `font-weight` rules |
| Icons | Tabler React components from `@tabler/icons-react`; typically 16px inside compact controls. Reuse a matching `WebuiIcon*` wrapper from `src/client/shell/icons.tsx` when available; otherwise import the Tabler glyph directly and size it to the component recipe |

### Interface icons

- Use `@tabler/icons-react`, already included by `packages/webui`. Prefer an existing semantic wrapper from `src/client/shell/icons.tsx` when one matches; otherwise import the appropriate named `Icon*` component directly.
- Do not hand-draw interface glyphs as inline SVG paths, CSS shapes/pseudo-elements, or text characters such as arrows, checks, plus signs and crosses. Replace such glyphs with Tabler components and retain the surrounding accessible name, layout and interaction.
- Keep approved brand marks as their supplied assets. Purpose-built illustrations, data visualizations, progress geometry and animations are not interface glyphs; keep their domain-specific rendering when needed instead of forcing them into an icon component.

Prefer `gap-spacing_8`, `p-spacing_12`, `rounded-radius_8`, `text-body-base` and semantic colors. Stock classes such as `gap-2` and `size-7` are supported too; preserve them in existing recipes. Literal geometry is appropriate when the scale does not describe the required shape. Distinguish documented existing sizes from recommended composition defaults; there is no universal 36px height for every button or 20px radius for every card.

## Component recipes and reuse

| Component | Reuse or inspect | Existing recipe / instruction |
| --- | --- | --- |
| Binary switch | `src/client/ui/ToggleSwitch.tsx`; `.webui-toggle-switch` in settings CSS | Reuse component and its `checked`, `label`, `onChange`, `disabled` contract. Existing track is 40×20px with a sliding thumb; keep `role=switch`, `aria-checked`, accent checked state and visible focus |
| Compact icon action | `src/client/ui/form-atoms.tsx` `IconButton` | 28px hit area, 16px glyph, tertiary→secondary icon hover and disabled opacity. Supply a Tabler React icon component as its child; `IconButton` renders the child directly |
| General settings row | `features/settings/ui/SettingsModal.public.tsx`: `SettingRow`, `Section`, `Divider`, `Button` | Reuse inside its owning module: left title/description, right control, grouped card, inset separators. These helpers are private, not a shared package API |
| Settings action button | `.webui-mavis-button` in `features/settings/ui/settings.css` | Existing 36px height, 80px min-width, radius 8, horizontal padding 12, text 14; neutral gray/primary/danger variants. Inspect effective declarations and state rules |
| Form field | `features/models/ui/ProviderFormPanel.public.tsx` and `.webui-provider-form-field` in `models.css` | Existing input 40px high, radius 8, border-default, canvas fill, horizontal padding 12; label 14/20, gap 8; focus border-accent. Textareas preserve multiline behavior |
| Context menu | `src/client/ui/ContextMenu.tsx`, `.webui-context-menu` in shell CSS | Reuse placement/dismissal semantics. Existing surface width 208px, radius 12, padding 6, rows min-height 30px, gap 8, hover fill and danger/disabled states |
| Help hint | `features/settings/ui/settings-atoms.tsx` `InfoHint`/`SectionHeader` | Settings-owned; matches existing bubble and keyboard focus. Do not import a private settings atom from another business |
| Status/empty/error | Neighboring feature component and semantic status tokens | Preserve text explanation, pending/error distinction and retry ownership; do not rely on a badge color to convey state |

There is no universal public Button/Input/Card library in this baseline. Reuse an existing shared primitive when one exists. Within a business, reuse its private recipe. For a new business-owned control, implement its own semantic-token CSS matching the established recipe rather than importing another business's private CSS class or TSX helper. Extract a shared primitive only when actual reuse justifies it and it can live in `client/ui/` without business dependencies. Do not create a generic component library merely to add one control.

## State contract for interactive controls

| State | Required treatment when applicable |
| --- | --- |
| Default | Semantic foreground/background pair, legible label, stable geometry |
| Hover / press | Corresponding semantic state tokens; keep dimensions stable |
| Keyboard focus | Visible `--border_accent` treatment; existing precedent is a 2px outline with 1–2px offset, or the reused component's inset ring |
| Selected / checked | Visible indicator plus `aria-pressed`, `aria-selected` or `aria-checked` as appropriate; selected is not hover |
| Disabled / unavailable | Native disabled semantics where appropriate, muted/inactive treatment and no active hover; explain unavailable capabilities when the user needs the reason |
| Pending | Prevent duplicate action as required by its command contract; retain label/layout, expose progress; pending is not empty |
| Error | Semantic error treatment, readable message and existing recovery command; preserve input |

Global controls already use a short 120ms response curve and reduced-motion handling in `styles/index.css`. Reuse those defaults rather than introducing decorative movement. Check long labels, shrink/overflow behavior, keyboard navigation and overlays in the actual component.

## Minimal new-control styling example

This illustrates a quiet business-owned action, not a new shared component or a prescription to replace existing controls. Use a native `button type="button"`, an accessible name and the owner's command.

```css
@layer components {
  .webui-example-action {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing_8);
    border: 1px solid var(--border_default);
    border-radius: var(--radius_8);
    padding: var(--spacing_6) var(--spacing_12);
    background: var(--bg_interaction_tertiary_default);
    color: var(--text_default_primary);
    font-size: var(--size_14);
    line-height: var(--line_height_20);
  }
  .webui-example-action:not(:disabled):hover { background: var(--bg_interaction_tertiary_hover); }
  .webui-example-action:not(:disabled):active { background: var(--bg_interaction_tertiary_press); }
  .webui-example-action:focus-visible { outline: 2px solid var(--border_accent); outline-offset: 2px; }
  .webui-example-action:disabled { color: var(--text_default_tertiary); cursor: default; }
}
```

Replace the example name with the owning business/component name. Place CSS in `src/client/features/<business>/ui/<business>.css`, imported through `styles/index.css`. Shared styling belongs in the appropriate existing shared home. Do not add another stylesheet link.

## Completion check

Before delivering a component, be able to name its reused primitive/recipe, semantic foreground/background/state tokens, type/spacing/radius choices, and stylesheet owner. Build to confirm utilities/classes are emitted, then inspect the actual result in light/dark and relevant interaction states. Use `visual-design.md` for compiler/cascade/asset and browser-verification details. Screenshots verify the result; they do not replace these design decisions.
