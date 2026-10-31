/**
 * Whether a seed attachment enters the composer's staging, and what happens
 * instead when it cannot.
 *
 * The composer receives a seed from whatever opened it — a transcript file
 * hand-off, typically a text file large enough that the caller did not want it
 * re-attached on every re-render. The rule that keeps that safe is a token the
 * staging records once the seed has been *decided*, not once it has been
 * *accepted*: a seed the composer refuses has to stay refused, and retrying it
 * on every attachment change would pin its error in place.
 *
 * This read answers the decision only. The caller records the token before it
 * acts on the answer, so the order the invariant requires is visible at the call
 * site rather than implied by this function's internals.
 */

import {
  webuiAttachmentLimitError,
  webuiTextAttachmentDataUrl,
  type WebuiComposerAttachment,
} from "./composer-interactions.js";

/** A seed attachment offered by whoever opened the composer. */
export interface WebuiComposerSeed {
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: string;
}

export type WebuiSeedApplication =
  /** Nothing to do: no seed, or this token has already been decided. */
  | { readonly kind: "none" }
  /** The seed breaks an attachment limit; report it and consume the token. */
  | { readonly kind: "refused"; readonly token: string; readonly error: string }
  /** Stage this attachment and consume the token. */
  | { readonly kind: "staged"; readonly token: string; readonly attachment: WebuiComposerAttachment };

export function readWebuiSeedApplication(input: {
  readonly seed: WebuiComposerSeed | undefined;
  /** The token the staging already decided, if any. */
  readonly consumedToken: string | undefined;
  readonly attachments: readonly { readonly sizeBytes: number }[];
}): WebuiSeedApplication {
  const { seed } = input;
  if (!seed || input.consumedToken === seed.token) return { kind: "none" };
  const error = webuiAttachmentLimitError(input.attachments, [{ sizeBytes: seed.sizeBytes }]);
  if (error) return { kind: "refused", token: seed.token, error };
  return {
    kind: "staged",
    token: seed.token,
    attachment: {
      id: `seed-${seed.token}`,
      fileName: seed.fileName,
      mimeType: seed.mimeType,
      sizeBytes: seed.sizeBytes,
      dataUrl: webuiTextAttachmentDataUrl(seed.mimeType, seed.content),
      kind: "file",
    },
  };
}
