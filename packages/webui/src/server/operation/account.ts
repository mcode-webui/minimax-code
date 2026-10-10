// The account descriptors (plan §7.1 `operation/account.ts`; §7.7 stage 3).
//
// One file for the account domain's request validation: the sign-in panel, the
// claim, sign-out and the device-login flow (split out of `operation/provider.ts`)
// plus the usage quota and account status reads (split out of
// `operation/queue.ts`). `provider.ts` keeps the provider and model descriptors;
// `queue.ts` keeps queue, model selection, skills and session usage.
//
// The descriptors are moved verbatim: only their home changes, so the registry
// order in `operation/operations.ts` — which is observable on the wire — is
// untouched.

import { WebuiErrorCode } from "../../shared/envelope.js";
import type { WebuiOperation } from "./operation-contract.js";
import { validateOptionalObjectBody } from "./common.js";
import {
  BEGIN_ACCOUNT_LOGIN_OPERATION_NAME,
  CANCEL_ACCOUNT_LOGIN_OPERATION_NAME,
  CLAIM_SIGNIN_OPERATION_NAME,
  GET_ACCOUNT_LOGIN_STATUS_OPERATION_NAME,
  GET_ACCOUNT_STATUS_OPERATION_NAME,
  GET_SIGNIN_PANEL_OPERATION_NAME,
  GET_USAGE_QUOTA_OPERATION_NAME,
  SIGN_OUT_OPERATION_NAME,
} from "../../shared/operation-names.js";

const emptyBody = (name: string) => (body: unknown) => {
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
    return { ok: false, code: WebuiErrorCode.invalidBody, message: `${name} body must be an empty object` } as const;
  return { ok: true, body: {} } as const;
};

export const getSigninPanelOperation: WebuiOperation<
  Record<string, never>,
  unknown
> = {
  name: GET_SIGNIN_PANEL_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "getSigninPanel body must be an empty object" };
    return { ok: true, body: {} };
  },
};

export const claimSigninOperation: WebuiOperation<
  Record<string, never>,
  unknown
> = {
  name: CLAIM_SIGNIN_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "claimSignin body must be an empty object" };
    return { ok: true, body: {} };
  },
};

// Account login over the device-authorization flow: `begin` starts (or
// re-attaches to) an attempt and usually answers with the prompt on the
// first reply; `status` is what the dialog polls; `cancel` aborts without
// touching the credential. Bodies are empty on purpose — the login session
// is server-owned, one per service, exactly like the check-in panel.

export const signOutOperation: WebuiOperation<Record<string, never>, { readonly success: true }> = {
  name: SIGN_OUT_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0)
      return { ok: false, code: WebuiErrorCode.invalidBody, message: "signOut body must be an empty object" };
    return { ok: true, body: {} };
  },
};

export const beginAccountLoginOperation: WebuiOperation<
  Record<string, never>,
  import("../../shared/contracts/account.js").WebuiAccountLoginView
> = {
  name: BEGIN_ACCOUNT_LOGIN_OPERATION_NAME,
  validate: emptyBody("beginAccountLogin"),
};

export const getAccountLoginStatusOperation: WebuiOperation<
  Record<string, never>,
  import("../../shared/contracts/account.js").WebuiAccountLoginView
> = {
  name: GET_ACCOUNT_LOGIN_STATUS_OPERATION_NAME,
  validate: emptyBody("getAccountLoginStatus"),
};

export const cancelAccountLoginOperation: WebuiOperation<
  Record<string, never>,
  { readonly ok: true }
> = {
  name: CANCEL_ACCOUNT_LOGIN_OPERATION_NAME,
  validate: emptyBody("cancelAccountLogin"),
};

export const getUsageQuotaOperation: WebuiOperation<
  { readonly forceRefresh?: boolean },
  unknown
> = {
  name: GET_USAGE_QUOTA_OPERATION_NAME,
  validate: (body) => {
    const value = validateOptionalObjectBody(GET_USAGE_QUOTA_OPERATION_NAME, body);
    if (!value.ok) return value;
    if (
      value.body.forceRefresh !== undefined &&
      typeof value.body.forceRefresh !== "boolean"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "forceRefresh must be a boolean",
      };
    return {
      ok: true,
      body: value.body.forceRefresh === true ? { forceRefresh: true } : {},
    };
  },
};

export const getAccountStatusOperation: WebuiOperation<
  { readonly sessionId?: string },
  Record<string, unknown>
> = {
  name: GET_ACCOUNT_STATUS_OPERATION_NAME,
  validate: (body) => {
    const value = validateOptionalObjectBody(
      GET_ACCOUNT_STATUS_OPERATION_NAME,
      body,
    );
    if (!value.ok) return value;
    if (
      value.body.sessionId !== undefined &&
      typeof value.body.sessionId !== "string"
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "sessionId must be a string",
      };
    return {
      ok: true,
      body: value.body.sessionId ? { sessionId: value.body.sessionId } : {},
    };
  },
};
