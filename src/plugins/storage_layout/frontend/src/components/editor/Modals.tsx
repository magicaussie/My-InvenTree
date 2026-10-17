/**
 * Designer dialogs: bin grid generator, renumber preview, archive
 * confirmation and the save-conflict (HTTP 412) resolution dialog.
 */

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
import { useMemo, useState } from 'react';

import type { DrawerDraft } from '../../state/commands';
import {
  type GridPreview,
  generateGrid,
  type RectLike
} from '../../state/grid';

export interface GridGeneratorModalProps {
  opened: boolean;
  interior: { width: number; height: number };
  existing: RectLike[];
  onClose: () => void;
  onConfirm: (preview: GridPreview, labelPrefix: string) => void;
}

export function GridGeneratorModal({
  opened,
  interior,
  existing,
  onClose,
  onConfirm
}: GridGeneratorModalProps) {
  const [columns, setColumns] = useState(4);
  const [rows, setRows] = useState(2);
  const [gutter, setGutter] = useState(2);
  const [margin, setMargin] = useState(0);
  const [labelPrefix, setLabelPrefix] = useState('B');

  const preview = useMemo(
    () =>
      generateGrid(
        {
          interior,
          columns,
          rows,
          gutter,
          margin
        },
        existing
      ),
    [interior, columns, rows, gutter, margin, existing]
  );

  return (
    <Modal opened={opened} onClose={onClose} title={t`Generate bin grid`}>
      <Stack gap='sm'>
        <Group grow>
          <NumberInput
            label={t`Columns`}
            min={1}
            value={columns}
            onChange={(value) => setColumns(Number(value) || 1)}
          />
          <NumberInput
            label={t`Rows`}
            min={1}
            value={rows}
            onChange={(value) => setRows(Number(value) || 1)}
          />
        </Group>
        <Group grow>
          <NumberInput
            label={t`Gutter`}
            min={0}
            value={gutter}
            onChange={(value) => setGutter(Number(value) || 0)}
          />
          <NumberInput
            label={t`Margin`}
            min={0}
            value={margin}
            onChange={(value) => setMargin(Number(value) || 0)}
          />
        </Group>
        <TextInput
          label={t`Label prefix`}
          value={labelPrefix}
          onChange={(event) => setLabelPrefix(event.currentTarget.value)}
        />

        <Alert
          color={preview.fits ? 'blue' : 'orange'}
          title={preview.fits ? t`Grid preview` : t`Grid does not fit`}
        >
          <Stack gap={2}>
            <Text size='sm'>
              {t`${preview.cells.length} new bin(s) of ${preview.totalWidth}x${preview.totalHeight} units.`}
            </Text>
            {preview.collisions.length > 0 ? (
              <Text size='sm' c='orange'>
                {t`${preview.collisions.length} cell(s) skipped to avoid overwriting existing bins (${existing.length} present).`}
              </Text>
            ) : null}
            {!preview.fits ? (
              <Text size='sm' c='red'>
                {t`Reduce the counts or gutter so the grid fits the drawer interior.`}
              </Text>
            ) : null}
          </Stack>
        </Alert>

        <Group justify='flex-end'>
          <Button variant='default' onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button
            disabled={!preview.fits || preview.cells.length === 0}
            onClick={() => onConfirm(preview, labelPrefix)}
          >
            {t`Generate`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export interface RenumberModalProps {
  opened: boolean;
  drawers: DrawerDraft[];
  onClose: () => void;
  onConfirm: (assignments: { id: string; display_number: number }[]) => void;
}

/** Sort drawers row-major by (y, x, id) for the default renumber preview. */
export function defaultRenumberOrder(drawers: DrawerDraft[]): DrawerDraft[] {
  return [...drawers].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    return a.id.localeCompare(b.id);
  });
}

export function RenumberModal({
  opened,
  drawers,
  onClose,
  onConfirm
}: RenumberModalProps) {
  const ordered = useMemo(() => defaultRenumberOrder(drawers), [drawers]);
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  const assignments = ordered.map((drawer, index) => ({
    id: drawer.id,
    display_number: overrides[drawer.id] ?? index + 1
  }));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t`Renumber preview`}
      size='lg'
    >
      <Stack gap='sm'>
        <Text size='sm'>
          {t`Drawers are sorted top-to-bottom, left-to-right. Numbering changes only the display number; labels, native locations and LED ranges are left unchanged.`}
        </Text>
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t`Label`}</Table.Th>
              <Table.Th>{t`Current`}</Table.Th>
              <Table.Th>{t`New`}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {ordered.map((drawer, index) => (
              <Table.Tr key={drawer.id}>
                <Table.Td>{drawer.label}</Table.Td>
                <Table.Td>
                  <Badge variant='light'>{drawer.display_number}</Badge>
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size='xs'
                    min={1}
                    w={100}
                    value={overrides[drawer.id] ?? index + 1}
                    onChange={(value) =>
                      setOverrides((current) => ({
                        ...current,
                        [drawer.id]: Number(value) || 1
                      }))
                    }
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify='flex-end'>
          <Button variant='default' onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button onClick={() => onConfirm(assignments)}>
            {t`Apply numbering`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export interface ArchiveConfirmModalProps {
  opened: boolean;
  title: string;
  entityLabel: string;
  affected: string[];
  isNew: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ArchiveConfirmModal({
  opened,
  title,
  entityLabel,
  affected,
  isNew,
  onClose,
  onConfirm
}: ArchiveConfirmModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack gap='sm'>
        <Alert color='red' title={t`This does not delete inventory`}>
          {isNew
            ? t`The unsaved item will be removed from the draft.`
            : t`The item is archived in the layout overlay only. Native locations and stock items are never deleted.`}
        </Alert>
        <Text size='sm'>
          {affected.length > 0
            ? t`Affected ${entityLabel} and ${affected.length} related bin(s).`
            : t`Affected ${entityLabel}.`}
        </Text>
        <Group justify='flex-end'>
          <Button variant='default' onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button color='red' onClick={onConfirm}>
            {isNew ? t`Remove` : t`Archive`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export interface ConflictModalProps {
  opened: boolean;
  message: string | null;
  onReload: () => void;
  onDiscard: () => void;
  onClose: () => void;
}

export function ConflictModal({
  opened,
  message,
  onReload,
  onDiscard,
  onClose
}: ConflictModalProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t`Save conflict (stale revision)`}
    >
      <Stack gap='sm'>
        <Alert color='orange' title={t`The layout changed on the server`}>
          {message ??
            t`Another operator saved a newer revision. Your draft has been kept.`}
        </Alert>
        <Text size='sm'>
          {t`Reload the server revision to continue from the latest state, or discard your local draft. Edits are never merged automatically.`}
        </Text>
        <Group justify='flex-end'>
          <Button variant='default' onClick={onDiscard}>
            {t`Discard draft`}
          </Button>
          <Button onClick={onReload}>{t`Reload server revision`}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
