"""Service-layer tests for the Storage Layout & WLED plugin.

These tests cover the transactional aggregate writes, compare-and-swap,
permissions, audit, idempotency, simulated operation, diagnostics and the
fail-closed live-hardware orchestration. No test opens a socket: live paths are
driven through the adapter's in-memory transport or a patched adapter.
"""

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.exceptions import ValidationError
from django.utils import timezone

from InvenTree.unit_test import InvenTreeTestCase
from stock.models import StockLocation
from storage_layout import services, wled
from storage_layout.models import (
    Bin,
    Cabinet,
    CabinetOperation,
    ConfigObservation,
    Controller,
    ControllerExecution,
    ControllerOutput,
    DesignAudit,
    Drawer,
    DrawerAllocation,
    HardwareReadJob,
    LEDString,
    LocateMode,
    LocateSession,
    MappingState,
    SessionState,
    TargetKind,
)

User = get_user_model()

ORIGIN = 'http://wled-a.local'


def grant(user, *codenames):
    """Grant the named plugin permissions to a user."""
    permissions = Permission.objects.filter(
        content_type__app_label='storage_layout', codename__in=codenames
    )
    user.user_permissions.add(*permissions)

    return User.objects.get(pk=user.pk)


def info_fixture(count=120):
    """Return a typical ``/json/info`` fixture."""
    return {
        'ver': '0.16.0',
        'vid': 2601010,
        'name': 'wled-a',
        'mac': 'AA:BB:CC:DD:EE:FF',
        'leds': {
            'count': count,
            'rgbw': False,
            'maxseg': 16,
            'lc': 1,
            'seglc': [count],
        },
    }


def cfg_fixture(count=120, **overrides):
    """Return a typical ``/json/cfg`` fixture."""
    entry = {
        'start': 0,
        'len': count,
        'pin': [16],
        'type': 22,
        'order': 0,
        'rev': False,
        'skip': 0,
    }
    entry.update(overrides)

    return {'hw': {'led': {'ins': [entry], 'maxpwr': 850, 'ledma': 55}}}


def fake_adapter(*, info=None, cfg=None, failures=None):
    """Build a real adapter backed by the in-memory transport."""
    transport = wled.FakeWledTransport(
        info if info is not None else info_fixture(),
        cfg if cfg is not None else cfg_fixture(),
        failures=failures,
    )
    policy = wled.OriginPolicy(
        entries=(wled.AllowlistEntry(host='wled-a.local'),),
        resolver=lambda host: ['10.0.0.1'],
    )

    return wled.get_adapter(transport=transport, policy=policy)


class ServiceTestCase(InvenTreeTestCase):
    """Base test case building a mapped cabinet with one controller."""

    def setUp(self):
        """Build native locations, a cabinet, a controller and a mapping."""
        super().setUp()

        self.user = grant(
            self.user,
            'view_cabinet',
            'change_cabinet',
            'configure_hardware',
            'operate_hardware',
            'emergency_stop',
        )

        self.root = StockLocation.objects.create(name='Warehouse', structural=True)
        self.cabinet_location = StockLocation.objects.create(
            name='Cabinet 1', parent=self.root, structural=True
        )
        self.drawer_location = StockLocation.objects.create(
            name='Drawer A1', parent=self.cabinet_location, structural=True
        )
        self.bin_location = StockLocation.objects.create(
            name='Bin A1-01', parent=self.drawer_location
        )

        self.cabinet = Cabinet.objects.create(
            name='Cabinet 1',
            slug='cabinet-1',
            location=self.cabinet_location,
            width_units=600,
            height_units=800,
        )

        self.drawer = Drawer.objects.create(
            cabinet=self.cabinet,
            label='A1',
            display_number=1,
            location=self.drawer_location,
            x=0,
            y=0,
            width=300,
            height=100,
            interior_width=280,
            interior_height=400,
        )

        self.controller = Controller.objects.create(
            cabinet=self.cabinet, name='Controller A', origin=ORIGIN, enabled=True
        )
        self.output = ControllerOutput.objects.create(
            controller=self.controller,
            bus_index=0,
            wled_start=0,
            pixel_count=120,
            pins=[16],
            led_type='22',
            colour_order='GRB',
        )
        self.string = LEDString.objects.create(
            output=self.output, label='S1', output_offset=0, pixel_count=120
        )

        # Durable dispatch is required for locate/read jobs. Tests patch the
        # queue gate and the enqueue seam so no real broker is used.
        self.queue = mock.patch.object(services, 'queue_available', return_value=True)
        self.queue.start()
        self.addCleanup(self.queue.stop)
        # Live protocol tests use only an injected in-memory adapter; a real
        # dispatcher is neither needed nor allowed in this fixture.
        self.dispatcher = mock.patch.object(services, 'require_live_dispatcher')
        self.dispatcher.start()
        self.addCleanup(self.dispatcher.stop)

        self.enqueue = mock.patch.object(
            services, 'enqueue_task', return_value='task-1'
        )
        self.enqueue.start()
        self.addCleanup(self.enqueue.stop)

        self.publish_single_span()

    def publish_single_span(self):
        """Publish a single-span mapping covering logical 1..120."""
        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 120,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': 1,
                }
            ],
        }

        return services.publish_mapping(
            self.cabinet, candidate, self.user, self.cabinet.revision
        )

    def allocate(self, start=1, end=60):
        """Allocate a logical range to the test drawer."""
        return DrawerAllocation.objects.create(
            drawer=self.drawer, logical_start=start, logical_end=end
        )


class CasTests(ServiceTestCase):
    """Tests for compare-and-swap and preconditions."""

    def test_parse_if_match_missing(self):
        """A missing If-Match header raises a 428 precondition error."""
        request = mock.Mock()
        request.headers = {}

        with self.assertRaises(services.MissingPreconditionError):
            services.parse_if_match(request)

        self.assertEqual(services.MissingPreconditionError.status_code, 428)

    def test_parse_if_match_invalid(self):
        """A non-numeric If-Match header raises a 412 stale error."""
        request = mock.Mock()
        request.headers = {'If-Match': 'abc'}

        with self.assertRaises(services.StaleRevisionError):
            services.parse_if_match(request)

        self.assertEqual(services.StaleRevisionError.status_code, 412)

    def test_parse_if_match_valid(self):
        """A quoted revision is parsed."""
        request = mock.Mock()
        request.headers = {'If-Match': '"7"'}

        self.assertEqual(services.parse_if_match(request), 7)

    def test_cas_stale_revision(self):
        """A stale revision is rejected without mutation."""
        before = self.cabinet.revision

        with self.assertRaises(services.StaleRevisionError):
            services.cas_update_cabinet(self.cabinet, before + 5, name='Nope')

        self.cabinet.refresh_from_db()
        self.assertEqual(self.cabinet.revision, before)
        self.assertEqual(self.cabinet.name, 'Cabinet 1')

    def test_cas_increments_once(self):
        """A successful CAS increments the revision exactly once."""
        before = self.cabinet.revision
        new = services.cas_update_cabinet(self.cabinet, before, name='Renamed')

        self.assertEqual(new, before + 1)
        self.assertEqual(self.cabinet.name, 'Renamed')


class LayoutServiceTests(ServiceTestCase):
    """Tests for the atomic layout aggregate write."""

    def test_validate_does_not_persist(self):
        """Validation returns diagnostics without writing."""
        before = self.cabinet.revision
        document = services.layout_document(self.cabinet)
        document['drawers'][0]['width'] = 99999

        result = services.validate_layout_document(self.cabinet, document)

        self.assertFalse(result['valid'])
        self.cabinet.refresh_from_db()
        self.assertEqual(self.cabinet.revision, before)

    def test_apply_layout_creates_bin(self):
        """A new bin is created and the revision advances."""
        before = self.cabinet.revision
        document = services.layout_document(self.cabinet)
        document['bins'].append(
            {
                'id': None,
                'drawer': str(self.drawer.pk),
                'label': 'A1-01',
                'location': self.bin_location.pk,
                'x': 0,
                'y': 0,
                'width': 70,
                'height': 100,
            }
        )

        result = services.apply_layout(
            self.cabinet, document, self.user, self.cabinet.revision
        )

        self.assertEqual(len(result['bins']), 1)
        self.assertEqual(result['cabinet']['revision'], before + 1)
        self.assertTrue(Bin.objects.filter(drawer=self.drawer, label='A1-01').exists())

    def test_apply_layout_rejects_overlap(self):
        """Overlapping drawers are rejected and nothing is persisted."""
        before = self.cabinet.revision
        document = services.layout_document(self.cabinet)
        document['drawers'].append(
            {
                'id': None,
                'label': 'A2',
                'display_number': 2,
                'location': self.drawer_location.pk,
                'x': 0,
                'y': 0,
                'width': 300,
                'height': 100,
                'interior_width': 280,
                'interior_height': 400,
            }
        )

        with self.assertRaises(services.StorageLayoutError) as ctx:
            services.apply_layout(
                self.cabinet, document, self.user, self.cabinet.revision
            )

        self.assertEqual(ctx.exception.code, 'geometry_overlap')
        self.cabinet.refresh_from_db()
        self.assertEqual(self.cabinet.revision, before)

    def test_apply_layout_rejects_cross_cabinet_id(self):
        """A drawer id from another cabinet is rejected."""
        other_location = StockLocation.objects.create(
            name='Other', parent=self.root, structural=True
        )
        other = Cabinet.objects.create(
            name='Other',
            slug='other',
            location=other_location,
            width_units=100,
            height_units=100,
        )
        other_drawer_location = StockLocation.objects.create(
            name='Other drawer', parent=other_location, structural=True
        )
        other_drawer = Drawer.objects.create(
            cabinet=other,
            label='X1',
            display_number=1,
            location=other_drawer_location,
            width=10,
            height=10,
            interior_width=10,
            interior_height=10,
        )

        document = services.layout_document(self.cabinet)
        document['drawers'].append(
            {
                'id': str(other_drawer.pk),
                'label': 'X1',
                'display_number': 9,
                'location': other_drawer_location.pk,
                'x': 0,
                'y': 0,
                'width': 10,
                'height': 10,
                'interior_width': 10,
                'interior_height': 10,
            }
        )

        with self.assertRaises(services.StorageLayoutError) as ctx:
            services.apply_layout(
                self.cabinet, document, self.user, self.cabinet.revision
            )

        self.assertEqual(ctx.exception.code, 'invalid_reference')

    def test_apply_layout_archives(self):
        """archive_ids archives a drawer without deleting it."""
        document = services.layout_document(self.cabinet)
        document['archive_ids'] = [str(self.drawer.pk)]

        services.apply_layout(self.cabinet, document, self.user, self.cabinet.revision)

        self.drawer.refresh_from_db()
        self.assertTrue(self.drawer.archived)

    def test_apply_layout_requires_change_permission(self):
        """A user without change permission is refused."""
        user = User.objects.create_user(username='viewer', password='x')

        with self.assertRaises(services.ForbiddenError):
            services.apply_layout(
                self.cabinet,
                services.layout_document(self.cabinet),
                user,
                self.cabinet.revision,
            )

    def test_apply_layout_stale_revision(self):
        """A stale revision is rejected."""
        with self.assertRaises(services.StaleRevisionError):
            services.apply_layout(
                self.cabinet,
                services.layout_document(self.cabinet),
                self.user,
                self.cabinet.revision + 3,
            )


class ElectricalServiceTests(ServiceTestCase):
    """Tests for the electrical topology write."""

    def test_electrical_document_roundtrip(self):
        """The saved electrical document reflects the topology."""
        document = services.electrical_document(self.cabinet)

        self.assertEqual(len(document['controllers']), 1)
        self.assertEqual(document['controllers'][0]['outputs'][0]['pixel_count'], 120)

    def test_apply_electrical_updates_output(self):
        """An output change is persisted and the revision advances."""
        before = self.cabinet.revision
        document = services.electrical_document(self.cabinet)
        document['controllers'][0]['outputs'][0]['pixel_count'] = 150

        result = services.apply_electrical(
            self.cabinet, document, self.user, self.cabinet.revision
        )

        self.output.refresh_from_db()
        self.assertEqual(self.output.pixel_count, 150)
        self.assertEqual(result['cabinet']['revision'], before + 1)

    def test_apply_electrical_requires_configure(self):
        """A user without configure permission is refused."""
        user = User.objects.create_user(username='operator', password='x')

        with self.assertRaises(services.ForbiddenError):
            services.apply_electrical(
                self.cabinet,
                services.electrical_document(self.cabinet),
                user,
                self.cabinet.revision,
            )

    def test_apply_electrical_rejects_busy_cabinet(self):
        """An active session blocks an electrical write."""
        self.allocate()
        services.create_locate_session(
            self.cabinet,
            self.user,
            {
                'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                'mode': LocateMode.SIMULATE,
                'idempotency_key': 'busy-1',
            },
        )

        with self.assertRaises(services.CabinetBusyError):
            services.apply_electrical(
                self.cabinet,
                services.electrical_document(self.cabinet),
                self.user,
                self.cabinet.revision,
            )


class MappingServiceTests(ServiceTestCase):
    """Tests for mapping preview, publish and translation."""

    def test_preview_valid(self):
        """A valid candidate previews with a hash and samples."""
        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 120,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': 1,
                }
            ],
        }

        result = services.mapping_preview(self.cabinet, candidate)

        self.assertTrue(result['valid'])
        self.assertTrue(result['mapping_hash'])
        self.assertTrue(result['samples'])

    def test_preview_detects_gap(self):
        """An uncovered logical pixel is reported."""
        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 100,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': 1,
                }
            ],
        }

        result = services.mapping_preview(self.cabinet, candidate)

        self.assertFalse(result['valid'])
        self.assertEqual(result['errors'][0]['code'], 'mapping_gap')

    def test_publish_creates_immutable_revision(self):
        """Publishing creates a published revision with spans."""
        mapping = self.cabinet.active_mapping

        self.assertEqual(mapping.state, MappingState.PUBLISHED)
        self.assertEqual(mapping.total_pixels, 120)
        self.assertEqual(mapping.spans.count(), 1)
        self.assertTrue(mapping.content_hash)

    def test_published_revision_is_immutable(self):
        """A published revision cannot be edited."""
        mapping = self.cabinet.active_mapping
        mapping.total_pixels = 130

        with self.assertRaises(ValidationError):
            mapping.save()

    def test_republish_supersedes_previous(self):
        """Publishing a new revision supersedes the previous one."""
        previous = self.cabinet.active_mapping

        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 120,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': -1,
                }
            ],
        }

        services.publish_mapping(
            self.cabinet, candidate, self.user, self.cabinet.revision
        )

        previous.refresh_from_db()
        self.assertEqual(previous.state, MappingState.SUPERSEDED)
        self.assertEqual(self.cabinet.active_mapping.number, 2)

    def test_publish_reports_changed_pixels(self):
        """Publishing reports the physical pixels whose address changed."""
        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 120,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': -1,
                }
            ],
        }

        result = services.publish_mapping(
            self.cabinet, candidate, self.user, self.cabinet.revision
        )

        # Reversing the span changes every logical pixel's physical address.
        self.assertEqual(result['changed_count'], 120)
        self.assertEqual(len(result['changed_pixels']), 120)
        self.assertFalse(result['changed_truncated'])
        self.assertEqual(result['changed_pixels'][0]['logical'], 1)
        self.assertIsNotNone(result['changed_pixels'][0]['before'])
        self.assertIsNotNone(result['changed_pixels'][0]['after'])

    def test_publish_reports_no_change_for_identical_mapping(self):
        """Re-publishing an identical mapping reports no changed pixels."""
        candidate = {
            'total_pixels': 120,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 120,
                    'string': str(self.string.pk),
                    'string_offset': 0,
                    'direction': 1,
                }
            ],
        }

        result = services.publish_mapping(
            self.cabinet, candidate, self.user, self.cabinet.revision
        )

        self.assertEqual(result['changed_count'], 0)
        self.assertEqual(result['changed_pixels'], [])

    def test_translate_range(self):
        """Translation returns physical runs for the active mapping."""
        result = services.translate_range(self.cabinet, 1, 10)

        self.assertEqual(result['pixel_count'], 10)
        self.assertEqual(len(result['runs']), 1)
        self.assertEqual(result['runs'][0]['controller'], str(self.controller.pk))

    def test_translate_stale_hash(self):
        """A stale mapping hash is rejected."""
        with self.assertRaises(services.StaleRevisionError):
            services.translate_range(self.cabinet, 1, 10, 'deadbeef')

    def test_translate_without_mapping(self):
        """Translation without an active mapping is rejected."""
        cabinet = Cabinet.objects.create(
            name='Empty',
            slug='empty',
            location=StockLocation.objects.create(name='Empty loc', structural=True),
            width_units=10,
            height_units=10,
        )

        with self.assertRaises(services.StorageLayoutError):
            services.translate_range(cabinet, 1, 1)


class SessionServiceTests(ServiceTestCase):
    """Tests for locate session creation, execution and stop."""

    def setUp(self):
        """Allocate the drawer."""
        super().setUp()
        self.allocate()

    def create(self, key='k1', **overrides):
        """Create a simulated locate session."""
        payload = {
            'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
            'mode': LocateMode.SIMULATE,
            'idempotency_key': key,
        }
        payload.update(overrides)

        return services.create_locate_session(self.cabinet, self.user, payload)

    def test_simulate_session_queued_then_active(self):
        """A simulated session is queued, then active after the worker runs."""
        session, created = self.create()

        self.assertTrue(created)
        self.assertEqual(session.state, SessionState.QUEUED)
        self.assertEqual(session.plan['logical_start'], 1)
        self.assertEqual(session.plan['logical_end'], 60)

        services.execute_session(session.pk)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.ACTIVE)
        self.assertTrue(session.expires_at)

    def test_idempotent_replay(self):
        """The same key and body returns the same session."""
        first, created = self.create()
        second, created_again = self.create()

        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first.pk, second.pk)

    def test_idempotency_conflict(self):
        """The same key with a different body is rejected."""
        self.create()

        with self.assertRaises(services.StorageLayoutError) as ctx:
            self.create(duration_seconds=30)

        self.assertEqual(ctx.exception.code, 'idempotency_conflict')

    def test_busy_cabinet(self):
        """A second session on a busy cabinet is rejected."""
        self.create()

        with self.assertRaises(services.CabinetBusyError):
            self.create(key='k2')

    def test_not_locatable(self):
        """An unmapped target is rejected."""
        with self.assertRaises(services.NotLocatableError):
            self.create(
                target={'kind': TargetKind.LOCATION, 'id': self.cabinet_location.pk}
            )

    def test_live_requires_approval(self):
        """Live mode without approve_live is rejected."""
        with self.assertRaises(services.StorageLayoutError) as ctx:
            self.create(mode=LocateMode.LIVE)

        self.assertEqual(ctx.exception.code, 'approval_required')

    def test_live_fails_closed_without_adapter(self):
        """Live mode fails closed when hardware is disabled."""
        with self.assertRaises(services.LiveNotAvailableError):
            self.create(mode=LocateMode.LIVE, approve_live=True)

    def test_stop_simulated(self):
        """Stopping a simulated session releases the reservation."""
        session, _ = self.create()
        services.stop_session(session, self.user)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.STOPPED)

        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertIsNone(operation.current_session_id)

    def test_stop_is_idempotent(self):
        """Stopping twice is safe."""
        session, _ = self.create()
        services.stop_session(session, self.user)
        services.stop_session(session, self.user)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.STOPPED)

    def test_stop_requires_owner_or_operator(self):
        """An unrelated user cannot stop a session."""
        session, _ = self.create()
        other = User.objects.create_user(username='other', password='x')

        with self.assertRaises(services.ForbiddenError):
            services.stop_session(session, other)

    def test_emergency_stop(self):
        """An emergency stop stops the active session."""
        session, _ = self.create()
        result = services.emergency_stop(self.cabinet, self.user)

        self.assertEqual(result['stopped_session'], str(session.pk))

    def test_pixel_test(self):
        """A pixel test creates a queued test session."""
        session, created = services.create_pixel_test(
            self.cabinet,
            self.user,
            {
                'logical_start': 1,
                'logical_end': 5,
                'mode': LocateMode.SIMULATE,
                'idempotency_key': 'pt-1',
            },
        )

        self.assertTrue(created)
        self.assertEqual(session.state, SessionState.QUEUED)
        self.assertEqual(session.plan['kind'], 'pixel-test')
        self.assertEqual(session.plan['logical_end'], 5)

        services.execute_session(session.pk)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.ACTIVE)


class LiveSessionTests(ServiceTestCase):
    """Tests for the fail-closed live orchestration."""

    def setUp(self):
        """Allocate the drawer and enable hardware."""
        super().setUp()
        self.allocate()
        self.adapter = fake_adapter()
        self.hardware = mock.patch.object(
            services, 'hardware_enabled', return_value=True
        )
        self.hardware.start()
        self.addCleanup(self.hardware.stop)

    def arm(self, adapter=None, config_hash=None):
        """Arm the controller for the current mapping."""
        adapter = adapter or self.adapter
        observation = adapter.observe(self.controller)

        self.controller.armed_until = timezone.now() + timedelta(minutes=10)
        self.controller.armed_mapping_hash = self.cabinet.active_mapping.content_hash
        self.controller.armed_config_hash = (
            config_hash if config_hash is not None else observation['fingerprint']
        )
        self.controller.save()

    def test_arm_fails_closed_without_adapter(self):
        """Arm fails closed when no adapter is available."""
        with mock.patch.object(services, 'build_live_adapter', return_value=None):
            with self.assertRaises(services.LiveNotAvailableError):
                services.arm_cabinet(self.cabinet, self.user, [self.controller.pk])

    def test_arm_requires_approved_snapshot(self):
        """Arm requires an approved supported configuration."""
        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            with self.assertRaises(services.UnsupportedConfigurationError):
                services.arm_cabinet(self.cabinet, self.user, [self.controller.pk])

    def test_live_apply_succeeds_when_armed(self):
        """A live apply succeeds when armed with the observed fingerprint."""
        self.arm()

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'live-1',
                },
            )
            services.execute_session(session.pk)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.ACTIVE)
        self.assertTrue(ControllerExecution.objects.filter(session=session).exists())

    def test_live_apply_fails_closed_on_fingerprint_mismatch(self):
        """A fixture-approved fingerprint never authorises a live write."""
        # Arm with a fingerprint that does not match the observed configuration.
        self.arm(config_hash='fixture-fingerprint')

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'live-2',
                },
            )

            result = services.execute_session(session.pk)
            self.assertEqual(result.state, SessionState.FAILED)
            self.assertEqual(result.failure['code'], 'config_drift')

    def test_live_stop_clears_plan_even_without_progress_rows(self):
        """A crashed worker's missing execution rows never imply black output."""
        self.arm()
        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'lost-progress',
                },
            )
            services.execute_session(session.pk)
            session.executions.all().delete()
            session.refresh_from_db()
            result = services.stop_session(session, self.user)
        self.assertEqual(result.state, SessionState.STOPPED)
        self.assertEqual(result.executions.get().clear_status, 'confirmed')

    def test_stopped_live_task_cannot_reapply(self):
        """A queued task delivered after stop never re-enables LEDs."""
        self.arm()
        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'stopped-queued',
                },
            )
            services.stop_session(session, self.user)
            with mock.patch.object(self.adapter, 'apply') as apply:
                result = services.execute_session(session.pk)
            apply.assert_not_called()
        self.assertEqual(result.state, SessionState.STOPPED)

    def test_bounded_live_walk_clears_each_step(self):
        """A finite walking test never leaves the previous pixel illuminated."""
        self.arm()
        with (
            mock.patch.object(services, 'build_live_adapter', return_value=self.adapter),
            mock.patch.object(services.time, 'sleep'),
            mock.patch.object(self.adapter, 'apply', wraps=self.adapter.apply) as apply,
        ):
            session, _ = services.create_pixel_test(self.cabinet, self.user, {
                'logical_start': 1, 'logical_end': 2, 'pattern': 'walk',
                'mode': LocateMode.LIVE, 'approve_live': True,
                'idempotency_key': 'finite-walk',
            })
            result = services.execute_session(session.pk)
        self.assertEqual(result.state, SessionState.STOPPED)
        self.assertEqual(apply.call_count, 2)
        self.assertEqual([call.args[1]['runs'][0]['logical_start'] for call in apply.call_args_list], [1, 2])
        self.assertEqual(result.executions.get().clear_status, 'confirmed')
        self.assertIsNone(CabinetOperation.objects.get(cabinet=self.cabinet).current_session_id)

    def test_live_stop_confirmed(self):
        """A confirmed live clear marks the session stopped."""
        self.arm()

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'live-3',
                },
            )
            services.execute_session(session.pk)
            services.stop_session(session, self.user)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.STOPPED)

        execution = session.executions.first()
        self.assertEqual(execution.clear_status, 'confirmed')

    def test_live_stop_unconfirmed_keeps_reservation(self):
        """An unconfirmed clear leaves the session unknown and reserved."""
        self.arm()

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'live-4',
                },
            )
            services.execute_session(session.pk)

        unconfirmed = wled.ClearResult(clear_status='unconfirmed', acknowledged=False)

        with (
            mock.patch.object(
                services, 'build_live_adapter', return_value=self.adapter
            ),
            mock.patch.object(self.adapter, 'clear', return_value=unconfirmed),
        ):
            services.stop_session(session, self.user)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.UNKNOWN)
        self.assertEqual(session.failure['code'], 'clear_unconfirmed')

        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertEqual(operation.current_session_id, session.pk)

        execution = session.executions.first()
        self.assertEqual(execution.clear_status, 'unconfirmed')

    def test_live_stop_without_adapter_is_unconfirmed(self):
        """A live stop with no adapter never reports a confirmed clear."""
        self.arm()

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'live-5',
                },
            )
            services.execute_session(session.pk)

        with mock.patch.object(services, 'build_live_adapter', return_value=None):
            services.stop_session(session, self.user)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.UNKNOWN)
        self.assertEqual(session.executions.first().clear_status, 'unconfirmed')

    def test_live_apply_partial_failure_cleans_up(self):
        """A late live failure clears the controller and never reports success."""
        failing = fake_adapter(
            failures=[{'method': 'POST', 'has_i': True, 'action': 'timeout'}]
        )
        self.arm(adapter=failing)

        with mock.patch.object(services, 'build_live_adapter', return_value=failing):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'fail-1',
                },
            )

            services.execute_session(session.pk)

        session.refresh_from_db()

        self.assertEqual(session.state, SessionState.FAILED)
        execution = session.executions.get(controller=self.controller)
        self.assertEqual(execution.clear_status, 'confirmed')

        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertIsNone(operation.current_session_id)

    def test_live_apply_unconfirmed_cleanup_keeps_reservation(self):
        """An unconfirmed live cleanup keeps the session unknown and reserved."""
        failing = fake_adapter(
            failures=[{'method': 'POST', 'has_i': True, 'action': 'timeout'}]
        )
        self.arm(adapter=failing)
        unconfirmed = wled.ClearResult(clear_status='unconfirmed', acknowledged=False)

        with (
            mock.patch.object(services, 'build_live_adapter', return_value=failing),
            mock.patch.object(failing, 'clear', return_value=unconfirmed),
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': 'fail-2',
                },
            )

            services.execute_session(session.pk)

        session.refresh_from_db()

        self.assertEqual(session.state, SessionState.UNKNOWN)
        self.assertEqual(session.failure['code'], 'clear_unconfirmed')
        self.assertEqual(
            session.executions.get(controller=self.controller).clear_status,
            'unconfirmed',
        )
        self.assertEqual(
            CabinetOperation.objects.get(cabinet=self.cabinet).current_session_id,
            session.pk,
        )

    def test_reconcile_sweeps_session_without_deadline(self):
        """A stuck active session with no deadline is reconciled once its lease expires."""
        session, _ = services.create_locate_session(
            self.cabinet,
            self.user,
            {
                'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                'mode': LocateMode.SIMULATE,
                'idempotency_key': 'stuck-1',
            },
        )
        session.expires_at = None
        session.save()

        CabinetOperation.objects.filter(cabinet=self.cabinet).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )

        result = services.reconcile_operations()

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.EXPIRED)
        self.assertEqual(result['expired_sessions'], 1)

    def observe_live(self, adapter=None):
        """Create and run a live observe job, returning the observation."""
        adapter = adapter or self.adapter

        with mock.patch.object(services, 'build_live_adapter', return_value=adapter):
            job = services.create_observe_job(
                self.controller, self.user, LocateMode.LIVE
            )
            services.execute_read_job(job.pk)

        job.refresh_from_db()

        return ConfigObservation.objects.get(pk=job.result['observation'])

    def test_arm_preflight_blocks_drift(self):
        """Arm re-reads the device and refuses a drifted configuration."""
        observation = self.observe_live()
        services.approve_configuration(self.controller, self.user, observation.pk)

        drifted = fake_adapter(info=info_fixture() | {'mac': '11:22:33:44:55:66'})

        with mock.patch.object(services, 'build_live_adapter', return_value=drifted):
            with self.assertRaises(services.ConfigDriftError):
                services.arm_cabinet(self.cabinet, self.user, [self.controller.pk])

    def test_arm_succeeds_with_current_approved_configuration(self):
        """Arm binds to the currently observed configuration on success."""
        observation = self.observe_live()
        services.approve_configuration(self.controller, self.user, observation.pk)

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            services.arm_cabinet(self.cabinet, self.user, [self.controller.pk])

        self.controller.refresh_from_db()
        self.assertIsNotNone(self.controller.armed_until)
        self.assertEqual(self.controller.armed_config_hash, observation.fingerprint)

    def expire_live_session(self, key):
        """Create, run and expire a live session."""
        self.arm()

        with mock.patch.object(
            services, 'build_live_adapter', return_value=self.adapter
        ):
            session, _ = services.create_locate_session(
                self.cabinet,
                self.user,
                {
                    'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                    'mode': LocateMode.LIVE,
                    'approve_live': True,
                    'idempotency_key': key,
                },
            )
            services.execute_session(session.pk)

        session.expires_at = timezone.now() - timedelta(seconds=1)
        session.save()

        return session

    def test_reconcile_defers_live_without_dispatcher(self):
        """The watchdog never clears live hardware without a dispatcher."""
        session = self.expire_live_session('wd-1')

        with mock.patch.object(services, 'dispatcher_enabled', return_value=False):
            result = services.reconcile_operations()

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.UNKNOWN)
        self.assertEqual(session.failure['code'], 'clear_unconfirmed')
        self.assertEqual(result['live_deferred'], 1)
        self.assertEqual(result['live_cleanups'], 0)

        # The reservation is retained for operator intervention.
        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertEqual(operation.current_session_id, session.pk)

    def test_reconcile_clears_live_with_dispatcher(self):
        """The watchdog clears live hardware when a dispatcher is configured."""
        session = self.expire_live_session('wd-2')

        with (
            mock.patch.object(services, 'dispatcher_enabled', return_value=True),
            mock.patch.object(
                services, 'build_live_adapter', return_value=self.adapter
            ),
        ):
            result = services.reconcile_operations()

        session.refresh_from_db()
        self.assertEqual(result['live_cleanups'], 1)
        self.assertEqual(session.state, SessionState.STOPPED)

        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertIsNone(operation.current_session_id)


class ObservationServiceTests(ServiceTestCase):
    """Tests for observe, import and approve."""

    def observe(self, mode=LocateMode.SIMULATE):
        """Create and run an observe job, returning the job and observation."""
        job = services.create_observe_job(self.controller, self.user, mode)
        services.execute_read_job(job.pk)
        job.refresh_from_db()

        return job, ConfigObservation.objects.get(pk=job.result['observation'])

    def test_observe_job_is_durable(self):
        """An observe job is created pending and dispatched on commit."""
        job = services.create_observe_job(
            self.controller, self.user, LocateMode.SIMULATE
        )

        self.assertEqual(job.state, 'pending')
        self.assertEqual(job.kind, 'observe')

    def test_observe_simulate(self):
        """A simulated observation is stored with a topology fingerprint."""
        job, observation = self.observe()

        self.assertEqual(job.state, 'complete')
        self.assertEqual(observation.capability_status, 'supported')
        self.assertTrue(observation.fingerprint)

    def test_import_preview_and_apply(self):
        """An observation diff can be previewed and applied."""
        _, observation = self.observe()

        preview = services.import_preview(self.controller, observation.pk)

        self.assertIn('diff_hash', preview)

        result = services.import_configuration(
            self.controller,
            self.user,
            observation.pk,
            preview['diff_hash'],
            self.cabinet.revision,
        )

        self.assertEqual(result['controller'], str(self.controller.pk))

    def test_import_rejects_wrong_diff_hash(self):
        """A mismatched accepted diff hash is rejected."""
        _, observation = self.observe()

        with self.assertRaises(services.ConfigDriftError):
            services.import_configuration(
                self.controller,
                self.user,
                observation.pk,
                'wrong-hash',
                self.cabinet.revision,
            )

    def test_approve_configuration(self):
        """A supported observation can be approved."""
        _, observation = self.observe()

        result = services.approve_configuration(
            self.controller, self.user, observation.pk
        )

        self.controller.refresh_from_db()
        self.assertEqual(self.controller.approved_snapshot_id, observation.pk)
        self.assertEqual(result['fingerprint'], observation.fingerprint)

    def test_observe_live_fails_closed(self):
        """Live observation fails closed without an adapter."""
        with self.assertRaises(services.LiveNotAvailableError):
            services.create_observe_job(self.controller, self.user, LocateMode.LIVE)

    def test_simulated_observation_does_not_claim_online(self):
        """Design fixtures must not update physical last-seen or status."""
        self.controller.refresh_from_db()
        before = (self.controller.status, self.controller.last_seen)
        self.observe()
        self.controller.refresh_from_db()
        self.assertEqual((self.controller.status, self.controller.last_seen), before)

    def test_discovery_reports_simulated_candidates(self):
        """Simulation discovers bounded saved origins without network access."""
        job = services.create_discovery_job(
            self.user, self.cabinet, LocateMode.SIMULATE, {}
        )
        services.execute_read_job(job.pk)
        job.refresh_from_db()
        self.assertEqual(job.state, 'complete')
        self.assertEqual(job.result['method'], 'registered-origins')
        self.assertEqual(
            job.result['candidates'][0]['controller'], str(self.controller.pk)
        )
        self.assertTrue(job.result['candidates'][0]['simulated'])

    def test_discovery_simulate(self):
        """A simulated discovery job is queued then completes."""
        job = services.create_discovery_job(
            self.user, self.cabinet, LocateMode.SIMULATE, {}
        )

        self.assertEqual(job.kind, 'discovery')
        self.assertEqual(job.state, 'pending')

        services.execute_read_job(job.pk)

        job.refresh_from_db()
        self.assertEqual(job.state, 'complete')


class DiagnosticsAndAuditTests(ServiceTestCase):
    """Tests for diagnostics, audit and reconciliation."""

    def test_audit_retention_keeps_recent_records(self):
        """Only expired audit entries are removed after cabinet cleanup."""
        old = services.record_audit(self.cabinet, self.user, 'retention.old')
        recent = services.record_audit(self.cabinet, self.user, 'retention.recent')
        DesignAudit.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - timedelta(days=100)
        )
        with mock.patch.object(services, 'plugin_setting', return_value=90):
            services.prune_old_audits()
        self.assertFalse(DesignAudit.objects.filter(pk=old.pk).exists())
        self.assertTrue(DesignAudit.objects.filter(pk=recent.pk).exists())

    def test_audit_retention_preserves_unresolved_cabinet(self):
        """Retention never discards evidence for an unresolved reservation."""
        self.allocate()
        services.create_locate_session(
            self.cabinet,
            self.user,
            {
                'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                'mode': LocateMode.SIMULATE,
                'idempotency_key': 'audit-keep',
            },
        )
        old = services.record_audit(self.cabinet, self.user, 'retention.unresolved')
        DesignAudit.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - timedelta(days=100)
        )
        with mock.patch.object(services, 'plugin_setting', return_value=90):
            services.prune_old_audits()
        self.assertTrue(DesignAudit.objects.filter(pk=old.pk).exists())

    def test_diagnostics_clean(self):
        """A valid cabinet reports no errors."""
        result = services.cabinet_diagnostics(self.cabinet)

        self.assertTrue(result['valid'])
        self.assertEqual(result['total_pixels'], 120)

    def test_diagnostics_detects_overlap(self):
        """An overlapping drawer is reported."""
        Drawer.objects.create(
            cabinet=self.cabinet,
            label='A2',
            display_number=2,
            location=StockLocation.objects.create(
                name='Drawer A2', parent=self.cabinet_location, structural=True
            ),
            x=0,
            y=0,
            width=300,
            height=100,
            interior_width=280,
            interior_height=400,
        )

        result = services.cabinet_diagnostics(self.cabinet)

        self.assertFalse(result['valid'])
        self.assertEqual(result['errors'][0]['code'], 'geometry_overlap')

    def test_audit_recorded(self):
        """Layout writes append an audit entry."""
        before = DesignAudit.objects.count()

        services.apply_layout(
            self.cabinet,
            services.layout_document(self.cabinet),
            self.user,
            self.cabinet.revision,
        )

        self.assertEqual(DesignAudit.objects.count(), before + 1)
        entry = DesignAudit.objects.latest('created_at')
        self.assertEqual(entry.operation, 'layout.save')
        self.assertEqual(entry.actor, self.user)

    def test_reconcile_expires_simulated_session(self):
        """Reconciliation expires a simulated session past its deadline."""
        DrawerAllocation.objects.create(
            drawer=self.drawer, logical_start=1, logical_end=60
        )
        session, _ = services.create_locate_session(
            self.cabinet,
            self.user,
            {
                'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
                'mode': LocateMode.SIMULATE,
                'idempotency_key': 'exp-1',
            },
        )

        session.expires_at = timezone.now() - timedelta(seconds=1)
        session.save()

        result = services.reconcile_operations()

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.EXPIRED)
        self.assertEqual(result['expired_sessions'], 1)

    def test_reconcile_clears_expired_arm(self):
        """Reconciliation clears an expired arm."""
        self.controller.armed_until = timezone.now() - timedelta(minutes=1)
        self.controller.armed_mapping_hash = 'x'
        self.controller.save()

        services.reconcile_operations()

        self.controller.refresh_from_db()
        self.assertIsNone(self.controller.armed_until)
        self.assertEqual(self.controller.armed_mapping_hash, '')


class DispatchTests(ServiceTestCase):
    """Tests for durable async dispatch and the bounded watchdog loop."""

    def setUp(self):
        """Allocate the drawer."""
        super().setUp()
        self.allocate()

    def payload(self, key='q-1'):
        """Return a locate session payload."""
        return {
            'target': {'kind': TargetKind.DRAWER, 'id': str(self.drawer.pk)},
            'mode': LocateMode.SIMULATE,
            'idempotency_key': key,
        }

    def test_live_dispatch_requires_fresh_watchdog(self):
        """An enabled flag alone cannot authorise output with no watchdog."""
        self.dispatcher.stop()
        with (
            mock.patch.object(services, 'dispatcher_enabled', return_value=True),
            mock.patch.object(services, 'watchdog_enabled', return_value=True),
            mock.patch.object(services, 'worker_running', return_value=True),
            mock.patch.object(
                services.cache, 'get', return_value=timezone.now().timestamp() - 30
            ),
        ):
            with self.assertRaises(services.LiveNotAvailableError):
                services.require_live_dispatcher()
        with (
            mock.patch.object(services, 'dispatcher_enabled', return_value=True),
            mock.patch.object(services, 'watchdog_enabled', return_value=True),
            mock.patch.object(services, 'worker_running', return_value=True),
            mock.patch.object(
                services.cache, 'get', return_value=timezone.now().timestamp()
            ),
        ):
            services.require_live_dispatcher()

    def test_simulated_walk_has_explicit_pixel_frames(self):
        """Walking previews preserve logical order and bounded time offsets."""
        session, _ = services.create_pixel_test(self.cabinet, self.user, {
            'logical_start': 2, 'logical_end': 4, 'pattern': 'walk',
            'mode': LocateMode.SIMULATE, 'idempotency_key': 'walk-preview',
        })
        result = services.execute_session(session.pk)
        self.assertEqual(result.state, SessionState.ACTIVE)
        frames = result.plan['frames']
        self.assertEqual([frame['logical_pixel'] for frame in frames], [2, 3, 4])
        self.assertEqual(frames[0]['offset_seconds'], 0)
        self.assertLess(frames[-1]['offset_seconds'], result.plan['duration_seconds'])
        self.assertEqual([frame['runs'][0]['wled_start'] for frame in frames], [1, 2, 3])

    def test_walk_range_is_bounded(self):
        """A walk cannot become an unbounded animation or request flood."""
        with self.assertRaises(services.StorageLayoutError):
            services.create_pixel_test(self.cabinet, self.user, {
                'logical_start': 1, 'logical_end': 33, 'pattern': 'walk',
                'mode': LocateMode.SIMULATE, 'idempotency_key': 'oversize-walk',
            })

    def test_duplicate_worker_cannot_claim_preflight(self):
        """An already claimed task is never executed by a second delivery."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )
        LocateSession.objects.filter(pk=session.pk).update(state=SessionState.PREFLIGHT)
        with mock.patch.object(services, 'run_session') as run:
            services.execute_session(session.pk)
        run.assert_not_called()

    def test_expired_queue_never_executes(self):
        """Queue latency cannot resurrect an expired hardware approval."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )
        LocateSession.objects.filter(pk=session.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        with mock.patch.object(services, 'run_session') as run:
            result = services.execute_session(session.pk)
        run.assert_not_called()
        self.assertEqual(result.state, SessionState.FAILED)
        self.assertEqual(result.failure['code'], 'session_expired')
        self.assertIsNone(
            CabinetOperation.objects.get(cabinet=self.cabinet).current_session_id
        )

    def test_stale_queued_layout_never_executes(self):
        """Worker preflight checks the saved aggregate revision again."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )
        Cabinet.objects.filter(pk=self.cabinet.pk).update(
            revision=self.cabinet.revision + 1
        )
        with mock.patch.object(services, 'run_session') as run:
            result = services.execute_session(session.pk)
        run.assert_not_called()
        self.assertEqual(result.state, SessionState.FAILED)
        self.assertEqual(result.failure['code'], 'stale')

    def test_queue_unavailable_rejects_session(self):
        """An unavailable queue rejects a locate session with 503."""
        with mock.patch.object(services, 'queue_available', return_value=False):
            with self.assertRaises(services.QueueUnavailableError) as ctx:
                services.create_locate_session(self.cabinet, self.user, self.payload())

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertFalse(LocateSession.objects.filter(cabinet=self.cabinet).exists())

    def test_queue_unavailable_rejects_read_job(self):
        """An unavailable queue rejects a read job with 503."""
        with mock.patch.object(services, 'queue_available', return_value=False):
            with self.assertRaises(services.QueueUnavailableError):
                services.create_observe_job(
                    self.controller, self.user, LocateMode.SIMULATE
                )

        self.assertFalse(HardwareReadJob.objects.exists())

    def test_session_dispatched_on_commit(self):
        """The session is dispatched on commit, not during the request."""
        with mock.patch.object(
            services, 'enqueue_task', return_value='task-9'
        ) as enqueue:
            with self.captureOnCommitCallbacks(execute=True):
                session, _ = services.create_locate_session(
                    self.cabinet, self.user, self.payload()
                )

        enqueue.assert_called_once()
        session.refresh_from_db()
        self.assertEqual(session.plan['q_task_id'], 'task-9')
        self.assertEqual(session.state, SessionState.QUEUED)

    def test_dispatch_records_task_id(self):
        """A successful dispatch records the background task ID."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )

        with mock.patch.object(services, 'enqueue_task', return_value='task-42'):
            task_id = services.dispatch_session(session.pk)

        self.assertEqual(task_id, 'task-42')
        session.refresh_from_db()
        self.assertEqual(session.plan['q_task_id'], 'task-42')

    def test_dispatch_failure_persisted(self):
        """An enqueue failure is persisted on the session and raises 503."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )

        with mock.patch.object(services, 'enqueue_task', return_value=False):
            with self.assertRaises(services.QueueUnavailableError):
                services.dispatch_session(session.pk)

        session.refresh_from_db()
        self.assertEqual(session.state, SessionState.FAILED)
        self.assertEqual(session.failure['code'], 'queue_unavailable')

        operation = CabinetOperation.objects.get(cabinet=self.cabinet)
        self.assertIsNone(operation.current_session_id)

    def test_read_job_dispatch_failure_persisted(self):
        """An enqueue failure is persisted on a read job."""
        job = services.create_observe_job(
            self.controller, self.user, LocateMode.SIMULATE
        )

        with mock.patch.object(services, 'enqueue_task', return_value=False):
            with self.assertRaises(services.QueueUnavailableError):
                services.dispatch_read_job(job.pk)

        job.refresh_from_db()
        self.assertEqual(job.state, 'failed')
        self.assertEqual(job.error['code'], 'queue_unavailable')

    def test_dispatch_skips_progressed_session(self):
        """A session that has already progressed is not re-dispatched."""
        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )
        services.execute_session(session.pk)

        with mock.patch.object(services, 'enqueue_task') as enqueue:
            self.assertIsNone(services.dispatch_session(session.pk))

        enqueue.assert_not_called()

    def test_run_session_task(self):
        """The session task entry point executes the durable session."""
        from storage_layout import tasks

        session, _ = services.create_locate_session(
            self.cabinet, self.user, self.payload()
        )

        result = tasks.run_session_task(str(session.pk))

        self.assertEqual(result['state'], SessionState.ACTIVE)

    def test_run_read_job_task(self):
        """The read job task entry point executes the durable job."""
        from storage_layout import tasks

        job = services.create_observe_job(
            self.controller, self.user, LocateMode.SIMULATE
        )

        result = tasks.run_read_job_task(str(job.pk))

        self.assertEqual(result['state'], 'complete')

    def test_enqueue_task_forces_async(self):
        """The enqueue seam always forces asynchronous dispatch."""
        from InvenTree import tasks as inventree_tasks

        # Use the real seam for this test.
        self.enqueue.stop()

        with mock.patch.object(
            inventree_tasks, 'offload_task', return_value='task-x'
        ) as offload:
            result = services.enqueue_task(
                'storage_layout.tasks.run_session_task', 'abc'
            )

        self.assertEqual(result, 'task-x')
        self.assertTrue(offload.call_args.kwargs['force_async'])

    def test_watchdog_loop_bounded(self):
        """The watchdog loop sweeps and returns a bounded summary."""
        from storage_layout import tasks

        with (
            mock.patch.object(tasks.cache, 'add', return_value=True),
            mock.patch.object(tasks.cache, 'delete'),
        ):
            result = tasks.watchdog_loop(duration_seconds=1, interval_seconds=1)

        self.assertGreaterEqual(result['sweeps'], 1)
        self.assertIn('expired_sessions', result)

    def test_watchdog_loop_skips_when_locked(self):
        """A second watchdog loop does not run while one is active."""
        from storage_layout import tasks

        with mock.patch.object(tasks.cache, 'add', return_value=False):
            result = tasks.watchdog_loop(duration_seconds=1, interval_seconds=1)

        self.assertEqual(result['skipped'], 'locked')

    def test_watchdog_loop_skips_when_disabled(self):
        """The watchdog loop is skipped when disabled."""
        from storage_layout import tasks

        # Patch by path so the patch targets the module the task imports at
        # call time (the registry may have purged and re-imported the package).
        with mock.patch('storage_layout.services.watchdog_enabled', return_value=False):
            result = tasks.watchdog_loop(duration_seconds=1, interval_seconds=1)

        self.assertEqual(result['skipped'], 'disabled')
