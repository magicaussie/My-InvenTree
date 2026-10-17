"""Tests for the plugin definition and native location guards."""

from django.apps import apps
from django.conf import settings
from django.core.exceptions import ValidationError

from InvenTree.unit_test import InvenTreeTestCase
from plugin import PluginMixinEnum, registry
from stock.models import StockLocation
from storage_layout.models import Bin, Cabinet, Drawer
from storage_layout.plugin import StorageLayoutPlugin


class StorageLayoutPluginTestCase(InvenTreeTestCase):
    """Base test case which activates the plugin in the test database.

    The plugin registry is loaded before the test database exists, so the
    ``PluginConfig`` rows must be recreated and the plugin explicitly activated
    for registry lookups (and therefore the validation mixin) to see it.
    """

    def setUp(self):
        """Ensure the plugin is installed and active."""
        super().setUp()
        self.ensurePluginsLoaded()
        registry.set_plugin_state('storage-layout', True)


class PluginRegistrationTests(StorageLayoutPluginTestCase):
    """Tests that the plugin package is discovered and registered."""

    def test_plugin_is_registered(self):
        """The plugin is discovered through the entry point group."""
        plugin = registry.get_plugin('storage-layout')

        self.assertIsNotNone(plugin)
        self.assertEqual(plugin.NAME, 'StorageLayout')
        self.assertEqual(plugin.SLUG, 'storage-layout')

    def test_plugin_is_active(self):
        """The plugin is active in the test environment."""
        self.assertIn('storage-layout', registry.plugins)

    def test_app_is_installed(self):
        """AppMixin registers the plugin package as a Django app."""
        self.assertIn('storage_layout', settings.INSTALLED_APPS)
        self.assertEqual(apps.get_app_config('storage_layout').name, 'storage_layout')

    def test_app_config(self):
        """The plugin app exposes the expected AppConfig."""
        config = apps.get_app_config('storage_layout')

        self.assertEqual(config.label, 'storage_layout')
        self.assertEqual(config.name, 'storage_layout')

    def test_collection_preserves_model_identity(self):
        """Rediscovery must not create duplicate registered model classes."""
        from importlib import import_module
        from importlib.metadata import EntryPoint

        entry = EntryPoint(
            name='storage_layout',
            value='storage_layout.plugin:StorageLayoutPlugin',
            group='inventree_plugins',
        )
        registry._purge_plugin_modules([entry])
        self.assertIs(import_module('storage_layout.models').Cabinet, Cabinet)

    def test_models_are_registered(self):
        """Plugin models are registered under the plugin app label."""
        for model in (Cabinet, Drawer, Bin):
            self.assertEqual(model._meta.app_label, 'storage_layout')

    def test_settings_declared(self):
        """The operator-facing configuration gates are declared."""
        expected = {
            'ENABLE_HARDWARE',
            'HARDWARE_NETWORK_ALLOWLIST',
            'ARM_DURATION_MINUTES',
            'MAX_CONTROLLERS_PER_CABINET',
            'AUDIT_RETENTION_DAYS',
            'DISPATCHER_ENABLED',
            'WATCHDOG_ENABLED',
        }

        self.assertEqual(set(StorageLayoutPlugin.SETTINGS.keys()), expected)

    def test_hardware_disabled_by_default(self):
        """Hardware access is disabled by default (simulation only)."""
        self.assertFalse(StorageLayoutPlugin.SETTINGS['ENABLE_HARDWARE']['default'])

    def test_locate_mixin_not_registered(self):
        """The native locate hook is deliberately not registered."""
        plugin = registry.get_plugin('storage-layout')

        self.assertFalse(plugin.mixin_enabled(PluginMixinEnum.LOCATE))


class NativeLocationGuardTests(StorageLayoutPluginTestCase):
    """Tests for the friendly native location reparent/delete guards."""

    def setUp(self):
        """Build a bound cabinet/drawer/bin hierarchy."""
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
        self.spare_location = StockLocation.objects.create(
            name='Spare', parent=self.root, structural=True
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
            width=300,
            height=100,
            interior_width=280,
            interior_height=400,
        )
        self.bin = Bin.objects.create(
            drawer=self.drawer,
            label='A1-01',
            location=self.bin_location,
            width=70,
            height=100,
        )

    def test_delete_bound_cabinet_location_refused(self):
        """Deleting a bound cabinet location is refused with a friendly error."""
        with self.assertRaises(ValidationError) as ctx:
            self.cabinet_location.delete()

        self.assertIn('cabinet', str(ctx.exception))

    def test_delete_bound_drawer_location_refused(self):
        """Deleting a bound drawer location is refused."""
        with self.assertRaises(ValidationError) as ctx:
            self.drawer_location.delete()

        self.assertIn('drawer', str(ctx.exception))

    def test_delete_bound_bin_location_refused(self):
        """Deleting a bound bin location is refused."""
        with self.assertRaises(ValidationError) as ctx:
            self.bin_location.delete()

        self.assertIn('bin', str(ctx.exception))

    def test_delete_unbound_location_allowed(self):
        """An unbound native location can still be deleted."""
        self.spare_location.delete()

        self.assertFalse(
            StockLocation.objects.filter(pk=self.spare_location.pk).exists()
        )

    def test_reparent_bound_drawer_location_refused(self):
        """Reparenting a bound drawer location is refused."""
        self.drawer_location.parent = self.spare_location

        with self.assertRaises(ValidationError):
            self.drawer_location.save()

    def test_reparent_bound_bin_location_refused(self):
        """Reparenting a bound bin location is refused."""
        self.bin_location.parent = self.spare_location

        with self.assertRaises(ValidationError):
            self.bin_location.save()

    def test_reparent_unbound_location_allowed(self):
        """An unbound native location can be reparented freely."""
        self.spare_location.parent = self.cabinet_location
        self.spare_location.save()

        self.spare_location.refresh_from_db()
        self.assertEqual(self.spare_location.parent_id, self.cabinet_location.pk)

    def test_reparent_cabinet_location_allowed(self):
        """A cabinet location may have any suitable native ancestor."""
        self.cabinet_location.parent = self.spare_location
        self.cabinet_location.save()

        self.cabinet_location.refresh_from_db()
        self.assertEqual(self.cabinet_location.parent_id, self.spare_location.pk)

    def test_structural_flag_change_refused(self):
        """The structural flag of a bound drawer location cannot change."""
        self.drawer_location.structural = False

        with self.assertRaises(ValidationError):
            self.drawer_location.save()

    def test_external_flag_refused(self):
        """A bound location cannot be marked external."""
        self.bin_location.external = True

        with self.assertRaises(ValidationError):
            self.bin_location.save()

    def test_unrelated_model_ignored(self):
        """The guard ignores models it does not own."""
        plugin = registry.get_plugin('storage-layout')

        self.assertIsNone(plugin.validate_model_instance(self.user))
        self.assertIsNone(plugin.validate_model_deletion(self.user))

    def test_guard_allows_unrelated_field_change(self):
        """Renaming a bound location is still permitted."""
        self.drawer_location.name = 'Drawer A1 renamed'
        self.drawer_location.save()

        self.drawer_location.refresh_from_db()
        self.assertEqual(self.drawer_location.name, 'Drawer A1 renamed')

    def test_guard_allows_new_location(self):
        """Creating a new native location is not blocked."""
        created = StockLocation.objects.create(name='New', parent=self.root)

        self.assertIsNotNone(created.pk)
