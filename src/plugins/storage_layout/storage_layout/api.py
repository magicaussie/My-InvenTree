"""REST API views for the Storage Layout & WLED plugin.

The API is mounted under ``/plugin/storage-layout/api/v1/`` through
:class:`storage_layout.urls`. Every view:

- requires an authenticated, active user with the appropriate plugin
  permission (``view`` / ``change`` / ``configure_hardware`` /
  ``operate_hardware`` / ``emergency_stop``);
- renders domain errors in the documented
  ``{code, message, errors, warnings, correlation_id}`` shape;
- never performs controller-network I/O from a GET or from a layout/electrical
  edit. Only the explicit arm/observe/discover/locate/test endpoints may touch
  hardware, and only when a commissioned adapter is present.

Aggregate mutations require an ``If-Match`` revision header (428 when absent,
412 when stale). Detail and layout GETs return an ``ETag`` carrying the current
cabinet revision.
"""

from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils.translation import gettext_lazy as _

from drf_spectacular.utils import extend_schema
from drf_spectacular.views import SpectacularAPIView
from rest_framework import generics, permissions, status
from rest_framework.pagination import LimitOffsetPagination
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from InvenTree.permissions import InvenTreeRoleScopeMixin, map_scope
from stock.models import StockLocation
from storage_layout import serializers as s
from storage_layout import services
from storage_layout.models import (
    Cabinet,
    CabinetOperation,
    Controller,
    HardwareReadJob,
    LocateProfile,
    LocateSession,
)

# region permission and base views


class StorageLayoutPagination(LimitOffsetPagination):
    """Default pagination for plugin list endpoints.

    InvenTree does not set a global ``PAGE_SIZE``, so an explicit default limit
    is required for the documented ``{count, next, previous, results}`` shape.
    """

    default_limit = 100
    max_limit = 1000


class StorageLayoutPermission(InvenTreeRoleScopeMixin, permissions.BasePermission):
    """Require an authenticated user holding the view's plugin permission."""

    def get_required_alternate_scopes(self, request, view):
        """Constrain OAuth independently of the user's Django permissions."""
        scopes = map_scope(
            roles=['stock_location'],
            override_all_actions='change',
            map_read=['GET', 'OPTIONS'],
        )
        scopes['HEAD'] = scopes['GET']
        return scopes

    def has_permission(self, request, view):
        """Require both token scope (when used) and plugin permission."""
        if self.is_oauth2ed(request) and not self.check_oauth2_authentication(
            request, view
        ):
            return False
        user = getattr(request, 'user', None)

        if not user or not user.is_active or not user.is_authenticated:
            return False

        permission_map = getattr(view, 'permission_map', None)

        if permission_map:
            required = permission_map.get(request.method, 'view')
        else:
            required = getattr(view, 'required_permission', 'view')

        if required is None:
            return True

        return services.user_has_permission(user, required)


class _HardwareRateThrottle(SimpleRateThrottle):
    """Base throttle for hardware operations.

    Only unsafe (state-changing) methods are throttled; read-only requests are
    never rate limited. The cache key is scoped per user and per target so one
    busy cabinet cannot exhaust another operator's budget.
    """

    rate = '10/minute'

    def get_cache_key(self, request, view):
        """Return the throttle cache key, or None for read-only requests."""
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return None

        user = getattr(request, 'user', None)

        if not user or not user.is_authenticated:
            return None

        return self.cache_format % {
            'scope': self.scope,
            'ident': f'{user.pk}:{self.target(request, view)}',
        }

    def target(self, request, view):
        """Return the throttle target identifier for this request."""
        return 'global'


class LocateRateThrottle(_HardwareRateThrottle):
    """Per-user, per-cabinet rate limit for locate and pixel-test sessions."""

    scope = 'storage_layout_locate'

    def target(self, request, view):
        """Return the cabinet identifier for the request."""
        data = getattr(request, 'data', None)

        if isinstance(data, dict) and data.get('cabinet'):
            return str(data['cabinet'])

        return str(view.kwargs.get('pk', 'global'))


class HardwareReadRateThrottle(_HardwareRateThrottle):
    """Per-user, per-controller rate limit for observe and discovery jobs."""

    scope = 'storage_layout_read'

    def target(self, request, view):
        """Return the controller or cabinet identifier for the request."""
        if view.kwargs.get('pk'):
            return str(view.kwargs['pk'])

        data = getattr(request, 'data', None)

        if isinstance(data, dict) and data.get('cabinet'):
            return str(data['cabinet'])

        return 'global'


class StorageLayoutBaseMixin:
    """Shared permission and error-rendering behaviour for plugin views."""

    permission_classes = [StorageLayoutPermission]
    required_permission = 'view'

    def handle_exception(self, exc):
        """Render plugin domain errors in the documented error shape."""
        if isinstance(exc, services.StorageLayoutError):
            return Response(exc.as_dict(), status=exc.status_code)

        return super().handle_exception(exc)


# endregion

# region helpers


def _fetch(model, pk, **filters):
    """Return an object by PK, or ``None`` for a missing/invalid PK."""
    try:
        return model.objects.filter(pk=pk, **filters).first()
    except (DjangoValidationError, ValueError, TypeError):
        return None


def _get_cabinet(pk, user) -> Cabinet:
    """Return a cabinet the user may access, or raise ``NotFoundError``.

    A cabinet the user does not own is reported as missing, so the endpoint
    cannot be used to probe for the existence of other operators' cabinets.
    """
    cabinet = _fetch(Cabinet, pk)

    if cabinet is None or not services.user_owns_cabinet(user, cabinet):
        raise services.NotFoundError(_('Cabinet not found'), code='not_found')

    return cabinet


def _get_drawer(pk, user):
    """Return a drawer the user may access, or raise ``NotFoundError``."""
    from storage_layout.models import Drawer

    drawer = _fetch(Drawer, pk)

    if drawer is None or not services.user_owns_drawer(user, drawer):
        raise services.NotFoundError(_('Drawer not found'), code='not_found')

    return drawer


def _get_controller(pk, user) -> Controller:
    """Return a controller the user may access, or raise ``NotFoundError``."""
    controller = _fetch(Controller, pk)

    if controller is None or not services.user_owns_cabinet(user, controller.cabinet):
        raise services.NotFoundError(_('Controller not found'), code='not_found')

    return controller


def _get_session(pk, user) -> LocateSession:
    """Return a session the user may access, or raise ``NotFoundError``."""
    session = _fetch(LocateSession, pk)

    if session is None or not services.user_owns_cabinet(user, session.cabinet):
        raise services.NotFoundError(_('Locate session not found'), code='not_found')

    return session


def _get_job(pk, user) -> HardwareReadJob:
    """Return a read job the user may read, or raise ``NotFoundError``.

    Read jobs are actor-scoped: a task ID alone confers no access.
    """
    job = _fetch(HardwareReadJob, pk)

    if job is None or not services.user_can_access_job(user, job):
        raise services.NotFoundError(_('Job not found'), code='not_found')

    return job


def _django_errors(exc: DjangoValidationError) -> list[dict]:
    """Convert a Django ``ValidationError`` into the documented error list."""
    errors = []

    if hasattr(exc, 'message_dict'):
        for field, messages in exc.message_dict.items():
            for message in messages:
                errors.append({
                    'path': field,
                    'code': 'invalid',
                    'message': str(message),
                    'related_ids': [],
                })
    else:
        for message in exc.messages:
            errors.append({
                'path': '',
                'code': 'invalid',
                'message': str(message),
                'related_ids': [],
            })

    return errors


def _save(instance):
    """Validate and save a model instance, raising a domain error on failure."""
    try:
        instance.full_clean()
    except DjangoValidationError as exc:
        raise services.StorageLayoutError(
            _('Validation failed'), code='invalid', errors=_django_errors(exc)
        ) from exc

    instance.save()

    return instance


def _etag(response: Response, revision: int) -> Response:
    """Attach a quoted revision ETag to a response."""
    response['ETag'] = f'"{revision}"'

    return response


# endregion

# region cabinets


@extend_schema(
    responses={200: s.CabinetSerializer(many=True), 201: s.CabinetSerializer}
)
class CabinetList(StorageLayoutBaseMixin, generics.ListAPIView):
    """List and create storage cabinets."""

    serializer_class = s.CabinetSerializer
    queryset = Cabinet.objects.all()
    pagination_class = StorageLayoutPagination
    permission_map = {'GET': 'view', 'POST': 'change'}

    def get_queryset(self):
        """Return cabinets the user owns, optionally filtered by archive state."""
        queryset = Cabinet.objects.all().order_by('name')

        visible = services.visible_cabinet_ids(self.request.user)

        if visible is not None:
            queryset = queryset.filter(pk__in=visible)

        archived = self.request.query_params.get('archived')

        if archived is not None:
            queryset = queryset.filter(
                archived=archived.lower() in ('1', 'true', 'yes')
            )

        return queryset

    def post(self, request):
        """Create a cabinet root."""
        services.require_change(request.user)

        serializer = s.CabinetCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        location = StockLocation.objects.filter(pk=data['location']).first()

        if location is None or not services.user_owns_location(request.user, location):
            raise services.NotFoundError(
                _('Native location not found'), code='not_found'
            )

        cabinet = Cabinet(
            name=data['name'],
            slug=data['slug'],
            location=location,
            width_units=data['width_units'],
            height_units=data['height_units'],
            created_by=request.user if request.user.is_authenticated else None,
        )
        _save(cabinet)

        services.record_audit(
            cabinet,
            request.user,
            'cabinet.create',
            after_revision=cabinet.revision,
            details={'location': location.pk},
        )

        return Response(
            s.CabinetSerializer(cabinet).data, status=status.HTTP_201_CREATED
        )


class CabinetDetail(StorageLayoutBaseMixin, APIView):
    """Retrieve or update a cabinet root."""

    serializer_class = s.CabinetUpdateSerializer
    permission_map = {'GET': 'view', 'PATCH': 'change', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return a cabinet with its current revision ETag."""
        cabinet = _get_cabinet(pk, request.user)

        return _etag(Response(s.CabinetSerializer(cabinet).data), cabinet.revision)

    def patch(self, request, pk):
        """Update a cabinet root using compare-and-swap."""
        cabinet = _get_cabinet(pk, request.user)
        services.require_change(request.user)
        expected = services.parse_if_match(request)

        serializer = s.CabinetUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        fields: dict = {}

        if 'name' in data:
            fields['name'] = data['name']

        if 'width_units' in data:
            fields['width_units'] = data['width_units']

        if 'height_units' in data:
            fields['height_units'] = data['height_units']

        if 'archived' in data:
            fields['archived'] = data['archived']

        if 'default_profile' in data:
            profile_id = data['default_profile']

            if profile_id is None:
                fields['default_profile_id'] = None
            else:
                profile = _fetch(LocateProfile, profile_id, cabinet=cabinet)

                if profile is None:
                    raise services.NotFoundError(
                        _('Profile not found'), code='not_found'
                    )

                fields['default_profile_id'] = profile.pk

        before = cabinet.revision

        with transaction.atomic():
            services.cas_update_cabinet(
                cabinet,
                expected,
                updated_by_id=request.user.pk
                if request.user.is_authenticated
                else None,
                **fields,
            )

        services.record_audit(
            cabinet,
            request.user,
            'cabinet.update',
            before_revision=before,
            after_revision=cabinet.revision,
            details={'fields': sorted(fields)},
        )

        return _etag(Response(s.CabinetSerializer(cabinet).data), cabinet.revision)


class NativeLocationBinding(StorageLayoutBaseMixin, APIView):
    """Resolve a native stock location to its plugin binding.

    Returns whether the location is a cabinet root, drawer, bin (or a bound
    descendant), together with the cabinet and mapping summary the frontend
    needs to present the binding and to start an actor-safe locate session.
    Ownership is enforced: a location the user may not access is reported as
    missing rather than revealing another operator's layout.
    """

    serializer_class = s.NativeBindingSerializer
    permission_map = {'GET': 'view', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return the binding document for a native location."""
        location = _fetch(StockLocation, pk)

        if location is None or not services.user_owns_location(request.user, location):
            raise services.NotFoundError(_('Location not found'), code='not_found')

        return Response(services.location_binding(location))


class CabinetLayout(StorageLayoutBaseMixin, APIView):
    """Retrieve or replace the full layout of a cabinet."""

    serializer_class = s.LayoutDocumentSerializer
    permission_map = {'GET': 'view', 'PUT': 'change', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return the full layout document with diagnostics."""
        cabinet = _get_cabinet(pk, request.user)
        document = services.layout_document(cabinet)
        document['diagnostics'] = services.cabinet_diagnostics(cabinet)

        return _etag(Response(document), cabinet.revision)

    def put(self, request, pk):
        """Atomically replace the full layout of a cabinet."""
        cabinet = _get_cabinet(pk, request.user)
        expected = services.parse_if_match(request)

        serializer = s.LayoutDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = services.apply_layout(
            cabinet, serializer.validated_data, request.user, expected
        )

        return _etag(Response(result), cabinet.revision)


class CabinetValidateLayout(StorageLayoutBaseMixin, APIView):
    """Validate a proposed layout document without persisting it."""

    serializer_class = s.LayoutDocumentSerializer
    permission_map = {'POST': 'view'}

    def post(self, request, pk):
        """Return validation diagnostics for a proposed layout."""
        cabinet = _get_cabinet(pk, request.user)

        serializer = s.LayoutDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        return Response(
            services.validate_layout_document(cabinet, serializer.validated_data)
        )


class DrawerLayout(StorageLayoutBaseMixin, APIView):
    """Retrieve or replace the drawer-focused layout projection."""

    serializer_class = s.DrawerLayoutDocumentSerializer
    permission_map = {'GET': 'view', 'PUT': 'change', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return the drawer layout projection with the cabinet ETag."""
        drawer = _get_drawer(pk, request.user)

        return _etag(
            Response(services.drawer_layout_document(drawer)), drawer.cabinet.revision
        )

    def put(self, request, pk):
        """Atomically apply a drawer layout projection."""
        drawer = _get_drawer(pk, request.user)
        expected = services.parse_if_match(request)

        serializer = s.DrawerLayoutDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = services.apply_drawer_layout(
            drawer, serializer.validated_data, request.user, expected
        )

        return _etag(Response(result), drawer.cabinet.revision)


class CabinetElectrical(StorageLayoutBaseMixin, APIView):
    """Retrieve or replace the saved electrical topology of a cabinet."""

    serializer_class = s.ElectricalDocumentSerializer
    permission_map = {'GET': 'view', 'PUT': 'configure_hardware', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return the saved electrical topology."""
        cabinet = _get_cabinet(pk, request.user)

        return _etag(Response(services.electrical_document(cabinet)), cabinet.revision)

    def put(self, request, pk):
        """Atomically replace the saved electrical topology (database only)."""
        cabinet = _get_cabinet(pk, request.user)
        expected = services.parse_if_match(request)

        serializer = s.ElectricalDocumentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = services.apply_electrical(
            cabinet, serializer.validated_data, request.user, expected
        )

        return _etag(Response(result), cabinet.revision)


class CabinetMappingPreview(StorageLayoutBaseMixin, APIView):
    """Validate a candidate mapping and preview its translation."""

    serializer_class = s.MappingCandidateSerializer
    permission_map = {'POST': 'view'}

    def post(self, request, pk):
        """Return deterministic mapping preview diagnostics."""
        cabinet = _get_cabinet(pk, request.user)

        serializer = s.MappingCandidateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        return Response(services.mapping_preview(cabinet, serializer.validated_data))


class CabinetMappingPublish(StorageLayoutBaseMixin, APIView):
    """Publish an immutable mapping revision."""

    serializer_class = s.MappingPublishSerializer
    permission_map = {'POST': 'configure_hardware'}

    def post(self, request, pk):
        """Publish a mapping revision and set it active atomically."""
        cabinet = _get_cabinet(pk, request.user)
        expected = services.parse_if_match(request)

        serializer = s.MappingPublishSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        result = services.publish_mapping(
            cabinet,
            data,
            request.user,
            expected,
            expected_fingerprints=data.get('expected_fingerprints'),
            replacement_allocations=data.get('replacement_allocations'),
        )

        return _etag(Response(result, status=status.HTTP_201_CREATED), cabinet.revision)


class CabinetArm(StorageLayoutBaseMixin, APIView):
    """Arm the cabinet's controllers for a bounded period."""

    serializer_class = s.ArmSerializer
    permission_map = {'POST': 'operate_hardware'}

    def post(self, request, pk):
        """Arm the listed controllers (fails closed without an adapter)."""
        cabinet = _get_cabinet(pk, request.user)

        serializer = s.ArmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        result = services.arm_cabinet(
            cabinet, request.user, data['controllers'], data.get('duration_minutes')
        )

        return Response(result, status=status.HTTP_202_ACCEPTED)


class CabinetDisarm(StorageLayoutBaseMixin, APIView):
    """Disarm the cabinet's controllers."""

    serializer_class = s.ArmSerializer
    permission_map = {'POST': 'operate_hardware'}

    def post(self, request, pk):
        """Disarm every controller and stop any active live session."""
        cabinet = _get_cabinet(pk, request.user)

        return Response(services.disarm_cabinet(cabinet, request.user))


class CabinetStop(StorageLayoutBaseMixin, APIView):
    """Stop the cabinet's active operation or perform an emergency stop."""

    serializer_class = s.ArmSerializer
    permission_map = {'POST': 'operate_hardware'}

    def post(self, request, pk):
        """Stop the active session, or emergency-stop when authorised."""
        cabinet = _get_cabinet(pk, request.user)

        if services.user_has_permission(request.user, 'emergency_stop'):
            result = services.emergency_stop(cabinet, request.user)
        else:
            operation = CabinetOperation.objects.filter(cabinet=cabinet).first()
            session = operation.current_session if operation else None
            stopped = None

            if session is not None:
                services.stop_session(session, request.user)
                stopped = str(session.pk)

            result = {'cabinet': str(cabinet.pk), 'stopped_session': stopped}

        return Response(result, status=status.HTTP_202_ACCEPTED)


class CabinetPixelTests(StorageLayoutBaseMixin, APIView):
    """Create a pixel-test session for an explicit logical range."""

    serializer_class = s.PixelTestSerializer
    permission_map = {'POST': 'operate_hardware'}
    throttle_classes = [LocateRateThrottle]

    def post(self, request, pk):
        """Create and run a pixel-test session."""
        cabinet = _get_cabinet(pk, request.user)

        serializer = s.PixelTestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        session, created = services.create_pixel_test(
            cabinet, request.user, serializer.validated_data
        )

        return Response(
            services.session_status(session),
            status=status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK,
        )


# endregion

# region translate / discovery / controllers


class TranslateView(StorageLayoutBaseMixin, APIView):
    """Translate a logical range into ordered physical runs."""

    serializer_class = s.TranslateRequestSerializer
    permission_map = {'POST': 'view'}

    def post(self, request):
        """Return the physical runs covering an inclusive logical range."""
        serializer = s.TranslateRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        cabinet = _get_cabinet(data['cabinet'], request.user)

        return Response(
            services.translate_range(
                cabinet,
                data['logical_start'],
                data['logical_end'],
                data.get('mapping_hash', ''),
            )
        )


class DiscoveryView(StorageLayoutBaseMixin, APIView):
    """Run a bounded controller discovery job."""

    serializer_class = s.DiscoverySerializer
    permission_map = {'POST': 'operate_hardware'}
    throttle_classes = [HardwareReadRateThrottle]

    def post(self, request):
        """Create a bounded discovery job (fails closed for live mode)."""
        serializer = s.DiscoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        cabinet = None

        if data.get('cabinet'):
            cabinet = _get_cabinet(data['cabinet'], request.user)

        job = services.create_discovery_job(
            request.user, cabinet, data['mode'], data.get('scope') or {}
        )

        return Response(
            s.HardwareReadJobSerializer(job).data, status=status.HTTP_202_ACCEPTED
        )


class ControllerObserve(StorageLayoutBaseMixin, APIView):
    """Observe a controller configuration."""

    serializer_class = s.ObserveSerializer
    permission_map = {'POST': 'operate_hardware'}
    throttle_classes = [HardwareReadRateThrottle]

    def post(self, request, pk):
        """Create a durable observe job and dispatch it to the worker."""
        controller = _get_controller(pk, request.user)

        serializer = s.ObserveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        job = services.create_observe_job(
            controller, request.user, serializer.validated_data['mode']
        )

        return Response(
            s.HardwareReadJobSerializer(job).data, status=status.HTTP_202_ACCEPTED
        )


class ControllerImportPreview(StorageLayoutBaseMixin, APIView):
    """Preview the database diff proposed by an observation."""

    serializer_class = s.ImportPreviewSerializer
    permission_map = {'POST': 'view'}

    def post(self, request, pk):
        """Return a database-only diff; never calls hardware."""
        controller = _get_controller(pk, request.user)

        serializer = s.ImportPreviewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        return Response(
            services.import_preview(
                controller, serializer.validated_data['observation']
            )
        )


class ControllerImport(StorageLayoutBaseMixin, APIView):
    """Apply an observation's proposal to the saved configuration."""

    serializer_class = s.ImportSerializer
    permission_map = {'POST': 'configure_hardware'}

    def post(self, request, pk):
        """Apply a database-only electrical proposal while idle."""
        controller = _get_controller(pk, request.user)
        expected = services.parse_if_match(request)

        serializer = s.ImportSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        result = services.import_configuration(
            controller,
            request.user,
            data['observation'],
            data.get('accepted_diff_hash', ''),
            expected,
        )

        return _etag(Response(result), controller.cabinet.revision)


class ControllerApproveConfiguration(StorageLayoutBaseMixin, APIView):
    """Approve an observation as the expected configuration."""

    serializer_class = s.ApproveConfigurationSerializer
    permission_map = {'POST': 'configure_hardware'}

    def post(self, request, pk):
        """Mark an observation as the approved expected configuration."""
        controller = _get_controller(pk, request.user)

        serializer = s.ApproveConfigurationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        return Response(
            services.approve_configuration(
                controller,
                request.user,
                data['observation'],
                data.get('mapping_hash', ''),
                data.get('checks'),
            )
        )


# endregion

# region profiles


class ProfileList(StorageLayoutBaseMixin, generics.ListAPIView):
    """List and create locate profiles."""

    serializer_class = s.LocateProfileSerializer
    queryset = LocateProfile.objects.all()
    pagination_class = StorageLayoutPagination
    permission_map = {'GET': 'view', 'POST': 'change'}

    def get_queryset(self):
        """Return profiles for cabinets the user owns."""
        queryset = LocateProfile.objects.all().order_by('name')

        visible = services.visible_cabinet_ids(self.request.user)

        if visible is not None:
            queryset = queryset.filter(cabinet_id__in=visible)

        cabinet = self.request.query_params.get('cabinet')

        if cabinet:
            queryset = queryset.filter(cabinet_id=cabinet)

        return queryset

    def post(self, request):
        """Create a locate profile."""
        services.require_change(request.user)

        serializer = s.ProfileCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        cabinet = _get_cabinet(data['cabinet'], request.user)

        profile = LocateProfile(
            cabinet=cabinet,
            name=data['name'],
            purpose=data['purpose'],
            rgb_r=data['rgb_r'],
            rgb_g=data['rgb_g'],
            rgb_b=data['rgb_b'],
            white=data['white'],
            brightness=data['brightness'],
            duration_seconds=data['duration_seconds'],
            created_by=request.user if request.user.is_authenticated else None,
        )
        _save(profile)

        services.record_audit(
            cabinet,
            request.user,
            'profile.create',
            details={'profile': str(profile.pk)},
        )

        return Response(
            s.LocateProfileSerializer(profile).data, status=status.HTTP_201_CREATED
        )


class ProfileDetail(StorageLayoutBaseMixin, APIView):
    """Retrieve or update a locate profile."""

    serializer_class = s.ProfileUpdateSerializer
    permission_map = {'GET': 'view', 'PATCH': 'change', 'OPTIONS': 'view'}

    def get(self, request, pk):
        """Return a locate profile."""
        profile = _fetch(LocateProfile, pk)

        if profile is None:
            raise services.NotFoundError(_('Profile not found'), code='not_found')

        return Response(s.LocateProfileSerializer(profile).data)

    def patch(self, request, pk):
        """Update a locate profile."""
        services.require_change(request.user)

        profile = _fetch(LocateProfile, pk)

        if profile is None:
            raise services.NotFoundError(_('Profile not found'), code='not_found')

        serializer = s.ProfileUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        for field, value in serializer.validated_data.items():
            setattr(profile, field, value)

        _save(profile)

        return Response(s.LocateProfileSerializer(profile).data)


# endregion

# region locate sessions


class LocateSessionList(StorageLayoutBaseMixin, generics.ListAPIView):
    """List and create locate sessions."""

    serializer_class = s.LocateSessionSerializer
    queryset = LocateSession.objects.all()
    pagination_class = StorageLayoutPagination
    permission_map = {'GET': 'view', 'POST': 'operate_hardware'}
    throttle_classes = [LocateRateThrottle]

    def get_queryset(self):
        """Return sessions for cabinets the user owns."""
        queryset = LocateSession.objects.all().order_by('-created_at')

        visible = services.visible_cabinet_ids(self.request.user)

        if visible is not None:
            queryset = queryset.filter(cabinet_id__in=visible)

        cabinet = self.request.query_params.get('cabinet')

        if cabinet:
            queryset = queryset.filter(cabinet_id=cabinet)

        state = self.request.query_params.get('state')

        if state:
            queryset = queryset.filter(state=state)

        return queryset

    def post(self, request):
        """Create a locate session idempotently."""
        serializer = s.LocateSessionCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        cabinet = _get_cabinet(data['cabinet'], request.user)

        session, created = services.create_locate_session(cabinet, request.user, data)

        return Response(
            services.session_status(session),
            status=status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK,
        )


class LocateSessionDetail(StorageLayoutBaseMixin, APIView):
    """Retrieve the persisted status of a locate session."""

    serializer_class = s.LocateSessionSerializer
    permission_map = {'GET': 'view'}

    def get(self, request, pk):
        """Return a session's persisted status and plan."""
        session = _get_session(pk, request.user)

        return Response(services.session_status(session))


class LocateSessionStop(StorageLayoutBaseMixin, APIView):
    """Idempotently stop a locate session."""

    serializer_class = s.ArmSerializer
    permission_map = {'POST': 'operate_hardware'}

    def post(self, request, pk):
        """Stop a session; live clears are only reported when confirmed."""
        session = _get_session(pk, request.user)
        services.stop_session(session, request.user)

        return Response(
            services.session_status(session), status=status.HTTP_202_ACCEPTED
        )


class JobDetail(StorageLayoutBaseMixin, APIView):
    """Retrieve a durable hardware read job."""

    serializer_class = s.HardwareReadJobSerializer
    permission_map = {'GET': 'view'}

    def get(self, request, pk):
        """Return a read job's saved progress and result.

        Read jobs are actor-scoped: only the initiating actor (or a hardware
        operator) may read a job's result, and only for a cabinet they own.
        """
        job = _get_job(pk, request.user)

        return Response(s.HardwareReadJobSerializer(job).data)


# endregion

# region schema


class SchemaView(StorageLayoutBaseMixin, SpectacularAPIView):
    """Serve the OpenAPI schema for the plugin's own routes."""

    permission_map = {'GET': 'view'}


# endregion
