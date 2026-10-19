"""Transactional services for the Storage Layout & WLED plugin.

This module owns every state-changing operation of the plugin domain:

- cabinet aggregate compare-and-swap (CAS) writes with ``If-Match`` revisions;
- geometry, electrical and mapping persistence with authoritative validation;
- append-only audit records;
- idempotent locate/test session creation and simulated execution;
- explicit, fail-closed live-hardware orchestration.

Design constraints enforced here (see ``docs/design/001``):

- All layout/binding/electrical/mapping writes go through a cabinet aggregate
  transaction which checks the expected revision and performs a conditional
  ``UPDATE ... WHERE revision = expected``. Exactly one writer wins.
- A successful response never proves that hardware was touched. Live hardware
  access is disabled by default and fails closed until a commissioned adapter
  is installed and the controller is armed.
- No function in this module performs network I/O unless a commissioned WLED
  adapter is present *and* the caller explicitly requested live mode.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from itertools import pairwise
from typing import Any

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from rest_framework import status
from rest_framework.exceptions import APIException

from stock.models import StockItem, StockLocation
from storage_layout import mapping as mapping_module
from storage_layout import validation as v
from storage_layout.models import (
    Bin,
    Cabinet,
    CabinetOperation,
    CapabilityStatus,
    ClearStatus,
    ConfigObservation,
    Controller,
    ControllerExecution,
    ControllerOutput,
    ControllerStatus,
    DesignAudit,
    Drawer,
    DrawerAllocation,
    ExecutionState,
    HardwareReadJob,
    JobState,
    LEDString,
    LocateMode,
    LocateProfile,
    LocatePurpose,
    LocateSession,
    MappingRevision,
    MappingState,
    PixelSpan,
    ReadJobKind,
    SessionState,
    TargetKind,
)

PLUGIN_SLUG = 'storage-layout'

SCHEMA_VERSION = mapping_module.SCHEMA_VERSION

#: Session states which hold the cabinet reservation.
ACTIVE_SESSION_STATES = {
    SessionState.QUEUED,
    SessionState.PREFLIGHT,
    SessionState.APPLYING,
    SessionState.ACTIVE,
    SessionState.STOPPING,
    SessionState.UNKNOWN,
}

#: Session states which are terminal.
TERMINAL_SESSION_STATES = {
    SessionState.STOPPED,
    SessionState.EXPIRED,
    SessionState.FAILED,
}


# region errors


class StorageLayoutError(APIException):
    """A domain error rendered in the documented API error shape."""

    status_code = status.HTTP_400_BAD_REQUEST
    default_code = 'error'

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        errors: list[dict[str, Any]] | None = None,
        warnings: list[dict[str, Any]] | None = None,
        status_code: int | None = None,
        correlation_id: str = '',
    ):
        """Build a domain error.

        Args:
            message: Human readable message.
            code: Machine readable error code.
            errors: Optional list of field-level errors.
            warnings: Optional list of non-blocking warnings.
            status_code: Optional HTTP status override.
            correlation_id: Optional correlation identifier.
        """
        self.code = code or self.default_code
        self.message = str(message)
        self.errors = list(errors or [])
        self.warnings = list(warnings or [])
        self.correlation_id = correlation_id or uuid.uuid4().hex

        if status_code is not None:
            self.status_code = status_code

        super().__init__(self.message)

    def as_dict(self) -> dict[str, Any]:
        """Return the documented error payload."""
        return {
            'code': self.code,
            'message': self.message,
            'errors': self.errors,
            'warnings': self.warnings,
            'correlation_id': self.correlation_id,
        }


class MissingPreconditionError(StorageLayoutError):
    """Raised when an aggregate mutation omits the ``If-Match`` header."""

    status_code = status.HTTP_428_PRECONDITION_REQUIRED
    default_code = 'precondition_required'


class StaleRevisionError(StorageLayoutError):
    """Raised when the supplied revision does not match the stored revision."""

    status_code = status.HTTP_412_PRECONDITION_FAILED
    default_code = 'stale'


class CabinetBusyError(StorageLayoutError):
    """Raised when a cabinet already has an active operation."""

    status_code = status.HTTP_409_CONFLICT
    default_code = 'cabinet_busy'


class NotArmedError(StorageLayoutError):
    """Raised when live execution is requested without a valid arm."""

    status_code = status.HTTP_409_CONFLICT
    default_code = 'not_armed'


class LiveNotAvailableError(StorageLayoutError):
    """Raised when live hardware access is not safely available."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_code = 'live_unavailable'


class NotLocatableError(StorageLayoutError):
    """Raised when a target cannot be resolved to a mapped drawer."""

    status_code = status.HTTP_409_CONFLICT
    default_code = 'not_locatable'


class UnsupportedConfigurationError(StorageLayoutError):
    """Raised when a controller configuration is not supported by the adapter."""

    status_code = status.HTTP_409_CONFLICT
    default_code = 'unsupported_configuration'


class ConfigDriftError(StorageLayoutError):
    """Raised when observed hardware configuration has drifted."""

    status_code = status.HTTP_409_CONFLICT
    default_code = 'config_drift'


class ForbiddenError(StorageLayoutError):
    """Raised when the actor lacks the required plugin permission."""

    status_code = status.HTTP_403_FORBIDDEN
    default_code = 'forbidden'


class NotFoundError(StorageLayoutError):
    """Raised when an object is missing or invisible to the actor."""

    status_code = status.HTTP_404_NOT_FOUND
    default_code = 'not_found'


class QueueUnavailableError(StorageLayoutError):
    """Raised when the background task queue cannot accept durable work.

    A locate/test session or hardware read job is never accepted unless its
    durable row can be dispatched to a worker; accepting an untracked live
    request would leave hardware in an unknown state.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_code = 'queue_unavailable'


# endregion


# region generic helpers


def _canonical_hash(payload: Any) -> str:
    """Return a deterministic SHA-256 hash of a JSON-serialisable payload."""
    encoded = json.dumps(
        payload, sort_keys=True, separators=(',', ':'), default=str
    ).encode('utf-8')

    return hashlib.sha256(encoded).hexdigest()


def _as_uuid(value: Any, field_name: str = 'id') -> uuid.UUID:
    """Coerce a value to a UUID or raise a domain error."""
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as exc:
        raise StorageLayoutError(
            _('Invalid %(field)s: %(value)s') % {'field': field_name, 'value': value},
            code='invalid_reference',
        ) from exc


def _as_int(value: Any, field_name: str, minimum: int | None = None) -> int:
    """Coerce a value to an integer or raise a domain error."""
    if isinstance(value, bool) or value is None:
        raise StorageLayoutError(
            _('%(field)s must be an integer') % {'field': field_name},
            code='invalid_value',
        )

    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise StorageLayoutError(
            _('%(field)s must be an integer') % {'field': field_name},
            code='invalid_value',
        ) from exc

    if minimum is not None and result < minimum:
        raise StorageLayoutError(
            _('%(field)s must be at least %(minimum)s')
            % {'field': field_name, 'minimum': minimum},
            code='invalid_bounds',
        )

    return result


def _report_error(report: v.ValidationReport, message: str, code: str) -> None:
    """Raise a domain error carrying a populated validation report."""
    if report.valid:
        return

    raise StorageLayoutError(
        message,
        code=code,
        errors=[issue.as_dict() for issue in report.errors],
        warnings=[issue.as_dict() for issue in report.warnings],
    )


def plugin_setting(key: str, default: Any = None) -> Any:
    """Return a plugin setting value, falling back to ``default``."""
    try:
        from plugin.registry import registry

        plugin = registry.get_plugin(PLUGIN_SLUG)

        if plugin is None:
            return default

        value = plugin.get_setting(key, backup_value=default)

        return default if value is None else value
    except Exception:  # pragma: no cover - defensive
        return default


def hardware_enabled() -> bool:
    """Return True when live hardware access has been explicitly enabled."""
    return bool(plugin_setting('ENABLE_HARDWARE', False))


def max_controllers_per_cabinet() -> int:
    """Return the configured operational controller limit."""
    try:
        return int(plugin_setting('MAX_CONTROLLERS_PER_CABINET', 5))
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return 5


def arm_duration_minutes() -> int:
    """Return the configured maximum arm lifetime in minutes."""
    try:
        return int(plugin_setting('ARM_DURATION_MINUTES', 15))
    except (TypeError, ValueError):  # pragma: no cover - defensive
        return 15


# endregion


# region dispatch


def dispatcher_enabled() -> bool:
    """Return True when an operator has enabled the live dispatcher.

    Live hardware work is only accepted when a functioning dispatcher is
    explicitly configured; otherwise it fails closed.
    """
    return bool(plugin_setting('DISPATCHER_ENABLED', False))


def watchdog_enabled() -> bool:
    """Return True when the reconciliation watchdog should run."""
    return bool(plugin_setting('WATCHDOG_ENABLED', True))


def worker_running() -> bool:
    """Return True when a background worker is operational."""
    try:
        from InvenTree.status import is_worker_running

        return bool(is_worker_running())
    except Exception:  # pragma: no cover - defensive
        return False


def require_live_dispatcher() -> None:
    """Refuse output changes unless a worker and fresh watchdog are present."""
    heartbeat = cache.get('storage_layout_watchdog_heartbeat')
    if (
        not dispatcher_enabled()
        or not watchdog_enabled()
        or not worker_running()
        or not isinstance(heartbeat, (int, float))
        or not 0 <= timezone.now().timestamp() - heartbeat <= 15
    ):
        raise LiveNotAvailableError(
            _(
                'Live operation requires an enabled dispatcher, running worker and fresh watchdog heartbeat'
            ),
            code='dispatcher_unavailable',
        )


def queue_available() -> bool:
    """Return True when durable background work can be dispatched.

    A running worker is required for any durable dispatch. Live hardware work
    additionally requires the explicit dispatcher gate, so an unconfigured
    deployment fails closed rather than queueing an untracked live request.
    """
    return worker_running() or dispatcher_enabled()


def enqueue_task(taskname: str, *args: Any, **kwargs: Any) -> Any:
    """Enqueue a durable background task via Django-Q2.

    This is the single seam used by the service layer and by tests. It always
    forces asynchronous dispatch so the durable row is committed before the
    worker can observe it.
    """
    from InvenTree import tasks as inventree_tasks

    return inventree_tasks.offload_task(
        taskname, *args, force_async=True, group=PLUGIN_SLUG, **kwargs
    )


def _record_dispatch_failure(session: LocateSession, message: str) -> None:
    """Persist a dispatch failure on a session and release its reservation."""
    session.state = SessionState.FAILED
    session.failure = {'code': 'queue_unavailable', 'message': message}
    session.save()
    _release_reservation(session)


def dispatch_session(session_id: Any) -> str | None:
    """Dispatch a durable locate/test session to the worker queue.

    Args:
        session_id: The session primary key.

    Returns:
        The background task ID, or ``None`` when the session no longer needs
        dispatching.

    Raises:
        QueueUnavailableError: If the task could not be enqueued. The failure is
            persisted on the session before the error is raised.
    """
    session = LocateSession.objects.filter(pk=session_id).first()

    if session is None:
        return None

    if session.state not in (SessionState.QUEUED, SessionState.PREFLIGHT):
        return None

    task_id = enqueue_task('storage_layout.tasks.run_session_task', str(session.pk))

    if isinstance(task_id, str) and task_id:
        session.plan = {**(session.plan or {}), 'q_task_id': task_id}
        session.save()
        return task_id

    _record_dispatch_failure(
        session, 'The background task queue did not accept the session'
    )
    raise QueueUnavailableError(
        _('The background task queue is unavailable'), code='queue_unavailable'
    )


def dispatch_read_job(job_id: Any) -> str | None:
    """Dispatch a durable hardware read job to the worker queue.

    Raises:
        QueueUnavailableError: If the task could not be enqueued. The failure is
            persisted on the job before the error is raised.
    """
    job = HardwareReadJob.objects.filter(pk=job_id).first()

    if job is None:
        return None

    if job.state not in (JobState.PENDING, JobState.RUNNING):
        return None

    task_id = enqueue_task('storage_layout.tasks.run_read_job_task', str(job.pk))

    if isinstance(task_id, str) and task_id:
        job.q_task_id = task_id
        job.save()
        return task_id

    job.state = JobState.FAILED
    job.error = {
        'code': 'queue_unavailable',
        'message': 'The background task queue did not accept the job',
    }
    job.save()
    raise QueueUnavailableError(
        _('The background task queue is unavailable'), code='queue_unavailable'
    )


# endregion


# region permissions


def user_has_permission(user: Any, permission: str) -> bool:
    """Return True when ``user`` holds the plugin permission."""
    if not user or not getattr(user, 'is_active', False):
        return False

    return Cabinet.check_user_permission(user, permission)


def require_permission(user: Any, permission: str) -> None:
    """Raise :class:`ForbiddenError` unless the user holds the permission."""
    if not user_has_permission(user, permission):
        raise ForbiddenError(
            _('You do not have permission to perform this operation'), code='forbidden'
        )


def require_view(user: Any) -> None:
    """Require the plugin view permission."""
    require_permission(user, 'view')


def require_change(user: Any) -> None:
    """Require the plugin change permission."""
    require_permission(user, 'change')


def require_configure(user: Any) -> None:
    """Require the hardware configuration permission."""
    require_permission(user, 'configure_hardware')


def require_operate(user: Any) -> None:
    """Require the hardware operate permission."""
    require_permission(user, 'operate_hardware')


def require_emergency_stop(user: Any) -> None:
    """Require the emergency-stop permission."""
    require_permission(user, 'emergency_stop')


# endregion


# region ownership


def ownership_enabled() -> bool:
    """Return True when native stock ownership control is enabled."""
    from common.settings import get_global_setting

    # A database/settings failure must not turn ownership enforcement off.
    return bool(get_global_setting('STOCK_OWNERSHIP_CONTROL'))


def user_owns_location(user: Any, location: Any) -> bool:
    """Return True when the user may access a native stock location.

    This delegates to the host's ``StockLocation.check_ownership`` so the plugin
    honours exactly the same rules (superuser, the ``STOCK_OWNERSHIP_CONTROL``
    global setting, and the nearest ancestor owner).
    """
    if location is None:
        return True

    if not user or not getattr(user, 'is_active', False):
        return False

    return bool(location.check_ownership(user))


def user_owns_cabinet(user: Any, cabinet: Any) -> bool:
    """Return True when the user may access a cabinet's native location."""
    if cabinet is None:
        return True

    if not user_owns_location(user, cabinet.location):
        return False
    if not ownership_enabled() or getattr(user, 'is_superuser', False):
        return True
    # Layouts are atomic aggregates, not partially redacted geometry. Refuse the
    # aggregate if a child overrides inherited ownership for another operator.
    return all(
        user_owns_drawer(user, drawer)
        for drawer in cabinet.drawers.select_related('location', 'cabinet__location')
    )


def user_owns_drawer(user: Any, drawer: Any) -> bool:
    """Return True when the user may access a drawer's native location."""
    if drawer is None:
        return True

    if not user_owns_location(user, drawer.location) or not user_owns_location(
        user, drawer.cabinet.location
    ):
        return False
    if not ownership_enabled() or getattr(user, 'is_superuser', False):
        return True
    return all(
        user_owns_location(user, row.location)
        for row in drawer.bins.select_related('location')
        if row.location_id
    )


def user_owns_bin(user: Any, bin_row: Any) -> bool:
    """Return True when the user may access a bin's native location."""
    if bin_row is None:
        return True

    if bin_row.location_id:
        return user_owns_location(user, bin_row.location)

    return user_owns_location(user, bin_row.drawer.location)


def visible_cabinet_ids(user: Any) -> set[Any] | None:
    """Return the cabinet PKs visible to the user, or ``None`` when unfiltered.

    ``None`` is returned when ownership control is disabled, so callers can skip
    filtering entirely and preserve the default (unrestricted) behaviour.
    """
    if not ownership_enabled():
        return None

    return {
        cabinet.pk
        for cabinet in Cabinet.objects.select_related('location')
        if user_owns_cabinet(user, cabinet)
    }


def user_can_access_job(user: Any, job: Any) -> bool:
    """Return True when the user may read a durable hardware read job.

    A job is actor-scoped: its result is only visible to the initiating actor
    (or a hardware operator / superuser), and only when the user may access the
    job's cabinet. A task ID alone confers no access.
    """
    if job is None:
        return False

    if not user or not getattr(user, 'is_active', False):
        return False

    if job.cabinet_id and not user_owns_cabinet(user, job.cabinet):
        return False

    if job.actor_id and job.actor_id == getattr(user, 'pk', None):
        return True

    return user_has_permission(user, 'operate_hardware')


# endregion


# region audit


def record_audit(
    cabinet: Cabinet | None,
    actor: Any,
    operation: str,
    *,
    before_revision: int | None = None,
    after_revision: int | None = None,
    details: dict[str, Any] | None = None,
    correlation_id: str = '',
) -> DesignAudit:
    """Append an audit entry for a layout, mapping or hardware operation."""
    user = actor if getattr(actor, 'is_authenticated', False) else None

    return DesignAudit.objects.create(
        cabinet=cabinet,
        actor=user,
        operation=operation,
        before_revision=before_revision,
        after_revision=after_revision,
        correlation_id=correlation_id or uuid.uuid4().hex,
        details=details or {},
    )


# endregion


# region CAS


def parse_if_match(request: Any) -> int:
    """Return the expected revision parsed from the ``If-Match`` header.

    Args:
        request: The DRF request.

    Returns:
        The expected revision integer.

    Raises:
        MissingPreconditionError: If the header is absent.
        StaleRevisionError: If the header is not a valid revision.
    """
    header = request.headers.get('If-Match')

    if header is None or not str(header).strip():
        raise MissingPreconditionError(
            _('This operation requires an If-Match revision header'),
            code='precondition_required',
        )

    value = str(header).strip().strip('"')

    if value == '*':
        raise StaleRevisionError(
            _('A specific revision is required in the If-Match header'), code='stale'
        )

    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise StaleRevisionError(
            _('The If-Match header must contain a revision number'), code='stale'
        ) from exc


def cas_update_cabinet(cabinet: Cabinet, expected_revision: int, **fields: Any) -> int:
    """Conditionally update a cabinet and increment its revision.

    Args:
        cabinet: The cabinet to update.
        expected_revision: The revision the caller believes is current.
        **fields: Additional cabinet fields to persist.

    Returns:
        The new revision.

    Raises:
        StaleRevisionError: If the stored revision does not match.
    """
    updated = Cabinet.objects.filter(pk=cabinet.pk, revision=expected_revision).update(
        revision=expected_revision + 1, **fields
    )

    if not updated:
        raise StaleRevisionError(
            _('The cabinet has changed since it was loaded; reload and retry'),
            code='stale',
        )

    cabinet.refresh_from_db()

    return cabinet.revision


def cabinet_is_idle(cabinet: Cabinet) -> bool:
    """Return True when the cabinet has no active operation."""
    operation = CabinetOperation.objects.filter(cabinet=cabinet).first()

    if operation is None or operation.current_session_id is None:
        return True

    session = operation.current_session

    if session is None:
        return True

    return session.state not in ACTIVE_SESSION_STATES


# endregion


# region layout documents


def allocation_document(allocation: DrawerAllocation | None) -> dict[str, Any] | None:
    """Return the document representation of a drawer allocation."""
    if allocation is None:
        return None

    return {
        'id': str(allocation.pk),
        'logical_start': allocation.logical_start,
        'logical_end': allocation.logical_end,
        'pixel_count': allocation.pixel_count,
    }


def drawer_document(
    drawer: Drawer, allocation: DrawerAllocation | None
) -> dict[str, Any]:
    """Return the document representation of a drawer."""
    return {
        'id': str(drawer.pk),
        'label': drawer.label,
        'display_number': drawer.display_number,
        'location': drawer.location_id,
        'x': drawer.x,
        'y': drawer.y,
        'width': drawer.width,
        'height': drawer.height,
        'interior_width': drawer.interior_width,
        'interior_height': drawer.interior_height,
        'archived': drawer.archived,
        'allocation': allocation_document(allocation),
    }


def bin_document(bin_row: Bin) -> dict[str, Any]:
    """Return the document representation of a bin."""
    return {
        'id': str(bin_row.pk),
        'drawer': str(bin_row.drawer_id),
        'label': bin_row.label,
        'location': bin_row.location_id,
        'x': bin_row.x,
        'y': bin_row.y,
        'width': bin_row.width,
        'height': bin_row.height,
        'archived': bin_row.archived,
    }


def layout_document(cabinet: Cabinet) -> dict[str, Any]:
    """Return the canonical layout document for a cabinet."""
    drawers = list(cabinet.drawers.all().order_by('display_number', 'id'))
    allocations = {
        allocation.drawer_id: allocation
        for allocation in DrawerAllocation.objects.filter(drawer__cabinet=cabinet)
    }
    bins = list(Bin.objects.filter(drawer__cabinet=cabinet).order_by('label', 'id'))
    mapping = cabinet.active_mapping
    total = mapping.total_pixels if mapping is not None else 0

    return {
        'schema_version': SCHEMA_VERSION,
        'cabinet': {
            'id': str(cabinet.pk),
            'name': cabinet.name,
            'slug': cabinet.slug,
            'revision': cabinet.revision,
            'width_units': cabinet.width_units,
            'height_units': cabinet.height_units,
            'archived': cabinet.archived,
            'location': cabinet.location_id,
            'active_mapping': str(mapping.pk) if mapping is not None else None,
            'mapping_hash': mapping.content_hash if mapping is not None else '',
            'total_pixels': total,
            'numbering_base': 1,
        },
        'drawers': [
            drawer_document(drawer, allocations.get(drawer.pk)) for drawer in drawers
        ],
        'bins': [bin_document(bin_row) for bin_row in bins],
        'archive_ids': [],
    }


def drawer_layout_document(drawer: Drawer) -> dict[str, Any]:
    """Return the drawer-focused layout projection."""
    allocation = getattr(drawer, 'allocation', None)
    bins = list(drawer.bins.all().order_by('label', 'id'))
    cabinet = drawer.cabinet

    return {
        'schema_version': SCHEMA_VERSION,
        'cabinet': {
            'id': str(cabinet.pk),
            'revision': cabinet.revision,
            'width_units': cabinet.width_units,
            'height_units': cabinet.height_units,
            'active_mapping': str(cabinet.active_mapping_id)
            if cabinet.active_mapping_id
            else None,
            'total_pixels': cabinet.active_mapping.total_pixels
            if cabinet.active_mapping_id
            else 0,
        },
        'drawer': drawer_document(drawer, allocation),
        'bins': [bin_document(bin_row) for bin_row in bins],
        'archive_ids': [],
    }


# endregion


# region layout planning


@dataclass
class DrawerSpec:
    """A parsed drawer row from a layout document."""

    doc_id: str
    instance: Drawer | None
    label: str
    display_number: int
    location_id: int | None
    auto_create_location: bool
    x: int
    y: int
    width: int
    height: int
    interior_width: int
    interior_height: int
    archived: bool
    allocation: tuple[int, int] | None
    allocation_present: bool

    def geometry(self) -> dict[str, Any]:
        """Return a geometry mapping for the validation module."""
        return {
            'id': self.doc_id,
            'label': self.label,
            'x': self.x,
            'y': self.y,
            'width': self.width,
            'height': self.height,
            'archived': self.archived,
            'display_number': self.display_number,
        }


@dataclass
class BinSpec:
    """A parsed bin row from a layout document."""

    doc_id: str
    instance: Bin | None
    drawer_doc_id: str
    label: str
    location_id: int | None
    auto_create_location: bool
    x: int
    y: int
    width: int
    height: int
    archived: bool

    def geometry(self) -> dict[str, Any]:
        """Return a geometry mapping for the validation module."""
        return {
            'id': self.doc_id,
            'label': self.label,
            'x': self.x,
            'y': self.y,
            'width': self.width,
            'height': self.height,
            'archived': self.archived,
        }


@dataclass
class LayoutPlan:
    """A fully parsed and validated layout document."""

    cabinet_width: int
    cabinet_height: int
    drawers: list[DrawerSpec] = field(default_factory=list)
    bins: list[BinSpec] = field(default_factory=list)
    archive_ids: list[str] = field(default_factory=list)
    report: v.ValidationReport = field(default_factory=v.ValidationReport)


def _as_bool(value: Any, field: str) -> bool:
    """Parse a strict boolean from a layout document."""
    if not isinstance(value, bool):
        raise StorageLayoutError(
            _('%(field)s must be a boolean') % {'field': field}, code='invalid_value'
        )
    return value


def _parse_drawer_specs(
    cabinet: Cabinet, entries: list[Any], report: v.ValidationReport
) -> list[DrawerSpec]:
    """Parse drawer entries into specs, resolving existing rows."""
    specs: list[DrawerSpec] = []
    seen_ids: set[uuid.UUID] = set()

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise StorageLayoutError(
                _('Each drawer must be an object'), code='invalid_value'
            )

        raw_id = entry.get('id')
        is_new = entry.get('is_new', False)
        if not isinstance(is_new, bool):
            raise StorageLayoutError(
                _('drawer.is_new must be a boolean'), code='invalid_value'
            )

        instance = None
        doc_id = f'new-drawer-{index}'

        if raw_id is not None:
            drawer_id = _as_uuid(raw_id, 'drawer.id')
            doc_id = str(drawer_id)
            if drawer_id in seen_ids:
                raise StorageLayoutError(
                    _('Duplicate drawer id: %(id)s') % {'id': raw_id},
                    code='invalid_reference',
                )
            seen_ids.add(drawer_id)
            instance = Drawer.objects.filter(pk=drawer_id, cabinet=cabinet).first()
            if Bin.objects.filter(pk=drawer_id).exists():
                raise StorageLayoutError(
                    _('The UUID is already used by a bin: %(id)s') % {'id': raw_id},
                    code='invalid_reference',
                )
            if instance is None:
                if Drawer.objects.filter(pk=drawer_id).exists():
                    raise StorageLayoutError(
                        _('Unknown or cross-cabinet drawer id: %(id)s')
                        % {'id': raw_id},
                        code='invalid_reference',
                    )
                if not is_new:
                    raise StorageLayoutError(
                        _('Unknown drawer id: %(id)s; new client IDs require is_new')
                        % {'id': raw_id},
                        code='invalid_reference',
                    )

        allocation = None
        allocation_present = 'allocation' in entry

        if allocation_present and entry.get('allocation') is not None:
            raw_allocation = entry['allocation']

            if not isinstance(raw_allocation, dict):
                raise StorageLayoutError(
                    _('allocation must be an object or null'), code='invalid_value'
                )

            allocation = (
                _as_int(raw_allocation.get('logical_start'), 'logical_start', 1),
                _as_int(raw_allocation.get('logical_end'), 'logical_end', 1),
            )

        specs.append(
            DrawerSpec(
                doc_id=doc_id,
                instance=instance,
                label=str(entry.get('label', '')),
                display_number=_as_int(
                    entry.get('display_number'), 'display_number', 1
                ),
                location_id=entry.get('location'),
                auto_create_location=_as_bool(
                    entry.get('auto_create_location', False),
                    'drawer.auto_create_location',
                ),
                x=_as_int(entry.get('x', 0), 'x', 0),
                y=_as_int(entry.get('y', 0), 'y', 0),
                width=_as_int(entry.get('width'), 'width', 1),
                height=_as_int(entry.get('height'), 'height', 1),
                interior_width=_as_int(
                    entry.get('interior_width'), 'interior_width', 1
                ),
                interior_height=_as_int(
                    entry.get('interior_height'), 'interior_height', 1
                ),
                archived=bool(entry.get('archived', False)),
                allocation=allocation,
                allocation_present=allocation_present,
            )
        )

    return specs


def _parse_bin_specs(
    cabinet: Cabinet, entries: list[Any], report: v.ValidationReport
) -> list[BinSpec]:
    """Parse bin entries into specs, resolving existing rows."""
    specs: list[BinSpec] = []
    seen_ids: set[uuid.UUID] = set()

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise StorageLayoutError(
                _('Each bin must be an object'), code='invalid_value'
            )

        raw_id = entry.get('id')
        is_new = entry.get('is_new', False)
        if not isinstance(is_new, bool):
            raise StorageLayoutError(
                _('bin.is_new must be a boolean'), code='invalid_value'
            )

        instance = None
        doc_id = f'new-bin-{index}'

        if raw_id is not None:
            bin_id = _as_uuid(raw_id, 'bin.id')
            doc_id = str(bin_id)
            if bin_id in seen_ids:
                raise StorageLayoutError(
                    _('Duplicate bin id: %(id)s') % {'id': raw_id},
                    code='invalid_reference',
                )
            seen_ids.add(bin_id)
            instance = Bin.objects.filter(pk=bin_id, drawer__cabinet=cabinet).first()
            if Drawer.objects.filter(pk=bin_id).exists():
                raise StorageLayoutError(
                    _('The UUID is already used by a drawer: %(id)s') % {'id': raw_id},
                    code='invalid_reference',
                )
            if instance is None:
                if Bin.objects.filter(pk=bin_id).exists():
                    raise StorageLayoutError(
                        _('Unknown or cross-cabinet bin id: %(id)s') % {'id': raw_id},
                        code='invalid_reference',
                    )
                if not is_new:
                    raise StorageLayoutError(
                        _('Unknown bin id: %(id)s; new client IDs require is_new')
                        % {'id': raw_id},
                        code='invalid_reference',
                    )

        drawer_ref = entry.get('drawer')

        if not drawer_ref:
            raise StorageLayoutError(
                _('Each bin must reference a drawer'), code='invalid_reference'
            )

        try:
            drawer_ref = str(uuid.UUID(str(drawer_ref)))
        except (TypeError, ValueError, AttributeError):
            drawer_ref = str(drawer_ref)

        specs.append(
            BinSpec(
                doc_id=doc_id,
                instance=instance,
                drawer_doc_id=str(drawer_ref),
                label=str(entry.get('label', '')),
                location_id=entry.get('location'),
                auto_create_location=_as_bool(
                    entry.get('auto_create_location', False), 'bin.auto_create_location'
                ),
                x=_as_int(entry.get('x', 0), 'x', 0),
                y=_as_int(entry.get('y', 0), 'y', 0),
                width=_as_int(entry.get('width'), 'width', 1),
                height=_as_int(entry.get('height'), 'height', 1),
                archived=bool(entry.get('archived', False)),
            )
        )

    return specs


def _validate_bindings(
    cabinet: Cabinet,
    drawers: list[DrawerSpec],
    bins: list[BinSpec],
    report: v.ValidationReport,
) -> None:
    """Validate native location bindings for a layout plan."""
    drawer_locations: list[StockLocation] = []
    bin_locations: list[StockLocation] = []

    for spec in drawers:
        if spec.location_id is None and spec.auto_create_location:
            if not spec.label.strip():
                report.add_error(
                    v.CODE_BINDING_INVALID,
                    _('A location label is required for automatic creation'),
                    path=f'drawers[{spec.doc_id}].label',
                )
            continue
        if spec.location_id is None:
            report.add_error(
                v.CODE_BINDING_INVALID,
                _('A drawer requires a native structural location'),
                path=f'drawers[{spec.doc_id}].location',
            )
            continue

        location = StockLocation.objects.filter(pk=spec.location_id).first()

        if location is None:
            report.add_error(
                v.CODE_BINDING_INVALID,
                _('The referenced native location does not exist'),
                path=f'drawers[{spec.doc_id}].location',
            )
            continue

        drawer_locations.append(location)
        v.validate_location_binding(
            'drawer',
            location,
            expected_parent=cabinet.location,
            structural=True,
            report=report,
        )

    for spec in bins:
        if spec.location_id is None:
            if spec.auto_create_location and not spec.label.strip():
                report.add_error(
                    v.CODE_BINDING_INVALID,
                    _('A location label is required for automatic creation'),
                    path=f'bins[{spec.doc_id}].label',
                )
            continue

        location = StockLocation.objects.filter(pk=spec.location_id).first()

        if location is None:
            report.add_error(
                v.CODE_BINDING_INVALID,
                _('The referenced native location does not exist'),
                path=f'bins[{spec.doc_id}].location',
            )
            continue

        bin_locations.append(location)
        parent = None

        for drawer_spec in drawers:
            if drawer_spec.doc_id == spec.drawer_doc_id and drawer_spec.location_id:
                parent = StockLocation.objects.filter(
                    pk=drawer_spec.location_id
                ).first()
                break

        v.validate_location_binding(
            'bin', location, expected_parent=parent, structural=False, report=report
        )

    v.validate_native_location_roles(
        cabinet.location, drawer_locations, bin_locations, report=report
    )


def prepare_layout(cabinet: Cabinet, document: dict[str, Any]) -> LayoutPlan:
    """Parse and validate a complete layout document without persisting it.

    Args:
        cabinet: The cabinet being edited.
        document: The proposed aggregate document.

    Returns:
        The validated layout plan.

    Raises:
        StorageLayoutError: If the document is malformed or invalid.
    """
    if not isinstance(document, dict):
        raise StorageLayoutError(
            _('A layout document is required'), code='invalid_value'
        )

    if (
        _as_int(document.get('schema_version', SCHEMA_VERSION), 'schema_version')
        != SCHEMA_VERSION
    ):
        raise StorageLayoutError(
            _('Unsupported schema_version'), code='unsupported_schema'
        )

    cabinet_block = document.get('cabinet') or {}

    if not isinstance(cabinet_block, dict):
        raise StorageLayoutError(_('cabinet must be an object'), code='invalid_value')

    width = _as_int(
        cabinet_block.get('width_units', cabinet.width_units), 'width_units', 1
    )
    height = _as_int(
        cabinet_block.get('height_units', cabinet.height_units), 'height_units', 1
    )

    report = v.ValidationReport()

    drawers = _parse_drawer_specs(cabinet, document.get('drawers') or [], report)
    bins = _parse_bin_specs(cabinet, document.get('bins') or [], report)

    # Omitted binding fields on persisted rows mean "retain current binding".
    # Restore before validation so ownership and hierarchy checks always run.
    for spec in drawers:
        if spec.location_id is None and spec.instance is not None:
            spec.location_id = spec.instance.location_id
    for spec in bins:
        if spec.location_id is None and spec.instance is not None:
            spec.location_id = spec.instance.location_id

    drawer_ids = {spec.doc_id for spec in drawers}

    for spec in bins:
        if spec.drawer_doc_id not in drawer_ids:
            report.add_error(
                v.CODE_BINDING_INVALID,
                _('Bin references an unknown drawer'),
                path=f'bins[{spec.doc_id}].drawer',
                related_ids=[spec.drawer_doc_id],
            )

    # Rows omitted from a partial document are retained in the database and
    # still occupy the cabinet/drawer-scoped unique constraints, so they must
    # seed the identity checks.
    represented_drawers = {
        spec.instance.pk for spec in drawers if spec.instance is not None
    }
    retained_drawers = list(
        Drawer.objects.filter(cabinet=cabinet).exclude(pk__in=represented_drawers)
    )

    v.validate_drawer_geometry(
        width,
        height,
        [spec.geometry() for spec in drawers],
        report=report,
        retained=retained_drawers,
    )

    represented_bins = {spec.instance.pk for spec in bins if spec.instance is not None}

    for drawer_spec in drawers:
        drawer_bins = [
            spec.geometry() for spec in bins if spec.drawer_doc_id == drawer_spec.doc_id
        ]
        retained_bins = []

        if drawer_spec.instance is not None:
            retained_bins = list(
                Bin.objects.filter(drawer=drawer_spec.instance).exclude(
                    pk__in=represented_bins
                )
            )

        v.validate_bin_geometry(
            drawer_spec.interior_width,
            drawer_spec.interior_height,
            drawer_bins,
            report=report,
            retained=retained_bins,
        )

    mapping = cabinet.active_mapping
    total = mapping.total_pixels if mapping is not None else 0

    allocations = [
        {
            'id': spec.doc_id,
            'logical_start': spec.allocation[0],
            'logical_end': spec.allocation[1],
        }
        for spec in drawers
        if spec.allocation is not None
    ]

    v.validate_allocations(allocations, total, report=report)
    _validate_bindings(cabinet, drawers, bins, report)

    archive_ids = [str(value) for value in (document.get('archive_ids') or [])]

    return LayoutPlan(
        cabinet_width=width,
        cabinet_height=height,
        drawers=drawers,
        bins=bins,
        archive_ids=archive_ids,
        report=report,
    )


def validate_layout_document(
    cabinet: Cabinet, document: dict[str, Any]
) -> dict[str, Any]:
    """Validate a layout document and return diagnostics without persisting."""
    plan = prepare_layout(cabinet, document)

    return {
        'valid': plan.report.valid,
        'errors': [issue.as_dict() for issue in plan.report.errors],
        'warnings': [issue.as_dict() for issue in plan.report.warnings],
        'unused_ranges': [list(r) for r in plan.report.unused_ranges],
    }


def apply_layout(
    cabinet: Cabinet, document: dict[str, Any], actor: Any, expected_revision: int
) -> dict[str, Any]:
    """Atomically apply a complete layout document to a cabinet.

    Args:
        cabinet: The cabinet being edited.
        document: The proposed aggregate document.
        actor: The acting user.
        expected_revision: The revision the caller believes is current.

    Returns:
        The canonical layout document after the write.

    Raises:
        StorageLayoutError: If validation fails or the revision is stale.
    """
    require_change(actor)

    if not user_owns_cabinet(actor, cabinet):
        raise ForbiddenError(
            _('The cabinet contains locations you do not own'), code='forbidden'
        )
    plan = prepare_layout(cabinet, document)
    _report_error(
        plan.report,
        _('The layout is invalid'),
        plan.report.errors[0].code if plan.report.errors else 'geometry_overlap',
    )
    for spec in [*plan.drawers, *plan.bins]:
        if spec.location_id and not user_owns_location(
            actor, StockLocation.objects.get(pk=spec.location_id)
        ):
            raise ForbiddenError(
                _('You cannot bind a location owned by another user'), code='forbidden'
            )

    before = cabinet.revision

    with transaction.atomic():
        cas_update_cabinet(
            cabinet,
            expected_revision,
            width_units=plan.cabinet_width,
            height_units=plan.cabinet_height,
            updated_by_id=actor.pk
            if getattr(actor, 'is_authenticated', False)
            else None,
        )

        drawer_map: dict[str, Drawer] = {}

        def resolve_or_create_location(
            parent: StockLocation, name: str, structural: bool
        ) -> StockLocation:
            """Create a uniquely named child without adopting unrelated locations."""
            base_name = name.strip()[:100]
            candidate = base_name
            suffix = 2
            # Serialize sibling name allocation across concurrent saves. Locking
            # the parent row coordinates all writers using this service.
            StockLocation.objects.select_for_update().get(pk=parent.pk)
            while StockLocation.objects.filter(parent=parent, name=candidate).exists():
                candidate = f'{base_name[:90]} ({suffix})'
                suffix += 1
            if not actor.has_perm('stock.add_stocklocation'):
                raise ForbiddenError(
                    _('You do not have permission to create native stock locations'),
                    code='forbidden',
                )
            return StockLocation.objects.create(
                parent=parent, name=candidate, structural=structural
            )

        # Park changing rows on temporary unique values first: a single write may
        # legitimately swap two drawers' labels or display numbers, which would
        # otherwise transiently violate the cabinet-scoped unique constraints.
        _park_drawers(cabinet, plan.drawers)

        for spec in plan.drawers:
            if (
                spec.location_id is None
                and spec.instance is not None
                and spec.instance.location_id
            ):
                spec.location_id = spec.instance.location_id
            if spec.auto_create_location and spec.location_id is None:
                spec.location_id = resolve_or_create_location(
                    cabinet.location, spec.label, True
                ).pk
            if spec.instance is None:
                drawer_values = {
                    'cabinet': cabinet,
                    'label': spec.label,
                    'display_number': spec.display_number,
                    'location_id': spec.location_id,
                    'x': spec.x,
                    'y': spec.y,
                    'width': spec.width,
                    'height': spec.height,
                    'interior_width': spec.interior_width,
                    'interior_height': spec.interior_height,
                    'archived': spec.archived,
                }
                if spec.doc_id.startswith('new-drawer-'):
                    drawer = Drawer.objects.create(**drawer_values)
                else:
                    drawer_id = _as_uuid(spec.doc_id, 'drawer.id')
                    drawer, created = Drawer.objects.get_or_create(
                        pk=drawer_id, defaults=drawer_values
                    )
                    if not created:
                        raise StorageLayoutError(
                            _('Drawer id was claimed during save: %(id)s')
                            % {'id': drawer_id},
                            code='invalid_reference',
                        )
            else:
                drawer = spec.instance
                drawer.label = spec.label
                drawer.display_number = spec.display_number
                drawer.location_id = spec.location_id
                drawer.x = spec.x
                drawer.y = spec.y
                drawer.width = spec.width
                drawer.height = spec.height
                drawer.interior_width = spec.interior_width
                drawer.interior_height = spec.interior_height
                drawer.archived = spec.archived
                drawer.save()

            drawer_map[spec.doc_id] = drawer

            if spec.allocation_present:
                if spec.allocation is None:
                    DrawerAllocation.objects.filter(drawer=drawer).delete()
                else:
                    DrawerAllocation.objects.update_or_create(
                        drawer=drawer,
                        defaults={
                            'logical_start': spec.allocation[0],
                            'logical_end': spec.allocation[1],
                        },
                    )

        _park_bins(plan.bins, drawer_map)

        for spec in plan.bins:
            drawer = drawer_map[spec.drawer_doc_id]
            if (
                spec.location_id is None
                and spec.instance is not None
                and spec.instance.location_id
            ):
                spec.location_id = spec.instance.location_id
            if spec.auto_create_location and spec.location_id is None:
                if drawer.location_id is None:
                    raise StorageLayoutError(
                        _('A bin location requires a drawer location'),
                        code='invalid_value',
                    )
                spec.location_id = resolve_or_create_location(
                    drawer.location, spec.label, False
                ).pk

            if spec.instance is None:
                bin_values = {
                    'drawer': drawer,
                    'label': spec.label,
                    'location_id': spec.location_id,
                    'x': spec.x,
                    'y': spec.y,
                    'width': spec.width,
                    'height': spec.height,
                    'archived': spec.archived,
                }
                if spec.doc_id.startswith('new-bin-'):
                    Bin.objects.create(**bin_values)
                else:
                    bin_id = _as_uuid(spec.doc_id, 'bin.id')
                    bin_row, created = Bin.objects.get_or_create(
                        pk=bin_id, defaults=bin_values
                    )
                    if not created:
                        raise StorageLayoutError(
                            _('Bin id was claimed during save: %(id)s')
                            % {'id': bin_row.pk},
                            code='invalid_reference',
                        )
            else:
                bin_row = spec.instance
                bin_row.drawer = drawer
                bin_row.label = spec.label
                bin_row.location_id = spec.location_id
                bin_row.x = spec.x
                bin_row.y = spec.y
                bin_row.width = spec.width
                bin_row.height = spec.height
                bin_row.archived = spec.archived
                bin_row.save()

        _apply_archive_ids(cabinet, plan.archive_ids)

    record_audit(
        cabinet,
        actor,
        'layout.save',
        before_revision=before,
        after_revision=cabinet.revision,
        details={'drawers': len(plan.drawers), 'bins': len(plan.bins)},
    )

    return layout_document(cabinet)


def _park_drawers(cabinet: Cabinet, specs: list[DrawerSpec]) -> None:
    """Move changing drawers onto temporary unique labels and numbers.

    A layout write may legitimately swap two drawers' labels or display
    numbers. Saving them one at a time would transiently violate the
    cabinet-scoped unique constraints, so every row whose identity changes is
    first parked on a value which cannot collide with any final or current
    value. Rows whose identity is unchanged are left alone: a collision with
    such a row is a genuine duplicate and is rejected by validation.
    """
    changing = [
        spec
        for spec in specs
        if spec.instance is not None
        and (
            spec.instance.label != spec.label
            or spec.instance.display_number != spec.display_number
        )
    ]

    if not changing:
        return

    final_numbers = {spec.display_number for spec in specs}
    final_labels = {spec.label for spec in specs}
    current_numbers = set(
        Drawer.objects.filter(cabinet=cabinet).values_list('display_number', flat=True)
    )
    current_labels = set(
        Drawer.objects.filter(cabinet=cabinet).values_list('label', flat=True)
    )
    base = max(final_numbers | current_numbers | {0})

    for offset, spec in enumerate(changing):
        drawer = spec.instance
        label = f'__tmp__{drawer.pk}'

        while label in final_labels or label in current_labels:
            label += '_'

        drawer.display_number = base + offset + 1
        drawer.label = label
        drawer.save(update_fields=['display_number', 'label'])


def _park_bins(specs: list[BinSpec], drawer_map: dict[str, Drawer]) -> None:
    """Move changing bins onto temporary unique labels within their drawer.

    As for drawers, a bin label swap would otherwise transiently violate the
    drawer-scoped unique constraint. Bins which are neither relabelled nor
    reparented are left alone; a collision with such a bin is a genuine
    duplicate and is rejected by validation.
    """
    changing = [
        spec
        for spec in specs
        if spec.instance is not None
        and (
            spec.instance.label != spec.label
            or spec.instance.drawer_id != drawer_map[spec.drawer_doc_id].pk
        )
    ]

    if not changing:
        return

    final_labels = {spec.label for spec in specs}

    for spec in changing:
        bin_row = spec.instance
        drawer = drawer_map[spec.drawer_doc_id]
        label = f'__tmp__{bin_row.pk}'
        current_labels = set(
            Bin.objects.filter(drawer=drawer).values_list('label', flat=True)
        )

        while label in final_labels or label in current_labels:
            label += '_'

        bin_row.drawer = drawer
        bin_row.label = label
        bin_row.save(update_fields=['drawer', 'label'])


def _apply_archive_ids(cabinet: Cabinet, archive_ids: list[str]) -> None:
    """Archive the listed drawers and bins, rejecting unknown ids."""
    for raw_id in archive_ids:
        value = _as_uuid(raw_id, 'archive_ids')

        drawer = Drawer.objects.filter(pk=value, cabinet=cabinet).first()

        if drawer is not None:
            drawer.archived = True
            drawer.save()
            continue

        bin_row = Bin.objects.filter(pk=value, drawer__cabinet=cabinet).first()

        if bin_row is not None:
            bin_row.archived = True
            bin_row.save()
            continue

        raise StorageLayoutError(
            _('Unknown or cross-cabinet archive id: %(id)s') % {'id': raw_id},
            code='invalid_reference',
        )


def apply_drawer_layout(
    drawer: Drawer, document: dict[str, Any], actor: Any, expected_revision: int
) -> dict[str, Any]:
    """Apply a drawer-focused layout document.

    The drawer projection shares the cabinet revision and transaction; it never
    reparents the drawer.
    """
    require_change(actor)

    cabinet = drawer.cabinet

    if not isinstance(document, dict):
        raise StorageLayoutError(
            _('A layout document is required'), code='invalid_value'
        )

    drawer_block = document.get('drawer') or {}

    if not isinstance(drawer_block, dict):
        raise StorageLayoutError(_('drawer must be an object'), code='invalid_value')

    if drawer_block.get('id') and str(drawer_block['id']) != str(drawer.pk):
        raise StorageLayoutError(
            _('The drawer id does not match the endpoint'), code='invalid_reference'
        )

    # Rebuild a full cabinet document so the same aggregate validation applies.
    full = layout_document(cabinet)
    target = None

    for entry in full['drawers']:
        if entry['id'] == str(drawer.pk):
            target = entry
            break

    if target is None:  # pragma: no cover - defensive
        raise NotFoundError(_('Drawer not found'), code='not_found')

    for key in (
        'label',
        'display_number',
        'x',
        'y',
        'width',
        'height',
        'interior_width',
        'interior_height',
        'archived',
        'location',
        'auto_create_location',
    ):
        if key in drawer_block:
            target[key] = drawer_block[key]

    if 'allocation' in drawer_block:
        target['allocation'] = drawer_block['allocation']

    if 'bins' in document:
        other_bins = [b for b in full['bins'] if b['drawer'] != str(drawer.pk)]
        full['bins'] = other_bins + list(document.get('bins') or [])

    full['archive_ids'] = document.get('archive_ids') or []

    return apply_layout(cabinet, full, actor, expected_revision)


# endregion


# region electrical documents


def electrical_document(cabinet: Cabinet) -> dict[str, Any]:
    """Return the saved electrical topology document for a cabinet."""
    controllers = []

    for controller in cabinet.controllers.all().order_by('name', 'id'):
        outputs = []

        for output in controller.outputs.all().order_by('bus_index', 'id'):
            strings = [
                {
                    'id': str(string.pk),
                    'label': string.label,
                    'output_offset': string.output_offset,
                    'pixel_count': string.pixel_count,
                    'notes': string.notes,
                    'archived': string.archived,
                }
                for string in output.strings.all().order_by('output_offset', 'id')
            ]

            outputs.append({
                'id': str(output.pk),
                'bus_index': output.bus_index,
                'wled_start': output.wled_start,
                'pixel_count': output.pixel_count,
                'pins': output.pins,
                'led_type': output.led_type,
                'colour_order': output.colour_order,
                'bus_reverse': output.bus_reverse,
                'skip': output.skip,
                'auto_white_mode': output.auto_white_mode,
                'max_current_ma': output.max_current_ma,
                'strings': strings,
            })

        controllers.append({
            'id': str(controller.pk),
            'name': controller.name,
            'origin': controller.origin,
            'expected_mac': controller.expected_mac,
            'firmware_adapter': controller.firmware_adapter,
            'enabled': controller.enabled,
            'status': controller.status,
            'commissioning_policy': controller.commissioning_policy,
            'outputs': outputs,
        })

    return {
        'schema_version': SCHEMA_VERSION,
        'cabinet': {'id': str(cabinet.pk), 'revision': cabinet.revision},
        'controllers': controllers,
        'archive_ids': [],
    }


@dataclass
class ElectricalPlan:
    """A parsed and validated electrical topology document."""

    controllers: list[dict[str, Any]] = field(default_factory=list)
    archive_ids: list[str] = field(default_factory=list)
    report: v.ValidationReport = field(default_factory=v.ValidationReport)


def prepare_electrical(cabinet: Cabinet, document: dict[str, Any]) -> ElectricalPlan:
    """Parse and validate an electrical topology document."""
    if not isinstance(document, dict):
        raise StorageLayoutError(
            _('An electrical document is required'), code='invalid_value'
        )

    report = v.ValidationReport()
    controllers = document.get('controllers') or []

    if not isinstance(controllers, list):
        raise StorageLayoutError(_('controllers must be a list'), code='invalid_value')

    limit = max_controllers_per_cabinet()

    if limit and len(controllers) > limit:
        report.add_error(
            v.CODE_UNSUPPORTED_CONFIGURATION,
            _('At most %(limit)s controllers are permitted per cabinet')
            % {'limit': limit},
            path='controllers',
        )

    parsed: list[dict[str, Any]] = []

    for index, entry in enumerate(controllers):
        if not isinstance(entry, dict):
            raise StorageLayoutError(
                _('Each controller must be an object'), code='invalid_value'
            )

        raw_id = entry.get('id')
        instance = None

        if raw_id:
            instance = Controller.objects.filter(
                pk=_as_uuid(raw_id, 'controller.id'), cabinet=cabinet
            ).first()

            if instance is None:
                raise StorageLayoutError(
                    _('Unknown or cross-cabinet controller id: %(id)s')
                    % {'id': raw_id},
                    code='invalid_reference',
                )

        origin = str(entry.get('origin', ''))

        try:
            origin = v.validate_canonical_origin(origin)
        except ValidationError as exc:
            report.add_error(
                v.CODE_UNSUPPORTED_CONFIGURATION,
                '; '.join(str(m) for m in exc.messages),
                path=f'controllers[{index}].origin',
            )

        outputs = entry.get('outputs') or []

        if not isinstance(outputs, list):
            raise StorageLayoutError(_('outputs must be a list'), code='invalid_value')

        parsed_outputs = []

        for output in outputs:
            if not isinstance(output, dict):
                raise StorageLayoutError(
                    _('Each output must be an object'), code='invalid_value'
                )

            output_id = output.get('id')
            output_instance = None

            if output_id:
                output_instance = ControllerOutput.objects.filter(
                    pk=_as_uuid(output_id, 'output.id'), controller__cabinet=cabinet
                ).first()

                if output_instance is None:
                    raise StorageLayoutError(
                        _('Unknown or cross-cabinet output id: %(id)s')
                        % {'id': output_id},
                        code='invalid_reference',
                    )

            strings = output.get('strings') or []

            if not isinstance(strings, list):
                raise StorageLayoutError(
                    _('strings must be a list'), code='invalid_value'
                )

            parsed_strings = []

            for string in strings:
                if not isinstance(string, dict):
                    raise StorageLayoutError(
                        _('Each string must be an object'), code='invalid_value'
                    )

                string_id = string.get('id')
                string_instance = None

                if string_id:
                    string_instance = LEDString.objects.filter(
                        pk=_as_uuid(string_id, 'string.id'),
                        output__controller__cabinet=cabinet,
                    ).first()

                    if string_instance is None:
                        raise StorageLayoutError(
                            _('Unknown or cross-cabinet string id: %(id)s')
                            % {'id': string_id},
                            code='invalid_reference',
                        )

                parsed_strings.append({
                    'id': str(string_id) if string_id else None,
                    'instance': string_instance,
                    'label': str(string.get('label', '')),
                    'output_offset': _as_int(
                        string.get('output_offset', 0), 'output_offset', 0
                    ),
                    'pixel_count': _as_int(string.get('pixel_count'), 'pixel_count', 1),
                    'notes': str(string.get('notes', '')),
                    'archived': bool(string.get('archived', False)),
                })

            parsed_outputs.append({
                'id': str(output_id) if output_id else None,
                'instance': output_instance,
                'bus_index': _as_int(output.get('bus_index', 0), 'bus_index', 0),
                'wled_start': _as_int(output.get('wled_start', 0), 'wled_start', 0),
                'pixel_count': _as_int(output.get('pixel_count'), 'pixel_count', 1),
                'pins': output.get('pins') or [],
                'led_type': str(output.get('led_type', '')),
                'colour_order': str(output.get('colour_order', 'GRB')),
                'bus_reverse': bool(output.get('bus_reverse', False)),
                'skip': _as_int(output.get('skip', 0), 'skip', 0),
                'auto_white_mode': _as_int(
                    output.get('auto_white_mode', 0), 'auto_white_mode', 0
                ),
                'max_current_ma': output.get('max_current_ma'),
                'strings': parsed_strings,
            })

        parsed.append({
            'id': str(raw_id) if raw_id else None,
            'instance': instance,
            'name': str(entry.get('name', '')),
            'origin': origin,
            'expected_mac': entry.get('expected_mac'),
            'firmware_adapter': str(entry.get('firmware_adapter', 'wled-v16.0.1-1d')),
            'enabled': bool(entry.get('enabled', False)),
            'commissioning_policy': entry.get('commissioning_policy') or {},
            'outputs': parsed_outputs,
        })

        v.validate_controller_outputs(
            [
                {
                    'id': output['id'] or f'new-{index}-{i}',
                    'bus_index': output['bus_index'],
                    'wled_start': output['wled_start'],
                    'pixel_count': output['pixel_count'],
                    'pins': output['pins'],
                    'bus_reverse': output['bus_reverse'],
                    'skip': output['skip'],
                }
                for i, output in enumerate(parsed_outputs)
            ],
            report=report,
        )

        for output in parsed_outputs:
            v.validate_led_strings(
                {'pixel_count': output['pixel_count']},
                [
                    {
                        'id': string['id'] or f'new-{index}-{string["label"]}',
                        'label': string['label'],
                        'output_offset': string['output_offset'],
                        'pixel_count': string['pixel_count'],
                    }
                    for string in output['strings']
                ],
                report=report,
            )

    _validate_controller_identities(parsed, report)

    return ElectricalPlan(
        controllers=parsed,
        archive_ids=[str(value) for value in (document.get('archive_ids') or [])],
        report=report,
    )


def _validate_controller_identities(
    controllers: list[dict[str, Any]], report: v.ValidationReport
) -> None:
    """Validate global controller origin and expected-MAC uniqueness.

    Origins and populated MAC addresses are globally unique across every
    cabinet. A conflict with a controller which is not part of the proposal is
    reported generically, without naming the owning cabinet, so the endpoint
    cannot be used to enumerate another operator's controllers.
    """
    seen_origins: dict[str, str] = {}
    seen_macs: dict[str, str] = {}

    for entry in controllers:
        identity = entry['id'] or f'new:{entry["name"]}'
        origin = entry['origin']

        if origin:
            if origin in seen_origins:
                report.add_error(
                    v.CODE_DUPLICATE_IDENTITY,
                    _('Controller origins must be unique'),
                    path=f'controllers[{identity}].origin',
                    related_ids=[seen_origins[origin], identity],
                )
            else:
                seen_origins[origin] = identity

        mac = entry['expected_mac']
        normalised = str(mac).strip().upper() if mac else ''

        if normalised:
            if normalised in seen_macs:
                report.add_error(
                    v.CODE_DUPLICATE_IDENTITY,
                    _('Expected MAC addresses must be unique'),
                    path=f'controllers[{identity}].expected_mac',
                    related_ids=[seen_macs[normalised], identity],
                )
            else:
                seen_macs[normalised] = identity

    represented = {
        entry['instance'].pk for entry in controllers if entry['instance'] is not None
    }

    for controller in Controller.objects.exclude(pk__in=represented):
        if controller.origin and controller.origin in seen_origins:
            report.add_error(
                v.CODE_DUPLICATE_IDENTITY,
                _('This controller origin is already in use'),
                path=f'controllers[{seen_origins[controller.origin]}].origin',
            )

        if controller.expected_mac and controller.expected_mac.upper() in seen_macs:
            report.add_error(
                v.CODE_DUPLICATE_IDENTITY,
                _('This expected MAC address is already in use'),
                path=(
                    f'controllers[{seen_macs[controller.expected_mac.upper()]}]'
                    '.expected_mac'
                ),
            )


def apply_electrical(
    cabinet: Cabinet, document: dict[str, Any], actor: Any, expected_revision: int
) -> dict[str, Any]:
    """Atomically apply an electrical topology document (database only)."""
    require_configure(actor)

    if not cabinet_is_idle(cabinet):
        raise CabinetBusyError(
            _('The cabinet has an active operation'), code='cabinet_busy'
        )

    plan = prepare_electrical(cabinet, document)
    _report_error(
        plan.report,
        _('The electrical configuration is invalid'),
        plan.report.errors[0].code
        if plan.report.errors
        else 'unsupported_configuration',
    )

    before = cabinet.revision

    with transaction.atomic():
        cas_update_cabinet(
            cabinet,
            expected_revision,
            updated_by_id=actor.pk
            if getattr(actor, 'is_authenticated', False)
            else None,
        )

        for entry in plan.controllers:
            try:
                controller = _persist_controller(cabinet, entry, actor)
            except IntegrityError as exc:
                # Origins and MAC addresses are globally unique, so a concurrent
                # write to another cabinet can still race the pre-flight check.
                # Convert only that expected unique violation; anything else is a
                # genuine fault and must not be swallowed.
                if not _is_controller_identity_conflict(exc):
                    raise

                raise StorageLayoutError(
                    _('This controller origin or MAC address is already in use'),
                    code=v.CODE_DUPLICATE_IDENTITY,
                ) from exc

            for output_entry in entry['outputs']:
                output = output_entry['instance']

                if output is None:
                    output = ControllerOutput.objects.create(
                        controller=controller,
                        bus_index=output_entry['bus_index'],
                        wled_start=output_entry['wled_start'],
                        pixel_count=output_entry['pixel_count'],
                        pins=output_entry['pins'],
                        led_type=output_entry['led_type'],
                        colour_order=output_entry['colour_order'],
                        bus_reverse=output_entry['bus_reverse'],
                        skip=output_entry['skip'],
                        auto_white_mode=output_entry['auto_white_mode'],
                        max_current_ma=output_entry['max_current_ma'],
                    )
                else:
                    output.bus_index = output_entry['bus_index']
                    output.wled_start = output_entry['wled_start']
                    output.pixel_count = output_entry['pixel_count']
                    output.pins = output_entry['pins']
                    output.led_type = output_entry['led_type']
                    output.colour_order = output_entry['colour_order']
                    output.bus_reverse = output_entry['bus_reverse']
                    output.skip = output_entry['skip']
                    output.auto_white_mode = output_entry['auto_white_mode']
                    output.max_current_ma = output_entry['max_current_ma']
                    output.save()

                for string_entry in output_entry['strings']:
                    string = string_entry['instance']

                    if string is None:
                        LEDString.objects.create(
                            output=output,
                            label=string_entry['label'],
                            output_offset=string_entry['output_offset'],
                            pixel_count=string_entry['pixel_count'],
                            notes=string_entry['notes'],
                            archived=string_entry['archived'],
                        )
                    else:
                        string.label = string_entry['label']
                        string.output_offset = string_entry['output_offset']
                        string.pixel_count = string_entry['pixel_count']
                        string.notes = string_entry['notes']
                        string.archived = string_entry['archived']
                        string.save()

        _apply_electrical_archive_ids(cabinet, plan.archive_ids)

    record_audit(
        cabinet,
        actor,
        'electrical.save',
        before_revision=before,
        after_revision=cabinet.revision,
        details={'controllers': len(plan.controllers)},
    )

    return electrical_document(cabinet)


def _persist_controller(
    cabinet: Cabinet, entry: dict[str, Any], actor: Any
) -> Controller:
    """Create or update a controller row from a parsed electrical entry."""
    controller = entry['instance']

    if controller is None:
        return Controller.objects.create(
            cabinet=cabinet,
            name=entry['name'],
            origin=entry['origin'],
            expected_mac=entry['expected_mac'],
            firmware_adapter=entry['firmware_adapter'],
            enabled=entry['enabled'],
            commissioning_policy=entry['commissioning_policy'],
            created_by=actor if getattr(actor, 'is_authenticated', False) else None,
        )

    controller.name = entry['name']
    controller.origin = entry['origin']
    controller.expected_mac = entry['expected_mac']
    controller.firmware_adapter = entry['firmware_adapter']
    controller.enabled = entry['enabled']
    controller.commissioning_policy = entry['commissioning_policy']
    controller.save()

    return controller


def _is_controller_identity_conflict(exc: IntegrityError) -> bool:
    """Return True when ``exc`` is a controller origin/MAC unique violation."""
    text = str(exc).lower()

    return 'origin' in text or 'expected_mac' in text


def _apply_electrical_archive_ids(cabinet: Cabinet, archive_ids: list[str]) -> None:
    """Archive the listed strings, rejecting unknown ids."""
    for raw_id in archive_ids:
        value = _as_uuid(raw_id, 'archive_ids')
        string = LEDString.objects.filter(
            pk=value, output__controller__cabinet=cabinet
        ).first()

        if string is None:
            raise StorageLayoutError(
                _('Unknown or cross-cabinet archive id: %(id)s') % {'id': raw_id},
                code='invalid_reference',
            )

        string.archived = True
        string.save()


# endregion


# region mapping


def _candidate_span_rows(
    cabinet: Cabinet, candidate: dict[str, Any]
) -> tuple[list[dict[str, Any]], int]:
    """Resolve candidate spans into validation rows with topology."""
    total = _as_int(candidate.get('total_pixels'), 'total_pixels', 1)
    rows = []
    spans = candidate.get('spans') or []

    if not isinstance(spans, list):
        raise StorageLayoutError(_('spans must be a list'), code='invalid_value')

    for index, span in enumerate(spans):
        if not isinstance(span, dict):
            raise StorageLayoutError(
                _('Each span must be an object'), code='invalid_value'
            )

        string_id = span.get('string')

        if not string_id:
            raise StorageLayoutError(
                _('Each span must reference a string'), code='invalid_reference'
            )

        string = (
            LEDString.objects
            .filter(
                pk=_as_uuid(string_id, 'span.string'),
                output__controller__cabinet=cabinet,
            )
            .select_related('output', 'output__controller')
            .first()
        )

        if string is None:
            raise StorageLayoutError(
                _('Unknown or cross-cabinet string id: %(id)s') % {'id': string_id},
                code='invalid_reference',
            )

        rows.append({
            'id': f'span-{index}',
            'logical_start': _as_int(span.get('logical_start'), 'logical_start', 1),
            'length': _as_int(span.get('length'), 'length', 1),
            'string_offset': _as_int(span.get('string_offset', 0), 'string_offset', 0),
            'direction': _as_int(span.get('direction', 1), 'direction'),
            'string': string,
        })

    return rows, total


def mapping_preview(cabinet: Cabinet, candidate: dict[str, Any]) -> dict[str, Any]:
    """Validate a candidate mapping and return deterministic diagnostics."""
    rows, total = _candidate_span_rows(cabinet, candidate)
    report = v.validate_mapping_spans(rows, total)

    result: dict[str, Any] = {
        'valid': report.valid,
        'errors': [issue.as_dict() for issue in report.errors],
        'warnings': [issue.as_dict() for issue in report.warnings],
        'unused_ranges': [list(r) for r in report.unused_ranges],
        'total_pixels': total,
        'mapping_hash': '',
        'samples': [],
        'drawer_impacts': [],
    }

    if report.valid:
        result['mapping_hash'] = mapping_module.mapping_hash(rows, total)
        result['samples'] = mapping_module.sample_translation(rows, total)
        result['drawer_impacts'] = _drawer_impacts(cabinet, rows, total)

    return result


def _drawer_impacts(
    cabinet: Cabinet, rows: list[dict[str, Any]], total: int
) -> list[dict[str, Any]]:
    """Return the per-drawer logical/physical impact of a candidate mapping."""
    impacts = []

    for drawer in cabinet.drawers.all().order_by('display_number', 'id'):
        allocation = getattr(drawer, 'allocation', None)

        if allocation is None:
            continue

        entry: dict[str, Any] = {
            'drawer': str(drawer.pk),
            'label': drawer.label,
            'logical_start': allocation.logical_start,
            'logical_end': allocation.logical_end,
            'runs': [],
            'valid': True,
        }

        if allocation.logical_end > total:
            entry['valid'] = False
            entry['error'] = 'allocation_exceeds_mapping'
        else:
            try:
                entry['runs'] = mapping_module.translate(
                    rows, allocation.logical_start, allocation.logical_end, total
                )
            except ValidationError:
                entry['valid'] = False
                entry['error'] = 'uncovered'

        impacts.append(entry)

    return impacts


#: Maximum number of changed physical pixels returned by a publish.
MAX_CHANGED_PIXELS = 500


def _physical_addresses(mapping: MappingRevision | None) -> dict[int, tuple[str, int]]:
    """Return the logical -> (controller, WLED index) address map for a mapping."""
    addresses: dict[int, tuple[str, int]] = {}

    if mapping is None:
        return addresses

    for span in mapping.spans.all():
        view = mapping_module.span_view(span)

        for offset in range(view.length):
            logical = view.logical_start + offset
            addresses[logical] = (view.controller_id, view.wled_index(logical))

    return addresses


def _changed_physical_pixels(
    previous: MappingRevision | None, revision: MappingRevision
) -> tuple[list[dict[str, Any]], int]:
    """Return the physical pixels whose address changed between two mappings.

    The returned list is bounded by :data:`MAX_CHANGED_PIXELS`; the returned
    count is the true total, so a caller can tell when the list was truncated.
    """
    before = _physical_addresses(previous)
    after = _physical_addresses(revision)

    changed: list[dict[str, Any]] = []
    count = 0

    for logical in sorted(set(before) | set(after)):
        old = before.get(logical)
        new = after.get(logical)

        if old == new:
            continue

        count += 1

        if len(changed) < MAX_CHANGED_PIXELS:
            changed.append({
                'logical': logical,
                'before': list(old) if old is not None else None,
                'after': list(new) if new is not None else None,
            })

    return changed, count


def publish_mapping(
    cabinet: Cabinet,
    candidate: dict[str, Any],
    actor: Any,
    expected_revision: int,
    *,
    expected_fingerprints: dict[str, str] | None = None,
    replacement_allocations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Publish an immutable mapping revision and set it active.

    Args:
        cabinet: The cabinet being edited.
        candidate: The candidate mapping document.
        actor: The acting user.
        expected_revision: The revision the caller believes is current.
        expected_fingerprints: Optional controller-id to fingerprint map.
        replacement_allocations: Optional explicit drawer allocation changes.

    Returns:
        The published mapping summary.

    Raises:
        StorageLayoutError: If validation fails or the revision is stale.
    """
    require_configure(actor)

    before = expected_revision

    with transaction.atomic():
        # A conditional write locks the aggregate on all supported databases,
        # including SQLite where select_for_update is a no-op. Check CAS before
        # reading allocations or computing the next immutable revision number.
        if not Cabinet.objects.filter(pk=cabinet.pk, revision=expected_revision).update(
            revision=expected_revision
        ):
            raise StaleRevisionError(
                _('The cabinet has changed since it was loaded; reload and retry'),
                code='stale',
            )
        current = Cabinet.objects.get(pk=cabinet.pk)
        if not cabinet_is_idle(current):
            raise CabinetBusyError(
                _('The cabinet has an active operation'), code='cabinet_busy'
            )

        rows, total = _candidate_span_rows(current, candidate)
        report = v.validate_mapping_spans(rows, total)
        _report_error(
            report,
            _('The mapping is invalid'),
            report.errors[0].code if report.errors else 'mapping_gap',
        )
        if expected_fingerprints:
            _check_fingerprints(current, expected_fingerprints)
        replacements = _validate_publication_allocations(
            current, replacement_allocations or [], total
        )
        content_hash = mapping_module.mapping_hash(rows, total)
        manifest = mapping_module.build_manifest(rows, total)
        previous = current.active_mapping

        number = (
            MappingRevision.objects.filter(cabinet=cabinet).aggregate(
                highest=Max('number')
            )['highest']
            or 0
        ) + 1

        revision = MappingRevision.objects.create(
            cabinet=cabinet,
            number=number,
            state=MappingState.PUBLISHED,
            total_pixels=total,
            content_hash=content_hash,
            source_revision=expected_revision,
            manifest=manifest,
            created_by=actor if getattr(actor, 'is_authenticated', False) else None,
        )

        for row in rows:
            PixelSpan.objects.create(
                mapping_revision=revision,
                string=row['string'],
                logical_start=row['logical_start'],
                length=row['length'],
                string_offset=row['string_offset'],
                direction=row['direction'],
            )

        for drawer_id, (start, end) in replacements.items():
            DrawerAllocation.objects.update_or_create(
                drawer_id=drawer_id,
                defaults={'logical_start': start, 'logical_end': end},
            )

        cas_update_cabinet(cabinet, expected_revision, active_mapping_id=revision.pk)

        if previous is not None and previous.pk != revision.pk:
            MappingRevision.objects.filter(pk=previous.pk).update(
                state=MappingState.SUPERSEDED
            )

    record_audit(
        cabinet,
        actor,
        'mapping.publish',
        before_revision=before,
        after_revision=cabinet.revision,
        details={
            'mapping': str(revision.pk),
            'number': number,
            'total_pixels': total,
            'mapping_hash': content_hash,
        },
    )

    changed_pixels, changed_count = _changed_physical_pixels(previous, revision)

    return {
        'id': str(revision.pk),
        'number': number,
        'state': revision.state,
        'total_pixels': total,
        'mapping_hash': content_hash,
        'revision': cabinet.revision,
        'changed_pixels': changed_pixels,
        'changed_count': changed_count,
        'changed_truncated': changed_count > len(changed_pixels),
    }


def _check_fingerprints(cabinet: Cabinet, expected: dict[str, str]) -> None:
    """Reject a publish request when an approved fingerprint has drifted."""
    for controller_id, fingerprint in expected.items():
        controller = Controller.objects.filter(
            pk=_as_uuid(controller_id, 'controller'), cabinet=cabinet
        ).first()

        if controller is None:
            raise StorageLayoutError(
                _('Unknown controller in expected fingerprints'),
                code='invalid_reference',
            )

        snapshot = controller.approved_snapshot

        if snapshot is None or snapshot.fingerprint != fingerprint:
            raise ConfigDriftError(
                _('Controller %(name)s configuration has drifted')
                % {'name': controller.name},
                code='config_drift',
            )


def _validate_publication_allocations(
    cabinet: Cabinet, allocations: list[dict[str, Any]], total: int
) -> dict[Any, tuple[int, int]]:
    """Validate the complete final set while the cabinet write lock is held.

    Archived drawers retain their allocations, matching layout validation; an
    archive does not silently free reserved logical pixels.
    """
    drawers = set(Drawer.objects.filter(cabinet=cabinet).values_list('pk', flat=True))
    final = {
        row.drawer_id: (row.logical_start, row.logical_end)
        for row in DrawerAllocation.objects.filter(drawer__cabinet=cabinet)
    }
    replacements = {}
    for entry in allocations:
        drawer_id = _as_uuid(entry.get('drawer'), 'drawer')
        if drawer_id not in drawers or drawer_id in replacements:
            raise StorageLayoutError(
                _('Unknown or duplicate drawer in replacement allocations'),
                code='invalid_reference',
            )
        start = _as_int(entry.get('logical_start'), 'logical_start')
        end = _as_int(entry.get('logical_end'), 'logical_end')
        replacements[drawer_id] = (start, end)
        final[drawer_id] = (start, end)

    report = v.validate_allocations(
        [
            {'id': str(drawer_id), 'logical_start': start, 'logical_end': end}
            for drawer_id, (start, end) in final.items()
        ],
        total,
    )
    # Allocation endpoints are inclusive, unlike physical WLED intervals.
    ordered = sorted(final.values())
    if any(right[0] <= left[1] for left, right in pairwise(ordered)):
        report.add_error('allocation_overlap', _('Drawer allocations must not overlap'))
    _report_error(
        report,
        _('The final drawer allocations are invalid'),
        report.errors[0].code if report.errors else 'invalid_bounds',
    )
    return replacements


def translate_range(
    cabinet: Cabinet, logical_start: int, logical_end: int, mapping_hash_value: str = ''
) -> dict[str, Any]:
    """Translate an inclusive logical range using the active mapping."""
    mapping = cabinet.active_mapping

    if mapping is None:
        raise StorageLayoutError(
            _('The cabinet has no active mapping'), code='mapping_gap'
        )

    if mapping_hash_value and mapping_hash_value != mapping.content_hash:
        raise StaleRevisionError(_('The supplied mapping hash is stale'), code='stale')

    runs = mapping_module.translate(
        mapping.spans.all(), logical_start, logical_end, mapping.total_pixels
    )

    return {
        'mapping_hash': mapping.content_hash,
        'total_pixels': mapping.total_pixels,
        'logical_start': int(logical_start),
        'logical_end': int(logical_end),
        'pixel_count': sum(
            run['logical_end'] - run['logical_start'] + 1 for run in runs
        ),
        'runs': runs,
    }


# endregion


# region target resolution


def resolve_drawer_for_location(
    cabinet: Cabinet, location: StockLocation
) -> Drawer | None:
    """Resolve a native location to a mapped drawer.

    A directly bound bin or drawer wins; otherwise the nearest mapped ancestor
    is used. The cabinet location itself is ambiguous and never resolves.
    """
    bin_row = (
        Bin.objects
        .filter(location=location, drawer__cabinet=cabinet)
        .select_related('drawer')
        .first()
    )

    if bin_row is not None:
        return bin_row.drawer

    drawer = Drawer.objects.filter(location=location, cabinet=cabinet).first()

    if drawer is not None:
        return drawer

    node = location.parent

    while node is not None:
        if node.pk == cabinet.location_id:
            return None

        bin_row = (
            Bin.objects
            .filter(location=node, drawer__cabinet=cabinet)
            .select_related('drawer')
            .first()
        )

        if bin_row is not None:
            return bin_row.drawer

        drawer = Drawer.objects.filter(location=node, cabinet=cabinet).first()

        if drawer is not None:
            return drawer

        node = node.parent

    return None


def resolve_target(
    cabinet: Cabinet, target_kind: str, target_id: Any
) -> tuple[Drawer, DrawerAllocation, dict[str, Any]]:
    """Resolve a locate target to a drawer and its allocation.

    Args:
        cabinet: The cabinet being targeted.
        target_kind: One of ``item``, ``location`` or ``drawer``.
        target_id: The target primary key.

    Returns:
        A tuple of ``(drawer, allocation, snapshot)``.

    Raises:
        NotLocatableError: If the target cannot be resolved to a mapped drawer.
    """
    snapshot: dict[str, Any] = {'kind': target_kind, 'pk': str(target_id)}

    if target_kind == TargetKind.DRAWER:
        drawer = Drawer.objects.filter(
            pk=_as_uuid(target_id, 'drawer'), cabinet=cabinet
        ).first()

        if drawer is None:
            raise NotFoundError(_('Drawer not found'), code='not_found')

        snapshot['label'] = drawer.label
    elif target_kind == TargetKind.ITEM:
        item = StockItem.objects.filter(pk=target_id).first()

        if item is None:
            raise NotFoundError(_('Stock item not found'), code='not_found')

        if not item.in_stock or item.location is None:
            raise NotLocatableError(
                _('The stock item is not in stock at a location'), code='not_locatable'
            )

        snapshot['label'] = item.part.full_name if item.part_id else str(item.pk)
        drawer = resolve_drawer_for_location(cabinet, item.location)
    elif target_kind == TargetKind.LOCATION:
        location = StockLocation.objects.filter(pk=target_id).first()

        if location is None:
            raise NotFoundError(_('Stock location not found'), code='not_found')

        snapshot['label'] = location.name
        drawer = resolve_drawer_for_location(cabinet, location)
    else:
        raise StorageLayoutError(_('Unsupported target kind'), code='invalid_value')

    if drawer is None:
        raise NotLocatableError(
            _('The target is not mapped to a drawer in this cabinet'),
            code='not_locatable',
        )

    allocation = getattr(drawer, 'allocation', None)

    if allocation is None:
        raise NotLocatableError(
            _('The target drawer has no LED allocation'), code='not_locatable'
        )

    return drawer, allocation, snapshot


def _binding_document(
    location: StockLocation,
    cabinet: Cabinet | None,
    role: str | None,
    drawer: Drawer | None,
    bin_row: Bin | None,
) -> dict[str, Any]:
    """Build the binding document returned by the location lookup endpoint."""
    mapping = cabinet.active_mapping if cabinet is not None else None
    allocation = getattr(drawer, 'allocation', None) if drawer is not None else None
    locatable = bool(drawer is not None and allocation is not None)

    reason = ''

    if role is None:
        reason = 'unbound'
    elif role == 'cabinet':
        reason = 'cabinet_root'
    elif not locatable:
        reason = 'no_allocation'

    return {
        'location': location.pk,
        'bound': cabinet is not None,
        'role': role,
        'cabinet': None
        if cabinet is None
        else {
            'id': str(cabinet.pk),
            'name': cabinet.name,
            'slug': cabinet.slug,
            'revision': cabinet.revision,
            'active_mapping': str(mapping.pk) if mapping is not None else None,
            'mapping_hash': mapping.content_hash if mapping is not None else '',
            'total_pixels': mapping.total_pixels if mapping is not None else 0,
        },
        'drawer': None
        if drawer is None
        else {
            'id': str(drawer.pk),
            'label': drawer.label,
            'display_number': drawer.display_number,
            'allocation': allocation_document(allocation),
        },
        'bin': None
        if bin_row is None
        else {'id': str(bin_row.pk), 'label': bin_row.label},
        'locatable': locatable,
        'reason': reason,
    }


def location_binding(location: StockLocation) -> dict[str, Any]:
    """Resolve a native location to its plugin binding.

    A directly bound cabinet, drawer or bin wins; otherwise the nearest bound
    ancestor is used. This lets the UI present the correct binding (cabinet /
    drawer / bin) and decide whether the location is locatable without issuing
    a list query per cabinet.

    Args:
        location: The native stock location.

    Returns:
        A binding document describing the role, cabinet, drawer, bin and
        whether the location can be lit.
    """
    from storage_layout.models import Bin as _Bin
    from storage_layout.models import Cabinet as _Cabinet
    from storage_layout.models import Drawer as _Drawer

    cabinet = (
        _Cabinet.objects.filter(location=location).select_related('location').first()
    )

    if cabinet is not None:
        return _binding_document(location, cabinet, 'cabinet', None, None)

    node = location

    while node is not None:
        bin_row = (
            _Bin.objects.filter(location=node).select_related('drawer__cabinet').first()
        )

        if bin_row is not None:
            return _binding_document(
                location, bin_row.drawer.cabinet, 'bin', bin_row.drawer, bin_row
            )

        drawer = _Drawer.objects.filter(location=node).select_related('cabinet').first()

        if drawer is not None:
            return _binding_document(location, drawer.cabinet, 'drawer', drawer, None)

        root = _Cabinet.objects.filter(location=node).select_related('location').first()

        if root is not None:
            return _binding_document(location, root, 'cabinet', None, None)

        node = node.parent

    return _binding_document(location, None, None, None, None)


# endregion


# region transport / WLED integration


def load_wled_adapter() -> Any:
    """Return the commissioned WLED adapter module, or ``None``.

    The adapter is owned by the Stage 4 work package
    (:mod:`storage_layout.wled`). When it is not installed, live hardware
    access fails closed.
    """
    try:
        from storage_layout import wled  # type: ignore[attr-defined]
    except ImportError:
        return None

    if not hasattr(wled, 'get_adapter'):
        return None

    return wled


def build_live_adapter() -> Any:
    """Build a live adapter instance, or return ``None`` when unavailable.

    This is the single seam used by the service layer and by tests: patching
    this function injects a deterministic transport without touching the
    fail-closed gate.
    """
    module = load_wled_adapter()

    if module is None:
        return None

    try:
        return module.get_adapter()
    except Exception:  # pragma: no cover - defensive
        return None


def require_live_adapter() -> Any:
    """Return the live adapter or raise :class:`LiveNotAvailableError`.

    This is the fail-closed gate for every live hardware operation.
    """
    if not hardware_enabled():
        raise LiveNotAvailableError(
            _('Live hardware access is disabled; enable it explicitly first'),
            code='live_unavailable',
        )

    adapter = build_live_adapter()

    if adapter is None:
        raise LiveNotAvailableError(
            _('No commissioned WLED adapter is installed'), code='live_unavailable'
        )

    return adapter


def translate_wled_error(exc: Exception) -> StorageLayoutError:
    """Map an adapter error onto the plugin's documented error shape.

    Matching is by class name rather than ``isinstance`` because the plugin
    registry purges and re-imports the whole plugin package when it reloads
    (the package is installed outside ``BASE_DIR``), so an adapter instance and
    this module can hold different class objects for the same error.
    """
    cls = type(exc)
    name = cls.__name__
    message = str(exc)

    if not getattr(cls, '__module__', '').startswith('storage_layout'):
        return LiveNotAvailableError(message, code='live_unavailable')

    if name == 'OutOfRangeError':
        details = getattr(exc, 'details', {})
        safe = (
            {
                key: value
                for key in ('start', 'stop', 'led_count')
                if type(value := details.get(key)) is int and abs(value) <= 2**63 - 1
            }
            if isinstance(details, dict)
            else {}
        )
        return StorageLayoutError(
            _('A pixel interval is outside the controller LED bounds'),
            code='out_of_range',
            errors=[safe] if safe else [],
        )

    if name in ('ConfigDriftError', 'ConfigDrift'):
        return ConfigDriftError(message, code='config_drift')

    if name in ('UnsupportedConfigError', 'UnsupportedConfig'):
        return UnsupportedConfigurationError(message, code='unsupported_configuration')

    if name in (
        'UnsafeOriginError',
        'UnsafeOrigin',
        'AllowlistError',
        'TransportUnavailableError',
        'TransportUnavailable',
    ):
        return LiveNotAvailableError(message, code='live_unavailable')

    if name in ('AmbiguousWriteError', 'AmbiguousWrite'):
        return StorageLayoutError(
            message, code='clear_unconfirmed', status_code=status.HTTP_409_CONFLICT
        )

    if name in ('TransportTimeoutError', 'TransportTimeout'):
        return StorageLayoutError(
            message,
            code='controller_timeout',
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    if name in (
        'ResponseTooLargeError',
        'ResponseTooLarge',
        'MalformedResponseError',
        'MalformedResponse',
        'ControllerError',
    ):
        return LiveNotAvailableError(message, code='controller_unavailable')

    if name in (
        'PreflightError',
        'ProtocolError',
        'PayloadTooLargeError',
        'PayloadTooLarge',
    ):
        return StorageLayoutError(
            message, code='protocol_error', status_code=status.HTTP_409_CONFLICT
        )

    return LiveNotAvailableError(message, code='live_unavailable')


class SimulatedTransport:
    """A no-op transport used for simulation mode.

    It records the plan it was asked to apply but never opens a socket.
    """

    def __init__(self) -> None:
        """Initialise an empty transport log."""
        self.calls: list[dict[str, Any]] = []

    def apply(self, controller: Any, plan: dict[str, Any]) -> dict[str, Any]:
        """Record a simulated apply."""
        self.calls.append({'controller': str(controller), 'plan': plan})

        return {'acknowledged': True, 'simulated': True}

    def clear(self, controller: Any) -> dict[str, Any]:
        """Record a simulated clear."""
        self.calls.append({'controller': str(controller), 'clear': True})

        return {'acknowledged': True, 'simulated': True}


# endregion


# region profiles


def profile_snapshot(profile: LocateProfile | None) -> dict[str, Any]:
    """Return the frozen profile snapshot stored on a session."""
    if profile is None:
        return {
            'name': 'default',
            'purpose': LocatePurpose.LOCATE,
            'rgb': [0, 255, 0],
            'white': 0,
            'brightness': 64,
            'duration_seconds': 120,
        }

    return {
        'id': str(profile.pk),
        'name': profile.name,
        'purpose': profile.purpose,
        'rgb': list(profile.rgb),
        'white': profile.white,
        'brightness': profile.brightness,
        'duration_seconds': profile.duration_seconds,
    }


# endregion


# region sessions


def build_session_plan(
    cabinet: Cabinet,
    drawer: Drawer,
    allocation: DrawerAllocation,
    profile: LocateProfile | None,
    mode: str,
    duration_seconds: int,
) -> dict[str, Any]:
    """Build the deterministic execution plan for a locate session."""
    mapping = cabinet.active_mapping

    if mapping is None:
        raise StorageLayoutError(
            _('The cabinet has no active mapping'), code='mapping_gap'
        )

    runs = mapping_module.translate(
        mapping.spans.all(),
        allocation.logical_start,
        allocation.logical_end,
        mapping.total_pixels,
    )

    controllers = sorted({run['controller'] for run in runs})

    return {
        'mode': mode,
        'drawer': str(drawer.pk),
        'drawer_label': drawer.label,
        'logical_start': allocation.logical_start,
        'logical_end': allocation.logical_end,
        'runs': runs,
        'controllers': controllers,
        'profile': profile_snapshot(profile),
        'duration_seconds': duration_seconds,
        'mapping_hash': mapping.content_hash,
    }


def create_locate_session(
    cabinet: Cabinet, actor: Any, payload: dict[str, Any]
) -> tuple[LocateSession, bool]:
    """Create (or return an existing) locate session idempotently.

    Args:
        cabinet: The target cabinet.
        actor: The initiating user.
        payload: The validated request payload.

    Returns:
        A tuple of ``(session, created)``.

    Raises:
        StorageLayoutError: On permission, busy, idempotency or resolution errors.
    """
    require_operate(actor)

    idempotency_key = str(payload.get('idempotency_key') or '')

    if not idempotency_key:
        raise StorageLayoutError(
            _('An idempotency_key is required'), code='invalid_value'
        )

    request_hash = _canonical_hash({
        'cabinet': str(cabinet.pk),
        'target': payload.get('target'),
        'profile': payload.get('profile'),
        'mode': payload.get('mode'),
        'mapping_hash': payload.get('mapping_hash'),
        'duration_seconds': payload.get('duration_seconds'),
    })

    existing = LocateSession.objects.filter(
        cabinet=cabinet, idempotency_key=idempotency_key
    ).first()

    if existing is not None:
        if existing.request_hash != request_hash:
            raise StorageLayoutError(
                _('This idempotency key was used with a different request'),
                code='idempotency_conflict',
                status_code=status.HTTP_409_CONFLICT,
            )

        return existing, False

    mode = str(payload.get('mode') or LocateMode.SIMULATE)

    if mode not in (LocateMode.SIMULATE, LocateMode.LIVE):
        raise StorageLayoutError(_('Unsupported mode'), code='invalid_value')

    if mode == LocateMode.LIVE and not payload.get('approve_live'):
        raise StorageLayoutError(
            _('Live locate requires explicit approve_live approval'),
            code='approval_required',
            status_code=status.HTTP_409_CONFLICT,
        )

    if mode == LocateMode.LIVE:
        # Fail closed at the request boundary: live work is never accepted
        # unless hardware access and a commissioned adapter are available.
        require_live_adapter()
        require_live_dispatcher()

    target = payload.get('target') or {}

    if not isinstance(target, dict):
        raise StorageLayoutError(_('target must be an object'), code='invalid_value')

    target_kind = str(target.get('kind') or '')

    drawer, allocation, snapshot = resolve_target(
        cabinet, target_kind, target.get('id')
    )

    mapping = cabinet.active_mapping

    if mapping is None:
        raise StorageLayoutError(
            _('The cabinet has no active mapping'), code='mapping_gap'
        )

    supplied_hash = str(payload.get('mapping_hash') or '')

    if supplied_hash and supplied_hash != mapping.content_hash:
        raise StaleRevisionError(_('The supplied mapping hash is stale'), code='stale')

    profile = None
    profile_id = payload.get('profile')

    if profile_id:
        profile = LocateProfile.objects.filter(
            pk=_as_uuid(profile_id, 'profile'), cabinet=cabinet
        ).first()

        if profile is None:
            raise NotFoundError(_('Profile not found'), code='not_found')

    purpose = profile.purpose if profile is not None else LocatePurpose.LOCATE
    duration = payload.get('duration_seconds')

    if duration is None:
        duration = profile.duration_seconds if profile is not None else 120

    duration = _as_int(duration, 'duration_seconds', 1)

    try:
        v.validate_profile_duration(purpose, duration)
    except ValidationError as exc:
        raise StorageLayoutError(
            '; '.join(str(m) for m in exc.messages), code='invalid_bounds'
        ) from exc

    plan = build_session_plan(cabinet, drawer, allocation, profile, mode, duration)

    if not queue_available():
        raise QueueUnavailableError(
            _('The background task queue is unavailable'), code='queue_unavailable'
        )

    with transaction.atomic():
        operation = CabinetOperation.objects.select_for_update().get(cabinet=cabinet)

        if operation.current_session_id:
            current = operation.current_session

            if current is not None and current.state in ACTIVE_SESSION_STATES:
                raise CabinetBusyError(
                    _('The cabinet is busy with another operation'), code='cabinet_busy'
                )

        session = LocateSession.objects.create(
            cabinet=cabinet,
            actor=actor if getattr(actor, 'is_authenticated', False) else None,
            target_kind=target_kind,
            target_item_id=target.get('id') if target_kind == TargetKind.ITEM else None,
            target_location_id=target.get('id')
            if target_kind == TargetKind.LOCATION
            else None,
            target_label=str(snapshot.get('label', ''))[:100],
            target_pk=str(snapshot.get('pk', ''))[:64],
            expires_at=timezone.now() + timedelta(seconds=duration),
            mode=mode,
            mapping_hash=mapping.content_hash,
            layout_revision=cabinet.revision,
            profile_snapshot=plan['profile'],
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            state=SessionState.QUEUED,
            plan=plan,
        )

        _reserve_session(operation, session, actor, duration)

        # Durable dispatch: the session row is committed before the worker can
        # observe it, and an enqueue failure is persisted on the session.
        transaction.on_commit(lambda: dispatch_session(session.pk))

    record_audit(
        cabinet,
        actor,
        'locate.create',
        before_revision=cabinet.revision,
        after_revision=cabinet.revision,
        details={'session': str(session.pk), 'mode': mode, 'target': snapshot},
    )

    return session, True


def create_pixel_test(
    cabinet: Cabinet, actor: Any, payload: dict[str, Any]
) -> tuple[LocateSession, bool]:
    """Create (or return an existing) pixel-test session idempotently.

    A pixel test exercises an explicit logical range using a test-purpose
    profile. It shares the session, reservation and simulation protocol with a
    locate session.
    """
    require_operate(actor)

    idempotency_key = str(payload.get('idempotency_key') or '')

    if not idempotency_key:
        raise StorageLayoutError(
            _('An idempotency_key is required'), code='invalid_value'
        )

    request_hash = _canonical_hash({
        'cabinet': str(cabinet.pk),
        'kind': 'pixel-test',
        'pattern': payload.get('pattern', 'range'),
        'logical_start': payload.get('logical_start'),
        'logical_end': payload.get('logical_end'),
        'profile': payload.get('profile'),
        'mode': payload.get('mode'),
        'mapping_hash': payload.get('mapping_hash'),
    })

    existing = LocateSession.objects.filter(
        cabinet=cabinet, idempotency_key=idempotency_key
    ).first()

    if existing is not None:
        if existing.request_hash != request_hash:
            raise StorageLayoutError(
                _('This idempotency key was used with a different request'),
                code='idempotency_conflict',
                status_code=status.HTTP_409_CONFLICT,
            )

        return existing, False

    mode = str(payload.get('mode') or LocateMode.SIMULATE)

    if mode == LocateMode.LIVE and not payload.get('approve_live'):
        raise StorageLayoutError(
            _('Live pixel tests require explicit approve_live approval'),
            code='approval_required',
            status_code=status.HTTP_409_CONFLICT,
        )

    if mode == LocateMode.LIVE:
        require_live_adapter()
        require_live_dispatcher()

    mapping = cabinet.active_mapping

    if mapping is None:
        raise StorageLayoutError(
            _('The cabinet has no active mapping'), code='mapping_gap'
        )

    supplied_hash = str(payload.get('mapping_hash') or '')

    if supplied_hash and supplied_hash != mapping.content_hash:
        raise StaleRevisionError(_('The supplied mapping hash is stale'), code='stale')

    start = _as_int(payload.get('logical_start'), 'logical_start', 1)
    end = _as_int(payload.get('logical_end'), 'logical_end', 1)

    if end < start or end > mapping.total_pixels:
        raise StorageLayoutError(
            _('The pixel test range is out of bounds'), code='invalid_bounds'
        )

    pattern = str(payload.get('pattern') or 'range')
    if pattern not in ('range', 'walk') or (pattern == 'walk' and end - start + 1 > 32):
        raise StorageLayoutError(
            _('A walking test supports at most 32 pixels'), code='invalid_bounds'
        )

    profile = None
    profile_id = payload.get('profile')

    if profile_id:
        profile = LocateProfile.objects.filter(
            pk=_as_uuid(profile_id, 'profile'), cabinet=cabinet
        ).first()

        if profile is None:
            raise NotFoundError(_('Profile not found'), code='not_found')

        if profile.purpose != LocatePurpose.TEST:
            raise StorageLayoutError(
                _('A pixel test requires a test-purpose profile'), code='invalid_value'
            )

    duration = profile.duration_seconds if profile is not None else 5

    try:
        v.validate_profile_duration(LocatePurpose.TEST, duration)
    except ValidationError as exc:
        raise StorageLayoutError(
            '; '.join(str(m) for m in exc.messages), code='invalid_bounds'
        ) from exc

    runs = mapping_module.translate(
        mapping.spans.all(), start, end, mapping.total_pixels
    )

    plan = {
        'mode': mode,
        'kind': 'pixel-test',
        'pattern': pattern,
        'frames': [
            {
                'logical_pixel': pixel,
                'offset_seconds': (pixel - start) * duration / (end - start + 1),
                'runs': mapping_module.translate(
                    mapping.spans.all(), pixel, pixel, mapping.total_pixels
                ),
            }
            for pixel in range(start, end + 1)
        ]
        if pattern == 'walk'
        else [],
        'logical_start': start,
        'logical_end': end,
        'runs': runs,
        'controllers': sorted({run['controller'] for run in runs}),
        'profile': profile_snapshot(profile),
        'duration_seconds': duration,
        'mapping_hash': mapping.content_hash,
    }

    if not queue_available():
        raise QueueUnavailableError(
            _('The background task queue is unavailable'), code='queue_unavailable'
        )

    with transaction.atomic():
        operation = CabinetOperation.objects.select_for_update().get(cabinet=cabinet)

        if operation.current_session_id:
            current = operation.current_session

            if current is not None and current.state in ACTIVE_SESSION_STATES:
                raise CabinetBusyError(
                    _('The cabinet is busy with another operation'), code='cabinet_busy'
                )

        session = LocateSession.objects.create(
            cabinet=cabinet,
            actor=actor if getattr(actor, 'is_authenticated', False) else None,
            target_kind=TargetKind.DRAWER,
            target_label='pixel-test',
            target_pk=f'{start}-{end}',
            expires_at=timezone.now() + timedelta(seconds=duration),
            mode=mode,
            mapping_hash=mapping.content_hash,
            layout_revision=cabinet.revision,
            profile_snapshot=plan['profile'],
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            state=SessionState.QUEUED,
            plan=plan,
        )

        _reserve_session(operation, session, actor, duration)

        transaction.on_commit(lambda: dispatch_session(session.pk))

    record_audit(
        cabinet,
        actor,
        'pixel_test.create',
        before_revision=cabinet.revision,
        after_revision=cabinet.revision,
        details={'session': str(session.pk), 'mode': mode, 'range': [start, end]},
    )

    return session, True


def _reserve_session(
    operation: CabinetOperation, session: LocateSession, actor: Any, duration: int
) -> None:
    """Reserve with CAS even on databases where row locks are ineffective."""
    claimed = CabinetOperation.objects.filter(
        pk=operation.pk,
        generation=operation.generation,
        current_session_id=operation.current_session_id,
    ).update(
        current_session=session,
        generation=operation.generation + 1,
        lease_owner=f'user:{getattr(actor, "pk", "anon")}',
        lease_expires_at=timezone.now() + timedelta(seconds=duration + 60),
        heartbeat_at=timezone.now(),
    )
    if not claimed:
        raise CabinetBusyError(
            _('Another operation reserved the cabinet'), code='cabinet_busy'
        )


def run_session(session: LocateSession) -> LocateSession:
    """Execute a queued session in its requested mode.

    Simulation never performs network I/O. Live execution fails closed unless a
    commissioned adapter is present and the cabinet is armed.
    """
    if session.mode == LocateMode.LIVE:
        return _run_live(session)

    return _run_simulated(session)


def execute_session(session_id: Any) -> LocateSession | None:
    """Execute a durable locate/test session (worker entry point).

    A session which is no longer queued is left untouched, so a duplicate or
    delayed task can never re-drive an operation that has already progressed.
    """
    session = LocateSession.objects.filter(pk=session_id).first()

    if session is None:
        return None

    # Claim with a conditional write, not a read-then-write: Q may deliver a
    # task twice, including to two workers at the same time.
    claimed = LocateSession.objects.filter(
        pk=session.pk, state=SessionState.QUEUED
    ).update(state=SessionState.PREFLIGHT)
    session.refresh_from_db()
    if not claimed:
        return session

    try:
        require_operate(session.actor)
        cabinet = Cabinet.objects.select_related('active_mapping').get(
            pk=session.cabinet_id
        )
        if not user_owns_cabinet(session.actor, cabinet):
            raise ForbiddenError(_('Target ownership changed'), code='forbidden')
        operation = CabinetOperation.objects.get(cabinet=cabinet)
        if operation.current_session_id != session.pk:
            raise CabinetBusyError(
                _('The session no longer owns the cabinet'), code='cabinet_busy'
            )
        if session.expires_at and session.expires_at <= timezone.now():
            raise StorageLayoutError(
                _('The queued session has expired'), code='session_expired'
            )
        if cabinet.revision != session.layout_revision or (
            cabinet.active_mapping is None
            or cabinet.active_mapping.content_hash != session.mapping_hash
        ):
            raise StaleRevisionError(
                _('The queued session layout or mapping changed'), code='stale'
            )
        if session.target_label != 'pixel-test':
            drawer, allocation, _snapshot = resolve_target(
                cabinet, session.target_kind, session.target_pk
            )
            plan = session.plan or {}
            if (
                str(drawer.pk) != plan.get('drawer')
                or allocation.logical_start != plan.get('logical_start')
                or allocation.logical_end != plan.get('logical_end')
            ):
                raise StorageLayoutError(
                    _('The target moved after the locate request'),
                    code='target_changed',
                )
        return run_session(session)
    except Exception as exc:
        session.refresh_from_db()
        # A failure before apply has no output to clear. Failures during apply
        # retain the adapter's durable failed/unknown result and reservation.
        if session.state == SessionState.PREFLIGHT:
            session.state = SessionState.FAILED
            session.failure = {
                'code': getattr(exc, 'code', 'preflight_failed'),
                'message': str(exc)[:500],
            }
            session.save()
            _release_reservation(session)
        return session


def _run_simulated(session: LocateSession) -> LocateSession:
    """Execute a session using the simulated transport."""
    transport = SimulatedTransport()
    plan = session.plan or {}
    controllers = list(plan.get('controllers') or [])

    session.state = SessionState.ACTIVE
    session.expires_at = timezone.now() + timedelta(
        seconds=int(plan.get('duration_seconds', 120))
    )
    session.save()

    for controller_id in controllers:
        controller = Controller.objects.filter(pk=controller_id).first()

        if controller is None:  # pragma: no cover - defensive
            continue

        transport.apply(controller, plan)

        ControllerExecution.objects.update_or_create(
            session=session,
            controller=controller,
            defaults={
                'generation': 1,
                'state': ExecutionState.ACTIVE,
                'last_step': 'simulated',
                'acknowledged_at': timezone.now(),
                'clear_status': ClearStatus.NOT_REQUIRED,
            },
        )

    return session


@contextmanager
def _cabinet_io_lock(session: LocateSession):
    """Serialize apply and clear across workers using a database write lock.

    An UPDATE acquires a write lock on SQLite too, unlike select_for_update.
    Keep this transaction bounded by the adapter's transport timeouts. Hardware
    failures must commit their unknown/failed progress before being re-raised.
    """
    failure = None
    with transaction.atomic():
        locked = CabinetOperation.objects.filter(
            cabinet_id=session.cabinet_id, current_session_id=session.pk
        ).update(heartbeat_at=timezone.now())
        if not locked:
            raise CabinetBusyError(
                _('The session no longer owns the cabinet'), code='cabinet_busy'
            )
        session.refresh_from_db()
        try:
            yield
        except Exception as exc:
            failure = exc
    if failure is not None:
        raise failure


def _run_live(session: LocateSession) -> LocateSession:
    """Serialize live output with stop and reconciliation from other workers."""
    with _cabinet_io_lock(session):
        if session.state not in (SessionState.QUEUED, SessionState.PREFLIGHT):
            return session
        if session.expires_at and session.expires_at <= timezone.now():
            session.state = SessionState.EXPIRED
            session.save()
            _release_reservation(session)
            return session
        return _apply_live(session)


def _apply_live(session: LocateSession) -> LocateSession:
    """Execute a live session safely, with durable progress and honest failure.

    The path fails closed: ``require_live_adapter`` and the per-controller arm
    check run before anything is written. A durable ``ControllerExecution`` row
    is persisted for every controller *before* its output can change, and the
    watchdog deadline is recorded before the first write. If any controller
    fails, every controller that may have been touched is cleared and the
    session is marked failed (cleanup confirmed) or unknown (cleanup
    unconfirmed); an unconfirmed clear keeps the cabinet reservation so no new
    operator can start against a controller that may still be lit. No code path
    reports an active or cleared state that the hardware did not acknowledge.
    """
    cabinet = session.cabinet
    adapter = require_live_adapter()
    require_live_dispatcher()

    controller_ids = list((session.plan or {}).get('controllers') or [])
    resolved: list[Controller] = []

    for controller_id in controller_ids:
        controller = Controller.objects.filter(pk=controller_id).first()

        if controller is None:
            raise NotFoundError(_('Controller not found'), code='not_found')

        _require_armed(cabinet, controller, session.mapping_hash)
        resolved.append(controller)

    if not resolved:
        # Never report an active success for a session with nothing to drive.
        session.failure = {
            'code': 'not_locatable',
            'message': 'The session plan did not reference any controller',
        }
        session.state = SessionState.FAILED
        session.save()
        _release_reservation(session)
        return session

    # Persist the watchdog deadline before any output change so an interrupted
    # process leaves a durable, reconcilable record.
    session.expires_at = timezone.now() + timedelta(
        seconds=int((session.plan or {}).get('duration_seconds', 120))
    )
    session.state = SessionState.APPLYING
    session.failure = {}
    session.save()

    executions: dict[Any, ControllerExecution] = {}

    for controller in resolved:
        execution, _created = ControllerExecution.objects.update_or_create(
            session=session,
            controller=controller,
            defaults={
                'generation': 1,
                'state': ExecutionState.PENDING,
                'last_step': 'preflight',
                'acknowledged_at': None,
                'clear_status': ClearStatus.PENDING,
                'error': {},
            },
        )
        executions[controller.pk] = execution

    touched: list[Controller] = []
    acknowledgements: dict[str, Any] = {}
    walking = session.plan.get('pattern') == 'walk'
    work = [(controller, session.plan) for controller in resolved]
    if walking:
        by_id = {str(controller.pk): controller for controller in resolved}
        work = [
            (
                by_id[frame['runs'][0]['controller']],
                {**session.plan, 'runs': frame['runs']},
            )
            for frame in session.plan.get('frames', [])
        ]
        if not work:
            raise StorageLayoutError(
                _('A walking test requires frames'), code='invalid_value'
            )
    started = time.monotonic()

    try:
        for index, (controller, frame_plan) in enumerate(work):
            if walking and timezone.now() >= session.expires_at:
                raise StorageLayoutError(
                    _('The walking test deadline elapsed'), code='session_expired'
                )
            execution = executions[controller.pk]
            execution.state = ExecutionState.APPLYING
            execution.last_step = 'applying'
            execution.save()

            # Record intent before the write: this controller may now be lit.
            if controller not in touched:
                touched.append(controller)

            acknowledgement = adapter.apply(controller, frame_plan)
            acknowledgements[str(controller.pk)] = _bounded_acknowledgement(
                acknowledgement
            )

            if acknowledgement.get('acknowledged', False):
                execution.state = ExecutionState.ACTIVE
                execution.last_step = 'applied'
                execution.clear_status = ClearStatus.PENDING
            else:
                execution.state = ExecutionState.CLEARED
                execution.last_step = 'no-runs'
                execution.clear_status = ClearStatus.NOT_REQUIRED

            execution.acknowledged_at = timezone.now()
            execution.error = {}
            execution.save()
            if walking:
                target = (index + 1) * session.plan['duration_seconds'] / len(work)
                time.sleep(max(0, target - (time.monotonic() - started)))
                cleared = adapter.clear(controller)
                if not getattr(cleared, 'confirmed', False):
                    raise StorageLayoutError(
                        _('A walking pixel did not confirm clear'),
                        code='clear_unconfirmed',
                    )
                execution.state = ExecutionState.CLEARED
                execution.clear_status = ClearStatus.CONFIRMED
                execution.last_step = f'walk:{index + 1}'
                execution.save()
    except Exception as exc:
        _fail_live_session(session, adapter, executions, touched, exc)
        raise translate_wled_error(exc) from exc

    session.plan = {**(session.plan or {}), 'acknowledgements': acknowledgements}
    session.state = SessionState.STOPPED if walking else SessionState.ACTIVE
    session.failure = {}
    session.save()
    if walking:
        _release_reservation(session)

    return session


def _bounded_acknowledgement(acknowledgement: Any) -> dict[str, Any]:
    """Return a bounded, JSON-safe summary of an adapter acknowledgement."""
    if not isinstance(acknowledgement, dict):
        return {}

    keys = (
        'acknowledged',
        'adapter_version',
        'origin',
        'controller',
        'led_count',
        'brightness',
        'duration_seconds',
        'nightlight_minutes',
        'chunks',
        'pixels',
        'intervals',
    )

    return {key: acknowledgement[key] for key in keys if key in acknowledgement}


def _release_reservation(session: LocateSession) -> None:
    """Release the cabinet reservation if this session still owns it."""
    CabinetOperation.objects.filter(
        cabinet=session.cabinet, current_session=session
    ).update(current_session=None, heartbeat_at=timezone.now())


def _fail_live_session(
    session: LocateSession,
    adapter: Any,
    executions: dict[Any, ControllerExecution],
    touched: list[Controller],
    error: Exception,
) -> None:
    """Stop every possibly-touched controller and persist an honest failure.

    Controllers that were never attempted have nothing to clear. Every touched
    controller is asked to clear; the session is ``failed`` only when every
    touched controller confirmed the clear by read-back. Otherwise it is
    ``unknown`` and keeps the reservation. This never reports a clear that the
    hardware did not acknowledge.
    """
    translated = translate_wled_error(error)
    touched_pks = {controller.pk for controller in touched}
    all_confirmed = True

    for pk, execution in executions.items():
        if pk in touched_pks and adapter is not None:
            try:
                result = adapter.clear(execution.controller)
            except Exception as clear_exc:
                result = None
                execution.error = {
                    'clear_error': 'Controller clear failed',
                    'code': translate_wled_error(clear_exc).code,
                }

            if result is not None and getattr(result, 'confirmed', False):
                execution.state = ExecutionState.CLEARED
                execution.clear_status = ClearStatus.CONFIRMED
                execution.error = {}
            else:
                execution.state = ExecutionState.UNKNOWN
                execution.clear_status = ClearStatus.UNCONFIRMED
                execution.error = (
                    result.as_dict()
                    if result is not None
                    else execution.error or {'error': 'clear failed'}
                )
                all_confirmed = False
        else:
            execution.state = ExecutionState.FAILED
            execution.clear_status = ClearStatus.NOT_REQUIRED

        execution.save()

    session.failure = {
        'code': translated.code,
        'message': translated.message,
        'errors': translated.errors,
    }

    if all_confirmed:
        session.state = SessionState.FAILED
        session.save()
        _release_reservation(session)
    else:
        session.state = SessionState.UNKNOWN
        session.save()


def _require_armed(cabinet: Cabinet, controller: Controller, mapping_hash: str) -> None:
    """Raise unless the controller is armed for the current mapping."""
    now = timezone.now()

    if (
        controller.armed_until is None
        or controller.armed_until < now
        or controller.armed_mapping_hash != mapping_hash
    ):
        raise NotArmedError(
            _('Controller %(name)s is not armed for this mapping')
            % {'name': controller.name},
            code='not_armed',
        )


def session_status(session: LocateSession) -> dict[str, Any]:
    """Return the persisted status of a locate session."""
    executions = [
        {
            'controller': str(execution.controller_id),
            'state': execution.state,
            'last_step': execution.last_step,
            'clear_status': execution.clear_status,
            'acknowledged_at': execution.acknowledged_at,
            'error': execution.error,
        }
        for execution in session.executions.all()
    ]

    return {
        'id': str(session.pk),
        'cabinet': str(session.cabinet_id),
        'state': session.state,
        'mode': session.mode,
        'target': {
            'kind': session.target_kind,
            'label': session.target_label,
            'pk': session.target_pk,
        },
        'mapping_hash': session.mapping_hash,
        'layout_revision': session.layout_revision,
        'profile': session.profile_snapshot,
        'plan': session.plan,
        'failure': session.failure,
        'executions': executions,
        'expires_at': session.expires_at,
        'created_at': session.created_at,
        'status_url': f'/plugin/{PLUGIN_SLUG}/api/v1/locate-sessions/{session.pk}/',
    }


def stop_session(session: LocateSession, actor: Any) -> LocateSession:
    """Idempotently stop a locate session and release its reservation.

    Simulation stops without any network I/O. A live stop drives the adapter's
    ``clear`` for every controller and only reports ``stopped`` when every
    controller confirmed the clear by read-back. An unconfirmed or ambiguous
    clear leaves the session ``unknown`` and keeps the cabinet reservation, so
    no new operator can start a session against a controller that may still be
    lit.
    """
    if session.state in TERMINAL_SESSION_STATES:
        return session

    if not (
        user_has_permission(actor, 'operate_hardware')
        or (session.actor_id and session.actor_id == getattr(actor, 'pk', None))
    ):
        raise ForbiddenError(
            _('You do not have permission to stop this session'), code='forbidden'
        )

    if session.mode == LocateMode.LIVE:
        return _stop_live(session, actor)

    return _stop_simulated(session, actor)


def _stop_simulated(session: LocateSession, actor: Any) -> LocateSession:
    """Stop a simulated session without any network I/O."""
    with transaction.atomic():
        session.state = SessionState.STOPPING
        session.save()

        for execution in session.executions.all():
            execution.state = ExecutionState.CLEARED
            execution.clear_status = ClearStatus.NOT_REQUIRED
            execution.error = {}
            execution.save()

        session.state = SessionState.STOPPED
        session.failure = {}
        session.save()

        _release_reservation(session)

    record_audit(
        session.cabinet,
        actor,
        'locate.stop',
        details={'session': str(session.pk), 'mode': session.mode},
    )

    return session


def _stop_live(session: LocateSession, actor: Any) -> LocateSession:
    """Serialize clear with apply; a delayed stop can never precede a write."""
    session.refresh_from_db()
    if session.state in TERMINAL_SESSION_STATES:
        return session
    try:
        with _cabinet_io_lock(session):
            return _clear_live(session, actor)
    except CabinetBusyError:
        # The watchdog may have completed the stop and released the reservation
        # after the refresh above but before this stop acquired the I/O lock.
        # Treat that race as idempotent only when this session is now terminal;
        # never clear hardware using a stale session after ownership changed.
        session.refresh_from_db()
        if session.state in TERMINAL_SESSION_STATES:
            return session
        raise


def _clear_live(session: LocateSession, actor: Any) -> LocateSession:
    """Stop a live session, confirming every planned controller by read-back."""
    adapter = build_live_adapter()
    # A worker may have died before recording execution rows. The immutable
    # plan, not the existence of progress rows, defines what must be cleared.
    for controller_id in (session.plan or {}).get('controllers', []):
        controller = Controller.objects.filter(
            pk=controller_id, cabinet=session.cabinet
        ).first()
        if controller is not None:
            ControllerExecution.objects.get_or_create(
                session=session,
                controller=controller,
                defaults={'generation': 1, 'state': ExecutionState.PENDING},
            )

    session.state = SessionState.STOPPING
    session.save()

    planned = set((session.plan or {}).get('controllers') or [])
    recorded = {
        str(pk) for pk in session.executions.values_list('controller_id', flat=True)
    }
    confirmed = bool(recorded) and planned.issubset(recorded)

    for execution in session.executions.all():
        controller = execution.controller
        result = None

        if adapter is not None:
            try:
                result = adapter.clear(controller)
            except Exception as exc:
                result = None
                execution.error = {'error': str(exc)}

        if result is not None and getattr(result, 'confirmed', False):
            execution.state = ExecutionState.CLEARED
            execution.clear_status = ClearStatus.CONFIRMED
            execution.error = {}
        else:
            execution.state = ExecutionState.UNKNOWN
            execution.clear_status = ClearStatus.UNCONFIRMED
            execution.error = (
                result.as_dict()
                if result is not None
                else execution.error or {'error': 'no adapter available'}
            )
            confirmed = False

        execution.save()

    if confirmed:
        session.state = SessionState.STOPPED
        session.failure = {}
        session.save()

        _release_reservation(session)
    else:
        session.state = SessionState.UNKNOWN
        session.failure = {
            'code': 'clear_unconfirmed',
            'message': 'One or more controllers did not confirm a clear',
        }
        session.save()

    record_audit(
        session.cabinet,
        actor,
        'locate.stop',
        details={
            'session': str(session.pk),
            'mode': session.mode,
            'clear_confirmed': confirmed,
        },
    )

    return session


def emergency_stop(cabinet: Cabinet, actor: Any) -> dict[str, Any]:
    """Perform an elevated cabinet emergency stop."""
    require_emergency_stop(actor)

    operation = CabinetOperation.objects.filter(cabinet=cabinet).first()
    stopped = None

    if operation is not None and operation.current_session_id:
        session = operation.current_session

        if session is not None and session.state not in TERMINAL_SESSION_STATES:
            stop_session(session, actor)
            stopped = str(session.pk)

    record_audit(cabinet, actor, 'cabinet.emergency_stop', details={'session': stopped})

    return {'cabinet': str(cabinet.pk), 'stopped_session': stopped}


# endregion


# region arm / disarm


def arm_cabinet(
    cabinet: Cabinet,
    actor: Any,
    controller_ids: list[Any],
    duration_minutes: int | None = None,
) -> dict[str, Any]:
    """Arm the listed controllers for a bounded period.

    Arm is a live-hardware action and therefore fails closed until a
    commissioned adapter is installed and hardware access is enabled.
    """
    require_operate(actor)

    adapter = require_live_adapter()

    mapping = cabinet.active_mapping

    if mapping is None:
        raise StorageLayoutError(
            _('The cabinet has no active mapping'), code='mapping_gap'
        )

    duration = duration_minutes or arm_duration_minutes()
    duration = max(1, min(int(duration), arm_duration_minutes()))

    controllers = []

    for raw_id in controller_ids:
        controller = Controller.objects.filter(
            pk=_as_uuid(raw_id, 'controller'), cabinet=cabinet
        ).first()

        if controller is None:
            raise NotFoundError(_('Controller not found'), code='not_found')

        if not controller.enabled:
            raise UnsupportedConfigurationError(
                _('Controller %(name)s is not enabled') % {'name': controller.name},
                code='unsupported_configuration',
            )

        snapshot = controller.approved_snapshot

        if snapshot is None:
            raise UnsupportedConfigurationError(
                _('Controller %(name)s has no approved configuration')
                % {'name': controller.name},
                code='unsupported_configuration',
            )

        if snapshot.capability_status != CapabilityStatus.SUPPORTED:
            raise UnsupportedConfigurationError(
                _('Controller %(name)s configuration is not supported')
                % {'name': controller.name},
                code='unsupported_configuration',
            )

        controllers.append(controller)

    # Explicit preflight reads under the operator's approval: arming is bound to
    # the configuration that is actually present, not only to a saved snapshot.
    # A changed fingerprint blocks arming rather than authorising a stale write.
    for controller in controllers:
        try:
            observation = adapter.observe(controller)
        except Exception as exc:
            raise translate_wled_error(exc) from exc

        if observation.get('capability_status') != CapabilityStatus.SUPPORTED:
            raise UnsupportedConfigurationError(
                _('Controller %(name)s configuration is not supported')
                % {'name': controller.name},
                code='unsupported_configuration',
            )

        if observation.get('fingerprint') != controller.approved_snapshot.fingerprint:
            raise ConfigDriftError(
                _(
                    'Controller %(name)s configuration has drifted from the '
                    'approved configuration'
                )
                % {'name': controller.name},
                code='config_drift',
            )

    armed_until = timezone.now() + timedelta(minutes=duration)

    for controller in controllers:
        controller.armed_until = armed_until
        controller.armed_by = (
            actor if getattr(actor, 'is_authenticated', False) else None
        )
        controller.armed_mapping_hash = mapping.content_hash
        controller.armed_config_hash = (
            controller.approved_snapshot.fingerprint
            if controller.approved_snapshot
            else ''
        )
        controller.save()

    record_audit(
        cabinet,
        actor,
        'cabinet.arm',
        details={
            'controllers': [str(c.pk) for c in controllers],
            'armed_until': armed_until.isoformat(),
            'adapter': getattr(adapter, '__name__', 'adapter'),
        },
    )

    return {
        'cabinet': str(cabinet.pk),
        'armed_until': armed_until,
        'controllers': [str(c.pk) for c in controllers],
    }


def disarm_cabinet(cabinet: Cabinet, actor: Any) -> dict[str, Any]:
    """Disarm every controller on a cabinet and stop any active session."""
    require_operate(actor)

    operation = CabinetOperation.objects.filter(cabinet=cabinet).first()

    if operation is not None and operation.current_session_id:
        session = operation.current_session

        if session is not None and session.state not in TERMINAL_SESSION_STATES:
            stop_session(session, actor)

    Controller.objects.filter(cabinet=cabinet).update(
        armed_until=None, armed_mapping_hash='', armed_config_hash=''
    )

    record_audit(cabinet, actor, 'cabinet.disarm', details={})

    return {'cabinet': str(cabinet.pk), 'armed_until': None}


# endregion


# region read jobs


def fixture_observation(controller: Controller) -> dict[str, Any]:
    """Build a simulated observation from the saved electrical topology.

    The topology fingerprint is computed with the adapter's
    :func:`storage_layout.wled.topology_fingerprint`, so an equivalent topology
    hashes equally whether it came from the fixture or from a live read. The
    full adapter ``config_fingerprint`` additionally covers device identity, so
    a fixture-approved fingerprint never matches a live observation and live
    execution therefore fails closed.
    """
    outputs = []
    total = 0
    supported = True
    reasons: list[str] = []

    for output in controller.outputs.all().order_by('bus_index', 'id'):
        total += output.pixel_count
        outputs.append({
            'bus_index': output.bus_index,
            'wled_start': output.wled_start,
            'pixel_count': output.pixel_count,
            'pins': output.pins,
            'led_type': output.led_type,
            'colour_order': output.colour_order,
            'bus_reverse': output.bus_reverse,
            'skip': output.skip,
        })

        if output.bus_reverse:
            supported = False
            reasons.append('bus_reverse')

        if output.skip:
            supported = False
            reasons.append('skip')

    normalised = {'outputs': outputs}

    try:
        from storage_layout.wled import topology_fingerprint

        fingerprint = topology_fingerprint(normalised)
    except ImportError:  # pragma: no cover - adapter always present
        fingerprint = _canonical_hash(normalised)

    return {
        'adapter_version': controller.firmware_adapter,
        'info': {'name': controller.name, 'leds': {'count': total}},
        'normalised_config': normalised,
        'fingerprint': fingerprint,
        'capability_status': (
            CapabilityStatus.SUPPORTED if supported else CapabilityStatus.UNSUPPORTED
        ),
        'capability_reasons': reasons,
        'runtime': {'live': False},
    }


def _perform_observe(
    controller: Controller, actor: Any, mode: str
) -> tuple[ConfigObservation, dict[str, Any]]:
    """Perform a controller observation and store the redacted observation."""
    if mode == LocateMode.LIVE:
        adapter = require_live_adapter()

        try:
            raw = adapter.observe(controller)
        except Exception as exc:
            raise translate_wled_error(exc) from exc
    else:
        raw = fixture_observation(controller)

    diff = raw.get('diff')

    if not diff:
        diff = {
            'capability_reasons': raw.get('capability_reasons', []),
            'runtime': raw.get('runtime', {}),
        }

    observation = ConfigObservation.objects.create(
        controller=controller,
        observed_at=timezone.now(),
        adapter_version=raw.get('adapter_version', controller.firmware_adapter),
        info=raw.get('info', {}),
        normalised_config=raw.get('normalised_config', {}),
        fingerprint=raw.get('fingerprint', ''),
        capability_status=raw.get('capability_status', CapabilityStatus.UNVERIFIED),
        diff=diff,
        observed_by=actor if getattr(actor, 'is_authenticated', False) else None,
    )

    if mode == LocateMode.LIVE:
        controller.last_seen = observation.observed_at
        controller.status = ControllerStatus.ONLINE
        controller.save()

    result = {
        'observation': str(observation.pk),
        'fingerprint': observation.fingerprint,
        'capability_status': observation.capability_status,
    }

    return observation, result


def create_observe_job(
    controller: Controller, actor: Any, mode: str = LocateMode.SIMULATE
) -> HardwareReadJob:
    """Create a durable observe job and dispatch it on commit.

    The job row is committed before the worker can observe it, so an enqueue
    failure is persisted rather than losing the request.
    """
    require_operate(actor)

    if mode == LocateMode.LIVE:
        require_live_adapter()

    if not queue_available():
        raise QueueUnavailableError(
            _('The background task queue is unavailable'), code='queue_unavailable'
        )

    with transaction.atomic():
        job = HardwareReadJob.objects.create(
            cabinet=controller.cabinet,
            actor=actor if getattr(actor, 'is_authenticated', False) else None,
            kind=ReadJobKind.OBSERVE,
            controller=controller,
            mode=mode,
            state=JobState.PENDING,
            scope_snapshot={'controller': str(controller.pk)},
            expires_at=timezone.now() + timedelta(minutes=5),
        )

        transaction.on_commit(lambda: dispatch_read_job(job.pk))

    return job


def create_discovery_job(
    actor: Any, cabinet: Cabinet | None, mode: str, scope: dict[str, Any]
) -> HardwareReadJob:
    """Create a durable discovery job and dispatch it on commit."""
    require_operate(actor)

    if mode == LocateMode.LIVE:
        require_live_adapter()

    if not queue_available():
        raise QueueUnavailableError(
            _('The background task queue is unavailable'), code='queue_unavailable'
        )

    with transaction.atomic():
        job = HardwareReadJob.objects.create(
            cabinet=cabinet,
            actor=actor if getattr(actor, 'is_authenticated', False) else None,
            kind=ReadJobKind.DISCOVERY,
            mode=mode,
            scope_snapshot=scope or {},
            expires_at=timezone.now() + timedelta(minutes=5),
            state=JobState.PENDING,
        )

        transaction.on_commit(lambda: dispatch_read_job(job.pk))

    return job


def execute_read_job(job_id: Any) -> HardwareReadJob | None:
    """Execute a durable hardware read job (worker entry point).

    Progress and the redacted result are persisted on the job; a failure is
    recorded as a failed job rather than raised into the worker.
    """
    job = HardwareReadJob.objects.filter(pk=job_id).first()

    if job is None:
        return None

    claimed = HardwareReadJob.objects.filter(pk=job.pk, state=JobState.PENDING).update(
        state=JobState.RUNNING
    )
    job.refresh_from_db()
    if not claimed:
        return job

    try:
        require_operate(job.actor)
        if job.cabinet_id and not user_owns_cabinet(job.actor, job.cabinet):
            raise ForbiddenError(_('Target ownership changed'), code='forbidden')
        if job.expires_at and job.expires_at <= timezone.now():
            raise StorageLayoutError(
                _('The read grant has expired'), code='session_expired'
            )
        if job.kind == ReadJobKind.OBSERVE:
            if job.controller is None:
                raise NotFoundError(_('Controller not found'), code='not_found')

            observation, result = _perform_observe(job.controller, job.actor, job.mode)
            job.result = result

            record_audit(
                job.cabinet,
                job.actor,
                'controller.observe',
                details={
                    'controller': str(job.controller_id),
                    'observation': str(observation.pk),
                },
            )
        else:
            # Bounded explicit discovery of registered origins, never a subnet
            # scan. The adapter independently checks the network allowlist.
            candidates = Controller.objects.select_related('cabinet').filter(
                enabled=True
            )
            if job.cabinet_id:
                candidates = candidates.filter(cabinet=job.cabinet)
            requested = (job.scope_snapshot or {}).get('controllers')
            if requested is not None:
                if not isinstance(requested, list) or len(requested) > 5:
                    raise StorageLayoutError(
                        _('Discovery requires at most five controller IDs'),
                        code='invalid_value',
                    )
                candidates = candidates.filter(
                    pk__in=[_as_uuid(pk, 'controllers') for pk in requested]
                )
            elif job.mode == LocateMode.LIVE:
                raise StorageLayoutError(
                    _('Live discovery requires explicit controller IDs'),
                    code='approval_required',
                )
            results = []
            for controller in candidates[:100]:
                if not user_owns_cabinet(job.actor, controller.cabinet):
                    continue
                raw = (
                    require_live_adapter().observe(controller)
                    if job.mode == LocateMode.LIVE
                    else fixture_observation(controller)
                )
                results.append({
                    'controller': str(controller.pk),
                    'origin': controller.origin,
                    'info': raw.get('info', {}),
                    'fingerprint': raw.get('fingerprint', ''),
                    'capability_status': raw.get('capability_status', 'unverified'),
                    'simulated': job.mode == LocateMode.SIMULATE,
                })
            job.result = {
                'candidates': results,
                'mode': job.mode,
                'method': 'registered-origins',
            }

            record_audit(
                job.cabinet,
                job.actor,
                'discovery.run',
                details={'job': str(job.pk), 'mode': job.mode},
            )

        job.state = JobState.COMPLETE
        job.error = {}
    except Exception as exc:
        translated = translate_wled_error(exc)
        job.state = JobState.FAILED
        job.error = {'code': translated.code, 'message': translated.message}

    job.save()

    return job


def import_preview(controller: Controller, observation_id: Any) -> dict[str, Any]:
    """Return the database-only diff proposed by an observation."""
    observation = ConfigObservation.objects.filter(
        pk=_as_uuid(observation_id, 'observation'), controller=controller
    ).first()

    if observation is None:
        raise NotFoundError(_('Observation not found'), code='not_found')

    saved = {output.bus_index: output for output in controller.outputs.all()}
    proposed = observation.normalised_config.get('outputs', [])

    added = []
    changed = []
    removed = [
        str(output.pk)
        for index, output in saved.items()
        if index not in {int(entry.get('bus_index', -1)) for entry in proposed}
    ]

    for entry in proposed:
        bus_index = int(entry.get('bus_index', -1))
        existing = saved.get(bus_index)

        if existing is None:
            added.append(entry)
            continue

        diff = {}

        for key in (
            'wled_start',
            'pixel_count',
            'pins',
            'led_type',
            'colour_order',
            'bus_reverse',
            'skip',
        ):
            if getattr(existing, key) != entry.get(key):
                diff[key] = {'from': getattr(existing, key), 'to': entry.get(key)}

        if diff:
            changed.append({
                'output': str(existing.pk),
                'bus_index': bus_index,
                'diff': diff,
            })

    diff_hash = _canonical_hash({
        'added': added,
        'changed': changed,
        'removed': removed,
    })

    return {
        'observation': str(observation.pk),
        'fingerprint': observation.fingerprint,
        'capability_status': observation.capability_status,
        'diff_hash': diff_hash,
        'added': added,
        'changed': changed,
        'removed': removed,
    }


def import_configuration(
    controller: Controller,
    actor: Any,
    observation_id: Any,
    accepted_diff_hash: str,
    expected_revision: int,
) -> dict[str, Any]:
    """Apply an observation's proposal to the saved configuration (database only)."""
    require_configure(actor)

    cabinet = controller.cabinet

    if not cabinet_is_idle(cabinet):
        raise CabinetBusyError(
            _('The cabinet has an active operation'), code='cabinet_busy'
        )

    preview = import_preview(controller, observation_id)

    if accepted_diff_hash and accepted_diff_hash != preview['diff_hash']:
        raise ConfigDriftError(
            _('The accepted diff hash does not match the current proposal'),
            code='config_drift',
        )

    observation = ConfigObservation.objects.get(pk=preview['observation'])
    before = cabinet.revision

    with transaction.atomic():
        cas_update_cabinet(cabinet, expected_revision)

        for entry in observation.normalised_config.get('outputs', []):
            bus_index = int(entry.get('bus_index', -1))
            output = controller.outputs.filter(bus_index=bus_index).first()

            if output is None:
                continue

            output.wled_start = int(entry.get('wled_start', output.wled_start))
            output.pixel_count = int(entry.get('pixel_count', output.pixel_count))
            output.pins = entry.get('pins', output.pins)
            output.led_type = entry.get('led_type', output.led_type)
            output.colour_order = entry.get('colour_order', output.colour_order)
            output.bus_reverse = bool(entry.get('bus_reverse', output.bus_reverse))
            output.skip = int(entry.get('skip', output.skip))
            output.save()

    record_audit(
        cabinet,
        actor,
        'controller.import',
        before_revision=before,
        after_revision=cabinet.revision,
        details={'controller': str(controller.pk), 'observation': str(observation.pk)},
    )

    return {
        'controller': str(controller.pk),
        'revision': cabinet.revision,
        'diff_hash': preview['diff_hash'],
    }


def approve_configuration(
    controller: Controller,
    actor: Any,
    observation_id: Any,
    mapping_hash_value: str = '',
    checks: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Mark an observation as the approved expected configuration."""
    require_configure(actor)

    observation = ConfigObservation.objects.filter(
        pk=_as_uuid(observation_id, 'observation'), controller=controller
    ).first()

    if observation is None:
        raise NotFoundError(_('Observation not found'), code='not_found')

    if observation.capability_status != CapabilityStatus.SUPPORTED:
        raise UnsupportedConfigurationError(
            _('The observation is not a supported configuration'),
            code='unsupported_configuration',
        )

    cabinet = controller.cabinet
    mapping = cabinet.active_mapping

    if (
        mapping_hash_value
        and mapping is not None
        and mapping_hash_value != mapping.content_hash
    ):
        raise StaleRevisionError(_('The supplied mapping hash is stale'), code='stale')

    controller.approved_snapshot = observation
    controller.save()

    record_audit(
        cabinet,
        actor,
        'controller.approve_configuration',
        details={
            'controller': str(controller.pk),
            'observation': str(observation.pk),
            'checks': checks or {},
        },
    )

    return {
        'controller': str(controller.pk),
        'observation': str(observation.pk),
        'fingerprint': observation.fingerprint,
    }


# endregion


# region diagnostics


def cabinet_diagnostics(cabinet: Cabinet) -> dict[str, Any]:
    """Return the full validation diagnostics for a saved cabinet."""
    report = v.validate_cabinet_layout(cabinet)
    mapping = cabinet.active_mapping

    return {
        'valid': report.valid,
        'errors': [issue.as_dict() for issue in report.errors],
        'warnings': [issue.as_dict() for issue in report.warnings],
        'unused_ranges': [list(r) for r in report.unused_ranges],
        'total_pixels': mapping.total_pixels if mapping is not None else 0,
        'mapping_hash': mapping.content_hash if mapping is not None else '',
        'numbering_base': 1,
    }


# endregion


# region reconciliation


def prune_old_audits() -> int:
    """Apply retention without removing unresolved-operation evidence."""
    try:
        days = int(plugin_setting('AUDIT_RETENTION_DAYS', 90))
    except (TypeError, ValueError):
        return 0
    if days <= 0:
        return 0
    unresolved = CabinetOperation.objects.filter(
        current_session__state__in=ACTIVE_SESSION_STATES
    ).values_list('cabinet_id', flat=True)
    expired = DesignAudit.objects.filter(
        created_at__lt=timezone.now() - timedelta(days=days)
    ).exclude(cabinet_id__in=unresolved)
    count, _details = expired.delete()
    return count


def reconcile_operations(now: Any = None) -> dict[str, Any]:
    """Reconcile expired sessions, expired arms and stale reservations.

    This is the scheduled watchdog sweep. It is internal safety work: it runs
    without an actor and never reports a clear that was not confirmed.

    Single-writer safety: the watchdog only performs a live hardware clear when
    an explicit dispatcher is configured (``DISPATCHER_ENABLED``). Without that
    gate the watchdog must not become a second hardware writer, so an expired
    live session is marked ``unknown`` and keeps its cabinet reservation for
    operator intervention rather than being cleared by an unconfirmed process.
    """
    now = now or timezone.now()

    expired_sessions = 0
    live_cleanups = 0
    live_deferred = 0

    stale = LocateSession.objects.filter(state__in=ACTIVE_SESSION_STATES).filter(
        Q(expires_at__lt=now)
        | Q(expires_at__isnull=True, cabinet__operation__lease_expires_at__lt=now)
    )

    for session in stale:
        if session.mode == LocateMode.SIMULATE:
            _stop_simulated(session, None)
            session.state = SessionState.EXPIRED
            session.save()
            expired_sessions += 1
        elif dispatcher_enabled():
            _stop_live(session, None)
            live_cleanups += 1
        else:
            # No confirmed dispatcher: never touch hardware from the watchdog.
            session.state = SessionState.UNKNOWN
            session.failure = {
                'code': 'clear_unconfirmed',
                'message': (
                    'The session expired without a confirmed dispatcher; '
                    'hardware state is unknown and the reservation is retained'
                ),
            }
            session.save()
            live_deferred += 1

    Controller.objects.filter(armed_until__lt=now).update(
        armed_until=None, armed_mapping_hash='', armed_config_hash=''
    )

    return {
        'expired_sessions': expired_sessions,
        'live_cleanups': live_cleanups,
        'live_deferred': live_deferred,
        'reconciled_at': now,
    }


# endregion
