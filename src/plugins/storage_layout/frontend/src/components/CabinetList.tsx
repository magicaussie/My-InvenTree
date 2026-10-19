/**
 * Cabinet list / landing route (`cabinets`).
 *
 * Authenticated cabinet list and creation flow. Root location creation and
 * cabinet creation are submitted atomically through the plugin API.
 */

import type { InvenTreePluginContext } from '@inventreedb/ui';
import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput
} from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';

import { StorageLayoutClient } from '../api/client';
import { type CabinetSummary, StorageLayoutApiError } from '../api/types';
import { NativeLocationPicker } from './editor/NativeLocationPicker';

export interface CabinetListProps {
  context: InvenTreePluginContext;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function CabinetList({ context }: CabinetListProps) {
  const client = new StorageLayoutClient(context.api);
  const [cabinets, setCabinets] = useState<CabinetSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const [name, setName] = useState('');
  const [location, setLocation] = useState<number | ''>('');
  const [createRootLocation, setCreateRootLocation] = useState(false);
  const [rootLocationName, setRootLocationName] = useState('');
  const [creating, setCreating] = useState(false);
  const [width, setWidth] = useState(600);
  const [height, setHeight] = useState(800);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await client.listCabinets();
      setCabinets(result.results ?? []);
      setStatus('ready');
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      setError(apiError.message);
      setStatus('error');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!createRootLocation && location === '') return;
    try {
      setCreating(true);
      await client.createCabinet({
        name,
        slug: slugify(name),
        ...(createRootLocation
          ? { root_location_name: rootLocationName.trim() }
          : { location: Number(location) }),
        width_units: width,
        height_units: height
      });
      setCreateOpen(false);
      setName('');
      setLocation('');
      setCreateRootLocation(false);
      setRootLocationName('');
      await load();
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      setError(apiError.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Stack gap='sm' p='md' data-testid='cabinet-list'>
      <Group justify='space-between'>
        <Group gap='xs'>
          <Text fw={700} size='lg'>
            {t`Storage Layout`}
          </Text>
          <Badge variant='light'>{t`cabinets`}</Badge>
        </Group>
        <Group gap='xs'>
          <Button size='xs' variant='default' onClick={() => void load()}>
            {t`Refresh`}
          </Button>
          <Button size='xs' onClick={() => setCreateOpen(true)}>
            {t`New cabinet`}
          </Button>
        </Group>
      </Group>

      {error ? <Alert color='red'>{error}</Alert> : null}

      {status === 'ready' && cabinets.length === 0 ? (
        <Alert color='blue' title={t`No cabinets yet`}>
          {t`Create a cabinet to start designing its drawers and bins. Cabinets can be bound to an existing native stock location or a new root location.`}
        </Alert>
      ) : null}

      <Table withTableBorder striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t`Name`}</Table.Th>
            <Table.Th>{t`Dimensions`}</Table.Th>
            <Table.Th>{t`Revision`}</Table.Th>
            <Table.Th>{t`Mapping`}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cabinets.map((cabinet) => (
            <Table.Tr key={cabinet.id}>
              <Table.Td>
                <Text size='sm'>{cabinet.name}</Text>
                <Text size='xs' c='dimmed'>
                  {cabinet.slug}
                </Text>
              </Table.Td>
              <Table.Td>
                {cabinet.width_units} × {cabinet.height_units} logical units
              </Table.Td>
              <Table.Td>
                <Badge variant='light'>{cabinet.revision}</Badge>
              </Table.Td>
              <Table.Td>
                {cabinet.active_mapping ? (
                  <Badge color='teal' variant='light'>
                    {String(cabinet.active_mapping).slice(0, 8)}
                  </Badge>
                ) : (
                  <Badge color='gray' variant='light'>
                    {t`none`}
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Button
                  size='compact-xs'
                  onClick={() =>
                    context.navigate(
                      `/plugin/storage-layout/cabinets/${cabinet.id}/design`
                    )
                  }
                >
                  {t`Design`}
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t`New cabinet`}
      >
        <Stack gap='sm'>
          <TextInput
            label={t`Name`}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Group gap='xs'>
            <Button
              size='compact-xs'
              variant={!createRootLocation ? 'filled' : 'default'}
              onClick={() => setCreateRootLocation(false)}
            >{t`Choose existing`}</Button>
            <Button
              size='compact-xs'
              variant={createRootLocation ? 'filled' : 'default'}
              onClick={() => setCreateRootLocation(true)}
            >{t`Create root location`}</Button>
          </Group>
          {createRootLocation ? (
            <TextInput
              label={t`New root StockLocation name`}
              value={rootLocationName}
              onChange={(event) =>
                setRootLocationName(event.currentTarget.value)
              }
            />
          ) : (
            <NativeLocationPicker
              api={context.api}
              label={t`Cabinet StockLocation`}
              description={t`Select the existing structural location that anchors this cabinet.`}
              value={location === '' ? null : location}
              clearable={false}
              structural
              onChange={(value) => setLocation(value ?? '')}
            />
          )}
          <Group grow>
            <NumberInput
              label={t`Width (logical units)`}
              min={1}
              value={width}
              onChange={(value) => setWidth(Number(value) || 1)}
            />
            <NumberInput
              label={t`Height (logical units)`}
              min={1}
              value={height}
              onChange={(value) => setHeight(Number(value) || 1)}
            />
          </Group>
          <Group justify='flex-end'>
            <Button variant='default' onClick={() => setCreateOpen(false)}>
              {t`Cancel`}
            </Button>
            <Button
              onClick={() => void create()}
              loading={creating}
              disabled={
                creating ||
                !name.trim() ||
                (createRootLocation
                  ? !rootLocationName.trim()
                  : location === '')
              }
            >
              {t`Create`}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
