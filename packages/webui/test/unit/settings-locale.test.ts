// The settings page's two language packs, the lookup that reads them, and the
// settings search that reaches a row by the words on it.
//
// What these tests are for is the two failure modes a language pack has: a
// key one language has and the other does not (a page that shows a raw key in
// one language and a sentence in the other), and a setting nobody can find
// (a row that is on the page but that the search cannot reach). The first is
// a parity question, the second is the defect the language row itself would
// have inherited if the search had stayed a tab-name search.

import { describe, expect, it } from "vitest";
import {
  SETTINGS_COPY_PACKS,
  SETTINGS_LANGUAGE_OPTIONS,
  SETTINGS_LOCALE_STORAGE_KEY,
  resolveSettingsLocale,
  settingsCopyValue,
  settingsText,
} from "../../src/client/features/settings/projection/settings-locale.js";
import {
  DESKTOP_SETTINGS_TABS,
  SETTINGS_GROUPS,
  filterSettingsTabs,
  findSettingsSearchHit,
  settingsGroups,
  settingsTabs,
} from "../../src/client/features/settings/projection/settings-view.js";

describe("the settings language packs", () => {
  it("gives both languages the same keys", () => {
    expect(Object.keys(SETTINGS_COPY_PACKS.en).sort()).toEqual(Object.keys(SETTINGS_COPY_PACKS.zh).sort());
  });

  it("leaves no key empty and no key untranslated", () => {
    for (const [locale, pack] of Object.entries(SETTINGS_COPY_PACKS)) {
      for (const [key, value] of Object.entries(pack)) {
        expect(value, `${locale}/${key} is empty`).toBeTruthy();
        // A value that repeats its own key is a placeholder nobody replaced.
        expect(value, `${locale}/${key} is still a placeholder`).not.toBe(key);
      }
    }
  });

  it("reads a key in the language that was asked for", () => {
    expect(settingsText("zh", "tab.desktop")).toBe("通用");
    expect(settingsText("en", "tab.desktop")).toBe("General");
    expect(settingsText("en", "generic.language.title")).toBe("Language");
  });

  it("falls back to the Chinese text when a language does not carry a key", () => {
    // The English pack without the language key is what a half-finished
    // translation looks like, and the page must read as Chinese rather than
    // showing the reader a raw key.
    const withoutTheLanguageKey = { zh: SETTINGS_COPY_PACKS.zh, en: {} };
    expect(settingsCopyValue("en", "generic.language.title", withoutTheLanguageKey)).toBe("语言");
    expect(settingsCopyValue("en", "generic.language.title")).toBe("Language");
  });

  it("falls back to the key itself when no language carries it", () => {
    // A key nobody has is a bug someone can report. A blank is not.
    expect(settingsCopyValue("en", "no.such.key", { zh: {}, en: {} })).toBe("no.such.key");
  });

  it("fills a placeholder and leaves an unfilled one visible", () => {
    expect(settingsText("en", "generic.themePreviewAlt", { theme: "Light mode" })).toBe("Light mode preview");
    expect(settingsText("zh", "generic.themePreviewAlt", { theme: "浅色模式" })).toBe("浅色模式预览");
    expect(settingsText("en", "generic.themePreviewAlt", {})).toBe("{theme} preview");
  });

  it("reads a stored value as the language it names", () => {
    expect(resolveSettingsLocale("zh")).toBe("zh");
    expect(resolveSettingsLocale("zh-CN")).toBe("zh");
    expect(resolveSettingsLocale("en")).toBe("en");
    expect(resolveSettingsLocale("en-US")).toBe("en");
    // A value that is not a language at all must not blank the page, and it
    // must not read as English either: a user whose storage was written by an
    // older build has no opinion about the language.
    expect(resolveSettingsLocale("")).toBe("zh");
    expect(resolveSettingsLocale(null)).toBe("zh");
    expect(resolveSettingsLocale("fr")).toBe("zh");
  });

  it("keeps the language choice on the key the page already used", () => {
    expect(SETTINGS_LOCALE_STORAGE_KEY).toBe("mavis-locale");
  });

  it("offers the languages in their own language", () => {
    expect(SETTINGS_LANGUAGE_OPTIONS).toEqual([{ value: "zh", label: "中文" }, { value: "en", label: "English" }]);
  });
});

describe("the settings registry under a language", () => {
  it("keeps the registry's own name the base language's name", () => {
    // The registry reads as it always did: the Chinese name is the pack's
    // Chinese text, not a second copy of it.
    expect(DESKTOP_SETTINGS_TABS.find((tab) => tab.key === "desktop")?.label).toBe(SETTINGS_COPY_PACKS.zh["tab.desktop"]);
    expect(SETTINGS_GROUPS.find((group) => group.key === "preferences")?.label).toBe(SETTINGS_COPY_PACKS.zh["group.preferences"]);
  });

  it("names the tabs and the groups in the chosen language", () => {
    expect(settingsTabs("en").find((tab) => tab.key === "desktop")?.label).toBe("General");
    expect(settingsTabs("en").find((tab) => tab.key === "custom-instructions")?.label).toBe("Personalization");
    expect(settingsTabs("zh").find((tab) => tab.key === "desktop")?.label).toBe("通用");
    expect(settingsGroups("en").map((group) => group.label)).toEqual(["Preferences", "Management", "Coding", "Archived"]);
    expect(settingsGroups("zh").map((group) => group.label)).toEqual(["偏好", "管理", "编码", "归档"]);
  });

  it("keeps the tab list itself unchanged by the language", () => {
    expect(settingsTabs("en").map((tab) => tab.key)).toEqual(settingsTabs("zh").map((tab) => tab.key));
    expect(settingsTabs("en").map((tab) => tab.key)).toEqual(DESKTOP_SETTINGS_TABS.map((tab) => tab.key));
  });
});

describe("the settings search", () => {
  it("finds the language row by the words on it", () => {
    // Before this, the search matched tab names only, so 「语言」 matched
    // nothing at all and the settings search answered 「没有匹配的设置」 to the
    // one question it existed to answer.
    expect(filterSettingsTabs("语言").map((tab) => tab.key)).toEqual(["desktop"]);
    expect(filterSettingsTabs("Language").map((tab) => tab.key)).toEqual(["desktop"]);
    // Both packs are searched, so the reader finds the row whichever language
    // the page is currently in.
    expect(filterSettingsTabs("语言", "en").map((tab) => tab.key)).toEqual(["desktop"]);
    expect(filterSettingsTabs("Language", "zh").map((tab) => tab.key)).toEqual(["desktop"]);
  });

  it("says which row a search matched, and which page owns it", () => {
    expect(findSettingsSearchHit("语言")).toEqual({ tabKey: "desktop", copyKey: "generic.language.title" });
    expect(findSettingsSearchHit("Language")).toEqual({ tabKey: "desktop", copyKey: "generic.language.title" });
    expect(findSettingsSearchHit("外观")).toEqual({ tabKey: "desktop", copyKey: "generic.appearance.title" });
    // A query that names a tab rather than a row has no row to point at.
    expect(findSettingsSearchHit("账户")).toBeUndefined();
    expect(findSettingsSearchHit("")).toBeUndefined();
  });

  it("still finds the tabs by their names, and still finds nothing for a name that is not there", () => {
    expect(filterSettingsTabs("账户").map((tab) => tab.key)).toContain("account");
    expect(filterSettingsTabs("个性化").map((tab) => tab.key)).toEqual(["custom-instructions"]);
    expect(filterSettingsTabs("不存在的设置")).toHaveLength(0);
  });

  it("shows every tab when the query is empty", () => {
    expect(filterSettingsTabs("").map((tab) => tab.key)).toEqual(DESKTOP_SETTINGS_TABS.map((tab) => tab.key));
  });
});
