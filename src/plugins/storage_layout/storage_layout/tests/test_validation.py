"""Unit tests for the authoritative validation module.

These tests exercise the pure validators directly, with no database access, so
they run as ``SimpleTestCase``.
"""

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from storage_layout import validation as v


def drawer(**kwargs):
    """Build a drawer-like mapping for geometry tests.

    The default label is derived from the id so that rows which are only meant
    to exercise geometry do not accidentally collide on the label constraint.
    """
    data = {
        'id': 'drawer',
        'display_number': 1,
        'x': 0,
        'y': 0,
        'width': 100,
        'height': 50,
        'archived': False,
    }
    data.update(kwargs)
    data.setdefault('label', f'drawer-{data["id"]}')
    return data


def bin_row(**kwargs):
    """Build a bin-like mapping for geometry tests.

    The default label is derived from the id so that rows which are only meant
    to exercise geometry do not accidentally collide on the label constraint.
    """
    data = {
        'id': 'bin',
        'x': 0,
        'y': 0,
        'width': 10,
        'height': 10,
        'archived': False,
    }
    data.update(kwargs)
    data.setdefault('label', f'bin-{data["id"]}')
    return data


def span(**kwargs):
    """Build a span-like mapping for mapping tests."""
    data = {
        'id': 'span',
        'logical_start': 1,
        'length': 10,
        'string_offset': 0,
        'direction': 1,
        'string': {
            'id': 'string',
            'output_offset': 0,
            'pixel_count': 100,
            'output': {'id': 'output', 'wled_start': 0, 'controller_id': 'controller'},
        },
    }
    data.update(kwargs)
    return data


def output(**kwargs):
    """Build a controller-output-like mapping."""
    data = {
        'id': 'output',
        'bus_index': 0,
        'wled_start': 0,
        'pixel_count': 50,
        'pins': [16],
        'bus_reverse': False,
        'skip': 0,
    }
    data.update(kwargs)
    return data


def led_string(**kwargs):
    """Build an LED-string-like mapping."""
    data = {'id': 'string', 'label': 'S1', 'output_offset': 0, 'pixel_count': 50}
    data.update(kwargs)
    return data


def location(**kwargs):
    """Build a native-location-like mapping."""
    data = {'id': 'loc', 'parent_id': None, 'structural': False, 'external': False}
    data.update(kwargs)
    return data


class GeometryPrimitiveTests(SimpleTestCase):
    """Tests for the half-open rectangle and interval primitives."""

    def test_rectangle_area(self):
        """Area of a half-open rectangle is width times height."""
        self.assertEqual(v.rectangle_area((0, 0, 10, 5)), 50)
        self.assertEqual(v.rectangle_area((0, 0, 0, 5)), 0)

    def test_overlap_positive_area(self):
        """Rectangles overlapping by positive area are detected."""
        self.assertTrue(v.rectangles_overlap((0, 0, 10, 10), (5, 5, 10, 10)))

    def test_touching_edges_do_not_overlap(self):
        """Rectangles which only touch along an edge do not overlap."""
        self.assertFalse(v.rectangles_overlap((0, 0, 10, 10), (10, 0, 10, 10)))
        self.assertFalse(v.rectangles_overlap((0, 0, 10, 10), (0, 10, 10, 10)))

    def test_disjoint_rectangles(self):
        """Disjoint rectangles do not overlap."""
        self.assertFalse(v.rectangles_overlap((0, 0, 10, 10), (20, 20, 5, 5)))

    def test_contained_rectangle_overlaps(self):
        """A contained rectangle still overlaps its container."""
        self.assertTrue(v.rectangles_overlap((0, 0, 10, 10), (2, 2, 3, 3)))

    def test_rectangle_within(self):
        """Containment includes the boundary but not the exterior."""
        self.assertTrue(v.rectangle_within((0, 0, 10, 10), (0, 0, 10, 10)))
        self.assertTrue(v.rectangle_within((1, 1, 8, 8), (0, 0, 10, 10)))
        self.assertFalse(v.rectangle_within((1, 1, 10, 8), (0, 0, 10, 10)))
        self.assertFalse(v.rectangle_within((-1, 0, 5, 5), (0, 0, 10, 10)))

    def test_intervals_overlap(self):
        """Half-open intervals which touch at an endpoint do not overlap."""
        self.assertTrue(v.intervals_overlap((0, 10), (5, 15)))
        self.assertFalse(v.intervals_overlap((0, 10), (10, 20)))

    def test_compute_unused_ranges(self):
        """Unused ranges are computed over the inclusive 1..N domain."""
        self.assertEqual(v.compute_unused_ranges([], 5), [(1, 5)])
        self.assertEqual(v.compute_unused_ranges([(1, 5)], 5), [])
        self.assertEqual(v.compute_unused_ranges([(2, 3)], 5), [(1, 1), (4, 5)])
        self.assertEqual(v.compute_unused_ranges([(1, 2), (4, 5)], 5), [(3, 3)])
        self.assertEqual(v.compute_unused_ranges([(1, 5)], 0), [])

    def test_compute_unused_ranges_merges_overlaps(self):
        """Overlapping allocations are merged before computing gaps."""
        self.assertEqual(v.compute_unused_ranges([(1, 3), (2, 5)], 6), [(6, 6)])


class CanonicalOriginTests(SimpleTestCase):
    """Tests for the controller origin SSRF boundary."""

    def test_valid_origins(self):
        """Plain HTTP(S) origins are accepted and normalised."""
        self.assertEqual(
            v.validate_canonical_origin('http://wled-1.local'), 'http://wled-1.local'
        )
        self.assertEqual(
            v.validate_canonical_origin('https://WLED-1.local:8443'),
            'https://wled-1.local:8443',
        )
        self.assertEqual(
            v.validate_canonical_origin('http://10.0.0.5:80'), 'http://10.0.0.5'
        )
        self.assertEqual(
            v.validate_canonical_origin('https://10.0.0.5:443'), 'https://10.0.0.5'
        )
        self.assertEqual(
            v.validate_canonical_origin('http://[::1]:8080'), 'http://[::1]:8080'
        )

    def test_rejects_missing_scheme(self):
        """A bare host is not a canonical origin."""
        with self.assertRaises(ValidationError):
            v.validate_canonical_origin('wled-1.local')

    def test_rejects_unsupported_scheme(self):
        """Only http and https are permitted."""
        with self.assertRaises(ValidationError):
            v.validate_canonical_origin('ftp://wled-1.local')

    def test_rejects_userinfo(self):
        """Credentials in the origin are refused."""
        with self.assertRaises(ValidationError):
            v.validate_canonical_origin('http://user:pass@wled-1.local')

    def test_rejects_path_query_fragment(self):
        """A path, query or fragment is refused."""
        for value in (
            'http://wled-1.local/json',
            'http://wled-1.local/?a=1',
            'http://wled-1.local/#frag',
        ):
            with self.assertRaises(ValidationError):
                v.validate_canonical_origin(value)

    def test_rejects_empty_and_invalid_port(self):
        """Empty values and invalid ports are refused."""
        with self.assertRaises(ValidationError):
            v.validate_canonical_origin('')

        with self.assertRaises(ValidationError):
            v.validate_canonical_origin('http://wled-1.local:notaport')


class ProfileDurationTests(SimpleTestCase):
    """Tests for purpose-specific profile duration limits."""

    def test_locate_duration(self):
        """Locate profiles allow up to 120 seconds."""
        self.assertEqual(v.validate_profile_duration('locate', 120), 120)

        with self.assertRaises(ValidationError):
            v.validate_profile_duration('locate', 121)

    def test_test_duration(self):
        """Test profiles allow up to 10 seconds."""
        self.assertEqual(v.validate_profile_duration('test', 10), 10)

        with self.assertRaises(ValidationError):
            v.validate_profile_duration('test', 11)

    def test_minimum_duration(self):
        """A duration of zero is always invalid."""
        with self.assertRaises(ValidationError):
            v.validate_profile_duration('locate', 0)


class DrawerGeometryTests(SimpleTestCase):
    """Tests for drawer front-face geometry validation."""

    def test_valid_layout(self):
        """A non-overlapping layout inside the cabinet is valid."""
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(id='a', x=0, y=0, width=300, height=100, display_number=1),
                drawer(id='b', x=300, y=0, width=300, height=100, display_number=2),
            ],
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_overlap_detected(self):
        """Overlapping drawers are reported."""
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(id='a', x=0, y=0, width=300, height=100),
                drawer(id='b', x=200, y=0, width=300, height=100, display_number=2),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_GEOMETRY_OVERLAP)
        self.assertEqual(sorted(report.errors[0].related_ids), ['a', 'b'])

    def test_touching_drawers_allowed(self):
        """Drawers which share an edge are permitted."""
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(id='a', x=0, y=0, width=300, height=100),
                drawer(id='b', x=300, y=0, width=300, height=100, display_number=2),
            ],
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_outside_cabinet(self):
        """A drawer extending beyond the cabinet is invalid."""
        report = v.validate_drawer_geometry(
            600, 800, [drawer(id='a', x=500, y=0, width=300, height=100)]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_zero_size(self):
        """A zero-sized drawer is invalid."""
        report = v.validate_drawer_geometry(
            600, 800, [drawer(id='a', width=0, height=100)]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_duplicate_display_number(self):
        """Duplicate display numbers within a cabinet are reported."""
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(id='a', x=0, y=0, width=100, height=50, display_number=1),
                drawer(id='b', x=0, y=100, width=100, height=50, display_number=1),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)

    def test_archived_excluded_by_default(self):
        """Archived drawers are excluded from overlap checks by default."""
        rows = [
            drawer(id='a', x=0, y=0, width=300, height=100),
            drawer(
                id='b', x=0, y=0, width=300, height=100, display_number=2, archived=True
            ),
        ]
        self.assertTrue(v.validate_drawer_geometry(600, 800, rows).valid)
        self.assertFalse(
            v.validate_drawer_geometry(600, 800, rows, include_archived=True).valid
        )

    def test_duplicate_label(self):
        """Duplicate drawer labels within a cabinet are reported."""
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(id='a', x=0, y=0, width=100, height=50, label='A1'),
                drawer(
                    id='b',
                    x=0,
                    y=100,
                    width=100,
                    height=50,
                    display_number=2,
                    label='A1',
                ),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)
        self.assertEqual(sorted(report.errors[0].related_ids), ['a', 'b'])

    def test_archived_rows_still_occupy_identity_constraints(self):
        """Archived drawers still occupy the label and number constraints."""
        rows = [
            drawer(id='a', x=0, y=0, width=100, height=50, label='A1'),
            drawer(
                id='b',
                x=0,
                y=100,
                width=100,
                height=50,
                label='A1',
                archived=True,
            ),
        ]
        report = v.validate_drawer_geometry(600, 800, rows)
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)

    def test_retained_drawer_identity_conflict(self):
        """A proposal cannot collide with a retained (omitted) drawer."""
        retained = [drawer(id='kept', label='A1', display_number=1)]
        report = v.validate_drawer_geometry(
            600,
            800,
            [
                drawer(
                    id='new',
                    x=0,
                    y=0,
                    width=100,
                    height=50,
                    display_number=2,
                    label='A1',
                )
            ],
            retained=retained,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)
        self.assertIn('kept', report.errors[0].related_ids)


class BinGeometryTests(SimpleTestCase):
    """Tests for bin geometry validation against the drawer interior."""

    def test_valid_layout(self):
        """Bins inside the interior plane are valid."""
        report = v.validate_bin_geometry(
            280, 400, [bin_row(id='a', x=0, y=0, width=70, height=100)]
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_outside_interior(self):
        """A bin extending beyond the interior is invalid."""
        report = v.validate_bin_geometry(
            280, 400, [bin_row(id='a', x=250, y=0, width=70, height=100)]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_overlap(self):
        """Overlapping bins are reported."""
        report = v.validate_bin_geometry(
            280,
            400,
            [
                bin_row(id='a', x=0, y=0, width=70, height=100),
                bin_row(id='b', x=50, y=0, width=70, height=100),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_GEOMETRY_OVERLAP)

    def test_interior_is_independent_of_front_face(self):
        """The interior plane is validated on its own dimensions."""
        # A bin which fits the interior but not the front rectangle is valid.
        report = v.validate_bin_geometry(
            280, 400, [bin_row(id='a', x=0, y=0, width=280, height=400)]
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_duplicate_label(self):
        """Duplicate bin labels within a drawer are reported."""
        report = v.validate_bin_geometry(
            280,
            400,
            [
                bin_row(id='a', x=0, y=0, width=70, height=100, label='B1'),
                bin_row(id='b', x=70, y=0, width=70, height=100, label='B1'),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)
        self.assertEqual(sorted(report.errors[0].related_ids), ['a', 'b'])

    def test_archived_bin_label_still_unique(self):
        """An archived bin still occupies its drawer's label constraint."""
        report = v.validate_bin_geometry(
            280,
            400,
            [
                bin_row(id='a', x=0, y=0, width=70, height=100, label='B1'),
                bin_row(
                    id='b',
                    x=70,
                    y=0,
                    width=70,
                    height=100,
                    label='B1',
                    archived=True,
                ),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)

    def test_retained_bin_label_conflict(self):
        """A proposal cannot collide with a retained (omitted) bin."""
        retained = [bin_row(id='kept', label='B1')]
        report = v.validate_bin_geometry(
            280,
            400,
            [bin_row(id='new', x=0, y=0, width=70, height=100, label='B1')],
            retained=retained,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)
        self.assertIn('kept', report.errors[0].related_ids)


class AllocationTests(SimpleTestCase):
    """Tests for drawer allocation validation."""

    def test_valid_allocations(self):
        """Non-overlapping in-range allocations are valid."""
        report = v.validate_allocations(
            [
                {'id': 'a', 'logical_start': 1, 'logical_end': 50},
                {'id': 'b', 'logical_start': 51, 'logical_end': 120},
            ],
            120,
        )
        self.assertTrue(report.valid, report.as_dict())
        self.assertEqual(report.unused_ranges, [])

    def test_overlap(self):
        """Overlapping allocations are reported."""
        report = v.validate_allocations(
            [
                {'id': 'a', 'logical_start': 1, 'logical_end': 60},
                {'id': 'b', 'logical_start': 51, 'logical_end': 120},
            ],
            120,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_ALLOCATION_OVERLAP)

    def test_out_of_range(self):
        """An allocation beyond the mapping size is invalid."""
        report = v.validate_allocations(
            [{'id': 'a', 'logical_start': 100, 'logical_end': 130}], 120
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_end_before_start(self):
        """An allocation with end < start is invalid."""
        report = v.validate_allocations(
            [{'id': 'a', 'logical_start': 10, 'logical_end': 5}], 120
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_requires_mapping(self):
        """An allocation without a published mapping is invalid."""
        report = v.validate_allocations(
            [{'id': 'a', 'logical_start': 1, 'logical_end': 5}], 0
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_unused_ranges_are_warnings(self):
        """Unallocated logical pixels are reported as unused ranges."""
        report = v.validate_allocations(
            [{'id': 'a', 'logical_start': 10, 'logical_end': 20}], 30
        )
        self.assertTrue(report.valid, report.as_dict())
        self.assertEqual(report.unused_ranges, [(1, 9), (21, 30)])


class MappingSpanTests(SimpleTestCase):
    """Tests for logical coverage and physical slice validation."""

    def test_design_worked_example(self):
        """The multi-controller worked example validates cleanly."""
        spans = [
            span(
                id='s1',
                logical_start=1,
                length=50,
                string={
                    'id': 'S1',
                    'output_offset': 0,
                    'pixel_count': 50,
                    'output': {'wled_start': 0, 'controller_id': 'A'},
                },
            ),
            span(
                id='s2',
                logical_start=51,
                length=30,
                string={
                    'id': 'S2',
                    'output_offset': 0,
                    'pixel_count': 30,
                    'output': {'wled_start': 80, 'controller_id': 'A'},
                },
            ),
            span(
                id='s3',
                logical_start=81,
                length=40,
                string={
                    'id': 'S3',
                    'output_offset': 0,
                    'pixel_count': 40,
                    'output': {'wled_start': 10, 'controller_id': 'B'},
                },
            ),
        ]
        report = v.validate_mapping_spans(spans, 120)
        self.assertTrue(report.valid, report.as_dict())

    def test_single_pixel_mapping(self):
        """A one-pixel mapping is valid."""
        report = v.validate_mapping_spans([span(id='s', logical_start=1, length=1)], 1)
        self.assertTrue(report.valid, report.as_dict())

    def test_gap_detected(self):
        """A hole in logical coverage is reported."""
        report = v.validate_mapping_spans(
            [span(id='a', logical_start=1, length=10)], 20
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_MAPPING_GAP)

    def test_logical_overlap_detected(self):
        """Overlapping logical spans are reported."""
        report = v.validate_mapping_spans(
            [
                span(id='a', logical_start=1, length=10, string_offset=0),
                span(id='b', logical_start=5, length=10, string_offset=20),
            ],
            20,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_MAPPING_GAP)

    def test_missing_leading_pixel(self):
        """A mapping which does not start at logical pixel 1 is reported."""
        report = v.validate_mapping_spans([span(id='a', logical_start=2, length=9)], 10)
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_MAPPING_GAP)

    def test_empty_mapping_is_reported(self):
        """A published mapping with no spans is reported."""
        report = v.validate_mapping_spans([], 10)
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_MAPPING_GAP)

    def test_span_beyond_string(self):
        """A span which does not fit its string is reported."""
        report = v.validate_mapping_spans(
            [
                span(
                    id='a',
                    logical_start=1,
                    length=10,
                    string_offset=45,
                    string={
                        'id': 'S1',
                        'output_offset': 0,
                        'pixel_count': 50,
                        'output': {'wled_start': 0, 'controller_id': 'A'},
                    },
                )
            ],
            10,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_span_offset_on_second_string_is_valid(self):
        """A span on a string with a non-zero output offset is bounded by the string.

        Regression: the bound must be checked in string-local coordinates. A
        string placed at ``output_offset > 0`` must not make its own spans look
        as though they overflow the string.
        """
        report = v.validate_mapping_spans(
            [
                span(
                    id='a',
                    logical_start=1,
                    length=60,
                    string_offset=0,
                    string={
                        'id': 'S2',
                        'output_offset': 40,
                        'pixel_count': 60,
                        'output': {'wled_start': 0, 'controller_id': 'A'},
                    },
                )
            ],
            60,
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_span_beyond_offset_string_is_reported(self):
        """A span which overruns its (offset) string is still reported."""
        report = v.validate_mapping_spans(
            [
                span(
                    id='a',
                    logical_start=1,
                    length=61,
                    string_offset=0,
                    string={
                        'id': 'S2',
                        'output_offset': 40,
                        'pixel_count': 60,
                        'output': {'wled_start': 0, 'controller_id': 'A'},
                    },
                )
            ],
            61,
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_physical_overlap_within_string(self):
        """Two spans claiming the same string slice are reported."""
        report = v.validate_mapping_spans(
            [
                span(id='a', logical_start=1, length=10, string_offset=0),
                span(id='b', logical_start=11, length=10, string_offset=5),
            ],
            20,
        )
        self.assertFalse(report.valid)
        codes = {issue.code for issue in report.errors}
        self.assertIn(v.CODE_PHYSICAL_OVERLAP, codes)

    def test_physical_overlap_across_strings_of_one_controller(self):
        """Overlap is detected in the controller-global address space."""
        report = v.validate_mapping_spans(
            [
                span(
                    id='a',
                    logical_start=1,
                    length=10,
                    string_offset=0,
                    string={
                        'id': 'S1',
                        'output_offset': 0,
                        'pixel_count': 50,
                        'output': {'wled_start': 0, 'controller_id': 'A'},
                    },
                ),
                span(
                    id='b',
                    logical_start=11,
                    length=10,
                    string_offset=0,
                    string={
                        'id': 'S2',
                        'output_offset': 0,
                        'pixel_count': 50,
                        'output': {'wled_start': 5, 'controller_id': 'A'},
                    },
                ),
            ],
            20,
        )
        self.assertFalse(report.valid)
        codes = {issue.code for issue in report.errors}
        self.assertIn(v.CODE_PHYSICAL_OVERLAP, codes)

    def test_same_address_on_different_controllers_is_allowed(self):
        """Different controllers have independent address spaces."""
        report = v.validate_mapping_spans(
            [
                span(
                    id='a',
                    logical_start=1,
                    length=10,
                    string={
                        'id': 'S1',
                        'output_offset': 0,
                        'pixel_count': 50,
                        'output': {'wled_start': 0, 'controller_id': 'A'},
                    },
                ),
                span(
                    id='b',
                    logical_start=11,
                    length=10,
                    string={
                        'id': 'S2',
                        'output_offset': 0,
                        'pixel_count': 50,
                        'output': {'wled_start': 0, 'controller_id': 'B'},
                    },
                ),
            ],
            20,
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_reverse_direction_does_not_change_interval(self):
        """Direction changes traversal, not interval membership."""
        report = v.validate_mapping_spans(
            [span(id='a', logical_start=1, length=10, direction=-1)], 10
        )
        self.assertTrue(report.valid, report.as_dict())


class ControllerOutputTests(SimpleTestCase):
    """Tests for controller output validation."""

    def test_valid_outputs(self):
        """Distinct bus indices, addresses and GPIOs are valid."""
        report = v.validate_controller_outputs(
            [
                output(id='a', bus_index=0, wled_start=0, pixel_count=50, pins=[16]),
                output(id='b', bus_index=1, wled_start=50, pixel_count=30, pins=[17]),
            ]
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_duplicate_bus_index(self):
        """Duplicate bus indices are reported."""
        report = v.validate_controller_outputs(
            [
                output(id='a', bus_index=0, wled_start=0, pixel_count=50, pins=[16]),
                output(id='b', bus_index=0, wled_start=50, pixel_count=30, pins=[17]),
            ]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)

    def test_overlapping_address_ranges(self):
        """Overlapping bus address ranges are reported."""
        report = v.validate_controller_outputs(
            [
                output(id='a', bus_index=0, wled_start=0, pixel_count=50, pins=[16]),
                output(id='b', bus_index=1, wled_start=40, pixel_count=30, pins=[17]),
            ]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_PHYSICAL_OVERLAP)

    def test_gpio_conflict(self):
        """Two outputs claiming the same GPIO are reported."""
        report = v.validate_controller_outputs(
            [
                output(id='a', bus_index=0, wled_start=0, pixel_count=50, pins=[16]),
                output(id='b', bus_index=1, wled_start=50, pixel_count=30, pins=[16]),
            ]
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_GPIO_CONFLICT)

    def test_unsupported_configuration_is_a_warning_by_default(self):
        """Reversed buses are warnings for design, errors when arming."""
        rows = [output(id='a', bus_reverse=True)]

        report = v.validate_controller_outputs(rows)
        self.assertTrue(report.valid, report.as_dict())
        self.assertEqual(report.warnings[0].code, v.CODE_UNSUPPORTED_CONFIGURATION)

        strict = v.validate_controller_outputs(rows, require_supported=True)
        self.assertFalse(strict.valid)
        self.assertEqual(strict.errors[0].code, v.CODE_UNSUPPORTED_CONFIGURATION)

    def test_non_zero_skip_is_unsupported(self):
        """A non-zero skip is unsupported by the v1 adapter."""
        report = v.validate_controller_outputs([output(id='a', skip=3)])
        self.assertEqual(report.warnings[0].code, v.CODE_UNSUPPORTED_CONFIGURATION)

    def test_invalid_count(self):
        """A zero pixel count is invalid."""
        report = v.validate_controller_outputs([output(id='a', pixel_count=0)])
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)


class LEDStringTests(SimpleTestCase):
    """Tests for LED string validation."""

    def test_valid_strings(self):
        """Non-overlapping strings inside the output are valid."""
        report = v.validate_led_strings(
            output(pixel_count=100),
            [
                led_string(id='a', label='S1', output_offset=0, pixel_count=50),
                led_string(id='b', label='S2', output_offset=50, pixel_count=50),
            ],
        )
        self.assertTrue(report.valid, report.as_dict())
        self.assertEqual(report.unused_ranges, [])

    def test_beyond_output(self):
        """A string extending beyond its output is invalid."""
        report = v.validate_led_strings(
            output(pixel_count=50),
            [led_string(id='a', output_offset=40, pixel_count=20)],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_INVALID_BOUNDS)

    def test_overlapping_strings(self):
        """Overlapping string slices are reported."""
        report = v.validate_led_strings(
            output(pixel_count=100),
            [
                led_string(id='a', label='S1', output_offset=0, pixel_count=60),
                led_string(id='b', label='S2', output_offset=50, pixel_count=50),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_PHYSICAL_OVERLAP)

    def test_duplicate_labels(self):
        """Duplicate labels within an output are reported."""
        report = v.validate_led_strings(
            output(pixel_count=100),
            [
                led_string(id='a', label='S1', output_offset=0, pixel_count=50),
                led_string(id='b', label='S1', output_offset=50, pixel_count=50),
            ],
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_DUPLICATE_IDENTITY)

    def test_unused_output_slices(self):
        """Unused output slices are reported as warnings."""
        report = v.validate_led_strings(
            output(pixel_count=100),
            [led_string(id='a', output_offset=10, pixel_count=20)],
        )
        self.assertTrue(report.valid, report.as_dict())
        self.assertEqual(report.unused_ranges, [(1, 10), (31, 100)])


class LocationBindingTests(SimpleTestCase):
    """Tests for native location binding validation."""

    def test_required_binding_missing(self):
        """A required binding which is absent is an error."""
        report = v.validate_location_binding('drawer', None, required=True)
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_BINDING_INVALID)

    def test_optional_binding_missing(self):
        """An optional binding which is absent is a warning."""
        report = v.validate_location_binding('bin', None, required=False)
        self.assertTrue(report.valid)
        self.assertEqual(report.warnings[0].code, v.CODE_BINDING_INVALID)

    def test_parent_mismatch(self):
        """A location which is not a direct child of the expected parent fails."""
        report = v.validate_location_binding(
            'drawer',
            location(id='loc', parent_id='other'),
            expected_parent={'id': 'cabinet-loc'},
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_BINDING_INVALID)

    def test_parent_match(self):
        """A direct child of the expected parent passes."""
        report = v.validate_location_binding(
            'drawer',
            location(id='loc', parent_id='cabinet-loc', structural=True),
            expected_parent={'id': 'cabinet-loc'},
            structural=True,
        )
        self.assertTrue(report.valid, report.as_dict())

    def test_structural_mismatch(self):
        """An incompatible structural flag fails."""
        report = v.validate_location_binding(
            'bin', location(id='loc', structural=True), structural=False
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_BINDING_INVALID)

    def test_external_location_rejected(self):
        """An external location cannot be bound."""
        report = v.validate_location_binding(
            'bin', location(id='loc', external=True), structural=False
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_BINDING_INVALID)

    def test_role_reuse_rejected(self):
        """A native location cannot serve two plugin roles."""
        report = v.validate_native_location_roles(
            {'id': 'shared'}, [{'id': 'shared'}], []
        )
        self.assertFalse(report.valid)
        self.assertEqual(report.errors[0].code, v.CODE_BINDING_INVALID)


class ReportTests(SimpleTestCase):
    """Tests for the validation report container."""

    def test_report_shape(self):
        """The report serialises to the documented error shape."""
        report = v.ValidationReport()
        report.add_error(v.CODE_MAPPING_GAP, 'gap', path='spans', related_ids=['a'])
        report.add_warning(v.CODE_UNSUPPORTED_CONFIGURATION, 'unsupported')

        payload = report.as_dict()

        self.assertEqual(set(payload.keys()), {'errors', 'warnings', 'unused_ranges'})
        self.assertEqual(payload['errors'][0]['code'], v.CODE_MAPPING_GAP)
        self.assertEqual(payload['errors'][0]['related_ids'], ['a'])
        self.assertEqual(
            payload['warnings'][0]['code'], v.CODE_UNSUPPORTED_CONFIGURATION
        )

    def test_extend_merges_reports(self):
        """Reports can be merged."""
        first = v.ValidationReport()
        second = v.ValidationReport()
        second.add_error(v.CODE_INVALID_BOUNDS, 'bad')
        second.unused_ranges.append((1, 2))

        first.extend(second)

        self.assertEqual(len(first.errors), 1)
        self.assertEqual(first.unused_ranges, [(1, 2)])

    def test_raise_for_report(self):
        """A report with errors raises a ValidationError."""
        report = v.ValidationReport()
        report.add_error(v.CODE_INVALID_BOUNDS, 'bad', path='x')

        with self.assertRaises(ValidationError):
            v.raise_for_report(report)

        v.raise_for_report(v.ValidationReport())
