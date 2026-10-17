"""Tests for the plugin's public user-interface declarations and lookups.

These cover the ``UserInterfaceMixin`` surface (routes, navigation item and
panels) plus the native location binding lookup which lets the location and
stock item panels resolve drawers/bins rather than only cabinet roots.
"""

import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import override_settings
from django.urls import reverse

from InvenTree.unit_test import InvenTreeTestCase
from plugin import PluginMixinEnum, registry
from stock.models import StockLocation
from storage_layout import services
from storage_layout.models import Bin, Cabinet, Drawer, DrawerAllocation


class StorageLayoutUITestCase(InvenTreeTestCase):
    """Base test case which activates the plugin."""

    def setUp(self):
        """Ensure the plugin is installed and active."""
        super().setUp()
        self.ensurePluginsLoaded()
        registry.set_plugin_state('storage-layout', True)
        self.plugin = registry.get_plugin('storage-layout')


class UserInterfaceDeclarationTests(StorageLayoutUITestCase):
    """The plugin declares routes, navigation and panels via the public mixin."""

    def test_built_assets_resolve_through_host_manifest(self):
        """The real host resolver locates every exported compiled UI entry."""
        static = Path(__file__).resolve().parents[1] / 'static'
        if not (static / '.vite' / 'manifest.json').exists():
            self.skipTest('Build frontend assets before package integration testing')
        with TemporaryDirectory(prefix='storage-layout-static-') as root:
            target = Path(root) / 'plugins' / 'storage-layout'
            shutil.copytree(static, target)
            with override_settings(
                STATIC_ROOT=root, PLUGIN_DEV_HOST='', PLUGIN_DEV_SLUG=''
            ):
                routes = self.plugin.get_ui_routes(None, {})
                for route in routes:
                    source = route['source']
                    self.assertRegex(
                        source, r'storage_layout-[A-Za-z0-9_-]+\.js:Render'
                    )
                    filename = source.split('/')[-1].split(':')[0]
                    self.assertTrue((target / filename).is_file())

    def test_ui_mixin_enabled(self):
        """UserInterfaceMixin is registered."""
        self.assertTrue(self.plugin.mixin_enabled(PluginMixinEnum.USER_INTERFACE))

    def test_routes_declared(self):
        """The three React routes are declared with the expected exports."""
        routes = self.plugin.get_ui_routes(None, {})
        by_key = {route['key']: route for route in routes}

        self.assertEqual(
            set(by_key),
            {
                'storage-layout-cabinets',
                'storage-layout-cabinet-design',
                'storage-layout-drawer-design',
            },
        )

        self.assertEqual(
            by_key['storage-layout-cabinets']['options']['path'], 'cabinets'
        )
        self.assertEqual(
            by_key['storage-layout-cabinet-design']['options']['path'],
            'cabinets/:id/design',
        )
        self.assertEqual(
            by_key['storage-layout-drawer-design']['options']['path'],
            'drawers/:id/design',
        )

        self.assertTrue(
            by_key['storage-layout-cabinets']['source'].endswith(':RenderCabinetList')
        )
        self.assertTrue(
            by_key['storage-layout-cabinet-design']['source'].endswith(
                ':RenderCabinetDesigner'
            )
        )
        self.assertTrue(
            by_key['storage-layout-drawer-design']['source'].endswith(
                ':RenderDrawerDesigner'
            )
        )

    def test_navigation_item_declared(self):
        """A top-level navigation item links to the cabinet list."""
        items = self.plugin.get_ui_navigation_items(None, {})

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['key'], 'storage-layout-nav')
        self.assertEqual(items[0]['options']['url'], 'plugin/storage-layout/cabinets')

    def test_location_panel_declared(self):
        """A panel is offered on stock location detail pages."""
        panels = self.plugin.get_ui_panels(None, {'target_model': 'stocklocation'})

        self.assertEqual(len(panels), 1)
        self.assertEqual(panels[0]['key'], 'storage-layout-location-panel')
        self.assertTrue(panels[0]['source'].endswith(':RenderStorageLocationPanel'))

    def test_stock_item_panel_declared(self):
        """A locate panel is offered on stock item detail pages."""
        panels = self.plugin.get_ui_panels(None, {'target_model': 'stockitem'})

        self.assertEqual(len(panels), 1)
        self.assertEqual(panels[0]['key'], 'storage-layout-item-locate')
        self.assertTrue(panels[0]['source'].endswith(':RenderStockItemPanel'))

    def test_panels_are_model_scoped(self):
        """No panel is offered for unrelated models."""
        self.assertEqual(self.plugin.get_ui_panels(None, {}), [])
        self.assertEqual(self.plugin.get_ui_panels(None, {'target_model': 'part'}), [])


class LocationBindingLookupTests(StorageLayoutUITestCase):
    """The native location binding lookup resolves cabinet/drawer/bin roles."""

    def setUp(self):
        """Build a bound cabinet/drawer/bin hierarchy with an allocation."""
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
        self.descendant_location = StockLocation.objects.create(
            name='Descendant', parent=self.bin_location
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
        DrawerAllocation.objects.create(
            drawer=self.drawer, logical_start=1, logical_end=50
        )
        self.bin = Bin.objects.create(
            drawer=self.drawer,
            label='A1-01',
            location=self.bin_location,
            width=70,
            height=100,
        )

    def test_cabinet_root_binding(self):
        """A cabinet root is reported as ambiguous (not locatable)."""
        binding = services.location_binding(self.cabinet_location)

        self.assertEqual(binding['role'], 'cabinet')
        self.assertFalse(binding['locatable'])
        self.assertEqual(binding['reason'], 'cabinet_root')
        self.assertEqual(binding['cabinet']['slug'], 'cabinet-1')

    def test_drawer_binding(self):
        """A drawer location resolves to its cabinet and allocation."""
        binding = services.location_binding(self.drawer_location)

        self.assertEqual(binding['role'], 'drawer')
        self.assertTrue(binding['locatable'])
        self.assertEqual(binding['drawer']['label'], 'A1')
        self.assertEqual(binding['drawer']['allocation']['logical_end'], 50)

    def test_bin_binding(self):
        """A bin location resolves through its drawer."""
        binding = services.location_binding(self.bin_location)

        self.assertEqual(binding['role'], 'bin')
        self.assertTrue(binding['locatable'])
        self.assertEqual(binding['bin']['label'], 'A1-01')
        self.assertEqual(binding['drawer']['label'], 'A1')

    def test_descendant_inherits_nearest_bin(self):
        """A descendant of a bound bin inherits that bin's drawer."""
        binding = services.location_binding(self.descendant_location)

        self.assertEqual(binding['role'], 'bin')
        self.assertEqual(binding['bin']['label'], 'A1-01')

    def test_unbound_location(self):
        """An unrelated location is reported as unbound."""
        binding = services.location_binding(self.spare_location)

        self.assertIsNone(binding['role'])
        self.assertFalse(binding['bound'])
        self.assertFalse(binding['locatable'])
        self.assertEqual(binding['reason'], 'unbound')

    def test_drawer_without_allocation_not_locatable(self):
        """A drawer with no allocation is bound but not locatable."""
        drawer = Drawer.objects.create(
            cabinet=self.cabinet,
            label='A2',
            display_number=2,
            location=self.spare_location,
            width=300,
            height=100,
            interior_width=280,
            interior_height=400,
        )

        binding = services.location_binding(drawer.location)

        self.assertEqual(binding['role'], 'drawer')
        self.assertFalse(binding['locatable'])
        self.assertEqual(binding['reason'], 'no_allocation')

    @override_settings(ROOT_URLCONF='storage_layout.tests.urls')
    def test_binding_endpoint_is_routed(self):
        """The binding lookup endpoint is mounted under the plugin base."""
        url = reverse(
            'storage-layout:location-binding', kwargs={'pk': self.drawer_location.pk}
        )

        self.assertEqual(
            url,
            f'/plugin/storage-layout/api/v1/locations/{self.drawer_location.pk}/binding/',
        )
