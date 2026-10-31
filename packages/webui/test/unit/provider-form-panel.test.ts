// The provider form's lifecycle conditions, pinned where they can go red.
//
// The split moved a branch's JSX into `features/models/ui/ProviderFormPanel.tsx`
// (now published as `ProviderFormPanel.public.tsx`). What must stay
// *unchanged* is not the file layout but the lifetime: every one of its conditions is a fact about
// which module holds a declaration, so each is asserted against the source, where moving it back
// turns the case red:
//
//   * the panel renders inside the same `sourceTab === "custom"` conditional it occupied;
//   * the session-keyed preload effect stays in the parent, still keyed on `[sessionId]`;
//   * the parent keeps its quota clock, and the Codex OAuth poll is the Account owner's: the
//     surface acquires an interest, the owner owns the timer;
//   * the provider drafts survive a sub-tab switch — they live in the Models provider editor,
//     which the parent hosts above the `sourceTab === "custom"` conditional;
//   * `ProviderPresetPicker` still resets on unmount (it lives inside the form's conditional).
//
// The drafts editor's counterpart (the picker's two regions) is pinned by the picker's own suites.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLIENT = new URL("../../src/client/features/", import.meta.url);
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, CLIENT)), "utf8");

const parent = read("settings/ui/UsageModelSettings.tsx");
const accountOwner = readFileSync(
  fileURLToPath(
    new URL("../../src/client/features/account/application/account-workflows.ts", import.meta.url),
  ),
  "utf8",
);
const panel = read("models/ui/ProviderFormPanel.public.tsx");

/** The slice from one marker to the next, so an assertion cannot be satisfied from elsewhere. */
const between = (text: string, from: string, to: string): string =>
  text.slice(text.indexOf(from), text.indexOf(to));

describe("the parent keeps the lifetime", () => {
  it("LC-2 keeps the session-keyed preload in the parent", () => {
    const effect = between(parent, "useEffect(() => {", "}, [sessionId]);");
    expect(effect).toContain("account?.loadUsage()");
    // The credential-status reads belong to the Account owner.
    expect(effect).toContain("account?.loadApiKeyStatus()");
    expect(effect).toContain("models?.loadProviders()");
    expect(effect).toContain("settings?.loadModelSource()");
    expect(effect).toContain("account?.loadCodexOAuthStatus()");
    expect(parent).toContain("}, [sessionId]);");
    // and NOT in the panel: a panel-side preload would run per mount
    expect(panel).not.toContain("loadProviders()");
    expect(panel).not.toContain("useEffect(");
  });

  it("LC-3 keeps the quota clock in the parent and the OAuth poll in its owner", () => {
    expect(parent).toContain("setInterval(() => setQuotaClock(Date.now()), 1000)");
    expect(parent).toContain("clearInterval(timer)");
    // The surface asks the owner for the poll instead of running its own timer,
    // and releases it on unmount.
    expect(parent).toContain("return account.acquireCodexOAuthPolling();");
    expect(parent).not.toContain("setInterval(() => { void settings.loadCodexOAuthStatus(); }, 1000)");
    // The timer itself lives in the Account owner, with its own cleanup.
    expect(accountOwner).toContain("setInterval(");
    expect(accountOwner).toContain("clearInterval(codexPollTimer)");
    expect(panel).not.toContain("setInterval(");
  });

  it("LC-4 keeps the drafts alive across a sub-tab switch, in the editor the parent hosts", () => {
    // The drafts are not the panel's, and they survive a sub-tab switch — but they are the Models
    // editor's, and what makes them survive is that the parent hosts the *instance* above the
    // conditional. Hoisting the hook below it, or calling it twice, turns this red.
    // Anchored on the branch's own testid, not on the quoted conditional: the hook's own
    // comment names that conditional, so a slice from its first occurrence would stop above it.
    expect(parent.indexOf("useWebuiProviderEditor(")).toBeLessThan(
      parent.indexOf('data-testid="settings-custom-models-panel"'),
    );
    expect(parent.match(/useWebuiProviderEditor\(/gu) ?? []).toHaveLength(1);
    expect(parent).toContain("editor={editor}");
    expect(parent).toContain("snapshot={providerEditorSnapshot}");
    // Neither module declares a draft field: the panel reads the snapshot and the parent hosts it.
    expect(panel).not.toMatch(/const \[draft[A-Z]/u);
  });

  it("LC-1 renders the panel in the branch it occupied, and only there", () => {
    // Anchored on the branch's own testid: `sourceTab === "custom"` also appears in the tab
    // button's className, and a slice from there would assert about the wrong region.
    // From the branch's own testid to the end of the module: `</section> : null}` closes the
    // token-plan branch first, so slicing to the FIRST one of those would assert about that one.
    const branch = parent.slice(parent.indexOf('data-testid="settings-custom-models-panel"'));
    expect(branch).toContain("<ProviderFormPanel");
    expect(parent.match(/<ProviderFormPanel/gu) ?? []).toHaveLength(1);
    // The OAuth surface is `settings`', so it stayed in the parent, after the panel.
    expect(branch.indexOf("<ProviderFormPanel")).toBeLessThan(branch.indexOf("Codex OAuth"));
  });
});

describe("the form carries every model field", () => {
  it("gives every model its own row instead of one field for the whole form", () => {
    const form = between(panel, "webui-provider-form-body", "webui-provider-form-actions");
    expect(form).toContain("webui-provider-form-models");
    expect(form).toContain("editor.addModel()");
    expect(form).toContain("editor.removeModel(");
    expect(form).toContain("editor.changeModel(");
    expect(form).toContain("editor.testModel(");
    // Picking another preset drops the models the previous one carried.
    expect(form).toContain("editor.clearModels()");
    // The API format is a choice among the formats the runtime accepts, and it
    // is a dropdown like every other one in the client.
    expect(form).toContain("webui-provider-format-menu");
    // The dropdown is named by the field's own label, and the trigger
    // names itself by that label plus the value it shows; the format's own
    // name reaches the dropdown through the shared contract's `ariaLabel`.
    expect(form).toContain('ariaLabel="API 格式"');
    expect(form).toContain("aria-labelledby={`${field.labelId} ${valueId}`}");
    expect(form).toContain("WebuiDropdown");
  });

  it("carries the limits, the reasoning levels and the attachments", () => {
    expect(panel).toContain("上下文窗口");
    expect(panel).toContain("最大输出 Token");
    expect(panel).toContain("推理等级");
    expect(panel).toContain("支持的附件");
    expect(panel).toContain("WEBUI_MODEL_ATTACHMENT_MODALITIES");
    // The textarea of ids is gone: one id belongs to one row now.
    expect(panel).not.toContain("modelIdText");
    expect(panel).not.toContain("<textarea");
  });
});

describe("the panel keeps the reset boundary", () => {
  it("LC-6 keeps ProviderPresetPicker inside the form's conditional", () => {
    // Its `open`/`query` reset when the enclosing subtree unmounts, which is today's behaviour.
    // Hoisting the picker out of `{!editingProvider ? … : null}`, or out of the dialog, would make
    // its state survive a close and the case goes red.
    const form = between(panel, "webui-provider-form-body", "webui-provider-form-actions");
    expect(form).toContain("{!editingProvider ?");
    expect(form.indexOf("ProviderPresetPicker")).toBeGreaterThan(form.indexOf("{!editingProvider ?"));
    // The dialog itself is still conditional on `showProviderForm`, and still a portal.
    expect(panel).toContain("{showProviderForm && portalTarget ? createPortal(");
    expect(panel).toContain("function ProviderPresetPicker(");
  });

  it("invokes the provider commands it is handed, and owns none of them", () => {
    expect(panel).toContain("commands.setProviderModelEnabled(");
    expect(panel).toContain("commands.reorderProviderModels(");
    // Intent, never a replacement array: an array built from rendered props is
    // exactly what could resurrect a list the owner had already changed.
    expect(panel).not.toContain("commands.patchProviderModels(");
    expect(panel).not.toContain("toModelInputs(");
    // The draft's write/test/delete commands are the editor's, so the panel no longer
    // names them: it calls the editor, and the editor is what sends them.
    expect(panel).not.toContain("commands.saveCandidate(");
    expect(panel).not.toContain("commands.testCandidate(");
    expect(panel).not.toContain("commands.deleteProvider(");
    expect(panel).toContain("editor.save()");
    expect(panel).toContain("editor.test()");
    expect(panel).toContain("editor.remove()");
    expect(panel).not.toContain("useWebuiSettingsWorkflows");
    expect(panel).not.toContain("application/");
  });
});
