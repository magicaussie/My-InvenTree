/**
 * Browser integration harness for the Storage Layout plugin frontend.
 *
 * This is **not** part of the shipped plugin. It exists only so Playwright can
 * load the *real* built plugin bundle in a real browser and drive it against an
 * in-memory fixture API.
 *
 * Query parameters:
 *   - `feature`  export name to render (e.g. `RenderCabinetDesigner`)
 *   - `seed`     `large` seeds the 500-drawer / 2,000-bin performance fixture
 *   - `instance` JSON for `context.instance`
 *   - `model` / `id` override the fake plugin context model and id
 *
 * The path supplies the route id used by `routeId()` (e.g.
 * `/cabinets/cab-1/design`).
 */

import '@mantine/core/styles.css';

import * as LinguiCore from '@lingui/core';
import * as LinguiReact from '@lingui/react';
import * as MantineCore from '@mantine/core';
import { MantineProvider } from '@mantine/core';
import * as React from 'react';

import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import { createRoot } from 'react-dom/client';

import { createMockApi } from './mockApi';

const scope = window as unknown as Record<string, unknown>;

// Provide the globals the host application assigns in `src/frontend/src/main.tsx`.
scope.React = React;
scope.ReactDOM = ReactDOM;
scope.ReactDOMClient = ReactDOMClient;
scope.MantineCore = MantineCore;
scope.LinguiCore = LinguiCore;
scope.LinguiReact = LinguiReact;

async function waitForBundle(): Promise<Record<string, unknown>> {
  const existing = scope.__pluginModule;
  if (existing) return existing as Record<string, unknown>;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/plugin-static/entry.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load plugin bundle'));
    document.head.appendChild(script);
  });

  const deadline = Date.now() + 5000;
  while (!scope.__pluginModule && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  if (!scope.__pluginModule) {
    throw new Error('plugin bundle did not register on window');
  }
  return scope.__pluginModule as Record<string, unknown>;
}

async function loadEntry(): Promise<Record<string, unknown>> {
  // Resolve the hashed bundle from the manifest the prepare script copied into
  // the harness public directory.
  //
  // Only the *built* bundle is supported: the plugin source imports the Lingui
  // macro package (`@lingui/core/macro`), which is compile-time only and pulls
  // Node-only tooling into the graph if the source is bundled directly.
  const manifest = (await fetch('/plugin-static/manifest.json').then((r) =>
    r.json()
  )) as { file: string };
  scope.__pluginFile = manifest.file;

  return waitForBundle();
}

async function start() {
  const params = new URLSearchParams(window.location.search);

  const api = createMockApi({ large: params.get('seed') === 'large' });
  scope.__mock = api;
  const navigation: string[] = [];
  scope.__navigation = navigation;

  const instanceParam = params.get('instance');

  const context: Record<string, unknown> = {
    api: api.instance,
    navigate: (path: string) => {
      navigation.push(path);
    },
    model: params.get('model') ?? 'stocklocation',
    id: params.get('id') ? Number(params.get('id')) : 41,
    instance: instanceParam ? JSON.parse(instanceParam) : {},
    i18n: LinguiCore.i18n,
    version: { inventree: 'test', react: '19', reactDom: '19', mantine: '9' },
    host: window.location.origin,
    locale: 'en',
    colorScheme: 'light',
    user: { username: 'tester' },
    userSettings: {},
    globalSettings: {},
    context: {}
  };

  const feature = params.get('feature') ?? 'RenderCabinetList';

  try {
    const mod = await loadEntry();
    const fn = mod[feature];

    if (typeof fn !== 'function') {
      throw new Error(`Export '${feature}' is not a function`);
    }

    const element = (fn as (ctx: unknown) => React.ReactElement)(context);

    createRoot(document.getElementById('root') as HTMLElement).render(
      <MantineProvider>{element}</MantineProvider>
    );
    scope.__ready = true;
  } catch (error) {
    scope.__error = String(error);
    const root = document.getElementById('root');
    if (root) root.textContent = `Harness error: ${String(error)}`;
  }
}

void start();
