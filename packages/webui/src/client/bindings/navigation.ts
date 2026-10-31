// Browser navigation IO: reading the session out of the URL hash and listening
// for it to change. Split out of the shell so the shell holds the React tree
// rather than the browser's URL plumbing.
//
// Both symbols are re-exported by `client/shell/WebuiClientFoundationApp.tsx` for
// back-compat: `main.tsx` re-exports `subscribeToSessionHash`, and the SSR
// snapshot reads `readSessionIdFromHash` through the shell.


/**
 * Hash helpers used by the shell. The SSR snapshot reads
 * `readSessionIdFromHash` through the shell, so the symbol is re-exported from
 * `WebuiClientFoundationApp.tsx` for back-compat.
 */
export function readSessionIdFromHash(hash: string): string | undefined {
  const params = new URLSearchParams(
    hash.startsWith("#") ? hash.slice(1) : hash,
  );
  const id = params.get("session");
  return id?.trim() || undefined;
}


export function subscribeToSessionHash(
  onChange: (sessionId: string | undefined) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onHashChange = () =>
    onChange(readSessionIdFromHash(window.location.hash));
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
}
