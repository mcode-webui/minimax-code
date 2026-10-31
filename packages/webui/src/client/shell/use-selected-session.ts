/**
 * The shell's selected session.
 *
 * The location hash is the source of truth: it is read once for the first render
 * (so an SSR snapshot and a reload agree) and subscribed afterwards, because a
 * hash change — a link, the back button, another tab — selects the session it
 * names.
 *
 * Extracted from `WebuiClientFoundationApp.tsx`. The file's other lines are
 * layout and public business composition; this is the one piece of browser
 * navigation state the shell owns itself, and it changes when navigation
 * changes, not when the layout does.
 */
import { useEffect, useState } from "react";

import { readSessionIdFromHash, subscribeToSessionHash } from "../bindings/navigation.js";

export function useSelectedSessionId(
  locationHash?: string,
): [string | undefined, (id: string | undefined) => void] {
  const read = () =>
    readSessionIdFromHash(
      locationHash ??
        (typeof window === "undefined" ? "" : window.location.hash),
    );
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    if (locationHash !== undefined || typeof window === "undefined") return;
    return subscribeToSessionHash((id) => setSelected(id));
  }, [locationHash]);
  return [selected, setSelected];
}
