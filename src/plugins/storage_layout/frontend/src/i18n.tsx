/**
 * Host-compatible plugin i18n wrapper.
 *
 * The host passes its **global** `@lingui/core` i18n instance as
 * `context.i18n` (see the host's `PluginContext`), and `t` macros compile
 * against that same singleton. Wrapping the plugin tree in an
 * `I18nProvider` bound to `context.i18n` - after loading the plugin's own
 * catalogs into it - is exactly what the SDK's `LocalizedComponent` does.
 *
 * This module re-implements that small wrapper locally instead of importing the
 * SDK's runtime component, because `@inventreedb/ui` declares no
 * `sideEffects` field: importing any runtime value from its bundled index
 * would pull the entire host UI library (and its non-externalised
 * dependencies) into the plugin bundle.
 *
 * Robustness: if no catalog can be loaded (missing locale, network failure,
 * or an untranslated locale) the children are still rendered, so the plugin
 * never disappears because of an i18n problem.
 */

import type { I18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { useEffect, useState } from 'react';

import { loadLocale } from './locales';

export interface PluginLocaleProps {
  i18n: I18n;
  locale: string;
  children: React.ReactNode;
}

/** Locale fallbacks to try, in order, for a requested locale. */
export function localeCandidates(locale: string): string[] {
  const candidates = [locale];

  if (locale.includes('-')) candidates.push(locale.split('-')[0]);
  if (locale.includes('_')) candidates.push(locale.split('_')[0]);
  if (!candidates.includes('en')) candidates.push('en');

  return candidates;
}

async function loadCatalog(
  i18n: I18n,
  loader: typeof loadLocale,
  locale: string
): Promise<boolean> {
  for (const candidate of localeCandidates(locale)) {
    let catalog: { messages?: Record<string, string> } | null = null;

    try {
      catalog = (await loader(candidate)) as {
        messages?: Record<string, string>;
      } | null;
    } catch {
      catalog = null;
    }

    const messages = catalog?.messages;

    if (messages && Object.keys(messages).length > 0) {
      i18n.load(candidate, messages);
      i18n.activate(candidate);
      return true;
    }
  }

  return false;
}

export function PluginLocale({ i18n, locale, children }: PluginLocaleProps) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    loadCatalog(i18n, loadLocale, locale).finally(() => {
      if (!cancelled) setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [i18n, locale]);

  if (!loaded) return null;

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
