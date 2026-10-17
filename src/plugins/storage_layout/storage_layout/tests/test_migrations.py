"""Migration lifecycle tests for the Storage Layout plugin.

These tests are tagged ``migration_test`` so that CI can run them separately
(they must not be run with ``--keepdb``, because they manipulate the schema).
"""

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.test.utils import tag

from stock.models import StockLocation

APP = 'storage_layout'

MIGRATION_0001 = '0001_storage_and_electrical'
MIGRATION_0002 = '0002_mapping_and_constraints'
MIGRATION_0003 = '0003_operations_audit_permissions'

LATEST = MIGRATION_0003

TABLES = (
    'storage_layout_cabinet',
    'storage_layout_drawer',
    'storage_layout_bin',
    'storage_layout_controller',
    'storage_layout_controlleroutput',
    'storage_layout_ledstring',
    'storage_layout_configobservation',
    'storage_layout_locateprofile',
    'storage_layout_mappingrevision',
    'storage_layout_pixelspan',
    'storage_layout_drawerallocation',
    'storage_layout_locatesession',
    'storage_layout_cabinetoperation',
    'storage_layout_controllerexecution',
    'storage_layout_hardwarereadjob',
    'storage_layout_designaudit',
)


def table_names():
    """Return the set of table names in the test database."""
    return set(connection.introspection.table_names())


def migrate_to(target):
    """Migrate the plugin app to a specific target and return the executor."""
    executor = MigrationExecutor(connection)
    executor.migrate([(APP, target)])
    return MigrationExecutor(connection)


@tag('migration_test')
class MigrationLifecycleTests(TransactionTestCase):
    """Tests for the additive, reversible plugin migration lifecycle."""

    def tearDown(self):
        """Restore the plugin schema to the latest migration."""
        call_command('migrate', APP, verbosity=0)
        super().tearDown()

    def test_migrations_apply_forward(self):
        """All plugin migrations apply and create the expected tables."""
        call_command('migrate', APP, verbosity=0)

        names = table_names()

        for table in TABLES:
            self.assertIn(table, names)

    def test_migrations_are_reversible(self):
        """The plugin migrations can be reversed and re-applied."""
        call_command('migrate', APP, 'zero', verbosity=0)

        names = table_names()

        for table in TABLES:
            self.assertNotIn(table, names)

        call_command('migrate', APP, verbosity=0)

        names = table_names()

        for table in TABLES:
            self.assertIn(table, names)

    def test_partial_migration_boundaries(self):
        """Each migration creates only its own schema."""
        migrate_to(MIGRATION_0001)
        names = table_names()

        self.assertIn('storage_layout_cabinet', names)
        self.assertNotIn('storage_layout_mappingrevision', names)
        self.assertNotIn('storage_layout_cabinetoperation', names)

        migrate_to(MIGRATION_0002)
        names = table_names()

        self.assertIn('storage_layout_mappingrevision', names)
        self.assertIn('storage_layout_pixelspan', names)
        self.assertIn('storage_layout_drawerallocation', names)
        self.assertNotIn('storage_layout_cabinetoperation', names)

        migrate_to(MIGRATION_0003)
        names = table_names()

        self.assertIn('storage_layout_cabinetoperation', names)
        self.assertIn('storage_layout_designaudit', names)

    def test_operation_rows_created_for_existing_cabinets(self):
        """The 0003 data migration precreates reservation rows."""
        executor = migrate_to(MIGRATION_0002)

        state = executor.loader.project_state([(APP, MIGRATION_0002)])
        cabinet_model = state.apps.get_model(APP, 'Cabinet')

        location = StockLocation.objects.create(name='Migration cabinet')

        cabinet = cabinet_model.objects.create(
            name='Migration cabinet',
            slug='migration-cabinet',
            location_id=location.pk,
            width_units=100,
            height_units=100,
        )

        executor = migrate_to(MIGRATION_0003)

        state = executor.loader.project_state([(APP, MIGRATION_0003)])
        operation_model = state.apps.get_model(APP, 'CabinetOperation')

        self.assertTrue(operation_model.objects.filter(cabinet_id=cabinet.pk).exists())

    def test_operation_rows_removed_on_reverse(self):
        """Reversing 0003 removes the precreated reservation rows."""
        executor = migrate_to(MIGRATION_0002)

        state = executor.loader.project_state([(APP, MIGRATION_0002)])
        cabinet_model = state.apps.get_model(APP, 'Cabinet')

        location = StockLocation.objects.create(name='Reverse cabinet')
        cabinet_model.objects.create(
            name='Reverse cabinet',
            slug='reverse-cabinet',
            location_id=location.pk,
            width_units=100,
            height_units=100,
        )

        migrate_to(MIGRATION_0003)
        migrate_to(MIGRATION_0002)

        self.assertNotIn('storage_layout_cabinetoperation', table_names())


@tag('migration_test')
class MigrationDependencyTests(TransactionTestCase):
    """Tests for the declared migration dependencies."""

    def test_initial_migration_dependencies(self):
        """The initial migration depends on the stock baseline and the user model."""
        from importlib import import_module

        module = import_module(f'{APP}.migrations.{MIGRATION_0001}')
        migration = module.Migration

        self.assertTrue(migration.initial)

        dependencies = [
            tuple(dep) if isinstance(dep, tuple) else dep
            for dep in migration.dependencies
        ]

        self.assertIn(('stock', '0128_remove_stockitem_notes'), dependencies)
