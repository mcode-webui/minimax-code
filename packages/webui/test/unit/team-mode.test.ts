import { beforeEach, describe, expect, it } from "vitest";
import { readSessionOverlay, toggleSessionOverlay } from "../../src/client/components/LeftRail.js";
import {
  isTeamModeLocked,
} from "../../src/client/team-mode.js";
import { createWebuiBrowserStorage } from "../../src/client/infrastructure/storage.js";

function createMemoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

beforeEach(() => {
  globalThis.localStorage = createMemoryLocalStorage();
});

describe("team mode lock contract", () => {
  it("locks when team mode is explicitly off or child sessions exist", () => {
    const children = new Map([["with-child", [{ id: "child-1" }]]]);
    const getChildSessions = (id: string) => children.get(id) ?? [];
    expect(
      isTeamModeLocked({ id: "off", teamModeOff: false }, getChildSessions),
    ).toBe(true);
    expect(
      isTeamModeLocked({ id: "with-child", teamModeOff: true }, getChildSessions),
    ).toBe(true);
    expect(
      isTeamModeLocked({ id: "free", teamModeOff: true }, getChildSessions),
    ).toBe(false);
  });

  it("round-trips the create-time choice through mavis-team-mode", () => {
    localStorage.clear();
    const storage = createWebuiBrowserStorage(localStorage);
    expect(storage.readTeamModeOff()).toBe(true);
    storage.writeTeamModeOff(false);
    expect(storage.readTeamModeOff()).toBe(false);
    storage.writeTeamModeOff(true);
    expect(storage.readTeamModeOff()).toBe(true);
  });

  it("round-trips per-session team mode choices through the infrastructure adapter", () => {
    localStorage.clear();
    const storage = createWebuiBrowserStorage(localStorage);
    expect(storage.readTeamModeSessionChoices()).toEqual({});
    storage.writeTeamModeSessionChoice("s1", false);
    expect(storage.readTeamModeSessionChoices()).toEqual({ s1: false });
  });

  it("persists the no-project choice through the infrastructure adapter", () => {
    localStorage.clear();
    const storage = createWebuiBrowserStorage(localStorage);
    expect(storage.readNoProjectFlag()).toBe(false);
    storage.writeNoProjectFlag(true);
    expect(storage.readNoProjectFlag()).toBe(true);
    storage.writeNoProjectFlag(false);
    expect(storage.readNoProjectFlag()).toBe(false);
  });

  it("uses isolated v1 localStorage overlays for session row state", () => {
    localStorage.clear();
    const storage = createWebuiBrowserStorage(localStorage);
    expect(toggleSessionOverlay("stars", "s1", storage)).toEqual({ s1: true });
    expect(toggleSessionOverlay("pins", "s1", storage)).toEqual({ s1: true });
    expect(toggleSessionOverlay("archives", "s1", storage)).toEqual({ s1: true });
    expect(readSessionOverlay("stars", storage)).toEqual({ s1: true });
    expect(toggleSessionOverlay("stars", "s1", storage)).toEqual({});
  });

  it("routes generic preferences through the injected storage adapter", () => {
    const backing = createMemoryLocalStorage();
    const storage = createWebuiBrowserStorage(backing);
    storage.setItem("webui-theme", "dark");
    expect(storage.getItem("webui-theme")).toBe("dark");
    storage.removeItem("webui-theme");
    expect(storage.getItem("webui-theme")).toBeNull();
    const unavailable = createWebuiBrowserStorage(undefined);
    expect(unavailable.getItem("webui-theme")).toBeNull();
    expect(() => unavailable.setItem("webui-theme", "dark")).not.toThrow();
  });
});
