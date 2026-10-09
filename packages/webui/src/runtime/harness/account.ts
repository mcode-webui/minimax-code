// Account login, quota, daily check-in and usage.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`. These
// capabilities are backed by the assembly's OAuth core, quota and check-in
// clients rather than the harness `cliService`; they wire into the same runtime
// capability group.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";

export function createAccountAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "getUsageQuota" | "getSigninPanel" | "claimSignin" | "beginAccountLogin" | "getAccountLoginStatus" | "cancelAccountLogin" | "signOutAccount" | "getAccountStatus" | "getSessionUsage"> {
  return {
    async getUsageQuota(request) {
      if (!host.getUsageQuota)
        throw new Error("runtime host does not expose the usage quota client");
      return host.getUsageQuota(request ?? {});
    },

    async getSigninPanel() {
      if (!host.getSigninPanel)
        throw new Error("runtime host does not expose the daily check-in client");
      return host.getSigninPanel();
    },

    async claimSignin() {
      if (!host.claimSignin)
        throw new Error("runtime host does not expose the daily check-in client");
      return host.claimSignin();
    },

    async beginAccountLogin() {
      if (!host.beginAccountLogin)
        throw new Error("runtime host does not expose account login");
      return host.beginAccountLogin();
    },

    async getAccountLoginStatus() {
      if (!host.getAccountLoginStatus)
        throw new Error("runtime host does not expose account login");
      return host.getAccountLoginStatus();
    },

    async cancelAccountLogin() {
      if (!host.cancelAccountLogin)
        throw new Error("runtime host does not expose account login");
      await host.cancelAccountLogin();
      return { ok: true as const };
    },

    async signOutAccount() {
      if (!host.signOutAccount)
        throw new Error("runtime host does not expose account sign-out");
      return host.signOutAccount();
    },

    async getAccountStatus(request) {
      return requireCliService(host).getAccountStatus(request);
    },

    async getSessionUsage(request) {
      return requireCliService(host).getSessionUsage(request);
    },
  };
}
