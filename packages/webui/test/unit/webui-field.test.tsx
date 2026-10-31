// The field contract (ADR 0028 § Shared contracts, #288).
//
// What a field promises is a wiring claim, and wiring is exactly what a rendered
// string can show: the label points at the control, the description and the error
// are reachable from it, and the error says so with `aria-invalid`. The browser
// check next door covers what a string cannot — that the focus ring is visible
// and the error is announced when it appears.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebuiField, WebuiFormActions, WebuiFormLayout, type FieldControlProps } from "../../src/client/ui/field.js";

const input = (props: FieldControlProps) => createElement("input", { ...props });

function render(field: Parameters<typeof WebuiField>[0]): string {
  return renderToStaticMarkup(createElement(WebuiField, field));
}

describe("the field contract", () => {
  it("associates the label with the control", () => {
    const html = render({ label: "API Key", control: input });
    const controlId = /<input[^>]*\bid="([^"]+)"/u.exec(html)?.[1];
    expect(controlId).toBeTruthy();
    expect(html).toContain(`<label class="webui-field-label" id="`);
    expect(html).toMatch(new RegExp(`for="${controlId}"`, "u"));
  });

  it("makes a description reachable from the control", () => {
    const html = render({ label: "上下文窗口", description: "留空按供应商默认值处理", control: input });
    const describedBy = /aria-describedby="([^"]+)"/u.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("留空按供应商默认值处理");
    // No error, so the control is not marked invalid.
    expect(html).not.toContain("aria-invalid");
  });

  it("marks the control invalid and describes it with the error", () => {
    const html = render({ label: "API Key", description: "必填", error: "请输入 API Key", control: input });
    expect(html).toContain('aria-invalid="true"');
    const describedBy = /aria-describedby="([^"]+)"/u.exec(html)?.[1] ?? "";
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(2);
    // The description comes first: what the field is for, then what is wrong.
    expect(html).toContain(`id="${ids[0]}"`);
    expect(html).toContain(`id="${ids[1]}"`);
    expect(html).toContain('role="alert"');
    expect(html).toContain("请输入 API Key");
  });

  it("expresses the same field as a row and as a stack", () => {
    const stacked = render({ label: "API Key", control: input });
    const row = render({ label: "API Key", arrangement: "row", control: input });
    expect(stacked).toContain('class="webui-field webui-field--gap-compact"');
    expect(row).toContain("webui-field webui-field--gap-compact webui-field--row");
    // Both carry the same wiring: the arrangement is where the four sit, not
    // what they are.
    for (const html of [stacked, row]) expect(html).toContain("webui-field-label");
  });

  it("leaves the control to the caller", () => {
    // The contract supplies ids and ARIA and nothing else: no value, no handler,
    // no validation.
    const html = render({ label: "API Key", control: input });
    expect(html).not.toContain("readonly");
    expect(html).toContain("<input");
  });
});

describe("the form arrangements", () => {
  it("lays several fields out and keeps the actions separate", () => {
    const layout = renderToStaticMarkup(
      createElement(WebuiFormLayout, null, createElement("span", null, "field")),
    );
    const actions = renderToStaticMarkup(
      createElement(WebuiFormActions, null, createElement("button", { type: "button" }, "保存")),
    );
    expect(layout).toContain('class="webui-form"');
    expect(actions).toContain('class="webui-form-actions"');
  });
});
