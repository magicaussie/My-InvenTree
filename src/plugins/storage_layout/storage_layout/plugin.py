"""InvenTree plugin definition for the Storage Layout & WLED plugin.

This module defines the plugin class registered through the
``inventree_plugins`` entry point group. It declares:

- ``AppMixin`` - registers the plugin package (and therefore its models and
  migrations) as a Django application.
- ``SettingsMixin`` - exposes the operator-facing configuration gates.
- ``UrlsMixin`` - mounts the plugin REST API under ``/plugin/storage-layout/``.
- ``UserInterfaceMixin`` - publishes the plugin's React routes and the stock
  location panel implemented by the bundled frontend.
- ``ScheduleMixin`` - registers the periodic reconciliation sweep.
- ``ValidationMixin`` - adds friendly native ``StockLocation`` reparent and
  delete guards.

The UI methods reference the exported entry functions in
``frontend/src/storage_layout.tsx`` (``RenderCabinetList``,
``RenderCabinetDesigner``, ``RenderDrawerDesigner``,
``RenderStorageLocationPanel`` and ``RenderStockItemPanel``) through
:meth:`plugin_static_file`, which resolves the hashed Vite bundle via the
plugin's static manifest.

``LocateMixin`` is deliberately **not** registered: the native locate hook
loses the initiating user before invoking the plugin, so it cannot enforce the
operate permission, approval or audit attribution required by the design.
"""

from django.core.exceptions import ValidationError
from django.db.utils import OperationalError, ProgrammingError
from django.utils.translation import gettext_lazy as _

from plugin import InvenTreePlugin
from plugin.mixins import (
    AppMixin,
    ScheduleMixin,
    SettingsMixin,
    UrlsMixin,
    UserInterfaceMixin,
    ValidationMixin,
)


class StorageLayoutPlugin(
    AppMixin,
    SettingsMixin,
    UrlsMixin,
    UserInterfaceMixin,
    ScheduleMixin,
    ValidationMixin,
    InvenTreePlugin,
):
    """Storage Layout & WLED plugin.

    Provides plugin-owned storage geometry, electrical topology, mapping and
    validation. Hardware access is disabled by default: the plugin is
    simulation-only until an operator explicitly enables and commissions it.
    """

    NAME = 'StorageLayout'
    SLUG = 'storage-layout'
    TITLE = _('Storage Layout & WLED')

    DESCRIPTION = _(
        'Visual storage layout, logical LED mapping and safe locating for '
        'InvenTree stock locations'
    )

    VERSION = '0.1.0'
    AUTHOR = 'My-InvenTree'
    LICENSE = 'MIT'
    WEBSITE = 'https://github.com/inventree/InvenTree'

    SETTINGS = {
        'ENABLE_HARDWARE': {
            'name': _('Enable hardware access'),
            'description': _(
                'Allow live controller operations. Disabled by default; the '
                'plugin is simulation-only until this is explicitly enabled '
                'and the controllers are commissioned.'
            ),
            'default': False,
            'validator': bool,
        },
        'HARDWARE_NETWORK_ALLOWLIST': {
            'name': _('Hardware network allowlist'),
            'description': _(
                'Comma separated list of approved inventory VLAN CIDR ranges '
                'or host:port entries. Controller origins outside this list '
                'are rejected.'
            ),
            'default': '',
        },
        'ARM_DURATION_MINUTES': {
            'name': _('Arm duration (minutes)'),
            'description': _('Maximum lifetime of an operator hardware approval'),
            'default': 15,
            'validator': int,
        },
        'MAX_CONTROLLERS_PER_CABINET': {
            'name': _('Maximum controllers per cabinet'),
            'description': _(
                'Operational limit on dedicated controllers per cabinet. '
                'The database schema imposes no limit.'
            ),
            'default': 5,
            'validator': int,
        },
        'AUDIT_RETENTION_DAYS': {
            'name': _('Audit retention (days)'),
            'description': _('Retention period for operational audit entries'),
            'default': 90,
            'validator': int,
        },
        'DISPATCHER_ENABLED': {
            'name': _('Enable live dispatcher'),
            'description': _(
                'Allow live hardware work to be dispatched to the background '
                'worker. Disabled by default; live locate/test fails closed '
                'until this is explicitly enabled alongside hardware access.'
            ),
            'default': False,
            'validator': bool,
        },
        'WATCHDOG_ENABLED': {
            'name': _('Enable reconciliation watchdog'),
            'description': _(
                'Run the bounded reconciliation sweep which expires stale '
                'sessions, clears expired arms and releases abandoned '
                'reservations.'
            ),
            'default': True,
            'validator': bool,
        },
    }

    #: Periodic reconciliation sweep. django-q schedules at minute granularity,
    #: so the scheduled task starts a bounded watchdog loop which sweeps every
    #: five seconds for at most 55 seconds before exiting.
    SCHEDULED_TASKS = {
        'reconcile': {'func': 'reconcile', 'schedule': 'I', 'minutes': 1}
    }

    # region urls

    @property
    def has_urls(self):
        """Report that this plugin exposes URL patterns."""
        return True

    @property
    def urlpatterns(self):
        """Return the plugin URL patterns, resolved lazily.

        The plugin app (and therefore its models) is not registered until
        ``AppMixin`` activation, which runs after plugin construction. The
        patterns are therefore imported on demand rather than in
        ``setup_urls``.
        """
        from storage_layout import urls

        return urls.urlpatterns

    def setup_urls(self):
        """Return no eager patterns; see :attr:`urlpatterns`."""
        return []

    # endregion

    # region scheduled tasks

    def reconcile(self):
        """Run the bounded reconciliation watchdog loop."""
        from storage_layout import tasks

        return tasks.watchdog_loop()

    # endregion

    # region user interface

    def get_ui_routes(self, request, context, **kwargs):
        """Return the plugin's custom React routes.

        The routes resolve under the SPA plugin namespace
        ``/web/plugin/storage-layout/...`` and are served from the bundled
        frontend module (see ``frontend/README.md``).
        """
        return [
            {
                'key': 'storage-layout-cabinets',
                'title': _('Storage Layout'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderCabinetList'
                ),
                'options': {'path': 'cabinets'},
            },
            {
                'key': 'storage-layout-cabinet-design',
                'title': _('Cabinet Designer'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderCabinetDesigner'
                ),
                'options': {'path': 'cabinets/:id/design'},
            },
            {
                'key': 'storage-layout-drawer-design',
                'title': _('Drawer Designer'),
                'icon': 'ti:layout-grid:outline',
                'source': self.plugin_static_file(
                    'storage_layout.js:RenderDrawerDesigner'
                ),
                'options': {'path': 'drawers/:id/design'},
            },
        ]

    def get_ui_navigation_items(self, request, context, **kwargs):
        """Return the plugin's top-level navigation item."""
        return [
            {
                'key': 'storage-layout-nav',
                'title': _('Storage Layout'),
                'icon': 'ti:layout-grid:outline',
                'options': {'url': 'plugin/storage-layout/cabinets'},
            }
        ]

    def get_ui_panels(self, request, context, **kwargs):
        """Return additive panels for stock location and stock item pages.

        The host passes the page's model and id as the ``target_model`` and
        ``target_id`` query parameters. Location panels resolve drawers and
        bins (not only cabinet roots); item panels offer an actor-safe locate
        action which calls the plugin's session API instead of the native
        ``LocateMixin`` hook.
        """
        target = context.get('target_model')

        if target == 'stocklocation':
            return [
                {
                    'key': 'storage-layout-location-panel',
                    'title': _('Storage Layout'),
                    'icon': 'ti:layout-grid:outline',
                    'source': self.plugin_static_file(
                        'storage_layout.js:RenderStorageLocationPanel'
                    ),
                    'context': {},
                }
            ]

        if target == 'stockitem':
            return [
                {
                    'key': 'storage-layout-item-locate',
                    'title': _('Locate'),
                    'icon': 'ti:bulb:outline',
                    'source': self.plugin_static_file(
                        'storage_layout.js:RenderStockItemPanel'
                    ),
                    'context': {},
                }
            ]

        return []

    # endregion

    # region native location guards

    def validate_model_instance(self, instance, deltas=None):
        """Guard native ``StockLocation`` edits which would break a binding.

        A native location which is bound to a cabinet, drawer or bin must keep
        the parent, structural flag and external flag required by that role.
        Reparenting or re-flagging a bound location is rejected here so that
        the operator is directed to the explicit relocation workflow instead
        of silently invalidating the layout.

        Args:
            instance: The model instance being validated.
            deltas: Optional dict of changed fields.

        Returns:
            None when this plugin has no opinion, so other plugins still run.
        """
        from stock.models import StockLocation

        if not isinstance(instance, StockLocation) or not instance.pk:
            return None

        relevant = {'parent', 'structural', 'external'}

        if deltas is not None and not (relevant & set(deltas)):
            return None

        try:
            binding = self._location_binding(instance)
        except (OperationalError, ProgrammingError):  # pragma: no cover
            # Plugin tables are not migrated yet - nothing to guard.
            return None

        if binding is None:
            return None

        role, expected_parent, structural = binding
        errors = []

        if expected_parent is not None and instance.parent_id != expected_parent.pk:
            errors.append(
                _(
                    'This location is bound to a storage layout %(role)s and '
                    'must remain a direct child of its parent location. Use '
                    'the explicit relocation workflow instead.'
                )
                % {'role': role}
            )

        if structural is not None and instance.structural != structural:
            errors.append(
                _(
                    'This location is bound to a storage layout %(role)s and '
                    'its structural flag cannot be changed.'
                )
                % {'role': role}
            )

        if instance.external:
            errors.append(
                _(
                    'This location is bound to a storage layout %(role)s and '
                    'cannot be marked as external.'
                )
                % {'role': role}
            )

        if errors:
            raise ValidationError(errors)

        return None

    def validate_model_deletion(self, instance):
        """Refuse to delete a native location which is bound to the layout.

        This replaces the raw ``PROTECT`` error with an actionable message:
        the binding must be removed (archive-first) before the native location
        can be deleted.

        Args:
            instance: The model instance being deleted.

        Returns:
            None when this plugin has no opinion.

        Raises:
            ValidationError: If the location is bound to the plugin layout.
        """
        from stock.models import StockLocation

        if not isinstance(instance, StockLocation):
            return None

        try:
            binding = self._location_binding(instance)
        except (OperationalError, ProgrammingError):  # pragma: no cover
            return None

        if binding is None:
            return None

        role = binding[0]

        raise ValidationError(
            _(
                'This location is bound to a storage layout %(role)s. Remove '
                'the binding before deleting the native location.'
            )
            % {'role': role}
        )

    @staticmethod
    def _location_binding(location):
        """Return ``(role, expected_parent, structural)`` for a bound location.

        Returns ``None`` when the location is not referenced by the plugin.
        """
        from storage_layout.models import Bin, Cabinet, Drawer

        if Cabinet.objects.filter(location=location).exists():
            # A cabinet location may have any suitable native ancestor.
            return ('cabinet', None, None)

        drawer = (
            Drawer.objects.filter(location=location).select_related('cabinet').first()
        )

        if drawer is not None:
            return ('drawer', drawer.cabinet.location, True)

        bin_row = Bin.objects.filter(location=location).select_related('drawer').first()

        if bin_row is not None:
            return ('bin', bin_row.drawer.location, False)

        return None

    # endregion
