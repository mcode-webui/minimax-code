# Account data: quota, membership, credits, daily sign-in

Everything the account surfaces need from MiniMax's own APIs, and the traps that make the numbers wrong.
It exists because the same data reaches the client through several endpoints with opposite conventions,
and because the credential path is not the one the CLI leaves on disk.

The WebUI's projection is `src/runtime/usage-quota-projection.ts` with types in
`src/shared/contracts/usage-quota.ts`; the surfaces are `features/account/ui/{UserMenuUsage,UserMenuSignin,ConversationUsageBanner}.tsx`
behind `features/account/contracts/account-port.ts`. The TUI is the reference implementation of the
gateway: `packages/tui/src/account/matrix-account-client.ts` (endpoints, caching, 401 handling) and
`packages/tui/src/checkin/http-gateway.ts`. Read those before inventing a client.

## The credential path is a lease, not the CLI's token

The bearer under `<dataDir>/cli-auth/` is rejected by these endpoints (401, body `"cookie is missing"` or
`"invalid api key"`). Mint a lease per request with `@mavis/oauth-core`, which is what the launcher does,
composed directly rather than through `packages/tui`:

```ts
const ns = createAuthNamespace({ dataDir, buildEnv, region });
const core = new MCodeOAuthCore({
  namespace: ns,
  credentialStore: createCredentialStore({ authHome: ns.namespaceHome }),
  oauthClient: new HttpOAuthClient(resolveMCodeOAuthEndpointConfig(process.env, { buildEnv, region })),
  initialize: () => migrateLegacyAuthNamespace(ns),
});
const lease = await core.getAccessToken({ requiredScopes: MCODE_OAUTH_SCOPES, minValidityMs: 30_000 });
```

Construction is lazy — no I/O until `getAccessToken` — so it is safe to build at assembly time while
signed out. A throw from `getAccessToken` means signed out or refresh failed: render the signed-out state,
not an error. Never print the lease; report key names and paths only.

Region routing comes from `resolveMCodeOAuthEndpointConfig` (`cn` + `prod` resolves to
`https://www.minimaxi.com`). Do not hardcode a host.

## Endpoints and their conventions

| Endpoint | Gives | Trap |
| --- | --- | --- |
| `GET /backend/account/token_plan/remains_percent` | 5-hour, weekly and video windows | `current_interval_used_percent` is the **used** percentage (`"96%"` means 96% consumed) |
| `GET /v1/api/openplatform/coding_plan/remains` | the same windows | `remaining_percent` is what is **left** — the opposite direction. Mixing the two flips every number |
| `GET /matrix/api/v1/commerce/get_membership_info` | membership, `hasTokenPlan`, credit summary | pass the workspace `op_group_id` as `X-Group-Id` on quota requests when present |
| `GET /matrix/api/v1/user/get_user_extra_info` | `op_group_id`, `has_token_plan`, `token_plan_tier`, `opcredit_balance` | the fallback when membership is unavailable |

- Quota responses are cached 5 s, membership 30 s in the TUI client; mirror those TTLs instead of adding a
  cache of your own. The auth-rejection code is `1_000_048`.
- Percentages arrive as strings with `%`, counts as raw numbers, `end_time` as epoch milliseconds, and the
  window `status: 3` means unlimited (render 无限制 and drop used/total).
- Credits arrive as decimals (`"7726.2119999999995"`); the desktop shows `7,726`
  (`toLocaleString("en-US", { maximumFractionDigits: 0 })`), and `—` when absent.

## Degradation the panel expects

Membership OK but quota failed → still signed in, credits only, no window rows. Any membership failure →
signed-out copy. A specific auth error (401 / `cookie` / login) → 「请重新登录」 with retry; a generic
failure → 「加载失败」 with retry. These are the four states the surfaces already render; keep them
distinct instead of collapsing everything into one error.

## Daily sign-in (每日签到)

| Endpoint | Gives |
| --- | --- |
| `GET /minimax-cloud/api/v1/signin/status` | the 7-day panel |
| `POST /minimax-cloud/api/v1/signin/claim` | claims today, returns the updated panel |

Requests go through the public-gateway signing wrapper — md5-derived `yy`, `x-signature` and
`x-timestamp` headers alongside the bearer; `packages/tui/src/runtime/public-gateway.ts` is the
specification. Type and validate responses with `@mavis/shared/daily-signin`
(`SigninPanel`, `SigninDayStatus`, `SigninClaimResult` plus its panel-state helpers): the same module the
desktop and the TUI consume, so day-state semantics cannot drift between clients.

## Before trusting this page

Endpoints and their field names are product-side and change without a repository diff. Re-read
`matrix-account-client.ts` and the projection before relying on a row here, and treat a captured response
body as a fixture to copy verbatim rather than a shape to retype by hand.
