// The conversation usage notice (U18).
//
// `deriveConversationUsageNotice` had no test at all, and its parameter was
// declared with a local all-optional copy of `WebuiUsageQuotaResult` that
// accepted any object — including one with no `quota` field, which is the field
// the function reads first. The parameter is the wire type now, so this file
// pins what the function does with it: which window earns a notice, which
// action the notice offers, and the precedence between them.
//
// The thresholds are the function's contract, not a snapshot of its arithmetic:
// a window at or over 80% used earns a notice, and an unlimited window never
// does however high its percentage reads.
import { describe, expect, it } from "vitest";

import { deriveConversationUsageNotice } from "../../src/client/features/transcript/projection/message-projection.js";
import type { WebuiUsageQuotaResult } from "../../src/shared/contracts/usage-quota.js";

function signedIn(
  quota: {
    weekly?: { usedPercent?: number; unlimited: boolean; resetAtMs?: number };
    fiveHour?: { usedPercent?: number; unlimited: boolean; resetAtMs?: number };
    video?: { usedCount?: number; totalCount?: number; unlimited: boolean };
  } | undefined,
): WebuiUsageQuotaResult {
  return {
    signedIn: true,
    ...(quota
      ? {
          quota: {
            weekly: quota.weekly ?? { unlimited: true },
            fiveHour: quota.fiveHour ?? { unlimited: true },
            ...(quota.video ? { video: quota.video } : {}),
          },
        }
      : {}),
  };
}

describe("deriveConversationUsageNotice", () => {
  it("stays silent when there is no answer to read", () => {
    expect(deriveConversationUsageNotice(undefined)).toBeNull();
    expect(deriveConversationUsageNotice({ signedIn: false })).toBeNull();
    // Signed in, but the quota half never arrived.
    expect(deriveConversationUsageNotice(signedIn(undefined))).toBeNull();
  });

  it("warns on the weekly window at 80% and offers the plan actions", () => {
    const notice = deriveConversationUsageNotice(
      signedIn({ weekly: { usedPercent: 80, unlimited: false, resetAtMs: 1 } }),
    );
    expect(notice?.kind).toBe("weekly");
    expect(notice?.actions).toEqual(["subscribe_plan", "upgrade_plan"]);
    expect(notice?.resetAtMs).toBe(1);
    expect(notice?.dismissable).toBe(true);
  });

  it("stays silent on the weekly window below 80%", () => {
    expect(
      deriveConversationUsageNotice(
        signedIn({ weekly: { usedPercent: 79, unlimited: false } }),
      ),
    ).toBeNull();
  });

  it("never warns on an unlimited window, however high its percentage reads", () => {
    expect(
      deriveConversationUsageNotice(
        signedIn({ weekly: { usedPercent: 99, unlimited: true } }),
      ),
    ).toBeNull();
  });

  it("warns on the five-hour window and offers credits", () => {
    const notice = deriveConversationUsageNotice(
      signedIn({ fiveHour: { usedPercent: 100, unlimited: false } }),
    );
    expect(notice?.kind).toBe("five_hour");
    expect(notice?.actions).toEqual(["buy_credits"]);
  });

  it("prefers the weekly window when both are over the line", () => {
    const notice = deriveConversationUsageNotice(
      signedIn({
        weekly: { usedPercent: 90, unlimited: false },
        fiveHour: { usedPercent: 95, unlimited: false },
      }),
    );
    expect(notice?.kind).toBe("weekly");
  });

  it("warns on the video quota once nothing is left", () => {
    const spent = deriveConversationUsageNotice(
      signedIn({ video: { usedCount: 5, totalCount: 5, unlimited: false } }),
    );
    expect(spent?.kind).toBe("video");
    expect(spent?.actions).toEqual(["buy_credits"]);

    expect(
      deriveConversationUsageNotice(
        signedIn({ video: { usedCount: 4, totalCount: 5, unlimited: false } }),
      ),
    ).toBeNull();
  });

  it("reports a missing reset time as null rather than dropping the notice", () => {
    const notice = deriveConversationUsageNotice(
      signedIn({ weekly: { usedPercent: 80, unlimited: false } }),
    );
    expect(notice).not.toBeNull();
    expect(notice?.resetAtMs).toBeNull();
  });
});
