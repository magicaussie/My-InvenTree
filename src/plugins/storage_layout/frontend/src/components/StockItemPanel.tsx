/**
 * Stock item detail panel.
 *
 * Provides a native locate action for a stock item. It uses the plugin's
 * **actor-safe** session API (`POST locate-sessions/` with `target.kind =
 * 'item'`), never the native `LocateMixin` hook, so the initiating user is
 * preserved for permission, approval and audit. The item's current location is
 * resolved through the same binding lookup the location panel uses, so a
 * drawer/bin (or a bound descendant) is handled correctly.
 *
 * The host passes the raw stock item API object as `context.instance`; the
 * fields consumed here (`pk`, `location`, `in_stock`, `part_detail`,
 * `location_detail`) are the ones the host actually provides.
 */

import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Text
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { StorageLayoutClient } from '../api/client';
import { type LocationBinding, StorageLayoutApiError } from '../api/types';
import { LocateControl } from './LocateControl';

export interface StockItemPanelProps {
  context: InvenTreePluginContext;
}

interface StockItemLike {
  pk?: number;
  location?: number | null;
  in_stock?: boolean;
  part?: number | string;
  part_detail?: { name?: string; full_name?: string };
  location_detail?: { name?: string };
}

export function StockItemPanel({ context }: StockItemPanelProps) {
  const instance = (context.instance ?? {}) as StockItemLike;
  const itemId =
    instance.pk ??
    (context.id !== undefined && context.id !== null
      ? Number(context.id)
      : null);
  const locationId =
    instance.location !== undefined && instance.location !== null
      ? Number(instance.location)
      : null;
  const inStock = instance.in_stock !== false;

  const client = useMemo(
    () => new StorageLayoutClient(context.api),
    [context.api]
  );

  const [binding, setBinding] = useState<LocationBinding | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (locationId === null) {
      setBinding(null);
      setStatus('ready');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      setBinding(await client.getLocationBinding(locationId));
      setStatus('ready');
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      setError(apiError.message);
      setStatus('error');
    }
  }, [client, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const itemLabel =
    instance.part_detail?.full_name ??
    instance.part_detail?.name ??
    (itemId !== null ? t`Item ${itemId}` : t`Item`);

  const locationLabel =
    instance.location_detail?.name ??
    (locationId !== null ? String(locationId) : '');

  const cabinet = binding?.cabinet ?? null;
  const target =
    binding?.locatable && itemId !== null
      ? { kind: 'item' as const, id: String(itemId) }
      : null;

  return (
    <Stack gap='xs' data-testid='stock-item-panel'>
      <Group gap='xs'>
        <Text fw={600}>{itemLabel}</Text>
        {inStock ? (
          <Badge color='green' variant='light'>
            {t`In stock`}
          </Badge>
        ) : (
          <Badge color='orange' variant='light'>
            {t`Not in stock`}
          </Badge>
        )}
      </Group>

      {!inStock ? (
        <Alert color='yellow' variant='light'>
          {t`This item is not in stock, so it cannot be located.`}
        </Alert>
      ) : locationId === null ? (
        <Alert color='yellow' variant='light'>
          {t`This item has no current location.`}
        </Alert>
      ) : status === 'loading' ? (
        <Group gap='xs'>
          <Loader size='xs' />
          <Text size='sm'>{t`Resolving location binding…`}</Text>
        </Group>
      ) : status === 'error' ? (
        <Alert color='red' title={t`Storage Layout unavailable`}>
          {error ?? t`Could not resolve the item location.`}
        </Alert>
      ) : (
        <>
          <Text size='sm'>
            {cabinet
              ? t`Current location ${locationLabel} — cabinet ${cabinet.name}, mapping N=${cabinet.total_pixels}`
              : t`Current location ${locationLabel} — not bound to a storage layout cabinet.`}
          </Text>
          {binding && !binding.locatable ? (
            <Text size='sm' c='dimmed'>
              {binding.reason === 'no_allocation'
                ? t`The mapped drawer has no LED allocation.`
                : t`The current location is not mapped to a locatable drawer.`}
            </Text>
          ) : null}
          <Group gap='xs'>
            <Button size='xs' variant='subtle' onClick={() => void load()}>
              {t`Refresh`}
            </Button>
          </Group>
        </>
      )}

      {inStock &&
      locationId !== null &&
      binding?.locatable &&
      status === 'ready' ? (
        <LocateControl
          client={client}
          target={target}
          cabinetId={cabinet?.id ?? null}
          mappingHash={cabinet?.mapping_hash ?? null}
          actionLabel={t`Locate item`}
        />
      ) : null}
    </Stack>
  );
}
