/**
 * Public entry point for the Storage Layout plugin frontend.
 *
 * Every export referenced from `plugin.py` is capitalised (React Fast Refresh
 * requirement) and returns a React element from a single
 * `InvenTreePluginContext` argument. The backend wires these functions through
 * `UserInterfaceMixin` using `plugin_static_file('storage_layout.js:Name')`.
 *
 * Each entry renders inside {@link PluginLocale}, which loads the plugin's
 * compiled catalogs into the host i18n instance (`context.i18n`) before
 * rendering, so `t`/`Trans` messages resolve against the host locale.
 *
 * See `README.md` for the exact `get_ui_routes` / `get_ui_navigation_items` /
 * `get_ui_panels` declarations in `plugin.py`.
 */

import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import { Alert } from '@mantine/core';
import type { ReactElement } from 'react';

import { CabinetDesigner } from './components/CabinetDesigner';
import { CabinetList } from './components/CabinetList';
import { DrawerDesigner } from './components/DrawerDesigner';
import { LocationPanel } from './components/LocationPanel';
import { StockItemPanel } from './components/StockItemPanel';
import { PluginLocale } from './i18n';

/**
 * Read the `:id` segment that follows `prefix` in the current URL.
 *
 * Plugin route params are not passed through the plugin context, so the
 * designer reads the id from the resolved path (mirroring the official sample).
 */
export function routeId(prefix: string): string {
  const segments = window.location.pathname.split('/').filter(Boolean);
  const index = segments.lastIndexOf(prefix);
  if (index >= 0 && index + 1 < segments.length) {
    return decodeURIComponent(segments[index + 1]);
  }
  return '';
}

/** Wrap an entry element in the host-compatible locale provider. */
function localized(
  context: InvenTreePluginContext,
  element: ReactElement
): ReactElement {
  if (!context?.i18n || !context?.locale) {
    // The host always supplies both; stay resilient if an older host does not.
    return element;
  }

  return (
    <PluginLocale i18n={context.i18n} locale={context.locale}>
      {element}
    </PluginLocale>
  );
}

/** Route: `cabinets` - cabinet list / landing page. */
export function RenderCabinetList(context: InvenTreePluginContext) {
  return localized(context, <CabinetList context={context} />);
}

/** Route: `cabinets/:id/design` - graphical cabinet designer. */
export function RenderCabinetDesigner(context: InvenTreePluginContext) {
  const cabinetId = routeId('cabinets');
  if (!cabinetId) {
    return localized(
      context,
      <Alert color='red' title={t`Missing cabinet id`}>
        {t`The cabinet designer requires a cabinet id in the route.`}
      </Alert>
    );
  }
  return localized(
    context,
    <CabinetDesigner context={context} cabinetId={cabinetId} />
  );
}

/** Route: `drawers/:id/design` - graphical drawer/bin designer. */
export function RenderDrawerDesigner(context: InvenTreePluginContext) {
  const drawerId = routeId('drawers');
  if (!drawerId) {
    return localized(
      context,
      <Alert color='red' title={t`Missing drawer id`}>
        {t`The drawer designer requires a drawer id in the route.`}
      </Alert>
    );
  }
  return localized(
    context,
    <DrawerDesigner context={context} drawerId={drawerId} />
  );
}

/** Panel: stock location detail - binding summary and locate action. */
export function RenderStorageLocationPanel(context: InvenTreePluginContext) {
  return localized(context, <LocationPanel context={context} />);
}

/** Panel: stock item detail - actor-safe locate action. */
export function RenderStockItemPanel(context: InvenTreePluginContext) {
  return localized(context, <StockItemPanel context={context} />);
}
