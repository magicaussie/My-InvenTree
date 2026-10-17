"""Bounded WLED adapter for the Storage Layout & WLED plugin.

This module is the Stage 4 (WLED adapter) work package described in
``docs/design/001 - Storage Layout & WLED.md``. It owns exactly four concerns
and nothing else:

1. **Origin and network safety** (:class:`OriginPolicy`). Controller origins are
   canonicalised with the authoritative :func:`storage_layout.validation.validate_canonical_origin`
   and then checked against an operator-approved allowlist. Loopback,
   link-local, multicast, unspecified and reserved addresses are rejected, as
   are resolved addresses outside the configured hardware networks. Resolved
   addresses are pinned to the request so a re-resolved DNS name cannot move a
   validated origin onto a forbidden address (SSRF / DNS-rebinding boundary).
2. **A bounded transport** (:class:`Transport`, :class:`HttpTransport`,
   :class:`RecordingTransport`, :class:`FakeWledTransport`). The adapter never
   opens a socket on import and never opens one unless an explicit transport is
   supplied. Response size and JSON depth are bounded, redirects and environment
   proxies are disabled, and there are no side-effecting GET requests.
3. **Pure observation**: redacted parsing/normalisation of ``/json/info``,
   ``/json/cfg``, ``/json/state`` and ``/json/pins``, a deterministic
   configuration fingerprint, capability classification and a structural diff.
4. **The safe state protocol** (:meth:`WledAdapter.apply`, :meth:`WledAdapter.clear`):
   black canonical-segment takeover with the master off, nightlight backup
   arming *before* master-on and before any non-black pixel write, sequential
   bounded individual-pixel chunks, and an idempotent clear that confirms
   read-back before reporting success.

Safety invariants enforced here (never by a host application):

- Hardware is **fail closed**: with no allowlist, no resolved origin, no
  transport, or an unsupported configuration, every live method refuses.
- A successful HTTP response is never treated as proof that LEDs were visibly
  lit; the adapter reports acknowledgement, not optical verification.
- An ambiguous illuminating write is surfaced as an error, never retried blindly
  and never reported as a confirmed clear.

Nothing in this module imports Django models or performs database access, so it
can be exercised exhaustively with the in-memory simulation transport.
"""

from __future__ import annotations

import copy
import hashlib
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _

from storage_layout.validation import validate_canonical_origin

# region constants

#: Adapter identity stored on every observation and used in the fingerprint.
ADAPTER_VERSION = 'wled-v16.0.1-1d'

#: The pinned firmware the parsers and capability rules were written against.
FIRMWARE_TARGET = 'wled v16.0.1'

PATH_INFO = '/json/info'
PATH_CFG = '/json/cfg'
PATH_STATE = '/json/state'
PATH_PINS = '/json/pins'

DEFAULT_CONNECT_TIMEOUT = 2.0
DEFAULT_READ_TIMEOUT = 3.0

#: Upper bound on a decoded response body, protecting against huge/untrusted data.
MAX_RESPONSE_BYTES = 64 * 1024
MAX_RESPONSE_DEPTH = 12

#: Upper bound on an outgoing state payload (design section 10.2).
MAX_PAYLOAD_BYTES = 8 * 1024
MAX_PIXELS_PER_CHUNK = 256
MAX_GET_RETRIES = 2
MAX_CLEAR_RETRIES = 2

#: Commissioning brightness cap; a controller may lower this but not raise it.
DEFAULT_BRIGHTNESS_CAP = 64

MIN_NIGHTLIGHT_MINUTES = 1
MAX_NIGHTLIGHT_MINUTES = 2

CANONICAL_SEGMENT_ID = 0

CAPABILITY_SUPPORTED = 'supported'
CAPABILITY_UNVERIFIED = 'unverified'
CAPABILITY_UNSUPPORTED = 'unsupported'

_CAPABILITY_RANK = {
    CAPABILITY_SUPPORTED: 0,
    CAPABILITY_UNVERIFIED: 1,
    CAPABILITY_UNSUPPORTED: 2,
}

# LED type identifiers and classification, transcribed from the pinned
# ``wled00/const.h`` (v16.0.1). These are used only to classify an observed bus;
# they are never written back to firmware.
TYPE_NONE = 0
TYPE_DIGITAL_MIN = 16
TYPE_DIGITAL_MAX = 39
TYPE_WS2812_1CH = 18
TYPE_WS2812_1CH_X3 = 19
TYPE_WS2812_WWA = 21
TYPE_ONOFF = 40
TYPE_ANALOG_MIN = 41
TYPE_ANALOG_MAX = 47
TYPE_2PIN_MIN = 48
TYPE_2PIN_MAX = 63
TYPE_HUB75_MIN = 64
TYPE_HUB75_MAX = 71
TYPE_VIRTUAL_MIN = 80
TYPE_VIRTUAL_MAX = 95

#: Digital types which carry an RGB channel (pinned ``const.h``).
DIGITAL_RGB_TYPES = frozenset(range(22, 35))

#: Digital types which carry no RGB channel (white-only / WWA).
DIGITAL_NO_RGB_TYPES = frozenset({TYPE_WS2812_1CH, TYPE_WS2812_1CH_X3, TYPE_WS2812_WWA})

#: The digital 1D RGB/RGBW types the v1 adapter claims verified support for.
#: Anything else is preserved but cannot be armed. Reconcile against the pinned
#: firmware before commissioning a new type.
SUPPORTED_LED_TYPES = frozenset({22, 24, 25, 27, 30, 33})

#: WLED colour-order index to canonical name (pinned ``const.h``).
COLOR_ORDERS = {0: 'GRB', 1: 'RGB', 2: 'BRG', 3: 'RBG', 4: 'BGR', 5: 'GBR'}

#: Fields copied by the import service; kept identical so an observation round
#: trips through import without loss.
OUTPUT_KEYS = (
    'bus_index',
    'wled_start',
    'pixel_count',
    'pins',
    'led_type',
    'colour_order',
    'bus_reverse',
    'skip',
)

# endregion


# region errors


class WledError(Exception):
    """Base class for adapter errors.

    Every error carries a machine-readable :attr:`code` aligned with the design
    error vocabulary so callers can map it onto the API error schema.
    """

    code = 'wled_error'

    def __init__(
        self, message: str, *, code: str | None = None, details: Any = None
    ) -> None:
        """Build an adapter error."""
        super().__init__(str(message))
        self.message = str(message)
        if code:
            self.code = code
        self.details = details if details is not None else {}


class TransportError(WledError):
    """A transport-level failure (unreachable, refused or timed out)."""

    code = 'controller_unavailable'


class TransportTimeoutError(TransportError):
    """A request timed out.

    The request may or may not have been applied at the device, so callers must
    treat an illuminated write that times out as ambiguous.
    """

    code = 'controller_timeout'


class TransportUnavailableError(TransportError):
    """No usable transport is configured (the fail-closed default)."""

    code = 'transport_unavailable'


class UnsafeOriginError(WledError):
    """An origin is not permitted by the network allowlist."""

    code = 'unsafe_origin'


class AllowlistError(WledError):
    """The configured hardware allowlist could not be parsed."""

    code = 'invalid_allowlist'


class ResponseTooLargeError(WledError):
    """A controller response exceeded the configured size or depth bound."""

    code = 'response_too_large'


class MalformedResponseError(WledError):
    """A controller response was not valid bounded JSON."""

    code = 'malformed_response'


class UnsupportedConfigError(WledError):
    """An observed configuration is not supported by the v1 adapter."""

    code = 'unsupported_configuration'


class ConfigDriftError(WledError):
    """The observed configuration differs from the approved configuration."""

    code = 'config_drift'


class PreflightError(WledError):
    """A protocol step did not reach its expected verified state."""

    code = 'preflight_failed'


class ProtocolError(WledError):
    """A payload or protocol precondition was violated."""

    code = 'protocol_error'


class AmbiguousWriteError(TransportTimeoutError):
    """An illuminating write may or may not have been applied.

    This is raised instead of a bare timeout for a non-idempotent write: the
    caller must not report the device as safely off and must not blindly retry.
    """

    code = 'ambiguous_write'


class PayloadTooLargeError(WledError):
    """A single bounded payload could not be encoded within the limits."""

    code = 'payload_too_large'


class ControllerError(WledError):
    """The controller returned a non-success HTTP status or error payload."""

    code = 'controller_error'

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        details: Any = None,
    ) -> None:
        """Build a controller error carrying the HTTP status."""
        super().__init__(message, code=code, details=details)
        self.status = status


# endregion


# region origin / SSRF policy


@dataclass(frozen=True)
class AllowlistEntry:
    """A single approved hardware network entry.

    Exactly one of ``host`` or ``network`` is populated. A host entry matches a
    controller hostname (optionally constrained to a port); a network entry
    matches any resolved address inside the CIDR range.
    """

    host: str | None = None
    port: int | None = None
    network: Any = None


@dataclass(frozen=True)
class ResolvedOrigin:
    """A canonical origin together with its pinned, validated addresses."""

    value: str
    scheme: str
    host: str
    port: int
    addresses: tuple[str, ...]

    @property
    def host_header(self) -> str:
        """Return the host (and non-default port) for an HTTP ``Host`` header."""
        host = f'[{self.host}]' if ':' in self.host else self.host

        default = 443 if self.scheme == 'https' else 80

        return host if self.port == default else f'{host}:{self.port}'


def system_resolver(host: str) -> list[str]:
    """Resolve a hostname using the platform resolver.

    This is only reachable for live (non-simulated) operations. Tests and
    simulation always inject a deterministic resolver.

    Args:
        host: The hostname to resolve.

    Returns:
        A de-duplicated list of resolved IP address strings.
    """
    addresses: list[str] = []

    for info in socket.getaddrinfo(host, None):
        address = info[4][0]

        if address and address not in addresses:
            addresses.append(address)

    return addresses


def _split_host_port(token: str) -> tuple[str, int | None]:
    """Split an allowlist token into ``(host, port)``."""
    if token.count(':') >= 2 and not token.startswith('[') and ']' not in token:
        # Bare IPv6 literal with no port.
        return token, None

    try:
        parts = urlsplit('//' + token)
        port = parts.port
    except ValueError as exc:
        raise AllowlistError(
            _('Invalid allowlist entry %(token)s: %(error)s')
            % {'token': token, 'error': exc}
        ) from exc

    if not parts.hostname:
        raise AllowlistError(_('Invalid allowlist entry: %(token)s') % {'token': token})

    return parts.hostname.lower(), port


def parse_allowlist(text: str | None) -> tuple[AllowlistEntry, ...]:
    """Parse an operator allowlist into entries.

    Tokens are comma/whitespace separated. A token containing ``/`` is a CIDR
    network; anything else is a ``host`` or ``host:port`` entry. Invalid tokens
    raise :class:`AllowlistError` rather than being silently ignored, because a
    dropped entry could widen or weaken the boundary silently.

    Args:
        text: The raw allowlist string.

    Returns:
        The parsed entries.

    Raises:
        AllowlistError: If an entry is malformed.
    """
    entries: list[AllowlistEntry] = []

    for token in re.split(r'[\s,]+', text or ''):
        token = token.strip()

        if not token:
            continue

        if '/' in token:
            try:
                network = ipaddress.ip_network(token, strict=False)
            except ValueError as exc:
                raise AllowlistError(
                    _('Invalid allowlist network %(token)s: %(error)s')
                    % {'token': token, 'error': exc}
                ) from exc

            entries.append(AllowlistEntry(network=network))
            continue

        host, port = _split_host_port(token)
        entries.append(AllowlistEntry(host=host, port=port))

    return tuple(entries)


def _normalise_ip(raw: str) -> Any:
    """Parse an address string, unwrapping IPv4-mapped IPv6 addresses."""
    text = str(raw).split('%', 1)[0]
    address = ipaddress.ip_address(text)

    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped

    return address


def _is_forbidden(address: Any) -> bool:
    """Return True for addresses which must never be contacted."""
    if (
        address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    ):
        return True

    return bool(address.version == 4 and address in ipaddress.ip_network('0.0.0.0/8'))


def _ip_in_network(address: Any, network: Any) -> bool:
    """Return True when ``address`` is inside ``network`` (version-safe)."""
    if network is None or address.version != network.version:
        return False

    return address in network


@dataclass
class OriginPolicy:
    """The SSRF boundary for controller origins.

    Attributes:
        entries: The parsed allowlist entries.
        resolver: A callable resolving a hostname to IP address strings. Inject a
            deterministic resolver in tests and simulation.
    """

    entries: tuple[AllowlistEntry, ...] = ()
    resolver: Callable[[str], list[str]] = system_resolver

    @classmethod
    def from_setting(cls, value: str | None, **kwargs: Any) -> OriginPolicy:
        """Build a policy from a raw allowlist string."""
        return cls(entries=parse_allowlist(value), **kwargs)

    def check(self, value: str) -> ResolvedOrigin:
        """Validate and canonicalise an origin, pinning its addresses.

        Args:
            value: The candidate origin (``scheme://host[:port]``).

        Returns:
            The resolved origin with pinned addresses.

        Raises:
            UnsafeOriginError: If the origin is malformed or not permitted.
        """
        try:
            canonical = validate_canonical_origin(value)
        except ValidationError as exc:
            raise UnsafeOriginError(
                _('Unsafe controller origin: %(error)s')
                % {'error': '; '.join(str(m) for m in exc.messages)}
            ) from exc

        parts = urlsplit(canonical)
        scheme = parts.scheme
        host = (parts.hostname or '').lower()
        port = parts.port or (443 if scheme == 'https' else 80)

        if not self.entries:
            raise UnsafeOriginError(_('No hardware network allowlist is configured'))

        host_entries = [entry for entry in self.entries if entry.host]
        cidr_entries = [entry for entry in self.entries if entry.network is not None]

        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None

        if literal is not None:
            addresses = [str(literal)]
        else:
            try:
                addresses = [a for a in self.resolver(host) if a]
            except OSError as exc:
                raise UnsafeOriginError(
                    _('Could not resolve controller host %(host)s') % {'host': host}
                ) from exc

        if not addresses:
            raise UnsafeOriginError(
                _('Controller host %(host)s did not resolve') % {'host': host}
            )

        host_match = any(
            entry.host == host and entry.port in (None, port) for entry in host_entries
        )

        pinned: list[str] = []

        for raw in addresses:
            try:
                address = _normalise_ip(raw)
            except ValueError as exc:
                raise UnsafeOriginError(
                    _('Invalid resolved address %(raw)s') % {'raw': raw}
                ) from exc

            if _is_forbidden(address):
                raise UnsafeOriginError(
                    _('Forbidden controller address %(address)s') % {'address': address}
                )

            in_cidr = any(
                _ip_in_network(address, entry.network) for entry in cidr_entries
            )

            if not (in_cidr or host_match):
                raise UnsafeOriginError(
                    _('Address %(address)s is outside the hardware allowlist')
                    % {'address': address}
                )

            pinned.append(str(address))

        return ResolvedOrigin(
            value=canonical,
            scheme=scheme,
            host=host,
            port=port,
            addresses=tuple(pinned),
        )


# endregion


# region transport


@dataclass
class Response:
    """A bounded HTTP response."""

    status: int
    body: bytes = b''
    headers: dict[str, str] = field(default_factory=dict)
    url: str = ''

    def json(self) -> Any:
        """Decode the response body as JSON."""
        return _decode_json(self.body)


class Transport(Protocol):
    """The injectable transport contract.

    Implementations receive a resolved (and address-pinned) origin; they must not
    perform their own name resolution or follow redirects.
    """

    def request(
        self,
        method: str,
        origin: ResolvedOrigin,
        path: str,
        *,
        json_body: Any = None,
        timeout: float | None = None,
    ) -> Response:
        """Perform one request and return the bounded response."""
        ...


def _encode_json(payload: Any) -> bytes:
    """Encode a payload deterministically."""
    return json.dumps(payload, separators=(',', ':'), default=str).encode('utf-8')


def _json_depth(value: Any) -> int:
    """Return the maximum nesting depth of a decoded JSON value."""
    depth = 0
    stack: list[tuple[Any, int]] = [(value, 1)]

    while stack:
        current, level = stack.pop()
        depth = max(depth, level)

        if isinstance(current, Mapping):
            stack.extend((item, level + 1) for item in current.values())
        elif isinstance(current, (list, tuple)):
            stack.extend((item, level + 1) for item in current)

    return depth


def _decode_json(
    body: bytes | None,
    *,
    max_bytes: int = MAX_RESPONSE_BYTES,
    max_depth: int = MAX_RESPONSE_DEPTH,
) -> Any:
    """Decode bounded JSON, rejecting oversized or malformed bodies."""
    if not body:
        return None

    if len(body) > max_bytes:
        raise ResponseTooLargeError(_('Controller response exceeds the size bound'))

    try:
        data = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MalformedResponseError(
            _('Controller response was not valid JSON')
        ) from exc

    if _json_depth(data) > max_depth:
        raise ResponseTooLargeError(_('Controller response exceeds the depth bound'))

    return data


class RecordingTransport:
    """A transport that records requests and replays scripted responses.

    Suitable for tests and protocol-order assertions. It never opens a socket.
    """

    def __init__(
        self,
        handler: Callable[[str, ResolvedOrigin, str, Any], Response] | None = None,
        *,
        responses: Sequence[Response] | None = None,
    ) -> None:
        """Initialise the transport with an optional handler or response script."""
        self.requests: list[dict[str, Any]] = []
        self._handler = handler
        self._responses = list(responses or [])

    def request(
        self,
        method: str,
        origin: ResolvedOrigin,
        path: str,
        *,
        json_body: Any = None,
        timeout: float | None = None,
    ) -> Response:
        """Record the request and return a scripted or handled response."""
        self.requests.append({
            'method': method,
            'origin': origin.value,
            'path': path,
            'body': copy.deepcopy(json_body),
        })

        if self._handler is not None:
            return self._handler(method, origin, path, json_body)

        if self._responses:
            return self._responses.pop(0)

        raise TransportUnavailableError(_('No scripted response is available'))

    def payloads(self, path: str | None = None) -> list[Any]:
        """Return recorded request bodies, optionally filtered by path."""
        return [
            record['body']
            for record in self.requests
            if path is None or record['path'] == path
        ]


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An HTTPS connection which pins the peer address but keeps TLS SNI."""

    def __init__(
        self,
        address: str,
        port: int,
        *,
        server_hostname: str,
        context: ssl.SSLContext,
        timeout: float,
    ) -> None:
        """Store the SNI name and configure the pinned connection."""
        super().__init__(address, port, timeout=timeout, context=context)
        self._sni = server_hostname

    def connect(self) -> None:
        """Connect to the pinned address, presenting the expected SNI name."""
        sock = socket.create_connection(
            (self.host, self.port), self.timeout, self.source_address
        )
        self.sock = self._context.wrap_socket(sock, server_hostname=self._sni)


def _pinned_connector(
    method: str,
    origin: ResolvedOrigin,
    path: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
) -> Response:
    """Open a bounded connection to a pinned address and read the response.

    This is the only code path in the module that can open a socket, and it is
    unreachable unless :class:`HttpTransport` was constructed with
    ``allow_network=True``.
    """
    address = origin.addresses[0]

    if origin.scheme == 'https':
        connection: http.client.HTTPConnection = _PinnedHTTPSConnection(
            address,
            origin.port,
            server_hostname=origin.host,
            context=ssl.create_default_context(),
            timeout=timeout,
        )
    else:
        connection = http.client.HTTPConnection(address, origin.port, timeout=timeout)

    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE_BYTES + 1)

        return Response(
            status=response.status,
            body=data,
            headers=dict(response.getheaders()),
            url=origin.value + path,
        )
    except (OSError, ssl.SSLError) as exc:
        raise TransportError(
            _('Controller transport error: %(error)s') % {'error': exc}
        ) from exc
    finally:
        connection.close()


class HttpTransport:
    """A bounded HTTP transport for live controller access.

    Network access is **off by default**. It is only enabled when the adapter is
    constructed for commissioning, and even then connections are pinned to the
    validated address, redirects are never followed, no environment proxy is
    used, and the response is size-bounded by :class:`WledConnection`.
    """

    def __init__(
        self,
        *,
        allow_network: bool = False,
        connector: Callable[..., Response] | None = None,
        user_agent: str = 'inventree-storage-layout/0.1.0',
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    ) -> None:
        """Configure the transport.

        Args:
            allow_network: Must be True to actually connect; False fails closed.
            connector: Optional connector override (used by tests). It receives
                ``(method, origin, path, headers, body, timeout)``.
            user_agent: The ``User-Agent`` header value.
            connect_timeout: Default connection/read timeout in seconds.
        """
        self.allow_network = allow_network
        self._connector = connector or _pinned_connector
        self.user_agent = user_agent
        self.connect_timeout = connect_timeout

    def request(
        self,
        method: str,
        origin: ResolvedOrigin,
        path: str,
        *,
        json_body: Any = None,
        timeout: float | None = None,
    ) -> Response:
        """Perform a bounded request against a pinned origin.

        Raises:
            TransportUnavailableError: If network access is not explicitly enabled.
        """
        if not self.allow_network:
            raise TransportUnavailableError(
                _('Network access is not enabled for this transport')
            )

        if not origin.addresses:
            raise TransportUnavailableError(
                _('The controller origin has no pinned address')
            )

        headers = {
            'Accept': 'application/json',
            'User-Agent': self.user_agent,
            'Host': origin.host_header,
        }

        body: bytes | None = None

        if json_body is not None:
            body = _encode_json(json_body)
            headers['Content-Type'] = 'application/json'

        return self._connector(
            method,
            origin,
            path,
            headers,
            body,
            timeout if timeout is not None else self.connect_timeout,
        )


def _json_response(payload: Any, status: int = 200) -> Response:
    """Build a JSON :class:`Response` with an encoded body."""
    return Response(status=status, body=_encode_json(payload))


def _has_individual_write(payload: Any) -> bool:
    """Return True when a state payload carries an individual-pixel ``i`` array."""
    if not isinstance(payload, Mapping):
        return False

    segments = payload.get('seg')

    if not isinstance(segments, list):
        return False

    return any(isinstance(entry, Mapping) and 'i' in entry for entry in segments)


def _default_state(info: Mapping[str, Any] | None) -> dict[str, Any]:
    """Build a minimal in-memory state for a simulated device."""
    count = _to_int(_dig(info, 'leds', 'count'), 0)

    return {
        'on': False,
        'bri': 128,
        'live': False,
        'lor': 0,
        'mainseg': 0,
        'nl': {'on': False, 'dur': 60, 'mode': 1, 'tbri': 0},
        'seg': [
            {
                'id': 0,
                'start': 0,
                'stop': count,
                'on': True,
                'bri': 255,
                'fx': 0,
                'frz': False,
                'grp': 1,
                'spc': 0,
                'of': 0,
                'col': [[0, 0, 0, 0]],
            }
        ],
    }


class FakeWledTransport:
    """An in-memory WLED device used for simulation and fixtures.

    It models just enough of the JSON API to exercise the production protocol
    and state machine without opening a socket, records every request, and
    supports scripted faults (timeout, non-success status, oversized, malformed
    and reboot) so the simulator fault cases can run first.
    """

    def __init__(
        self,
        info: Mapping[str, Any] | None,
        cfg: Mapping[str, Any] | None,
        state: Mapping[str, Any] | None = None,
        pins: Any = None,
        *,
        failures: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        """Initialise the device from fixtures.

        Args:
            info: The ``/json/info`` fixture (may be empty).
            cfg: The ``/json/cfg`` fixture, or ``None`` to simulate a PIN lock or
                missing configuration.
            state: An optional ``/json/state`` fixture; a default is generated.
            pins: An optional ``/json/pins`` fixture.
            failures: Scripted fault descriptors. Each descriptor may set
                ``method``/``path`` matchers (``None`` matches any) and an
                ``action`` of ``timeout``, ``unavailable``, ``status``
                (default), ``oversize``, ``malformed`` or ``reboot``.
        """
        self.info = copy.deepcopy(info) if info is not None else {}
        self.cfg = copy.deepcopy(cfg) if cfg is not None else None
        self.state = (
            copy.deepcopy(state) if state is not None else _default_state(self.info)
        )
        self.pins = copy.deepcopy(pins) if pins is not None else None
        self.failures = [dict(item) for item in (failures or [])]
        self.requests: list[dict[str, Any]] = []
        self.individual_writes: list[list[Any]] = []

    def request(
        self,
        method: str,
        origin: ResolvedOrigin,
        path: str,
        *,
        json_body: Any = None,
        timeout: float | None = None,
    ) -> Response:
        """Handle a request against the in-memory device."""
        self.requests.append({
            'method': method,
            'origin': origin.value,
            'path': path,
            'body': copy.deepcopy(json_body),
        })

        scripted = self._maybe_fail(method, path, json_body)

        if scripted is not None:
            return scripted

        if method == 'GET':
            return self._get(path)

        if method == 'POST':
            return self._post(path, json_body or {})

        return _json_response({'error': 1}, status=404)

    def _maybe_fail(
        self, method: str, path: str, json_body: Any = None
    ) -> Response | None:
        """Apply the next matching scripted fault, if any."""
        for index, failure in enumerate(self.failures):
            if failure.get('method') not in (None, method):
                continue

            if failure.get('path') not in (None, path):
                continue

            if failure.get('has_i') and not _has_individual_write(json_body):
                continue

            hits = int(failure.get('_hits', 0))
            skip = int(failure.get('skip', 0))

            if hits < skip:
                failure['_hits'] = hits + 1
                continue

            if not failure.get('repeat'):
                self.failures.pop(index)

            action = str(failure.get('action', 'status'))

            if action == 'timeout':
                raise TransportTimeoutError(_('Scripted controller timeout'))

            if action == 'unavailable':
                raise TransportUnavailableError(_('Scripted controller unavailable'))

            if action == 'oversize':
                return Response(status=200, body=b'[' + b'0,' * 40000 + b'0]')

            if action == 'malformed':
                return Response(status=200, body=b'not json')

            if action == 'reboot':
                self.info['uptime'] = 0
                return None

            return _json_response({'error': 1}, status=int(failure.get('status', 500)))

        return None

    def _get(self, path: str) -> Response:
        """Handle a GET request."""
        if path == PATH_INFO:
            return _json_response(self.info)

        if path == PATH_CFG:
            if self.cfg is None:
                return _json_response({'error': 1}, status=404)
            return _json_response(self.cfg)

        if path == PATH_STATE:
            return _json_response(self.state)

        if path == PATH_PINS:
            return _json_response(self.pins if self.pins is not None else {})

        return _json_response({'error': 1}, status=404)

    def _post(self, path: str, payload: Mapping[str, Any]) -> Response:
        """Handle a POST request by merging it into the in-memory state."""
        if path not in (PATH_STATE, '/json'):
            return _json_response({'error': 1}, status=404)

        self._apply_state(payload)

        return _json_response({'success': True})

    def _segment(self, segment_id: Any) -> dict[str, Any]:
        """Return the target segment, creating it when absent."""
        target = _to_int(segment_id, 0)
        segments = self.state.setdefault('seg', [])

        for segment in segments:
            if _to_int(segment.get('id'), 0) == target:
                return segment

        segment = {
            'id': target,
            'start': 0,
            'stop': 0,
            'on': True,
            'bri': 255,
            'fx': 0,
            'frz': False,
        }
        segments.append(segment)

        return segment

    def _apply_state(self, payload: Mapping[str, Any]) -> None:
        """Merge a WLED state command into the in-memory state."""
        if 'on' in payload:
            self.state['on'] = bool(payload['on'])

        if 'bri' in payload:
            self.state['bri'] = _to_int(payload['bri'], self.state.get('bri', 0))

        nightlight = payload.get('nl')

        if isinstance(nightlight, Mapping):
            night = self.state.setdefault('nl', {})

            for key in ('on', 'dur', 'mode', 'tbri'):
                if key in nightlight:
                    night[key] = nightlight[key]

        segments = payload.get('seg')

        if not isinstance(segments, list):
            return

        for entry in segments:
            if not isinstance(entry, Mapping):
                continue

            segment = self._segment(entry.get('id'))

            if 'start' in entry:
                segment['start'] = _to_int(entry['start'], segment.get('start', 0))

            if 'stop' in entry:
                segment['stop'] = _to_int(entry['stop'], segment.get('stop', 0))

            if segment['stop'] <= segment['start']:
                self.state['seg'] = [
                    item
                    for item in self.state['seg']
                    if _to_int(item.get('id'), 0) != _to_int(segment.get('id'), 0)
                ]
                continue

            for key in ('on', 'bri', 'fx', 'grp', 'spc', 'of', 'rev', 'mi', 'col'):
                if key in entry:
                    segment[key] = copy.deepcopy(entry[key])

            if 'frz' in entry:
                segment['frz'] = bool(entry['frz'])

            if 'i' in entry:
                self.individual_writes.append(list(entry['i']))
                segment['frz'] = True


# endregion


# region observation parsing / normalisation


def _dig(value: Any, *path: str) -> Any:
    """Descend a nested mapping, returning ``None`` when any step is missing."""
    current = value

    for key in path:
        if not isinstance(current, Mapping):
            return None

        current = current.get(key)

    return current


def _to_int(value: Any, default: int = 0) -> int:
    """Coerce a JSON value to an int, falling back to ``default``."""
    if isinstance(value, bool):
        return int(value)

    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalise_pins(value: Any) -> list[int]:
    """Normalise a WLED ``pin`` value, dropping the unused sentinel ``255``."""
    if value is None:
        return []

    if not isinstance(value, (list, tuple)):
        value = [value]

    pins: list[int] = []

    for item in value:
        if isinstance(item, bool):
            continue

        try:
            pin = int(item)
        except (TypeError, ValueError):
            continue

        if 0 <= pin < 255:
            pins.append(pin)

    return pins


def _type_token(value: Any) -> str:
    """Return the opaque LED type token for storage (never a fabricated name)."""
    if value is None:
        return ''

    if isinstance(value, bool):
        return ''

    if isinstance(value, int):
        return str(value)

    text = str(value).strip()

    return text if text.isdigit() else ''


def _normalise_mac(value: Any) -> str:
    """Normalise a MAC address to upper colon-separated form."""
    if not value:
        return ''

    text = str(value).replace(':', '').replace('-', '').strip().upper()

    if len(text) != 12 or any(c not in '0123456789ABCDEF' for c in text):
        return ''

    return ':'.join(text[i : i + 2] for i in range(0, 12, 2))


def normalise_info(info: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the redacted, whitelisted identity and LED geometry from ``/json/info``.

    Only fields used for identity, fingerprinting and geometry are retained;
    WiFi, filesystem, power, uptime, heap and signal telemetry are dropped.
    """
    info = info if isinstance(info, Mapping) else {}
    leds = info.get('leds') if isinstance(info.get('leds'), Mapping) else {}
    seglc = leds.get('seglc')

    return {
        'name': str(info.get('name', '') or ''),
        'version': str(info.get('ver', '') or ''),
        'build': _to_int(info.get('vid'), 0),
        'brand': str(info.get('brand', '') or ''),
        'product': str(info.get('product', '') or ''),
        'arch': str(info.get('arch', '') or ''),
        'mac': _normalise_mac(info.get('mac')),
        'leds': {
            'count': _to_int(leds.get('count'), 0),
            'rgbw': bool(leds.get('rgbw', False)),
            'maxseg': _to_int(leds.get('maxseg'), 0),
            'lc': _to_int(leds.get('lc'), 0),
            'seglc': [_to_int(x, 0) for x in seglc] if isinstance(seglc, list) else [],
        },
    }


def normalise_outputs(cfg: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Return the redacted output list parsed from ``hw.led.ins[]``.

    The output index is the array position (a snapshot position, not a durable
    identity). Unsupported entries are preserved verbatim rather than dropped.
    """
    ins = _dig(cfg, 'hw', 'led', 'ins')

    if not isinstance(ins, list):
        return []

    outputs: list[dict[str, Any]] = []

    for index, entry in enumerate(ins):
        if not isinstance(entry, Mapping):
            continue

        order = _to_int(entry.get('order'), 0)
        outputs.append({
            'bus_index': index,
            'wled_start': _to_int(entry.get('start'), 0),
            'pixel_count': _to_int(entry.get('len'), 0),
            'pins': _normalise_pins(entry.get('pin')),
            'led_type': _type_token(entry.get('type')),
            'colour_order': COLOR_ORDERS.get(order, str(order)),
            'bus_reverse': bool(entry.get('rev', False)),
            'skip': _to_int(entry.get('skip'), 0),
        })

    return outputs


def normalise_config(cfg: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the redacted, import-compatible normalised configuration."""
    led = _dig(cfg, 'hw', 'led') if isinstance(cfg, Mapping) else None
    led = led if isinstance(led, Mapping) else {}

    return {
        'outputs': normalise_outputs(cfg),
        'max_current_ma': _to_int(led.get('maxpwr'), 0),
        'milliamps_per_led': _to_int(led.get('ledma'), 0),
    }


def normalise_state(state: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the redacted runtime state from ``/json/state``.

    This is deliberately kept separate from the configuration: runtime changes
    (colour, effect, on/off, nightlight) must never be mistaken for hardware
    configuration drift.
    """
    state = state if isinstance(state, Mapping) else {}
    nl = state.get('nl') if isinstance(state.get('nl'), Mapping) else {}
    segments = state.get('seg') if isinstance(state.get('seg'), list) else []

    return {
        'on': bool(state.get('on', False)),
        'bri': _to_int(state.get('bri'), 0),
        'live': bool(state.get('live', False)),
        'lor': _to_int(state.get('lor'), 0),
        'mainseg': _to_int(state.get('mainseg'), 0),
        'nightlight': {
            'on': bool(nl.get('on', False)),
            'dur': _to_int(nl.get('dur'), 0),
            'mode': _to_int(nl.get('mode'), 0),
            'tbri': _to_int(nl.get('tbri'), 0),
        },
        'segments': [
            {
                'id': _to_int(seg.get('id'), index),
                'start': _to_int(seg.get('start'), 0),
                'stop': _to_int(seg.get('stop'), 0),
                'on': bool(seg.get('on', True)),
                'bri': _to_int(seg.get('bri'), 0),
                'fx': _to_int(seg.get('fx'), 0),
                'frz': bool(seg.get('frz', False)),
                'grp': _to_int(seg.get('grp'), 0),
                'spc': _to_int(seg.get('spc'), 0),
                'of': _to_int(seg.get('of'), 0),
            }
            for index, seg in enumerate(segments)
            if isinstance(seg, Mapping)
        ],
    }


def normalise_runtime(
    info: Mapping[str, Any] | None, state: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Return telemetry and runtime state, explicitly excluded from fingerprints."""
    info = info if isinstance(info, Mapping) else {}
    wifi = info.get('wifi') if isinstance(info.get('wifi'), Mapping) else {}

    return {
        'uptime': _to_int(info.get('uptime'), 0),
        'live': bool(info.get('live', False)),
        'signal': _to_int(wifi.get('signal'), 0),
        'on': bool((state or {}).get('on', False)),
        'bri': _to_int((state or {}).get('bri'), 0),
        'lor': _to_int((state or {}).get('lor'), 0),
    }


# endregion


# region capability


@dataclass
class CapabilityResult:
    """The result of classifying an observed configuration."""

    status: str
    reasons: list[dict[str, Any]] = field(default_factory=list)

    @property
    def supported(self) -> bool:
        """Return True when the configuration is supported for live use."""
        return self.status == CAPABILITY_SUPPORTED

    def as_dict(self) -> dict[str, Any]:
        """Return a serialisable representation."""
        return {'status': self.status, 'reasons': list(self.reasons)}


def _classify_led_type(type_value: Any) -> tuple[str, str]:
    """Classify an LED type token.

    Returns:
        A ``(status, reason_code)`` pair where ``status`` is ``ok`` when the type
        is a supported digital 1D RGB/RGBW type.
    """
    if not isinstance(type_value, int) or isinstance(type_value, bool):
        return CAPABILITY_UNVERIFIED, 'unknown_led_type'

    if type_value == TYPE_NONE:
        return CAPABILITY_UNVERIFIED, 'unconfigured_led_type'

    is_digital = (
        TYPE_DIGITAL_MIN <= type_value <= TYPE_DIGITAL_MAX
        or TYPE_2PIN_MIN <= type_value <= TYPE_2PIN_MAX
    )

    if TYPE_ANALOG_MIN <= type_value <= TYPE_ANALOG_MAX or type_value == TYPE_ONOFF:
        return CAPABILITY_UNSUPPORTED, 'non_digital_bus'

    if TYPE_HUB75_MIN <= type_value <= TYPE_HUB75_MAX:
        return CAPABILITY_UNSUPPORTED, 'matrix_bus'

    if TYPE_VIRTUAL_MIN <= type_value <= TYPE_VIRTUAL_MAX:
        return CAPABILITY_UNSUPPORTED, 'network_bus'

    if not is_digital:
        return CAPABILITY_UNVERIFIED, 'unknown_led_type'

    if TYPE_2PIN_MIN <= type_value <= TYPE_2PIN_MAX:
        return CAPABILITY_UNSUPPORTED, 'two_pin_bus'

    if type_value in DIGITAL_NO_RGB_TYPES:
        return CAPABILITY_UNSUPPORTED, 'no_rgb_bus'

    if type_value not in DIGITAL_RGB_TYPES:
        return CAPABILITY_UNVERIFIED, 'unknown_led_type'

    if type_value not in SUPPORTED_LED_TYPES:
        return CAPABILITY_UNSUPPORTED, 'unsupported_led_type'

    return 'ok', ''


def _detect_transforms(
    cfg: Mapping[str, Any] | None, state: Mapping[str, Any] | None
) -> list[str]:
    """Detect 2D/matrix/ledmap transforms the v1 adapter cannot drive."""
    findings: list[str] = []

    if isinstance(cfg, Mapping):
        led = _dig(cfg, 'hw', 'led')

        if isinstance(led, Mapping):
            if led.get('ledmap'):
                findings.append('ledmap')
            if led.get('matrix') or led.get('panels'):
                findings.append('matrix')

    if isinstance(state, Mapping):
        if _to_int(state.get('ledmap'), 0) > 0:
            findings.append('ledmap')

        segments = state.get('seg')

        if isinstance(segments, list):
            for seg in segments:
                if not isinstance(seg, Mapping):
                    continue
                if seg.get('startY') is not None or seg.get('stopY') is not None:
                    findings.append('matrix')
                    break
                if _to_int(seg.get('m12'), 0) > 0 or bool(seg.get('tp', False)):
                    findings.append('matrix')
                    break

    return sorted(set(findings))


def evaluate_capability(
    info: Mapping[str, Any] | None,
    cfg: Mapping[str, Any] | None,
    state: Mapping[str, Any] | None = None,
) -> CapabilityResult:
    """Classify whether an observed configuration is supported for live use.

    The result is the worst finding across all checks, so a single unsupported
    bus makes the whole controller unsupported. Missing or unparsable data is
    reported as ``unverified`` rather than guessed.

    Args:
        info: The raw ``/json/info`` payload, or ``None``.
        cfg: The raw ``/json/cfg`` payload, or ``None``.
        state: The optional raw ``/json/state`` payload.

    Returns:
        The capability classification and supporting reasons.
    """
    reasons: list[dict[str, Any]] = []

    def note(status: str, code: str, message: str, **extra: Any) -> None:
        reasons.append({'status': status, 'code': code, 'message': message, **extra})

    if not isinstance(info, Mapping):
        note(CAPABILITY_UNVERIFIED, 'missing_info', 'Controller info was not available')
        return CapabilityResult(CAPABILITY_UNVERIFIED, reasons)

    count = _to_int(_dig(info, 'leds', 'count'), 0)

    if count < 1:
        note(CAPABILITY_UNVERIFIED, 'invalid_count', 'Controller reported no LEDs')

    if not isinstance(cfg, Mapping):
        note(
            CAPABILITY_UNVERIFIED,
            'missing_cfg',
            'Controller configuration was not available (for example PIN-locked)',
        )
        return CapabilityResult(_worst(reasons), reasons)

    ins = _dig(cfg, 'hw', 'led', 'ins')

    if not isinstance(ins, list) or not ins:
        note(
            CAPABILITY_UNVERIFIED,
            'missing_outputs',
            'Controller did not report any LED outputs',
        )
        return CapabilityResult(_worst(reasons), reasons)

    intervals: list[tuple[int, int, int]] = []
    gpio_claims: dict[int, int] = {}
    total = 0

    for index, entry in enumerate(ins):
        if not isinstance(entry, Mapping):
            note(
                CAPABILITY_UNVERIFIED,
                'malformed_output',
                'An LED output entry was not an object',
                bus_index=index,
            )
            continue

        length = _to_int(entry.get('len'), 0)
        start = _to_int(entry.get('start'), 0)

        if length < 1 or start < 0:
            note(
                CAPABILITY_UNSUPPORTED,
                'invalid_bounds',
                'An LED output had a non-positive length or negative start',
                bus_index=index,
            )
            continue

        total += length
        intervals.append((start, start + length, index))

        type_status, type_code = _classify_led_type(entry.get('type'))

        if type_status != 'ok':
            note(
                type_status,
                type_code,
                'LED type is not a supported digital 1D RGB/RGBW type',
                bus_index=index,
                led_type=entry.get('type'),
            )

        if bool(entry.get('rev', False)):
            note(
                CAPABILITY_UNSUPPORTED,
                'bus_reverse',
                'Reversed buses are not supported by the v1 adapter',
                bus_index=index,
            )

        if _to_int(entry.get('skip'), 0) != 0:
            note(
                CAPABILITY_UNSUPPORTED,
                'skip',
                'Non-zero skip is not supported by the v1 adapter',
                bus_index=index,
            )

        order = _to_int(entry.get('order'), 0)

        if order not in COLOR_ORDERS:
            note(
                CAPABILITY_UNVERIFIED,
                'unknown_colour_order',
                'Unrecognised colour order',
                bus_index=index,
                colour_order=entry.get('order'),
            )

        pins = _normalise_pins(entry.get('pin'))

        if not pins:
            note(
                CAPABILITY_UNVERIFIED,
                'missing_pins',
                'An LED output did not declare any GPIO pin',
                bus_index=index,
            )

        for pin in pins:
            if pin in gpio_claims:
                note(
                    CAPABILITY_UNSUPPORTED,
                    'gpio_conflict',
                    'A GPIO pin is claimed by more than one output',
                    bus_index=index,
                    pin=pin,
                )
            else:
                gpio_claims[pin] = index

    if count and total != count:
        note(
            CAPABILITY_UNVERIFIED,
            'count_mismatch',
            'The configured bus lengths do not sum to the reported LED count',
            expected=count,
            actual=total,
        )

    for position, first in enumerate(intervals):
        for second in intervals[position + 1 :]:
            if first[0] < second[1] and second[0] < first[1]:
                note(
                    CAPABILITY_UNSUPPORTED,
                    'physical_overlap',
                    'Controller bus address ranges overlap',
                    related=[first[2], second[2]],
                )

    for transform in _detect_transforms(cfg, state):
        note(
            CAPABILITY_UNSUPPORTED,
            transform,
            'The v1 adapter cannot drive ledmap/matrix transforms',
        )

    return CapabilityResult(_worst(reasons), reasons)


def _worst(reasons: Iterable[Mapping[str, Any]]) -> str:
    """Return the worst capability status across the supplied reasons."""
    rank = 0

    for reason in reasons:
        rank = max(rank, _CAPABILITY_RANK.get(str(reason.get('status')), 0))

    for status, value in _CAPABILITY_RANK.items():
        if value == rank:
            return status

    return CAPABILITY_SUPPORTED


# endregion


# region fingerprint / diff


def _canonical_hash(payload: Any) -> str:
    """Return the deterministic SHA-256 hash used across the plugin."""
    encoded = json.dumps(
        payload, sort_keys=True, separators=(',', ':'), default=str
    ).encode('utf-8')

    return hashlib.sha256(encoded).hexdigest()


def topology_fingerprint(normalised_config: Mapping[str, Any] | None) -> str:
    """Hash only the output topology.

    This matches the fingerprint produced by the service-layer simulation
    observation, so equivalent topologies hash equally regardless of source.
    """
    outputs = (normalised_config or {}).get('outputs', [])

    return _canonical_hash({'outputs': outputs})


def config_fingerprint(
    adapter_version: str,
    info: Mapping[str, Any] | None,
    normalised_config: Mapping[str, Any] | None,
) -> str:
    """Return the adapter configuration fingerprint.

    The fingerprint covers identity, adapter/version, count, bus
    starts/lengths/GPIO/types/order/reverse/skip and light capabilities, and
    deliberately excludes uptime, signal, power and other telemetry.
    """
    info = info or {}
    leds = info.get('leds', {}) if isinstance(info, Mapping) else {}

    return _canonical_hash({
        'adapter_version': adapter_version,
        'device': {
            'name': info.get('name', ''),
            'version': info.get('version', ''),
            'build': info.get('build', 0),
            'arch': info.get('arch', ''),
            'mac': info.get('mac', ''),
        },
        'leds': {
            'count': leds.get('count', 0),
            'maxseg': leds.get('maxseg', 0),
            'lc': leds.get('lc', 0),
            'seglc': leds.get('seglc', []),
        },
        'outputs': (normalised_config or {}).get('outputs', []),
    })


def diff_configurations(
    baseline: Mapping[str, Any] | None, current: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Return the structural diff between two normalised configurations.

    Outputs are matched by their snapshot index. The diff is database-shaped and
    performs no hardware operation.
    """
    previous = {
        int(entry.get('bus_index', -1)): entry
        for entry in (baseline or {}).get('outputs', [])
        if isinstance(entry, Mapping)
    }
    proposed = {
        int(entry.get('bus_index', -1)): entry
        for entry in (current or {}).get('outputs', [])
        if isinstance(entry, Mapping)
    }

    added: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    removed: list[int] = []

    for bus_index, entry in sorted(proposed.items()):
        existing = previous.get(bus_index)

        if existing is None:
            added.append(dict(entry))
            continue

        field_diff: dict[str, Any] = {}

        for key in OUTPUT_KEYS:
            if existing.get(key) != entry.get(key):
                field_diff[key] = {'from': existing.get(key), 'to': entry.get(key)}

        if field_diff:
            changed.append({'bus_index': bus_index, 'diff': field_diff})

    for bus_index in sorted(previous):
        if bus_index not in proposed:
            removed.append(bus_index)

    return {
        'added': added,
        'changed': changed,
        'removed': removed,
        'drift': bool(added or changed or removed),
    }


def diff_observations(
    baseline: Mapping[str, Any] | None, current: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Return the identity/config/runtime diff between two observations."""
    baseline = baseline or {}
    current = current or {}
    base_info = baseline.get('info', {}) or {}
    curr_info = current.get('info', {}) or {}

    identity_keys = ('name', 'version', 'build', 'arch', 'mac')
    identity_diff = {
        key: {'from': base_info.get(key), 'to': curr_info.get(key)}
        for key in identity_keys
        if base_info.get(key) != curr_info.get(key)
    }

    return {
        'fingerprint_changed': baseline.get('fingerprint')
        != current.get('fingerprint'),
        'identity': identity_diff,
        'config': diff_configurations(
            baseline.get('normalised_config'), current.get('normalised_config')
        ),
        'capability': {
            'from': baseline.get('capability_status'),
            'to': current.get('capability_status'),
        },
        'runtime': current.get('runtime', {}),
    }


# endregion


# region chunked individual-pixel writes


@dataclass(frozen=True)
class PixelRun:
    """A contiguous half-open controller-global WLED interval and its colour."""

    start: int
    stop: int
    colour: str

    @property
    def pixels(self) -> int:
        """Return the number of pixels in this run."""
        return self.stop - self.start


def _colour_hex(rgb: Sequence[int], white: int = 0) -> str:
    """Return a WLED hex colour for a profile RGB(W) value."""
    if white:
        raise UnsupportedConfigError(
            _('RGBW white-channel values are not supported by the v1 adapter'),
            code='unsupported_configuration',
        )

    channels = []

    for index in range(3):
        value = int(rgb[index]) if index < len(rgb) else 0
        channels.append(max(0, min(255, value)))

    return ''.join(f'{channel:02X}' for channel in channels)


def build_pixel_payload(
    pieces: Sequence[tuple[int, int, str]], segment_id: int = CANONICAL_SEGMENT_ID
) -> dict[str, Any]:
    """Build one ``i`` payload from ``(start, stop, colour)`` pieces.

    Because the canonical segment starts at ``0``, the segment-relative indices
    equal the controller-global WLED indices.
    """
    values: list[Any] = []

    for start, stop, colour in pieces:
        values.extend([int(start), int(stop), colour])

    return {
        'seg': [{'id': int(segment_id), 'i': values}],
        'tt': 0,
        'udpn': {'nn': True},
    }


def prepare_pixel_runs(
    intervals: Iterable[tuple[int, int]], colour: str
) -> list[PixelRun]:
    """Validate, sort and merge ``(start, stop)`` intervals into pixel runs.

    Raises:
        ProtocolError: If an interval is empty or intervals overlap.
    """
    runs = [PixelRun(int(start), int(stop), colour) for start, stop in intervals]

    for run in runs:
        if run.stop <= run.start:
            raise ProtocolError(
                _('A pixel interval must have a positive length'),
                details={'start': run.start, 'stop': run.stop},
            )

    runs.sort(key=lambda run: run.start)
    merged: list[PixelRun] = []

    for run in runs:
        if merged and run.start < merged[-1].stop:
            raise ProtocolError(
                _('Pixel intervals must not overlap'),
                details={
                    'first': [merged[-1].start, merged[-1].stop],
                    'second': [run.start, run.stop],
                },
            )

        if merged and merged[-1].stop == run.start and merged[-1].colour == run.colour:
            previous = merged[-1]
            merged[-1] = PixelRun(previous.start, run.stop, run.colour)
        else:
            merged.append(run)

    return merged


def chunk_pixel_writes(
    runs: Sequence[PixelRun],
    *,
    segment_id: int = CANONICAL_SEGMENT_ID,
    max_pixels: int = MAX_PIXELS_PER_CHUNK,
    max_payload_bytes: int = MAX_PAYLOAD_BYTES,
) -> list[dict[str, Any]]:
    """Split pixel runs into ordered, bounded, sequential payloads.

    Each payload covers at most ``max_pixels`` pixels and encodes to at most
    ``max_payload_bytes`` bytes, matching the WLED guidance of at most 256
    colours per call and a conservative encoded payload bound.

    Raises:
        PayloadTooLargeError: If a single piece cannot be encoded within the bound.
        ProtocolError: If a run is empty.
    """
    pieces: list[tuple[int, int, str]] = []

    for run in runs:
        if run.pixels <= 0:
            raise ProtocolError(_('A pixel run must have a positive length'))

        start = run.start

        while start < run.stop:
            stop = min(start + max_pixels, run.stop)
            pieces.append((start, stop, run.colour))
            start = stop

    chunks: list[dict[str, Any]] = []
    current: list[tuple[int, int, str]] = []
    current_pixels = 0

    for piece in pieces:
        piece_pixels = piece[1] - piece[0]
        alone = build_pixel_payload([piece], segment_id=segment_id)

        if len(_encode_json(alone)) > max_payload_bytes:
            raise PayloadTooLargeError(
                _('A single pixel chunk exceeds the payload bound'),
                details={'start': piece[0], 'stop': piece[1]},
            )

        candidate = build_pixel_payload([*current, piece], segment_id=segment_id)
        over_pixels = current_pixels + piece_pixels > max_pixels
        over_bytes = len(_encode_json(candidate)) > max_payload_bytes

        if current and (over_pixels or over_bytes):
            chunks.append(build_pixel_payload(current, segment_id=segment_id))
            current = [piece]
            current_pixels = piece_pixels
        else:
            current.append(piece)
            current_pixels += piece_pixels

    if current:
        chunks.append(build_pixel_payload(current, segment_id=segment_id))

    return chunks


def nightlight_minutes(duration_seconds: int) -> int:
    """Return the coarse device-backup duration in whole minutes (1..2)."""
    minutes = math.ceil(max(0, int(duration_seconds)) / 60) or 1

    return max(MIN_NIGHTLIGHT_MINUTES, min(MAX_NIGHTLIGHT_MINUTES, minutes))


# endregion


# region state protocol payloads


def segment_takeover_payload(led_count: int) -> dict[str, Any]:
    """Build the black canonical-segment takeover payload.

    Segment ``0`` spans the whole controller with group=1, spacing=0, reverse
    and mirror off, offset=0, ``fx=0`` and a black primary colour while the
    master is off.
    """
    return {
        'seg': [
            {
                'id': CANONICAL_SEGMENT_ID,
                'start': 0,
                'stop': int(led_count),
                'grp': 1,
                'spc': 0,
                'of': 0,
                'on': True,
                'bri': 255,
                'fx': 0,
                'rev': False,
                'mi': False,
                'col': [[0, 0, 0, 0]],
            }
        ],
        'tt': 0,
        'udpn': {'nn': True},
    }


def master_off_payload() -> dict[str, Any]:
    """Build the master-off payload."""
    return {'on': False, 'tt': 0, 'udpn': {'nn': True}}


def master_on_payload(brightness: int) -> dict[str, Any]:
    """Build the master-on payload with a capped brightness."""
    return {
        'on': True,
        'bri': max(1, min(255, int(brightness))),
        'tt': 0,
        'udpn': {'nn': True},
    }


def nightlight_backup_payload(duration_seconds: int) -> dict[str, Any]:
    """Build the instant-off nightlight backup payload."""
    return {
        'nl': {
            'on': True,
            'dur': nightlight_minutes(duration_seconds),
            'mode': 0,
            'tbri': 0,
        },
        'tt': 0,
        'udpn': {'nn': True},
    }


def clear_segment_payload() -> dict[str, Any]:
    """Build the explicit black/unfreeze payload for the canonical segment."""
    return {
        'seg': [
            {'id': CANONICAL_SEGMENT_ID, 'col': [[0, 0, 0, 0]], 'fx': 0, 'frz': False}
        ],
        'tt': 0,
        'udpn': {'nn': True},
    }


def disable_nightlight_payload() -> dict[str, Any]:
    """Build the nightlight-disable payload used after a confirmed off."""
    return {'nl': {'on': False}, 'tt': 0, 'udpn': {'nn': True}}


# endregion


# region connection


def _truthy_error(value: Any) -> bool:
    """Return True when a WLED ``error`` value indicates a failure."""
    return value not in (None, False, 0, '', '0')


class WledConnection:
    """A bounded, origin-pinned connection to one controller."""

    def __init__(
        self,
        transport: Transport,
        origin: ResolvedOrigin,
        *,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
        max_response_depth: int = MAX_RESPONSE_DEPTH,
    ) -> None:
        """Configure the connection for a single resolved origin."""
        self.transport = transport
        self.origin = origin
        self.read_timeout = read_timeout
        self.max_response_bytes = max_response_bytes
        self.max_response_depth = max_response_depth

    def _validate_path(self, path: str) -> str:
        """Validate a request path, rejecting traversal and absolute URLs."""
        if not path.startswith('/') or ' ' in path or '..' in path:
            raise ProtocolError(_('Invalid request path'), details={'path': path})

        return path

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        retries: int = 0,
        idempotent: bool = False,
        timeout: float | None = None,
    ) -> Response:
        """Perform a bounded request, retrying only when explicitly idempotent."""
        self._validate_path(path)
        attempts = retries + 1 if idempotent else 1
        last_error: WledError | None = None

        for attempt in range(attempts):
            try:
                response = self.transport.request(
                    method,
                    self.origin,
                    path,
                    json_body=json_body,
                    timeout=timeout if timeout is not None else self.read_timeout,
                )
            except TransportTimeoutError as exc:
                last_error = exc

                if idempotent and attempt + 1 < attempts:
                    continue

                if not idempotent:
                    raise AmbiguousWriteError(
                        _('The write timed out and may have been applied'),
                        details={'method': method, 'path': path},
                    ) from exc

                raise

            body = response.body or b''

            if len(body) > self.max_response_bytes:
                raise ResponseTooLargeError(
                    _('Controller response exceeds the size bound')
                )

            if 200 <= response.status < 300:
                return response

            error = ControllerError(
                _('Controller returned HTTP %(status)s') % {'status': response.status},
                status=response.status,
            )
            last_error = error

            if (
                idempotent
                and response.status in (429, 500, 502, 503, 504)
                and attempt + 1 < attempts
            ):
                continue

            raise error

        raise last_error or TransportError(_('Controller request failed'))

    def _decode(self, response: Response) -> Any:
        """Decode a bounded response body."""
        return _decode_json(
            response.body,
            max_bytes=self.max_response_bytes,
            max_depth=self.max_response_depth,
        )

    def get_json(
        self, path: str, *, optional: bool = False, retries: int = MAX_GET_RETRIES
    ) -> Any:
        """Perform an idempotent bounded GET and decode the JSON body.

        Args:
            path: The request path.
            optional: When True, a missing/forbidden/malformed resource returns
                ``None`` instead of raising.
            retries: Number of bounded retries for transient failures.
        """
        try:
            response = self.request('GET', path, retries=retries, idempotent=True)
        except ControllerError as exc:
            if optional and exc.status in (403, 404, 405):
                return None
            raise

        try:
            data = self._decode(response)
        except (MalformedResponseError, ResponseTooLargeError):
            if optional:
                return None
            raise

        if isinstance(data, Mapping) and _truthy_error(data.get('error')):
            if optional:
                return None
            raise ControllerError(
                _('Controller reported an error'), details={'error': data.get('error')}
            )

        return data

    def post_json(
        self, path: str, payload: Mapping[str, Any], *, retries: int = 0
    ) -> Any:
        """Perform a bounded POST and decode any JSON acknowledgement.

        Illuminating writes must pass ``retries=0``: an ambiguous write is never
        retried blindly.
        """
        encoded = _encode_json(payload)

        if len(encoded) > MAX_PAYLOAD_BYTES:
            raise PayloadTooLargeError(
                _('Outgoing payload exceeds the size bound'),
                details={'bytes': len(encoded)},
            )

        response = self.request(
            'POST', path, json_body=payload, retries=retries, idempotent=retries > 0
        )
        data = self._decode(response)

        if isinstance(data, Mapping) and _truthy_error(data.get('error')):
            raise ControllerError(
                _('Controller reported an error'), details={'error': data.get('error')}
            )

        return data

    # region verification

    def read_state(self) -> dict[str, Any]:
        """Read and normalise the controller state."""
        return normalise_state(self.get_json(PATH_STATE))

    def verify_canonical_segment(self, led_count: int) -> None:
        """Raise unless the canonical black segment covers the whole strip."""
        state = self.read_state()
        segment = _find_segment(state, CANONICAL_SEGMENT_ID)

        if (
            segment is None
            or segment['start'] != 0
            or segment['stop'] != int(led_count)
        ):
            raise PreflightError(
                _('The canonical segment geometry could not be verified'),
                details={'segment': segment},
            )

    def verify_nightlight(self, minutes: int) -> None:
        """Raise unless the nightlight backup is armed for the expected duration."""
        state = self.read_state()
        nightlight = state['nightlight']

        if not nightlight['on'] or nightlight['dur'] != int(minutes):
            raise PreflightError(
                _('The nightlight backup could not be verified'),
                details={'nightlight': nightlight},
            )

    def verify_master_on(self, brightness: int) -> None:
        """Raise unless the master is on at the expected brightness."""
        state = self.read_state()

        if not state['on'] or state['bri'] != int(brightness):
            raise PreflightError(
                _('The master on/brightness state could not be verified'),
                details={'on': state['on'], 'bri': state['bri']},
            )

    def verify_clear(self) -> bool:
        """Return True when the controller confirms off, black and unfrozen."""
        state = self.read_state()

        if state['on'] or state['nightlight']['on']:
            return False

        return all(not segment['frz'] for segment in state['segments'])

    # endregion


def _find_segment(state: Mapping[str, Any], segment_id: int) -> dict[str, Any] | None:
    """Return the segment with ``segment_id`` from a normalised state."""
    for segment in state.get('segments', []):
        if segment.get('id') == segment_id:
            return segment

    return None


# endregion


# region adapter


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read an attribute from a mapping or an object."""
    if obj is None:
        return default

    if isinstance(obj, Mapping):
        return obj.get(name, default)

    return getattr(obj, name, default)


def _controller_id(controller: Any) -> str:
    """Return a stable string identity for a controller-like object."""
    value = _attr(controller, 'pk', None)

    if value is None:
        value = _attr(controller, 'id', None)

    return str(value) if value is not None else ''


@dataclass
class ClearResult:
    """The outcome of a clear/stop attempt."""

    clear_status: str
    acknowledged: bool
    state: dict[str, Any] | None = None
    error: str = ''

    @property
    def confirmed(self) -> bool:
        """Return True when the clear was confirmed by read-back."""
        return self.clear_status == 'confirmed'

    def as_dict(self) -> dict[str, Any]:
        """Return a serialisable representation."""
        return {
            'clear_status': self.clear_status,
            'acknowledged': self.acknowledged,
            'error': self.error,
            'state': self.state,
        }


class WledAdapter:
    """The bounded WLED adapter.

    The adapter is stateless between calls. It is constructed with an injected
    transport and origin policy, so the exact same code path drives simulation
    (in-memory transport) and live commissioning (bounded HTTP transport).
    """

    def __init__(
        self,
        transport: Transport,
        policy: OriginPolicy,
        *,
        clock: Callable[[], float] = time.monotonic,
        read_timeout: float = DEFAULT_READ_TIMEOUT,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
        max_response_depth: int = MAX_RESPONSE_DEPTH,
        enforce_config_hash: bool = True,
        adapter_version: str = ADAPTER_VERSION,
    ) -> None:
        """Configure the adapter.

        Args:
            transport: The injected transport (never auto-created).
            policy: The origin/SSRF policy.
            clock: A monotonic clock used for deadlines.
            read_timeout: Per-request read timeout.
            max_response_bytes: Response size bound.
            max_response_depth: Response JSON depth bound.
            enforce_config_hash: Reject live apply when the observed
                configuration drifts from the controller's approved fingerprint.
            adapter_version: Adapter identity recorded on observations.
        """
        self.transport = transport
        self.policy = policy
        self.clock = clock
        self.read_timeout = read_timeout
        self.max_response_bytes = max_response_bytes
        self.max_response_depth = max_response_depth
        self.enforce_config_hash = enforce_config_hash
        self.adapter_version = adapter_version

    # region connection / observation

    def connection(self, controller: Any) -> WledConnection:
        """Resolve and check the controller origin, returning a connection."""
        origin_value = _attr(controller, 'origin', '') or ''

        if not str(origin_value).strip():
            raise UnsafeOriginError(_('A controller origin is required'))

        resolved = self.policy.check(str(origin_value))

        return WledConnection(
            self.transport,
            resolved,
            read_timeout=self.read_timeout,
            max_response_bytes=self.max_response_bytes,
            max_response_depth=self.max_response_depth,
        )

    def observe(
        self, controller: Any, *, baseline: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """Read and redact a controller observation.

        Reads ``/json/info`` (required), ``/json/cfg`` and ``/json/state``
        (optional). A missing or unparsable cfg degrades the capability to
        ``unverified`` rather than fabricating a bus list.

        Args:
            controller: A controller-like object exposing ``origin``.
            baseline: Optional previous observation used to build a diff.

        Returns:
            The observation dictionary stored on ``ConfigObservation``.
        """
        connection = self.connection(controller)

        return self._observe_with(connection, baseline=baseline)

    def _observe_with(
        self, connection: WledConnection, *, baseline: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """Build an observation from an existing connection."""
        info_raw = connection.get_json(PATH_INFO)
        cfg_raw = connection.get_json(PATH_CFG, optional=True)
        state_raw = connection.get_json(PATH_STATE, optional=True)

        info = normalise_info(info_raw)
        normalised = normalise_config(cfg_raw)
        capability = evaluate_capability(info_raw, cfg_raw, state_raw)
        fingerprint = config_fingerprint(self.adapter_version, info, normalised)

        observation = {
            'adapter_version': self.adapter_version,
            'info': info,
            'normalised_config': normalised,
            'fingerprint': fingerprint,
            'capability_status': capability.status,
            'capability_reasons': capability.reasons,
            'firmware_target': FIRMWARE_TARGET,
            'runtime': normalise_runtime(info_raw, state_raw),
        }

        if baseline is not None:
            observation['diff'] = diff_observations(baseline, observation)

        return observation

    # endregion

    # region apply

    def _brightness_cap(self, controller: Any) -> int:
        """Return the commissioned brightness cap for a controller."""
        policy = _attr(controller, 'commissioning_policy', None) or {}

        cap = policy.get('brightness_cap') if isinstance(policy, Mapping) else None

        try:
            cap = int(cap)
        except (TypeError, ValueError):
            cap = DEFAULT_BRIGHTNESS_CAP

        return max(1, min(255, cap))

    def _check_drift(self, controller: Any, observation: Mapping[str, Any]) -> None:
        """Raise when the observed fingerprint differs from the approved one."""
        if not self.enforce_config_hash:
            return

        expected = str(_attr(controller, 'armed_config_hash', '') or '')

        if not expected:
            approved = _attr(controller, 'approved_snapshot', None)

            if approved is not None:
                expected = str(_attr(approved, 'fingerprint', '') or '')

        if expected and expected != observation.get('fingerprint'):
            raise ConfigDriftError(
                _('The observed controller configuration has drifted'),
                details={
                    'expected': expected,
                    'observed': observation.get('fingerprint'),
                },
            )

    def _check_ownership(self, observation: Mapping[str, Any]) -> None:
        """Reject an active realtime/external ownership conflict."""
        runtime = observation.get('runtime') or {}

        if runtime.get('live'):
            raise ProtocolError(
                _('The controller is receiving realtime data'),
                code='ownership_conflict',
            )

    def _verify_identity(
        self, connection: WledConnection, observation: Mapping[str, Any]
    ) -> None:
        """Re-read identity and reject a replacement or an unexpected reboot."""
        info = connection.get_json(PATH_INFO) or {}
        mac = _normalise_mac(info.get('mac'))
        uptime = _to_int(info.get('uptime'), 0)
        expected_mac = (observation.get('info') or {}).get('mac', '')
        expected_uptime = _to_int((observation.get('runtime') or {}).get('uptime'), 0)

        if expected_mac and mac and mac != expected_mac:
            raise ConfigDriftError(
                _('The controller identity changed during preflight'),
                details={'expected': expected_mac, 'observed': mac},
            )

        if uptime < expected_uptime:
            raise ProtocolError(
                _('The controller rebooted during preflight'),
                code='reboot_detected',
                details={'before': expected_uptime, 'after': uptime},
            )

    def _runs_for(
        self, controller: Any, plan: Mapping[str, Any]
    ) -> list[Mapping[str, Any]]:
        """Return the plan runs which target this controller."""
        controller_id = _controller_id(controller)
        listed = plan.get('controllers')

        if isinstance(listed, (list, tuple, set)) and controller_id not in {
            str(item) for item in listed
        }:
            return []

        return [
            run
            for run in (plan.get('runs') or [])
            if str(run.get('controller')) == controller_id
        ]

    def apply(
        self,
        controller: Any,
        plan: Mapping[str, Any],
        *,
        cleanup_on_failure: bool = True,
    ) -> dict[str, Any]:
        """Execute the safe locate/test protocol for one controller.

        The sequence is: read and validate, establish a black canonical segment
        while the master is off, arm the nightlight backup, switch the master on,
        clear the canonical segment explicitly, then send bounded individual
        pixel chunks sequentially.

        Args:
            controller: The controller-like object to drive.
            plan: A session plan carrying ``runs``, ``controllers``, ``profile``
                and ``duration_seconds``.
            cleanup_on_failure: When True (the safe default), a failure after the
                master has been switched on attempts a bounded clear so a single
                controller is never left lit by this call. The error is still
                raised, whether or not the cleanup succeeded.

        Returns:
            An acknowledgement record. This reports that commands were
            acknowledged, never that LEDs were optically verified.

        Raises:
            UnsafeOriginError: If the origin is not permitted.
            UnsupportedConfigError: If the observed configuration is unsupported.
            ConfigDriftError: If the observation drifted from the approved config.
            PreflightError: If a verification step fails.
            TransportError: If a transport error makes the outcome ambiguous.
        """
        connection = self.connection(controller)
        observation = self._observe_with(connection)

        if observation['capability_status'] != CAPABILITY_SUPPORTED:
            raise UnsupportedConfigError(
                _('The controller configuration is not supported'),
                details={
                    'status': observation['capability_status'],
                    'reasons': observation['capability_reasons'],
                },
            )

        self._check_drift(controller, observation)
        self._check_ownership(observation)

        runs = self._runs_for(controller, plan)

        if not runs:
            return {
                'acknowledged': False,
                'reason': 'no-runs',
                'origin': connection.origin.value,
                'controller': _controller_id(controller),
            }

        profile = plan.get('profile') or {}
        rgb = profile.get('rgb') or [0, 255, 0]
        white = int(profile.get('white', 0) or 0)
        colour = _colour_hex(rgb, white)

        brightness = min(
            max(1, int(profile.get('brightness', DEFAULT_BRIGHTNESS_CAP) or 1)),
            self._brightness_cap(controller),
        )
        duration = max(1, int(plan.get('duration_seconds', 120) or 120))
        minutes = nightlight_minutes(duration)
        led_count = int(observation['info']['leds']['count'])

        if led_count < 1:
            raise UnsupportedConfigError(
                _('The controller reported no LEDs to address'),
                details={'count': led_count},
            )

        intervals = [(int(run['wled_start']), int(run['wled_stop'])) for run in runs]
        pixel_runs = prepare_pixel_runs(intervals, colour)
        chunks = chunk_pixel_writes(pixel_runs)
        deadline = self.clock() + duration
        output_live = False

        try:
            # 1. Establish black canonical geometry while the master is off.
            connection.post_json(PATH_STATE, master_off_payload())
            connection.post_json(PATH_STATE, segment_takeover_payload(led_count))
            connection.verify_canonical_segment(led_count)

            # 2. Arm the device-backup nightlight BEFORE master-on / first pixel.
            connection.post_json(PATH_STATE, nightlight_backup_payload(duration))
            connection.verify_nightlight(minutes)

            # 3. Switch the master on in its own acknowledged request.
            connection.post_json(PATH_STATE, master_on_payload(brightness))
            connection.verify_master_on(brightness)
            connection.verify_nightlight(minutes)
            self._verify_identity(connection, observation)

            # Past this point the strip may be visibly lit, so a failure must
            # not leave it on without an attempt to clear it.
            output_live = True

            # 4. Clear the canonical segment explicitly, then send pixels.
            connection.post_json(PATH_STATE, clear_segment_payload())

            for chunk in chunks:
                if self.clock() > deadline:
                    raise ProtocolError(
                        _('The locate deadline elapsed before all chunks were sent')
                    )

                connection.post_json(PATH_STATE, chunk)
        except Exception:
            if cleanup_on_failure and output_live:
                try:
                    self.clear(controller)
                except Exception:  # cleanup is best effort; never mask the error
                    pass

            raise

        return {
            'acknowledged': True,
            'adapter_version': self.adapter_version,
            'controller': _controller_id(controller),
            'origin': connection.origin.value,
            'led_count': led_count,
            'brightness': brightness,
            'duration_seconds': duration,
            'nightlight_minutes': minutes,
            'chunks': len(chunks),
            'pixels': sum(run.pixels for run in pixel_runs),
            'intervals': [[run.start, run.stop] for run in pixel_runs],
            'expires_at': deadline,
        }

    # endregion

    # region clear / stop

    def clear(self, controller: Any) -> ClearResult:
        """Idempotently return a controller to an off, black, unfrozen state.

        Master-off, canonical-segment clear and nightlight-disable are attempted;
        ``clear_status`` is only ``confirmed`` when a read-back proves the
        controller is off, black and unfrozen. An unreachable or ambiguous
        controller is reported as ``unconfirmed`` and never as safe.
        """
        result = ClearResult(clear_status='unconfirmed', acknowledged=False)

        try:
            connection = self.connection(controller)
        except WledError as exc:
            result.error = str(exc)
            return result

        try:
            connection.post_json(
                PATH_STATE, master_off_payload(), retries=MAX_CLEAR_RETRIES
            )
            connection.post_json(
                PATH_STATE, clear_segment_payload(), retries=MAX_CLEAR_RETRIES
            )
            connection.post_json(
                PATH_STATE, disable_nightlight_payload(), retries=MAX_CLEAR_RETRIES
            )

            result.acknowledged = True
            state = connection.read_state()
            result.state = state
            result.clear_status = (
                'confirmed' if connection.verify_clear() else 'unconfirmed'
            )
        except WledError as exc:
            result.error = str(exc)
            result.clear_status = 'unconfirmed'

        return result

    def stop(self, controller: Any) -> ClearResult:
        """Stop an operation; identical to :meth:`clear`."""
        return self.clear(controller)

    # endregion


def default_policy() -> OriginPolicy:
    """Return the live origin policy from the operator allowlist setting.

    An empty allowlist yields a deny-all policy, so live access fails closed.
    """
    try:
        from storage_layout.services import plugin_setting

        allowlist = plugin_setting('HARDWARE_NETWORK_ALLOWLIST', '')
    except Exception:  # pragma: no cover - defensive
        allowlist = ''

    try:
        return OriginPolicy.from_setting(allowlist)
    except AllowlistError:  # pragma: no cover - defensive
        return OriginPolicy(entries=())


def get_adapter(
    *,
    transport: Transport | None = None,
    policy: OriginPolicy | None = None,
    **options: Any,
) -> WledAdapter:
    """Return the live adapter used by the service layer.

    This is the module entry point consumed by
    ``storage_layout.services.load_wled_adapter``. It never opens a socket at
    construction time and fails closed at request time unless an allowlist is
    configured and the origin resolves inside it.

    Args:
        transport: Optional injected transport (tests/simulation). When omitted a
            bounded :class:`HttpTransport` with network access enabled is used.
        policy: Optional injected origin policy.
        **options: Additional :class:`WledAdapter` keyword arguments.

    Returns:
        A configured adapter.
    """
    if transport is None:
        transport = HttpTransport(allow_network=True)

    if policy is None:
        policy = default_policy()

    return WledAdapter(transport=transport, policy=policy, **options)


# endregion


__all__ = [
    'ADAPTER_VERSION',
    'CAPABILITY_SUPPORTED',
    'CAPABILITY_UNSUPPORTED',
    'CAPABILITY_UNVERIFIED',
    'FIRMWARE_TARGET',
    'MAX_PAYLOAD_BYTES',
    'MAX_PIXELS_PER_CHUNK',
    'SUPPORTED_LED_TYPES',
    'AllowlistEntry',
    'AllowlistError',
    'AmbiguousWriteError',
    'CapabilityResult',
    'ClearResult',
    'ConfigDriftError',
    'ControllerError',
    'FakeWledTransport',
    'HttpTransport',
    'MalformedResponseError',
    'OriginPolicy',
    'PayloadTooLargeError',
    'PixelRun',
    'PreflightError',
    'ProtocolError',
    'RecordingTransport',
    'ResolvedOrigin',
    'Response',
    'ResponseTooLargeError',
    'Transport',
    'TransportError',
    'TransportTimeoutError',
    'TransportUnavailableError',
    'UnsafeOriginError',
    'UnsupportedConfigError',
    'WledAdapter',
    'WledConnection',
    'WledError',
    'build_pixel_payload',
    'chunk_pixel_writes',
    'clear_segment_payload',
    'config_fingerprint',
    'default_policy',
    'diff_configurations',
    'diff_observations',
    'disable_nightlight_payload',
    'evaluate_capability',
    'get_adapter',
    'master_off_payload',
    'master_on_payload',
    'nightlight_backup_payload',
    'nightlight_minutes',
    'normalise_config',
    'normalise_info',
    'normalise_outputs',
    'normalise_runtime',
    'normalise_state',
    'parse_allowlist',
    'prepare_pixel_runs',
    'segment_takeover_payload',
    'system_resolver',
    'topology_fingerprint',
]
