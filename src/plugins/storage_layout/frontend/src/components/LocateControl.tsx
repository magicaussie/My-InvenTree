/**
 * Reusable locate control.
 *
 * Used by the stock location panel and the stock item panel to start an
 * **actor-safe** locate session through the plugin's authenticated session API
 * (`POST locate-sessions/`) rather than the native `LocateMixin` hook, which
 * loses the initiating user. Because the backend dispatches sessions to the
 * background worker, the control polls the durable session status until it
 * settles (`queued` -> `active` -> `stopped`/`expired`).
 */

import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  SegmentedControl,
  Stack,
  Text
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  generateIdempotencyKey,
  type StorageLayoutClient
} from '../api/client';
import type { LocateMode, LocateSession, TargetKind } from '../api/types';
import {
  describeApiError,
  isPendingSessionState,
  isTerminalSessionState,
  POLL_INTERVAL_MS,
  sessionStateColour
} from '../state/session';
import { formatRange } from '../utils';

export interface LocateControlProps {
  client: StorageLayoutClient;
  /** Locate target. When null the control is disabled. */
  target: { kind: TargetKind; id: string } | null;
  /** Cabinet that owns the target; required by the session API. */
  cabinetId: string | null;
  mappingHash?: string | null;
  durationSeconds?: number;
  readOnly?: boolean;
  /** Label for the primary action button. */
  actionLabel?: string;
}

export function LocateControl({
  client,
  target,
  cabinetId,
  mappingHash,
  durationSeconds = 120,
  readOnly = false,
  actionLabel
}: LocateControlProps) {
  const [mode, setMode] = useState<LocateMode>('simulate');
  const [approveLive, setApproveLive] = useState(false);
  const [session, setSession] = useState<LocateSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const terminal = session ? isTerminalSessionState(session.state) : true;

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Poll a non-terminal session until it settles.
  useEffect(() => {
    if (!session || terminal) {
      stopPolling();
      return;
    }

    const sessionId = session.id;
    stopPolling();
    pollingRef.current = setInterval(() => {
      client
        .getLocateSession(sessionId)
        .then((next) => setSession(next))
        .catch(() => stopPolling());
    }, POLL_INTERVAL_MS);

    return stopPolling;
  }, [client, session?.id, terminal, stopPolling, session]);

  const liveBlocked = mode === 'live' && (!approveLive || readOnly);
  const disabled = readOnly || !target || !cabinetId || liveBlocked || busy;
  const label = actionLabel ?? t`Locate`;

  const run = useCallback(async () => {
    if (!target || !cabinetId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.createLocateSession({
        cabinet: cabinetId,
        target,
        mode,
        mapping_hash: mappingHash ?? '',
        duration_seconds: durationSeconds,
        idempotency_key: generateIdempotencyKey(),
        approve_live: approveLive
      });
      setSession(created);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }, [
    approveLive,
    cabinetId,
    client,
    durationSeconds,
    mappingHash,
    mode,
    target
  ]);

  const stop = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.stopLocateSession(session.id);
      setSession(next);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }, [client, session]);

  return (
    <Stack gap='xs' data-testid='locate-control'>
      {target && cabinetId ? (
        <Group gap='xs'>
          <SegmentedControl
            size='xs'
            value={mode}
            onChange={(value) => {
              setMode(value as LocateMode);
              setApproveLive(false);
            }}
            data={[
              { value: 'simulate', label: t`Simulate` },
              { value: 'live', label: t`Live` }
            ]}
            aria-label={t`Locate mode`}
          />
          <Badge color={mode === 'live' ? 'red' : 'teal'} variant='filled'>
            {mode === 'live' ? t`LIVE` : t`SIMULATION`}
          </Badge>
          <Button
            size='xs'
            onClick={() => void run()}
            loading={busy}
            disabled={disabled}
            aria-label={label}
          >
            {label}
          </Button>
        </Group>
      ) : (
        <Text size='sm' c='dimmed'>
          {cabinetId
            ? t`This item is not mapped to a locatable drawer.`
            : t`No cabinet mapping is available for this location.`}
        </Text>
      )}

      {mode === 'live' && target && cabinetId ? (
        <Alert color='red' title={t`Live mode`}>
          <Stack gap='xs'>
            <Text size='sm'>
              {t`Live actions write to hardware and require an armed, exclusively owned controller. A crash can leave pixels lit until the device backup timer expires.`}
            </Text>
            <Checkbox
              size='xs'
              checked={approveLive}
              disabled={readOnly}
              onChange={(event) => setApproveLive(event.currentTarget.checked)}
              label={t`I approve this live locate`}
            />
          </Stack>
        </Alert>
      ) : null}

      {error ? (
        <Alert color='red' withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      {session ? (
        <Stack gap='xs' data-testid='locate-session'>
          <Group gap='xs'>
            <Badge color={sessionStateColour(session.state)} variant='filled'>
              {session.state}
            </Badge>
            {isPendingSessionState(session.state) ? (
              <Text size='xs' c='dimmed' data-testid='locate-pending'>
                {t`Request queued; waiting for the background worker…`}
              </Text>
            ) : null}
            <Text size='xs' c='dimmed'>
              {t`expires ${session.expires_at}`}
            </Text>
          </Group>

          {session.executions?.map((execution) => (
            <Group key={execution.controller} gap='xs'>
              <Text size='xs' c='dimmed'>
                {execution.controller.slice(0, 8)}
              </Text>
              <Text size='xs'>{execution.state}</Text>
              {execution.clear_status &&
              execution.clear_status !== 'not-required' ? (
                <Text size='xs' c='dimmed'>
                  {t`clear: ${execution.clear_status}`}
                </Text>
              ) : null}
            </Group>
          ))}

          {session.plan?.runs && session.plan.runs.length > 0 ? (
            <Stack gap={2} data-testid='locate-runs'>
              {session.plan.runs.map((run) => (
                <Text size='xs' key={run.logical_start}>
                  L{formatRange(run.logical_start, run.logical_end)} →{' '}
                  {run.controller}:{run.wled_start}-{run.wled_stop}
                </Text>
              ))}
            </Stack>
          ) : null}

          <Group>
            <Button
              size='xs'
              variant='default'
              onClick={() => void stop()}
              disabled={busy || terminal}
              aria-label={t`Stop locate`}
            >
              {t`Stop`}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Stack>
  );
}
