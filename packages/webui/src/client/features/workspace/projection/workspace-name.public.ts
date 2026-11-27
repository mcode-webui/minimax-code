// The workspace business's display rule, published.
//
// The last path segment is what names a project, and the fallback copy for
// "nothing chosen yet" is Chinese product copy, not a UI string this layer
// invents.
//
// This module is `.public` because two other businesses need the rule: the
// sessions rail labels a project with it and the composer's project row labels
// a folder with it. Neither owns the concept, so neither may re-derive it, and
// the derivation lives here where the business that owns it can keep changing
// it. The `.public` suffix changes nothing about what the module is — the
// classifier strips it, so this is still `projection/`, still the same rule.

import { basenamePath } from "../../../projection/common/paths.js";

/**
 * A project displays its last path segment, the root itself when it has no
 * segment, or "未选项目" when nothing is chosen.
 */
export function workspaceProjectName(workspaceDir?: string): string {
  const value = workspaceDir?.trim();
  return value ? basenamePath(value) : "未选项目";
}
