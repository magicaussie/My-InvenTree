"""Django-Q2 task entry points for the Storage Layout & WLED plugin.

These functions are the durable worker entry points referenced by
:mod:`storage_layout.services`. They are deliberately thin: all business logic
lives in the service layer, and every function is safe to run more than once
(the service layer re-checks the durable row's state before acting, so a
duplicate or delayed task never re-drives an operation that has progressed).

Nothing here opens a socket. Live hardware access is only reached through the
service layer's fail-closed adapter gate.
"""

from __future__ import annotations

import time
from typing import Any

from django.core.cache import cache
from django.utils import timezone

import structlog

logger = structlog.get_logger('inventree')

#: Cache key guarding the bounded watchdog loop against overlapping runs.
WATCHDOG_LOCK_KEY = 'storage_layout_watchdog_lock'

#: Default bounded watchdog loop duration (seconds). django-q schedules at
#: minute granularity, so a single scheduled task starts a bounded loop which
#: sweeps every ``interval_seconds`` for at most this long.
WATCHDOG_DURATION_SECONDS = 55

#: Default watchdog sweep interval (seconds).
WATCHDOG_INTERVAL_SECONDS = 5


def run_session_task(session_id: str) -> dict[str, Any]:
    """Execute a durable locate/test session.

    Args:
        session_id: The session primary key.

    Returns:
        A bounded result summary.
    """
    from storage_layout import services

    session = services.execute_session(session_id)

    if session is None:
        return {'session': session_id, 'state': 'missing'}

    return {'session': session_id, 'state': session.state}


def run_read_job_task(job_id: str) -> dict[str, Any]:
    """Execute a durable hardware read job.

    Args:
        job_id: The read job primary key.

    Returns:
        A bounded result summary.
    """
    from storage_layout import services

    job = services.execute_read_job(job_id)

    if job is None:
        return {'job': job_id, 'state': 'missing'}

    return {'job': job_id, 'state': job.state}


def watchdog_loop(
    duration_seconds: int = WATCHDOG_DURATION_SECONDS,
    interval_seconds: int = WATCHDOG_INTERVAL_SECONDS,
) -> dict[str, Any]:
    """Run a bounded reconciliation sweep loop.

    A single scheduled task starts this bounded loop, which sweeps every
    ``interval_seconds`` for at most ``duration_seconds`` and then exits. A
    cache lock guarantees that only one loop runs at a time, so a slow or
    duplicated schedule cannot stack sweeps.

    Args:
        duration_seconds: Maximum loop lifetime.
        interval_seconds: Sweep interval.

    Returns:
        A bounded summary of the sweeps performed.
    """
    from storage_layout import services

    if not services.watchdog_enabled():
        return {'skipped': 'disabled', 'sweeps': 0}

    duration = max(1, int(duration_seconds))
    interval = max(1, int(interval_seconds))

    if not cache.add(WATCHDOG_LOCK_KEY, '1', timeout=duration + 30):
        return {'skipped': 'locked', 'sweeps': 0}

    sweeps = 0
    expired_sessions = 0
    live_cleanups = 0

    try:
        deadline = time.monotonic() + duration
        if cache.add('storage_layout_audit_retention', True, timeout=86400):
            try:
                services.prune_old_audits()
            except Exception:
                # Audit maintenance must never interrupt hardware cleanup.
                cache.delete('storage_layout_audit_retention')
                logger.exception('Storage layout audit retention failed')

        while True:
            cache.set(
                'storage_layout_watchdog_heartbeat',
                timezone.now().timestamp(),
                timeout=15,
            )
            result = services.reconcile_operations()
            sweeps += 1
            expired_sessions += int(result.get('expired_sessions', 0))
            live_cleanups += int(result.get('live_cleanups', 0))

            remaining = deadline - time.monotonic()

            if remaining <= 0:
                break

            time.sleep(min(interval, remaining))
    finally:
        cache.delete(WATCHDOG_LOCK_KEY)

    return {
        'sweeps': sweeps,
        'expired_sessions': expired_sessions,
        'live_cleanups': live_cleanups,
    }
