// The account's own legal documents.
//
// The Desktop's login page closes with "登录即表示你同意 [服务条款] 和 [隐私政策]",
// and both links point at the account's own site. The account scope decides
// the site and the language it publishes its documents in, so the resolver is
// a pure function of the scope — and the browser resolves it from the same
// handshake the credential came with.

import { describe, expect, it } from "vitest";

import { webuiAccountLegalLinks } from "../../src/shared/account-legal-links.js";

describe("the account's legal documents", () => {
  it("names the account's own site and language", () => {
    expect(
      webuiAccountLegalLinks({ region: "cn", buildEnv: "prod" }),
    ).toEqual({
      termsUrl: "https://agent.minimax.cn/doc/zh/terms-of-service.html",
      privacyUrl: "https://agent.minimax.cn/doc/zh/privacy-policy.html",
    });
    expect(
      webuiAccountLegalLinks({ region: "en", buildEnv: "prod" }),
    ).toEqual({
      termsUrl: "https://agent.minimax.io/doc/en/terms-of-service.html",
      privacyUrl: "https://agent.minimax.io/doc/en/privacy-policy.html",
    });
  });

  it("has no documents for a scope it does not know", () => {
    // An unknown scope is not a reason to link a document that does not exist.
    expect(webuiAccountLegalLinks(undefined)).toBeUndefined();
    expect(
      webuiAccountLegalLinks({ region: "cn", buildEnv: "nowhere" }),
    ).toBeUndefined();
  });
});
