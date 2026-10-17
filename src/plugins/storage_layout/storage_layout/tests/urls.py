"""Test URLconf mounting the plugin API at its production prefix.

The plugin API is normally mounted by ``UrlsMixin`` under
``/plugin/storage-layout/``. Tests mount the same patterns explicitly (ahead of
the host URLconf) so they do not depend on the plugin registry being active or
on the root URLconf being rebuilt after activation.
"""

from django.urls import include, path

from InvenTree.urls import urlpatterns as inventree_urlpatterns
from storage_layout import urls

urlpatterns = [
    path('plugin/storage-layout/', include((urls.urlpatterns, 'storage-layout'))),
    *inventree_urlpatterns,
]
