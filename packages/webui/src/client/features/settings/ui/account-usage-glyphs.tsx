// The account page's icons, transcribed from the Desktop icon set.
//
// The Desktop draws the account page with five glyphs — share, info, refresh,
// download and close. Their path data is copied here rather than approximated,
// because the account page is meant to look like the Desktop's.
//
// The Desktop's own icon components live in a private renderer bundle, so the
// paths were read out of it; nothing else was taken.

import { IconDownload, IconInfoCircle, IconRefresh, IconShare3 } from "@tabler/icons-react";
import type { ReactElement } from "react";

/** The account page's "share" action. */
export function AccountUsageShareIcon({
  size = 20,
}: {
  readonly size?: number;
}): ReactElement {
  return <IconShare3 aria-hidden="true" size={size} stroke={1.4} />;
}

/** The info hint next to the usage numbers. */
export function AccountUsageInfoIcon({
  size = 16,
}: {
  readonly size?: number;
}): ReactElement {
  return <IconInfoCircle aria-hidden="true" size={size} stroke={1.3} />;
}

/** The account page's "retry" action. */
export function AccountUsageRefreshIcon({
  size = 20,
}: {
  readonly size?: number;
}): ReactElement {
  return <IconRefresh aria-hidden="true" size={size} stroke={1.3} />;
}

/** The share image's "save" action. */
export function AccountUsageDownloadIcon({
  size = 20,
}: {
  readonly size?: number;
}): ReactElement {
  return <IconDownload aria-hidden="true" size={size} stroke={1.3} />;
}
