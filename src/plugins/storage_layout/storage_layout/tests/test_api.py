"""REST API tests for the Storage Layout & WLED plugin.

These tests exercise the full endpoint surface, the permission matrix, the
``If-Match``/``ETag`` compare-and-swap contract, idempotency, the documented
error shape and the fail-closed hardware behaviour. No test opens a socket.
"""

from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.cache import cache
from django.test import override_settings

from InvenTree.unit_test import InvenTreeAPITestCase
from stock.models import StockLocation
from storage_layout.models import (
    Cabinet,
    Controller,
    ControllerOutput,
    Drawer,
    DrawerAllocation,
    LEDString,
    LocateProfile,
    MappingRevision,
    PixelSpan,
)

User = get_user_model()

BASE = '/plugin/storage-layout/api/v1/'


def grant(user, *codenames):
    """Grant the named plugin permissions to a user."""
    permissions = Permission.objects.filter(
        content_type__app_label='storage_layout', codename__in=codenames
    )
    user.user_permissions.add(*permissions)

    return User.objects.get(pk=user.pk)


@override_settings(ROOT_URLCONF='storage_layout.tests.urls')
class ApiTestCase(InvenTreeAPITestCase):
    """Base API test case building a mapped cabinet with one controller."""

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
            cabinet=self.cabinet,
            name='Controller A',
            origin='http://wled-a.local',
            enabled=True,
        )
        self.output = ControllerOutput.objects.create(
            controller=self.controller,
            bus_index=0,
            wled_start=0,
            pixel_count=120,
            pins=[16],
            led_type='22',
        )
        self.string = LEDString.objects.create(
            output=self.output, label='S1', output_offset=0, pixel_count=120
        )

        self.mapping = MappingRevision.objects.create(
            cabinet=self.cabinet,
            number=1,
            state='published',
            total_pixels=120,
            content_hash='hash-1',
            source_revision=1,
        )
        PixelSpan.objects.create(
            mapping_revision=self.mapping,
            string=self.string,
            logical_start=1,
            length=120,
            string_offset=0,
            direction=1,
        )
        Cabinet.objects.filter(pk=self.cabinet.pk).update(active_mapping=self.mapping)
        self.cabinet.refresh_from_db()

        self.allocation = DrawerAllocation.objects.create(
            drawer=self.drawer, logical_start=1, logical_end=60
        )

        # Rate-limit state is process-global; clear it between tests.
        cache.clear()

        # Durable dispatch is required for locate/read jobs. Tests patch the
        # queue gate and the enqueue seam so no real broker is used. The plugin
        # registry may purge and re-import the plugin package, so resolve the
        # service module fresh for every test.
        import importlib

        services = importlib.import_module('storage_layout.services')

        self.queue = mock.patch.object(services, 'queue_available', return_value=True)
        self.queue.start()
        self.addCleanup(self.queue.stop)

        self.enqueue = mock.patch.object(
            services, 'enqueue_task', return_value='task-1'
        )
        self.enqueue.start()
        self.addCleanup(self.enqueue.stop)

    def cabinet_url(self, suffix=''):
        """Return a cabinet-scoped API URL."""
        return f'{BASE}cabinets/{self.cabinet.pk}/{suffix}'


class PermissionTests(ApiTestCase):
    """Tests for the API permission matrix."""

    def test_oauth_scope_cannot_be_bypassed_by_user_permission(self):
        """An OAuth token is bounded even when its owner may operate hardware."""
        from storage_layout.api import StorageLayoutPermission

        permission = StorageLayoutPermission()
        request = mock.Mock(method='POST', user=self.user)
        view = mock.Mock(permission_map={'POST': 'operate_hardware'})
        with (
            mock.patch.object(permission, 'is_oauth2ed', return_value=True),
            mock.patch.object(
                permission, 'check_oauth2_authentication', return_value=False
            ),
        ):
            self.assertFalse(permission.has_permission(request, view))
        scopes = permission.get_required_alternate_scopes(request, view)
        self.assertEqual(scopes['POST'], [['r:change:stock_location']])
        self.assertEqual(scopes['HEAD'], scopes['GET'])

    def test_anonymous_denied(self):
        """An anonymous request is denied."""
        self.logout()

        response = self.client.get(f'{BASE}cabinets/')

        self.assertIn(response.status_code, (401, 403))

    def test_authenticated_without_permission_denied(self):
        """An authenticated user without the plugin permission is denied."""
        user = User.objects.create_user(username='noperm', password='x')
        self.client.force_login(user)

        response = self.client.get(f'{BASE}cabinets/')

        self.assertEqual(response.status_code, 403)

    def test_view_permission_allows_list(self):
        """A user with view permission can list cabinets."""
        self.get(f'{BASE}cabinets/', expected_code=200)

    def test_change_required_for_layout_write(self):
        """A view-only user cannot write the layout."""
        user = grant(
            User.objects.create_user(username='viewer', password='x'), 'view_cabinet'
        )
        self.client.force_login(user)

        response = self.client.put(
            self.cabinet_url('layout/'),
            {},
            content_type='application/json',
            HTTP_IF_MATCH='"1"',
        )

        self.assertEqual(response.status_code, 403)


class CabinetApiTests(ApiTestCase):
    """Tests for the cabinet endpoints."""

    def test_list(self):
        """The cabinet list is paginated."""
        response = self.get(f'{BASE}cabinets/', expected_code=200)

        self.assertIn('results', response.data)
        self.assertEqual(response.data['count'], 1)

    def test_create(self):
        """A cabinet can be created."""
        location = StockLocation.objects.create(name='New cabinet loc', structural=True)

        response = self.post(
            f'{BASE}cabinets/',
            {
                'name': 'Cabinet 2',
                'slug': 'cabinet-2',
                'location': location.pk,
                'width_units': 100,
                'height_units': 200,
            },
            expected_code=201,
        )

        self.assertEqual(response.data['revision'], 1)
        self.assertTrue(Cabinet.objects.filter(slug='cabinet-2').exists())

    def test_detail_has_etag(self):
        """The detail response carries a revision ETag."""
        response = self.get(f'{BASE}cabinets/{self.cabinet.pk}/', expected_code=200)

        self.assertEqual(response['ETag'], f'"{self.cabinet.revision}"')

    def test_patch_requires_if_match(self):
        """A patch without If-Match is rejected with 428."""
        self.patch(
            f'{BASE}cabinets/{self.cabinet.pk}/', {'name': 'Renamed'}, expected_code=428
        )

    def test_patch_stale_revision(self):
        """A patch with a stale revision is rejected with 412."""
        response = self.patch(
            f'{BASE}cabinets/{self.cabinet.pk}/',
            {'name': 'Renamed'},
            expected_code=412,
            HTTP_IF_MATCH='"999"',
        )

        self.assertEqual(response.data['code'], 'stale')

    def test_patch_success(self):
        """A patch with the current revision succeeds."""
        response = self.patch(
            f'{BASE}cabinets/{self.cabinet.pk}/',
            {'name': 'Renamed'},
            expected_code=200,
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

        self.assertEqual(response.data['name'], 'Renamed')
        self.assertEqual(response.data['revision'], self.cabinet.revision + 1)

    def test_error_shape(self):
        """Domain errors use the documented shape."""
        response = self.patch(
            f'{BASE}cabinets/{self.cabinet.pk}/',
            {'name': 'Renamed'},
            expected_code=412,
            HTTP_IF_MATCH='"999"',
        )

        for key in ('code', 'message', 'errors', 'warnings', 'correlation_id'):
            self.assertIn(key, response.data)


class LayoutApiTests(ApiTestCase):
    """Tests for the layout endpoints."""

    def test_get_layout(self):
        """The layout document includes diagnostics and an ETag."""
        response = self.get(self.cabinet_url('layout/'), expected_code=200)

        self.assertIn('drawers', response.data)
        self.assertIn('diagnostics', response.data)
        self.assertEqual(response['ETag'], f'"{self.cabinet.revision}"')

    def test_validate_layout(self):
        """Validation returns diagnostics without persisting."""
        document = self.get(self.cabinet_url('layout/'), expected_code=200).data
        document['drawers'][0]['width'] = 99999

        response = self.post(
            self.cabinet_url('validate-layout/'), document, expected_code=200
        )

        self.assertFalse(response.data['valid'])

    def test_put_layout(self):
        """A layout write advances the revision."""
        document = self.get(self.cabinet_url('layout/'), expected_code=200).data
        document.pop('diagnostics', None)
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

        response = self.put(
            self.cabinet_url('layout/'),
            document,
            expected_code=200,
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

        self.assertEqual(len(response.data['bins']), 1)

    def test_put_layout_requires_if_match(self):
        """A layout write without If-Match is rejected with 428."""
        document = self.get(self.cabinet_url('layout/'), expected_code=200).data
        document.pop('diagnostics', None)

        self.put(self.cabinet_url('layout/'), document, expected_code=428)

    def test_drawer_layout(self):
        """The drawer projection is available and writable."""
        response = self.get(
            f'{BASE}drawers/{self.drawer.pk}/layout/', expected_code=200
        )

        self.assertEqual(response.data['drawer']['label'], 'A1')


class ElectricalApiTests(ApiTestCase):
    """Tests for the electrical endpoints."""

    def test_get_electrical(self):
        """The electrical document reflects the saved topology."""
        response = self.get(self.cabinet_url('electrical/'), expected_code=200)

        self.assertEqual(len(response.data['controllers']), 1)

    def test_put_electrical_requires_configure(self):
        """A user without configure permission cannot write electrical topology."""
        user = grant(
            User.objects.create_user(username='editor', password='x'),
            'view_cabinet',
            'change_cabinet',
        )
        self.client.force_login(user)

        document = self.get(self.cabinet_url('electrical/'), expected_code=200).data

        response = self.client.put(
            self.cabinet_url('electrical/'),
            document,
            content_type='application/json',
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

        self.assertEqual(response.status_code, 403)

    def test_put_electrical(self):
        """An electrical write advances the revision."""
        document = self.get(self.cabinet_url('electrical/'), expected_code=200).data
        document['controllers'][0]['outputs'][0]['pixel_count'] = 150

        response = self.put(
            self.cabinet_url('electrical/'),
            document,
            expected_code=200,
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

        self.assertEqual(
            response.data['cabinet']['revision'], self.cabinet.revision + 1
        )


class MappingApiTests(ApiTestCase):
    """Tests for the mapping and translation endpoints."""

    def candidate(self):
        """Return a valid candidate mapping document."""
        return {
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

    def test_preview(self):
        """A valid candidate previews with a hash."""
        response = self.post(
            self.cabinet_url('mapping-preview/'), self.candidate(), expected_code=200
        )

        self.assertTrue(response.data['valid'])
        self.assertTrue(response.data['mapping_hash'])

    def test_publish(self):
        """Publishing creates a new active revision."""
        response = self.post(
            self.cabinet_url('mapping-publish/'),
            self.candidate(),
            expected_code=201,
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

        self.assertEqual(response.data['number'], 2)
        self.assertEqual(response.data['total_pixels'], 120)

    def test_publish_requires_if_match(self):
        """Publishing without If-Match is rejected with 428."""
        self.post(
            self.cabinet_url('mapping-publish/'), self.candidate(), expected_code=428
        )

    def test_translate(self):
        """Translation returns physical runs."""
        response = self.post(
            f'{BASE}translate/',
            {
                'cabinet': str(self.cabinet.pk),
                'logical_start': 1,
                'logical_end': 10,
                'mapping_hash': 'hash-1',
            },
            expected_code=200,
        )

        self.assertEqual(response.data['pixel_count'], 10)

    def test_translate_stale_hash(self):
        """A stale mapping hash is rejected with 412."""
        response = self.post(
            f'{BASE}translate/',
            {
                'cabinet': str(self.cabinet.pk),
                'logical_start': 1,
                'logical_end': 10,
                'mapping_hash': 'stale',
            },
            expected_code=412,
        )

        self.assertEqual(response.data['code'], 'stale')


class ProfileApiTests(ApiTestCase):
    """Tests for the profile endpoints."""

    def test_create_and_list(self):
        """A profile can be created and listed."""
        response = self.post(
            f'{BASE}profiles/',
            {
                'cabinet': str(self.cabinet.pk),
                'name': 'Green',
                'purpose': 'locate',
                'rgb_g': 255,
                'brightness': 64,
                'duration_seconds': 120,
            },
            expected_code=201,
        )

        profile_id = response.data['id']

        listing = self.get(f'{BASE}profiles/', expected_code=200)
        self.assertEqual(listing.data['count'], 1)

        detail = self.get(f'{BASE}profiles/{profile_id}/', expected_code=200)
        self.assertEqual(detail.data['name'], 'Green')

    def test_patch_profile(self):
        """A profile can be updated."""
        profile = LocateProfile.objects.create(
            cabinet=self.cabinet, name='Green', brightness=64
        )

        response = self.patch(
            f'{BASE}profiles/{profile.pk}/', {'brightness': 32}, expected_code=200
        )

        self.assertEqual(response.data['brightness'], 32)

    def test_test_profile_duration_cap(self):
        """A test profile cannot exceed the test duration cap."""
        self.post(
            f'{BASE}profiles/',
            {
                'cabinet': str(self.cabinet.pk),
                'name': 'Test',
                'purpose': 'test',
                'duration_seconds': 60,
            },
            expected_code=400,
        )


class SessionApiTests(ApiTestCase):
    """Tests for the locate session endpoints."""

    def payload(self, key='api-1', **overrides):
        """Return a locate session payload."""
        data = {
            'cabinet': str(self.cabinet.pk),
            'target': {'kind': 'drawer', 'id': str(self.drawer.pk)},
            'mode': 'simulate',
            'idempotency_key': key,
        }
        data.update(overrides)

        return data

    def test_create_simulate(self):
        """A simulated session is created queued for durable dispatch."""
        response = self.post(
            f'{BASE}locate-sessions/', self.payload(), expected_code=202
        )

        self.assertEqual(response.data['state'], 'queued')
        self.assertIn('status_url', response.data)

    def test_idempotent_replay(self):
        """The same key and body returns the same session."""
        first = self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=202)
        second = self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=200)

        self.assertEqual(first.data['id'], second.data['id'])

    def test_idempotency_conflict(self):
        """The same key with a different body is rejected with 409."""
        self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=202)

        response = self.post(
            f'{BASE}locate-sessions/',
            self.payload(duration_seconds=30),
            expected_code=409,
        )

        self.assertEqual(response.data['code'], 'idempotency_conflict')

    def test_busy(self):
        """A second session on a busy cabinet is rejected with 409."""
        self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=202)

        response = self.post(
            f'{BASE}locate-sessions/', self.payload(key='api-2'), expected_code=409
        )

        self.assertEqual(response.data['code'], 'cabinet_busy')

    def test_not_locatable(self):
        """An unmapped target is rejected with 409."""
        response = self.post(
            f'{BASE}locate-sessions/',
            self.payload(
                target={'kind': 'location', 'id': str(self.cabinet_location.pk)}
            ),
            expected_code=409,
        )

        self.assertEqual(response.data['code'], 'not_locatable')

    def test_live_fails_closed(self):
        """Live mode fails closed without a commissioned adapter."""
        response = self.post(
            f'{BASE}locate-sessions/',
            self.payload(mode='live', approve_live=True),
            expected_code=503,
        )

        self.assertEqual(response.data['code'], 'live_unavailable')

    def test_detail_and_stop(self):
        """A session can be retrieved and stopped."""
        created = self.post(
            f'{BASE}locate-sessions/', self.payload(), expected_code=202
        )
        session_id = created.data['id']

        detail = self.get(f'{BASE}locate-sessions/{session_id}/', expected_code=200)
        self.assertEqual(detail.data['state'], 'queued')

        stopped = self.post(
            f'{BASE}locate-sessions/{session_id}/stop/', {}, expected_code=202
        )
        self.assertEqual(stopped.data['state'], 'stopped')

    def test_list_filtered(self):
        """The session list can be filtered by cabinet."""
        self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=202)

        response = self.get(
            f'{BASE}locate-sessions/?cabinet={self.cabinet.pk}', expected_code=200
        )

        self.assertEqual(response.data['count'], 1)

    def test_pixel_test(self):
        """A pixel test creates a test session."""
        response = self.post(
            self.cabinet_url('pixel-tests/'),
            {
                'cabinet': str(self.cabinet.pk),
                'logical_start': 1,
                'logical_end': 5,
                'mode': 'simulate',
                'idempotency_key': 'pt-api-1',
            },
            expected_code=202,
        )

        self.assertEqual(response.data['plan']['kind'], 'pixel-test')

    def test_cabinet_stop(self):
        """The cabinet stop endpoint stops the active session."""
        self.post(f'{BASE}locate-sessions/', self.payload(), expected_code=202)

        response = self.post(self.cabinet_url('stop/'), {}, expected_code=202)

        self.assertIsNotNone(response.data['stopped_session'])

    def test_queue_unavailable_returns_503(self):
        """An unavailable queue rejects a locate session with 503."""
        import importlib

        services = importlib.import_module('storage_layout.services')

        with mock.patch.object(services, 'queue_available', return_value=False):
            response = self.post(
                f'{BASE}locate-sessions/', self.payload(), expected_code=503
            )

        self.assertEqual(response.data['code'], 'queue_unavailable')


class HardwareApiTests(ApiTestCase):
    """Tests for the hardware endpoints (all fail closed by default)."""

    def test_arm_fails_closed(self):
        """Arm fails closed while hardware is disabled."""
        response = self.post(
            self.cabinet_url('arm/'),
            {'controllers': [str(self.controller.pk)]},
            expected_code=503,
        )

        self.assertEqual(response.data['code'], 'live_unavailable')

    def test_observe_simulate(self):
        """A simulated observation creates a durable pending job."""
        response = self.post(
            f'{BASE}controllers/{self.controller.pk}/observe/',
            {'mode': 'simulate'},
            expected_code=202,
        )

        self.assertEqual(response.data['state'], 'pending')
        self.assertEqual(response.data['kind'], 'observe')

    def test_observe_live_fails_closed(self):
        """A live observation fails closed."""
        response = self.post(
            f'{BASE}controllers/{self.controller.pk}/observe/',
            {'mode': 'live'},
            expected_code=503,
        )

        self.assertEqual(response.data['code'], 'live_unavailable')

    def observe(self):
        """Create and run an observe job, returning the observation ID."""
        from storage_layout import services as svc

        job = svc.create_observe_job(self.controller, self.user, 'simulate')
        svc.execute_read_job(job.pk)
        job.refresh_from_db()

        return job.result['observation']

    def test_import_preview_and_import(self):
        """An observation can be previewed and imported."""
        observation_id = self.observe()

        preview = self.post(
            f'{BASE}controllers/{self.controller.pk}/import-preview/',
            {'observation': observation_id},
            expected_code=200,
        )

        self.assertIn('diff_hash', preview.data)

        self.post(
            f'{BASE}controllers/{self.controller.pk}/import/',
            {
                'observation': observation_id,
                'accepted_diff_hash': preview.data['diff_hash'],
            },
            expected_code=200,
            HTTP_IF_MATCH=f'"{self.cabinet.revision}"',
        )

    def test_approve_configuration(self):
        """A supported observation can be approved."""
        observation_id = self.observe()

        response = self.post(
            f'{BASE}controllers/{self.controller.pk}/approve-configuration/',
            {'observation': observation_id},
            expected_code=200,
        )

        self.assertEqual(response.data['controller'], str(self.controller.pk))

    def test_discovery_simulate(self):
        """A simulated discovery job is queued then completes."""
        response = self.post(
            f'{BASE}discovery/',
            {'cabinet': str(self.cabinet.pk), 'mode': 'simulate'},
            expected_code=202,
        )

        self.assertEqual(response.data['kind'], 'discovery')
        self.assertEqual(response.data['state'], 'pending')

        from storage_layout import services as svc

        svc.execute_read_job(response.data['id'])

        job = self.get(f'{BASE}jobs/{response.data["id"]}/', expected_code=200)
        self.assertEqual(job.data['state'], 'complete')


class OwnershipApiTests(ApiTestCase):
    """Tests for native stock location ownership scoping."""

    def setUp(self):
        """Enable ownership control and assign the cabinet to another owner."""
        super().setUp()

        from django.contrib.auth.models import Group

        from common.models import InvenTreeSetting
        from users.models import Owner

        InvenTreeSetting.set_setting('STOCK_OWNERSHIP_CONTROL', True, self.user)

        other_group = Group.objects.create(name='other_owner_group')
        self.cabinet_location.owner = Owner.get_owner(other_group)
        self.cabinet_location.save()

    def test_list_excludes_unowned_cabinet(self):
        """A cabinet owned by another group is not listed."""
        response = self.get(f'{BASE}cabinets/', expected_code=200)

        self.assertEqual(response.data['count'], 0)

    def test_detail_hidden_for_unowned_cabinet(self):
        """A cabinet owned by another group is reported as missing."""
        self.get(f'{BASE}cabinets/{self.cabinet.pk}/', expected_code=404)

    def test_layout_hidden_for_unowned_cabinet(self):
        """The layout of an unowned cabinet is reported as missing."""
        self.get(self.cabinet_url('layout/'), expected_code=404)

    def test_drawer_hidden_for_unowned_cabinet(self):
        """A drawer in an unowned cabinet is reported as missing."""
        self.get(f'{BASE}drawers/{self.drawer.pk}/layout/', expected_code=404)

    def test_controller_hidden_for_unowned_cabinet(self):
        """A controller in an unowned cabinet is reported as missing."""
        self.post(
            f'{BASE}controllers/{self.controller.pk}/observe/',
            {'mode': 'simulate'},
            expected_code=404,
        )

    def test_session_hidden_for_unowned_cabinet(self):
        """A session for an unowned cabinet is reported as missing."""
        from storage_layout.models import LocateSession

        session = LocateSession.objects.create(
            cabinet=self.cabinet, target_kind='drawer', idempotency_key='own-1'
        )

        self.get(f'{BASE}locate-sessions/{session.pk}/', expected_code=404)

    def test_session_list_excludes_unowned_cabinet(self):
        """The session list excludes sessions for unowned cabinets."""
        from storage_layout.models import LocateSession

        LocateSession.objects.create(
            cabinet=self.cabinet, target_kind='drawer', idempotency_key='own-2'
        )

        response = self.get(f'{BASE}locate-sessions/', expected_code=200)

        self.assertEqual(response.data['count'], 0)

    def test_child_owner_override_hides_atomic_layout(self):
        """Owning the root must not expose another owner's drawer/bins."""
        from users.models import Owner

        self.drawer_location.owner = self.cabinet_location.owner
        self.drawer_location.save()
        self.cabinet_location.owner = Owner.get_owner(self.group)
        self.cabinet_location.save()
        self.get(self.cabinet_url('layout/'), expected_code=404)
        self.get(f'{BASE}drawers/{self.drawer.pk}/layout/', expected_code=404)
        response = self.get(f'{BASE}cabinets/', expected_code=200)
        self.assertEqual(response.data['count'], 0)

    def test_owner_can_access(self):
        """The owning group can access the cabinet."""
        from users.models import Owner

        self.cabinet_location.owner = Owner.get_owner(self.group)
        self.cabinet_location.save()

        self.get(f'{BASE}cabinets/{self.cabinet.pk}/', expected_code=200)


class JobScopeApiTests(ApiTestCase):
    """Tests for actor-scoped read jobs."""

    def make_job(self):
        """Create a durable observe job for the test user."""
        import importlib

        svc = importlib.import_module('storage_layout.services')

        return svc.create_observe_job(self.controller, self.user, 'simulate')

    def test_job_visible_to_actor(self):
        """The initiating actor can read their job."""
        job = self.make_job()

        self.get(f'{BASE}jobs/{job.pk}/', expected_code=200)

    def test_job_hidden_from_view_only_user(self):
        """A view-only user cannot read another actor's job."""
        job = self.make_job()

        other = grant(
            User.objects.create_user(username='viewer2', password='x'), 'view_cabinet'
        )
        self.client.force_login(other)

        self.get(f'{BASE}jobs/{job.pk}/', expected_code=404)

    def test_job_visible_to_operator(self):
        """A hardware operator can read a job."""
        job = self.make_job()

        other = grant(
            User.objects.create_user(username='op2', password='x'),
            'view_cabinet',
            'operate_hardware',
        )
        self.client.force_login(other)

        self.get(f'{BASE}jobs/{job.pk}/', expected_code=200)


class SchemaApiTests(ApiTestCase):
    """Tests for the plugin schema endpoint."""

    def test_schema_available(self):
        """The plugin schema endpoint returns a document."""
        response = self.get(f'{BASE}schema/', expected_code=200)

        self.assertIn('openapi', response.data)


class PluginWiringTests(ApiTestCase):
    """Tests that the plugin exposes the API and reconciliation wiring."""

    def test_plugin_exposes_urls(self):
        """The plugin declares the URLS mixin and exposes patterns."""
        from plugin.registry import registry

        self.ensurePluginsLoaded()
        registry.set_plugin_state('storage-layout', True)

        plugin = registry.get_plugin('storage-layout')

        self.assertTrue(plugin.has_urls)
        self.assertTrue(plugin.urlpatterns)

    def test_plugin_declares_reconciliation(self):
        """The plugin declares the reconciliation scheduled task."""
        from storage_layout.plugin import StorageLayoutPlugin

        self.assertIn('reconcile', StorageLayoutPlugin.SCHEDULED_TASKS)

    def test_reconcile_member_runs(self):
        """The plugin reconciliation member runs the bounded watchdog loop."""
        from plugin.registry import registry

        self.ensurePluginsLoaded()
        registry.set_plugin_state('storage-layout', True)

        plugin = registry.get_plugin('storage-layout')

        # Patch by path so the patch targets the module the plugin imports at
        # call time (the registry may have purged and re-imported the package).
        with mock.patch(
            'storage_layout.tasks.watchdog_loop', return_value={'sweeps': 1}
        ) as loop:
            result = plugin.reconcile()

        loop.assert_called_once()
        self.assertEqual(result['sweeps'], 1)


class ThrottleTests(ApiTestCase):
    """Tests for the hardware rate limiting."""

    def payload(self, key):
        """Return a locate session payload."""
        return {
            'cabinet': str(self.cabinet.pk),
            'target': {'kind': 'drawer', 'id': str(self.drawer.pk)},
            'mode': 'simulate',
            'idempotency_key': key,
        }

    def test_locate_rate_limited(self):
        """The locate endpoint is limited to 10 requests per minute."""
        for index in range(10):
            expected = 202 if index == 0 else 409
            self.post(
                f'{BASE}locate-sessions/',
                self.payload(f'rate-{index}'),
                expected_code=expected,
            )

        self.post(f'{BASE}locate-sessions/', self.payload('rate-11'), expected_code=429)

    def test_read_not_throttled(self):
        """Read-only requests are never rate limited."""
        for _ in range(15):
            self.get(f'{BASE}locate-sessions/', expected_code=200)
