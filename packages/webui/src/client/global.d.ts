// The composer's folder-attachment input uses the legacy attribute; the
// spec name is "directory".
interface HTMLInputElement {
  webkitdirectory?: boolean;
}

declare module "highlight.js/lib/core" {
  interface HighlightResult { value: string; }
  interface HighlightOptions { language: string; ignoreIllegals?: boolean; }
  interface HighlightJs {
    highlight(code: string, options: HighlightOptions): HighlightResult;
    getLanguage(name: string): unknown;
    registerLanguage(name: string, language: (hljs: unknown) => unknown): void;
  }
  const hljs: HighlightJs;
  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  const language: (hljs: unknown) => unknown;
  export default language;
}
