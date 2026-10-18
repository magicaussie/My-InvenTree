"""Real PostgreSQL/Q worker delivery and watchdog checks inside the sandbox.

Execute through manage.py shell after the API fixture run. No mocked queue,
manual reconciliation, network device or physical transport is used.
"""

import hashlib
import json
import os
import time
import uuid
from importlib.metadata import version
from pathlib import Path

from django.apps import apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.db.migrations.recorder import MigrationRecorder

from django_q.models import Task
from django_q.tasks import async_task
from storage_layout import services
from storage_layout.models import Cabinet, CabinetOperation, LocateSession

from plugin.registry import registry


def wait_for(predicate, timeout=30):
    """Wait for actual background processing, with a strict finite deadline."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError('Background worker condition timed out')


def main():
    """Verify real duplicate task delivery and scheduled session expiry."""
    assert connection.vendor == 'postgresql'
    assert settings.DATABASES['default']['NAME'] == 'sl001'
    assert apps.is_installed('storage_layout')
    plugin = registry.get_plugin('storage-layout')
    assert plugin is not None
    assert plugin.get_setting('ENABLE_HARDWARE') is False
    assert plugin.get_setting('DISPATCHER_ENABLED') is False
    assert settings.GLOBAL_CACHE_ENABLED
    assert settings.Q_CLUSTER['workers'] >= 4
    applied = sorted(
        name
        for app, name in MigrationRecorder(connection).applied_migrations()
        if app == 'storage_layout'
    )
    assert len(applied) == 3
    cabinet = Cabinet.objects.filter(active_mapping__isnull=False).latest('created_at')
    assert cabinet.operation.current_session_id is None
    drawer = cabinet.drawers.filter(archived=False, allocation__isnull=False).first()
    actor = get_user_model().objects.get(username='sl_admin')
    started = time.monotonic()
    session, created = services.create_locate_session(
        cabinet,
        actor,
        {
            'target': {'kind': 'drawer', 'id': str(drawer.pk)},
            'mode': 'simulate',
            'duration_seconds': 8,
            'mapping_hash': cabinet.active_mapping.content_hash,
            'idempotency_key': f'worker-evidence-{uuid.uuid4()}',
        },
    )
    assert created

    def active():
        session.refresh_from_db()
        return session.state == 'active'

    wait_for(active)
    initial_expiry = session.expires_at
    acknowledgements = list(
        session.executions.order_by('controller_id').values_list(
            'controller_id', 'acknowledged_at'
        )
    )
    assert acknowledgements
    tasks = [
        async_task('storage_layout.tasks.run_session_task', str(session.pk), sync=False)
        for _ in range(2)
    ]
    wait_for(lambda: Task.objects.filter(pk__in=tasks, success=True).count() == 2)
    session.refresh_from_db()
    assert session.expires_at == initial_expiry, 'Duplicate delivery reset the expiry'
    assert (
        list(
            session.executions.order_by('controller_id').values_list(
                'controller_id', 'acknowledged_at'
            )
        )
        == acknowledgements
    ), 'Duplicate delivery reapplied output'

    def expired():
        session.refresh_from_db()
        return session.state == 'expired'

    wait_for(expired, timeout=30)
    assert CabinetOperation.objects.get(cabinet=cabinet).current_session_id is None
    heartbeat = cache.get('storage_layout_watchdog_heartbeat')
    assert heartbeat and 0 <= time.time() - heartbeat < 15
    assert LocateSession.objects.filter(pk=session.pk).count() == 1
    # Exercise the actual production AppMixin unload/re-register path, not
    # only test_settings' permanently installed app configuration.
    before_count = Cabinet.objects.count()
    assert registry.reload_plugins(full_reload=True, force_reload=True, collect=True)
    from storage_layout import models

    assert models.Cabinet is apps.get_model('storage_layout', 'Cabinet')
    assert services.Cabinet is models.Cabinet, 'Hot reload split model identities'
    assert models.Cabinet.objects.count() == before_count
    expected_sources = json.loads(os.environ['SL_EXPECTED_SOURCE_HASHES'])
    for relative, expected_hash in expected_sources.items():
        if relative.startswith('src/plugins/storage_layout/storage_layout/'):
            source = Path(services.__file__).parent / Path(relative).name
        else:
            source = Path('/app') / relative
        assert hashlib.sha256(source.read_bytes()).hexdigest() == expected_hash, (
            f'Running image source mismatch: {relative}'
        )
    result = {
        'tested_source_sha256': expected_sources,
        'hot_reload_preserved_model_and_service_identity': True,
        'result': 'passed',
        'database': connection.vendor,
        'plugin_distribution': version('inventree-storage-layout'),
        'app_registered': True,
        'migrations': applied,
        'global_cache': settings.GLOBAL_CACHE_ENABLED,
        'workers': settings.Q_CLUSTER['workers'],
        'real_duplicate_tasks_completed': len(tasks),
        'duplicate_delivery_preserved_acknowledgements': True,
        'scheduled_watchdog_expired_session': True,
        'cabinet_reservation_released': True,
        'elapsed_seconds': round(time.monotonic() - started, 3),
        'hardware_enabled': False,
        'live_dispatch_enabled': False,
    }
    print('SL_WORKER_EVIDENCE=' + json.dumps(result, sort_keys=True))


main()
