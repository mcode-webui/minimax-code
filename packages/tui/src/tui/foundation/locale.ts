export function resolveTuiLocale(): string {
  const override = process.env.MCODE_TUI_LOCALE?.trim();
  return override || Intl.DateTimeFormat().resolvedOptions().locale;
}
