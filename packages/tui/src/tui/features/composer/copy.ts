import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';
import { resolveTuiLocale } from '../../foundation/locale.js';

import { COMPOSER_COPY, type ComposerCopyKey } from './copy.en.js';
import { ZH_HANS_COMPOSER_COPY } from './copy.zh-Hans.js';

export function composerText(key: ComposerCopyKey, locale = resolveTuiLocale()): string {
  return getRuntimeLocaleLanguage(locale) === 'zh'
    ? ZH_HANS_COMPOSER_COPY[key]
    : COMPOSER_COPY[key];
}
