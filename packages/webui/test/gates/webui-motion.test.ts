// Motion foundations (ADR 0028 § Shared contracts, #284).
//
// The inventory gate's own rules, and the one place where CSS and JavaScript
// read the same timing value. None of this needs a browser: the stylesheets and
// the constants are read from disk, which is what makes the check cheap enough
// to run on every change.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareMotion, scanStylesheet } from "../../../../scripts/check-webui-motion.mjs";

const clientRoot = new URL("../../src/client/", import.meta.url);
const motionCss = readFileSync(new URL("styles/motion.css", clientRoot), "utf8");
const dropdownCss = readFileSync(new URL("styles/dropdown.css", clientRoot), "utf8");
const dropdownTsx = readFileSync(new URL("ui/Dropdown.tsx", clientRoot), "utf8");

const inventory = {
  tokens: { feedback: "120ms", surface: "180ms", disclosure: "160ms", loading: "1.2s", popupExit: "120ms" },
  files: {
    "a.css": {
      durations: [{ value: "120ms", family: "feedback" }],
      keyframes: [{ name: "fade-in", family: "surface" }],
    },
  },
};

describe("the motion inventory", () => {
  it("names the four families and the popup exit in tokens", () => {
    for (const family of ["feedback", "surface", "disclosure", "loading"]) {
      expect(motionCss).toMatch(new RegExp(`--webui-motion-duration-${family}:\\s*\\d`, "u"));
      expect(motionCss).toMatch(new RegExp(`\\.webui-motion-${family}\\b`, "u"));
    }
    expect(motionCss).toMatch(/--webui-motion-duration-popup-exit:\s*\d+ms/u);
  });

  it("collapses every duration under the reduced-motion policy", () => {
    const block = motionCss.slice(motionCss.indexOf("prefers-reduced-motion"));
    for (const token of ["feedback", "surface", "disclosure", "loading", "popup-exit"]) {
      expect(block).toContain(`--webui-motion-duration-${token}: 0.01ms`);
    }
  });

  it("fails on a duration the inventory does not know", () => {
    const scanned = { "a.css": scanStylesheet("a{transition:color 175ms linear;}") };
    expect(compareMotion(scanned, inventory)).toContain("a.css: 175ms is not in the motion inventory");
  });

  it("fails on a family entry whose value is not that family's token", () => {
    const scanned = { "a.css": scanStylesheet("a{transition:color 200ms linear;}") };
    expect(compareMotion(scanned, { ...inventory, files: { "a.css": { durations: [{ value: "200ms", family: "feedback" }], keyframes: [] } } })).toEqual([
      "a.css: 200ms claims feedback but that token is 120ms",
    ]);
  });

  it("fails on a distinct effect with no reason, and on an entry that has gone", () => {
    const scanned = { "a.css": scanStylesheet("a{animation:fade-out 400ms linear;}") };
    const problems = compareMotion(scanned, {
      ...inventory,
      files: {
        "a.css": {
          durations: [{ value: "400ms", family: "distinct" }, { value: "120ms", family: "feedback" }],
          keyframes: [{ name: "fade-in", family: "surface" }],
        },
      },
    });
    expect(problems).toContain("a.css: 400ms is recorded as distinct with no reason");
    expect(problems).toContain("a.css: recorded 120ms no longer appears");
    expect(problems).toContain("a.css: recorded @keyframes fade-in no longer appears");
  });
});

describe("the shared popup's timing", () => {
  it("reads one value from JavaScript and CSS", () => {
    const constant = /export const WEBUI_DROPDOWN_EXIT_MS = (\d+);/u.exec(dropdownTsx)?.[1];
    const token = /--webui-motion-duration-popup-exit:\s*(\d+)ms/u.exec(motionCss)?.[1];
    expect(constant, "WEBUI_DROPDOWN_EXIT_MS").toBeTruthy();
    expect(token, "--webui-motion-duration-popup-exit").toBeTruthy();
    expect(constant).toBe(token);
    // the skeleton writes that number into the property the exit animation reads
    expect(dropdownTsx).toContain("--webui-dropdown-exit-duration");
    expect(dropdownCss).toContain("var(--webui-dropdown-exit-duration, var(--webui-motion-duration-popup-exit))");
  });

  it("leaves no raw duration in the shared dropdown stylesheet", () => {
    const { durations } = scanStylesheet(dropdownCss);
    expect(durations, "dropdown.css timed by its own numbers").toEqual([]);
  });

  it("adopts the surface-enter family for its entry", () => {
    expect(dropdownCss).toContain("webui-dropdown-in var(--webui-motion-duration-surface) var(--webui-motion-ease-enter)");
  });
});
