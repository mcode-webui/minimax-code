// Reading a plugin-management row.
//
// The rows this area renders come from the harness as untyped objects, so both the catalogue and the
// dialogs it hosts read them by key with a fallback — one implementation, not one per file, since a
// shared invariant gets a single implementation.

/** A plugin-management row as the runtime sends it: an object with no declared shape. */
export type WebuiPluginRow = Record<string, unknown>;

/** The first of `keys` whose value is a string, else `""`. */
export function readWebuiPluginRow(row: WebuiPluginRow, ...keys: readonly string[]): string {
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  return "";
}
