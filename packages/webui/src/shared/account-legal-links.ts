// The legal documents the sign-in page links to.
//
// The Desktop's login page closes with "登录即表示你同意 [服务条款] 和 [隐私政策]",
// and both links point at the account's own site: the origin the account
// belongs to, plus the `/doc/<language>/` tree that site publishes. The
// Desktop derives that origin from the account scope it already holds, and so
// does this — the region decides the site, and the scope decides the language.
//
// The table is the WebUI's own account origins — the site the account's
// documents are published on, not the service origin the WebUI calls. It is
// repeated here rather than imported from the runtime layer because the shared
// layer may not import a workspace package and the runtime layer may not be
// reached from the browser: the browser needs the same origins the server
// signs with, and one table is how they stay the same.

/** The account scope the links are resolved for. */
export interface WebuiAccountScope {
  readonly region: string;
  readonly buildEnv: string;
}

/** The two documents the sign-in page links to. */
export interface WebuiAccountLegalLinksView {
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

const ACCOUNT_SITE_ORIGINS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  cn: {
    dev: "https://matrix-test.example.invalid",
    test: "https://matrix-test.example.invalid",
    staging: "https://matrix-pre.example.invalid",
    // The account's *site*, not its API: the Desktop's login page takes the
    // host of its legal documents from the site origin its own build is
    // served from, and the port has to name the same documents the Desktop
    // names. The service origins the WebUI calls (check-in, quota, pairing)
    // are a different table and a different question.
    prod: "https://agent.minimax.cn",
  },
  en: {
    dev: "https://matrix-overseas-test.example.invalid",
    test: "https://matrix-overseas-test.example.invalid",
    staging: "https://matrix-overseas-pre.example.invalid",
    prod: "https://agent.minimax.io",
  },
};

/**
 * The language the account's site publishes its documents in.
 *
 * The account region decides it, the same way the Desktop's page decides the
 * `zh` / `en` segment of its links. It is not the browser's language: the
 * document has to be the one that governs the account.
 */
function documentLanguage(region: string): "zh" | "en" {
  return region === "en" ? "en" : "zh";
}

/**
 * The account's own legal documents.
 *
 * `undefined` when the scope names no account site this build knows — a
 * scope the resolver never produced, or a region a public build does not
 * serve. The page then shows the notice without links rather than links to a
 * document that does not exist.
 */
export function webuiAccountLegalLinks(
  scope: WebuiAccountScope | undefined,
): WebuiAccountLegalLinksView | undefined {
  if (!scope) return undefined;
  const origin = ACCOUNT_SITE_ORIGINS[scope.region]?.[scope.buildEnv];
  if (!origin) return undefined;
  const language = documentLanguage(scope.region);
  return {
    termsUrl: `${origin}/doc/${language}/terms-of-service.html`,
    privacyUrl: `${origin}/doc/${language}/privacy-policy.html`,
  };
}
