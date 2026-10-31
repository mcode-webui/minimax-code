// A complete in-memory `Storage`.
//
// Five test files used to hand-roll one of these, and three of them cast an
// incomplete object `as Storage`: `length` hard-coded to 0 and `key()` returning
// null no matter what had been stored. Those fakes typecheck and pass while
// lying about the interface, so a change that started iterating storage or
// clearing it would have been tested against a fake that cannot answer. This one
// is honest — the Map is the whole truth, and `values` exposes it for assertions
// about what was and was not written.

export type WebuiMemoryStorage = Storage & { readonly values: Map<string, string> };

export function createWebuiMemoryStorage(): WebuiMemoryStorage {
  const values = new Map<string, string>();
  return {
    get values() {
      return values;
    },
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}
