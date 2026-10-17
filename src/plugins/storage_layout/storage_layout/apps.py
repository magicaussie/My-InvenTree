"""Django application configuration for the Storage Layout plugin app."""

from django.apps import AppConfig
from django.utils.translation import gettext_lazy as _


class StorageLayoutConfig(AppConfig):
    """AppConfig for the ``storage_layout`` plugin application.

    The app label matches the plugin package name so that ``AppMixin`` can
    register the package in ``INSTALLED_APPS`` and Django can locate the
    plugin's models and migrations.
    """

    name = 'storage_layout'
    label = 'storage_layout'
    verbose_name = _('Storage Layout')
    default_auto_field = 'django.db.models.BigAutoField'
