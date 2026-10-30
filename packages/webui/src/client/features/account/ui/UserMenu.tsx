// The rail's account menu and the shell around its two panels.
//
// This file is what is left after the check-in panel and the quota popover moved out: the menu button,
// the popover's four items, the account/usage/check-in snapshot reads, and the effect that loads
// the account when the menu opens.
//
// **The open/closed flags and the mutual exclusion stay here**: `loadUsage` opens
// usage and closes check-in (and `loadSignin` the reverse), every close — the outside pointer,
// Escape, or the trigger — takes both panels down together,
// and each fly-out closes after its complete hover region is left. The panels load on hover,
// focus or click — never on mount — and this file keeps those handlers. Each panel owns only its own
// presentation.
//
// The menu's own surface is the shared dropdown skeleton: it owns the popup's placement, its
// motion and its dismissal, so the outside-pointer and Escape listeners this file used to carry
// are gone. What is left here is the open state and the two panels.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { IconCalendarEvent, IconChevronRight, IconSettings, IconUserCircle } from "@tabler/icons-react";
import { WebuiIconBell, WebuiIconCommandUsage } from "../../../shell/icons.js";
import { SigninClaimResult } from "@mavis/shared/daily-signin";
import { SettingsModal } from "../../settings/ui/SettingsModal.public.js";
import { AccountLoginDialog } from "./AccountLoginDialog.js";
import type { MemoryHandoff } from "../../settings/contracts/memory-handoff.js";
import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useWebuiAccountWorkflows, useWebuiAccountWorkflowsState } from "../bindings/use-account-workflows.public.js";
import { SIGNIN, SigninCard, formatSigninError, type SigninState } from "./UserMenuSignin.js";
import { UsagePanel, type UsageState } from "./UserMenuUsage.js";

type AccountStatus = Record<string, unknown>;

interface UserMenuProps {
  readonly collapsed: boolean;
  readonly hostLabel?: string;
  readonly dataDir?: string;
  readonly version?: WebuiVersionInfo;
  readonly sessionId?: string;
  /** Forwarded to the settings modal so the code-review page knows which
   *  workspace to read a change set from. */
  readonly workspaceDir?: string;
  /** Forwarded to the settings modal. The review page turns a diff line into
   *  a real editor jump through it. */
  readonly onOpenFileLine?: (path: string, line: number) => void;
  /** Forwarded to the settings modal, which owns 记忆摘要's 「在会话中创建」.
   *  The menu neither interprets nor stores it. */
  readonly onCreateMemorySession?: (input: MemoryHandoff) => void;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function accountString(account: AccountStatus | undefined, key: string): string | undefined {
  const candidates = [
    account?.[key],
    objectValue(account?.account)?.[key],
    objectValue(account?.user)?.[key],
    objectValue(account?.profile)?.[key],
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

function SigninGlyph(): ReactElement {
  return <IconCalendarEvent aria-hidden="true" size={18} stroke={1.7} />;
}

function AccountGlyph(): ReactElement {
  return <IconUserCircle aria-hidden="true" size={18} stroke={1.7} />;
}

function UserMenuAvatar({
  avatarUrl,
  displayName,
  compact = false,
}: {
  readonly avatarUrl?: string;
  readonly displayName: string;
  readonly compact?: boolean;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const initial = Array.from(displayName.trim())[0]?.toUpperCase() || "M";
  return (
    <span
      className={`webui-user-menu-avatar ${compact ? "webui-user-menu-avatar-compact" : ""}`}
      aria-hidden="true"
    >
      {avatarUrl && !failed
        ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <span>{initial}</span>}
    </span>
  );
}

function Chevron(): ReactElement {
  return <IconChevronRight className="webui-user-menu-chevron" size={16} stroke={1.7} aria-hidden="true" />;
}

function MenuDivider(): ReactElement {
  return <div className="webui-user-menu-divider" role="separator" />;
}

/* ------------------------------------------------------------------ *
 * Daily check-in card — the card's DOM, classes and copy, with inline svgs.
 * ------------------------------------------------------------------ */

/** Info circle beside the card title, size 14. */

export function UserMenu({
  collapsed,
  hostLabel,
  dataDir,
  sessionId,
  version,
  workspaceDir,
  onOpenFileLine,
  onCreateMemorySession,
}: UserMenuProps): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  // The account, usage, check-in and login answers all come from the one
  // application owner. This component submits commands and reads the snapshot;
  // it holds no transport method for them.
  const accountWorkflows = useWebuiAccountWorkflows();
  const accountSnapshot = useWebuiAccountWorkflowsState();
  // The settings modal is the menu's own state, so the menu is also the only
  // thing that can dismiss it. Handing the memory to a conversation moves the
  // user off this surface entirely; leaving the modal parked over the home
  // composer would hide the very composer the hand-off just filled.
  const handleCreateMemorySession = useCallback((input: MemoryHandoff) => {
    setSettingsOpen(false);
    onCreateMemorySession?.(input);
  }, [onCreateMemorySession]);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [signinOpen, setSigninOpen] = useState(false);
  const panelCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [animatedDay, setAnimatedDay] = useState<number | null>(null);
  // Derived from the one owner's snapshot rather than held locally: the menu
  // and the login dialog read the same answer, and neither writes it.
  const account: AccountStatus | undefined = accountSnapshot.account.value;
  const usage: UsageState =
    accountSnapshot.usage.status === "ready"
      ? { status: "ready", result: accountSnapshot.usage.result }
      : accountSnapshot.usage.status === "error"
        ? { status: "error", errorMessage: accountSnapshot.usage.error }
        : { status: accountSnapshot.usage.status };
  const signin: SigninState = {
    loading: accountSnapshot.signin.loading,
    claiming: accountSnapshot.signin.claiming,
    ...(accountSnapshot.signin.panel ? { panel: accountSnapshot.signin.panel } : {}),
    // The owner stores the raw failure; the two copy strings are the menu's,
    // exactly as they were when the menu owned the request.
    ...(accountSnapshot.signin.error !== undefined
      ? { error: formatSigninError(accountSnapshot.signin.error) }
      : {}),
  };
  // The claim result drives the day animation once per claim. The owner keeps
  // the result; the menu only turns it into the animation's day number.
  const claimedDay =
    accountSnapshot.signin.claim?.claim_result === SigninClaimResult.Claimed
      ? accountSnapshot.signin.claim.day_no
      : undefined;
  useEffect(() => {
    if (claimedDay === undefined) return;
    setAnimatedDay(claimedDay);
  }, [claimedDay]);

  const closePanels = () => {
    if (panelCloseTimer.current !== undefined) {
      clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = undefined;
    }
    setUsageOpen(false);
    setSigninOpen(false);
  };

  const cancelPanelClose = () => {
    if (panelCloseTimer.current === undefined) return;
    clearTimeout(panelCloseTimer.current);
    panelCloseTimer.current = undefined;
  };

  const schedulePanelClose = () => {
    cancelPanelClose();
    // The fly-outs have a deliberate visual gap. Keep the panel alive while
    // the pointer crosses it, then close after the whole hover region is left.
    panelCloseTimer.current = setTimeout(() => {
      panelCloseTimer.current = undefined;
      setUsageOpen(false);
      setSigninOpen(false);
    }, 180);
  };

  useEffect(() => () => cancelPanelClose(), []);

  useEffect(() => {
    if (!open) return;
    void accountWorkflows?.loadAccount(sessionId);
  }, [accountWorkflows, open, sessionId]);

  useEffect(() => {
    if (accountSnapshot.profile.status !== "idle") return;
    void accountWorkflows?.loadAccountProfile();
  }, [accountWorkflows, accountSnapshot.profile.status]);

  const loadUsage = (forceRefresh = false) => {
    setUsageOpen(true);
    setSigninOpen(false);
    void accountWorkflows?.loadUsage(forceRefresh);
  };

  const loadSignin = () => {
    setSigninOpen(true);
    setUsageOpen(false);
    void accountWorkflows?.loadSigninPanel();
  };

  const claim = () => {
    void accountWorkflows?.claimSignin();
  };

  const profile = accountSnapshot.profile.profile;
  const nickname =
    profile?.userName?.trim() ||
    accountString(account, "userName")?.trim() ||
    accountString(account, "nickname")?.trim() ||
    accountString(account, "name")?.trim() ||
    "MiniMax Code";
  const avatarUrl = profile?.avatarUrl?.trim() || profile?.defaultAvatarUrl?.trim();
  const plan = accountString(account, "plan") ?? accountString(account, "planName") ?? (hostLabel ? `本地 · ${hostLabel}` : "本地");
  const identity = objectValue(account?.identity);
  const auth = objectValue(account?.auth);
  const uid =
    accountString(account, "uid") ??
    accountString(account, "userId") ??
    accountString(account, "id") ??
    accountString(identity, "uid") ??
    accountString(identity, "realUserID") ??
    accountString(auth, "realUserID");

  const portalTarget = dom.portalTarget();
  return <>
    <div className={`webui-user-menu-anchor ${collapsed ? "webui-user-menu-anchor-collapsed" : ""}`} data-webui-rail-identity="true">
      <WebuiDropdown
        open={open}
        onOpen={() => { setOpen(true); closePanels(); }}
        onClose={() => { setOpen(false); closePanels(); }}
        // Managed (ADR 0028 § Overlay coordination): the account menu is a layer
        // in the client's order, so one Escape closes it and nothing beneath it,
        // and the popup keeps no listener of its own. `closePanels` still runs on
        // every close, which is the semantics this menu always had.
        managed
        managedLayerId="user-menu"
        role="menu"
        side="top"
        align="start"
        className="webui-user-menu-popover"
        trigger={(triggerProps) => {
          // Every trigger prop is spread onto the button: they are all DOM
          // attributes, or the ref the skeleton focuses when Escape closes
          // the menu.
          const buttonProps = triggerProps;
          return collapsed
            ? <button type="button" {...buttonProps} className="webui-user-menu-trigger-rail" data-testid="sidebar-user-menu-trigger-rail" aria-label="打开用户菜单">
                <UserMenuAvatar avatarUrl={avatarUrl} displayName={nickname} compact />
              </button>
            : <button type="button" {...buttonProps} className="webui-user-menu-trigger" data-testid="sidebar-user-menu-trigger">
                {/* The row's own text names the trigger. An `aria-label` that
                  * restates the nickname and the plan joins two adjacent spans
                  * with a space the markup does not have, and the rule compares
                  * the visible text as a substring of the name — so the content
                  * is the name, and the decorative parts are hidden. */}
                <span aria-hidden="true"><UserMenuAvatar avatarUrl={avatarUrl} displayName={nickname} /></span>
                <span className="webui-user-menu-identity"><span>{nickname}</span><small>{plan}</small></span>
                <span className="webui-user-menu-bell" aria-hidden="true"><WebuiIconBell /></span>
              </button>;
        }}
      >
        <div className="webui-user-menu-uid" aria-label="用户 ID">UID : {uid ?? "—"}</div>
        <div className="webui-user-menu-list">
          <button type="button" className="webui-user-menu-item" role="menuitem" data-testid="user-menu-settings" onClick={() => { setOpen(false); setSettingsOpen(true); }}><IconSettings aria-hidden="true" size={18} stroke={1.7} /><span>设置</span><span className="webui-user-menu-shortcut">Ctrl+,</span></button>
          <button type="button" className="webui-user-menu-item" role="menuitem" data-testid="user-menu-account-login" onClick={() => { setOpen(false); setLoginOpen(true); }}><AccountGlyph /><span>账号与登录</span></button>
          <MenuDivider />
          <div className="webui-user-menu-signin-anchor" onMouseEnter={() => { cancelPanelClose(); loadSignin(); }} onMouseLeave={schedulePanelClose} onFocus={() => { cancelPanelClose(); loadSignin(); }} onClick={(event) => { event.stopPropagation(); if (!signinOpen) loadSignin(); }}>
            <button type="button" className="webui-user-menu-item" role="menuitem" aria-haspopup="dialog" aria-expanded={signinOpen} data-testid="user-menu-signin"><SigninGlyph /><span>每日签到</span><Chevron /></button>
            {signinOpen ? (
              <div className="webui-user-menu-signin-panel" role="dialog" aria-label={SIGNIN.title}>
                <SigninCard
                  panel={signin.panel}
                  loading={signin.loading}
                  claiming={signin.claiming}
                  error={signin.error}
                  animatedDay={animatedDay}
                  onClaim={claim}
                  onRetry={loadSignin}
                  onNavigateToUsage={() => {
                    setSigninOpen(false);
                    loadUsage();
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="webui-user-menu-usage-anchor" onMouseEnter={() => { cancelPanelClose(); loadUsage(); }} onMouseLeave={schedulePanelClose} onFocus={() => { cancelPanelClose(); loadUsage(); }}>
            <button type="button" className="webui-user-menu-item" role="menuitem" aria-haspopup="dialog" aria-expanded={usageOpen} data-testid="user-menu-usage" onClick={() => loadUsage()}><WebuiIconCommandUsage /><span>用量</span><Chevron /></button>
            {usageOpen ? <UsagePanel state={usage} onRetry={() => loadUsage(true)} onLogin={() => { setOpen(false); setLoginOpen(true); }} /> : null}
          </div>
        </div>
      </WebuiDropdown>
    </div>
    <AccountLoginDialog
      open={loginOpen}
      onClose={() => setLoginOpen(false)}
      onAuthenticated={() => {
        loadUsage(true);
        void accountWorkflows?.loadAccountProfile();
      }}
    />
    {portalTarget ? createPortal(<SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dataDir={dataDir} version={version} sessionId={sessionId} workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} {...(onCreateMemorySession ? { onCreateMemorySession: handleCreateMemorySession } : {})} />, portalTarget) : <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dataDir={dataDir} version={version} sessionId={sessionId} workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} {...(onCreateMemorySession ? { onCreateMemorySession: handleCreateMemorySession } : {})} />}
  </>;
}
