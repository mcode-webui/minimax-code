/**
 * The 远程控制 page: the projection and the rendered branches.
 *
 * The page is transcribed from the Desktop's 远程控制 tab, so the wording is asserted here rather
 * than eyeballed: the hero, the subtitle, the three feature rows and their order, the 连接 button,
 * the SSH entry with its accessible name, the two app-store marks and the minimum-version line.
 *
 * The live state is asserted too, because it is the part the Desktop pushes and the WebUI has to
 * get right on its own: a pairing code is shown with the seconds it is still good for, and once
 * that moment has passed the code is not shown at all — a code the server has already forgotten is
 * worse than no code.
 *
 * Rendering goes through `renderToStaticMarkup` — this package has no jsdom.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WebuiRemoteControlSnapshot } from "../../src/client/features/remote-control/application/remote-control-owner.js";
import {
  webuiRemoteControlPanelModel,
  WEBUI_REMOTE_CONTROL_FEATURES,
  WEBUI_REMOTE_CONTROL_MINIMUM_VERSION,
  WEBUI_REMOTE_CONTROL_SUBTITLE,
  WEBUI_REMOTE_CONTROL_TITLE,
} from "../../src/client/features/remote-control/projection/remote-control-panel.js";
import { RemoteControlPanelView } from "../../src/client/features/remote-control/ui/RemoteControlPanel.public.js";

const NOW_MS = 1_700_000_000_000;

function snapshot(overrides: Partial<WebuiRemoteControlSnapshot> = {}): WebuiRemoteControlSnapshot {
  return { status: "ready", link: { phase: "idle" }, loadedAtMs: NOW_MS, ...overrides };
}

function render(view: React.ReactElement): string {
  return renderToStaticMarkup(view);
}

describe("the remote-control page", () => {
  it("carries the Desktop's copy, in the Desktop's order", () => {
    const model = webuiRemoteControlPanelModel(snapshot(), NOW_MS);

    expect(model.title).toBe("用手机连接你的 MiniMax Code");
    expect(model.subtitle).toBe("通过 MiniMax App 访问此电脑，随时随地继续桌面端的任务");
    expect(model.features.map((feature) => feature.text)).toEqual([
      "手机直接接管电脑上复杂任务，无需守在屏幕前。",
      "对话不断线，进度、指令和审批，手机端随时处理。",
      "遛狗、散步、晒太阳，都可以是你的工作场景。",
    ]);
    expect(model.connectLabel).toBe("连接");
    expect(model.sshLabel).toBe("SSH");
    expect(model.sshAriaLabel).toBe("通过 SSH 连接远程服务器");
    expect(model.platformMarks.map((mark) => mark.label)).toEqual(["安卓", "iOS"]);
    expect(model.minimumVersion).toBe("支持移动端 App 4.15.0 及以上版本");
    expect(WEBUI_REMOTE_CONTROL_FEATURES).toHaveLength(3);
    expect(WEBUI_REMOTE_CONTROL_TITLE).toBe(model.title);
    expect(WEBUI_REMOTE_CONTROL_SUBTITLE).toBe(model.subtitle);
    expect(WEBUI_REMOTE_CONTROL_MINIMUM_VERSION).toBe(model.minimumVersion);
  });

  it("renders the hero, the three rows, the button, the SSH entry and the version line", () => {
    const markup = render(
      <RemoteControlPanelView
        snapshot={snapshot()}
        nowMs={NOW_MS}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onResolveUnbind={() => {}}
      />,
    );

    expect(markup).toContain("用手机连接你的 MiniMax Code");
    expect(markup).toContain("通过 MiniMax App 访问此电脑，随时随地继续桌面端的任务");
    for (const feature of WEBUI_REMOTE_CONTROL_FEATURES) {
      expect(markup).toContain(feature.text);
    }
    expect(markup).toContain(">连接<");
    expect(markup).toContain("aria-label=\"通过 SSH 连接远程服务器\"");
    expect(markup).toContain(">SSH<");
    expect(markup).toContain("安卓");
    expect(markup).toContain(">iOS<");
    expect(markup).toContain("支持移动端 App 4.15.0 及以上版本");
    // The two dividers between the three rows.
    expect(markup.match(/aria-hidden="true" class="relative h-0 w-full"/gu)).toHaveLength(2);
  });

  it("marks the SSH entry disabled rather than silent when nothing can open it", () => {
    const markup = render(
      <RemoteControlPanelView
        snapshot={snapshot()}
        nowMs={NOW_MS}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onResolveUnbind={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="remote-control-ssh-entry"');
    expect(markup).toContain('aria-disabled="true"');
  });

  it("shows the pairing code with the seconds it is still good for", () => {
    const model = webuiRemoteControlPanelModel(
      snapshot({
        link: { phase: "pairing", pairingCode: "482913", expiresIn: 60 },
        pairingExpiresAtMs: NOW_MS + 60_000,
      }),
      NOW_MS,
    );

    expect(model.pairingCode).toBe("482913");
    expect(model.pairingExpiresInSeconds).toBe(60);
    expect(model.pairingExpired).toBe(false);

    const markup = render(
      <RemoteControlPanelView
        snapshot={snapshot({
          link: { phase: "pairing", pairingCode: "482913", expiresIn: 60 },
          pairingExpiresAtMs: NOW_MS + 60_000,
        })}
        nowMs={NOW_MS}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onResolveUnbind={() => {}}
      />,
    );
    expect(markup).toContain("482913");
    expect(markup).toContain("60 秒后失效");
  });

  it("drops the pairing code once its moment has passed", () => {
    const model = webuiRemoteControlPanelModel(
      snapshot({
        link: { phase: "pairing", pairingCode: "482913", expiresIn: 60 },
        pairingExpiresAtMs: NOW_MS + 60_000,
      }),
      NOW_MS + 60_001,
    );

    expect(model.pairingExpired).toBe(true);
    expect(model.pairingCode).toBeUndefined();

    const markup = render(
      <RemoteControlPanelView
        snapshot={snapshot({
          link: { phase: "pairing", pairingCode: "482913", expiresIn: 60 },
          pairingExpiresAtMs: NOW_MS + 60_000,
        })}
        nowMs={NOW_MS + 60_001}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onResolveUnbind={() => {}}
      />,
    );
    expect(markup).not.toContain("482913");
  });

  it("shows the linked device once the phone is connected", () => {
    const model = webuiRemoteControlPanelModel(
      snapshot({ link: { phase: "connected", displayName: "贾晓源的手机" } }),
      NOW_MS,
    );

    expect(model.showsConnectedDevice).toBe(true);
    expect(model.connectedDevice).toBe("贾晓源的手机");

    const markup = render(
      <RemoteControlPanelView
        snapshot={snapshot({ link: { phase: "connected", displayName: "贾晓源的手机" } })}
        nowMs={NOW_MS}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onResolveUnbind={() => {}}
      />,
    );
    expect(markup).toContain("贾晓源的手机");
  });

  it("reports the bridge's own failure instead of hiding it", () => {
    const model = webuiRemoteControlPanelModel(
      snapshot({
        status: "error",
        link: { phase: "error", lastError: { code: "unauthorized", message: "配对码已失效" } },
        error: "配对码已失效",
      }),
      NOW_MS,
    );

    expect(model.error).toBe("配对码已失效");
    expect(model.phase).toBe("error");
  });
});
