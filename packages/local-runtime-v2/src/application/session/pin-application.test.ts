import { describe, expect, it, vi } from "vitest";
import { PinServiceError } from "../../service/pin/index.js";
import { PinApplication } from "./pin-application.js";

describe("PinApplication", () => {
  it("projects the owned pin roster and forwards ordered references", async () => {
    const getOrder = vi.fn(async () => [{ ref: { type: "agent" as const, id: "a" }, agent: { agentName: "a", displayName: "Agent" } }]);
    const putOrder = vi.fn(async () => [{ ref: { type: "session" as const, id: "s" } }]);
    const application = new PinApplication({ service: { getOrder, putOrder, pinSession: vi.fn() }, publishGlobalEvent: vi.fn() });
    expect(await application.getOrder()).toEqual({ items: [{ itemType: 2, id: "a", agent: { name: "a", displayName: "Agent" } }] });
    expect(await application.putOrder([{ itemType: 1, id: "s" }])).toEqual({ items: [{ itemType: 1, id: "s" }] });
    expect(putOrder).toHaveBeenCalledWith([{ type: "session", id: "s" }]);
  });

  it("publishes a committed pin and maps missing sessions", async () => {
    const pinSession = vi.fn().mockResolvedValueOnce({ items: [{ ref: { type: "session", id: "s" } }] }).mockRejectedValueOnce(new PinServiceError("session-not-found", "missing"));
    const publishGlobalEvent = vi.fn();
    const application = new PinApplication({ service: { getOrder: vi.fn(), putOrder: vi.fn(), pinSession }, publishGlobalEvent });
    expect(await application.pinSession({ sessionId: "s", pinned: true })).toEqual({ success: true, items: [{ itemType: 1, id: "s" }] });
    expect(publishGlobalEvent).toHaveBeenCalledWith({ type: "session.pinned_updated", payload: { sessionId: "s", pinned: true } });
    await expect(application.pinSession({ sessionId: "missing", pinned: true })).rejects.toMatchObject({ status: 404, key: "SESSION_NOT_FOUND" });
  });
});
