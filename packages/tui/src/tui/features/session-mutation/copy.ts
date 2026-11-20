import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';
import { resolveTuiLocale } from '../../foundation/locale.js';

import {
  SESSION_HISTORY_COPY,
  SESSION_MUTATION_COPY,
  type SessionHistoryCopyKey,
  type SessionMutationCopyKey,
} from './copy.en.js';
import { ZH_HANS_SESSION_HISTORY_COPY, ZH_HANS_SESSION_MUTATION_COPY } from './copy.zh-Hans.js';

export type { SessionHistoryCopyKey } from './copy.en.js';

export { resolveTuiLocale as sessionMutationLocale };

function isChineseLocale(locale: string): boolean {
  return getRuntimeLocaleLanguage(locale) === 'zh';
}

export function sessionHistoryText(
  key: SessionHistoryCopyKey,
  locale = resolveTuiLocale(),
): string {
  return isChineseLocale(locale) ? ZH_HANS_SESSION_HISTORY_COPY[key] : SESSION_HISTORY_COPY[key];
}

export function sessionMutationText(
  key: SessionMutationCopyKey,
  locale = resolveTuiLocale(),
): string {
  return isChineseLocale(locale) ? ZH_HANS_SESSION_MUTATION_COPY[key] : SESSION_MUTATION_COPY[key];
}

export function sessionMutationTemplate(
  key: SessionMutationCopyKey,
  values: Readonly<Record<string, string | number>>,
  locale = resolveTuiLocale(),
): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    sessionMutationText(key, locale),
  );
}
