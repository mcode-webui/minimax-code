import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WebuiErrorBoundary,
  WebuiErrorBoundaryFallback,
} from "../../src/client/shell/WebuiErrorBoundary.js";
import { describeWebuiBoundaryError } from "../../src/client/features/shell/application/boundary-error.js";

/**
 * The webui suite runs in the `node` environment with no DOM, and React does
 * not run error boundaries during `renderToStaticMarkup` — the lifecycle is
 * client-only. So these tests drive the class's real contract directly:
 * `getDerivedStateFromError` for the state transition, `componentDidCatch`
 * for the console hand-off, and the caught instance's own `render` for the
 * markup. That covers every branch the boundary owns without asserting on
 * React internals.
 */
function caughtBoundary(error: unknown, children = createElement("span", null, "child")) {
  const instance = new WebuiErrorBoundary({ children });
  instance.state = WebuiErrorBoundary.getDerivedStateFromError(error);
  return instance;
}

describe("describeWebuiBoundaryError", () => {
  it("passes an Error through unchanged so the original identity survives", () => {
    const error = new Error("render exploded");
    expect(describeWebuiBoundaryError(error)).toBe(error);
  });

  it("normalises a non-Error throw instead of failing again while reporting it", () => {
    expect(describeWebuiBoundaryError("stringly thrown").message).toBe("stringly thrown");
    expect(describeWebuiBoundaryError(undefined).message).toBe("undefined");
    expect(describeWebuiBoundaryError({ code: 7 }).message).toBe("[object Object]");
  });
});

describe("WebuiErrorBoundary", () => {
  it("starts with no error and renders its children", () => {
    const instance = new WebuiErrorBoundary({ children: createElement("span", null, "healthy") });
    expect(instance.state.error).toBeUndefined();
    expect(renderToStaticMarkup(<>{instance.render()}</>)).toContain("healthy");
  });

  it("records the thrown cause on the derived state", () => {
    const error = new Error("render exploded");
    expect(WebuiErrorBoundary.getDerivedStateFromError(error).error).toBe(error);
  });

  it("swaps the subtree for a recoverable surface that still names the cause", () => {
    const instance = caughtBoundary(new Error("render exploded"));
    const markup = renderToStaticMarkup(<>{instance.render()}</>);
    expect(markup).toContain('data-testid="webui-error-boundary"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("render exploded");
    expect(markup).toContain('data-testid="webui-error-boundary-retry"');
    // The healthy child is gone: the boundary replaced it rather than
    // rendering the broken tree alongside the error message.
    expect(markup).not.toContain("healthy");
    expect(markup).not.toContain("child");
  });

  it("restores the subtree once the retry action clears the caught error", () => {
    const instance = caughtBoundary(new Error("render exploded"), createElement("span", null, "recovered"));
    const setState = vi.spyOn(instance, "setState").mockImplementation(() => undefined);
    instance.resetErrorBoundary();
    expect(setState).toHaveBeenCalledWith({ error: undefined });
    setState.mockRestore();
    // With the error cleared the boundary is a pass-through again.
    const healthy = new WebuiErrorBoundary({ children: createElement("span", null, "recovered") });
    expect(renderToStaticMarkup(<>{healthy.render()}</>)).toContain("recovered");
  });

  it("runs the host reset hook alongside the retry so a host can re-fetch", () => {
    const onReset = vi.fn();
    const instance = new WebuiErrorBoundary({ children: createElement("span"), onReset });
    vi.spyOn(instance, "setState").mockImplementation(() => undefined);
    instance.resetErrorBoundary();
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("does not swallow the error: it reaches the console with its component stack", () => {
    const error = new Error("render exploded");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    caughtBoundary(error).componentDidCatch(error, { componentStack: "\n    in Boom\n" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [prefix, reported, stack] = consoleError.mock.calls[0] ?? [];
    expect(prefix).toBe("[webui] uncaught render error:");
    expect(reported).toBe(error);
    expect(stack).toContain("in Boom");
    consoleError.mockRestore();
  });

  it("reports a non-Error throw on the same console path", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    new WebuiErrorBoundary({ children: createElement("span") })
      .componentDidCatch("plain string", { componentStack: null });
    expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    consoleError.mockRestore();
  });

  it("carries the host's copy overrides into the recoverable surface", () => {
    const instance = new WebuiErrorBoundary({
      children: createElement("span"),
      title: "自定义标题",
      detail: "自定义说明",
      retryLabel: "重新加载",
    });
    instance.state = WebuiErrorBoundary.getDerivedStateFromError(new Error("x"));
    const markup = renderToStaticMarkup(<>{instance.render()}</>);
    expect(markup).toContain("自定义标题");
    expect(markup).toContain("自定义说明");
    expect(markup).toContain("重新加载");
  });
});

describe("WebuiErrorBoundaryFallback", () => {
  it("defaults to the WebUI zh copy", () => {
    const markup = renderToStaticMarkup(
      <WebuiErrorBoundaryFallback error={new Error("原因")} onRetry={() => undefined} />,
    );
    expect(markup).toContain("界面出现错误");
    expect(markup).toContain("可以重试恢复");
    expect(markup).toContain("原因");
    expect(markup).toContain("重试");
  });
});

describe("V08 · a zone failure is recoverable without losing the app", () => {
  it("holds the throw in one zone while its siblings keep rendering", () => {
    // React does not run boundaries under `renderToStaticMarkup`, so the zone's
    // guarantee is driven at the level the zone owns: the boundary catches, and
    // the region outside it is a separate tree that never sees the throw. What
    // distinguishes this from a root boundary is the *scope* — which is exactly
    // what the composition asserts.
    const failed = caughtBoundary(new Error("workspace panel exploded"));
    const zone = renderToStaticMarkup(<>{failed.render()}</>);

    expect(zone).toContain("webui-error-boundary");
    expect(zone).toContain("workspace panel exploded");
    // A sibling zone is a different boundary instance with no error, so it
    // renders its own children rather than the fallback.
    const sibling = new WebuiErrorBoundary({ children: createElement("span", null, "composer") });
    expect(sibling.state.error).toBeUndefined();
    expect(renderToStaticMarkup(<>{sibling.render()}</>)).toContain("composer");
    expect(renderToStaticMarkup(<>{sibling.render()}</>)).not.toContain("webui-error-boundary");
  });

  it("renders the zone's own copy, so a broken panel names itself", () => {
    const instance = new WebuiErrorBoundary({
      children: createElement("span", null, "workspace"),
      title: "工作区面板出现错误",
      detail: "工作区面板未能正常显示。应用已保留其余状态，可以重试恢复。",
      presentation: "panel",
    });
    instance.state = WebuiErrorBoundary.getDerivedStateFromError(new Error("boom"));
    const markup = renderToStaticMarkup(<>{instance.render()}</>);
    expect(markup).toContain("工作区面板出现错误");
    expect(markup).toContain("boom");
  });

  it("keeps a zone fallback inside its region instead of taking the screen", () => {
    // The root fallback is `min-h-screen`. Inside a column, that pushes the rest
    // of the app off the viewport — recovering from one panel by losing sight of
    // the others is not recovery — so the zone presentation drops it.
    const panel = new WebuiErrorBoundary({
      children: createElement("span", null, "workspace"),
      presentation: "panel",
    });
    panel.state = WebuiErrorBoundary.getDerivedStateFromError(new Error("boom"));
    const page = new WebuiErrorBoundary({ children: createElement("span", null, "app") });
    page.state = WebuiErrorBoundary.getDerivedStateFromError(new Error("boom"));

    expect(renderToStaticMarkup(<>{panel.render()}</>)).not.toContain("min-h-screen");
    expect(renderToStaticMarkup(<>{page.render()}</>)).toContain("min-h-screen");
  });

  it("recovers a zone by retrying it, running the zone's own reset", () => {
    const onReset = vi.fn();
    const instance = new WebuiErrorBoundary({
      children: createElement("span", null, "workspace"),
      onReset,
    });
    instance.state = WebuiErrorBoundary.getDerivedStateFromError(new Error("boom"));

    const setState = vi.spyOn(instance, "setState").mockImplementation(() => undefined);
    instance.resetErrorBoundary();

    expect(setState).toHaveBeenCalledWith({ error: undefined });
    expect(onReset).toHaveBeenCalledTimes(1);
    setState.mockRestore();
    // With the error cleared the zone is a pass-through again: the children mount
    // once more, which is what re-establishes their effects.
    instance.state = { error: undefined };
    expect(renderToStaticMarkup(<>{instance.render()}</>)).toContain("workspace");
  });
});
