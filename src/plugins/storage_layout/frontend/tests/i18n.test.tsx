import { i18n } from '@lingui/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { localeCandidates, PluginLocale } from '../src/i18n';
import { loadLocale } from '../src/locales';

describe('localeCandidates', () => {
  it('keeps a plain locale and appends the English fallback', () => {
    expect(localeCandidates('de')).toEqual(['de', 'en']);
    expect(localeCandidates('en')).toEqual(['en']);
  });

  it('adds language-only fallbacks for region and script variants', () => {
    expect(localeCandidates('de-DE')).toEqual(['de-DE', 'de', 'en']);
    expect(localeCandidates('zh_Hans')).toEqual(['zh_Hans', 'zh', 'en']);
  });
});

describe('loadLocale', () => {
  it('loads a compiled catalog for a supported locale', async () => {
    const catalog = await loadLocale('en');
    expect(catalog).not.toBeNull();
    expect(typeof catalog?.messages).toBe('object');
    expect(Object.keys(catalog?.messages ?? {}).length).toBeGreaterThan(0);
  });

  it('returns null for an unsupported locale', async () => {
    expect(await loadLocale('zz_ZZ')).toBeNull();
  });
});

describe('PluginLocale', () => {
  it('loads the catalog and renders children', async () => {
    render(
      <PluginLocale i18n={i18n} locale='en'>
        <div data-testid='localized-child'>content</div>
      </PluginLocale>
    );

    expect(await screen.findByTestId('localized-child')).toBeInTheDocument();
  });

  it('still renders children when no catalog matches', async () => {
    render(
      <PluginLocale i18n={i18n} locale='zz_ZZ'>
        <div data-testid='fallback-child'>content</div>
      </PluginLocale>
    );

    expect(await screen.findByTestId('fallback-child')).toBeInTheDocument();
  });
});
