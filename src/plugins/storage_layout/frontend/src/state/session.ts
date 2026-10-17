/**
 * Locate-session and hardware-read-job lifecycle helpers.
 *
 * The backend dispatches locate/pixel-test sessions and observe/discovery jobs
 * to the background worker. A create request therefore returns a **pending**
 * document (`queued` for sessions, `pending` for jobs), and the frontend must
 * poll the durable status endpoint until it settles. These pure helpers define
 * the states and intervals used by the polling hooks, and are unit-tested
 * independently of React.
 */

import { t } from '@lingui/core/macro';

import { StorageLayoutApiError } from '../api/types';

/** Poll cadence for non-terminal sessions and jobs. */
export const POLL_INTERVAL_MS = 1000;

/** Session states after which polling can stop. */
export const SESSION_TERMINAL_STATES = [
  'stopped',
  'expired',
  'failed',
  'unknown'
] as const;

/** Session states which indicate work has not yet been applied. */
export const SESSION_PENDING_STATES = [
  'queued',
  'preflight',
  'applying'
] as const;

/** The live/simulated state in which pixels are lit. */
export const SESSION_ACTIVE_STATE = 'active';

/** Hardware read job states after which polling can stop. */
export const JOB_TERMINAL_STATES = ['complete', 'failed', 'expired'] as const;

export function isTerminalSessionState(
  state: string | undefined | null
): boolean {
  return (
    !!state && (SESSION_TERMINAL_STATES as readonly string[]).includes(state)
  );
}

export function isPendingSessionState(
  state: string | undefined | null
): boolean {
  return (
    !!state && (SESSION_PENDING_STATES as readonly string[]).includes(state)
  );
}

export function isTerminalJobState(state: string | undefined | null): boolean {
  return !!state && (JOB_TERMINAL_STATES as readonly string[]).includes(state);
}

/** A Mantine colour name for a session state badge. */
export function sessionStateColour(state: string | undefined | null): string {
  switch (state) {
    case SESSION_ACTIVE_STATE:
      return 'green';
    case 'stopping':
      return 'orange';
    case 'stopped':
      return 'gray';
    case 'expired':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'unknown':
      return 'red';
    case 'queued':
    case 'preflight':
    case 'applying':
      return 'blue';
    default:
      return 'gray';
  }
}

/** Human readable message for an API failure, keyed on the domain error code. */
export function describeApiError(error: unknown): string {
  if (error instanceof StorageLayoutApiError) {
    switch (error.code) {
      case 'cabinet_busy':
        return t`The cabinet is busy with another operation. Stop it and retry.`;
      case 'not_locatable':
        return t`The target is not mapped to an allocated drawer.`;
      case 'queue_unavailable':
        return t`The background task queue is unavailable. Retry later.`;
      case 'approval_required':
        return t`Live locate requires explicit approval.`;
      case 'not_armed':
        return t`The cabinet is not armed for live operation.`;
      case 'stale':
        return t`The mapping changed. Reload the page and retry.`;
      case 'forbidden':
        return t`You do not have permission to start this locate.`;
      case 'mapping_gap':
        return t`The cabinet has no active mapping.`;
      default:
        return error.message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}
