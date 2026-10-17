import '@testing-library/jest-dom/vitest';
import { i18n } from '@lingui/core';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Lingui's `t` macro delegates to the global i18n instance, which throws unless
// a locale has been activated. The browser bundle activates it via
// `PluginLocale`; tests activate English with an empty catalog so messages fall
// back to their source strings.
i18n.load('en', {});
i18n.activate('en');

// Mantine relies on a handful of browser APIs which jsdom does not implement.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  });
}

// jsdom does not implement PointerEvent. The editors rely on it for the
// pointer capture drag/resize flow, so provide a minimal MouseEvent-based
// polyfill (including `pointerId`).
type PointerEventInitLike = MouseEventInit & { pointerId?: number };

if (
  typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined'
) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;

    constructor(type: string, params: PointerEventInitLike = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }

  (globalThis as { PointerEvent?: unknown }).PointerEvent =
    PointerEventPolyfill;
}

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const globals = globalThis as unknown as {
  ResizeObserver?: unknown;
  IntersectionObserver?: unknown;
};

globals.ResizeObserver ??= MockResizeObserver;
globals.IntersectionObserver ??= MockIntersectionObserver;

afterEach(() => {
  cleanup();
});
