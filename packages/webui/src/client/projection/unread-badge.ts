// The unread badge rule (plan §7.6 "Unread"; ticket #49 criterion 6).
//
// The presentation half of the former `client/session-unread.ts`, split out so
// the storage IO could move to `infrastructure/storage.ts` and the source path
// could be deleted. It decides how many unread turns to draw, nothing else.

/** Above this the badge says "99+" -- a 4-digit pill has nowhere to go. */
export const SESSION_UNREAD_BADGE_MAX = 99;

/** The number to draw. `0` and `undefined` both render as no badge at all. */
export function formatWebuiUnreadBadge(count: number | undefined): string {
  if (!count || count <= 0) return "";
  return count > SESSION_UNREAD_BADGE_MAX ? `${SESSION_UNREAD_BADGE_MAX}+` : String(count);
}
