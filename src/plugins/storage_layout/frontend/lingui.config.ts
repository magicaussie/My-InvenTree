import { formatter } from '@lingui/format-po';

/**
 * Lingui configuration for the plugin frontend.
 *
 * Mirrors the host's locale set and the official plugin-creator configuration:
 * catalogs live next to the source and are compiled to TypeScript modules that
 * `src/locales.ts` loads on demand through the host i18n instance.
 */
export default {
  locales: [
    'de',
    'en',
    'es',
    'fr',
    'it',
    'ja',
    'ru',
    'zh_Hans',
    'zh_Hant',
    'pseudo-LOCALE'
  ],
  sourceLocale: 'en',
  fallbackLocales: {
    default: 'en',
    'pseudo-LOCALE': 'en'
  },
  catalogs: [
    {
      path: 'src/locales/{locale}/messages',
      include: ['src'],
      exclude: ['**/node_modules/**', './dist/**', './harness/**', './e2e/**']
    }
  ],
  format: formatter({ lineNumbers: false }),
  orderBy: 'origin'
};
