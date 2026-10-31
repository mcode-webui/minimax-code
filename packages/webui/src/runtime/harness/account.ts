// Account login, quota, daily check-in and usage.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`. These
// capabilities are backed by the assembly's OAuth core, quota and check-in
// clients rather than the harness `cliService`; they wire into the same runtime
// capability group.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService, requireHostSlot } from "./requirements.js";
import { toWebuiRecord } from "./result-conversion.js";

export function createAccountAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<
  WebuiHarnessPort,
  | "getUsageQuota"
  | "getCreditFallback"
  | "setCreditFallback"
  | "listResetCards"
  | "useResetCard"
  | "queryResetCardFlows"
  | "getAccountUsageSummary"
  | "getAccountProfile"
  | "getSigninPanel"
  | "claimSignin"
  | "beginAccountLogin"
  | "getAccountLoginStatus"
  | "cancelAccountLogin"
  | "signOutAccount"
  | "getAccountStatus"
  | "getSessionUsage"
> {
  return {
    async getUsageQuota(request) {
      const getUsageQuota = requireHostSlot(
        host.getUsageQuota,
        "the usage quota client",
      );
      return getUsageQuota.call(host, request ?? {});
    },

    async getCreditFallback() {
      const getCreditFallback = requireHostSlot(
        host.getCreditFallback,
        "the account billing client",
      );
      return getCreditFallback.call(host);
    },

    async setCreditFallback(request) {
      const setCreditFallback = requireHostSlot(
        host.setCreditFallback,
        "the account billing client",
      );
      return setCreditFallback.call(host, request);
    },

    async listResetCards(request) {
      const listResetCards = requireHostSlot(
        host.listResetCards,
        "the account billing client",
      );
      return listResetCards.call(host, request);
    },

    async useResetCard(request) {
      const useResetCard = requireHostSlot(
        host.useResetCard,
        "the account billing client",
      );
      return useResetCard.call(host, request);
    },

    async queryResetCardFlows(request) {
      const queryResetCardFlows = requireHostSlot(
        host.queryResetCardFlows,
        "the account billing client",
      );
      return queryResetCardFlows.call(host, request);
    },

    async getAccountUsageSummary() {
      const getAccountUsageSummary = requireHostSlot(
        host.getAccountUsageSummary,
        "the account usage client",
      );
      return getAccountUsageSummary.call(host);
    },

    async getAccountProfile() {
      const getAccountProfile = requireHostSlot(
        host.getAccountProfile,
        "the account usage client",
      );
      return getAccountProfile.call(host);
    },

    async getSigninPanel() {
      const getSigninPanel = requireHostSlot(
        host.getSigninPanel,
        "the daily check-in client",
      );
      return getSigninPanel.call(host);
    },

    async claimSignin() {
      const claimSignin = requireHostSlot(
        host.claimSignin,
        "the daily check-in client",
      );
      return claimSignin.call(host);
    },

    async beginAccountLogin() {
      const beginAccountLogin = requireHostSlot(host.beginAccountLogin, "account login");
      return beginAccountLogin.call(host);
    },

    async getAccountLoginStatus() {
      const getAccountLoginStatus = requireHostSlot(
        host.getAccountLoginStatus,
        "account login",
      );
      return getAccountLoginStatus.call(host);
    },

    async cancelAccountLogin() {
      const cancelAccountLogin = requireHostSlot(
        host.cancelAccountLogin,
        "account login",
      );
      await cancelAccountLogin.call(host);
      return { ok: true as const };
    },

    async signOutAccount() {
      const signOutAccount = requireHostSlot(host.signOutAccount, "account sign-out");
      return signOutAccount.call(host);
    },

    async getAccountStatus(request) {
      return requireCliService(host).getAccountStatus(request);
    },

    async getSessionUsage(request) {
      return toWebuiRecord(await requireCliService(host).getSessionUsage(request));
    },
  };
}
