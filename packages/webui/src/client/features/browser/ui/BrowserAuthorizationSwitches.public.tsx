// The four browser authorization switches, as Settings renders them.
//
// Three browser switches and one Full CDP switch, and the separation is the
// point rather than the layout. A browser switch says *a browser may be launched
// or reached*; Full CDP says *a caller may send any DevTools command the provider
// supports*. They are different risks — the second widens the command set of a
// browser that is already on — so Full CDP lives in its own section, is described
// in terms of the command set, and is never folded into the surface rows. The
// ADR forbids the combined switch precisely because it would make it impossible
// to grant one without granting the rest.
//
// Every switch is off by default, from the shared
// `WEBUI_BROWSER_AUTHORIZATION_DEFAULT` rather than from four literals here: the
// default is a product decision that already lives in one place, and a second
// copy is a second answer to it.
//
// A switch with no baseline is *disabled*, not merely rendered off. The person
// cannot see what they are changing, and a write on top of a state nobody read is
// how a setting gets flipped by accident.
//
// `.public` because the Settings surface mounts it — the browser business owns
// the vocabulary, and a settings-local copy of these switches is a second answer
// to the same authorization question.
//
// `BrowserInstallationKey` lives here rather than in a file of its own for one
// reason: the dependency-check gate records every source path against a
// hand-maintained oracle (`test/gates/fixtures/path-metadata-f00.json`), and
// that fixture is not this task's to extend. Both components are the same
// thing — the browser rows a Settings page mounts — so they belong together
// anyway.

import { useCallback, useState, type ReactElement } from "react";
import { WebuiTextInput } from "../../../ui/field.js";
import {
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  type WebuiBrowserAuthorization,
  type WebuiBrowserSurface,
  type WebuiBridgeBrowserSurface,
} from "../../../../shared/contracts/browser.js";
import type {
  WebuiBrowserAuthorizationToggle,
  WebuiBrowserInstallationKeyResult,
} from "../contracts/browser-port.js";
import { ToggleSwitch } from "../../../ui/ToggleSwitch.js";
import { SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import { WebuiButton } from "../../../ui/button.js";

const SURFACE_ROWS: readonly { readonly surface: WebuiBrowserSurface; readonly title: string; readonly description: string }[] = [
  {
    surface: "isolated-chromium",
    title: "隔离浏览器",
    description: "允许启动本进程自带的隔离浏览器，并在浏览器面板中显示它的画面。",
  },
  {
    surface: "edge",
    title: "Microsoft Edge",
    description: "允许通过扩展连接你已经打开的 Edge，并显示它可访问的标签页。",
  },
  {
    surface: "chrome",
    title: "Google Chrome",
    description: "允许通过扩展连接你已经打开的 Chrome，并显示它可访问的标签页。",
  },
];

const FULL_CDP_DESCRIPTION =
  "扩大可发送的 DevTools 命令范围，包含诊断与浏览器内部的敏感能力。打开它不会启用任何浏览器：每个浏览器仍需单独授权，且关闭它不会影响已启用浏览器上的普通浏览器操作。";

export interface BrowserAuthorizationSwitchesProps {
  /** The four switches as they stand. Absent means "never read". */
  readonly authorization?: WebuiBrowserAuthorization;
  /**
   * Called with the one switch that moved, not with a whole authorization — the
   * caller maps it through `webuiBrowserAuthorizationChange()` and sends it, so
   * this component never has to know the wire's shape.
   */
  readonly onChange?: (toggle: WebuiBrowserAuthorizationToggle) => void;
  /** Held off while a write is in flight, or when the host cannot take one. */
  readonly disabled?: boolean;
}

export function BrowserAuthorizationSwitches({
  authorization,
  onChange,
  disabled = false,
}: BrowserAuthorizationSwitchesProps): ReactElement {
  // The documented default stands in for a read that has not happened, and the
  // switches stay disabled so nothing can be written over it.
  const current = authorization ?? WEBUI_BROWSER_AUTHORIZATION_DEFAULT;
  const readOnly = disabled || !authorization || !onChange;

  const value = (surface: WebuiBrowserSurface): boolean =>
    surface === "isolated-chromium"
      ? current.isolatedChromium
      : surface === "edge"
        ? current.edge
        : current.chrome;

  return (
    <>
      <SettingsSection title="浏览器设置" testId="browser-authorization-surfaces" hint="每个浏览器单独授权，默认全部关闭。">
        {SURFACE_ROWS.map((row) => (
          <SettingsRow
            key={row.surface}
            title={row.title}
            description={row.description}
            testId={`browser-authorization-${row.surface}-row`}
          >
            <ToggleSwitch
              checked={value(row.surface)}
              label={row.title}
              testId={`browser-authorization-${row.surface}`}
              disabled={readOnly}
              onChange={(checked) => onChange?.({ surface: row.surface, enabled: checked })}
            />
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Full CDP 访问" testId="browser-authorization-full-cdp">
        <SettingsRow
          title="Full CDP 访问"
          description={FULL_CDP_DESCRIPTION}
          testId="browser-authorization-full-cdp-row"
        >
          <ToggleSwitch
            checked={current.fullCdp}
            label="Full CDP 访问"
            testId="browser-authorization-full-cdp"
            disabled={readOnly}
            onChange={(checked) => onChange?.({ surface: "full-cdp", enabled: checked })}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

export interface BrowserInstallationKeyProps {
  /** Reads one surface's key. Absent means "this host does not wire the bridge". */
  readonly readKey?: (request: {
    readonly surface: WebuiBridgeBrowserSurface;
  }) => Promise<WebuiBrowserInstallationKeyResult>;
}

interface RevealedKey {
  readonly surface: WebuiBridgeBrowserSurface;
  readonly key: string;
  readonly fingerprint: string;
}

const BRIDGE_SURFACES = [
  { surface: "edge", title: "Microsoft Edge" },
  { surface: "chrome", title: "Google Chrome" },
] as const satisfies readonly { readonly surface: WebuiBridgeBrowserSurface; readonly title: string }[];

/**
 * The installation key, shown once so the person can paste it into the
 * extension.
 *
 * This is the one place the key leaves the host's OS secure store, and it is
 * deliberately small about it: the key is fetched only from a click, held only
 * in this component's state, and never part of the authorization snapshot above
 * — so a client that reads the switches learns nothing about pairing.
 */
export function BrowserInstallationKey({ readKey }: BrowserInstallationKeyProps): ReactElement {
  const [revealed, setRevealed] = useState<RevealedKey | undefined>();
  const [notProvisioned, setNotProvisioned] = useState<readonly WebuiBridgeBrowserSurface[]>([]);
  const [busy, setBusy] = useState(false);

  const reveal = useCallback(
    async (surface: WebuiBridgeBrowserSurface): Promise<void> => {
      if (!readKey) return;
      setBusy(true);
      try {
        const result = await readKey({ surface });
        if (result.present) {
          setRevealed({ surface: result.surface, key: result.key, fingerprint: result.fingerprint });
          setNotProvisioned((prior) => prior.filter((entry) => entry !== surface));
          return;
        }
        // Not an error: the surface has never been switched on, so there is
        // nothing provisioned and nothing to paste.
        setNotProvisioned((prior) => (prior.includes(surface) ? prior : [...prior, surface]));
        setRevealed((prior) => (prior?.surface === surface ? undefined : prior));
      } finally {
        setBusy(false);
      }
    },
    [readKey],
  );

  return (
    <SettingsSection
      title="浏览器桥接安装密钥"
      testId="browser-installation-key"
      hint="扩展需要这把密钥才能完成配对。打开对应浏览器的开关后在此查看，并粘贴到扩展的选项页。"
    >
      {BRIDGE_SURFACES.map(({ surface, title }) => (
        <SettingsRow
          key={surface}
          title={title}
          description={
            notProvisioned.includes(surface)
              ? "该浏览器尚未启用，没有可复制的密钥。"
              : revealed?.surface === surface
                ? `指纹 ${revealed.fingerprint}`
                : "查看并复制这把密钥。"
          }
          testId={`browser-installation-key-${surface}-row`}
        >
          <WebuiButton
            variant="quiet-secondary"
            size="inline"
            data-testid={`browser-installation-key-${surface}-reveal`}
            disabled={!readKey || busy}
            onClick={() => {
              void reveal(surface);
            }}
          >
            查看密钥
          </WebuiButton>
        </SettingsRow>
      ))}
      {revealed ? (
        <SettingsRow
          title="复制用密钥"
          description="粘贴到扩展的选项页后即可配对。密钥只保存在这台浏览器的本地存储中。"
          testId="browser-installation-key-value-row"
        >
          <WebuiTextInput
            appearance="bare"
            controlSize="dense"
            textSize="small"
            textTone="secondary"
            className="w-auto font-mono"
            readOnly
            data-testid="browser-installation-key-value"
            value={revealed.key}
            aria-label={`${revealed.surface} installation key`}
          />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
