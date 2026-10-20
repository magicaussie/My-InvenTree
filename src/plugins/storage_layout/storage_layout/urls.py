"""URL routing for the Storage Layout & WLED plugin.

The patterns are mounted by ``UrlsMixin`` under ``/plugin/storage-layout/``, so
the API base is ``/plugin/storage-layout/api/v1/``. Trailing slashes are
required. SPA routes and API routes are distinct namespaces even though both
live under ``plugin``.
"""

from django.urls import path

from storage_layout import api, backgrounds

API_PREFIX = 'api/v1/'

urlpatterns = [
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/background/',
        backgrounds.BackgroundView.as_view(),
        name='cabinet-background',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/background/content/',
        backgrounds.BackgroundContentView.as_view(),
        name='cabinet-background-content',
    ),
    path(
        f'{API_PREFIX}drawers/<uuid:pk>/background/',
        backgrounds.DrawerBackgroundView.as_view(),
        name='drawer-background',
    ),
    path(
        f'{API_PREFIX}drawers/<uuid:pk>/background/content/',
        backgrounds.DrawerBackgroundContentView.as_view(),
        name='drawer-background-content',
    ),
    # Cabinets
    path(f'{API_PREFIX}cabinets/', api.CabinetList.as_view(), name='cabinet-list'),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/',
        api.CabinetDetail.as_view(),
        name='cabinet-detail',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/layout/',
        api.CabinetLayout.as_view(),
        name='cabinet-layout',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/validate-layout/',
        api.CabinetValidateLayout.as_view(),
        name='cabinet-validate-layout',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/electrical/',
        api.CabinetElectrical.as_view(),
        name='cabinet-electrical',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/mapping-preview/',
        api.CabinetMappingPreview.as_view(),
        name='cabinet-mapping-preview',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/mapping-publish/',
        api.CabinetMappingPublish.as_view(),
        name='cabinet-mapping-publish',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/arm/',
        api.CabinetArm.as_view(),
        name='cabinet-arm',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/disarm/',
        api.CabinetDisarm.as_view(),
        name='cabinet-disarm',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/stop/',
        api.CabinetStop.as_view(),
        name='cabinet-stop',
    ),
    path(
        f'{API_PREFIX}cabinets/<uuid:pk>/pixel-tests/',
        api.CabinetPixelTests.as_view(),
        name='cabinet-pixel-tests',
    ),
    # Drawers
    path(
        f'{API_PREFIX}drawers/<uuid:pk>/layout/',
        api.DrawerLayout.as_view(),
        name='drawer-layout',
    ),
    # Native location binding lookup
    path(
        f'{API_PREFIX}locations/<int:pk>/binding/',
        api.NativeLocationBinding.as_view(),
        name='location-binding',
    ),
    # Translation and discovery
    path(f'{API_PREFIX}translate/', api.TranslateView.as_view(), name='translate'),
    path(f'{API_PREFIX}discovery/', api.DiscoveryView.as_view(), name='discovery'),
    # Controllers
    path(
        f'{API_PREFIX}controllers/<uuid:pk>/observe/',
        api.ControllerObserve.as_view(),
        name='controller-observe',
    ),
    path(
        f'{API_PREFIX}controllers/<uuid:pk>/import-preview/',
        api.ControllerImportPreview.as_view(),
        name='controller-import-preview',
    ),
    path(
        f'{API_PREFIX}controllers/<uuid:pk>/import/',
        api.ControllerImport.as_view(),
        name='controller-import',
    ),
    path(
        f'{API_PREFIX}controllers/<uuid:pk>/approve-configuration/',
        api.ControllerApproveConfiguration.as_view(),
        name='controller-approve-configuration',
    ),
    # Profiles
    path(f'{API_PREFIX}profiles/', api.ProfileList.as_view(), name='profile-list'),
    path(
        f'{API_PREFIX}profiles/<uuid:pk>/',
        api.ProfileDetail.as_view(),
        name='profile-detail',
    ),
    # Locate sessions
    path(
        f'{API_PREFIX}locate-sessions/',
        api.LocateSessionList.as_view(),
        name='locate-session-list',
    ),
    path(
        f'{API_PREFIX}locate-sessions/<uuid:pk>/',
        api.LocateSessionDetail.as_view(),
        name='locate-session-detail',
    ),
    path(
        f'{API_PREFIX}locate-sessions/<uuid:pk>/stop/',
        api.LocateSessionStop.as_view(),
        name='locate-session-stop',
    ),
    # Jobs
    path(f'{API_PREFIX}jobs/<uuid:pk>/', api.JobDetail.as_view(), name='job-detail'),
    # Schema
    path(
        f'{API_PREFIX}schema/',
        api.SchemaView.as_view(urlconf='storage_layout.urls'),
        name='schema',
    ),
]


def get_urlpatterns():
    """Return the plugin URL patterns (used by the schema view)."""
    return urlpatterns
