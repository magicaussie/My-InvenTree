/**
 * Dynamic locale loader for the plugin catalogs.
 *
 * `lingui compile --typescript` emits `<locale>/messages.ts` for every catalog
 * declared in `lingui.config.ts`; this loader resolves the requested locale at
 * runtime and is handed to the host i18n instance by {@link PluginLocale}.
 *
 * The type is the public `LocaleLoader` from the UI SDK, so this file stays
 * API-compatible with the official plugin-creator layout.
 */

import type { LocaleLoader } from '@inventreedb/ui';

export const loadLocale: LocaleLoader = async (locale: string) =>
  import(`./locales/${locale}/messages.ts`).catch(() => null);
