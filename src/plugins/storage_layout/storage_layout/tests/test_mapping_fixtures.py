"""Shared mapping-translation fixture parity tests (Python side).

This module consumes the single canonical fixture at
``src/plugins/storage_layout/shared/mapping_fixtures.json``. The TypeScript
suite (``frontend/tests/mapping-fixtures.test.ts``) consumes the *same* file, so
the two translators cannot drift: any divergence in forward/reverse handling,
multi-controller splitting, split outputs, gaps, overlaps, partial ranges or
zero-based half-open physical indices fails one of the two suites.

The fixture is deliberately data-only; this module builds the span-like objects
the pure translator expects from the fixture topology.
"""

import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from storage_layout import mapping

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / 'shared' / 'mapping_fixtures.json'
)


def load_fixture():
    """Load the canonical fixture document."""
    with FIXTURE_PATH.open(encoding='utf-8') as handle:
        return json.load(handle)


def build_topology(document, topology_id):
    """Return ``{string_id: string_node}`` for a fixture topology."""
    topology = document['topologies'][topology_id]
    nodes = {}

    for controller in topology['controllers']:
        for output in controller['outputs']:
            for string in output['strings']:
                nodes[string['id']] = {
                    'id': string['id'],
                    'label': string['label'],
                    'output_offset': string['output_offset'],
                    'pixel_count': string['pixel_count'],
                    'output': {
                        'id': output['id'],
                        'bus_index': output['bus_index'],
                        'wled_start': output['wled_start'],
                        'pixel_count': output['pixel_count'],
                        'controller': {
                            'id': controller['id'],
                            'name': controller['name'],
                        },
                    },
                }

    return nodes


def build_spans(document, topology_id, span_specs):
    """Build span-like objects from fixture span specifications."""
    nodes = build_topology(document, topology_id)
    spans = []

    for spec in span_specs:
        node = nodes[spec['string']]
        spans.append({
            'id': f"{spec['string']}-{spec['logical_start']}",
            'logical_start': spec['logical_start'],
            'length': spec['length'],
            'string_offset': spec['string_offset'],
            'direction': spec['direction'],
            'string': node,
        })

    return spans


class SharedMappingFixtureTests(SimpleTestCase):
    """Run every canonical fixture case through the Python translator."""

    def test_fixture_file_exists(self):
        """The canonical fixture must be present and parseable."""
        document = load_fixture()
        self.assertEqual(document['schema_version'], 1)
        self.assertTrue(document['cases'])

    def test_all_cases(self):
        """Every fixture case must match the Python translator exactly."""
        document = load_fixture()
        self.assertTrue(document['cases'])

        for case in document['cases']:
            with self.subTest(case=case['name']):
                spans = build_spans(document, case['topology'], case['spans'])
                request = case['request']
                expect = case['expect']

                if 'error' in expect:
                    with self.assertRaises(ValidationError) as ctx:
                        mapping.translate(
                            spans,
                            request['start'],
                            request['end'],
                            case['total_pixels'],
                        )
                    self.assertIn(expect['error'], str(ctx.exception))
                else:
                    runs = mapping.translate(
                        spans,
                        request['start'],
                        request['end'],
                        case['total_pixels'],
                    )
                    self.assertEqual(runs, expect['runs'])
