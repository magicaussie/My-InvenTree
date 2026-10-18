/**
 * Function colour configuration panel.
 *
 * Colours are configured through the product's real schema: a `LocateProfile`
 * carries a `purpose` (`locate`, `test` or `reserved`) plus an RGB/white colour,
 * brightness and duration. The panel edits those existing profiles - it never
 * invents API fields.
 *
 * Schema limitation (recorded honestly): the product schema distinguishes
 * locate / test / reserved purposes only. It does not model separate colours for
 * locate-drawer vs locate-bin, selection/identification, warning/error or
 * idle/clear. Those remain owner-input requirements rather than silently
 * invented fields.
 *
 * The panel performs no hardware I/O: it only reads and writes profile rows
 * through the plugin REST API.
 */

import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput
} from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';

import type { StorageLayoutClient } from '../../api/client';
import type { LocateProfile, ProfileCreate } from '../../api/types';

export interface FunctionColorsPanelProps {
  client: StorageLayoutClient;
  cabinetId: string;
  readOnly: boolean;
}

type Purpose = ProfileCreate['purpose'];

interface Draft {
  name: string;
  purpose: Purpose;
  rgb_r: number;
  rgb_g: number;
  rgb_b: number;
  white: number;
  brightness: number;
  duration_seconds: number;
}

function purposeOptions(): { value: Purpose; label: string }[] {
  return [
    { value: 'locate', label: t`Locate` },
    { value: 'test', label: t`Test` },
    { value: 'reserved', label: t`Reserved` }
  ];
}

function draftFromProfile(profile: LocateProfile): Draft {
  return {
    name: profile.name,
    purpose: profile.purpose,
    rgb_r: profile.rgb[0] ?? 0,
    rgb_g: profile.rgb[1] ?? 0,
    rgb_b: profile.rgb[2] ?? 0,
    white: profile.white,
    brightness: profile.brightness,
    duration_seconds: profile.duration_seconds
  };
}

function emptyDraft(): Draft {
  return {
    name: '',
    purpose: 'locate',
    rgb_r: 0,
    rgb_g: 255,
    rgb_b: 0,
    white: 0,
    brightness: 64,
    duration_seconds: 120
  };
}

function swatch(draft: Draft): string {
  return `rgb(${draft.rgb_r}, ${draft.rgb_g}, ${draft.rgb_b})`;
}

export function FunctionColorsPanel({
  client,
  cabinetId,
  readOnly
}: FunctionColorsPanelProps) {
  const [profiles, setProfiles] = useState<LocateProfile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [newProfile, setNewProfile] = useState<Draft>(emptyDraft);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);

    try {
      const response = await client.listProfiles(cabinetId);
      setProfiles(response.results);
      setDrafts(
        Object.fromEntries(
          response.results.map((profile) => [
            profile.id,
            draftFromProfile(profile)
          ])
        )
      );
      setStatus('ready');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('error');
    }
  }, [client, cabinetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateDraft = (id: string, change: Partial<Draft>) => {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...change }
    }));
  };

  const save = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;

    setError(null);
    setMessage(null);

    try {
      await client.updateProfile(id, draft);
      setMessage(t`Saved profile ${draft.name}`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const create = async () => {
    setError(null);
    setMessage(null);

    try {
      await client.createProfile({ cabinet: cabinetId, ...newProfile });
      setMessage(t`Created profile ${newProfile.name}`);
      setNewProfile(emptyDraft());
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Stack gap='sm' data-testid='function-colors-panel'>
      <Text size='sm' c='dimmed'>
        {t`Configure the colour, brightness and duration used for each function. Colours are stored as locate profiles (purposes: locate, test, reserved). The product schema does not model separate colours for locate-drawer vs locate-bin, selection, warning/error or idle/clear.`}
      </Text>

      {error ? (
        <Alert color='red' variant='light' data-testid='function-colors-error'>
          {error}
        </Alert>
      ) : null}
      {message ? (
        <Alert
          color='green'
          variant='light'
          data-testid='function-colors-message'
        >
          {message}
        </Alert>
      ) : null}

      {status === 'loading' ? (
        <Text size='sm'>{t`Loading profiles...`}</Text>
      ) : null}

      {status === 'ready' && profiles.length === 0 ? (
        <Text size='sm' c='dimmed' data-testid='function-colors-empty'>
          {t`No profiles yet. Create one below to set a function colour.`}
        </Text>
      ) : null}

      {profiles.length > 0 ? (
        <Table data-testid='function-colors-table'>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t`Name`}</Table.Th>
              <Table.Th>{t`Purpose`}</Table.Th>
              <Table.Th>{t`Colour`}</Table.Th>
              <Table.Th>{t`R`}</Table.Th>
              <Table.Th>{t`G`}</Table.Th>
              <Table.Th>{t`B`}</Table.Th>
              <Table.Th>{t`White`}</Table.Th>
              <Table.Th>{t`Brightness`}</Table.Th>
              <Table.Th>{t`Duration`}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {profiles.map((profile) => {
              const draft = drafts[profile.id] ?? draftFromProfile(profile);
              return (
                <Table.Tr
                  key={profile.id}
                  data-testid={`profile-row-${profile.id}`}
                >
                  <Table.Td>
                    <TextInput
                      aria-label={t`Profile name`}
                      value={draft.name}
                      disabled={readOnly}
                      onChange={(event) =>
                        updateDraft(profile.id, {
                          name: event.currentTarget.value
                        })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <Badge variant='light'>{draft.purpose}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Box
                      data-testid={`profile-swatch-${profile.id}`}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 4,
                        border: '1px solid var(--mantine-color-gray-4)',
                        background: swatch(draft)
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`Red`}
                      min={0}
                      max={255}
                      w={72}
                      value={draft.rgb_r}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, { rgb_r: Number(value) || 0 })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`Green`}
                      min={0}
                      max={255}
                      w={72}
                      value={draft.rgb_g}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, { rgb_g: Number(value) || 0 })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`Blue`}
                      min={0}
                      max={255}
                      w={72}
                      value={draft.rgb_b}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, { rgb_b: Number(value) || 0 })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`White`}
                      min={0}
                      max={255}
                      w={72}
                      value={draft.white}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, { white: Number(value) || 0 })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`Brightness`}
                      min={1}
                      max={255}
                      w={80}
                      value={draft.brightness}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, {
                          brightness: Number(value) || 1
                        })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      aria-label={t`Duration`}
                      min={1}
                      max={draft.purpose === 'test' ? 10 : 120}
                      error={
                        draft.purpose === 'test' &&
                        (draft.duration_seconds < 1 ||
                          draft.duration_seconds > 10)
                          ? t`Test profiles require a duration from 1 to 10 seconds.`
                          : undefined
                      }
                      w={80}
                      value={draft.duration_seconds}
                      disabled={readOnly}
                      onChange={(value) =>
                        updateDraft(profile.id, {
                          duration_seconds: Number(value) || 1
                        })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size='xs'
                      disabled={
                        readOnly ||
                        draft.duration_seconds < 1 ||
                        draft.duration_seconds >
                          (draft.purpose === 'test' ? 10 : 120)
                      }
                      onClick={() => void save(profile.id)}
                    >
                      {t`Save`}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      ) : null}

      <Divider label={t`Add a function colour`} labelPosition='left' />

      <Group align='flex-end' gap='sm' wrap='wrap'>
        <TextInput
          label={t`Name`}
          value={newProfile.name}
          disabled={readOnly}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setNewProfile((current) => ({ ...current, name: value }));
          }}
        />
        <Select
          label={t`Purpose`}
          data={purposeOptions()}
          value={newProfile.purpose}
          disabled={readOnly}
          onChange={(value) =>
            value &&
            setNewProfile((current) => ({
              ...current,
              purpose: value as Purpose,
              duration_seconds: Math.min(
                current.duration_seconds,
                value === 'test' ? 10 : 120
              )
            }))
          }
        />
        <NumberInput
          label={t`R`}
          min={0}
          max={255}
          w={72}
          value={newProfile.rgb_r}
          disabled={readOnly}
          onChange={(value) =>
            setNewProfile((current) => ({
              ...current,
              rgb_r: Number(value) || 0
            }))
          }
        />
        <NumberInput
          label={t`G`}
          min={0}
          max={255}
          w={72}
          value={newProfile.rgb_g}
          disabled={readOnly}
          onChange={(value) =>
            setNewProfile((current) => ({
              ...current,
              rgb_g: Number(value) || 0
            }))
          }
        />
        <NumberInput
          label={t`B`}
          min={0}
          max={255}
          w={72}
          value={newProfile.rgb_b}
          disabled={readOnly}
          onChange={(value) =>
            setNewProfile((current) => ({
              ...current,
              rgb_b: Number(value) || 0
            }))
          }
        />
        <NumberInput
          label={t`Brightness`}
          min={1}
          max={255}
          w={90}
          value={newProfile.brightness}
          disabled={readOnly}
          onChange={(value) =>
            setNewProfile((current) => ({
              ...current,
              brightness: Number(value) || 1
            }))
          }
        />
        <NumberInput
          label={t`Duration`}
          min={1}
          max={newProfile.purpose === 'test' ? 10 : 120}
          w={90}
          value={newProfile.duration_seconds}
          disabled={readOnly}
          onChange={(value) =>
            setNewProfile((current) => ({
              ...current,
              duration_seconds: Number(value) || 1
            }))
          }
        />
        <Button
          disabled={
            readOnly ||
            newProfile.name.trim() === '' ||
            newProfile.duration_seconds < 1 ||
            newProfile.duration_seconds >
              (newProfile.purpose === 'test' ? 10 : 120)
          }
          onClick={() => void create()}
        >
          {t`Create`}
        </Button>
      </Group>
    </Stack>
  );
}
