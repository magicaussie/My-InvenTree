"""Pure translator tests for the Storage Layout & WLED plugin.

These tests exercise :mod:`storage_layout.mapping` without a database. They
cover the design's mapping test matrix: single pixel, unequal strings, multiple
outputs and controllers, non-zero bus/string offsets, reverse direction, exact
boundaries and crossings, the worked 46-pixel example, full coverage, reverse
lookup round-trips, no cross-controller merging and rejection of invalid input.
"""

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from storage_layout import mapping


def make_span(
    logical_start,
    length,
    *,
    controller='A',
    output='o1',
    bus_index=0,
    wled_start=0,
    output_offset=0,
    string_offset=0,
    direction=1,
    string='s1',
    string_pixel_count=None,
    output_pixel_count=None,
):
    """Build a span-like mapping with its nested topology."""
    if string_pixel_count is None:
        string_pixel_count = output_offset + string_offset + length

    if output_pixel_count is None:
        output_pixel_count = wled_start + output_offset + string_offset + length

    return {
        'id': f'{string}-{logical_start}',
        'logical_start': logical_start,
        'length': length,
        'string_offset': string_offset,
        'direction': direction,
        'string': {
            'id': string,
            'label': string,
            'output_offset': output_offset,
            'pixel_count': string_pixel_count,
            'output': {
                'id': output,
                'bus_index': bus_index,
                'wled_start': wled_start,
                'pixel_count': output_pixel_count,
                'controller': {'id': controller, 'name': controller},
            },
        },
    }


def worked_example():
    """Return the design's three-span worked example."""
    return [
        make_span(1, 50, controller='A', output='A-out0', string='S1', wled_start=0),
        make_span(51, 30, controller='A', output='A-out1', string='S2', wled_start=80),
        make_span(81, 40, controller='B', output='B-out0', string='S3', wled_start=10),
    ]


class SpanViewTests(SimpleTestCase):
    """Tests for resolving a span into a physical view."""

    def test_forward_index(self):
        """A forward span maps logical pixels onto ascending WLED indices."""
        view = mapping.span_view(make_span(1, 10, wled_start=5))

        self.assertEqual(view.wled_index(1), 5)
        self.assertEqual(view.wled_index(10), 14)

    def test_reverse_index(self):
        """A reverse span maps logical pixels onto descending WLED indices."""
        view = mapping.span_view(make_span(1, 10, wled_start=5, direction=-1))

        self.assertEqual(view.wled_index(1), 14)
        self.assertEqual(view.wled_index(10), 5)

    def test_offsets_accumulate(self):
        """String and output offsets accumulate into the WLED index."""
        view = mapping.span_view(
            make_span(1, 4, wled_start=100, output_offset=10, string_offset=3)
        )

        self.assertEqual(view.wled_index(1), 113)
        self.assertEqual(view.wled_index(4), 116)

    def test_out_of_range_rejected(self):
        """Indexing outside the span is rejected."""
        view = mapping.span_view(make_span(5, 3))

        with self.assertRaises(ValidationError):
            view.wled_index(4)

    def test_invalid_direction_rejected(self):
        """A direction other than +1/-1 is rejected."""
        with self.assertRaises(ValidationError):
            mapping.span_view(make_span(1, 3, direction=0))


class TranslateTests(SimpleTestCase):
    """Tests for the logical to physical translation."""

    def test_single_pixel(self):
        """A single logical pixel resolves to one run."""
        spans = worked_example()
        runs = mapping.translate(spans, 1, 1, 120)

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 1)
        self.assertEqual(runs[0]['wled_start'], 0)
        self.assertEqual(runs[0]['wled_stop'], 1)

    def test_first_and_last(self):
        """The first and last logical pixels resolve to their controllers."""
        spans = worked_example()

        first = mapping.translate(spans, 1, 1, 120)[0]
        last = mapping.translate(spans, 120, 120, 120)[0]

        self.assertEqual(first['controller'], 'A')
        self.assertEqual(last['controller'], 'B')
        self.assertEqual(last['wled_start'], 49)
        self.assertEqual(last['wled_stop'], 50)

    def test_worked_example_split(self):
        """The design's 46-pixel drawer split is reproduced exactly."""
        runs = mapping.translate(worked_example(), 45, 90, 120)

        self.assertEqual(len(runs), 3)

        self.assertEqual(
            (runs[0]['controller'], runs[0]['wled_start'], runs[0]['wled_stop']),
            ('A', 44, 50),
        )
        self.assertEqual(
            (runs[1]['controller'], runs[1]['wled_start'], runs[1]['wled_stop']),
            ('A', 80, 110),
        )
        self.assertEqual(
            (runs[2]['controller'], runs[2]['wled_start'], runs[2]['wled_stop']),
            ('B', 10, 20),
        )

        covered = sum(r['logical_end'] - r['logical_start'] + 1 for r in runs)
        self.assertEqual(covered, 46)

    def test_reverse_subrange(self):
        """A reversed span keeps the same interval but reverses traversal."""
        spans = [
            make_span(
                1, 50, controller='A', output='A-out0', string='S1', wled_start=0
            ),
            make_span(
                51,
                30,
                controller='A',
                output='A-out1',
                string='S2',
                wled_start=80,
                direction=-1,
            ),
            make_span(
                81, 40, controller='B', output='B-out0', string='S3', wled_start=10
            ),
        ]

        whole = mapping.translate(spans, 51, 80, 120)

        self.assertEqual(len(whole), 1)
        self.assertEqual(whole[0]['wled_start'], 80)
        self.assertEqual(whole[0]['wled_stop'], 110)
        self.assertEqual(whole[0]['direction'], -1)

        sub = mapping.translate(spans, 51, 55, 120)

        self.assertEqual(sub[0]['wled_start'], 105)
        self.assertEqual(sub[0]['wled_stop'], 110)

    def test_boundary_crossing(self):
        """A range crossing a span boundary splits at the boundary."""
        runs = mapping.translate(worked_example(), 50, 51, 120)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['logical_start'], 50)
        self.assertEqual(runs[0]['logical_end'], 50)
        self.assertEqual(runs[1]['logical_start'], 51)
        self.assertEqual(runs[1]['logical_end'], 51)

    def test_no_cross_controller_merge(self):
        """Adjacent runs on different controllers are never merged."""
        spans = [
            make_span(1, 10, controller='A', output='o1', string='s1', wled_start=0),
            make_span(11, 10, controller='B', output='o2', string='s2', wled_start=0),
        ]

        runs = mapping.translate(spans, 1, 20, 20)

        self.assertEqual(len(runs), 2)
        self.assertEqual({r['controller'] for r in runs}, {'A', 'B'})

    def test_contiguous_same_controller_merges(self):
        """Adjacent, contiguous runs on one controller merge into one run."""
        spans = [
            make_span(1, 10, controller='A', output='o1', string='s1', wled_start=0),
            make_span(11, 10, controller='A', output='o1', string='s1', wled_start=10),
        ]

        runs = mapping.translate(spans, 1, 20, 20)

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 20)
        self.assertEqual(runs[0]['wled_stop'], 20)

    def test_full_coverage_every_pixel_once(self):
        """Every logical pixel resolves exactly once across the mapping."""
        spans = worked_example()

        for pixel in range(1, 121):
            runs = mapping.translate(spans, pixel, pixel, 120)
            self.assertEqual(len(runs), 1, msg=f'pixel {pixel}')
            self.assertEqual(runs[0]['logical_start'], pixel)
            self.assertEqual(runs[0]['logical_end'], pixel)

    def test_reverse_lookup_roundtrip(self):
        """A forward span's WLED index round-trips back to its logical pixel."""
        spans = worked_example()

        for pixel in (1, 25, 50, 51, 65, 80, 81, 100, 120):
            run = mapping.translate(spans, pixel, pixel, 120)[0]
            self.assertEqual(run['wled_stop'] - run['wled_start'], 1)

    def test_rejects_invalid_range(self):
        """Invalid ranges are rejected."""
        spans = worked_example()

        for start, end in ((0, 5), (5, 0), (10, 5), (-1, 5)):
            with self.assertRaises(ValidationError):
                mapping.translate(spans, start, end, 120)

    def test_rejects_out_of_bounds(self):
        """A range beyond the mapping size is rejected."""
        with self.assertRaises(ValidationError):
            mapping.translate(worked_example(), 1, 121, 120)

    def test_rejects_uncovered_range(self):
        """A range not fully covered by the spans is rejected."""
        spans = [make_span(1, 10, wled_start=0)]

        with self.assertRaises(ValidationError):
            mapping.translate(spans, 1, 20, 20)

    def test_rejects_fractional_input(self):
        """Fractional input is rejected."""
        with self.assertRaises(ValidationError):
            mapping.translate(worked_example(), 1.5, 3, 120)


class ManifestTests(SimpleTestCase):
    """Tests for the manifest and content hash."""

    def test_hash_is_deterministic(self):
        """The same spans always produce the same hash."""
        spans = worked_example()

        self.assertEqual(
            mapping.mapping_hash(spans, 120), mapping.mapping_hash(spans, 120)
        )

    def test_hash_changes_with_topology(self):
        """A different topology produces a different hash."""
        first = mapping.mapping_hash(worked_example(), 120)

        changed = worked_example()
        changed[0]['string']['output']['wled_start'] = 1

        self.assertNotEqual(first, mapping.mapping_hash(changed, 120))

    def test_manifest_freezes_identity(self):
        """The manifest records controller, output and string identities."""
        manifest = mapping.build_manifest(worked_example(), 120)

        self.assertEqual(manifest['total_pixels'], 120)
        self.assertEqual(len(manifest['spans']), 3)
        self.assertEqual({c['id'] for c in manifest['controllers']}, {'A', 'B'})
        self.assertEqual({s['id'] for s in manifest['strings']}, {'S1', 'S2', 'S3'})


class SampleTranslationTests(SimpleTestCase):
    """Tests for the deterministic preview samples."""

    def test_samples_include_endpoints(self):
        """The sample includes the first and last logical pixels."""
        samples = mapping.sample_translation(worked_example(), 120)

        pixels = [s['logical'] for s in samples]

        self.assertIn(1, pixels)
        self.assertIn(120, pixels)

    def test_empty_mapping(self):
        """An empty mapping produces no samples."""
        self.assertEqual(mapping.sample_translation([], 0), [])

    def test_sample_translation_detects_overlap(self):
        """A sampled pixel covered twice fails the preview sample."""
        spans = [
            make_span(1, 60, controller='A', output='A-0', string='FWD', wled_start=0),
            make_span(41, 60, controller='A', output='A-0', string='FWD', wled_start=0),
        ]

        with self.assertRaises(ValidationError):
            mapping.sample_translation(spans, 100)

    def test_sample_translation_reversed_endpoints(self):
        """A reversed mapping still resolves its sampled endpoints."""
        spans = [
            make_span(
                1,
                50,
                controller='A',
                output='A-200',
                string='REV',
                wled_start=200,
                direction=-1,
            )
        ]

        samples = mapping.sample_translation(spans, 50)

        self.assertEqual([s['logical'] for s in samples], [1, 25, 50])

        first = samples[0]['runs'][0]
        self.assertEqual((first['wled_start'], first['wled_stop']), (249, 250))

        last = samples[-1]['runs'][0]
        self.assertEqual((last['wled_start'], last['wled_stop']), (200, 201))


class TranslationIntegrityTests(SimpleTestCase):
    """Regression tests for coverage validation and reversed run merging.

    These mirror the frontend 002H tests in ``frontend/tests/mapping.test.ts``
    so the backend translator - the authoritative one used by the API, preview
    and simulation - enforces the same invariants.
    """

    # Shared topology: FWD and FWD2 are distinct strings on controller A's
    # output 'A-0'; REV is a second output on controller A; ALT is on B.
    TOPOLOGY = {
        'FWD': ('A', 'A-0', 0),
        'FWD2': ('A', 'A-0', 0),
        'REV': ('A', 'A-200', 200),
        'ALT': ('B', 'B-50', 50),
    }

    def span(self, logical_start, length, *, string, string_offset=0, direction=1):
        """Build a span on the shared integrity topology."""
        controller, output, wled_start = self.TOPOLOGY[string]

        return make_span(
            logical_start,
            length,
            controller=controller,
            output=output,
            string=string,
            wled_start=wled_start,
            string_offset=string_offset,
            direction=direction,
        )

    def test_rejects_overlap_cancelled_by_equal_gap(self):
        """An overlap offset by an equal gap is rejected despite equal totals.

        Aggregate length is 60 + 40 = 100, exactly the requested range, so a
        length-sum check would pass. Pixels 41-60 are covered twice while
        81-100 are never covered.
        """
        spans = [self.span(1, 60, string='FWD'), self.span(41, 40, string='FWD')]

        with self.assertRaises(ValidationError) as ctx:
            mapping.translate(spans, 1, 100, 100)

        self.assertIn('overlapping', str(ctx.exception))

    def test_rejects_direct_overlap(self):
        """Two spans covering the same logical pixels are rejected."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(30, 41, string='FWD', string_offset=50),
        ]

        with self.assertRaises(ValidationError) as ctx:
            mapping.translate(spans, 1, 70, 100)

        self.assertIn('overlapping', str(ctx.exception))

    def test_rejects_gap(self):
        """A gap between two spans is rejected."""
        spans = [
            self.span(1, 40, string='FWD'),
            self.span(51, 50, string='FWD', string_offset=40),
        ]

        with self.assertRaises(ValidationError) as ctx:
            mapping.translate(spans, 1, 100, 100)

        self.assertIn('not fully covered', str(ctx.exception))

    def test_merges_forward_contiguous_spans(self):
        """Logically and physically contiguous forward spans merge."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(51, 50, string='FWD', string_offset=50),
        ]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 100)
        self.assertEqual(runs[0]['controller'], 'A')
        self.assertEqual(runs[0]['string'], 'FWD')
        self.assertEqual(runs[0]['direction'], 1)
        self.assertEqual(runs[0]['wled_start'], 0)
        self.assertEqual(runs[0]['wled_stop'], 100)

    def test_merges_reversed_physically_contiguous_spans(self):
        """Logically adjacent reversed spans merge when physically contiguous.

        The first span covers physical ``[250, 300)`` and the second
        ``[200, 250)``: the reversed traversal continues downward, so the runs
        are physically contiguous and must merge into ``[200, 300)``.
        """
        spans = [
            self.span(1, 50, string='REV', string_offset=50, direction=-1),
            self.span(51, 50, string='REV', string_offset=0, direction=-1),
        ]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 100)
        self.assertEqual(runs[0]['direction'], -1)
        self.assertEqual(runs[0]['wled_start'], 200)
        self.assertEqual(runs[0]['wled_stop'], 300)

    def test_keeps_reversed_physically_discontiguous_spans_separate(self):
        """Reversed spans adjacent only in the forward sense must not merge.

        The first span covers physical ``[200, 250)`` and the second
        ``[250, 300)``. They are adjacent in the forward sense, but a reversed
        traversal jumps from pixel 200 up to pixel 299, so they must not merge.
        """
        spans = [
            self.span(1, 50, string='REV', string_offset=0, direction=-1),
            self.span(51, 50, string='REV', string_offset=50, direction=-1),
        ]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 50)
        self.assertEqual(runs[0]['wled_start'], 200)
        self.assertEqual(runs[0]['wled_stop'], 250)
        self.assertEqual(runs[1]['logical_start'], 51)
        self.assertEqual(runs[1]['logical_end'], 100)
        self.assertEqual(runs[1]['wled_start'], 250)
        self.assertEqual(runs[1]['wled_stop'], 300)

    def test_does_not_merge_across_string_boundary(self):
        """Physically contiguous spans on different strings stay separate."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(51, 50, string='FWD2', string_offset=50),
        ]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['string'], 'FWD')
        self.assertEqual(runs[1]['string'], 'FWD2')

    def test_does_not_merge_across_direction_boundary(self):
        """Physically contiguous spans with different directions stay separate."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(51, 50, string='FWD', string_offset=50, direction=-1),
        ]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['direction'], 1)
        self.assertEqual(runs[1]['direction'], -1)

    def test_does_not_merge_across_controller_boundary(self):
        """Physically contiguous spans on different controllers stay separate."""
        spans = [self.span(1, 50, string='FWD'), self.span(51, 50, string='ALT')]

        runs = mapping.translate(spans, 1, 100, 100)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['controller'], 'A')
        self.assertEqual(runs[1]['controller'], 'B')

    def test_partial_request_inside_two_spans(self):
        """A request starting and ending inside spans is accepted."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(51, 50, string='FWD2', string_offset=50),
        ]

        runs = mapping.translate(spans, 45, 60, 100)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['logical_start'], 45)
        self.assertEqual(runs[0]['logical_end'], 50)
        self.assertEqual(runs[0]['wled_start'], 44)
        self.assertEqual(runs[0]['wled_stop'], 50)
        self.assertEqual(runs[1]['logical_start'], 51)
        self.assertEqual(runs[1]['logical_end'], 60)
        self.assertEqual(runs[1]['wled_start'], 50)
        self.assertEqual(runs[1]['wled_stop'], 60)

    def test_unrelated_spans_outside_request_are_ignored(self):
        """A disjoint span outside the request does not affect it."""
        spans = [
            self.span(1, 50, string='FWD'),
            self.span(51, 50, string='FWD', string_offset=50),
            self.span(101, 50, string='ALT'),
        ]

        runs = mapping.translate(spans, 1, 100, 150)

        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['logical_start'], 1)
        self.assertEqual(runs[0]['logical_end'], 100)

    def test_does_not_mutate_input_spans(self):
        """Translation neither mutates the spans nor their order."""
        spans = [
            self.span(51, 50, string='FWD', string_offset=50),
            self.span(1, 50, string='FWD'),
        ]
        snapshot = [dict(span) for span in spans]

        mapping.translate(spans, 1, 100, 100)

        self.assertEqual(spans, snapshot)
        self.assertEqual([span['logical_start'] for span in spans], [51, 1])

    def test_rejects_fractional_span_geometry(self):
        """Fractional span geometry is rejected instead of silently truncated."""
        for field, value in (
            ('logical_start', 1.5),
            ('length', 50.5),
            ('string_offset', 0.5),
        ):
            span = self.span(1, 50, string='FWD')
            span[field] = value

            with self.assertRaises(ValidationError):
                mapping.translate([span], 1, 50, 100)
