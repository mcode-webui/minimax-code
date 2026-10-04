import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiQueuePanel } from "../../src/client/components/QueuePanel.js";
import type { WebuiQueueItem } from "../../src/server/port.js";

function item(over: Partial<WebuiQueueItem> = {}): WebuiQueueItem {
  return {
    itemId: "q1",
    sessionId: "mvs_a",
    status: "queued",
    content: "把测试跑一遍",
    ...over,
  };
}

const render = (
  items: readonly WebuiQueueItem[],
  over: { readonly paused?: boolean; readonly onRemove?: (item: WebuiQueueItem) => void } = {},
) => renderToStaticMarkup(createElement(WebuiQueuePanel, { items, ...over }));

describe("WebuiQueuePanel", () => {
  it("renders nothing when there is nothing queued and nothing paused", () => {
    // An empty box above the composer is worse than no box: it claims the
    // queue exists and is empty, which is a thing the user cannot act on.
    expect(render([])).toBe("");
  });

  it("shows the paused notice on its own when paused with nothing queued", () => {
    // This is the real case: the user hit stop and wants to know the rest of
    // their messages are held, not discarded. There may be no visible items to
    // show, and the notice is then the only thing they can act on.
    const html = render([], { paused: true });
    expect(html).toMatch(/队列已暂停/u);
    // No queue box: there is no queue on screen to be looking at.
    expect(html).not.toMatch(/data-webui-queue="true"/u);
  });

  it("counts the queued messages in its heading", () => {
    const html = render([item(), item({ itemId: "q2" }), item({ itemId: "q3" })]);
    expect(html).toMatch(/排队消息（3）/u);
  });

  it("lists every item, showing its content", () => {
    const html = render([item({ itemId: "q1", content: "第一条" }), item({ itemId: "q2", content: "第二条" })]);
    expect(html).toMatch(/第一条/u);
    expect(html).toMatch(/第二条/u);
    expect(html).toMatch(/data-webui-queue-item="q1"/u);
    expect(html).toMatch(/data-webui-queue-item="q2"/u);
  });

  it("falls back to the item id when the message has no content", () => {
    // A queue entry can outlive the text that made it, and a row with an empty
    // left half gives the reader nothing to identify it by. Asserted on the
    // text: the id is also in a data attribute, so matching the markup would
    // pass whether or not the fallback ever rendered.
    const visible = (html: string) =>
      html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
    expect(visible(render([item({ itemId: "orphan", content: "" })]))).toMatch(/orphan/u);
  });

  it("shows the queue box itself when there is a queue", () => {
    // The paused notice may stand alone, but when there are messages the box
    // around them has to be there and has to be visible: it is what separates
    // the queue from the transcript above it.
    expect(render([item()])).toMatch(/data-webui-queue="true"(?![^>]*hidden)/u);
  });

  it("offers removal on a button that is actually operable", () => {
    // A `disabled` remove button satisfies every other assertion here: the
    // data attribute is still there and the label still reads. What the reader
    // gets is a control that looks like the one they used to be able to use.
    const html = render([item({ itemId: "q1" })], { onRemove: () => undefined });
    const tag = html.match(/<button[^>]*data-webui-remove-queue-item[^>]*>/u)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\bdisabled\b/u);
    expect(tag).not.toMatch(/aria-disabled="true"/u);
  });

  it("offers to remove an item that is still queued", () => {
    const html = render([item({ itemId: "q1" })], { onRemove: () => undefined });
    expect(html).toMatch(/data-webui-remove-queue-item="q1"/u);
    expect(html).toMatch(/移除/u);
  });

  it("does not offer to remove an item that is already running or done", () => {
    // Removing a message the runtime has already started is not a thing the
    // user can mean. The button on such a row would look operable and do
    // nothing, which is the one failure shape worth engineering against.
    const html = render(
      [item({ itemId: "q1", status: "running" }), item({ itemId: "q2", status: "done" })],
      { onRemove: () => undefined },
    );
    expect(html).not.toMatch(/data-webui-remove-queue-item/u);
    // The rows still render: the reader needs to see what is in flight.
    expect(html).toMatch(/data-webui-queue-item="q1"/u);
    expect(html).toMatch(/data-webui-queue-item="q2"/u);
  });

  it("never renders an English string into a Chinese composer", () => {
    // This is the whole reason the panel was pulled out. "Waiting messages"
    // and "Remove" shipped inside an otherwise Chinese composer because no
    // test could reach them: the list lived in component state, and the webui
    // suite runs in a node environment where effects never fire.
    //
    // Checked against the text the reader sees, not the markup: class names
    // and data attributes are English by convention here and asserting on them
    // would fire on `webui-card flex items-center` rather than on anything
    // worth changing.
    const visible = (html: string) =>
      html
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    const html = render([item(), item({ itemId: "q2" })], {
      paused: true,
      onRemove: () => undefined,
    });
    expect(visible(html)).not.toMatch(/[A-Za-z]{2,}/u);
    expect(html).not.toMatch(/Waiting messages/u);
    expect(html).not.toMatch(/>\s*Remove\s*</u);
  });

  it("labels the panel for a screen reader rather than only a bold row", () => {
    // The heading is styled as a strong element and reads as plain text; the
    // region is announced as a list of pending messages or not at all.
    const html = render([item()]);
    expect(html).toMatch(/aria-label="排队消息"/u);
    expect(html).toMatch(/role="list"/u);
  });

  it("keeps the item id reachable even when the text is long", () => {
    // Two entries that start the same way must still be distinguishable to
    // assistive tech and to a reader inspecting the row.
    const html = render([
      item({ itemId: "q1", content: "a very long message that truncates" }),
      item({ itemId: "q2", content: "a very long message that also truncates" }),
    ]);
    expect(html).toMatch(/data-webui-queue-item="q1"/u);
    expect(html).toMatch(/data-webui-queue-item="q2"/u);
  });
});

describe("the composer wiring", () => {
  const composer = readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "client",
      "components",
      "SessionComposer.tsx",
    ),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//gu, "");

  /**
   * These are the four assertions in the file that are not behavioural, and the
   * reason is the same one that let this panel ship untested: the queue list
   * lives in `SessionComposer` state, filled by an effect, and the webui suite
   * runs in `environment: "node"` with no jsdom, so rendering the composer
   * yields an empty queue every time. The panel itself is covered above; what
   * is left is whether the composer still hands it the real state.
   */
  it("hands the panel the live queue", () => {
    expect(composer).toMatch(/items=\{queueItems\}/u);
  });

  it("reports the pause, and only once there is a session to pause", () => {
    // Before a session exists there is no queue, so a paused flag would put a
    // "queue paused" notice above a composer that has nothing queued.
    expect(composer).toMatch(/paused=\{sessionId \? queuePaused : false\}/u);
  });

  it("wires the remove handler through", () => {
    // A missing handler is the quiet version of this bug: the panel renders
    // the button because the type allows an absent `onRemove` to hide it, and
    // the user is back to a message they cannot take back.
    expect(composer).toMatch(
      /onRemove=\{\(item\) => void handleDeleteQueueItem\(item\)\}/u,
    );
  });

  it("no longer carries its own copy of the queue markup", () => {
    // Two renderings of the same panel means two places to translate, and
    // this one is the reason the English survived the first pass.
    expect(composer).not.toMatch(/Waiting messages/u);
    expect(composer).not.toMatch(/>\s*Remove\s*</u);
  });
});
