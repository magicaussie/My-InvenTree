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
