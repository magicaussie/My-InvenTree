"""Reproducible plugin test settings, independent of saved plugin activation.

Use ``manage.py test storage_layout.tests --keepdb
--settings=storage_layout.test_settings`` from ``src/backend/InvenTree`` after
installing the plugin package into the backend environment. The test runner
creates the schema; no existing plugin or production database is required.
"""

from InvenTree import settings as _base

for _name in dir(_base):
    if _name.isupper():
        globals()[_name] = getattr(_base, _name)

PLUGIN_TESTING_SETUP = True

# Use AppMixin's exact package name so registry activation cannot add a second
# AppConfig for the same models. Production still registers through AppMixin.
INSTALLED_APPS = [*_base.INSTALLED_APPS, 'storage_layout']
