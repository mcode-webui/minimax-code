// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiBrowserCanvas` | A drawing surface the browser hands to a feature, with the context it paints on and the PNG it exports. | Browser `client/platform/browser-dom.ts` (`createWebuiBrowserDom`). | `client/features/settings/ui/account-usage-share-image.ts`; `client/features/settings/ui/AccountUsageSettings.tsx`. |
// | `WebuiBrowserImage` | An image the browser has decoded, ready to be drawn on a canvas. | Browser `client/platform/browser-dom.ts` (`createWebuiBrowserDom`). | `client/features/settings/ui/account-usage-share-image.ts`. |
//
// These are the browser's drawing capabilities as a contract, not a wire
// format: the account page's share image is painted on a canvas and exported
// as a PNG, and the platform is the only layer allowed to reach the browser's
// canvas, image and download APIs.

/** A drawing surface a feature paints on. */
export interface WebuiBrowserCanvas {
  readonly width: number;
  readonly height: number;
  readonly context: CanvasRenderingContext2D;
  /** Exports the surface as a PNG. */
  readonly toBlob: () => Promise<Blob>;
}

/** An image the browser has decoded and the canvas can draw. */
export interface WebuiBrowserImage {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}
