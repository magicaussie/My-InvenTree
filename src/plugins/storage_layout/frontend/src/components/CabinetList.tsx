/**
 * Cabinet list / landing route (`cabinets`).
 *
 * Simple, authenticated list of plugin cabinets with a link into the graphical
 * designer. Cabinet creation references an existing native location; it never
 * creates one implicitly (design section 5).
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
    if (location === '') return;
    try {
      await client.createCabinet({
        name,
        slug: slugify(name),
        location: Number(location),
        width_units: width,
        height_units: height
      });
      setCreateOpen(false);
      setName('');
      setLocation('');
      await load();
    } catch (err) {
      const apiError =
        err instanceof StorageLayoutApiError
          ? err
          : new StorageLayoutApiError(String(err), 0);
      setError(apiError.message);
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
          {t`Create a cabinet to start designing its drawers and bins. Cabinets are bound to existing native stock locations.`}
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
                {cabinet.width_units}x{cabinet.height_units}
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
          <NumberInput
            label={t`Native location ID`}
            description={t`Existing structural StockLocation that anchors the cabinet.`}
            min={1}
            value={location}
            onChange={(value) =>
              setLocation(value === '' ? '' : Number(value) || '')
            }
          />
          <Group grow>
            <NumberInput
              label={t`Width (units)`}
              min={1}
              value={width}
              onChange={(value) => setWidth(Number(value) || 1)}
            />
            <NumberInput
              label={t`Height (units)`}
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
              disabled={!name || location === ''}
            >
              {t`Create`}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
