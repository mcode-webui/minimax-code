// The composer's `+` menu stack: the root panel, its skills submenu and its
// plugins submenu.
//
// It was 47 lines inside the `WebuiComposer` render, reading fifteen
// of the component's state cells and refs directly. Those became named props:
// each one is either a field the menu displays or an intent it raises, so the
// menu holds no submission logic of its own and the caret it inserts at stays
// the editor's (the callback focuses the textarea the editor owns).
//
// The stack lives inside the trigger's wrap rather than at the end of the
// composer section. Anchoring it to the `+` button means it always clears that
// button — the old `bottom: 56px` was measured from the composer region, so the
// panel grew over the `+` and the permission pill as soon as the workspace bar
// changed the region's height. The wrap is also the surface's container for
// outside-close, which is why a click inside the composer could not dismiss it.
//
// The wrapper's keyboard handling — Escape closes the stack, the arrows move
// between a submenu and its trigger — belongs to this surface and moved with it.

import { WebuiIconAttach, WebuiIconCommandGoal, WebuiIconCommandPlan, WebuiIconPlugins, WebuiIconSkillGeneric } from "../../../shell/icons.js";
import { IconChevronRight } from "@tabler/icons-react";
import type { WebuiComposerPluginSummary } from "../../../features/plugins/application/composer-catalogue.public.js";
import type { WebuiSlashSkillSummary } from "./slash-palette.js";
import { FeedbackError } from "../../../ui/feedback.js";

export type WebuiComposerMenu = "root" | "skills" | "plugins";

export interface WebuiComposerMenusProps {
  /** The open panel, or `undefined` when the stack is closed. */
  readonly menu: WebuiComposerMenu | undefined;
  readonly onMenuChange: (next: WebuiComposerMenu | undefined) => void;
  readonly skills: readonly WebuiSlashSkillSummary[];
  readonly skillsLoading: boolean;
  readonly skillsError: string | undefined;
  readonly plugins: readonly WebuiComposerPluginSummary[];
  readonly pluginsLoading: boolean;
  readonly pluginsError: string | undefined;
  /** Whether the plugin catalogue answered at all. */
  readonly pluginsAvailable: boolean;
  readonly onOpenPluginManagement?: (area: "plugins" | "skills") => void;
  /** Opens the file picker; the input itself belongs to the composer. */
  readonly onAttach: () => void;
  readonly onGoal: () => void;
  readonly onPlan: () => void;
  /** Raises an insertion at the editor's caret; the editor focuses itself. */
  readonly onInsertSkill: (name: string) => void;
  readonly onInsertPlugin: (name: string) => void;
}

export function WebuiComposerMenus({
  menu,
  onMenuChange,
  skills,
  skillsLoading,
  skillsError,
  plugins,
  pluginsLoading,
  pluginsError,
  pluginsAvailable,
  onOpenPluginManagement,
  onAttach,
  onGoal,
  onPlan,
  onInsertSkill,
  onInsertPlugin,
}: WebuiComposerMenusProps) {
  // The panel is mounted by the shared dropdown, which keeps it mounted for
  // the length of the exit animation. So `menu` may already be `undefined`
  // while the panel is still on screen, fading out: the root panel stays, and
  // the submenu is simply gone. Hovering a panel that is on its way out must
  // not re-open the menu, which is why every handler below checks `menu`.
  return (
    <div
      className="webui-composer-menu-stack"
      data-webui-composer-menu-stack="true"
      data-webui-open-submenu={menu === "root" ? undefined : menu}
      onMouseLeave={() => {
        if (menu && menu !== "root") onMenuChange("root");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onMenuChange(undefined);
        } else if (
          event.key === "ArrowRight" &&
          event.target instanceof Element &&
          event.target.closest<HTMLElement>("[data-webui-composer-submenu-trigger]")
        ) {
          event.preventDefault();
          const submenu = event.target
            .closest<HTMLElement>("[data-webui-composer-submenu-trigger]")
            ?.dataset.webuiComposerSubmenuTrigger;
          const stack = event.currentTarget;
          if (submenu) {
            window.requestAnimationFrame(() =>
              stack
                .querySelector<HTMLElement>(`[data-webui-composer-submenu="${submenu}"] [role="menuitem"]`)
                ?.focus(),
            );
          }
        } else if (
          event.key === "ArrowLeft" &&
          event.target instanceof Element &&
          event.target.closest("[data-webui-composer-submenu]")
        ) {
          event.preventDefault();
          const submenu = event.target
            .closest<HTMLElement>("[data-webui-composer-submenu]")
            ?.dataset.webuiComposerSubmenu;
          onMenuChange("root");
          if (submenu) {
            event.currentTarget
              .querySelector<HTMLElement>(`[data-webui-composer-submenu-trigger="${submenu}"]`)
              ?.focus();
          }
        }
      }}
    >
      <div className="webui-composer-menu" role="menu" aria-label="添加附件或技能" data-webui-composer-menu="root">
        <button type="button" role="menuitem" onMouseEnter={() => { if (menu && menu !== "root") onMenuChange("root"); }} onFocus={() => { if (menu && menu !== "root") onMenuChange("root"); }} onClick={() => { onMenuChange(undefined); onAttach(); }}><WebuiIconAttach className="webui-composer-menu-icon" />添加文件或图片</button>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menu === "skills"} data-webui-composer-submenu-trigger="skills" onMouseEnter={() => onMenuChange("skills")} onFocus={() => onMenuChange("skills")} onClick={() => onMenuChange("skills")}><WebuiIconSkillGeneric className="webui-composer-menu-icon" />技能 <IconChevronRight aria-hidden="true" size={16} stroke={1.7} /></button>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={menu === "plugins"} data-webui-composer-submenu-trigger="plugins" onMouseEnter={() => onMenuChange("plugins")} onFocus={() => onMenuChange("plugins")} onClick={() => onMenuChange("plugins")}><WebuiIconPlugins className="webui-composer-menu-icon" />插件 <IconChevronRight aria-hidden="true" size={16} stroke={1.7} /></button>
        <div role="separator" />
        <button type="button" role="menuitem" onMouseEnter={() => { if (menu && menu !== "root") onMenuChange("root"); }} onFocus={() => { if (menu && menu !== "root") onMenuChange("root"); }} onClick={() => { onMenuChange(undefined); onGoal(); }}><WebuiIconCommandGoal className="webui-composer-menu-icon" />目标</button>
        <button type="button" role="menuitem" onMouseEnter={() => { if (menu && menu !== "root") onMenuChange("root"); }} onFocus={() => { if (menu && menu !== "root") onMenuChange("root"); }} onClick={() => { onMenuChange(undefined); onPlan(); }}><WebuiIconCommandPlan className="webui-composer-menu-icon" />计划</button>
      </div>
      {menu === "skills" ? (
        <div className="webui-composer-menu webui-dropdown-surface" role="menu" aria-label="技能" data-webui-composer-menu="skills" data-webui-composer-submenu="skills">
          {skillsLoading ? <div className="webui-composer-menu-empty">正在加载技能…</div> : skillsError ? <FeedbackError message={skillsError} className="webui-composer-menu-empty" /> : skills.length ? skills.map((skill) => <button key={skill.name} type="button" role="menuitem" onClick={() => { onMenuChange(undefined); onInsertSkill(skill.name); }}>{skill.displayName ?? skill.name}</button>) : <div className="webui-composer-menu-empty">没有已安装的技能</div>}
          <div role="separator" />
          <button type="button" role="menuitem" onClick={() => { onMenuChange(undefined); onOpenPluginManagement?.("skills"); }}>管理技能</button>
          <button type="button" role="menuitem" onClick={() => { onMenuChange(undefined); onOpenPluginManagement?.("skills"); }}>添加技能</button>
        </div>
      ) : menu === "plugins" ? (
        <div className="webui-composer-menu webui-dropdown-surface" role="menu" aria-label="插件" data-webui-composer-menu="plugins" data-webui-composer-submenu="plugins">
          {pluginsLoading ? <div className="webui-composer-menu-empty">正在加载插件…</div> : pluginsError ? <FeedbackError message={pluginsError} className="webui-composer-menu-empty" /> : plugins.length ? plugins.map((plugin) => <button key={plugin.name} type="button" role="menuitem" title={plugin.description} onClick={() => { onMenuChange(undefined); onInsertPlugin(plugin.name); }}>{plugin.displayName}</button>) : <div className="webui-composer-menu-empty">{pluginsAvailable ? "没有已安装的插件" : "插件目录暂不可用"}</div>}
          <div role="separator" />
          <button type="button" role="menuitem" onClick={() => { onMenuChange(undefined); onOpenPluginManagement?.("plugins"); }}>添加插件</button>
        </div>
      ) : null}
    </div>
  );
}
