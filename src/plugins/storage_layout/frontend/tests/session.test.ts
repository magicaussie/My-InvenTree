import { describe, expect, it } from 'vitest';

import { StorageLayoutApiError } from '../src/api/types';
import {
  describeApiError,
  isPendingSessionState,
  isTerminalJobState,
  isTerminalSessionState,
  sessionStateColour
} from '../src/state/session';

describe('session lifecycle helpers', () => {
  it('classifies terminal and pending session states', () => {
    for (const state of ['stopped', 'expired', 'failed', 'unknown']) {
      expect(isTerminalSessionState(state)).toBe(true);
      expect(isPendingSessionState(state)).toBe(false);
    }

    expect(isTerminalSessionState('active')).toBe(false);
    expect(isTerminalSessionState('queued')).toBe(false);
    expect(isTerminalSessionState(null)).toBe(false);

    for (const state of ['queued', 'preflight', 'applying']) {
      expect(isPendingSessionState(state)).toBe(true);
      expect(isTerminalSessionState(state)).toBe(false);
    }

    expect(isPendingSessionState('active')).toBe(false);
  });

  it('classifies terminal job states', () => {
    for (const state of ['complete', 'failed', 'expired']) {
      expect(isTerminalJobState(state)).toBe(true);
    }
    expect(isTerminalJobState('pending')).toBe(false);
    expect(isTerminalJobState('running')).toBe(false);
    expect(isTerminalJobState(undefined)).toBe(false);
  });

  it('maps states to badge colours', () => {
    expect(sessionStateColour('active')).toBe('green');
    expect(sessionStateColour('queued')).toBe('blue');
    expect(sessionStateColour('stopping')).toBe('orange');
    expect(sessionStateColour('failed')).toBe('red');
    expect(sessionStateColour('stopped')).toBe('gray');
    expect(sessionStateColour(undefined)).toBe('gray');
  });

  it('describes domain API errors by code', () => {
    expect(
      describeApiError(
        new StorageLayoutApiError('busy', 409, { code: 'cabinet_busy' })
      )
    ).toMatch(/busy with another operation/);

    expect(
      describeApiError(
        new StorageLayoutApiError('x', 400, { code: 'not_locatable' })
      )
    ).toMatch(/not mapped to an allocated drawer/);

    expect(
      describeApiError(
        new StorageLayoutApiError('x', 503, { code: 'queue_unavailable' })
      )
    ).toMatch(/queue is unavailable/);

    // A raw error falls back to its message.
    expect(describeApiError(new StorageLayoutApiError('plain', 400, {}))).toBe(
      'plain'
    );
    expect(describeApiError(new Error('boom'))).toBe('boom');
    expect(describeApiError('nope')).toBe('nope');
  });
});
