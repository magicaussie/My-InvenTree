"""Storage Layout integration bootstrap for the isolated Docker stack.

This script is executed *inside* the InvenTree backend container, through the
Django shell, before ``api_checks.py`` runs. It performs the environment
bootstrap that cannot be performed over the HTTP API:

1. enables the four plugin feature gates (App / URL / Interface / Schedule);
2. activates the ``storage-layout`` plugin;
3. applies the plugin's additive migrations;
4. creates the integration accounts (an admin and a read-only user) with the
   plugin permissions each role needs, explicitly creating the ``UserProfile``
   that a read-only shell suppresses;
5. creates the native ``StockLocation`` tree the checks bind to;
6. forces live hardware **off** so the fail-closed checks are meaningful.

Credentials are read from the environment and are never written to disk or to
the manifest. The manifest contains only non-secret fixture identifiers.

Run it with either::

    python manage.py shell -c "exec(open('contrib/storage-layout-integration/seed.py').read())"

or::

    python manage.py shell < contrib/storage-layout-integration/seed.py

Environment:

    SL_ADMIN_USER          admin username        (default: sl_admin)
    SL_ADMIN_PASSWORD      admin password        (required)
    SL_READONLY_USER       read-only username    (default: sl_readonly)
    SL_READONLY_PASSWORD   read-only password    (required)
    SL_SEED_MANIFEST       optional path to also write the manifest JSON

Preconditions:

- the plugin package is installed into the backend environment
  (``pip install -e src/plugins/storage_layout``);
- ``INVENTREE_PLUGINS_ENABLED`` is true;
- the backend and worker are restarted **after** this script runs, so the web
  process mounts the plugin URL routes and the worker picks up the scheduled
  reconciliation task.

This script never touches a physical controller and never enables live
hardware access.
"""

import json
import os

from django.apps import apps
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.management import call_command

from common.models import InvenTreeSetting
from plugin.models import PluginConfig
from plugin.registry import registry
from stock.models import StockLocation
from users.models import UserProfile

PLUGIN_SLUG = 'storage-layout'
APP_LABEL = 'storage_layout'

#: Feature gates the plugin requires (see the plugin README).
FEATURE_GATES = (
    'ENABLE_PLUGINS_APP',
    'ENABLE_PLUGINS_URL',
    'ENABLE_PLUGINS_INTERFACE',
    'ENABLE_PLUGINS_SCHEDULE',
)

#: Live hardware is deliberately forced off so the integration checks can prove
#: fail-closed behaviour. These are forced, not merely defaulted.
HARDWARE_GATES = {'ENABLE_HARDWARE': False, 'DISPATCHER_ENABLED': False}

#: Plugin permissions granted to each integration account.
ADMIN_PERMISSIONS = (
    'view_cabinet',
    'change_cabinet',
    'add_cabinet',
    'delete_cabinet',
    'configure_hardware',
    'operate_hardware',
    'emergency_stop',
)
READONLY_PERMISSIONS = ('view_cabinet',)

LOCATION_ROOT_NAME = 'SL Integration Root'
LOCATION_CABINET_NAME = 'SL Integration Cabinet'
LOCATION_DRAWER_NAMES = (
    'SL Integration Drawer 1',
    'SL Integration Drawer 2',
    'SL Integration Drawer 3',
)
LOCATION_BIN_NAMES = ('SL Integration Bin 1', 'SL Integration Bin 2')

MANIFEST_BEGIN = '=== SL_SEED_MANIFEST_BEGIN ==='
MANIFEST_END = '=== SL_SEED_MANIFEST_END ==='


def _env(name, default=None):
    """Return a stripped environment value, or ``default`` when unset/empty."""
    value = os.environ.get(name)

    if value is None:
        return default

    value = value.strip()

    return value or default


def _enable_feature_gates():
    """Enable the plugin feature gates and return the applied values."""
    applied = {}

    for key in FEATURE_GATES:
        InvenTreeSetting.set_setting(key, True, None)
        applied[key] = True

    return applied


def _disable_live_hardware():
    """Force live hardware off and return the applied values."""
    applied = {}

    for key, value in HARDWARE_GATES.items():
        plugin = registry.get_plugin(PLUGIN_SLUG, active=None)
        plugin.set_setting(key, value, None)
        applied[key] = value

    return applied


def _ensure_plugin():
    """Return the active plugin instance, discovering and activating it.

    An installed but *inactive* plugin is present in ``plugins_full`` but not in
    ``plugins``, so ``get_plugin`` alone cannot see it. Activation is therefore
    driven from the full plugin map.
    """
    if PLUGIN_SLUG not in getattr(registry, 'plugins_full', {}):
        registry.reload_plugins(full_reload=True, force_reload=True, collect=True)

    if PLUGIN_SLUG not in getattr(registry, 'plugins_full', {}):
        raise RuntimeError(
            f"Plugin '{PLUGIN_SLUG}' was not discovered. Install it with "
            "'pip install -e src/plugins/storage_layout' and ensure "
            'INVENTREE_PLUGINS_ENABLED is true.'
        )

    # A first boot shell may intentionally suppress automatic config creation
    # while migrations are pending. Bootstrap the explicit new app config.
    PluginConfig.objects.get_or_create(
        key=PLUGIN_SLUG, defaults={'name': 'StorageLayout'}
    )
    registry.set_plugin_state(PLUGIN_SLUG, True)

    plugin = registry.get_plugin(PLUGIN_SLUG, active=None)

    if plugin is None:
        # Activation only marks the configuration active; reload so the plugin
        # instance (and its AppMixin registration) is present in this process.
        registry.reload_plugins(full_reload=True, force_reload=True, collect=True)
        plugin = registry.get_plugin(PLUGIN_SLUG, active=None)

    if plugin is None:
        raise RuntimeError(f"Plugin '{PLUGIN_SLUG}' could not be activated.")

    return plugin


def _ensure_app_and_schema():
    """Ensure the plugin app is registered and its migrations are applied."""
    if not apps.is_installed(APP_LABEL):
        registry.reload_plugins(full_reload=True, force_reload=True, collect=True)

    if not apps.is_installed(APP_LABEL):
        raise RuntimeError(
            f"App '{APP_LABEL}' is not registered. Enable ENABLE_PLUGINS_APP and "
            'restart the backend container so the AppMixin registration runs at '
            'startup.'
        )

    call_command('migrate', APP_LABEL, interactive=False, verbosity=0)


def _ensure_user(username, password, *, superuser, permissions):
    """Create or update an integration account and grant plugin permissions."""
    user_model = get_user_model()
    user = user_model.objects.filter(username=username).first()
    created = user is None

    if user is None:
        user = user_model(username=username)

    user.is_active = True

    if superuser:
        user.is_superuser = True
        user.is_staff = True

    user.set_password(password)
    user.save()

    # ``manage.py shell`` is a read-only command, so the ``post_save`` receiver
    # that normally creates a ``UserProfile`` returns early. The token endpoints
    # call ``login()``, which saves the user and dereferences ``user.profile``;
    # without this row they fail with RelatedObjectDoesNotExist (HTTP 500).
    _profile, profile_created = UserProfile.objects.get_or_create(user=user)

    granted = []

    if permissions:
        rows = Permission.objects.filter(
            content_type__app_label=APP_LABEL, codename__in=permissions
        )
        user.user_permissions.add(*rows)
        granted = sorted(rows.values_list('codename', flat=True))

    return {
        'username': username,
        'created': created,
        'profile_created': profile_created,
        'superuser': superuser,
        'permissions': granted,
    }


def _ensure_location(name, parent=None, structural=False):
    """Return a native stock location, creating it when it does not exist."""
    location = StockLocation.objects.filter(name=name, parent=parent).first()

    if location is None:
        location = StockLocation.objects.create(
            name=name, parent=parent, structural=structural
        )

    return location


def _ensure_locations():
    """Create the native location tree the integration checks bind to."""
    root = _ensure_location(LOCATION_ROOT_NAME, structural=True)
    cabinet = _ensure_location(LOCATION_CABINET_NAME, parent=root, structural=True)
    drawers = [
        _ensure_location(name, parent=cabinet, structural=True)
        for name in LOCATION_DRAWER_NAMES
    ]
    bins = [
        _ensure_location(name, parent=drawers[1], structural=False)
        for name in LOCATION_BIN_NAMES
    ]

    return {
        'root': root.pk,
        'cabinet': cabinet.pk,
        'drawers': [drawer.pk for drawer in drawers],
        'bins': [bin_row.pk for bin_row in bins],
    }


def _emit_manifest(manifest):
    """Print the manifest and optionally write it to ``SL_SEED_MANIFEST``."""
    payload = json.dumps(manifest, indent=2, sort_keys=True, default=str)
    path = _env('SL_SEED_MANIFEST')

    if path:
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(payload + '\n')

    print(MANIFEST_BEGIN)
    print(payload)
    print(MANIFEST_END)


def main():
    """Run the bootstrap and emit the manifest."""
    admin_password = _env('SL_ADMIN_PASSWORD')
    readonly_password = _env('SL_READONLY_PASSWORD')

    if not admin_password or not readonly_password:
        raise RuntimeError(
            'SL_ADMIN_PASSWORD and SL_READONLY_PASSWORD must be set for the '
            'integration bootstrap.'
        )

    gates = _enable_feature_gates()
    plugin = _ensure_plugin()
    _ensure_app_and_schema()
    hardware = _disable_live_hardware()

    admin = _ensure_user(
        _env('SL_ADMIN_USER', 'sl_admin'),
        admin_password,
        superuser=True,
        permissions=ADMIN_PERMISSIONS,
    )
    readonly = _ensure_user(
        _env('SL_READONLY_USER', 'sl_readonly'),
        readonly_password,
        superuser=False,
        permissions=READONLY_PERMISSIONS,
    )

    locations = _ensure_locations()

    _emit_manifest({
        'plugin': {
            'slug': PLUGIN_SLUG,
            'version': getattr(plugin, 'VERSION', ''),
            'active': True,
            'app_registered': apps.is_installed(APP_LABEL),
        },
        'feature_gates': gates,
        'hardware_gates': hardware,
        'accounts': {'admin': admin, 'readonly': readonly},
        'locations': locations,
        'notes': [
            'Restart the backend and worker after this script so the plugin URL '
            'routes and scheduled task are mounted.',
            'Live hardware is forced off; the integration checks assert '
            'fail-closed behaviour.',
        ],
    })

    return 0


# ``manage.py shell`` executes this file inside a shell namespace where
# ``__name__`` is *not* ``'__main__'``, so the bootstrap is invoked directly.
# A raised exception prints a traceback and exits the shell non-zero.
main()
