"""Regression tests for plugin registry reloads and model class identity.

A plugin registry reload empties an app's model registry but retains the models
module in ``sys.modules`` (``PluginsRegistry._purge_plugin_modules`` deliberately
retains model packages so that class identity is stable). Re-registering the
retained model classes must preserve that identity, so modules which imported
those classes at startup (services, serializers, ...) keep referring to the same
objects that ``apps.get_model`` returns.

The plugin test settings register the storage layout app directly, so a normal
registry reload does not unload it. These tests therefore reproduce the
post-deactivation state explicitly rather than driving a full registry reload.
"""

import sys
import types
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps
from django.test import TestCase

from plugin.mixins import AppMixin
from storage_layout import models, services


class ReregisterContribAppsTests(TestCase):
    """Tests for ``AppMixin._reregister_contrib_apps``."""

    def test_reregister_preserves_model_identity(self):
        """Retained model classes are re-registered, not reloaded.

        This is the regression for the reload bug: after a registry reload,
        ``services.Cabinet`` must still be the same class that
        ``apps.get_model`` returns.
        """
        app_config = apps.get_app_config('storage_layout')
        registry = SimpleNamespace(installed_apps=['storage_layout'])

        # Simulate the state left by ``_deactivate_mixin`` + ``apps.populate``:
        # the app's model registry is empty, but the models module is retained.
        saved = dict(apps.all_models['storage_layout'])
        apps.all_models['storage_layout'].clear()
        apps.clear_cache()

        def restore():
            apps.all_models['storage_layout'].clear()
            apps.all_models['storage_layout'].update(saved)
            apps.clear_cache()

        self.addCleanup(restore)

        self.assertEqual(len(app_config.models), 0)

        AppMixin._reregister_contrib_apps(AppMixin, registry)

        cabinet = apps.get_model('storage_layout', 'Cabinet')
        self.assertIs(cabinet, models.Cabinet)
        self.assertIs(cabinet, services.Cabinet)

    def test_reregister_does_not_reload_retained_module(self):
        """A retained models module is re-registered without being reloaded."""
        app_config = SimpleNamespace(
            label='storage_layout',
            models_module=models,
            models={},
            module=SimpleNamespace(),
            get_models=lambda: [],
        )
        registry = SimpleNamespace(installed_apps=['storage_layout'])
        registered = []

        with (
            patch(
                'plugin.base.integration.AppMixin.apps.get_app_config',
                return_value=app_config,
            ),
            patch(
                'plugin.base.integration.AppMixin.apps.register_model',
                side_effect=lambda label, model: registered.append((label, model)),
            ),
            patch('plugin.base.integration.AppMixin.reload') as mock_reload,
        ):
            AppMixin._reregister_contrib_apps(AppMixin, registry)

        mock_reload.assert_not_called()
        self.assertIn(('storage_layout', models.Cabinet), registered)

    def test_reregister_falls_back_to_reload_without_models(self):
        """A module exposing no concrete models falls back to a reload."""
        module = types.ModuleType('fake_plugin.models')
        app_config = SimpleNamespace(
            label='fake_plugin',
            models_module=module,
            models={},
            module=SimpleNamespace(),
            get_models=lambda: [],
        )
        registry = SimpleNamespace(installed_apps=['fake_plugin'])

        with (
            patch.dict(sys.modules, {'fake_plugin.models': module}),
            patch(
                'plugin.base.integration.AppMixin.apps.get_app_config',
                return_value=app_config,
            ),
            patch('plugin.base.integration.AppMixin.reload') as mock_reload,
        ):
            AppMixin._reregister_contrib_apps(AppMixin, registry)

        mock_reload.assert_called_once_with(module)
