/**
 * Stock location detail panel.
 *
 * Resolves the current native location to its plugin binding using the
 * dedicated lookup endpoint, so a location that is a **drawer** or **bin**
 * (or a bound descendant) is reported correctly, not just a cabinet root. It
 * also offers an actor-safe locate action for locatable locations.
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

export interface LocationPanelProps {
  context: InvenTreePluginContext;
}

const ROLE_COLOURS: Record<string, string> = {
  cabinet: 'blue',
  drawer: 'green',
  bin: 'teal'
};

function roleLabel(binding: LocationBinding): string {
  if (binding.bin) return t`Bin ${binding.bin.label}`;
  if (binding.drawer) {
    return t`Drawer ${binding.drawer.display_number}. ${binding.drawer.label}`;
  }
  if (binding.role === 'cabinet') return t`Cabinet root`;
  return t`Unbound`;
}

export function LocationPanel({ context }: LocationPanelProps) {
  const locationId = context.id ? Number(context.id) : null;
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
    if (locationId === null || Number.isNaN(locationId)) {
      setStatus('error');
      setError(t`No location id was provided to the panel.`);
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

  if (status === 'loading') {
    return (
      <Group gap='xs'>
        <Loader size='xs' />
        <Text size='sm'>{t`Resolving storage binding…`}</Text>
      </Group>
    );
  }

  if (status === 'error' || !binding) {
    return (
      <Alert color='red' title={t`Storage Layout unavailable`}>
        {error ?? t`Could not resolve this location.`}
      </Alert>
    );
  }

  const cabinet = binding.cabinet;
  const target =
    binding.locatable && locationId !== null
      ? { kind: 'location' as const, id: String(locationId) }
      : null;

  return (
    <Stack gap='xs' data-testid='location-panel'>
      <Group gap='xs'>
        <Badge
          color={ROLE_COLOURS[binding.role ?? ''] ?? 'gray'}
          variant='light'
          data-testid='binding-role'
        >
          {binding.role ?? t`unbound`}
        </Badge>
        <Text fw={600}>{roleLabel(binding)}</Text>
      </Group>

      {cabinet ? (
        <Text size='sm' data-testid='binding-cabinet'>
          {t`Bound to cabinet ${cabinet.name} (${cabinet.slug}), revision ${cabinet.revision}, mapping N=${cabinet.total_pixels}.`}
        </Text>
      ) : (
        <Text size='sm'>
          {t`This native location is not bound to a storage layout cabinet, drawer or bin.`}
        </Text>
      )}

      {binding.drawer?.allocation ? (
        <Text size='sm' data-testid='inherited-range'>
          {t`Inherited LED range: L${binding.drawer.allocation.logical_start}–${binding.drawer.allocation.logical_end}`}
        </Text>
      ) : null}

      {binding.reason === 'cabinet_root' ? (
        <Alert color='yellow' variant='light'>
          {t`A cabinet root is ambiguous: use the cabinet designer or target a drawer/bin to locate.`}
        </Alert>
      ) : null}

      <Group gap='xs'>
        {cabinet ? (
          <Button
            size='xs'
            variant='default'
            onClick={() =>
              context.navigate(
                `/plugin/storage-layout/cabinets/${cabinet.id}/design`
              )
            }
            data-testid='open-cabinet-designer'
          >
            {t`Open cabinet designer`}
          </Button>
        ) : (
          <Button
            size='xs'
            variant='default'
            onClick={() => context.navigate('/plugin/storage-layout/cabinets')}
          >
            {t`Browse cabinets`}
          </Button>
        )}
        <Button size='xs' variant='subtle' onClick={() => void load()}>
          {t`Refresh`}
        </Button>
      </Group>

      {binding.locatable ? (
        <LocateControl
          client={client}
          target={target}
          cabinetId={cabinet?.id ?? null}
          mappingHash={cabinet?.mapping_hash ?? null}
          actionLabel={t`Locate location`}
        />
      ) : null}
    </Stack>
  );
}
