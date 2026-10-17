/**
 * Shared designer toolbar.
 *
 * Buttons have accessible names and the toolbar exposes the same actions as
 * the keyboard shortcuts documented on the designer screens (design section 6).
 */

import { t } from '@lingui/core/macro';
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  NumberInput,
  Switch,
  Tooltip
} from '@mantine/core';

export interface EditorToolbarProps {
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  snap: boolean;
  grid: number;
  onToggleSnap: (value: boolean) => void;
  onGridChange: (value: number) => void;
  onAdd: () => void;
  addLabel: string;
  onDuplicate: () => void;
  duplicateDisabled: boolean;
  onArchive: () => void;
  archiveLabel: string;
  archiveDisabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onValidate?: () => void;
  onRenumber?: () => void;
  onSave: () => void;
  onRevert: () => void;
  extra?: React.ReactNode;
}

export function EditorToolbar(props: EditorToolbarProps) {
  const {
    readOnly,
    dirty,
    saving,
    canUndo,
    canRedo,
    snap,
    grid,
    onToggleSnap,
    onGridChange,
    onAdd,
    addLabel,
    onDuplicate,
    duplicateDisabled,
    onArchive,
    archiveLabel,
    archiveDisabled,
    onUndo,
    onRedo,
    onValidate,
    onRenumber,
    onSave,
    onRevert,
    extra
  } = props;

  return (
    <Group gap='xs' wrap='wrap' role='toolbar' aria-label={t`Designer toolbar`}>
      <Button
        size='xs'
        onClick={onAdd}
        disabled={readOnly}
        aria-label={addLabel}
      >
        {addLabel}
      </Button>
      <Button
        size='xs'
        variant='default'
        onClick={onDuplicate}
        disabled={readOnly || duplicateDisabled}
        aria-label={t`Duplicate selection`}
      >
        {t`Duplicate`}
      </Button>
      <Button
        size='xs'
        variant='default'
        color='red'
        onClick={onArchive}
        disabled={readOnly || archiveDisabled}
        aria-label={archiveLabel}
      >
        {archiveLabel}
      </Button>

      <Divider orientation='vertical' />

      <Tooltip label={t`Undo (Ctrl+Z)`}>
        <ActionIcon
          variant='default'
          aria-label={t`Undo`}
          disabled={readOnly || !canUndo}
          onClick={onUndo}
        >
          {'\u21b6'}
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t`Redo (Ctrl+Shift+Z)`}>
        <ActionIcon
          variant='default'
          aria-label={t`Redo`}
          disabled={readOnly || !canRedo}
          onClick={onRedo}
        >
          {'\u21b7'}
        </ActionIcon>
      </Tooltip>

      <Divider orientation='vertical' />

      <Switch
        size='xs'
        checked={snap}
        onChange={(event) => onToggleSnap(event.currentTarget.checked)}
        label={t`Snap`}
        aria-label={t`Snap to grid`}
      />
      <NumberInput
        size='xs'
        w={90}
        min={1}
        value={grid}
        onChange={(value) =>
          onGridChange(typeof value === 'number' ? value : Number(value) || 1)
        }
        aria-label={t`Grid size`}
      />

      {onRenumber ? (
        <Button
          size='xs'
          variant='default'
          onClick={onRenumber}
          disabled={readOnly}
          aria-label={t`Renumber preview`}
        >
          {t`Renumber`}
        </Button>
      ) : null}

      {onValidate ? (
        <Button
          size='xs'
          variant='default'
          onClick={onValidate}
          aria-label={t`Validate layout`}
        >
          {t`Validate`}
        </Button>
      ) : null}

      {extra}

      <Group gap='xs' ml='auto'>
        {dirty ? (
          <Badge color='orange' variant='light'>
            {t`Unsaved changes`}
          </Badge>
        ) : (
          <Badge color='green' variant='light'>
            {t`Saved`}
          </Badge>
        )}
        <Button
          size='xs'
          variant='default'
          onClick={onRevert}
          disabled={readOnly || !dirty}
          aria-label={t`Revert changes`}
        >
          {t`Revert`}
        </Button>
        <Button
          size='xs'
          onClick={onSave}
          loading={saving}
          disabled={readOnly}
          aria-label={t`Save layout`}
        >
          {t`Save`}
        </Button>
      </Group>
    </Group>
  );
}
