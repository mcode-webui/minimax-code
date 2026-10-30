// The content page frame (ADR 0028 § Shared contracts, #291).
//
// What the frame owns is a markup claim, and the claims are what a rendered
// string can show: the title sits in the header, the actions sit beside it, the
// body carries exactly one scroll boundary, and a page that asks for no scroll
// gets no scrolling element at all.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentPage } from "../../src/client/ui/content-page.js";

const render = (props: Parameters<typeof ContentPage>[0]) => renderToStaticMarkup(createElement(ContentPage, props));

describe("the content page frame", () => {
  it("puts the title in the header and the actions beside it", () => {
    const html = render({
      title: "定时任务",
      actions: createElement("button", { type: "button" }, "刷新"),
      children: createElement("p", null, "body"),
    });
    const header = /<header[^>]*>([\s\S]*?)<\/header>/u.exec(html)?.[1] ?? "";
    expect(header).toContain("<h1");
    expect(header).toContain("定时任务");
    expect(header).toContain("刷新");
    // The title comes first: the reading order is the visual order.
    expect(header.indexOf("定时任务")).toBeLessThan(header.indexOf("刷新"));
  });

  it("gives the body exactly one scroll boundary", () => {
    const html = render({ title: "SSH", children: createElement("p", null, "body") });
    const scrollers = html.match(/overflow-y-auto/gu) ?? [];
    expect(scrollers).toHaveLength(1);
    expect(html).toContain("webui-rail-scroll");
  });

  it("leaves the scroll to the page when the page asks for none", () => {
    const html = render({ title: "终端", scroll: false, children: createElement("p", null, "body") });
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("webui-rail-scroll");
  });

  it("passes the page's own markers through without reading them", () => {
    const html = render({
      title: "SSH",
      testId: "ssh-panel",
      ariaLabel: "SSH",
      dataAttributes: { "data-webui-component": "ssh-panel" },
      children: null,
    });
    expect(html).toContain('data-testid="ssh-panel"');
    expect(html).toContain('data-webui-component="ssh-panel"');
    expect(html).toContain('aria-label="SSH"');
  });

  it("renders no action region when the page has no actions", () => {
    const html = render({ title: "SSH", children: null });
    const header = /<header[^>]*>([\s\S]*?)<\/header>/u.exec(html)?.[1] ?? "";
    expect(header).not.toContain("<div");
  });
});
