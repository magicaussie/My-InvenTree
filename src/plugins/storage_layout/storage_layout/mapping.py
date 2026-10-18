"""Deterministic logical to physical mapping translation.

This module implements the mapping model described in
``docs/design/001 - Storage Layout & WLED.md`` section 8. It is the single
translator used by the simulation engine, the REST API and the tests.

Everything here is **pure**: the functions operate on plain data or on
model-like objects exposing the documented attribute paths, and never touch the
database or the network. That keeps the translator exhaustively testable and
guarantees that previewing a mapping cannot perform a hardware operation.

Definitions (design section 8):

- ``L``: cabinet logical pixel, ``1..N`` inclusive.
- ``s``, ``n``: span logical start and length; logical end ``s + n - 1``.
- ``o``: span's lowest string-local offset (zero-based); ``d``: direction ``+/-1``.
- ``t``: ``LEDString.output_offset``; ``b``: ``ControllerOutput.wled_start``.
- ``W``: zero-based WLED controller-global pixel index.

For ``k = L - s`` with ``0 <= k < n``::

    string_local = o + (k if d == +1 else n - 1 - k)
    output_local = t + string_local
    W            = b + output_local
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

SCHEMA_VERSION = 1

DIRECTION_FORWARD = 1
DIRECTION_REVERSE = -1


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


# endregion


@dataclass(frozen=True)
class SpanView:
    """A resolved pixel span together with its physical topology.

    Instances are built from model objects or plain mappings via
    :func:`span_view`, so the translator never depends on the ORM.
    """

    logical_start: int
    length: int
    string_offset: int
    direction: int

    string_id: str
    string_label: str
    output_offset: int
    string_pixel_count: int

    output_id: str
    bus_index: int
    wled_start: int
    output_pixel_count: int

    controller_id: str
    controller_name: str

    @property
    def logical_end(self) -> int:
        """Inclusive logical end of this span."""
        return self.logical_start + self.length - 1

    def wled_index(self, logical: int) -> int:
        """Return the controller-global WLED index for a logical pixel.

        Args:
            logical: A logical pixel inside this span.

        Returns:
            The zero-based controller-global WLED index.

        Raises:
            ValidationError: If ``logical`` is outside this span.
        """
        if logical < self.logical_start or logical > self.logical_end:
            raise ValidationError(
                _('Logical pixel %(pixel)s is outside span %(start)s-%(end)s')
                % {
                    'pixel': logical,
                    'start': self.logical_start,
                    'end': self.logical_end,
                }
            )

        k = logical - self.logical_start

        if self.direction == DIRECTION_REVERSE:
            string_local = self.string_offset + (self.length - 1 - k)
        else:
            string_local = self.string_offset + k

        output_local = self.output_offset + string_local

        return self.wled_start + output_local


def _span_int(value: Any, field: str) -> int:
    """Coerce span geometry to an integer, rejecting fractional input.

    Model fields are integers, so this only guards against malformed plain
    mappings. The previous ``int(value or 0)`` coercion silently truncated
    fractional geometry, which could change the physical address of a span
    without any error. ``None`` and empty values still default to ``0`` for
    backwards compatibility.

    Args:
        value: The raw value read from the span-like object.
        field: The field name, used in the error message.

    Returns:
        The value as an integer.

    Raises:
        ValidationError: If the value is not an integer.
    """
    if value is None or value == '':
        return 0

    if isinstance(value, bool):
        raise ValidationError(_('Span %(field)s must be an integer') % {'field': field})

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        if not value.is_integer():
            raise ValidationError(
                _('Span %(field)s must be an integer') % {'field': field}
            )

        return int(value)

    text = str(value).strip()

    if not text.lstrip('-').isdigit():
        raise ValidationError(_('Span %(field)s must be an integer') % {'field': field})

    return int(text)


def span_view(span: Any) -> SpanView:
    """Build a :class:`SpanView` from a model object or plain mapping.

    Args:
        span: A span-like object exposing ``logical_start``, ``length``,
            ``string_offset``, ``direction`` and the nested ``string`` /
            ``string.output`` topology.

    Returns:
        The resolved span view.
    """
    raw_direction = _value(span, 'direction', DIRECTION_FORWARD)

    if raw_direction is None:
        raw_direction = DIRECTION_FORWARD

    try:
        direction = int(raw_direction)
    except (TypeError, ValueError) as exc:
        raise ValidationError(_('Span direction must be +1 or -1')) from exc

    if direction not in (DIRECTION_FORWARD, DIRECTION_REVERSE):
        raise ValidationError(_('Span direction must be +1 or -1'))

    return SpanView(
        logical_start=_span_int(_value(span, 'logical_start', 0), 'logical_start'),
        length=_span_int(_value(span, 'length', 0), 'length'),
        string_offset=_span_int(_value(span, 'string_offset', 0), 'string_offset'),
        direction=direction,
        string_id=str(_resolve(span, 'string.id', '') or ''),
        string_label=str(_resolve(span, 'string.label', '') or ''),
        output_offset=_span_int(
            _resolve(span, 'string.output_offset', 0), 'output_offset'
        ),
        string_pixel_count=_span_int(
            _resolve(span, 'string.pixel_count', 0), 'string_pixel_count'
        ),
        output_id=str(_resolve(span, 'string.output.id', '') or ''),
        bus_index=_span_int(_resolve(span, 'string.output.bus_index', 0), 'bus_index'),
        wled_start=_span_int(
            _resolve(span, 'string.output.wled_start', 0), 'wled_start'
        ),
        output_pixel_count=_span_int(
            _resolve(span, 'string.output.pixel_count', 0), 'output_pixel_count'
        ),
        controller_id=str(_resolve(span, 'string.output.controller.id', '') or ''),
        controller_name=str(_resolve(span, 'string.output.controller.name', '') or ''),
    )


def span_views(spans: Iterable[Any]) -> list[SpanView]:
    """Resolve an iterable of spans into ordered :class:`SpanView` objects."""
    return sorted((span_view(span) for span in spans), key=lambda s: s.logical_start)


# region manifest and hash


def build_manifest(spans: Iterable[Any], total_pixels: int) -> dict[str, Any]:
    """Build the immutable published manifest for a mapping revision.

    The manifest freezes output/string identities and every address-affecting
    value, so an old session remains diagnosable even if the draft topology is
    later edited.

    Args:
        spans: Span-like rows.
        total_pixels: ``N`` for the mapping revision.

    Returns:
        A JSON-serialisable manifest dictionary.
    """
    views = span_views(spans)

    controllers: dict[str, dict[str, Any]] = {}
    outputs: dict[str, dict[str, Any]] = {}
    strings: dict[str, dict[str, Any]] = {}
    span_rows: list[dict[str, Any]] = []

    for view in views:
        controllers[view.controller_id] = {
            'id': view.controller_id,
            'name': view.controller_name,
        }
        outputs[view.output_id] = {
            'id': view.output_id,
            'controller': view.controller_id,
            'bus_index': view.bus_index,
            'wled_start': view.wled_start,
            'pixel_count': view.output_pixel_count,
        }
        strings[view.string_id] = {
            'id': view.string_id,
            'output': view.output_id,
            'label': view.string_label,
            'output_offset': view.output_offset,
            'pixel_count': view.string_pixel_count,
        }
        span_rows.append({
            'logical_start': view.logical_start,
            'length': view.length,
            'string': view.string_id,
            'string_offset': view.string_offset,
            'direction': view.direction,
        })

    return {
        'schema_version': SCHEMA_VERSION,
        'total_pixels': int(total_pixels),
        'controllers': [controllers[k] for k in sorted(controllers)],
        'outputs': [outputs[k] for k in sorted(outputs)],
        'strings': [strings[k] for k in sorted(strings)],
        'spans': span_rows,
    }


def compute_mapping_hash(manifest: Mapping[str, Any]) -> str:
    """Return the deterministic content hash of a mapping manifest."""
    payload = json.dumps(manifest, sort_keys=True, separators=(',', ':'))

    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def mapping_hash(spans: Iterable[Any], total_pixels: int) -> str:
    """Return the content hash for a set of spans and a logical size."""
    return compute_mapping_hash(build_manifest(spans, total_pixels))


# endregion


# region translation


def _physically_adjacent(previous: Mapping[str, Any], run: Mapping[str, Any]) -> bool:
    """Return whether two logically adjacent runs are contiguous in WLED space.

    A forward run traverses its physical half-open interval from low to high, so
    the next run must begin exactly where the previous one stopped
    (``previous['wled_stop'] == run['wled_start']``). A reversed run traverses
    from high to low, so the next run must begin exactly one pixel below the
    previous run's lowest pixel (``run['wled_stop'] == previous['wled_start']``).
    Using the forward test for reversed runs would merge physically
    discontiguous spans.
    """
    if run['direction'] == DIRECTION_REVERSE:
        return run['wled_stop'] == previous['wled_start']

    return previous['wled_stop'] == run['wled_start']


def _merge_runs(runs: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge adjacent, contiguous, same-controller runs.

    Runs are merged only when they are adjacent in logical order, contiguous in
    controller-global WLED space and share controller, output, string and
    direction. Runs are never merged across controllers, outputs, strings,
    directions or physical discontinuities.
    """
    merged: list[dict[str, Any]] = []

    for run in runs:
        if merged:
            previous = merged[-1]

            same_identity = (
                previous['controller'] == run['controller']
                and previous['output'] == run['output']
                and previous['string'] == run['string']
                and previous['direction'] == run['direction']
            )
            logically_adjacent = previous['logical_end'] + 1 == run['logical_start']
            contiguous = logically_adjacent and _physically_adjacent(previous, run)

            if same_identity and contiguous:
                previous['logical_end'] = run['logical_end']
                # The merged run must span the full physical half-open interval.
                # A forward run extends upward and a reversed run downward, so
                # taking the min/max of both bounds covers either case.
                previous['wled_start'] = min(previous['wled_start'], run['wled_start'])
                previous['wled_stop'] = max(previous['wled_stop'], run['wled_stop'])
                continue

        merged.append(dict(run))

    return merged


def _strict_int(value: Any) -> int:
    """Coerce a value to an integer, rejecting fractional input."""
    if isinstance(value, bool):
        raise ValidationError(_('Logical range must be integers'))

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        if not value.is_integer():
            raise ValidationError(_('Logical range must be integers'))

        return int(value)

    text = str(value).strip()

    if not text.lstrip('-').isdigit():
        raise ValidationError(_('Logical range must be integers'))

    return int(text)


def translate(
    spans: Iterable[Any],
    logical_start: int,
    logical_end: int,
    total_pixels: int | None = None,
) -> list[dict[str, Any]]:
    """Translate an inclusive logical range into ordered physical runs.

    Args:
        spans: Span-like rows for a single mapping revision.
        logical_start: Inclusive logical start ``A``.
        logical_end: Inclusive logical end ``B``.
        total_pixels: Optional ``N`` used to bound-check the request.

    Returns:
        An ordered list of physical runs. The runs cover exactly
        ``B - A + 1`` logical pixels.

    Raises:
        ValidationError: If the range is invalid, out of bounds, or cannot be
            fully covered by the supplied spans.
    """
    try:
        start = _strict_int(logical_start)
        end = _strict_int(logical_end)
    except ValidationError:
        raise
    except (TypeError, ValueError) as exc:
        raise ValidationError(_('Logical range must be integers')) from exc

    if start < 1 or end < 1 or start > end:
        raise ValidationError(_('Logical range must satisfy 1 <= start <= end'))

    views = span_views(spans)

    if total_pixels is not None and end > int(total_pixels):
        raise ValidationError(_('Logical range must not exceed the mapping size'))

    intersecting = [
        view
        for view in views
        if view.logical_end >= start and view.logical_start <= end
    ]

    # Establish exact, gap-free, non-overlapping coverage of the requested
    # interval. Aggregate covered length is not sufficient: overlapping spans can
    # duplicate coverage while a gap elsewhere keeps the totals equal. Walking
    # the spans in logical order and requiring each to start exactly at the next
    # uncovered pixel rejects both gaps and overlaps. Only intersecting spans are
    # considered, so unrelated rows outside the request cannot fail it.
    cursor = start

    for index, view in enumerate(intersecting):
        if view.logical_start > cursor:
            raise ValidationError(
                _('Logical range %(start)s-%(end)s is not fully covered by the mapping')
                % {'start': start, 'end': end}
            )

        if index > 0 and view.logical_start < cursor:
            raise ValidationError(
                _('Logical range %(start)s-%(end)s has overlapping spans')
                % {'start': start, 'end': end}
            )

        cursor = view.logical_end + 1

    if cursor <= end:
        raise ValidationError(
            _('Logical range %(start)s-%(end)s is not fully covered by the mapping')
            % {'start': start, 'end': end}
        )

    runs: list[dict[str, Any]] = []

    for view in intersecting:
        a = max(start, view.logical_start)
        z = min(end, view.logical_end)

        wa = view.wled_index(a)
        wz = view.wled_index(z)

        runs.append({
            'logical_start': a,
            'logical_end': z,
            'controller': view.controller_id,
            'output': view.output_id,
            'string': view.string_id,
            'wled_start': min(wa, wz),
            'wled_stop': max(wa, wz) + 1,
            'direction': view.direction,
        })

    return _merge_runs(runs)


def sample_translation(
    spans: Iterable[Any], total_pixels: int, samples: int = 3
) -> list[dict[str, Any]]:
    """Return a small deterministic sample of translated logical pixels.

    Used by the mapping preview endpoint to demonstrate that a candidate
    mapping resolves. The sample always includes the first and last logical
    pixel when ``N >= 1``.

    Args:
        spans: Span-like rows.
        total_pixels: ``N`` for the mapping.
        samples: Maximum number of sample pixels to translate.

    Returns:
        A list of ``{'logical': int, 'runs': [...]}`` entries.
    """
    total = int(total_pixels)

    if total < 1:
        return []

    pixels = {1, total}

    if samples >= 3 and total >= 3:
        pixels.add((total + 1) // 2)

    result = []

    for pixel in sorted(pixels):
        result.append({'logical': pixel, 'runs': translate(spans, pixel, pixel, total)})

    return result


# endregion
