/**
 * Property inspector for the selected drawer or bin.
 *
 * Values are edited through explicit commands, so each change is undoable. The
 * native location is referenced by its InvenTree location PK; the inspector
 * only nudges the operator towards the native edit workflow - it never
 * reparents or creates native locations itself (design section 6).
 */

import { t } from '@lingui/core/macro';
import {
  Badge,
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput
} from '@mantine/core';
import type { AxiosInstance } from 'axios';

import type { BinDraft, DrawerDraft } from '../../state/commands';
import { formatRange, rangeCount } from '../../utils';
import { NativeLocationPicker } from './NativeLocationPicker';

export interface FieldChange {
  field: string;
  value: unknown;
}

export interface DrawerInspectorProps {
  api?: AxiosInstance;
  drawer: DrawerDraft;
  parentId?: number | null;
  totalPixels: number;
  readOnly: boolean;
  locationPath?: string;
  onField: (change: FieldChange) => void;
  onAllocate: (start: number | null, end: number | null) => void;
  onOpenLocation?: (locationId: number) => void;
  onEditLocation?: (locationId: number | null) => void;
  conflictIds?: string[];
}

function numericField(
  label: string,
  value: number,
  onChange: (value: number) => void,
  extras: { min?: number; readOnly?: boolean } = {}
) {
  return (
    <NumberInput
      key={label}
      label={label}
      size='xs'
      min={extras.min ?? 0}
      value={value}
      readOnly={extras.readOnly}
      onChange={(next) =>
        onChange(typeof next === 'number' ? next : Number(next) || 0)
      }
    />
  );
}

export function DrawerInspector({
  api,
  drawer,
  parentId,
  totalPixels,
  readOnly,
  locationPath,
  onField,
  onAllocate,
  onOpenLocation,
  onEditLocation,
  conflictIds = []
}: DrawerInspectorProps) {
  const allocation = drawer.allocation;

  return (
    <Stack gap='xs' data-testid='drawer-inspector'>
      <Group justify='space-between'>
        <Text fw={600}>{t`Drawer`}</Text>
        {drawer.archived ? (
          <Badge color='gray'>{t`Archived`}</Badge>
        ) : (
          <Badge color='blue'>{t`Active`}</Badge>
        )}
      </Group>

      <TextInput
        label={t`Label`}
        size='xs'
        value={drawer.label}
        readOnly={readOnly}
        onChange={(event) =>
          onField({ field: 'label', value: event.currentTarget.value })
        }
      />
      {numericField(
        t`Display number`,
        drawer.display_number,
        (value) => onField({ field: 'display_number', value }),
        { min: 1, readOnly }
      )}

      <Divider
        label={t`Front rectangle (logical units)`}
        labelPosition='center'
      />
      <Group grow>
        {numericField(
          t`X`,
          drawer.x,
          (value) => onField({ field: 'x', value }),
          {
            readOnly
          }
        )}
        {numericField(
          t`Y`,
          drawer.y,
          (value) => onField({ field: 'y', value }),
          {
            readOnly
          }
        )}
      </Group>
      <Group grow>
        {numericField(
          t`Width`,
          drawer.width,
          (value) => onField({ field: 'width', value }),
          { min: 1, readOnly }
        )}
        {numericField(
          t`Height`,
          drawer.height,
          (value) => onField({ field: 'height', value }),
          { min: 1, readOnly }
        )}
      </Group>

      <Divider
        label={t`Interior (top-down logical units)`}
        labelPosition='center'
      />
      <Group grow>
        {numericField(
          t`Interior width`,
          drawer.interior_width,
          (value) => onField({ field: 'interior_width', value }),
          { min: 1, readOnly }
        )}
        {numericField(
          t`Interior depth`,
          drawer.interior_height,
          (value) => onField({ field: 'interior_height', value }),
          { min: 1, readOnly }
        )}
      </Group>

      <Divider label={t`Native location`} labelPosition='center' />
      <Group grow align='flex-end'>
        <NativeLocationPicker
          api={api}
          label={t`Stock location`}
          value={drawer.location}
          structural
          parentId={parentId}
          disabled={readOnly}
          onChange={(value) => onField({ field: 'location', value })}
        />
        {onEditLocation ? (
          <Button
            size='xs'
            variant='default'
            disabled={readOnly}
            onClick={() => onEditLocation(drawer.location)}
          >
            {t`Edit native`}
          </Button>
        ) : null}
      </Group>
      {locationPath ? (
        <Group gap='xs'>
          <Text size='xs' c='dimmed'>
            {locationPath}
          </Text>
          {onOpenLocation && drawer.location ? (
            <Button
              size='compact-xs'
              variant='subtle'
              onClick={() => onOpenLocation(drawer.location as number)}
            >
              {t`Open`}
            </Button>
          ) : null}
        </Group>
      ) : drawer.location === null ? (
        <Text size='xs' c='yellow'>
          {t`Unbound: this drawer cannot resolve inventory until a structural native location is assigned.`}
        </Text>
      ) : null}

      <Divider label={t`Logical allocation`} labelPosition='center' />
      {totalPixels < 1 ? (
        <Text size='xs' c='dimmed'>
          {t`No active mapping. Publish a complete mapping before allocating LEDs.`}
        </Text>
      ) : (
        <>
          <Group grow align='flex-end'>
            <NumberInput
              label={t`Logical start`}
              size='xs'
              min={1}
              value={allocation?.logical_start ?? ''}
              readOnly={readOnly}
              onChange={(value) =>
                onAllocate(
                  value === '' ? null : Number(value) || null,
                  allocation?.logical_end ?? null
                )
              }
            />
            <NumberInput
              label={t`Logical end`}
              size='xs'
              min={1}
              value={allocation?.logical_end ?? ''}
              readOnly={readOnly}
              onChange={(value) =>
                onAllocate(
                  allocation?.logical_start ?? null,
                  value === '' ? null : Number(value) || null
                )
              }
            />
          </Group>
          <Group gap='xs'>
            <Button
              size='xs'
              variant='default'
              disabled={readOnly}
              aria-label={t`Clear allocation`}
              onClick={() => onAllocate(null, null)}
            >
              {t`Clear allocation`}
            </Button>
            {allocation ? (
              <Badge variant='light'>
                {t`${rangeCount(allocation.logical_start, allocation.logical_end)} LEDs (${formatRange(allocation.logical_start, allocation.logical_end)})`}
              </Badge>
            ) : (
              <Text size='xs' c='dimmed'>
                {t`Unlit drawer`}
              </Text>
            )}
          </Group>
        </>
      )}

      {conflictIds.length > 0 ? (
        <Paper withBorder p='xs' bg='red.0'>
          <Text size='xs' c='red'>
            {t`Allocation conflicts with another drawer.`}
          </Text>
        </Paper>
      ) : null}
    </Stack>
  );
}

export interface BinInspectorProps {
  api?: AxiosInstance;
  bin: BinDraft;
  parentId?: number | null;
  inheritedRange: { logical_start: number; logical_end: number } | null;
  readOnly: boolean;
  locationPath?: string;
  onField: (change: FieldChange) => void;
  onOpenLocation?: (locationId: number) => void;
  onEditLocation?: (locationId: number | null) => void;
  stockCount?: number | null;
}

export function BinInspector({
  api,
  bin,
  parentId,
  inheritedRange,
  readOnly,
  locationPath,
  onField,
  onOpenLocation,
  onEditLocation,
  stockCount
}: BinInspectorProps) {
  return (
    <Stack gap='xs' data-testid='bin-inspector'>
      <Group justify='space-between'>
        <Text fw={600}>{t`Bin`}</Text>
        {bin.location === null ? (
          <Badge color='yellow'>{t`Unbound`}</Badge>
        ) : (
          <Badge color='blue'>{t`Bound`}</Badge>
        )}
      </Group>

      <TextInput
        label={t`Label`}
        size='xs'
        value={bin.label}
        readOnly={readOnly}
        onChange={(event) =>
          onField({ field: 'label', value: event.currentTarget.value })
        }
      />

      <Divider label={t`Rectangle (logical units)`} labelPosition='center' />
      <Group grow>
        {numericField(t`X`, bin.x, (value) => onField({ field: 'x', value }), {
          readOnly
        })}
        {numericField(t`Y`, bin.y, (value) => onField({ field: 'y', value }), {
          readOnly
        })}
      </Group>
      <Group grow>
        {numericField(
          t`Width`,
          bin.width,
          (value) => onField({ field: 'width', value }),
          {
            min: 1,
            readOnly
          }
        )}
        {numericField(
          t`Height`,
          bin.height,
          (value) => onField({ field: 'height', value }),
          { min: 1, readOnly }
        )}
      </Group>

      <Divider label={t`Native location`} labelPosition='center' />
      <Group grow align='flex-end'>
        <NativeLocationPicker
          api={api}
          label={t`Stock location`}
          value={bin.location}
          structural={false}
          parentId={parentId}
          disabled={readOnly}
          onChange={(value) => onField({ field: 'location', value })}
        />
        {onEditLocation ? (
          <Button
            size='xs'
            variant='default'
            disabled={readOnly}
            onClick={() => onEditLocation(bin.location)}
          >
            {t`Edit native`}
          </Button>
        ) : null}
      </Group>
      {locationPath ? (
        <Group gap='xs'>
          <Text size='xs' c='dimmed'>
            {locationPath}
          </Text>
          {onOpenLocation && bin.location ? (
            <Button
              size='compact-xs'
              variant='subtle'
              onClick={() => onOpenLocation(bin.location as number)}
            >
              {t`Open`}
            </Button>
          ) : null}
        </Group>
      ) : null}
      {stockCount !== undefined && stockCount !== null ? (
        <Text size='xs' c='dimmed'>
          {t`${stockCount} stock item(s) at this location (informational).`}
        </Text>
      ) : null}

      <Divider label={t`Inherited LED range`} labelPosition='center' />
      {inheritedRange ? (
        <Badge variant='light' color='green' data-testid='inherited-range'>
          {t`${formatRange(inheritedRange.logical_start, inheritedRange.logical_end)} (${rangeCount(inheritedRange.logical_start, inheritedRange.logical_end)})`}
        </Badge>
      ) : (
        <Text size='xs' c='dimmed'>
          {t`Drawer has no allocation.`}
        </Text>
      )}
      <Text size='xs' c='dimmed'>
        {t`Bins inherit the drawer's locating behaviour; per-bin overrides are not supported in v1.`}
      </Text>
    </Stack>
  );
}
