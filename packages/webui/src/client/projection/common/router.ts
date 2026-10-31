export type WebuiRoute = "archon" | "miniapp" | "404";

export function route(pathname: string): WebuiRoute {
  if (pathname === "/archon" || pathname === "/") return "archon";
  // ADR 0020's standalone presentation: the same client document, told by the
  // route to render only the Mini App view. The service maps the path to this
  // bundle (`server/http/router.ts`), so the tab is an ordinary client.
  if (pathname === "/miniapp") return "miniapp";
  return "404";
}

/** The plugin and session a standalone Mini App's deep link names. */
export interface WebuiMiniAppDeepLink {
  readonly pluginId: string;
  readonly sessionId: string;
}

/**
 * What the standalone route points at, or `undefined` when the link is incomplete.
 *
 * Both ids are required: a tab that names no Mini App has nothing to show, and one
 * that names no session cannot say what conversation it was opened from. The
 * session is carried in the query rather than the `#session=` hash because this
 * page selects nothing — it shows one page, which is the whole point of the
 * separate document.
 *
 * The token a hand-typed link does not carry is not this function's business: the
 * service answers the page only for a link that has one, and this parses what is
 * left.
 */
export function miniAppDeepLink(search: string): WebuiMiniAppDeepLink | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pluginId = params.get("plugin")?.trim();
  const sessionId = params.get("session")?.trim();
  if (!pluginId || !sessionId) return undefined;
  return { pluginId, sessionId };
}

/**
 * The session deep link's hash. It lives next to `route()` because it is the
 * other half of the same route shape: `readSessionIdFromHash`
 * (`client/bindings/navigation.ts`) parses what this builds, so the two must
 * agree on the key.
 *
 * It was declared in `SessionRail.tsx`, which was its only caller while the rail
 * was the only surface that could navigate to a session. The shell navigates too
 * (a created/imported session, a subagent), so it lives in the module that owns
 * the route.
 */
export function sessionHash(sessionId: string): string {
  const params = new URLSearchParams();
  params.set("session", sessionId);
  return `#${params.toString()}`;
}
