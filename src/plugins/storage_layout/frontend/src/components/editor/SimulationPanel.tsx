/**
 * Simulation and diagnostic controls.
 *
 * The default is simulation: no sockets are opened and no controller is
 * contacted. Live actions are opt-in, individually approved, and clearly
 * badged. This panel reuses the exact session/status protocol owned by the
 * backend; it never claims a successful clear without an acknowledgement
 * (design sections 9 and 10).
 */

import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  generateIdempotencyKey,
  type StorageLayoutClient
} from '../../api/client';
import type {
  HardwareReadJob,
  LocateMode,
  LocateSession,
  TargetKind
} from '../../api/types';
import type { StringTopology } from '../../state/mapping';
import {
  describeApiError,
  isPendingSessionState,
  isTerminalJobState,
  isTerminalSessionState,
  POLL_INTERVAL_MS,
  sessionStateColour
} from '../../state/session';
import { formatRange } from '../../utils';

export interface SimulationPanelProps {
  client: StorageLayoutClient;
  cabinetId: string;
  totalPixels: number;
  mappingHash: string | null;
  topology: StringTopology[];
  readOnly: boolean;
  /** Drawer/location/item most recently selected in the designer canvas. */
  defaultTarget?: { kind: TargetKind; id: string } | null;
}

export function SimulationPanel({
  client,
  cabinetId,
  totalPixels,
  mappingHash,
  topology,
  readOnly,
  defaultTarget
}: SimulationPanelProps) {
  const [mode, setMode] = useState<LocateMode>('simulate');
  const [approveLive, setApproveLive] = useState(false);
  const [targetKind, setTargetKind] = useState<TargetKind>('drawer');
  const [targetId, setTargetId] = useState(defaultTarget?.id ?? '');
  const [duration, setDuration] = useState(120);
  const [testPattern, setTestPattern] = useState<'range' | 'walk'>('range');
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(Math.max(1, totalPixels));
  const [session, setSession] = useState<LocateSession | null>(null);
  const [job, setJob] = useState<HardwareReadJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controllerId, setControllerId] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (defaultTarget) {
      setTargetKind(defaultTarget.kind);
      setTargetId(defaultTarget.id);
    }
  }, [defaultTarget]);

  const controllers = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of topology) {
      map.set(node.output.controller.id, node.output.controller.name);
    }
    return [...map.entries()].map(([id, name]) => ({ value: id, label: name }));
  }, [topology]);

  const isLive = mode === 'live';
  const liveBlocked = isLive && (!approveLive || readOnly);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const stopJobPolling = useCallback(() => {
    if (jobPollRef.current) {
      clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  }, []);

  useEffect(() => stopJobPolling, [stopJobPolling]);

  const pollSession = useCallback(
    async (id: string) => {
      try {
        const next = await client.getLocateSession(id);
        setSession(next);
        if (isTerminalSessionState(next.state)) {
          stopPolling();
        }
      } catch {
        stopPolling();
      }
    },
    [client, stopPolling]
  );

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = setInterval(
        () => void pollSession(id),
        POLL_INTERVAL_MS
      );
    },
    [pollSession, stopPolling]
  );

  // Hardware read jobs (observe / discovery) are dispatched to the worker and
  // start pending, so poll the durable job until it settles.
  const startJobPolling = useCallback(
    (id: string) => {
      stopJobPolling();
      jobPollRef.current = setInterval(() => {
        client
          .getJob(id)
          .then((next) => {
            setJob(next);
            if (isTerminalJobState(next.state)) stopJobPolling();
          })
          .catch(() => stopJobPolling());
      }, POLL_INTERVAL_MS);
    },
    [client, stopJobPolling]
  );

  const handleError = (error: unknown) => {
    setMessage(describeApiError(error));
  };

  const locate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await client.createLocateSession({
        cabinet: cabinetId,
        target: { kind: targetKind, id: targetId },
        mode,
        mapping_hash: mappingHash ?? '',
        duration_seconds: duration,
        idempotency_key: generateIdempotencyKey(),
        approve_live: approveLive
      });
      setSession(created);
      startPolling(created.id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const pixelTest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await client.pixelTest({
        pattern: testPattern,
        cabinet: cabinetId,
        logical_start: rangeStart,
        logical_end: rangeEnd,
        mode,
        mapping_hash: mappingHash ?? '',
        idempotency_key: generateIdempotencyKey(),
        approve_live: approveLive
      });
      setSession(created);
      startPolling(created.id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const next = await client.stopLocateSession(session.id);
      setSession(next);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const emergencyStop = async () => {
    setBusy(true);
    try {
      await client.stopCabinet(cabinetId);
      setMessage('Cabinet stop requested.');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const observe = async () => {
    if (!controllerId) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await client.observeController(controllerId, mode);
      setJob(created);
      startJobPolling(created.id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const discovery = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await client.discovery({ cabinet: cabinetId, mode });
      setJob(created);
      startJobPolling(created.id);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const arm = async () => {
    if (!controllerId) return;
    setBusy(true);
    try {
      const result = await client.armCabinet(cabinetId, {
        controllers: [controllerId]
      });
      setMessage(`Armed until ${result.armed_until}.`);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const disarm = async () => {
    setBusy(true);
    try {
      await client.disarmCabinet(cabinetId);
      setMessage('Disarmed.');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap='sm' data-testid='simulation-panel'>
      <Group justify='space-between'>
        <Group gap='xs'>
          <Text fw={600}>{t`Diagnostics`}</Text>
          <Badge color={isLive ? 'red' : 'teal'} variant='filled'>
            {isLive ? t`LIVE` : t`SIMULATION`}
          </Badge>
        </Group>
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
          aria-label={t`Mode`}
        />
      </Group>

      {isLive ? (
        <Alert color='red' title={t`Live mode`}>
          <Stack gap='xs'>
            <Text size='sm'>
              {t`Live actions write to hardware. The controller must be armed, in a supported configuration and exclusively owned. A crash can leave pixels lit until the device backup timer expires.`}
            </Text>
            <Checkbox
              size='xs'
              checked={approveLive}
              disabled={readOnly}
              onChange={(event) => setApproveLive(event.currentTarget.checked)}
              label={t`I approve this live operation`}
            />
          </Stack>
        </Alert>
      ) : (
        <Text size='sm' c='dimmed'>
          {t`Simulation uses the production translator and session state machine with a fake transport. No network access is performed.`}
        </Text>
      )}

      {message ? (
        <Alert color='blue' withCloseButton onClose={() => setMessage(null)}>
          {message}
        </Alert>
      ) : null}

      <Card withBorder padding='sm'>
        <Stack gap='xs'>
          <Group gap='xs' align='flex-end'>
            <Select
              size='xs'
              label={t`Target kind`}
              data={[
                { value: 'drawer', label: t`Drawer` },
                { value: 'location', label: t`Location` },
                { value: 'item', label: t`Stock item` }
              ]}
              value={targetKind}
              onChange={(value) => setTargetKind(value as TargetKind)}
              aria-label={t`Target kind`}
            />
            <TextInput
              size='xs'
              label={t`Target id`}
              value={targetId}
              onChange={(event) => setTargetId(event.currentTarget.value)}
              aria-label={t`Target id`}
            />
            <NumberInput
              size='xs'
              w={120}
              label={t`Duration (s)`}
              min={1}
              max={120}
              value={duration}
              onChange={(value) => setDuration(Number(value) || 1)}
            />
            <Button
              size='xs'
              onClick={() => void locate()}
              loading={busy}
              disabled={liveBlocked || !targetId}
            >
              {t`Locate`}
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder padding='sm'>
        <Stack gap='xs'>
          <Text size='sm' fw={600}>
            {t`Pixel test / translate range`}
          </Text>
          <Group gap='xs' align='flex-end'>
            <NumberInput
              size='xs'
              w={100}
              label={t`Start`}
              min={1}
              value={rangeStart}
              onChange={(value) => setRangeStart(Number(value) || 1)}
            />
            <NumberInput
              size='xs'
              w={100}
              label={t`End`}
              min={1}
              value={rangeEnd}
              onChange={(value) => setRangeEnd(Number(value) || 1)}
            />
            <Select
              size='xs'
              label={t`Test pattern`}
              value={testPattern}
              data={[
                { value: 'range', label: t`Range / single pixel` },
                { value: 'walk', label: t`Walk (maximum 32 pixels)` }
              ]}
              onChange={(value) =>
                setTestPattern(value === 'walk' ? 'walk' : 'range')
              }
            />
            <Button
              size='xs'
              variant='default'
              onClick={() => void pixelTest()}
              loading={busy}
              disabled={liveBlocked}
            >
              {t`Run pixel test`}
            </Button>
          </Group>
        </Stack>
      </Card>

      {session?.plan?.frames?.length ? (
        <Text size='xs'>
          {t`Walking sequence`}:{' '}
          {session.plan.frames
            .map(
              (frame) =>
                `L${frame.logical_pixel} @ ${frame.offset_seconds.toFixed(2)}s`
            )
            .join(' → ')}
        </Text>
      ) : null}
      {session ? (
        <Card withBorder padding='sm' data-testid='session-status'>
          <Stack gap='xs'>
            <Group gap='xs'>
              <Text size='sm' fw={600}>
                {t`Session ${session.id.slice(0, 8)}…`}
              </Text>
              <Badge color={sessionStateColour(session.state)} variant='filled'>
                {session.state}
              </Badge>
              <Badge color='red' variant='light'>
                {session.mode ?? mode}
              </Badge>
              <Text size='xs' c='dimmed'>
                {t`expires ${session.expires_at}`}
              </Text>
            </Group>
            {isPendingSessionState(session.state) ? (
              <Text size='xs' c='dimmed' data-testid='session-pending'>
                {t`Request queued; waiting for the background worker…`}
              </Text>
            ) : null}
            {session.target?.label ? (
              <Text size='xs' c='dimmed'>
                {t`target ${session.target.kind} ${session.target.label}`}
              </Text>
            ) : null}
            {session.executions?.map((execution) => (
              <Group key={execution.controller} gap='xs'>
                <Badge size='xs' variant='light'>
                  {execution.controller.slice(0, 8)}
                </Badge>
                <Text size='xs'>{execution.state}</Text>
                {execution.clear_status ? (
                  <Text size='xs' c='dimmed'>
                    {t`clear: ${execution.clear_status}`}
                  </Text>
                ) : null}
              </Group>
            ))}
            {session.plan?.runs && session.plan.runs.length > 0 ? (
              <Stack gap={2} data-testid='session-plan-runs'>
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
                onClick={() => void stopSession()}
                disabled={busy}
              >
                {t`Stop session`}
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}

      <Group>
        <Button
          size='xs'
          color='red'
          variant='light'
          onClick={() => void emergencyStop()}
          disabled={readOnly}
        >
          {t`Emergency cabinet stop`}
        </Button>
      </Group>

      <Divider label={t`Hardware reads and arming`} labelPosition='center' />

      <Group gap='xs' align='flex-end'>
        <Select
          size='xs'
          label={t`Controller`}
          data={controllers}
          value={controllerId}
          onChange={(value) => setControllerId(value ?? '')}
          placeholder={t`Select controller`}
          aria-label={t`Controller`}
        />
        <Button size='xs' variant='default' onClick={() => void observe()}>
          {t`Observe (${mode})`}
        </Button>
        <Button size='xs' variant='default' onClick={() => void discovery()}>
          {t`Discovery (${mode})`}
        </Button>
        <Button
          size='xs'
          variant='default'
          onClick={() => void arm()}
          disabled={readOnly || !controllerId}
        >
          {t`Arm`}
        </Button>
        <Button
          size='xs'
          variant='default'
          onClick={() => void disarm()}
          disabled={readOnly}
        >
          {t`Disarm`}
        </Button>
      </Group>

      {job ? (
        <Alert color='blue' title={t`Hardware read job`} data-testid='read-job'>
          <Stack gap={2}>
            <Group gap='xs'>
              <Text size='sm'>
                {job.kind} - {job.state} ({job.mode})
              </Text>
              {!isTerminalJobState(job.state) ? (
                <Badge size='xs' color='blue' variant='light'>
                  {t`polling`}
                </Badge>
              ) : null}
            </Group>
            {job.error ? (
              <Text size='sm' c='red'>
                {typeof job.error === 'string'
                  ? job.error
                  : JSON.stringify(job.error)}
              </Text>
            ) : null}
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  );
}
