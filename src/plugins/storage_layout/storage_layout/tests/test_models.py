"""Database model tests for the Storage Layout plugin.

These tests cover the plugin-owned schema: constraints, defaults, lifecycle
hooks, custom permissions and the DB-backed validation helpers.
"""

from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.utils import timezone

from InvenTree.unit_test import InvenTreeTestCase
from stock.models import StockLocation
from storage_layout import validation as v
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
    LocateProfile,
    LocateSession,
    MappingRevision,
    MappingState,
    PixelSpan,
)


class StorageLayoutTestCase(InvenTreeTestCase):
    """Base test case which builds a small cabinet/drawer/bin fixture."""

    def setUp(self):
        """Build native locations and a cabinet."""
        super().setUp()

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

    def make_drawer(self, **kwargs):
        """Create a drawer attached to the test cabinet."""
        data = {
            'cabinet': self.cabinet,
            'label': 'A1',
            'display_number': 1,
            'location': self.drawer_location,
            'x': 0,
            'y': 0,
            'width': 300,
            'height': 100,
            'interior_width': 280,
            'interior_height': 400,
        }
        data.update(kwargs)
        return Drawer.objects.create(**data)

    def make_controller(self, **kwargs):
        """Create a controller attached to the test cabinet."""
        data = {
            'cabinet': self.cabinet,
            'name': 'Controller A',
            'origin': 'http://wled-a.local',
        }
        data.update(kwargs)
        return Controller.objects.create(**data)


class CabinetTests(StorageLayoutTestCase):
    """Tests for the Cabinet aggregate root."""

    def test_defaults(self):
        """A new cabinet starts at revision 1 and is not archived."""
        self.assertEqual(self.cabinet.revision, 1)
        self.assertFalse(self.cabinet.archived)
        self.assertIsNone(self.cabinet.active_mapping)
        self.assertIsNone(self.cabinet.default_profile)

    def test_operation_row_precreated(self):
        """Creating a cabinet precreates its reservation row."""
        self.assertTrue(CabinetOperation.objects.filter(cabinet=self.cabinet).exists())

    def test_slug_is_unique(self):
        """Cabinet slugs must be unique."""
        with self.assertRaises(IntegrityError), transaction.atomic():
            Cabinet.objects.create(
                name='Duplicate',
                slug='cabinet-1',
                location=StockLocation.objects.create(name='Other', structural=True),
                width_units=10,
                height_units=10,
            )

    def test_location_is_protected(self):
        """A bound native location cannot be deleted."""
        with self.assertRaises((ValidationError, ProtectedError)), transaction.atomic():
            self.cabinet_location.delete()

    def test_clean_rejects_foreign_active_mapping(self):
        """The active mapping must belong to the same cabinet."""
        other_location = StockLocation.objects.create(name='Cabinet 2', structural=True)
        other = Cabinet.objects.create(
            name='Cabinet 2',
            slug='cabinet-2',
            location=other_location,
            width_units=100,
            height_units=100,
        )
        mapping = MappingRevision.objects.create(cabinet=other, number=1)

        self.cabinet.active_mapping = mapping

        with self.assertRaises(ValidationError):
            self.cabinet.clean()

    def test_clean_rejects_foreign_default_profile(self):
        """The default profile must belong to the same cabinet."""
        other_location = StockLocation.objects.create(name='Cabinet 3', structural=True)
        other = Cabinet.objects.create(
            name='Cabinet 3',
            slug='cabinet-3',
            location=other_location,
            width_units=100,
            height_units=100,
        )
        profile = LocateProfile.objects.create(cabinet=other, name='Green')

        self.cabinet.default_profile = profile

        with self.assertRaises(ValidationError):
            self.cabinet.clean()

    def test_custom_permissions_defined(self):
        """The three hardware permissions are declared on the model."""
        codenames = {code for code, _label in Cabinet._meta.permissions}

        self.assertEqual(
            codenames, {'configure_hardware', 'operate_hardware', 'emergency_stop'}
        )

    def test_check_user_permission_superuser(self):
        """A superuser passes every cabinet permission check."""
        self.user.is_superuser = True
        self.user.save()

        self.assertTrue(Cabinet.check_user_permission(self.user, 'view'))
        self.assertTrue(Cabinet.check_user_permission(self.user, 'operate_hardware'))

    def test_check_user_permission_denied_by_default(self):
        """A plain user is denied hardware permissions by default."""
        self.assertFalse(Cabinet.check_user_permission(self.user, 'operate_hardware'))
        self.assertFalse(Cabinet.check_user_permission(self.user, 'emergency_stop'))

    def test_check_user_permission_unknown_permission(self):
        """An unknown permission name is denied."""
        self.assertFalse(Cabinet.check_user_permission(self.user, 'not_a_permission'))

    def test_check_user_permission_inactive_user(self):
        """An inactive user is denied."""
        self.user.is_active = False

        self.assertFalse(Cabinet.check_user_permission(self.user, 'view'))


class DrawerAndBinTests(StorageLayoutTestCase):
    """Tests for drawer and bin constraints."""

    def test_drawer_label_unique_per_cabinet(self):
        """Drawer labels are unique within a cabinet."""
        self.make_drawer()

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_drawer(
                display_number=2,
                location=StockLocation.objects.create(
                    name='Drawer A2', parent=self.cabinet_location, structural=True
                ),
            )

    def test_drawer_number_unique_per_cabinet(self):
        """Drawer display numbers are unique within a cabinet."""
        self.make_drawer()

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_drawer(
                label='A2',
                location=StockLocation.objects.create(
                    name='Drawer A2', parent=self.cabinet_location, structural=True
                ),
            )

    def test_drawer_number_must_be_positive(self):
        """A drawer display number must be at least 1."""
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_drawer(display_number=0)

    def test_drawer_location_is_protected(self):
        """A bound drawer location cannot be deleted."""
        self.make_drawer()

        with self.assertRaises((ValidationError, ProtectedError)), transaction.atomic():
            self.drawer_location.delete()

    def test_bin_label_unique_per_drawer(self):
        """Bin labels are unique within a drawer."""
        drawer = self.make_drawer()
        Bin.objects.create(drawer=drawer, label='A1-01', width=10, height=10)

        with self.assertRaises(IntegrityError), transaction.atomic():
            Bin.objects.create(drawer=drawer, label='A1-01', width=10, height=10)

    def test_bin_may_be_unbound(self):
        """A bin may be saved without a native location."""
        drawer = self.make_drawer()
        bin_row = Bin.objects.create(drawer=drawer, label='A1-01', width=10, height=10)

        self.assertIsNone(bin_row.location)

    def test_bin_zero_size_rejected(self):
        """A zero-sized bin is rejected by the database."""
        drawer = self.make_drawer()

        with self.assertRaises(IntegrityError), transaction.atomic():
            Bin.objects.create(drawer=drawer, label='A1-01', width=0, height=10)


class AllocationTests(StorageLayoutTestCase):
    """Tests for drawer allocations."""

    def test_end_before_start_rejected(self):
        """The database enforces end >= start."""
        drawer = self.make_drawer()

        with self.assertRaises(IntegrityError), transaction.atomic():
            DrawerAllocation.objects.create(
                drawer=drawer, logical_start=10, logical_end=5
            )

    def test_pixel_count(self):
        """The pixel count is inclusive."""
        drawer = self.make_drawer()
        allocation = DrawerAllocation.objects.create(
            drawer=drawer, logical_start=45, logical_end=75
        )

        self.assertEqual(allocation.pixel_count, 31)

    def test_one_allocation_per_drawer(self):
        """A drawer has at most one allocation row."""
        drawer = self.make_drawer()
        DrawerAllocation.objects.create(drawer=drawer, logical_start=1, logical_end=5)

        with self.assertRaises(IntegrityError), transaction.atomic():
            DrawerAllocation.objects.create(
                drawer=drawer, logical_start=6, logical_end=10
            )


class MappingRevisionTests(StorageLayoutTestCase):
    """Tests for mapping revisions and pixel spans."""

    def test_number_unique_per_cabinet(self):
        """Mapping numbers are unique within a cabinet."""
        MappingRevision.objects.create(cabinet=self.cabinet, number=1)

        with self.assertRaises(IntegrityError), transaction.atomic():
            MappingRevision.objects.create(cabinet=self.cabinet, number=1)

    def test_published_requires_pixels(self):
        """A published mapping must declare a positive pixel count."""
        with self.assertRaises(IntegrityError), transaction.atomic():
            MappingRevision.objects.create(
                cabinet=self.cabinet,
                number=1,
                state=MappingState.PUBLISHED,
                total_pixels=0,
            )

    def test_draft_may_have_no_pixels(self):
        """An empty draft mapping is permitted."""
        mapping = MappingRevision.objects.create(cabinet=self.cabinet, number=1)

        self.assertEqual(mapping.state, MappingState.DRAFT)
        self.assertEqual(mapping.total_pixels, 0)

    def test_published_revision_is_immutable(self):
        """A published revision cannot be modified."""
        mapping = MappingRevision.objects.create(
            cabinet=self.cabinet,
            number=1,
            state=MappingState.PUBLISHED,
            total_pixels=10,
        )

        mapping.total_pixels = 20

        with self.assertRaises(ValidationError):
            mapping.save()

    def test_published_revision_cannot_be_unpublished(self):
        """A published revision cannot be reverted to draft."""
        mapping = MappingRevision.objects.create(
            cabinet=self.cabinet,
            number=1,
            state=MappingState.PUBLISHED,
            total_pixels=10,
        )

        mapping.state = MappingState.DRAFT

        with self.assertRaises(ValidationError):
            mapping.save()

    def test_draft_revision_is_mutable(self):
        """A draft revision can be edited."""
        mapping = MappingRevision.objects.create(cabinet=self.cabinet, number=1)
        mapping.total_pixels = 20
        mapping.save()

        mapping.refresh_from_db()
        self.assertEqual(mapping.total_pixels, 20)

    def test_span_logical_start_unique(self):
        """Logical starts are unique within a mapping revision."""
        mapping = MappingRevision.objects.create(cabinet=self.cabinet, number=1)
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(output=output, label='S1', pixel_count=100)

        PixelSpan.objects.create(
            mapping_revision=mapping, string=string, logical_start=1, length=10
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            PixelSpan.objects.create(
                mapping_revision=mapping, string=string, logical_start=1, length=10
            )

    def test_span_direction_constraint(self):
        """Only +1 and -1 are valid directions."""
        mapping = MappingRevision.objects.create(cabinet=self.cabinet, number=1)
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(output=output, label='S1', pixel_count=100)

        with self.assertRaises(IntegrityError), transaction.atomic():
            PixelSpan.objects.create(
                mapping_revision=mapping,
                string=string,
                logical_start=1,
                length=10,
                direction=0,
            )

    def test_span_logical_end(self):
        """The logical end is inclusive."""
        mapping = MappingRevision.objects.create(cabinet=self.cabinet, number=1)
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(output=output, label='S1', pixel_count=100)
        span = PixelSpan.objects.create(
            mapping_revision=mapping, string=string, logical_start=45, length=31
        )

        self.assertEqual(span.logical_end, 75)


class ControllerTests(StorageLayoutTestCase):
    """Tests for controller and electrical topology models."""

    def test_origin_is_unique(self):
        """Controller origins are globally unique."""
        self.make_controller()

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_controller(name='Controller B')

    def test_mac_normalised_and_uppercased(self):
        """A MAC address is uppercased on save."""
        controller = self.make_controller(expected_mac='aa:bb:cc:dd:ee:ff')

        self.assertEqual(controller.expected_mac, 'AA:BB:CC:DD:EE:FF')

    def test_blank_mac_normalised_to_null(self):
        """A blank MAC address is stored as NULL."""
        controller = self.make_controller(expected_mac='   ')

        self.assertIsNone(controller.expected_mac)

    def test_multiple_null_macs_allowed(self):
        """Nullable uniqueness permits several uncommissioned controllers."""
        self.make_controller(expected_mac=None)
        self.make_controller(name='Controller B', origin='http://wled-b.local')

        self.assertEqual(
            Controller.objects.filter(expected_mac__isnull=True).count(), 2
        )

    def test_duplicate_mac_rejected(self):
        """A populated MAC address is unique."""
        self.make_controller(expected_mac='AA:BB:CC:DD:EE:FF')

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_controller(
                name='Controller B',
                origin='http://wled-b.local',
                expected_mac='AA:BB:CC:DD:EE:FF',
            )

    def test_clean_canonicalises_origin(self):
        """A valid origin is canonicalised during clean."""
        controller = self.make_controller(origin='http://WLED-A.local:80')
        controller.clean()

        self.assertEqual(controller.origin, 'http://wled-a.local')

    def test_origin_canonicalised_on_save(self):
        """A valid origin is canonicalised when the model is saved."""
        controller = self.make_controller(origin='http://WLED-A.local:80')
        controller.refresh_from_db()

        self.assertEqual(controller.origin, 'http://wled-a.local')

    def test_equivalent_origins_collide(self):
        """Equivalent spellings of one origin cannot both be stored."""
        self.make_controller(origin='http://wled-a.local')

        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_controller(name='Controller B', origin='http://WLED-A.local:80')

    def test_clean_rejects_invalid_origin(self):
        """An invalid origin is rejected during clean."""
        controller = self.make_controller(origin='http://wled-a.local/json')

        with self.assertRaises(ValidationError):
            controller.clean()

    def test_clean_rejects_invalid_mac(self):
        """A malformed MAC address is rejected during clean."""
        controller = self.make_controller(expected_mac='not-a-mac')

        with self.assertRaises(ValidationError):
            controller.clean()

    def test_output_bus_index_unique(self):
        """Bus indices are unique within a controller."""
        controller = self.make_controller()
        ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=50
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            ControllerOutput.objects.create(
                controller=controller, bus_index=0, pixel_count=50
            )

    def test_output_count_positive(self):
        """An output must have at least one pixel."""
        controller = self.make_controller()

        with self.assertRaises(IntegrityError), transaction.atomic():
            ControllerOutput.objects.create(
                controller=controller, bus_index=0, pixel_count=0
            )

    def test_output_wled_end(self):
        """The exclusive WLED end is start plus count."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, wled_start=80, pixel_count=30
        )

        self.assertEqual(output.wled_end, 110)

    def test_string_label_unique_per_output(self):
        """String labels are unique within an output."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        LEDString.objects.create(output=output, label='S1', pixel_count=50)

        with self.assertRaises(IntegrityError), transaction.atomic():
            LEDString.objects.create(output=output, label='S1', pixel_count=50)

    def test_string_output_end(self):
        """The exclusive output-local end is offset plus count."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(
            output=output, label='S1', output_offset=10, pixel_count=20
        )

        self.assertEqual(string.output_end, 30)


class ObservationTests(StorageLayoutTestCase):
    """Tests for append-only observation and audit models."""

    def test_config_observation_is_append_only(self):
        """An existing observation cannot be updated."""
        controller = self.make_controller()
        observation = ConfigObservation.objects.create(
            controller=controller, observed_at=timezone.now()
        )

        observation.fingerprint = 'abc'

        with self.assertRaises(ValidationError):
            observation.save()

    def test_config_observation_defaults(self):
        """An observation defaults to an unverified capability status."""
        controller = self.make_controller()
        observation = ConfigObservation.objects.create(
            controller=controller, observed_at=timezone.now()
        )

        self.assertEqual(observation.capability_status, 'unverified')

    def test_design_audit_is_append_only(self):
        """An existing audit entry cannot be updated."""
        entry = DesignAudit.objects.create(cabinet=self.cabinet, operation='publish')

        entry.operation = 'other'

        with self.assertRaises(ValidationError):
            entry.save()

    def test_design_audit_survives_cabinet_deletion(self):
        """Audit snapshots survive cabinet deletion."""
        DesignAudit.objects.create(cabinet=self.cabinet, operation='publish')

        self.cabinet.delete()

        entry = DesignAudit.objects.get()
        self.assertIsNone(entry.cabinet)


class LocateProfileTests(StorageLayoutTestCase):
    """Tests for locate profiles."""

    def test_name_unique_per_cabinet(self):
        """Profile names are unique within a cabinet."""
        LocateProfile.objects.create(cabinet=self.cabinet, name='Green')

        with self.assertRaises(IntegrityError), transaction.atomic():
            LocateProfile.objects.create(cabinet=self.cabinet, name='Green')

    def test_defaults(self):
        """The recommended green profile defaults are applied."""
        profile = LocateProfile.objects.create(cabinet=self.cabinet, name='Green')

        self.assertEqual(profile.rgb, (0, 255, 0))
        self.assertEqual(profile.white, 0)
        self.assertEqual(profile.brightness, 64)
        self.assertEqual(profile.duration_seconds, 120)

    def test_brightness_range(self):
        """Brightness must be within 1..255."""
        with self.assertRaises(IntegrityError), transaction.atomic():
            LocateProfile.objects.create(
                cabinet=self.cabinet, name='Too bright', brightness=0
            )

    def test_duration_range(self):
        """Duration must be within 1..120 seconds."""
        with self.assertRaises(IntegrityError), transaction.atomic():
            LocateProfile.objects.create(
                cabinet=self.cabinet, name='Too long', duration_seconds=121
            )

    def test_test_profile_duration_cap(self):
        """Test profiles are capped at 10 seconds by clean()."""
        profile = LocateProfile.objects.create(
            cabinet=self.cabinet, name='Test', purpose='test', duration_seconds=20
        )

        with self.assertRaises(ValidationError):
            profile.clean()

    def test_test_profile_within_cap(self):
        """A short test profile passes clean()."""
        profile = LocateProfile.objects.create(
            cabinet=self.cabinet, name='Test', purpose='test', duration_seconds=5
        )

        profile.clean()


class OperationModelTests(StorageLayoutTestCase):
    """Tests for session, execution and read job models."""

    def test_session_idempotency_key_unique(self):
        """Idempotency keys are unique within a cabinet."""
        LocateSession.objects.create(
            cabinet=self.cabinet, target_kind='drawer', idempotency_key='abc'
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            LocateSession.objects.create(
                cabinet=self.cabinet, target_kind='drawer', idempotency_key='abc'
            )

    def test_session_defaults(self):
        """A new session defaults to a queued simulation."""
        session = LocateSession.objects.create(
            cabinet=self.cabinet, target_kind='drawer', idempotency_key='abc'
        )

        self.assertEqual(session.state, 'queued')
        self.assertEqual(session.mode, 'simulate')

    def test_execution_unique_per_controller(self):
        """A session has at most one execution row per controller."""
        session = LocateSession.objects.create(
            cabinet=self.cabinet, target_kind='drawer', idempotency_key='abc'
        )
        controller = self.make_controller()

        ControllerExecution.objects.create(session=session, controller=controller)

        with self.assertRaises(IntegrityError), transaction.atomic():
            ControllerExecution.objects.create(session=session, controller=controller)

    def test_read_job_defaults(self):
        """A read job defaults to a pending simulation."""
        job = HardwareReadJob.objects.create(kind='observe')

        self.assertEqual(job.state, 'pending')
        self.assertEqual(job.mode, 'simulate')

    def test_operation_row_generation_default(self):
        """The reservation row starts at generation zero."""
        operation = CabinetOperation.objects.get(cabinet=self.cabinet)

        self.assertEqual(operation.generation, 0)
        self.assertIsNone(operation.current_session)


class DatabaseValidationHelperTests(StorageLayoutTestCase):
    """Tests for the DB-backed validation helpers."""

    def test_validate_cabinet_layout_clean(self):
        """A well-formed cabinet layout validates."""
        drawer = self.make_drawer()
        Bin.objects.create(
            drawer=drawer,
            label='A1-01',
            location=self.bin_location,
            width=70,
            height=100,
        )

        report = v.validate_cabinet_layout(self.cabinet)

        self.assertTrue(report.valid, report.as_dict())

    def test_validate_cabinet_layout_detects_overlap(self):
        """Overlapping drawers are detected through the DB helper."""
        self.make_drawer()
        self.make_drawer(
            label='A2',
            display_number=2,
            x=100,
            location=StockLocation.objects.create(
                name='Drawer A2', parent=self.cabinet_location, structural=True
            ),
        )

        report = v.validate_cabinet_layout(self.cabinet)

        self.assertFalse(report.valid)
        self.assertIn(v.CODE_GEOMETRY_OVERLAP, {issue.code for issue in report.errors})

    def test_validate_cabinet_layout_detects_bad_binding(self):
        """A drawer bound to a non-structural location is reported."""
        self.drawer_location.structural = False
        self.drawer_location.save()

        self.make_drawer()

        report = v.validate_cabinet_layout(self.cabinet)

        self.assertFalse(report.valid)
        self.assertIn(v.CODE_BINDING_INVALID, {issue.code for issue in report.errors})

    def test_validate_mapping_revision_clean(self):
        """A complete mapping revision validates."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(output=output, label='S1', pixel_count=100)
        mapping = MappingRevision.objects.create(
            cabinet=self.cabinet, number=1, total_pixels=100
        )
        PixelSpan.objects.create(
            mapping_revision=mapping, string=string, logical_start=1, length=100
        )

        report = v.validate_mapping_revision(mapping)

        self.assertTrue(report.valid, report.as_dict())

    def test_validate_mapping_revision_detects_gap(self):
        """An incomplete mapping revision is reported."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100
        )
        string = LEDString.objects.create(output=output, label='S1', pixel_count=100)
        mapping = MappingRevision.objects.create(
            cabinet=self.cabinet, number=1, total_pixels=100
        )
        PixelSpan.objects.create(
            mapping_revision=mapping, string=string, logical_start=1, length=50
        )

        report = v.validate_mapping_revision(mapping)

        self.assertFalse(report.valid)
        self.assertIn(v.CODE_MAPPING_GAP, {issue.code for issue in report.errors})

    def test_validate_controller_clean(self):
        """A well-formed controller topology validates."""
        controller = self.make_controller()
        output = ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=100, pins=[16]
        )
        LEDString.objects.create(output=output, label='S1', pixel_count=100)

        report = v.validate_controller(controller)

        self.assertTrue(report.valid, report.as_dict())

    def test_validate_controller_detects_gpio_conflict(self):
        """A GPIO conflict is detected through the DB helper."""
        controller = self.make_controller()
        ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=50, pins=[16]
        )
        ControllerOutput.objects.create(
            controller=controller, bus_index=1, wled_start=50, pixel_count=50, pins=[16]
        )

        report = v.validate_controller(controller)

        self.assertFalse(report.valid)
        self.assertIn(v.CODE_GPIO_CONFLICT, {issue.code for issue in report.errors})

    def test_validate_controller_requires_supported_for_arm(self):
        """Unsupported configuration blocks arming but not design."""
        controller = self.make_controller()
        ControllerOutput.objects.create(
            controller=controller, bus_index=0, pixel_count=50, bus_reverse=True
        )

        self.assertTrue(v.validate_controller(controller).valid)
        self.assertFalse(
            v.validate_controller(controller, require_supported=True).valid
        )


class TimestampTests(StorageLayoutTestCase):
    """Tests for UTC timestamps on plugin models."""

    def test_created_and_updated_timestamps(self):
        """Mutable models record creation and update timestamps."""
        self.assertIsNotNone(self.cabinet.created_at)
        self.assertIsNotNone(self.cabinet.updated_at)

        original = self.cabinet.updated_at
        self.cabinet.name = 'Renamed'
        self.cabinet.save()
        self.cabinet.refresh_from_db()

        self.assertGreaterEqual(self.cabinet.updated_at, original)

    def test_append_only_model_has_no_updated_at(self):
        """Append-only models do not carry an updated timestamp."""
        self.assertFalse(hasattr(DesignAudit(), 'updated_at'))

    def test_expiry_fields_accept_aware_datetimes(self):
        """Session expiry accepts timezone-aware datetimes."""
        session = LocateSession.objects.create(
            cabinet=self.cabinet,
            target_kind='drawer',
            idempotency_key='abc',
            expires_at=timezone.now() + timedelta(seconds=120),
        )

        self.assertIsNotNone(session.expires_at)
