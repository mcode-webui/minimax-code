/** Headless Browser runtime configuration shared by local providers. */
export interface BrowserConfig {
  /** Optional Chrome executable path. Omit it to use platform discovery. */
  chromePath?: string;
  /**
   * Whether the isolated Chromium this process launches and owns may be used.
   *
   * Off unless the configuration says otherwise: a browser that starts on its
   * own is a browser the person did not ask for.
   */
  isolatedChromium?: boolean;
  /** Whether the person's Microsoft Edge may be driven through the extension bridge. */
  edge?: boolean;
  /** Whether the person's Google Chrome may be driven through the extension bridge. */
  chrome?: boolean;
  /**
   * Whether a caller may send every DevTools command the active provider
   * exposes, instead of only the restricted command set.
   *
   * This widens an already-authorized surface; it never authorizes one. It is
   * deliberately a separate switch so that granting it is an explicit act
   * rather than a side effect of allowing a browser.
   */
  fullCdp?: boolean;
}

/**
 * The browser configuration a fresh install has: no browser, no Full CDP.
 *
 * Every authorization is absent rather than merely false, so a caller reading
 * the configuration cannot mistake "not configured" for "configured off" and
 * quietly widen a gate.
 */
export const BROWSER_CONFIG_DEFAULTS: BrowserConfig = {
  isolatedChromium: false,
  edge: false,
  chrome: false,
  fullCdp: false,
};

export function parseBrowserConfig(raw: unknown): BrowserConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...BROWSER_CONFIG_DEFAULTS };
  }
  const chromePath = Reflect.get(raw, 'chromePath');
  const parsedChromePath =
    typeof chromePath === 'string' && chromePath.trim() ? chromePath.trim() : undefined;
  return {
    ...BROWSER_CONFIG_DEFAULTS,
    ...(parsedChromePath ? { chromePath: parsedChromePath } : {}),
    isolatedChromium: parseBooleanFlag(raw, 'isolatedChromium'),
    edge: parseBooleanFlag(raw, 'edge'),
    chrome: parseBooleanFlag(raw, 'chrome'),
    fullCdp: parseBooleanFlag(raw, 'fullCdp'),
  };
}

/**
 * A switch is on only when the configuration says `true` in so many words.
 *
 * Anything else — a string, a number, a missing key — leaves it off. A switch
 * that turned itself on because a config file held `"true"` would be a switch
 * that could be turned on by accident.
 */
function parseBooleanFlag(raw: object, key: string): boolean {
  return Reflect.get(raw, key) === true;
}
