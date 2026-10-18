"""Tests for the bounded WLED adapter (``storage_layout.wled``).

Every test runs against the in-memory simulation transport or an injected
recording transport. No test opens a socket: the network-touching transport
refuses unless explicitly enabled, and one test additionally proves the whole
observation/apply/clear path works with ``socket`` monkeypatched to fail.

Coverage follows the design's WLED fixture and simulation test matrix:
origin/SSRF allowlisting, redaction, parsing/normalisation, capability, config
fingerprint/diff, bounded individual-pixel chunking, the safe protocol ordering
(backup before master-on and before the first pixel), clear/stop confirmation,
ambiguous-write handling and fail-closed defaults.
"""

import socket
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from storage_layout import wled
from storage_layout.wled import (
    AllowlistEntry,
    AllowlistError,
    AmbiguousWriteError,
    ConfigDriftError,
    ControllerError,
    FakeWledTransport,
    HttpTransport,
    MalformedResponseError,
    OriginPolicy,
    OutOfRangeError,
    PayloadTooLargeError,
    PixelRun,
    PreflightError,
    ProtocolError,
    RecordingTransport,
    Response,
    ResponseTooLargeError,
    TransportTimeoutError,
    TransportUnavailableError,
    UnsafeOriginError,
    UnsupportedConfigError,
    WledAdapter,
    WledConnection,
)

# region fixtures


def info_fixture(count=120, **overrides):
    """Return a typical ``/json/info`` fixture."""
    data = {
        'ver': '0.16.0',
        'vid': 2601010,
        'leds': {
            'count': count,
            'rgbw': False,
            'pwr': 120,
            'maxpwr': 850,
            'maxseg': 16,
            'lc': 1,
            'seglc': [1],
        },
        'name': 'WLED-Test',
        'udpport': 21324,
        'live': False,
        'fxcount': 80,
        'palcount': 71,
        'arch': 'esp32',
        'freeheap': 13264,
        'uptime': 17985,
        'brand': 'WLED',
        'product': 'FOSS',
        'mac': '60019423b441',
        'wifi': {'bssid': 'aa:bb:cc:dd:ee:ff', 'signal': 80, 'channel': 6},
        'ip': '10.20.30.40',
    }
    data.update(overrides)
    return data


def outputs_fixture(ins=None):
    """Return a typical ``hw.led.ins`` fixture."""
    if ins is not None:
        return ins

    return [
        {
            'start': 0,
            'len': 50,
            'pin': [16],
            'order': 0,
            'rev': False,
            'skip': 0,
            'type': 22,
        },
        {
            'start': 80,
            'len': 70,
            'pin': [18],
            'order': 0,
            'rev': False,
            'skip': 0,
            'type': 30,
        },
    ]


def cfg_fixture(ins=None, **led_overrides):
    """Return a typical ``/json/cfg`` fixture including secrets to be redacted."""
    led = {'total': 120, 'maxpwr': 850, 'ledma': 55, 'ins': outputs_fixture(ins)}
    led.update(led_overrides)

    return {
        'hw': {'led': led},
        'wifi': {'sta': {'ssid': 'secret-network', 'psk': 'hunter2'}},
        'ota': {'pass': 'otapass'},
    }


HOST = 'wled-a.local'
ORIGIN = f'http://{HOST}'
MOCK_ADDRESS = '10.20.30.40'


def policy(*, host=HOST, port=None, address=MOCK_ADDRESS, entries=None, resolver=None):
    """Build an allowlist policy with a deterministic resolver."""
    if entries is None:
        entries = (AllowlistEntry(host=host, port=port),)

    if resolver is None:

        def resolver(value):
            return [address] if value == host else []

    return OriginPolicy(entries=entries, resolver=resolver)


def controller(pk='ctrl-a', origin=ORIGIN, **overrides):
    """Build a controller-like object (a plain mapping)."""
    data = {
        'pk': pk,
        'origin': origin,
        'name': 'Controller A',
        'commissioning_policy': {},
    }
    data.update(overrides)
    return data


def adapter(transport, *, policy_obj=None, **options):
    """Build an adapter wired to a transport and deterministic policy."""
    return WledAdapter(transport=transport, policy=policy_obj or policy(), **options)


def device(info=None, cfg=None, state=None, pins=None, failures=None):
    """Build an in-memory simulated device."""
    return FakeWledTransport(
        info if info is not None else info_fixture(),
        cfg if cfg is not None else cfg_fixture(),
        state,
        pins,
        failures=failures,
    )


def plan(runs, pk='ctrl-a', profile=None, duration=60):
    """Build a session plan for one controller."""
    return {
        'runs': runs,
        'controllers': [pk],
        'profile': profile or {'rgb': [0, 255, 0], 'white': 0, 'brightness': 64},
        'duration_seconds': duration,
    }


def make_run(wled_start, wled_stop, pk='ctrl-a', logical_start=1):
    """Build a single plan run."""
    return {
        'logical_start': logical_start,
        'logical_end': logical_start + (wled_stop - wled_start) - 1,
        'controller': pk,
        'output': 'out-1',
        'string': 'str-1',
        'wled_start': wled_start,
        'wled_stop': wled_stop,
        'direction': 1,
    }


def state_posts(transport):
    """Return the POST ``/json/state`` bodies recorded by a transport."""
    return [
        request['body']
        for request in transport.requests
        if request['method'] == 'POST' and request['path'] == wled.PATH_STATE
    ]


def has_individual(body):
    """Return True when a recorded body carries an individual-pixel array."""
    segments = (body or {}).get('seg')

    return bool(segments) and any('i' in entry for entry in segments)


# endregion


# region origin / SSRF policy


class OriginPolicyTests(SimpleTestCase):
    """Tests for the SSRF allowlist boundary."""

    def test_canonicalises_and_accepts_listed_host(self):
        """An allowlisted host is canonicalised and its address pinned."""
        resolved = policy().check('HTTP://WLED-A.LOCAL:80/')

        self.assertEqual(resolved.value, ORIGIN)
        self.assertEqual(resolved.host, HOST)
        self.assertEqual(resolved.addresses, (MOCK_ADDRESS,))

    def test_rejects_missing_scheme_and_path(self):
        """Non-canonical origins are rejected."""
        for value in ('wled-a.local', 'ftp://wled-a.local', 'http://wled-a.local/path'):
            with self.assertRaises(UnsafeOriginError):
                policy().check(value)

    def test_rejects_userinfo_query_fragment(self):
        """Origins carrying credentials, query or fragment are rejected."""
        for value in (
            'http://user:pass@wled-a.local',
            'http://wled-a.local?x=1',
            'http://wled-a.local#frag',
        ):
            with self.assertRaises(UnsafeOriginError):
                policy().check(value)

    def test_rejects_without_allowlist(self):
        """An empty allowlist denies every origin (fail closed)."""
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(entries=(), resolver=lambda host: ['10.0.0.1']).check(ORIGIN)

    def test_rejects_unlisted_host(self):
        """A host outside the allowlist is rejected."""
        with self.assertRaises(UnsafeOriginError):
            policy(host='other.local').check(ORIGIN)

    def test_rejects_port_mismatch(self):
        """A host entry constrains the port when one is supplied."""
        with self.assertRaises(UnsafeOriginError):
            policy(port=8080).check(ORIGIN)

    def test_accepts_matching_port(self):
        """A host:port entry matches the same port only."""
        resolved = policy(port=8081).check('http://wled-a.local:8081')
        self.assertEqual(resolved.port, 8081)

    def test_rejects_loopback_literal(self):
        """A loopback address is rejected even when explicitly allowlisted."""
        entries = (AllowlistEntry(host='127.0.0.1'),)
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(entries=entries, resolver=lambda host: []).check(
                'http://127.0.0.1'
            )

    def test_rejects_metadata_link_local(self):
        """The cloud metadata endpoint is rejected."""
        entries = (AllowlistEntry(host='169.254.169.254'),)
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(entries=entries, resolver=lambda host: []).check(
                'http://169.254.169.254'
            )

    def test_rejects_forbidden_literals(self):
        """Unspecified, multicast and reserved literals are rejected."""
        for host in ('0.0.0.0', '224.0.0.1', '240.0.0.1'):
            entries = (AllowlistEntry(host=host),)
            with self.assertRaises(UnsafeOriginError):
                OriginPolicy(entries=entries, resolver=lambda value: []).check(
                    f'http://{host}'
                )

    def test_rejects_ipv4_mapped_ipv6_loopback(self):
        """An IPv4-mapped IPv6 loopback is unwrapped and rejected."""
        entries = (AllowlistEntry(host='::ffff:127.0.0.1'),)
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(entries=entries, resolver=lambda value: []).check(
                'http://[::ffff:127.0.0.1]'
            )

    def test_cidr_allowlist_accepts_inside(self):
        """A resolved address inside an allowlisted CIDR is accepted."""
        entries = _cidr_entries('10.0.0.0/8')
        resolved = OriginPolicy(
            entries=entries, resolver=lambda host: ['10.1.2.3']
        ).check('http://wled-a.local')

        self.assertEqual(resolved.addresses, ('10.1.2.3',))

    def test_cidr_allowlist_rejects_outside(self):
        """A resolved address outside the allowlisted CIDR is rejected."""
        entries = _cidr_entries('10.0.0.0/8')
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(entries=entries, resolver=lambda host: ['192.168.1.1']).check(
                'http://wled-a.local'
            )

    def test_rejects_rebinding_to_forbidden_address(self):
        """All resolved addresses must be permitted (no partial pinning)."""
        entries = _cidr_entries('10.0.0.0/8')
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(
                entries=entries, resolver=lambda host: ['10.1.2.3', '127.0.0.1']
            ).check('http://wled-a.local')

    def test_rejects_unresolved_host(self):
        """A host that does not resolve is rejected."""
        with self.assertRaises(UnsafeOriginError):
            OriginPolicy(
                entries=(AllowlistEntry(host=HOST),), resolver=lambda h: []
            ).check(ORIGIN)

    def test_invalid_allowlist_entry_raises(self):
        """A malformed allowlist entry fails loudly."""
        with self.assertRaises(AllowlistError):
            wled.parse_allowlist('10.0.0.0/999')

    def test_parse_allowlist_mixed(self):
        """CIDR and host:port entries parse together."""
        entries = wled.parse_allowlist('10.0.0.0/8, wled-a.local:8080, [fd00::1]')

        self.assertEqual(len(entries), 3)
        self.assertIsNotNone(entries[0].network)
        self.assertEqual(entries[1].host, 'wled-a.local')
        self.assertEqual(entries[1].port, 8080)
        self.assertEqual(entries[2].host, 'fd00::1')

    def test_host_header_ipv6_and_port(self):
        """The Host header brackets IPv6 and keeps non-default ports."""
        entries = _cidr_entries('fd00::/8')
        resolved = OriginPolicy(
            entries=entries, resolver=lambda host: ['fd00::1']
        ).check('https://wled-a.local:8443')

        self.assertEqual(resolved.host_header, 'wled-a.local:8443')

        literal = OriginPolicy(
            entries=_cidr_entries('fd00::/8'), resolver=lambda host: []
        ).check('http://[fd00::1]')
        self.assertEqual(literal.host_header, '[fd00::1]')


def _cidr_entries(text):
    """Return parsed allowlist entries for a CIDR string."""
    import ipaddress

    return (AllowlistEntry(network=ipaddress.ip_network(text, strict=False)),)


# endregion


# region transport


class TransportTests(SimpleTestCase):
    """Tests for the bounded, injectable transport."""

    def test_http_transport_fails_closed(self):
        """The HTTP transport refuses to act unless network access is enabled."""
        transport = HttpTransport()
        origin = policy().check(ORIGIN)

        with self.assertRaises(TransportUnavailableError):
            transport.request('GET', origin, wled.PATH_INFO)

    def test_http_transport_builds_pinned_request(self):
        """When enabled, the HTTP transport pins the address and sets headers."""
        captured = {}

        def connector(method, origin, path, headers, body, timeout):
            captured.update(
                {
                    'method': method,
                    'origin': origin,
                    'path': path,
                    'headers': headers,
                    'body': body,
                    'timeout': timeout,
                }
            )
            return Response(status=200, body=b'{"on":true}')

        transport = HttpTransport(allow_network=True, connector=connector)
        origin = policy().check(ORIGIN)
        response = transport.request(
            'POST', origin, wled.PATH_STATE, json_body={'on': True}
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(captured['method'], 'POST')
        self.assertEqual(captured['origin'].addresses, (MOCK_ADDRESS,))
        self.assertEqual(captured['headers']['Host'], HOST)
        self.assertEqual(captured['headers']['Content-Type'], 'application/json')
        self.assertEqual(captured['body'], b'{"on":true}')

    def test_recording_transport_requires_script(self):
        """An unscripted recording transport fails closed."""
        origin = policy().check(ORIGIN)

        with self.assertRaises(TransportUnavailableError):
            RecordingTransport().request('GET', origin, wled.PATH_INFO)

    def test_connection_rejects_bad_paths(self):
        """Traversal and absolute URLs are rejected before any request."""
        connection = WledConnection(RecordingTransport(), policy().check(ORIGIN))

        for path in ('http://evil/', '/a/../b', 'json/state', '/json/state x'):
            with self.assertRaises(ProtocolError):
                connection.request('GET', path)

    def test_connection_bounds_response_size(self):
        """An oversized response is rejected."""
        transport = RecordingTransport(
            responses=[Response(status=200, body=b'[' + b'0,' * 40000 + b'0]')]
        )
        connection = WledConnection(
            transport, policy().check(ORIGIN), max_response_bytes=1024
        )

        with self.assertRaises(ResponseTooLargeError):
            connection.get_json(wled.PATH_INFO)

    def test_connection_bounds_response_depth(self):
        """An over-deep response is rejected."""
        deep = '{"a":' * 20 + '0' + '}' * 20
        transport = RecordingTransport(
            responses=[Response(status=200, body=deep.encode())]
        )
        connection = WledConnection(
            transport, policy().check(ORIGIN), max_response_depth=5
        )

        with self.assertRaises(ResponseTooLargeError):
            connection.get_json(wled.PATH_INFO)

    def test_connection_malformed_json(self):
        """A malformed body raises, or returns None when optional."""
        transport = RecordingTransport(
            responses=[
                Response(status=200, body=b'not json'),
                Response(status=200, body=b'not json'),
            ]
        )
        connection = WledConnection(transport, policy().check(ORIGIN))

        with self.assertRaises(MalformedResponseError):
            connection.get_json(wled.PATH_INFO)

        self.assertIsNone(connection.get_json(wled.PATH_CFG, optional=True))

    def test_connection_optional_missing(self):
        """A 404 resource returns None when optional."""
        transport = RecordingTransport(responses=[Response(status=404)])
        connection = WledConnection(transport, policy().check(ORIGIN))

        self.assertIsNone(connection.get_json(wled.PATH_CFG, optional=True))

    def test_connection_non_success_status(self):
        """A non-2xx status raises a ControllerError carrying the status."""
        transport = RecordingTransport(responses=[Response(status=500)])
        connection = WledConnection(transport, policy().check(ORIGIN))

        with self.assertRaises(ControllerError) as ctx:
            connection.get_json(wled.PATH_INFO, retries=0)

        self.assertEqual(ctx.exception.status, 500)

    def test_connection_error_payload(self):
        """A JSON ``error`` value raises."""
        transport = RecordingTransport(
            responses=[Response(status=200, body=b'{"error":9}')]
        )
        connection = WledConnection(transport, policy().check(ORIGIN))

        with self.assertRaises(ControllerError):
            connection.get_json(wled.PATH_INFO)

    def test_get_is_retried_on_timeout(self):
        """Idempotent GETs retry a transient timeout."""
        transport = RecordingTransport(handler=_timeout_then_success())
        connection = WledConnection(transport, policy().check(ORIGIN))

        self.assertEqual(connection.get_json(wled.PATH_INFO), {'ok': True})
        self.assertEqual(len(transport.requests), 2)

    def test_illuminating_write_is_not_retried(self):
        """A POST with no retries is attempted exactly once."""

        def handler(method, origin, path, body):
            raise TransportTimeoutError('scripted')

        transport = RecordingTransport(handler=handler)
        connection = WledConnection(transport, policy().check(ORIGIN))

        with self.assertRaises(TransportTimeoutError):
            connection.post_json(wled.PATH_STATE, {'on': True})

        self.assertEqual(len(transport.requests), 1)

    def test_post_rejects_oversize_payload(self):
        """An outgoing payload beyond the bound is refused."""
        connection = WledConnection(RecordingTransport(), policy().check(ORIGIN))

        with self.assertRaises(PayloadTooLargeError):
            connection.post_json(wled.PATH_STATE, {'seg': [{'i': ['FF0000'] * 4000}]})


def _timeout_then_success():
    """Return a handler which times out once, then succeeds."""
    state = {'calls': 0}

    def handler(method, origin, path, body):
        state['calls'] += 1

        if state['calls'] == 1:
            raise TransportTimeoutError('scripted')

        return Response(status=200, body=b'{"ok": true}')

    return handler


# endregion


# region normalisation / redaction


class NormalisationTests(SimpleTestCase):
    """Tests for redacted parsing and normalisation."""

    def test_info_redaction(self):
        """Telemetry and network details are not retained in redacted info."""
        info = wled.normalise_info(info_fixture())

        self.assertNotIn('wifi', info)
        self.assertNotIn('ip', info)
        self.assertNotIn('uptime', info)
        self.assertNotIn('freeheap', info)
        self.assertEqual(info['mac'], '60:01:94:23:B4:41')
        self.assertEqual(info['leds']['count'], 120)

    def test_runtime_keeps_telemetry_out_of_fingerprint(self):
        """Telemetry lives in the runtime summary, not the fingerprint input."""
        runtime = wled.normalise_runtime(info_fixture(), {'on': True})

        self.assertEqual(runtime['uptime'], 17985)
        self.assertEqual(runtime['signal'], 80)

    def test_config_outputs_mapping(self):
        """Outputs are indexed by position and normalise order/pins/type."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 5,
                    'len': 10,
                    'pin': [16, 255],
                    'order': 4,
                    'rev': True,
                    'skip': 2,
                    'type': 22,
                }
            ]
        )
        outputs = wled.normalise_config(cfg)['outputs']

        self.assertEqual(len(outputs), 1)
        output = outputs[0]

        self.assertEqual(output['bus_index'], 0)
        self.assertEqual(output['wled_start'], 5)
        self.assertEqual(output['pixel_count'], 10)
        self.assertEqual(output['pins'], [16])
        self.assertEqual(output['colour_order'], 'BGR')
        self.assertEqual(output['led_type'], '22')
        self.assertTrue(output['bus_reverse'])
        self.assertEqual(output['skip'], 2)

    def test_config_missing_returns_empty(self):
        """A missing configuration yields an empty output list."""
        self.assertEqual(wled.normalise_config(None)['outputs'], [])

    def test_state_normalisation(self):
        """State normalisation exposes nightlight and segment geometry."""
        state = wled.normalise_state(
            {
                'on': True,
                'bri': 64,
                'nl': {'on': True, 'dur': 2, 'mode': 0, 'tbri': 0},
                'seg': [{'id': 0, 'start': 0, 'stop': 120, 'frz': True}],
            }
        )

        self.assertTrue(state['on'])
        self.assertTrue(state['nightlight']['on'])
        self.assertEqual(state['nightlight']['dur'], 2)
        self.assertEqual(state['segments'][0]['stop'], 120)
        self.assertTrue(state['segments'][0]['frz'])


# endregion


# region capability


class CapabilityTests(SimpleTestCase):
    """Tests for capability classification."""

    def capability(self, info=None, cfg=None, state=None):
        """Evaluate capability for the given raw payloads."""
        return wled.evaluate_capability(info, cfg, state)

    def test_supported_configuration(self):
        """A digital 1D RGB/RGBW configuration is supported."""
        result = self.capability(info_fixture(), cfg_fixture())

        self.assertEqual(result.status, wled.CAPABILITY_SUPPORTED)
        self.assertEqual(result.reasons, [])

    def test_missing_cfg_is_unverified(self):
        """A missing configuration is unverified, never fabricated."""
        result = self.capability(info_fixture(), None)

        self.assertEqual(result.status, wled.CAPABILITY_UNVERIFIED)
        self.assertIn('missing_cfg', [reason['code'] for reason in result.reasons])

    def test_missing_outputs_is_unverified(self):
        """An empty output list is unverified."""
        result = self.capability(info_fixture(), cfg_fixture(ins=[]))

        self.assertEqual(result.status, wled.CAPABILITY_UNVERIFIED)

    def test_reversed_bus_unsupported(self):
        """A reversed bus is unsupported."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': True,
                    'skip': 0,
                    'type': 22,
                }
            ]
        )
        result = self.capability(info_fixture(), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)
        self.assertIn('bus_reverse', [reason['code'] for reason in result.reasons])

    def test_skip_unsupported(self):
        """A non-zero skip is unsupported."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 3,
                    'type': 22,
                }
            ]
        )

        self.assertEqual(
            self.capability(info_fixture(), cfg).status, wled.CAPABILITY_UNSUPPORTED
        )

    def test_non_digital_bus_unsupported(self):
        """Analog and on/off buses are unsupported."""
        for led_type in (40, 41, 45):
            cfg = cfg_fixture(
                ins=[
                    {
                        'start': 0,
                        'len': 120,
                        'pin': [16],
                        'order': 0,
                        'rev': False,
                        'skip': 0,
                        'type': led_type,
                    }
                ]
            )
            self.assertEqual(
                self.capability(info_fixture(), cfg).status,
                wled.CAPABILITY_UNSUPPORTED,
                msg=f'type {led_type}',
            )

    def test_matrix_and_network_bus_unsupported(self):
        """HUB75 and virtual network buses are unsupported."""
        for led_type in (66, 80):
            cfg = cfg_fixture(
                ins=[
                    {
                        'start': 0,
                        'len': 120,
                        'pin': [16],
                        'order': 0,
                        'rev': False,
                        'skip': 0,
                        'type': led_type,
                    }
                ]
            )
            self.assertEqual(
                self.capability(info_fixture(), cfg).status,
                wled.CAPABILITY_UNSUPPORTED,
                msg=f'type {led_type}',
            )

    def test_white_only_bus_unsupported(self):
        """A white-only digital bus is unsupported."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 18,
                }
            ]
        )
        result = self.capability(info_fixture(), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)
        self.assertIn('no_rgb_bus', [reason['code'] for reason in result.reasons])

    def test_unknown_type_is_unverified(self):
        """An unrecognised LED type is unverified (never guessed)."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 99,
                }
            ]
        )

        self.assertEqual(
            self.capability(info_fixture(), cfg).status, wled.CAPABILITY_UNVERIFIED
        )

    def test_known_but_unverified_type_unsupported(self):
        """A known digital RGB type outside the adapter allowlist is unsupported."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 23,
                }
            ]
        )
        result = self.capability(info_fixture(), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)
        self.assertIn(
            'unsupported_led_type', [reason['code'] for reason in result.reasons]
        )

    def test_count_mismatch_is_unverified(self):
        """Bus lengths which do not sum to the reported count are unverified."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 30,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 22,
                }
            ]
        )
        result = self.capability(info_fixture(count=120), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNVERIFIED)
        self.assertIn('count_mismatch', [reason['code'] for reason in result.reasons])

    def test_physical_overlap_unsupported(self):
        """Overlapping bus address ranges are unsupported."""
        ins = [
            {
                'start': 0,
                'len': 60,
                'pin': [16],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
            {
                'start': 40,
                'len': 60,
                'pin': [18],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
        ]
        cfg = cfg_fixture(ins=ins)
        result = self.capability(info_fixture(count=120), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)
        self.assertIn('physical_overlap', [reason['code'] for reason in result.reasons])

    def test_gpio_conflict_unsupported(self):
        """A shared GPIO pin is unsupported."""
        ins = [
            {
                'start': 0,
                'len': 60,
                'pin': [16],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
            {
                'start': 60,
                'len': 60,
                'pin': [16],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
        ]
        cfg = cfg_fixture(ins=ins)
        result = self.capability(info_fixture(count=120), cfg)

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)
        self.assertIn('gpio_conflict', [reason['code'] for reason in result.reasons])

    def test_missing_pins_unverified(self):
        """An output with no declared GPIO is unverified."""
        ins = [
            {
                'start': 0,
                'len': 60,
                'pin': [16],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
            {
                'start': 60,
                'len': 60,
                'pin': [],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
        ]
        cfg = cfg_fixture(ins=ins)

        self.assertEqual(
            self.capability(info_fixture(count=120), cfg).status,
            wled.CAPABILITY_UNVERIFIED,
        )

    def test_ledmap_transform_unsupported(self):
        """A configured ledmap is unsupported."""
        cfg = cfg_fixture(ledmap=True)

        self.assertEqual(
            self.capability(info_fixture(), cfg).status, wled.CAPABILITY_UNSUPPORTED
        )

    def test_matrix_state_unsupported(self):
        """A 2D segment is unsupported."""
        state = {'seg': [{'id': 0, 'start': 0, 'stop': 120, 'startY': 0, 'stopY': 4}]}

        self.assertEqual(
            self.capability(info_fixture(), cfg_fixture(), state).status,
            wled.CAPABILITY_UNSUPPORTED,
        )

    def test_unsupported_wins_over_unverified(self):
        """The worst finding determines the overall status."""
        ins = [
            {
                'start': 0,
                'len': 60,
                'pin': [16],
                'order': 0,
                'rev': True,
                'skip': 0,
                'type': 22,
            },
            {
                'start': 60,
                'len': 70,
                'pin': [18],
                'order': 0,
                'rev': False,
                'skip': 0,
                'type': 22,
            },
        ]
        result = self.capability(info_fixture(count=120), cfg_fixture(ins=ins))

        self.assertEqual(result.status, wled.CAPABILITY_UNSUPPORTED)


# endregion


# region fingerprint / diff


class FingerprintTests(SimpleTestCase):
    """Tests for the configuration fingerprint and structural diff."""

    def fingerprint(self, info=None, cfg=None):
        """Compute the fingerprint for the given fixtures."""
        info = wled.normalise_info(info if info is not None else info_fixture())
        normalised = wled.normalise_config(cfg if cfg is not None else cfg_fixture())

        return wled.config_fingerprint(wled.ADAPTER_VERSION, info, normalised)

    def test_deterministic(self):
        """The same configuration fingerprints identically."""
        self.assertEqual(self.fingerprint(), self.fingerprint())

    def test_identity_change_changes_fingerprint(self):
        """An identity change changes the fingerprint."""
        self.assertNotEqual(
            self.fingerprint(), self.fingerprint(info_fixture(name='Renamed'))
        )

    def test_telemetry_change_does_not_change_fingerprint(self):
        """Telemetry changes do not change the fingerprint."""
        self.assertEqual(
            self.fingerprint(), self.fingerprint(info_fixture(uptime=99999, freeheap=1))
        )

    def test_output_change_changes_fingerprint(self):
        """A bus change changes the fingerprint."""
        changed = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 50,
                    'pin': [16],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 22,
                },
                {
                    'start': 80,
                    'len': 70,
                    'pin': [19],
                    'order': 0,
                    'rev': False,
                    'skip': 0,
                    'type': 30,
                },
            ]
        )

        self.assertNotEqual(self.fingerprint(), self.fingerprint(cfg=changed))

    def test_topology_fingerprint_matches_service_shape(self):
        """The topology fingerprint hashes only the outputs list."""
        plain = wled.topology_fingerprint(wled.normalise_config(cfg_fixture()))
        manual = wled._canonical_hash(
            {'outputs': wled.normalise_config(cfg_fixture())['outputs']}
        )

        self.assertEqual(plain, manual)

    def test_diff_configurations(self):
        """Structural diff reports added, changed and removed outputs."""
        baseline = wled.normalise_config(cfg_fixture())
        current = wled.normalise_config(
            cfg_fixture(
                ins=[
                    {
                        'start': 0,
                        'len': 50,
                        'pin': [16],
                        'order': 0,
                        'rev': False,
                        'skip': 0,
                        'type': 22,
                    },
                    {
                        'start': 80,
                        'len': 90,
                        'pin': [19],
                        'order': 0,
                        'rev': False,
                        'skip': 0,
                        'type': 30,
                    },
                ]
            )
        )
        diff = wled.diff_configurations(baseline, current)

        self.assertTrue(diff['drift'])
        self.assertEqual(len(diff['changed']), 1)
        self.assertIn('pixel_count', diff['changed'][0]['diff'])
        self.assertEqual(diff['removed'], [])

    def test_diff_observations_separates_runtime(self):
        """Runtime telemetry is reported separately from configuration drift."""
        base = {
            'info': wled.normalise_info(info_fixture()),
            'normalised_config': wled.normalise_config(cfg_fixture()),
            'fingerprint': 'a',
            'capability_status': 'supported',
            'runtime': {'uptime': 1},
        }
        current = {**base, 'fingerprint': 'a', 'runtime': {'uptime': 2}}
        diff = wled.diff_observations(base, current)

        self.assertFalse(diff['fingerprint_changed'])
        self.assertFalse(diff['config']['drift'])
        self.assertEqual(diff['runtime']['uptime'], 2)


# endregion


# region chunking


class ChunkingTests(SimpleTestCase):
    """Tests for bounded individual-pixel chunking."""

    def test_single_chunk_range_syntax(self):
        """A small run becomes a single range payload."""
        chunks = wled.chunk_pixel_writes([PixelRun(44, 50, '00FF00')])

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]['seg'][0]['i'], [44, 50, '00FF00'])
        self.assertEqual(chunks[0]['seg'][0]['id'], 0)
        self.assertEqual(chunks[0]['tt'], 0)
        self.assertTrue(chunks[0]['udpn']['nn'])

    def test_large_run_is_split_at_256(self):
        """A run longer than 256 pixels is split across sequential chunks."""
        chunks = wled.chunk_pixel_writes([PixelRun(0, 600, '00FF00')])
        pixels = 0

        for chunk in chunks:
            values = chunk['seg'][0]['i']
            covered = 0

            for index in range(0, len(values), 3):
                covered += values[index + 1] - values[index]

            self.assertLessEqual(covered, wled.MAX_PIXELS_PER_CHUNK)
            pixels += covered

        self.assertEqual(pixels, 600)
        self.assertGreaterEqual(len(chunks), 3)

    def test_multiple_runs_pack_into_one_chunk(self):
        """Adjacent ranges may pack into one chunk while under both bounds."""
        chunks = wled.chunk_pixel_writes(
            [PixelRun(0, 100, 'FF0000'), PixelRun(200, 300, '00FF00')]
        )

        self.assertEqual(len(chunks), 1)
        self.assertEqual(
            chunks[0]['seg'][0]['i'], [0, 100, 'FF0000', 200, 300, '00FF00']
        )

    def test_encoded_payload_within_bound(self):
        """Every chunk encodes within the payload bound."""
        chunks = wled.chunk_pixel_writes([PixelRun(0, 5000, '00FF00')])

        for chunk in chunks:
            self.assertLessEqual(len(wled._encode_json(chunk)), wled.MAX_PAYLOAD_BYTES)

    def test_build_pixel_payload_shape(self):
        """The payload carries an explicit segment id and notification suppression."""
        payload = wled.build_pixel_payload([(1, 3, 'AABBCC')], segment_id=0)

        self.assertEqual(payload['seg'], [{'id': 0, 'i': [1, 3, 'AABBCC']}])
        self.assertTrue(payload['udpn']['nn'])

    def test_prepare_runs_merges_adjacent(self):
        """Adjacent same-colour intervals merge."""
        runs = wled.prepare_pixel_runs([(0, 10), (10, 20)], '00FF00')

        self.assertEqual(len(runs), 1)
        self.assertEqual((runs[0].start, runs[0].stop), (0, 20))

    def test_prepare_runs_rejects_overlap(self):
        """Overlapping intervals are rejected."""
        with self.assertRaises(ProtocolError):
            wled.prepare_pixel_runs([(0, 10), (5, 15)], '00FF00')

    def test_prepare_runs_rejects_empty(self):
        """An empty interval is rejected."""
        with self.assertRaises(ProtocolError):
            wled.prepare_pixel_runs([(5, 5)], '00FF00')

    def test_chunk_rejects_empty_run(self):
        """A zero-length run is rejected during chunking."""
        with self.assertRaises(ProtocolError):
            wled.chunk_pixel_writes([PixelRun(5, 5, '00FF00')])

    def test_payload_bound_rejects_huge_single_piece(self):
        """An impossibly small payload bound is refused, not truncated."""
        with self.assertRaises(PayloadTooLargeError):
            wled.chunk_pixel_writes([PixelRun(0, 256, '00FF00')], max_payload_bytes=8)

    def test_nightlight_minutes(self):
        """The device-backup duration is clamped to 1..2 whole minutes."""
        self.assertEqual(wled.nightlight_minutes(5), 1)
        self.assertEqual(wled.nightlight_minutes(60), 1)
        self.assertEqual(wled.nightlight_minutes(61), 2)
        self.assertEqual(wled.nightlight_minutes(120), 2)
        self.assertEqual(wled.nightlight_minutes(600), 2)


# endregion


# region pixel bounds


class PixelBoundsTests(SimpleTestCase):
    """Tests for the fail-closed physical-address bounds interlock."""

    def test_accepts_intervals_inside_the_device(self):
        """Intervals within ``[0, led_count)`` are accepted."""
        wled.validate_pixel_bounds([(0, 1), (10, 20), (119, 120)], 120)

    def test_rejects_stop_beyond_led_count(self):
        """A half-open interval ending past the LED count is rejected."""
        with self.assertRaises(OutOfRangeError):
            wled.validate_pixel_bounds([(0, 121)], 120)

    def test_rejects_negative_start(self):
        """A negative start index is rejected."""
        with self.assertRaises(OutOfRangeError):
            wled.validate_pixel_bounds([(-1, 10)], 120)

    def test_rejects_empty_interval(self):
        """An empty interval is rejected."""
        with self.assertRaises(OutOfRangeError):
            wled.validate_pixel_bounds([(10, 10)], 120)

    def test_error_carries_diagnostics(self):
        """The rejection reports the offending interval and the LED count."""
        with self.assertRaises(OutOfRangeError) as ctx:
            wled.validate_pixel_bounds([(0, 200)], 120)

        self.assertEqual(ctx.exception.code, 'out_of_range')
        self.assertEqual(ctx.exception.details['led_count'], 120)
        self.assertEqual(ctx.exception.details['stop'], 200)


# endregion


# region protocol


class _NeverTurnsOn(FakeWledTransport):
    """A simulated device which silently ignores master-on commands."""

    def _apply_state(self, payload):
        """Apply state except any attempt to switch the master on."""
        payload = dict(payload)

        if payload.get('on'):
            payload.pop('on', None)

        super()._apply_state(payload)


class _StuckOn(FakeWledTransport):
    """A simulated device which refuses to switch the master off."""

    def _apply_state(self, payload):
        """Apply state except any attempt to switch the master off."""
        payload = dict(payload)

        if payload.get('on') is False:
            payload.pop('on', None)

        super()._apply_state(payload)


class ProtocolTests(SimpleTestCase):
    """Tests for the safe protocol sequence, clear/stop and ambiguity."""

    def test_apply_sequence_order(self):
        """Backup arms before master-on and before the first pixel write."""
        transport = device()
        result = adapter(transport).apply(
            controller(), plan([make_run(0, 50)], duration=60)
        )

        self.assertTrue(result['acknowledged'])
        self.assertEqual(result['pixels'], 50)
        self.assertEqual(result['nightlight_minutes'], 1)

        posts = state_posts(transport)
        master_off = posts.index(wled.master_off_payload())
        takeover = posts.index(wled.segment_takeover_payload(120))
        backup = posts.index(wled.nightlight_backup_payload(60))
        master_on = posts.index(wled.master_on_payload(64))
        clear = posts.index(wled.clear_segment_payload())
        first_pixels = next(
            index for index, body in enumerate(posts) if has_individual(body)
        )

        self.assertLess(master_off, takeover)
        self.assertLess(takeover, backup)
        self.assertLess(backup, master_on)
        self.assertLess(master_on, clear)
        self.assertLess(clear, first_pixels)

    def test_apply_caps_brightness(self):
        """Brightness is capped by the commissioning policy."""
        transport = device()
        target = controller(commissioning_policy={'brightness_cap': 32})
        adapter(transport).apply(
            target,
            plan(
                [make_run(0, 10)],
                profile={'rgb': [0, 255, 0], 'white': 0, 'brightness': 200},
            ),
        )

        self.assertIn(wled.master_on_payload(32), state_posts(transport))

    def test_apply_rejects_rgbw_white(self):
        """A non-zero white request is rejected rather than remapped."""
        with self.assertRaises(UnsupportedConfigError):
            adapter(device()).apply(
                controller(),
                plan(
                    [make_run(0, 10)],
                    profile={'rgb': [0, 255, 0], 'white': 255, 'brightness': 64},
                ),
            )

    def test_apply_blocks_unsupported_configuration(self):
        """An unsupported configuration blocks apply before any write."""
        cfg = cfg_fixture(
            ins=[
                {
                    'start': 0,
                    'len': 120,
                    'pin': [16],
                    'order': 0,
                    'rev': True,
                    'skip': 0,
                    'type': 22,
                }
            ]
        )
        transport = device(cfg=cfg)

        with self.assertRaises(UnsupportedConfigError):
            adapter(transport).apply(controller(), plan([make_run(0, 10)]))

        self.assertEqual(state_posts(transport), [])

    def test_apply_blocks_config_drift(self):
        """A drift between observed and approved fingerprints blocks apply."""
        transport = device()
        target = controller(armed_config_hash='deadbeef')

        with self.assertRaises(ConfigDriftError):
            adapter(transport).apply(target, plan([make_run(0, 10)]))

    def test_apply_accepts_matching_fingerprint(self):
        """A matching approved fingerprint permits apply."""
        transport = device()
        adapter_obj = adapter(transport)
        observed = adapter_obj.observe(controller())
        target = controller(armed_config_hash=observed['fingerprint'])

        result = adapter_obj.apply(target, plan([make_run(0, 10)]))

        self.assertTrue(result['acknowledged'])

    def test_apply_rejects_realtime_ownership(self):
        """An active realtime/stream owner is rejected, not overpowered."""
        transport = device(info=info_fixture(live=True))

        with self.assertRaises(ProtocolError):
            adapter(transport).apply(controller(), plan([make_run(0, 10)]))

        self.assertEqual(state_posts(transport), [])

    def test_apply_detects_reboot(self):
        """An unexpected reboot during preflight blocks the pixel write."""
        transport = device(
            failures=[
                {'method': 'GET', 'path': wled.PATH_INFO, 'action': 'reboot', 'skip': 1}
            ]
        )

        with self.assertRaises(ProtocolError):
            adapter(transport).apply(controller(), plan([make_run(0, 50)]))

        self.assertFalse(any(has_individual(body) for body in state_posts(transport)))

    def test_apply_returns_no_runs(self):
        """A controller with no runs is not illuminated."""
        transport = device()
        result = adapter(transport).apply(controller(), plan([], pk='ctrl-b'))

        self.assertFalse(result['acknowledged'])
        self.assertEqual(result['reason'], 'no-runs')
        self.assertEqual(state_posts(transport), [])

    def test_apply_rejects_run_beyond_led_count(self):
        """A run addressing pixels past the observed LED count fails closed.

        The mapping may declare an output range larger than the device reports
        (for example after a firmware or wiring change). The adapter must refuse
        before the first illuminating write rather than send an out-of-range
        address.
        """
        transport = device(info=info_fixture(count=120))

        with self.assertRaises(OutOfRangeError):
            adapter(transport).apply(controller(), plan([make_run(0, 130)]))

        self.assertEqual(state_posts(transport), [])

    def test_apply_rejects_negative_run_start(self):
        """A run with a negative start index fails closed."""
        transport = device(info=info_fixture(count=120))

        with self.assertRaises(OutOfRangeError):
            adapter(transport).apply(controller(), plan([make_run(-1, 10)]))

        self.assertEqual(state_posts(transport), [])

    def test_apply_accepts_run_at_led_count_boundary(self):
        """A half-open run ending exactly at the LED count is in range."""
        transport = device(info=info_fixture(count=120))

        result = adapter(transport).apply(controller(), plan([make_run(110, 120)]))

        self.assertTrue(result['acknowledged'])
        self.assertEqual(result['pixels'], 10)

    def test_apply_verifies_master_on(self):
        """A device which never switches on fails preflight verification."""
        transport = _NeverTurnsOn(info_fixture(), cfg_fixture())

        with self.assertRaises(PreflightError):
            adapter(transport).apply(controller(), plan([make_run(0, 10)]))

        self.assertFalse(transport.state['on'])
        self.assertFalse(transport.state['nl']['on'])

    def test_apply_cleans_up_when_master_on_verification_fails(self):
        """Master-on verification failure triggers cleanup before surfacing."""
        transport = device()

        with patch.object(WledConnection, 'verify_master_on',
                          side_effect=ProtocolError('master-on readback failed')):
            with self.assertRaises(ProtocolError):
                adapter(transport).apply(controller(), plan([make_run(0, 10)]))

        self.assertFalse(transport.state['on'])
        self.assertFalse(transport.state['nl']['on'])
        self.assertEqual(transport.individual_writes, [])
        self.assertFalse(
            [body['on'] for body in state_posts(transport) if 'on' in body][-1]
        )

    def test_ambiguous_pixel_write_not_retried(self):
        """A timed-out illuminating chunk is surfaced, never retried."""
        transport = device(
            failures=[{'method': 'POST', 'has_i': True, 'action': 'timeout'}]
        )

        with self.assertRaises(AmbiguousWriteError):
            adapter(transport).apply(controller(), plan([make_run(0, 50)]))

        individual = [body for body in state_posts(transport) if has_individual(body)]
        self.assertEqual(len(individual), 1)
        self.assertEqual(transport.individual_writes, [])

    def test_apply_self_cleans_after_late_failure(self):
        """The safe default clears the device after a late sequence failure."""
        transport = device(
            failures=[{'method': 'POST', 'has_i': True, 'action': 'timeout'}]
        )

        with self.assertRaises(AmbiguousWriteError):
            adapter(transport).apply(controller(), plan([make_run(0, 50)]))

        self.assertFalse(transport.state['on'])
        self.assertFalse(transport.state['nl']['on'])

    def test_apply_cleanup_can_be_disabled(self):
        """Disabling cleanup leaves the device for the orchestrator to clear."""
        transport = device(
            failures=[{'method': 'POST', 'has_i': True, 'action': 'timeout'}]
        )

        with self.assertRaises(AmbiguousWriteError):
            adapter(transport).apply(
                controller(), plan([make_run(0, 50)]), cleanup_on_failure=False
            )

        self.assertTrue(transport.state['on'])

    def test_capture_state_does_not_post(self):
        """Capturing a restorable runtime snapshot is read-only."""
        transport = device()
        wled_adapter = adapter(transport)

        snapshot = wled_adapter.capture_state(controller())

        self.assertIsInstance(snapshot, dict)
        self.assertEqual(state_posts(transport), [])

    def test_capture_state_rejects_malformed_runtime_fields(self):
        """Unexpected controller JSON fails preflight without changing state."""
        for fields in ({'seg': [None]}, {'nl': []}):
            with self.subTest(fields=fields):
                transport = device()
                transport.state.update(fields)
                with self.assertRaises(PreflightError):
                    adapter(transport).capture_state(controller())
                self.assertEqual(state_posts(transport), [])

    def test_capture_state_rejects_frozen_segments(self):
        """Frozen segment state cannot provide reliable individual-pixel colors."""
        transport = device(state={
            'on': True,
            'bri': 80,
            'nl': {'on': False},
            'seg': [{'id': 0, 'start': 0, 'stop': 20, 'on': True, 'bri': 80, 'frz': True}],
            'mainseg': 0,
        })
        wled_adapter = adapter(transport)

        with self.assertRaises(PreflightError):
            wled_adapter.capture_state(controller())

        self.assertEqual(state_posts(transport), [])

    def test_restore_state_roundtrip_after_apply_and_clear(self):
        """A captured state can be restored after a locate and explicit clear."""
        original = {
            'on': False,
            'bri': 37,
            'nl': {'on': True, 'dur': 9, 'mode': 2, 'tbri': 41},
            'seg': [
                {'id': 0, 'start': 5, 'stop': 25, 'on': True, 'bri': 73,
                 'grp': 1, 'spc': 0, 'of': 0, 'rev': False, 'mi': False,
                 'fx': 4, 'frz': False, 'col': [[1, 2, 3]]},
            ],
            'mainseg': 0,
        }
        transport = device(state=original)
        wled_adapter = adapter(transport)
        snapshot = wled_adapter.capture_state(controller())

        wled_adapter.apply(controller(), plan([make_run(0, 10)]))
        wled_adapter.clear(controller())
        result = wled_adapter.restore_state(controller(), snapshot)

        self.assertTrue(result.confirmed)
        self.assertEqual(transport.state['on'], original['on'])
        self.assertEqual(transport.state['bri'], original['bri'])
        self.assertEqual(transport.state['nl'], original['nl'])
        self.assertEqual(transport.state['seg'], original['seg'])
        self.assertEqual(transport.state['mainseg'], original['mainseg'])

    def test_restore_state_timeout_is_unconfirmed(self):
        """A restore write timeout is reported as unconfirmed, not success."""
        transport = device(failures=[{'method': 'POST', 'action': 'timeout'}])
        wled_adapter = adapter(transport)
        snapshot = wled_adapter.capture_state(controller())

        result = wled_adapter.restore_state(controller(), snapshot)

        self.assertFalse(result.confirmed)

    def test_clear_confirms_off(self):
        """Clear returns off/black/unfrozen and confirms by read-back."""
        transport = device()
        adapter(transport).apply(controller(), plan([make_run(0, 50)]))
        result = adapter(transport).clear(controller())

        self.assertTrue(result.confirmed)
        self.assertTrue(result.acknowledged)
        self.assertFalse(result.state['on'])
        self.assertFalse(result.state['nightlight']['on'])

    def test_clear_unconfirmed_on_stubborn_device(self):
        """A device which stays on is reported unconfirmed, never safe."""
        transport = _StuckOn(
            info_fixture(), cfg_fixture(), state={'on': True, 'bri': 200, 'seg': []}
        )
        result = adapter(transport).clear(controller())

        self.assertFalse(result.confirmed)
        self.assertEqual(result.clear_status, 'unconfirmed')

    def test_clear_unconfirmed_on_unreachable_device(self):
        """A transport failure during clear is reported unconfirmed."""
        transport = device(
            failures=[
                {
                    'method': 'POST',
                    'path': wled.PATH_STATE,
                    'action': 'timeout',
                    'repeat': True,
                }
            ]
        )
        result = adapter(transport).clear(controller())

        self.assertFalse(result.confirmed)
        self.assertFalse(result.acknowledged)
        self.assertTrue(result.error)

    def test_clear_is_idempotent(self):
        """Clear may be called repeatedly with the same confirmed result."""
        transport = device()
        adapter_obj = adapter(transport)

        first = adapter_obj.clear(controller())
        second = adapter_obj.clear(controller())

        self.assertTrue(first.confirmed)
        self.assertTrue(second.confirmed)

    def test_stop_is_clear(self):
        """Stop is an alias for the idempotent clear."""
        transport = device()
        result = adapter(transport).stop(controller())

        self.assertTrue(result.confirmed)

    def test_clear_rejects_unsafe_origin(self):
        """Clear fails closed on an origin outside the allowlist."""
        result = adapter(device()).clear(controller(origin='http://evil.example'))

        self.assertFalse(result.confirmed)
        self.assertFalse(result.acknowledged)


# endregion


# region simulation / no network


class SimulationTests(SimpleTestCase):
    """Tests that the adapter works entirely without a network."""

    def test_observe_simulation(self):
        """Observation over the in-memory transport yields a supported result."""
        transport = device()
        observation = adapter(transport).observe(controller())

        self.assertEqual(observation['capability_status'], wled.CAPABILITY_SUPPORTED)
        self.assertEqual(observation['info']['leds']['count'], 120)
        self.assertEqual(len(observation['normalised_config']['outputs']), 2)
        self.assertEqual(observation['adapter_version'], wled.ADAPTER_VERSION)
        self.assertIn('runtime', observation)

    def test_observe_with_baseline_reports_diff(self):
        """An observation with a baseline includes a diff."""
        transport = device()
        adapter_obj = adapter(transport)
        first = adapter_obj.observe(controller())
        second = adapter_obj.observe(controller(), baseline=first)

        self.assertFalse(second['diff']['fingerprint_changed'])

    def test_observe_oversize_response_raises(self):
        """An oversized response aborts observation."""
        transport = device(failures=[{'path': wled.PATH_INFO, 'action': 'oversize'}])

        with self.assertRaises(ResponseTooLargeError):
            adapter(transport).observe(controller())

    def test_observe_malformed_cfg_is_unverified(self):
        """A malformed optional configuration degrades to unverified."""
        transport = device(failures=[{'path': wled.PATH_CFG, 'action': 'malformed'}])
        observation = adapter(transport).observe(controller())

        self.assertEqual(observation['capability_status'], wled.CAPABILITY_UNVERIFIED)
        self.assertEqual(observation['normalised_config']['outputs'], [])

    def test_no_socket_is_opened(self):
        """The full apply/clear path opens no socket, even if sockets are broken."""
        original_connect = socket.create_connection
        original_resolve = socket.getaddrinfo

        def boom(*args, **kwargs):
            raise AssertionError('network access attempted')

        socket.create_connection = boom
        socket.getaddrinfo = boom

        try:
            transport = device()
            adapter_obj = adapter(transport)
            result = adapter_obj.apply(controller(), plan([make_run(0, 30)]))
            cleared = adapter_obj.clear(controller())
        finally:
            socket.create_connection = original_connect
            socket.getaddrinfo = original_resolve

        self.assertTrue(result['acknowledged'])
        self.assertTrue(cleared.confirmed)


# endregion


# region adapter discovery / fail-closed defaults


class AdapterDiscoveryTests(SimpleTestCase):
    """Tests that the service layer discovers the adapter and fails closed."""

    def test_module_exposes_get_adapter(self):
        """The module exposes the ``get_adapter`` hook the service layer expects."""
        self.assertTrue(hasattr(wled, 'get_adapter'))

    def test_service_discovery_contract(self):
        """The module satisfies the service-layer discovery contract.

        ``storage_layout.services.load_wled_adapter`` imports
        ``storage_layout.wled`` and requires a ``get_adapter`` attribute; this
        asserts that contract without importing the model-dependent service
        module in a schema-less unit test.

        The plugin registry purges and re-imports the whole plugin package when
        it reloads (the package is installed outside ``BASE_DIR``), so the
        module-level ``wled`` binding captured at collection time can be a
        stale module object by the time this test runs. The contract is
        therefore asserted against a fresh import rather than by module
        identity.
        """
        import importlib

        module = importlib.import_module('storage_layout.wled')

        self.assertTrue(hasattr(module, 'get_adapter'))
        self.assertTrue(callable(module.get_adapter))
        self.assertEqual(module.get_adapter.__module__, 'storage_layout.wled')
        self.assertEqual(module.get_adapter.__qualname__, 'get_adapter')

    def test_default_adapter_denies_all_origins(self):
        """With no configured allowlist the default adapter fails closed."""
        adapter_obj = wled.get_adapter()

        self.assertIsInstance(adapter_obj, WledAdapter)
        self.assertIsInstance(adapter_obj.transport, HttpTransport)

        with self.assertRaises(UnsafeOriginError):
            adapter_obj.connection(controller())

    def test_get_adapter_accepts_injection(self):
        """An injected transport and policy are honoured."""
        transport = device()
        adapter_obj = wled.get_adapter(transport=transport, policy=policy())

        observation = adapter_obj.observe(controller())

        self.assertEqual(observation['capability_status'], wled.CAPABILITY_SUPPORTED)


# endregion


# region errors


class ErrorVocabularyTests(SimpleTestCase):
    """Tests that adapter errors carry the documented codes."""

    def test_error_codes(self):
        """Each error exposes its design error code."""
        self.assertEqual(UnsafeOriginError('x').code, 'unsafe_origin')
        self.assertEqual(UnsupportedConfigError('x').code, 'unsupported_configuration')
        self.assertEqual(ConfigDriftError('x').code, 'config_drift')
        self.assertEqual(TransportTimeoutError('x').code, 'controller_timeout')
        self.assertEqual(TransportUnavailableError('x').code, 'transport_unavailable')

    def test_controller_error_status(self):
        """A controller error retains the HTTP status."""
        error = ControllerError('x', status=503)

        self.assertEqual(error.status, 503)

    def test_validation_error_is_not_leaked(self):
        """Origin validation errors are wrapped in the adapter vocabulary."""
        with self.assertRaises(UnsafeOriginError) as ctx:
            policy().check('http://wled-a.local/path')

        self.assertIsInstance(ctx.exception, wled.WledError)
        self.assertNotIsInstance(ctx.exception, ValidationError)
