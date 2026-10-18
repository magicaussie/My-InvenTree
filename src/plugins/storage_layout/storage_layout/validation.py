"""Authoritative validation for the Storage Layout plugin.

This module is the single source of truth for cross-row and cross-model
validation: geometry containment and overlap, interval coverage, native
location binding rules, controller/output/string consistency and profile
limits. It is called from model ``clean()`` methods, from serializers and from
command execution - it is never duplicated.

Row-local numeric bounds, enum membership and ``end >= start`` are enforced by
database constraints in :mod:`storage_layout.models`; this module deliberately
does **not** re-implement them as SQL.

The validators operate on plain data (mappings or objects) so that they can be
exercised without a database, and are wrapped by a small number of DB-backed
helpers for use from model ``clean()`` methods.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

# region error codes

CODE_GEOMETRY_OVERLAP = 'geometry_overlap'
CODE_BINDING_INVALID = 'binding_invalid'
CODE_MAPPING_GAP = 'mapping_gap'
CODE_PHYSICAL_OVERLAP = 'physical_overlap'
CODE_ALLOCATION_OVERLAP = 'allocation_overlap'
CODE_CONFIG_DRIFT = 'config_drift'
CODE_UNSUPPORTED_CONFIGURATION = 'unsupported_configuration'
CODE_NOT_ARMED = 'not_armed'
CODE_CABINET_BUSY = 'cabinet_busy'
CODE_CONTROLLER_TIMEOUT = 'controller_timeout'
CODE_CLEAR_UNCONFIRMED = 'clear_unconfirmed'
CODE_INVALID_BOUNDS = 'invalid_bounds'
CODE_DUPLICATE_IDENTITY = 'duplicate_identity'
CODE_GPIO_CONFLICT = 'gpio_conflict'
CODE_NOT_LOCATABLE = 'not_locatable'
CODE_STALE = 'stale'

SEVERITY_ERROR = 'error'
SEVERITY_WARNING = 'warning'

# endregion

# region report structures


@dataclass
class ValidationIssue:
    """A single validation finding."""

    code: str
    message: str
    path: str = ''
    related_ids: list[str] = field(default_factory=list)
    severity: str = SEVERITY_ERROR

    def as_dict(self) -> dict[str, Any]:
        """Return the issue in the documented API error shape."""
        return {
            'path': self.path,
            'code': self.code,
            'message': str(self.message),
            'related_ids': list(self.related_ids),
        }


@dataclass
class ValidationReport:
    """A collection of validation errors, warnings and unused ranges."""

    errors: list[ValidationIssue] = field(default_factory=list)
    warnings: list[ValidationIssue] = field(default_factory=list)
    unused_ranges: list[tuple[int, int]] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        """Return True when no blocking errors were recorded."""
        return not self.errors

    def add_error(
        self,
        code: str,
        message: str,
        path: str = '',
        related_ids: Iterable[Any] | None = None,
    ) -> ValidationIssue:
        """Record a blocking error."""
        issue = ValidationIssue(
            code=code,
            message=message,
            path=path,
            related_ids=[str(i) for i in (related_ids or [])],
            severity=SEVERITY_ERROR,
        )
        self.errors.append(issue)
        return issue

    def add_warning(
        self,
        code: str,
        message: str,
        path: str = '',
        related_ids: Iterable[Any] | None = None,
    ) -> ValidationIssue:
        """Record a non-blocking warning."""
        issue = ValidationIssue(
            code=code,
            message=message,
            path=path,
            related_ids=[str(i) for i in (related_ids or [])],
            severity=SEVERITY_WARNING,
        )
        self.warnings.append(issue)
        return issue

    def extend(self, other: ValidationReport) -> ValidationReport:
        """Merge another report into this one."""
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)
        self.unused_ranges.extend(other.unused_ranges)
        return self

    def as_dict(self) -> dict[str, Any]:
        """Return the report in the documented API error shape."""
        return {
            'errors': [issue.as_dict() for issue in self.errors],
            'warnings': [issue.as_dict() for issue in self.warnings],
            'unused_ranges': [list(r) for r in self.unused_ranges],
        }


def raise_for_report(report: ValidationReport) -> None:
    """Raise a ``ValidationError`` when a report contains blocking errors."""
    if report.valid:
        return

    raise ValidationError([
        f'[{issue.code}] {issue.path}: {issue.message}'.strip()
        for issue in report.errors
    ])


# endregion

# region accessors


def _value(obj: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from a mapping or an object."""
    if obj is None:
        return default

    if isinstance(obj, Mapping):
        return obj.get(name, default)

    return getattr(obj, name, default)


def _resolve(obj: Any, path: str, default: Any = None) -> Any:
    """Resolve a dotted attribute path against a mapping or object."""
    current = obj

    for part in path.split('.'):
        current = _value(current, part, None)

        if current is None:
            return default

    return current


def _identity(obj: Any) -> str:
    """Return a stable string identity for a row-like object."""
    value = _value(obj, 'id', None)

    if value is None:
        value = _value(obj, 'pk', None)

    return str(value) if value is not None else ''


def _rect(obj: Any) -> tuple[int, int, int, int]:
    """Return the ``(x, y, width, height)`` rectangle of a row-like object."""
    return (
        int(_value(obj, 'x', 0) or 0),
        int(_value(obj, 'y', 0) or 0),
        int(_value(obj, 'width', 0) or 0),
        int(_value(obj, 'height', 0) or 0),
    )


def _is_archived(obj: Any) -> bool:
    """Return True when a row-like object is archived."""
    return bool(_value(obj, 'archived', False))


# endregion

# region geometry primitives


def rectangle_area(rect: Sequence[int]) -> int:
    """Return the area of a half-open rectangle."""
    _, _, width, height = rect
    return max(int(width), 0) * max(int(height), 0)


def rectangles_overlap(a: Sequence[int], b: Sequence[int]) -> bool:
    """Return True when two half-open rectangles overlap by positive area.

    Rectangles are ``[x, x+w) x [y, y+h)``, so rectangles which merely touch
    along an edge do **not** overlap.
    """
    ax, ay, aw, ah = (int(v) for v in a)
    bx, by, bw, bh = (int(v) for v in b)

    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


def rectangle_within(inner: Sequence[int], outer: Sequence[int]) -> bool:
    """Return True when ``inner`` lies entirely inside ``outer``."""
    ix, iy, iw, ih = (int(v) for v in inner)
    ox, oy, ow, oh = (int(v) for v in outer)

    return ix >= ox and iy >= oy and ix + iw <= ox + ow and iy + ih <= oy + oh


def intervals_overlap(a: Sequence[int], b: Sequence[int]) -> bool:
    """Return True when two half-open integer intervals overlap."""
    a_start, a_end = int(a[0]), int(a[1])
    b_start, b_end = int(b[0]), int(b[1])

    return a_start < b_end and b_start < a_end


def compute_unused_ranges(
    intervals: Iterable[Sequence[int]], total: int
) -> list[tuple[int, int]]:
    """Return inclusive unused ranges within ``1..total``.

    ``intervals`` are inclusive ``(start, end)`` pairs. Overlapping or
    out-of-order intervals are tolerated; the result is normalised.
    """
    if total < 1:
        return []

    merged: list[list[int]] = []

    for start, end in sorted((int(i[0]), int(i[1])) for i in intervals):
        if start > end:
            continue

        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    unused: list[tuple[int, int]] = []
    cursor = 1

    for start, end in merged:
        if start > cursor:
            unused.append((cursor, start - 1))

        cursor = max(cursor, end + 1)

    if cursor <= total:
        unused.append((cursor, total))

    return unused


# endregion

# region origin / profile validation


def validate_canonical_origin(value: str) -> str:
    """Return the canonical ``scheme://host[:port]`` origin for a controller.

    Rejects anything which is not a bare HTTP(S) origin: userinfo, path,
    query, fragment, unsupported schemes and invalid ports are all refused.
    This is the SSRF boundary described in the design, so it is deliberately
    strict.

    Args:
        value: The candidate origin string.

    Returns:
        The canonical origin string.

    Raises:
        ValidationError: If the value is not a valid canonical origin.
    """
    if not value or not str(value).strip():
        raise ValidationError(_('A controller origin is required'))

    try:
        parts = urlsplit(str(value).strip())
        port = parts.port
    except ValueError as exc:
        raise ValidationError(
            _('Invalid controller origin: %(error)s') % {'error': exc}
        ) from exc

    if parts.scheme not in ('http', 'https'):
        raise ValidationError(_('Controller origin must use the http or https scheme'))

    if not parts.hostname:
        raise ValidationError(_('Controller origin must include a host'))

    if parts.username or parts.password:
        raise ValidationError(_('Controller origin must not include user information'))

    if parts.path not in ('', '/') or parts.query or parts.fragment:
        raise ValidationError(
            _('Controller origin must not include a path, query or fragment')
        )

    host = parts.hostname.lower()

    if ':' in host:
        host = f'[{host}]'

    if (
        port is None
        or (parts.scheme == 'http' and port == 80)
        or (parts.scheme == 'https' and port == 443)
    ):
        return f'{parts.scheme}://{host}'

    return f'{parts.scheme}://{host}:{port}'


def validate_profile_duration(purpose: str, duration_seconds: int) -> int:
    """Validate a profile duration against its purpose-specific limit.

    Locate profiles are capped at 120 seconds; test profiles at 10 seconds.

    Args:
        purpose: The profile purpose (``locate`` / ``test`` / ``reserved``).
        duration_seconds: The proposed duration.

    Returns:
        The validated duration.

    Raises:
        ValidationError: If the duration is outside the permitted range.
    """
    duration = int(duration_seconds)

    if duration < 1:
        raise ValidationError(_('Duration must be at least 1 second'))

    maximum = 10 if purpose == 'test' else 120

    if duration > maximum:
        raise ValidationError(
            _('Duration must not exceed %(maximum)s seconds for this purpose')
            % {'maximum': maximum}
        )

    return duration


# endregion

# region geometry validators


def validate_drawer_geometry(
    cabinet_width: int,
    cabinet_height: int,
    drawers: Iterable[Any],
    report: ValidationReport | None = None,
    include_archived: bool = False,
    retained: Iterable[Any] | None = None,
) -> ValidationReport:
    """Validate drawer front-face rectangles and identities.

    Checks positive dimensions, containment within the cabinet and
    non-overlap between peers. Archived drawers are excluded from the geometry
    checks by default, but always participate in the identity checks: the
    cabinet-scoped unique constraints on ``label`` and ``display_number`` apply
    to archived rows too. ``retained`` rows are persisted drawers which are not
    part of the proposal but still occupy those constraints (for example rows
    omitted from a partial document).

    Args:
        cabinet_width: Cabinet width in grid units.
        cabinet_height: Cabinet height in grid units.
        drawers: Drawer-like rows (mapping or object).
        report: Optional report to append to.
        include_archived: Include archived drawers in the geometry checks.
        retained: Persisted drawers which are not part of the proposal.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    cabinet = (0, 0, int(cabinet_width), int(cabinet_height))
    rows = list(drawers)

    active = [d for d in rows if include_archived or not _is_archived(d)]

    for drawer in active:
        rect = _rect(drawer)
        path = f'drawers[{_identity(drawer)}]'

        if rect[2] < 1 or rect[3] < 1:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Drawer width and height must be positive'),
                path=path,
                related_ids=[_identity(drawer)],
            )
            continue

        if not rectangle_within(rect, cabinet):
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Drawer rectangle must lie inside the cabinet'),
                path=path,
                related_ids=[_identity(drawer)],
            )

    for index, first in enumerate(active):
        for second in active[index + 1 :]:
            if rectangles_overlap(_rect(first), _rect(second)):
                report.add_error(
                    CODE_GEOMETRY_OVERLAP,
                    _('Drawer rectangles must not overlap'),
                    path=f'drawers[{_identity(first)}]',
                    related_ids=[_identity(first), _identity(second)],
                )

    _validate_unique_display_numbers(rows, report, retained=retained)
    _validate_unique_drawer_labels(rows, report, retained=retained)

    return report


def _validate_unique_values(
    rows: Sequence[Any],
    report: ValidationReport,
    *,
    field: str,
    code: str,
    message: str,
    path_prefix: str,
    retained: Iterable[Any] | None = None,
    coerce: Callable[[Any], Any] | None = None,
) -> None:
    """Report duplicate values of ``field`` across proposed and retained rows.

    ``retained`` rows are persisted rows which are not part of the proposal but
    still occupy the same unique constraint (archived rows, or rows omitted from
    a partial document). They seed the seen-set so a proposal cannot silently
    collide with them.
    """
    seen: dict[Any, str] = {}

    def key(value: Any) -> Any:
        return coerce(value) if coerce is not None else value

    for row in retained or []:
        value = _value(row, field, None)

        if value is None:
            continue

        seen.setdefault(key(value), _identity(row))

    for row in rows:
        value = _value(row, field, None)

        if value is None:
            continue

        value = key(value)
        identity = _identity(row)

        if value in seen:
            report.add_error(
                code,
                message,
                path=f'{path_prefix}[{identity}]',
                related_ids=[seen[value], identity],
            )
        else:
            seen[value] = identity


def _validate_unique_display_numbers(
    drawers: Sequence[Any],
    report: ValidationReport,
    retained: Iterable[Any] | None = None,
) -> None:
    """Report duplicate drawer display numbers within a cabinet."""
    _validate_unique_values(
        drawers,
        report,
        field='display_number',
        code=CODE_DUPLICATE_IDENTITY,
        message=_('Drawer display numbers must be unique within a cabinet'),
        path_prefix='drawers',
        retained=retained,
        coerce=int,
    )


def _validate_unique_drawer_labels(
    drawers: Sequence[Any],
    report: ValidationReport,
    retained: Iterable[Any] | None = None,
) -> None:
    """Report duplicate drawer labels within a cabinet."""
    _validate_unique_values(
        drawers,
        report,
        field='label',
        code=CODE_DUPLICATE_IDENTITY,
        message=_('Drawer labels must be unique within a cabinet'),
        path_prefix='drawers',
        retained=retained,
    )


def validate_bin_geometry(
    interior_width: int,
    interior_height: int,
    bins: Iterable[Any],
    report: ValidationReport | None = None,
    include_archived: bool = False,
    retained: Iterable[Any] | None = None,
) -> ValidationReport:
    """Validate bin rectangles and labels against the drawer interior plane.

    Archived bins are excluded from the geometry checks by default, but always
    participate in the label check: the drawer-scoped unique constraint on
    ``label`` applies to archived rows too. ``retained`` rows are persisted bins
    in the same drawer which are not part of the proposal but still occupy that
    constraint.

    Args:
        interior_width: Drawer interior width in grid units.
        interior_height: Drawer interior height (depth) in grid units.
        bins: Bin-like rows (mapping or object).
        report: Optional report to append to.
        include_archived: Include archived bins in the geometry checks.
        retained: Persisted bins in the same drawer which are not proposed.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    interior = (0, 0, int(interior_width), int(interior_height))
    rows = list(bins)

    active = [b for b in rows if include_archived or not _is_archived(b)]

    for bin_row in active:
        rect = _rect(bin_row)
        path = f'bins[{_identity(bin_row)}]'

        if rect[2] < 1 or rect[3] < 1:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Bin width and height must be positive'),
                path=path,
                related_ids=[_identity(bin_row)],
            )
            continue

        if not rectangle_within(rect, interior):
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Bin rectangle must lie inside the drawer interior'),
                path=path,
                related_ids=[_identity(bin_row)],
            )

    for index, first in enumerate(active):
        for second in active[index + 1 :]:
            if rectangles_overlap(_rect(first), _rect(second)):
                report.add_error(
                    CODE_GEOMETRY_OVERLAP,
                    _('Bin rectangles must not overlap'),
                    path=f'bins[{_identity(first)}]',
                    related_ids=[_identity(first), _identity(second)],
                )

    _validate_unique_bin_labels(rows, report, retained=retained)

    return report


def _validate_unique_bin_labels(
    bins: Sequence[Any], report: ValidationReport, retained: Iterable[Any] | None = None
) -> None:
    """Report duplicate bin labels within a drawer."""
    _validate_unique_values(
        bins,
        report,
        field='label',
        code=CODE_DUPLICATE_IDENTITY,
        message=_('Bin labels must be unique within a drawer'),
        path_prefix='bins',
        retained=retained,
    )


# endregion

# region allocation / mapping validators


def validate_allocations(
    allocations: Iterable[Any],
    total_pixels: int,
    report: ValidationReport | None = None,
) -> ValidationReport:
    """Validate drawer allocations against the active mapping size.

    Checks positive bounds, ``end >= start``, containment within ``1..N`` and
    non-overlap between allocations. Unused logical pixels are reported as
    warnings, not errors.

    Args:
        allocations: Allocation-like rows (mapping or object).
        total_pixels: ``N`` of the active mapping (0 when there is no map).
        report: Optional report to append to.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    rows = list(allocations)
    intervals: list[tuple[int, int]] = []

    for allocation in rows:
        start = int(_value(allocation, 'logical_start', 0) or 0)
        end = int(_value(allocation, 'logical_end', 0) or 0)
        identity = _identity(allocation)
        path = f'allocations[{identity}]'

        if start < 1 or end < 1 or end < start:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Allocation must satisfy 1 <= start <= end'),
                path=path,
                related_ids=[identity],
            )
            continue

        if total_pixels < 1:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('An allocation requires a published mapping'),
                path=path,
                related_ids=[identity],
            )
            continue

        if end > total_pixels:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Allocation must not exceed the mapping size'),
                path=path,
                related_ids=[identity],
            )
            continue

        intervals.append((start, end))

    for index, first in enumerate(intervals):
        for second in intervals[index + 1 :]:
            if intervals_overlap(first, second):
                report.add_error(
                    CODE_ALLOCATION_OVERLAP,
                    _('Drawer allocations must not overlap'),
                    path='allocations',
                )

    if total_pixels >= 1:
        report.unused_ranges.extend(compute_unused_ranges(intervals, total_pixels))

    return report


def validate_mapping_spans(
    spans: Iterable[Any], total_pixels: int, report: ValidationReport | None = None
) -> ValidationReport:
    """Validate logical coverage and physical slices of a mapping revision.

    Logical coverage must be exactly ``1..N`` with no gaps or overlaps.
    Physical slices must lie inside their string and must not overlap either
    within a string or within a controller-global address space.

    Args:
        spans: Span-like rows exposing ``logical_start``, ``length``,
            ``string_offset`` and ``string.output_offset`` /
            ``string.pixel_count`` / ``string.output.wled_start`` /
            ``string.output.controller_id``.
        total_pixels: ``N`` for the mapping revision.
        report: Optional report to append to.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    rows = list(spans)
    total = int(total_pixels)

    if total < 1:
        if rows:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('A mapping with spans must declare a positive pixel count'),
                path='total_pixels',
            )
        return report

    logical: list[tuple[int, int, str]] = []
    physical: dict[str, list[tuple[int, int, str]]] = {}
    controller_physical: dict[str, list[tuple[int, int, str]]] = {}

    for span in rows:
        start = int(_value(span, 'logical_start', 0) or 0)
        length = int(_value(span, 'length', 0) or 0)
        identity = _identity(span)
        path = f'spans[{identity}]'

        if start < 1 or length < 1:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Span logical start and length must be positive'),
                path=path,
                related_ids=[identity],
            )
            continue

        end = start + length - 1

        if end > total:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Span must not exceed the mapping size'),
                path=path,
                related_ids=[identity],
            )

        logical.append((start, end, identity))

        string_id = str(_resolve(span, 'string.id', '') or '')
        string_count = _resolve(span, 'string.pixel_count', None)
        output_offset = int(_resolve(span, 'string.output_offset', 0) or 0)
        string_offset = int(_value(span, 'string_offset', 0) or 0)

        # ``string_offset`` is string-local (see mapping.span_view); the physical
        # slice used for overlap detection below is output-local, because a
        # controller-global address is ``wled_start + output_offset + string_offset``.
        string_local_end = string_offset + length

        if string_count is not None and string_local_end > int(string_count):
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Span must lie inside its LED string'),
                path=path,
                related_ids=[identity, string_id],
            )

        local_start = output_offset + string_offset
        local_end = local_start + length

        physical.setdefault(string_id, []).append((local_start, local_end, identity))

        wled_start = _resolve(span, 'string.output.wled_start', None)
        controller_id = _resolve(span, 'string.output.controller_id', None)

        if wled_start is not None:
            global_start = int(wled_start) + local_start
            controller_physical.setdefault(str(controller_id), []).append((
                global_start,
                global_start + length,
                identity,
            ))

    _validate_logical_coverage(logical, total, report)
    _validate_interval_groups(physical, report, 'LED string')
    _validate_interval_groups(controller_physical, report, 'controller address space')

    return report


def _validate_logical_coverage(
    logical: Sequence[tuple[int, int, str]], total: int, report: ValidationReport
) -> None:
    """Assert that logical spans cover exactly ``1..N``."""
    if not logical:
        report.add_error(
            CODE_MAPPING_GAP,
            _('A published mapping must cover every logical pixel'),
            path='spans',
        )
        return

    ordered = sorted(logical)
    expected = 1

    for start, end, identity in ordered:
        if start > expected:
            report.add_error(
                CODE_MAPPING_GAP,
                _('Logical pixels %(from)s-%(to)s are not covered')
                % {'from': expected, 'to': start - 1},
                path=f'spans[{identity}]',
                related_ids=[identity],
            )
        elif start < expected:
            report.add_error(
                CODE_MAPPING_GAP,
                _('Logical spans overlap at pixel %(pixel)s') % {'pixel': start},
                path=f'spans[{identity}]',
                related_ids=[identity],
            )

        expected = max(expected, end + 1)

    if expected <= total:
        report.add_error(
            CODE_MAPPING_GAP,
            _('Logical pixels %(from)s-%(to)s are not covered')
            % {'from': expected, 'to': total},
            path='spans',
        )


def _validate_interval_groups(
    groups: Mapping[str, Sequence[tuple[int, int, str]]],
    report: ValidationReport,
    label: str,
) -> None:
    """Report overlapping half-open intervals within each group."""
    for group_id, intervals in groups.items():
        for index, first in enumerate(intervals):
            for second in intervals[index + 1 :]:
                if intervals_overlap(first, second):
                    report.add_error(
                        CODE_PHYSICAL_OVERLAP,
                        _('Physical slices must not overlap within a %(label)s')
                        % {'label': label},
                        path=f'spans[{first[2]}]',
                        related_ids=[first[2], second[2], group_id],
                    )


# endregion

# region electrical validators


def validate_controller_outputs(
    outputs: Iterable[Any],
    report: ValidationReport | None = None,
    require_supported: bool = False,
) -> ValidationReport:
    """Validate controller outputs for address and GPIO consistency.

    Bus address intervals must not overlap, GPIO claims must be distinct, and
    the v1 identity-transform restrictions (``bus_reverse`` false, ``skip`` 0)
    are reported as warnings unless ``require_supported`` is set.

    Args:
        outputs: Output-like rows (mapping or object).
        report: Optional report to append to.
        require_supported: Treat unsupported configuration as an error.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    rows = list(outputs)
    severity = report.add_error if require_supported else report.add_warning

    seen_bus: dict[int, str] = {}
    intervals: list[tuple[int, int, str]] = []
    gpio_claims: dict[int, str] = {}

    for output in rows:
        identity = _identity(output)
        path = f'outputs[{identity}]'
        bus_index = _value(output, 'bus_index', None)
        count = int(_value(output, 'pixel_count', 0) or 0)
        start = int(_value(output, 'wled_start', 0) or 0)

        if bus_index is not None:
            bus_index = int(bus_index)

            if bus_index in seen_bus:
                report.add_error(
                    CODE_DUPLICATE_IDENTITY,
                    _('Bus indices must be unique within a controller'),
                    path=path,
                    related_ids=[seen_bus[bus_index], identity],
                )
            else:
                seen_bus[bus_index] = identity

        if count < 1 or start < 0:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('Output must have a non-negative start and a positive count'),
                path=path,
                related_ids=[identity],
            )
            continue

        intervals.append((start, start + count, identity))

        for pin in _value(output, 'pins', []) or []:
            try:
                pin = int(pin)
            except (TypeError, ValueError):
                report.add_error(
                    CODE_UNSUPPORTED_CONFIGURATION,
                    _('GPIO pins must be integers'),
                    path=path,
                    related_ids=[identity],
                )
                continue

            if pin in gpio_claims:
                report.add_error(
                    CODE_GPIO_CONFLICT,
                    _('GPIO %(pin)s is claimed by more than one output') % {'pin': pin},
                    path=path,
                    related_ids=[gpio_claims[pin], identity],
                )
            else:
                gpio_claims[pin] = identity

        if bool(_value(output, 'bus_reverse', False)):
            severity(
                CODE_UNSUPPORTED_CONFIGURATION,
                _('Reversed buses are not supported by the v1 adapter'),
                path=path,
                related_ids=[identity],
            )

        if int(_value(output, 'skip', 0) or 0) != 0:
            severity(
                CODE_UNSUPPORTED_CONFIGURATION,
                _('Non-zero skip is not supported by the v1 adapter'),
                path=path,
                related_ids=[identity],
            )

    for index, first in enumerate(intervals):
        for second in intervals[index + 1 :]:
            if intervals_overlap(first, second):
                report.add_error(
                    CODE_PHYSICAL_OVERLAP,
                    _('Output bus address ranges must not overlap'),
                    path=f'outputs[{first[2]}]',
                    related_ids=[first[2], second[2]],
                )

    return report


def validate_led_strings(
    output: Any, strings: Iterable[Any], report: ValidationReport | None = None
) -> ValidationReport:
    """Validate LED strings against their output and each other.

    Args:
        output: The parent output-like row (mapping or object).
        strings: String-like rows (mapping or object).
        report: Optional report to append to.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    rows = list(strings)
    output_count = int(_value(output, 'pixel_count', 0) or 0)
    intervals: list[tuple[int, int, str]] = []
    seen_labels: dict[str, str] = {}

    for string in rows:
        identity = _identity(string)
        path = f'strings[{identity}]'
        offset = int(_value(string, 'output_offset', 0) or 0)
        count = int(_value(string, 'pixel_count', 0) or 0)
        label = str(_value(string, 'label', '') or '')

        if count < 1 or offset < 0:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('String must have a non-negative offset and a positive count'),
                path=path,
                related_ids=[identity],
            )
            continue

        if output_count and offset + count > output_count:
            report.add_error(
                CODE_INVALID_BOUNDS,
                _('String must lie inside its output'),
                path=path,
                related_ids=[identity],
            )

        if label:
            if label in seen_labels:
                report.add_error(
                    CODE_DUPLICATE_IDENTITY,
                    _('String labels must be unique within an output'),
                    path=path,
                    related_ids=[seen_labels[label], identity],
                )
            else:
                seen_labels[label] = identity

        intervals.append((offset, offset + count, identity))

    for index, first in enumerate(intervals):
        for second in intervals[index + 1 :]:
            if intervals_overlap(first, second):
                report.add_error(
                    CODE_PHYSICAL_OVERLAP,
                    _('String slices must not overlap'),
                    path=f'strings[{first[2]}]',
                    related_ids=[first[2], second[2]],
                )

    if output_count:
        report.unused_ranges.extend(
            compute_unused_ranges([(i[0] + 1, i[1]) for i in intervals], output_count)
        )

    return report


# endregion

# region native binding validators


def validate_location_binding(
    role: str,
    location: Any,
    expected_parent: Any = None,
    structural: bool | None = None,
    allow_external: bool = False,
    required: bool = True,
    report: ValidationReport | None = None,
) -> ValidationReport:
    """Validate a native ``StockLocation`` binding for a plugin role.

    Args:
        role: One of ``cabinet``, ``drawer`` or ``bin``.
        location: The bound native location (or None).
        expected_parent: The required native parent location (or None).
        structural: Required value of the native ``structural`` flag.
        allow_external: Whether an external native location is permitted.
        required: Whether a binding is mandatory for this role.
        report: Optional report to append to.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    path = f'{role}.location'

    if location is None:
        if required:
            report.add_error(
                CODE_BINDING_INVALID,
                _('A native location is required for this %(role)s') % {'role': role},
                path=path,
            )
        else:
            report.add_warning(
                CODE_BINDING_INVALID,
                _('This %(role)s is not bound to a native location') % {'role': role},
                path=path,
            )
        return report

    identity = _identity(location)

    if expected_parent is not None:
        parent_id = _value(location, 'parent_id', None)

        if parent_id is None:
            parent_id = _value(_value(location, 'parent', None), 'id', None)

        if str(parent_id) != str(_identity(expected_parent)):
            report.add_error(
                CODE_BINDING_INVALID,
                _('The native location must be a direct child of its parent'),
                path=path,
                related_ids=[identity, _identity(expected_parent)],
            )

    if (
        structural is not None
        and bool(_value(location, 'structural', False)) != structural
    ):
        report.add_error(
            CODE_BINDING_INVALID,
            _('The native location has an incompatible structural flag'),
            path=path,
            related_ids=[identity],
        )

    if not allow_external and bool(_value(location, 'external', False)):
        report.add_error(
            CODE_BINDING_INVALID,
            _('An external native location cannot be bound to this %(role)s')
            % {'role': role},
            path=path,
            related_ids=[identity],
        )

    return report


def validate_native_location_roles(
    cabinet_location: Any,
    drawer_locations: Iterable[Any],
    bin_locations: Iterable[Any],
    report: ValidationReport | None = None,
) -> ValidationReport:
    """Ensure a native location is not reused across plugin roles.

    Args:
        cabinet_location: The cabinet's native location.
        drawer_locations: Native locations bound to drawers.
        bin_locations: Native locations bound to bins.
        report: Optional report to append to.

    Returns:
        The populated validation report.
    """
    report = report or ValidationReport()
    seen: dict[str, str] = {}

    groups = (
        ('cabinet', [cabinet_location] if cabinet_location is not None else []),
        ('drawer', list(drawer_locations)),
        ('bin', list(bin_locations)),
    )

    for role, locations in groups:
        for location in locations:
            identity = _identity(location)

            if not identity:
                continue

            if identity in seen:
                report.add_error(
                    CODE_BINDING_INVALID,
                    _('A native location cannot be bound to more than one role'),
                    path=f'{role}.location',
                    related_ids=[identity],
                )
            else:
                seen[identity] = role

    return report


# endregion

# region DB-backed helpers


def validate_cabinet_layout(cabinet: Any) -> ValidationReport:
    """Validate the full saved layout of a cabinet.

    Args:
        cabinet: A :class:`storage_layout.models.Cabinet` instance.

    Returns:
        The populated validation report.
    """
    report = ValidationReport()

    drawers = list(cabinet.drawers.all())
    bins = [b for drawer in drawers for b in drawer.bins.all()]

    validate_drawer_geometry(
        cabinet.width_units, cabinet.height_units, drawers, report=report
    )

    for drawer in drawers:
        validate_bin_geometry(
            drawer.interior_width,
            drawer.interior_height,
            drawer.bins.all(),
            report=report,
        )

    mapping = cabinet.active_mapping
    total = mapping.total_pixels if mapping is not None else 0

    allocations = [
        drawer.allocation for drawer in drawers if hasattr(drawer, 'allocation')
    ]

    validate_allocations(allocations, total, report=report)

    validate_native_location_roles(
        cabinet.location,
        [drawer.location for drawer in drawers],
        [b.location for b in bins if b.location_id],
        report=report,
    )

    for drawer in drawers:
        validate_location_binding(
            'drawer',
            drawer.location,
            expected_parent=cabinet.location,
            structural=True,
            report=report,
        )

    for bin_row in bins:
        if bin_row.location_id:
            validate_location_binding(
                'bin',
                bin_row.location,
                expected_parent=bin_row.drawer.location,
                structural=False,
                report=report,
            )

    if mapping is not None:
        validate_mapping_spans(mapping.spans.all(), mapping.total_pixels, report=report)

    return report


def validate_mapping_revision(mapping: Any) -> ValidationReport:
    """Validate a mapping revision's spans.

    Args:
        mapping: A :class:`storage_layout.models.MappingRevision` instance.

    Returns:
        The populated validation report.
    """
    return validate_mapping_spans(mapping.spans.all(), mapping.total_pixels)


def validate_controller(
    controller: Any, require_supported: bool = False
) -> ValidationReport:
    """Validate a controller's saved electrical topology.

    Args:
        controller: A :class:`storage_layout.models.Controller` instance.
        require_supported: Treat unsupported configuration as an error.

    Returns:
        The populated validation report.
    """
    report = ValidationReport()
    outputs = list(controller.outputs.all())

    validate_controller_outputs(
        outputs, report=report, require_supported=require_supported
    )

    for output in outputs:
        validate_led_strings(output, output.strings.all(), report=report)

    return report


# endregion
