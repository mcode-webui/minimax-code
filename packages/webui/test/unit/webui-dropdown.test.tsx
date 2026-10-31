// The shared dropdown skeleton.
//
// What these cases cover: the surface every popup in the client now shares,
// the trigger's wiring to that popup, and the two facts that make the
// behaviour uniform — a press outside closes the popup, and Escape closes it
// and returns the focus to the trigger.
//
// The markup is rendered without a DOM runtime (`renderToStaticMarkup`), so
// the cases here pin what the skeleton *is*; the dismissal itself needs a real
// document and is pinned by the browser suite
// (`packages/webui/test/browser/provider-form.spec.mjs`).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WEBUI_DROPDOWN_EXIT_MS,
  WebuiDropdown,
} from "../../src/client/ui/Dropdown.js";

function render(props: {
  readonly open?: boolean;
  readonly role?: "menu" | "listbox" | "dialog";
  readonly ariaLabel?: string;
  readonly width?: "match" | "content";
}): string {
  return renderToStaticMarkup(
    <WebuiDropdown
      open={props.open ?? true}
      onOpen={() => undefined}
      onClose={() => undefined}
      role={props.role ?? "menu"}
      ariaLabel={props.ariaLabel ?? "测试菜单"}
      width={props.width ?? "content"}
      trigger={(triggerProps) => (
        <button type="button" {...triggerProps}>
          触发器
        </button>
      )}
    >
      <button type="button">菜单项</button>
    </WebuiDropdown>,
  );
}

describe("the shared dropdown surface", () => {
  it("gives the popup the shared surface and the role it was asked for", () => {
    const markup = render({ role: "listbox" });
    expect(markup).toContain("webui-dropdown-popup");
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-label="测试菜单"');
    expect(markup).toContain("菜单项");
  });

  it("carries the exit duration the stylesheet reads", () => {
    // The popup is unmounted when the animation that fades it out has run, so
    // the two numbers have to be the same one.
    expect(render({})).toContain(`--webui-dropdown-exit-duration:${WEBUI_DROPDOWN_EXIT_MS}ms`);
  });

  it("renders no popup while it is closed", () => {
    const markup = render({ open: false });
    expect(markup).not.toContain("webui-dropdown-popup");
    expect(markup).not.toContain("菜单项");
  });

  it("wires the trigger to the popup it owns", () => {
    const markup = render({});
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-haspopup="menu"');
    // The trigger names the popup it controls.
    const controls = /aria-controls="([^"]+)"/.exec(markup)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`id="${controls}"`);
  });

  it("reports a closed dropdown to the trigger as well", () => {
    const markup = render({ open: false });
    expect(markup).toContain('aria-expanded="false"');
  });

  it("marks the wrapper with the state it is in", () => {
    expect(render({})).toContain('data-webui-dropdown="open"');
    expect(render({ open: false })).toContain('data-webui-dropdown="closed"');
  });
});

describe("a popup with no trigger", () => {
  // A list that follows the caret in a textarea, a fly-out that follows the row
  // a pointer is over and a menu that opens at the pointer all have an anchor
  // that is not a button. They are the same skeleton in a different shape:
  // the surface, the motion and the dismissal are the same three things.
  function renderDetached(): string {
    return renderToStaticMarkup(
      <WebuiDropdown
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        role="listbox"
        ariaLabel="提及列表"
      >
        <button type="button">候选项</button>
      </WebuiDropdown>,
    );
  }

  it("renders the popup without a trigger", () => {
    const markup = renderDetached();
    expect(markup).toContain("webui-dropdown-popup");
    expect(markup).toContain("候选项");
    expect(markup).not.toContain("触发器");
  });

  it("gives its wrapper no box of its own, so it takes no room in its parent", () => {
    // `display: contents` keeps the element in the DOM — the dismissal still
    // asks it what it contains — while giving it no box.
    expect(renderDetached()).toContain("webui-dropdown--detached");
  });

  it("announces no expanded state, because there is no trigger to announce it on", () => {
    const markup = renderDetached();
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("aria-controls");
  });
});

describe("the popup's own markers", () => {
  it("carries the data attributes the surface is found by", () => {
    // A surface's marker belongs on the popup, not on the wrapper: the popup
    // is the thing the marker names.
    const markup = renderToStaticMarkup(
      <WebuiDropdown
        open
        onOpen={() => undefined}
        onClose={() => undefined}
        role="dialog"
        popupDataAttributes={{ "data-webui-model-menu": "true", "data-webui-model-tier": "settings" }}
        trigger={(triggerProps) => (
          <button type="button" {...triggerProps}>
            触发器
          </button>
        )}
      >
        <button type="button">条目</button>
      </WebuiDropdown>,
    );

    expect(markup).toContain('data-webui-model-menu="true"');
    expect(markup).toContain('data-webui-model-tier="settings"');
  });
});
