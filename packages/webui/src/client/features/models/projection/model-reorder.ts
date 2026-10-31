/** Return the item order after moving one stable model id onto another. */
export function reorderModelIds(ids: readonly string[], activeId: string, overId: string): string[] {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
