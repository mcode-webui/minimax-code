# Rendering surfaces

How a displayed thing in this client gets produced, and how to change it without creating a second
definition of something that already exists. The contracts themselves are repository documents:
`packages/webui/docs/client/transcript-rendering.md` (settlement, workspace media, file references,
fences, gutter, math) and `packages/webui/docs/client/ownership.md` (history handoff, retry, the
settlement owner). This reference carries the procedure, the seams and the traps those documents do not
state.

Read it when the request is a display affordance — an icon per file type, an inline image or video, a
link that should render itself, a row that shows its kind — rather than a new runtime capability. For a
whole surface ported from Desktop, `desktop-to-webui-port` is the workflow; for a structural split of
the module doing the rendering, [module-refactor.md](module-refactor.md).

## The change is almost always a projection

The data already crosses the transport. The job is: find the seam, decide once, install once, prove it.
Re-inventing a data path, or repeating a decision per call site, is the failure this reference exists to
prevent. Paths below are relative to `packages/webui/src/client/`.

| Need | Seam |
| --- | --- |
| Decide whether a file is image/video/audio | `features/workspace/projection/media-preview.ts` (`mediaKind`, `isMediaContent`) |
| Serve a workspace file's bytes | `workspacePort.workspaceFileUrl({ workspaceDir, path })` from `features/workspace/contracts/workspace-port.ts`; never build a fetch route or a base64 bridge for a file the panel can already open |
| URL builder inside the transcript | `WebuiWorkspaceFileUrlProvider` in `features/transcript/ui/markdown.public.tsx`, mounted once at the transcript root by `SessionTranscript` |
| Render media for a path | `WebuiFileMedia` → `WebuiMessageFileMedia` (`markdown.public.tsx`), kind by `webuiInlineMediaKind` |
| Per-file glyph | `FILE_TYPE_ICONS` in `shell/icons.tsx`, read through `WebuiIconFileForName({ fileName })` |
| File reference in prose | `fileReferenceAnchor` + `parseWebuiMessageFileReference` (`markdown.public.tsx`) |
| Files the reply produced | delivered-asset rows in `features/transcript/ui/AssistantBody.tsx` |

**Decide once, in one exported helper.** A mapping belongs in a module-level table behind one named
function with a stated fallback (`WebuiIconFileForName` falls back to `IconFile`; `webuiInlineMediaKind`
returns nothing for a non-media path). Call sites call the helper; they never carry their own
`.endsWith(".png")`. Decide by basename and extension, never by a substring of the path —
`src/png-notes.ts` is not an image and `v1.2/README` has no extension.

**Install once, then enumerate the surfaces.** `WebuiIconDiffFile` delegates to the same table, so diff
cards, stat rows and the tab strip pick a new mapping up for free. Media has two independently rendered
surfaces, and both matter: `fileReferenceAnchor` (a reference in the prose) and `AssistantBody`'s
delivered-asset row (`li.webui-delivered-asset`) — the reply's own file list, which is what a screenshot
of a reply usually shows. One `WebuiFileMedia({ path })` serves both; wiring only the prose path leaves
the more common surface unchanged. Threading a prop through six `<WebuiMarkdown>` call sites instead of
mounting the provider once is the wrong shape.

**Degrade instead of failing.** An absent builder renders the old link-only behaviour; a failed load
drops the preview and keeps the link. The bounded retry and its marker (`webui-file-media-attempt`) are
the transcript document's contract — do not add a second retry policy in a caller, and do not replace
the retry with a latched `failed` flag: a reply names its file before the write lands, so the first
request legitimately 404s, and a latched flag hides the picture until the page reloads.

## Identify the surface before diagnosing the feature

A report that inline media "does not work" usually names one surface out of several. In a live page, ask
the anchor what it is:

```js
anchor.closest('[data-webui-markdown]')     // prose reference
anchor.closest('.webui-delivered-asset')    // the reply's file row
```

Guessing from a screenshot sends the fix to a renderer that was never involved.

## Prove a silent degrade

When a component returns `null` by design, the DOM cannot distinguish "did not render" from "rendered
nothing". Add a temporary marker instead of reasoning about it:

1. `<span data-webui-media-skipped={build ? "no-url" : "no-builder"} hidden />` on the early return.
2. `pnpm build:webui`, navigate cache-busted (see [verification.md](verification.md)).
3. Count `document.querySelectorAll('[data-webui-media-skipped]')` in the page, read the attribute.
4. Remove the marker and rebuild — never leave it in.

Cheap and decisive too: a zero-width `<img>` plus a manual `fetch(src)` from the page. Status 200 with
the right content type means the URL seam is fine and the fault is in the element (hooks, attributes,
layout), not in the host capability.

## Fixture limits for rendering specs

The browser fixture's fake host serves workspace bytes only where a test intercepts them. Intercept in
the spec instead of extending the fixture server, and vary the answer per attempt to reproduce a load
race:

```js
await page.route("**/workspace-file?*", (route) =>
  route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG }));
```

Assert on the element (`toBeVisible`, `naturalWidth`, bounding box), not on the wrapper: a wrapper
around an unloaded `<img>` looks like success in a DOM query. A transient 404 then 200 is the real
production race, not a fixture defect.

## Announced states

A state that heals itself in under a second — reconnecting, retrying, resubscribing — renders nothing:
a notice for it appears on every page load and every tab wake, then leaves before the reader decides
anything. Terminal states keep their notice and their action. When asked to drop such a notice, drop it
from every surface in the same pass (inline region, toast, transcript placeholder) and rewrite the tests
to assert silence rather than deleting the assertions. Announcement channels belong to the `Feedback*`
family — a hand-written `role="status"` is drift the feedback gate reports.

SSR is blind to this whole category: a toast created in `useEffect` never appears in
`renderToStaticMarkup`, so its copy and test id belong in a browser spec.
