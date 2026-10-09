import {
  ownsElectronRuntimeCapabilities,
  type RuntimeOwnerPolicy,
} from '@mavis/local-runtime';
import {
  initializeBrowserUseService,
  type BrowserUseService,
} from '../../service/browser-use/index.js';

type BrowserUseServiceOptions = Parameters<typeof initializeBrowserUseService>[0];

interface RuntimeBrowserUseBetaConfig {
  readonly filePanelBrowser?: boolean;
  readonly browserUseTooling?: boolean;
}

export interface RuntimeBrowserUseOptions {
  readonly browserUse?: Pick<BrowserUseServiceOptions, 'adapter' | 'toolExposure'>;
  readonly runtimeOwnerKind?: string;
  /** Policy resolved once by the composition root; absent for direct test callers. */
  readonly ownerPolicy?: RuntimeOwnerPolicy;
  readonly compatibility: {
    readonly agentHost: {
      readonly preparation: {
        readonly configBuilder: {
          config(): { readonly beta?: RuntimeBrowserUseBetaConfig };
        };
      };
    };
    readonly generatedAssets: {
      readonly compressModelImage: BrowserUseServiceOptions['compressScreenshot'];
      readonly registerGeneratedAsset: BrowserUseServiceOptions['registerGeneratedAsset'];
    };
    readonly questionnaires: {
      bindRequestAdmission(admission: BrowserUseService['admitQuestionnaireRequest']): void;
    };
  };
}

export interface RuntimeBrowserUseComposition {
  readonly service: BrowserUseService;
  close(): void;
}

// Re-exported from the policy module rather than re-implemented, so the desktop
// service gates and the compatibility gate cannot disagree about what an absent
// owner means.
export { ownsElectronRuntimeCapabilities };

export function createRuntimeBrowserUseComposition(
  options: RuntimeBrowserUseOptions,
): RuntimeBrowserUseComposition {
  const activationMode =
    options.ownerPolicy?.wiring.browserActivation ??
    (ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
      ? 'desktop-plugin'
      : 'explicit-config');
  const service = initializeBrowserUseService({
    ...(options.browserUse?.adapter ? { adapter: options.browserUse.adapter } : {}),
    ...(options.browserUse?.toolExposure ? { toolExposure: options.browserUse.toolExposure } : {}),
    readConfig: () => {
      const beta = options.compatibility.agentHost.preparation.configBuilder.config().beta;
      return {
        ...(beta?.filePanelBrowser === undefined
          ? {}
          : { filePanelBrowserEnabled: beta.filePanelBrowser }),
        ...(beta?.browserUseTooling === undefined
          ? {}
          : { browserUseToolingEnabled: beta.browserUseTooling }),
      };
    },
    compressScreenshot: options.compatibility.generatedAssets.compressModelImage,
    registerGeneratedAsset: options.compatibility.generatedAssets.registerGeneratedAsset,
    activationMode,
  });
  options.compatibility.questionnaires.bindRequestAdmission((input) =>
    service.admitQuestionnaireRequest(input),
  );
  return {
    service,
    close(): void {
      service.close();
    },
  };
}
