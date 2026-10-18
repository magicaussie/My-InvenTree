"""Real-HTTP integration checks for the Storage Layout & WLED plugin.

This script exercises a **running** InvenTree stack over real HTTP. It never
mocks the API, never imports plugin code, and never contacts a physical
controller. Every assertion is made against the deployed backend through its
public REST API. It also creates a small amount of native inventory (one part
and one stock item bound to a plugin bin) so the browser suite has a real item
to locate.

It is intended to be run by the owning lead after the isolated Docker stack is
up and ``seed.py`` has prepared the environment. The plugin API must be mounted
and the background worker must be running for the asynchronous checks.

Environment:

    SL_BASE_URL            backend base URL     (default: http://127.0.0.1:18761)
    SL_ADMIN_USER          admin username       (default: sl_admin)
    SL_ADMIN_PASSWORD      admin password       (required)
    SL_READONLY_USER       read-only username   (default: sl_readonly)
    SL_READONLY_PASSWORD   read-only password   (required)
    SL_RESULTS_DIR         results directory    (default: <repo>/contrib/.../.runtime)
    SL_ASYNC_TIMEOUT       async wait seconds   (default: 120)
    SL_HTTP_TIMEOUT        HTTP timeout seconds (default: 30)
    SL_VERIFY_TLS          verify TLS           (default: true)
    SL_RUN_ID              override the run id  (default: generated)

Credentials and tokens are read from the environment and are never written to
the results file; the results contain fixture identifiers only.

Exit code is ``0`` when no check failed, ``1`` when a check failed, and ``2``
when the configuration is incomplete.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_SLUG = 'storage-layout'
PLUGIN_API = f'/plugin/{PLUGIN_SLUG}/api/v1/'
STOCK_API = '/api/'

PASS = 'pass'
FAIL = 'fail'
SKIP = 'skip'

#: Response keys whose values are redacted before being written as evidence.
SENSITIVE_KEYS = frozenset({
    'token',
    'password',
    'authorization',
    'secret',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
    'key',
})


class ConfigError(RuntimeError):
    """Raised when required runtime configuration is missing."""


class TransportError(RuntimeError):
    """Raised when the HTTP transport cannot reach the backend."""


def _redact(value):
    """Return ``value`` with credential-bearing keys replaced."""
    if isinstance(value, dict):
        return {
            key: '<redacted>' if str(key).lower() in SENSITIVE_KEYS else _redact(item)
            for key, item in value.items()
        }

    if isinstance(value, list):
        return [_redact(item) for item in value]

    return value


class Response:
    """A minimal HTTP response wrapper with JSON and ETag helpers."""

    def __init__(self, status, headers, text):
        """Store the status code, headers and decoded body text."""
        self.status = status
        self.headers = {str(key).lower(): value for key, value in headers.items()}
        self.text = text
        self._json = None
        self._parsed = False

    @property
    def json(self):
        """Return the decoded JSON body, or ``None`` when the body is not JSON."""
        if not self._parsed:
            try:
                self._json = json.loads(self.text) if self.text else None
            except ValueError:
                self._json = None

            self._parsed = True

        return self._json

    @property
    def etag(self):
        """Return the raw ``ETag`` header value, or an empty string."""
        return str(self.headers.get('etag', ''))

    def summary(self, limit=700):
        """Return a redacted, truncated body summary for use as evidence."""
        payload = self.json if self.json is not None else self.text

        try:
            text = json.dumps(_redact(payload), sort_keys=True, default=str)
        except (TypeError, ValueError):
            text = str(payload)

        if len(text) > limit:
            text = text[:limit] + '...'

        return text


class Client:
    """A small JSON HTTP client with token or basic authentication."""

    def __init__(self, base_url, timeout, *, token=None, basic=None, verify_tls=True):
        """Configure the client for a base URL and an authentication mode."""
        self.base_url = base_url.rstrip('/')
        self.timeout = timeout
        self.token = token
        self.basic = basic
        self.context = None

        if self.base_url.startswith('https') and not verify_tls:
            self.context = ssl.create_default_context()
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def request(self, method, path, *, body=None, headers=None):
        """Perform a request and return a :class:`Response`.

        Raises:
            TransportError: When the backend cannot be reached at all.
        """
        url = f'{self.base_url}{path}'
        data = None
        request_headers = {'Accept': 'application/json'}

        if body is not None:
            data = json.dumps(body).encode('utf-8')
            request_headers['Content-Type'] = 'application/json'

        if self.token:
            request_headers['Authorization'] = f'Token {self.token}'
        elif self.basic:
            raw = f'{self.basic[0]}:{self.basic[1]}'.encode()
            encoded = base64.b64encode(raw).decode('ascii')
            request_headers['Authorization'] = f'Basic {encoded}'

        if headers:
            request_headers.update(headers)

        request = urllib.request.Request(
            url, data=data, headers=request_headers, method=method
        )

        try:
            with urllib.request.urlopen(
                request, timeout=self.timeout, context=self.context
            ) as response:
                text = response.read().decode('utf-8', 'replace')

                return Response(response.status, dict(response.headers), text)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode('utf-8', 'replace')

            return Response(exc.code, dict(exc.headers or {}), text)
        except urllib.error.URLError as exc:
            raise TransportError(f'{method} {url} failed: {exc.reason}') from exc


class Recorder:
    """Collects check outcomes, fixture identifiers and discovered bugs."""

    def __init__(self):
        """Initialise an empty recorder."""
        self.checks = []
        self.fixtures = {}
        self.bugs = []

    def record(
        self, name, status, *, detail='', expected=None, observed=None, evidence=None
    ):
        """Append a single check outcome."""
        self.checks.append({
            'name': name,
            'status': status,
            'detail': detail,
            'expected': expected,
            'observed': observed,
            'evidence': evidence,
        })

        return status == PASS

    def ok(self, name, *, detail='', expected=None, observed=None, evidence=None):
        """Record a passing check."""
        return self.record(
            name,
            PASS,
            detail=detail,
            expected=expected,
            observed=observed,
            evidence=evidence,
        )

    def fail(self, name, *, detail='', expected=None, observed=None, evidence=None):
        """Record a failing check."""
        return self.record(
            name,
            FAIL,
            detail=detail,
            expected=expected,
            observed=observed,
            evidence=evidence,
        )

    def skip(self, name, *, detail=''):
        """Record a skipped check (a missing prerequisite, not a defect)."""
        return self.record(name, SKIP, detail=detail)

    def expect(
        self, name, condition, *, detail='', expected=None, observed=None, evidence=None
    ):
        """Record a pass or fail based on ``condition`` and return the boolean."""
        if condition:
            return self.ok(
                name,
                detail=detail,
                expected=expected,
                observed=observed,
                evidence=evidence,
            )

        return self.fail(
            name, detail=detail, expected=expected, observed=observed, evidence=evidence
        )

    def bug(self, title, detail):
        """Record a discovered defect for the lead to triage and fix."""
        self.bugs.append({'title': title, 'detail': detail})


class Config:
    """Runtime configuration resolved from the environment."""

    def __init__(self):
        """Resolve configuration, raising when required values are missing."""
        self.base_url = os.environ.get('SL_BASE_URL', 'http://127.0.0.1:18761').rstrip(
            '/'
        )
        self.admin_user = os.environ.get('SL_ADMIN_USER', 'sl_admin').strip()
        self.admin_password = os.environ.get('SL_ADMIN_PASSWORD', '')
        self.readonly_user = os.environ.get('SL_READONLY_USER', 'sl_readonly').strip()
        self.readonly_password = os.environ.get('SL_READONLY_PASSWORD', '')
        self.results_dir = Path(
            os.environ.get('SL_RESULTS_DIR')
            or (Path(__file__).resolve().parent / '.runtime')
        )
        self.http_timeout = float(os.environ.get('SL_HTTP_TIMEOUT', '30'))
        self.async_timeout = float(os.environ.get('SL_ASYNC_TIMEOUT', '120'))
        self.verify_tls = os.environ.get('SL_VERIFY_TLS', 'true').lower() not in {
            '0',
            'false',
            'no',
        }
        self.run_id = os.environ.get('SL_RUN_ID') or (
            f'{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}-'
            f'{uuid.uuid4().hex[:6]}'
        )

        missing = [
            name
            for name, value in (
                ('SL_ADMIN_PASSWORD', self.admin_password),
                ('SL_READONLY_PASSWORD', self.readonly_password),
            )
            if not value
        ]

        if missing:
            raise ConfigError(
                'missing required environment variable(s): ' + ', '.join(missing)
            )


class IntegrationChecks:
    """Drives the ordered integration checks against the running backend."""

    def __init__(self, config):
        """Initialise the checks with resolved configuration."""
        self.config = config
        self.recorder = Recorder()
        self.anon = Client(
            config.base_url, config.http_timeout, verify_tls=config.verify_tls
        )
        self.admin = self.anon
        self.readonly = self.anon

        self.cabinet_id = None
        self.cabinet_revision = None
        self.cabinet_location = None
        self.drawer_locations = []
        self.bin_locations = []
        self.drawers = {}
        self.bins = {}
        self.controllers = {}
        self.strings = {}
        self.mapping_hash = ''
        self.locate_profile = None
        self.test_profile = None
        self.observation_id = None
        self.approved_fingerprint = ''
        self.session_id = None
        self.part = None
        self.stock_item = None

    # region helpers

    def _expect_status(self, name, response, allowed, *, detail='', evidence=None):
        """Assert that a response status is in ``allowed``."""
        return self.recorder.expect(
            name,
            response.status in allowed,
            detail=detail,
            expected=f'HTTP {sorted(allowed)}',
            observed=f'HTTP {response.status}',
            evidence=evidence if evidence is not None else response.summary(),
        )

    def _revision_from(self, response, fallback):
        """Return the cabinet revision carried by a response."""
        etag = response.etag.strip().strip('"')

        if etag.isdigit():
            return int(etag)

        payload = response.json or {}

        for candidate in (
            payload.get('revision'),
            (payload.get('cabinet') or {}).get('revision'),
        ):
            if isinstance(candidate, int):
                return candidate

        return fallback

    def _track_revision(self, response):
        """Advance the tracked revision from a successful write response.

        Every aggregate write returns the new revision in the ``ETag`` (and
        usually in the body). When neither is present the revision is left
        unchanged rather than guessed, so a failed write cannot inflate the
        tracked revision and cascade into spurious precondition failures.
        """
        self.cabinet_revision = self._revision_from(response, self.cabinet_revision)

    def _if_match(self):
        """Return the current ``If-Match`` header value."""
        return {'If-Match': f'"{self.cabinet_revision}"'}

    def _create_location(self, name, *, parent=None, structural=False):
        """Create a native stock location and return its primary key."""
        body = {'name': name, 'structural': structural}

        if parent is not None:
            body['parent'] = parent

        response = self.admin.request('POST', f'{STOCK_API}stock/location/', body=body)
        payload = response.json or {}

        if response.status in (200, 201) and isinstance(payload.get('pk'), int):
            return payload['pk']

        self.recorder.fail(
            'create_native_location',
            detail=f'could not create native location {name!r}',
            expected='HTTP 201',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        return None

    def _wait_for(self, path, states, *, timeout=None):
        """Poll ``path`` until ``state`` is in ``states`` or the timeout elapses.

        The default wait is deliberately longer than the plugin's bounded
        reconciliation loop (``storage_layout.tasks.WATCHDOG_DURATION_SECONDS``,
        55s): that loop runs inside a single background-worker slot, so durable
        dispatch can be delayed by up to ~55s when the deployment effectively
        runs one worker. Waiting well past that bound measures the plugin's
        correct behaviour instead of racing its own scheduled task, and still
        fails when no worker is running at all.
        """
        limit = timeout if timeout is not None else self.config.async_timeout
        deadline = time.monotonic() + limit
        last = None

        while time.monotonic() < deadline:
            response = self.admin.request('GET', path)

            if response.status == 200:
                last = response.json or {}

                if last.get('state') in states:
                    return last, True

            time.sleep(0.5)

        return last, False

    def _layout_document(self):
        """Return the saved layout projected back into an editable document."""
        response = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/'
        )
        payload = response.json or {}
        cabinet = payload.get('cabinet') or {}
        drawers = [
            {
                'id': entry.get('id'),
                'label': entry.get('label'),
                'display_number': entry.get('display_number'),
                'location': entry.get('location'),
                'x': entry.get('x'),
                'y': entry.get('y'),
                'width': entry.get('width'),
                'height': entry.get('height'),
                'interior_width': entry.get('interior_width'),
                'interior_height': entry.get('interior_height'),
                'archived': entry.get('archived'),
                'allocation': entry.get('allocation'),
            }
            for entry in payload.get('drawers', [])
        ]
        bins = [
            {
                'id': entry.get('id'),
                'drawer': entry.get('drawer'),
                'label': entry.get('label'),
                'location': entry.get('location'),
                'x': entry.get('x'),
                'y': entry.get('y'),
                'width': entry.get('width'),
                'height': entry.get('height'),
                'archived': entry.get('archived'),
            }
            for entry in payload.get('bins', [])
        ]

        return {
            'schema_version': 1,
            'cabinet': {
                'width_units': cabinet.get('width_units'),
                'height_units': cabinet.get('height_units'),
            },
            'drawers': drawers,
            'bins': bins,
            'archive_ids': [],
        }

    def _put_layout(self, document):
        """PUT a full layout document using the current revision."""
        return self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/',
            body=document,
            headers=self._if_match(),
        )

    def _put_electrical(self, controllers):
        """PUT an electrical document using the current revision."""
        return self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/electrical/',
            body={'schema_version': 1, 'controllers': controllers, 'archive_ids': []},
            headers=self._if_match(),
        )

    @staticmethod
    def _controller_entry(name, origin, mac, pins, wled_start):
        """Return an electrical-document controller entry."""
        return {
            'id': None,
            'name': name,
            'origin': origin,
            'expected_mac': mac,
            'firmware_adapter': 'wled-v16.0.1-1d',
            'enabled': True,
            'outputs': [
                {
                    'id': None,
                    'bus_index': 0,
                    'wled_start': wled_start,
                    'pixel_count': 10,
                    'pins': pins,
                    'led_type': '22',
                    'colour_order': 'GRB',
                    'bus_reverse': False,
                    'skip': 0,
                    'strings': [
                        {
                            'id': None,
                            'label': 'S',
                            'output_offset': 0,
                            'pixel_count': 10,
                            'notes': '',
                            'archived': False,
                        }
                    ],
                }
            ],
        }

    def _expect_documented_error(self, name, response, *, detail=''):
        """Assert a documented HTTP 400 error shape rather than an unhandled 500."""
        payload = response.json if isinstance(response.json, dict) else {}

        return self.recorder.expect(
            name,
            response.status == 400 and 'code' in payload,
            detail=detail,
            expected='HTTP 400 with the documented {code, message, ...} shape',
            observed=f'HTTP {response.status}',
            evidence=response.summary(400),
        )

    def _labels_by_drawer(self):
        """Return a mapping of drawer id to label for the saved layout."""
        response = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/'
        )

        return {
            entry.get('id'): entry.get('label')
            for entry in (response.json or {}).get('drawers', [])
        }

    def _schema_post_fields(self, path):
        """Return the OPTIONS ``POST`` field metadata for an endpoint, or ``None``.

        ``InvenTreeMetadata`` derives the available actions and their serializer
        fields from the deployed API, so this is the authoritative source for the
        fields a create request must supply.
        """
        response = self.admin.request('OPTIONS', path)

        if response.status != 200:
            return None

        actions = (response.json or {}).get('actions')

        if not isinstance(actions, dict) or not isinstance(actions.get('POST'), dict):
            return None

        return actions['POST']

    def _schema_placeholder(self, meta):
        """Return a minimal safe value for a required field from its schema type."""
        kind = str(meta.get('type') or '')

        if kind == 'choice':
            choices = meta.get('choices') or []

            return choices[0].get('value') if choices else None

        if kind in {'integer', 'decimal', 'float', 'number'}:
            return 1

        if kind == 'boolean':
            return False

        if kind == 'string':
            limit = meta.get('max_length') or 64

            return f'sl-{self.config.run_id}'[:limit]

        if kind == 'list':
            return []

        return None

    def _create_from_schema(self, name, path, values):
        """Create an object, deriving required fields from the OPTIONS schema.

        Args:
            name: Check-name prefix.
            path: Create endpoint path (for example ``/api/part/``).
            values: Field values the caller already knows (name, relations).

        Returns:
            The created object, or ``None`` when creation was skipped or failed.
        """
        fields = self._schema_post_fields(path)

        if fields is None:
            self.recorder.skip(
                f'{name}_created',
                detail=f'the OPTIONS schema for {path} did not expose POST fields',
            )

            return None

        payload = {}
        unresolved = []

        for field, meta in fields.items():
            meta = meta if isinstance(meta, dict) else {}

            if meta.get('read_only'):
                continue

            if values.get(field) is not None:
                payload[field] = values[field]
                continue

            if not meta.get('required'):
                continue

            placeholder = self._schema_placeholder(meta)

            if placeholder is None:
                unresolved.append(field)
            else:
                payload[field] = placeholder

        if unresolved:
            self.recorder.skip(
                f'{name}_created',
                detail=(
                    'required field(s) could not be derived from the schema, so '
                    f'creation was not attempted: {sorted(unresolved)}'
                ),
            )

            return None

        response = self.admin.request('POST', path, body=payload)
        raw = response.json
        record = None

        if isinstance(raw, dict):
            record = raw
        elif isinstance(raw, list) and raw and isinstance(raw[0], dict):
            # InvenTree's stock create endpoint returns a list of created items.
            record = raw[0]

        created = response.status in (200, 201) and isinstance(
            (record or {}).get('pk'), int
        )
        self.recorder.expect(
            f'{name}_created',
            created,
            detail=f'create via {path} with schema-derived fields {sorted(payload)}',
            expected='HTTP 201 with a pk',
            observed=f'HTTP {response.status}',
            evidence=response.summary(400),
        )

        return record if created else None

    # endregion

    # region phases

    def phase_connectivity(self):
        """Verify the backend is reachable and obtain API tokens."""
        # InvenTree answers an unauthenticated API request with 401; that still
        # proves the backend is up. The version document is verified again once
        # a token is available.
        response = self.anon.request('GET', f'{STOCK_API}version/')
        self.recorder.expect(
            'server_reachable',
            response.status in (200, 401),
            detail=(
                'InvenTree version endpoint (401 is the expected anonymous '
                'response in this deployment)'
            ),
            expected='HTTP 200 or 401',
            observed=f'HTTP {response.status}',
            evidence=response.summary(200),
        )

        admin_token = self._login(
            self.config.admin_user, self.config.admin_password, 'admin'
        )
        readonly_token = self._login(
            self.config.readonly_user, self.config.readonly_password, 'readonly'
        )

        if admin_token:
            self.admin = Client(
                self.config.base_url,
                self.config.http_timeout,
                token=admin_token,
                verify_tls=self.config.verify_tls,
            )

        if readonly_token:
            self.readonly = Client(
                self.config.base_url,
                self.config.http_timeout,
                token=readonly_token,
                verify_tls=self.config.verify_tls,
            )

        response = self.admin.request('GET', f'{STOCK_API}version/')
        payload = response.json if isinstance(response.json, dict) else {}
        self.recorder.expect(
            'version_after_auth',
            response.status == 200 and isinstance(payload.get('version'), dict),
            detail='the version document is readable once a token is presented',
            expected='HTTP 200 with a JSON version document',
            observed=f'HTTP {response.status}',
            evidence=response.summary(300),
        )

        # The plugin API is served under /plugin/, which InvenTree's own
        # auth middleware protects before DRF runs: only a Token can reach it
        # (basic auth is answered with a plain 401 by that middleware).
        response = self.admin.request('GET', f'{PLUGIN_API}schema/')
        self.recorder.expect(
            'plugin_api_mounted',
            response.status == 200 and isinstance(response.json, dict),
            detail=(
                'plugin OpenAPI schema is served with token auth (a 401 here '
                'means the token did not reach the plugin; a non-JSON body means '
                'the URL gate is off or the plugin is inactive)'
            ),
            expected='HTTP 200 with a JSON schema document',
            observed=f'HTTP {response.status}',
            evidence=response.summary(300),
        )

    def _login(self, username, password, role):
        """Obtain an API token via HTTP basic authentication.

        The modern ``/api/user/me/token/`` endpoint always issues a fresh token
        (re-issuing for an existing name), whereas the legacy endpoint refuses to
        return an existing v2 token's secret. The modern endpoint is therefore
        tried first.
        """
        client = Client(
            self.config.base_url,
            self.config.http_timeout,
            basic=(username, password),
            verify_tls=self.config.verify_tls,
        )
        attempts = [client.request('GET', f'{STOCK_API}user/me/token/')]

        if attempts[0].status != 200:
            attempts.append(client.request('GET', f'{STOCK_API}user/token/'))

        # Prefer a successful response; otherwise report the most diagnostic
        # failure (a 5xx explains the underlying cause better than the legacy
        # endpoint's 400 about an already-issued token).
        response = next(
            (item for item in attempts if item.status == 200),
            max(attempts, key=lambda item: item.status),
        )

        payload = response.json or {}
        token = payload.get('token') if isinstance(payload, dict) else None
        detail = f'token acquisition for the {role} account'

        if response.status >= 500:
            detail += (
                ' (a 500 usually means the account has no UserProfile; ensure '
                'seed.py created it)'
            )

        self.recorder.expect(
            f'login_{role}',
            response.status == 200 and bool(token),
            detail=detail,
            expected='HTTP 200 with a token',
            observed=f'HTTP {response.status}',
            evidence=response.summary(300),
        )

        return token

    def phase_native_tree(self):
        """Create the native location tree and the cabinet aggregate."""
        root = self._create_location(
            f'SL Integration Root {self.config.run_id}', structural=True
        )
        cabinet_location = self._create_location(
            'SL Integration Cabinet', parent=root, structural=True
        )
        self.cabinet_location = cabinet_location
        self.drawer_locations = [
            self._create_location(
                f'SL Integration Drawer {index + 1}',
                parent=cabinet_location,
                structural=True,
            )
            for index in range(3)
        ]
        self.bin_locations = [
            self._create_location(
                f'SL Integration Bin {index + 1}',
                parent=self.drawer_locations[1],
                structural=False,
            )
            for index in range(2)
        ]

        if cabinet_location is None or None in self.drawer_locations:
            self.recorder.skip(
                'create_cabinet',
                detail='native locations were not created, cannot create a cabinet',
            )
            return

        body = {
            'name': 'SL Integration Cabinet',
            'slug': f'sl-cabinet-{self.config.run_id}'.lower(),
            'location': cabinet_location,
            'width_units': 600,
            'height_units': 800,
        }
        response = self.admin.request('POST', f'{PLUGIN_API}cabinets/', body=body)
        payload = response.json or {}

        if self._expect_status(
            'create_cabinet', response, {201}, detail='create a cabinet aggregate'
        ):
            self.cabinet_id = payload.get('id')
            self.cabinet_revision = payload.get('revision', 1)
            self.recorder.fixtures['cabinet'] = self.cabinet_id

        if not self.cabinet_id:
            return

        detail = self.admin.request('GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/')
        self._expect_status(
            'cabinet_detail_etag',
            detail,
            {200},
            detail='cabinet detail carries the revision ETag',
        )
        self.recorder.expect(
            'cabinet_revision_increments',
            self._revision_from(detail, 0) == self.cabinet_revision,
            detail='the cabinet detail revision matches the creation revision',
            expected=str(self.cabinet_revision),
            observed=detail.etag,
            evidence=detail.summary(),
        )

    def phase_permissions(self):
        """Verify the anonymous and read-only permission boundaries."""
        response = self.anon.request('GET', f'{PLUGIN_API}cabinets/')
        self._expect_status(
            'anonymous_denied', response, {401, 403}, detail='anonymous cabinet list'
        )

        response = self.readonly.request('GET', f'{PLUGIN_API}cabinets/')
        self._expect_status(
            'readonly_can_list', response, {200}, detail='read-only cabinet list'
        )

        response = self.readonly.request(
            'POST',
            f'{PLUGIN_API}cabinets/',
            body={
                'name': 'nope',
                'slug': 'nope',
                'location': 1,
                'width_units': 1,
                'height_units': 1,
            },
        )
        self._expect_status(
            'readonly_cannot_create_cabinet',
            response,
            {403},
            detail='read-only user is refused the change permission',
        )

        if self.cabinet_id:
            response = self.readonly.request(
                'PUT',
                f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/',
                body={'schema_version': 1},
                headers=self._if_match(),
            )
            self._expect_status('readonly_cannot_write_layout', response, {403})

            response = self.readonly.request(
                'POST', f'{PLUGIN_API}cabinets/{self.cabinet_id}/stop/', body={}
            )
            self._expect_status(
                'readonly_cannot_operate',
                response,
                {403},
                detail='read-only user is refused the operate permission',
            )

    def phase_layout(self):
        """Build the drawer/bin layout through the aggregate document API."""
        if not self.cabinet_id:
            self.recorder.skip('layout_write', detail='no cabinet available')
            return

        drawers = [
            {
                'id': None,
                'label': f'D{index + 1}',
                'display_number': index + 1,
                'location': self.drawer_locations[index],
                'x': 0,
                'y': index * 200,
                'width': 600,
                'height': 200,
                'interior_width': 560,
                'interior_height': 160,
                'archived': False,
            }
            for index in range(3)
        ]
        document = {
            'schema_version': 1,
            'cabinet': {'width_units': 600, 'height_units': 800},
            'drawers': drawers,
            'bins': [],
            'archive_ids': [],
        }

        response = self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/',
            body=document,
            headers=self._if_match(),
        )
        self._expect_status(
            'layout_write_drawers',
            response,
            {200},
            detail='create three drawers in one aggregate write',
        )
        self._track_revision(response)

        read_back = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/'
        )
        payload = read_back.json or {}
        self._expect_status('layout_read_back', read_back, {200})

        for entry in payload.get('drawers', []):
            self.drawers[entry.get('label')] = entry.get('id')

        self.recorder.expect(
            'layout_has_three_drawers',
            len(payload.get('drawers', [])) == 3,
            detail='the saved layout contains three drawers',
            expected='3',
            observed=str(len(payload.get('drawers', []))),
            evidence=read_back.summary(),
        )
        self.recorder.fixtures['drawers'] = self.drawers

        bins = [
            {
                'id': None,
                'drawer': self.drawers.get('D2'),
                'label': f'B{index + 1}',
                'location': self.bin_locations[index],
                'x': index * 200,
                'y': 0,
                'width': 200,
                'height': 100,
                'archived': False,
            }
            for index in range(2)
        ]
        document['drawers'] = [
            {**drawer, 'id': self.drawers.get(f'D{index + 1}')}
            for index, drawer in enumerate(drawers)
        ]
        document['bins'] = bins

        response = self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/',
            body=document,
            headers=self._if_match(),
        )
        self._expect_status(
            'layout_write_bins', response, {200}, detail='add two bins to drawer D2'
        )
        self._track_revision(response)

        read_back = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/'
        )
        payload = read_back.json or {}

        for entry in payload.get('bins', []):
            self.bins[entry.get('label')] = entry.get('id')

        self.recorder.expect(
            'layout_has_two_bins',
            len(payload.get('bins', [])) == 2,
            expected='2',
            observed=str(len(payload.get('bins', []))),
            evidence=read_back.summary(),
        )
        self.recorder.expect(
            'layout_diagnostics_valid',
            (payload.get('diagnostics') or {}).get('valid') is True,
            detail='saved layout diagnostics report no errors',
            evidence=json.dumps((payload.get('diagnostics') or {}), sort_keys=True)[
                :700
            ],
        )
        self.recorder.fixtures['bins'] = self.bins

        invalid = {
            'schema_version': 1,
            'cabinet': {'width_units': 600, 'height_units': 800},
            'drawers': [
                {**document['drawers'][0], 'x': 0},
                {**document['drawers'][1], 'x': 0, 'y': 0},
            ],
            'bins': [],
            'archive_ids': [],
        }
        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/validate-layout/',
            body=invalid,
        )
        self.recorder.expect(
            'validate_layout_reports_overlap',
            response.status == 200 and (response.json or {}).get('valid') is False,
            detail='overlapping drawers are reported as invalid without persisting',
            expected='valid=false',
            observed=str((response.json or {}).get('valid')),
            evidence=response.summary(),
        )

        # The 412 is raised by the compare-and-swap inside ``apply_layout``, which
        # runs *after* document validation. Send the current, valid document (with
        # real row ids) so validation cannot preempt the stale-revision refusal
        # with a 400.
        valid = self._layout_document()

        response = self.admin.request(
            'PUT', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/', body=valid
        )
        self._expect_status(
            'layout_write_requires_if_match',
            response,
            {428},
            detail='an aggregate write without If-Match is refused',
        )

        response = self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/',
            body=valid,
            headers={'If-Match': '"999999"'},
        )
        self._expect_status(
            'layout_write_stale_revision',
            response,
            {412},
            detail='an aggregate write with a stale If-Match is refused',
        )

    def phase_validation_guards(self):
        """Duplicate identities are rejected with 400 and never advance the revision.

        Covers the four unique constraints that the API can reach: drawer label,
        bin label, controller origin and controller expected MAC. Each duplicate
        write must render the documented error shape (400), not an unhandled
        IntegrityError (500), and must leave the cabinet revision unchanged. A
        valid label/display-number swap is then allowed and reversible.
        """
        if not self.cabinet_id or len(self.drawers) != 3 or len(self.bins) != 2:
            self.recorder.skip('validation_guards', detail='layout fixture unavailable')
            return

        revision_before = self.cabinet_revision

        document = self._layout_document()

        for entry in document['drawers']:
            if entry['label'] == 'D2':
                entry['label'] = 'D1'

        self._expect_documented_error(
            'duplicate_drawer_label_rejected',
            self._put_layout(document),
            detail='two drawers in one cabinet may not share a label',
        )

        document = self._layout_document()

        for entry in document['bins']:
            if entry['label'] == 'B2':
                entry['label'] = 'B1'

        self._expect_documented_error(
            'duplicate_bin_label_rejected',
            self._put_layout(document),
            detail='two bins in one drawer may not share a label',
        )

        self._expect_documented_error(
            'duplicate_controller_origin_rejected',
            self._put_electrical([
                self._controller_entry(
                    'C1', 'http://duplicate-origin.invalid', None, [16], 0
                ),
                self._controller_entry(
                    'C2', 'http://duplicate-origin.invalid', None, [17], 100
                ),
            ]),
            detail='two controllers may not share an origin',
        )
        self._expect_documented_error(
            'duplicate_controller_mac_rejected',
            self._put_electrical([
                self._controller_entry(
                    'C1', 'http://mac-a.invalid', 'AA:BB:CC:DD:EE:01', [16], 0
                ),
                self._controller_entry(
                    'C2', 'http://mac-b.invalid', 'AA:BB:CC:DD:EE:01', [17], 100
                ),
            ]),
            detail='two controllers may not share an expected MAC address',
        )

        detail = self.admin.request('GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/')
        current = self._revision_from(detail, -1)
        self.recorder.expect(
            'duplicate_rejects_leave_revision_unchanged',
            current == revision_before,
            detail='a rejected aggregate write must not advance the cabinet revision',
            expected=str(revision_before),
            observed=str(current),
            evidence=detail.summary(400),
        )

        original = self._layout_document()
        swapped = self._layout_document()
        by_id = {entry['id']: entry for entry in swapped['drawers']}
        first = by_id.get(self.drawers.get('D1'))
        second = by_id.get(self.drawers.get('D2'))

        if not (first and second):
            self.recorder.skip(
                'label_number_swap_allowed', detail='drawer D1/D2 entries unavailable'
            )
            return

        first['label'], second['label'] = second['label'], first['label']
        first['display_number'], second['display_number'] = (
            second['display_number'],
            first['display_number'],
        )

        response = self._put_layout(swapped)
        self._expect_status(
            'label_number_swap_allowed',
            response,
            {200},
            detail="exchanging two drawers' labels and display numbers is valid",
        )
        self._track_revision(response)

        labels = self._labels_by_drawer()
        self.recorder.expect(
            'label_number_swap_applied',
            labels.get(self.drawers.get('D1')) == 'D2'
            and labels.get(self.drawers.get('D2')) == 'D1',
            detail='the D1/D2 labels are exchanged after the accepted write',
            expected='D1 label=D2, D2 label=D1',
            observed=json.dumps(labels, sort_keys=True),
        )

        response = self._put_layout(original)
        self._expect_status(
            'original_layout_restore_allowed',
            response,
            {200},
            detail='restoring the original labels and numbers is allowed',
        )
        self._track_revision(response)

        labels = self._labels_by_drawer()
        self.recorder.expect(
            'layout_restored',
            labels.get(self.drawers.get('D1')) == 'D1'
            and labels.get(self.drawers.get('D2')) == 'D2',
            detail='the original drawer labels are restored',
            expected='D1 label=D1, D2 label=D2',
            observed=json.dumps(labels, sort_keys=True),
        )

    def phase_electrical(self):
        """Build the two-controller electrical topology."""
        if not self.cabinet_id:
            self.recorder.skip('electrical_write', detail='no cabinet available')
            return

        document = {
            'schema_version': 1,
            'controllers': [
                {
                    'id': None,
                    'name': 'C1',
                    'origin': f'http://wled-{self.config.run_id}-c1.invalid',
                    'firmware_adapter': 'wled-v16.0.1-1d',
                    'enabled': True,
                    'outputs': [
                        {
                            'id': None,
                            'bus_index': 0,
                            'wled_start': 0,
                            'pixel_count': 120,
                            'pins': [16],
                            'led_type': '22',
                            'colour_order': 'GRB',
                            'bus_reverse': False,
                            'skip': 0,
                            'strings': [
                                {
                                    'id': None,
                                    'label': 'S1',
                                    'output_offset': 0,
                                    'pixel_count': 60,
                                    'notes': '',
                                    'archived': False,
                                },
                                {
                                    'id': None,
                                    'label': 'S2',
                                    'output_offset': 60,
                                    'pixel_count': 60,
                                    'notes': '',
                                    'archived': False,
                                },
                            ],
                        }
                    ],
                },
                {
                    'id': None,
                    'name': 'C2',
                    'origin': f'http://wled-{self.config.run_id}-c2.invalid',
                    'firmware_adapter': 'wled-v16.0.1-1d',
                    'enabled': True,
                    'outputs': [
                        {
                            'id': None,
                            'bus_index': 0,
                            'wled_start': 0,
                            'pixel_count': 60,
                            'pins': [16],
                            'led_type': '22',
                            'colour_order': 'GRB',
                            'bus_reverse': False,
                            'skip': 0,
                            'strings': [
                                {
                                    'id': None,
                                    'label': 'S3',
                                    'output_offset': 0,
                                    'pixel_count': 60,
                                    'notes': '',
                                    'archived': False,
                                }
                            ],
                        }
                    ],
                },
            ],
            'archive_ids': [],
        }

        response = self.admin.request(
            'PUT',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/electrical/',
            body=document,
            headers=self._if_match(),
        )
        self._expect_status(
            'electrical_write',
            response,
            {200},
            detail='two controllers, two outputs and three strings',
        )
        self._track_revision(response)
        payload = response.json or {}

        for controller in payload.get('controllers', []):
            self.controllers[controller.get('name')] = controller.get('id')

            for output in controller.get('outputs', []):
                for string in output.get('strings', []):
                    self.strings[string.get('label')] = string.get('id')

        if len(payload.get('controllers', [])) != 2 or len(self.strings) != 3:
            self.recorder.bug(
                'electrical topology round-trip',
                f'expected 2 controllers and 3 strings, got '
                f'{len(payload.get("controllers", []))} controllers and '
                f'{len(self.strings)} strings',
            )

        self.recorder.fixtures['controllers'] = self.controllers
        self.recorder.fixtures['strings'] = self.strings

        response = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/electrical/'
        )
        self.recorder.expect(
            'electrical_read_back',
            response.status == 200
            and len((response.json or {}).get('controllers', [])) == 2,
            expected='2 controllers',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

    def phase_mapping(self):
        """Publish a cross-boundary, partially reversed mapping and translate."""
        if not self.cabinet_id or len(self.strings) != 3 or len(self.drawers) != 3:
            self.recorder.skip('mapping_publish', detail='topology not available')
            return

        candidate = {
            'total_pixels': 180,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 60,
                    'string': self.strings['S1'],
                    'string_offset': 0,
                    'direction': 1,
                },
                {
                    'logical_start': 61,
                    'length': 60,
                    'string': self.strings['S2'],
                    'string_offset': 0,
                    'direction': -1,
                },
                {
                    'logical_start': 121,
                    'length': 60,
                    'string': self.strings['S3'],
                    'string_offset': 0,
                    'direction': 1,
                },
            ],
        }

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/mapping-preview/',
            body=candidate,
        )
        preview = response.json or {}
        self.recorder.expect(
            'mapping_preview_valid',
            response.status == 200
            and preview.get('valid') is True
            and bool(preview.get('mapping_hash')),
            detail='a reversed cross-boundary candidate previews as valid',
            expected='valid=true with a mapping hash',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        publish = dict(candidate)
        publish['replacement_allocations'] = [
            {'drawer': self.drawers['D1'], 'logical_start': 1, 'logical_end': 60},
            {'drawer': self.drawers['D2'], 'logical_start': 61, 'logical_end': 140},
            {'drawer': self.drawers['D3'], 'logical_start': 141, 'logical_end': 180},
        ]
        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/mapping-publish/',
            body=publish,
            headers=self._if_match(),
        )
        self._expect_status(
            'mapping_publish',
            response,
            {201},
            detail='publish an immutable mapping revision with allocations',
        )
        payload = response.json or {}
        self._track_revision(response)
        self.mapping_hash = payload.get('mapping_hash', '')

        self.recorder.expect(
            'mapping_publish_shape',
            payload.get('total_pixels') == 180
            and payload.get('number') == 1
            and payload.get('changed_count') == 180,
            detail='first publish reports the full changed pixel count',
            expected='total_pixels=180, number=1, changed_count=180',
            observed=json.dumps(
                {
                    'total_pixels': payload.get('total_pixels'),
                    'number': payload.get('number'),
                    'changed_count': payload.get('changed_count'),
                },
                sort_keys=True,
            ),
            evidence=response.summary(),
        )
        self.recorder.fixtures['mapping_hash'] = self.mapping_hash

        layout = self.admin.request(
            'GET', f'{PLUGIN_API}cabinets/{self.cabinet_id}/layout/'
        )
        allocations = {
            entry.get('label'): (entry.get('allocation') or {})
            for entry in (layout.json or {}).get('drawers', [])
        }
        self.recorder.expect(
            'allocations_applied',
            allocations.get('D2', {}).get('logical_start') == 61
            and allocations.get('D2', {}).get('logical_end') == 140
            and allocations.get('D3', {}).get('logical_end') == 180,
            detail='publish applied the replacement drawer allocations',
            expected='D2=61-140, D3=141-180',
            observed=json.dumps(allocations, sort_keys=True),
            evidence=layout.summary(),
        )

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}translate/',
            body={
                'cabinet': self.cabinet_id,
                'logical_start': 40,
                'logical_end': 140,
                'mapping_hash': self.mapping_hash,
            },
        )
        payload = response.json or {}
        runs = payload.get('runs', [])
        run_controllers = {run.get('controller') for run in runs}
        reversed_runs = [run for run in runs if run.get('direction') == -1]

        self.recorder.expect(
            'translate_cross_boundary',
            response.status == 200
            and payload.get('pixel_count') == 101
            and run_controllers == {self.controllers['C1'], self.controllers['C2']},
            detail='40-140 crosses the string and controller boundary and covers 101 pixels',
            expected='pixel_count=101 across both controllers',
            observed=json.dumps(
                {
                    'pixel_count': payload.get('pixel_count'),
                    'controllers': len(run_controllers),
                },
                sort_keys=True,
            ),
            evidence=response.summary(),
        )
        self.recorder.expect(
            'translate_preserves_reverse_direction',
            len(reversed_runs) == 1,
            detail='the reversed S2 span is reported with direction -1',
            expected='1 reversed run',
            observed=str(len(reversed_runs)),
            evidence=response.summary(),
        )

        if len(reversed_runs) == 1:
            self.recorder.expect(
                'translate_reverse_wled_address',
                reversed_runs[0].get('wled_start') == 60
                and reversed_runs[0].get('wled_stop') == 120,
                detail='reversed logical 61 maps to descending WLED addresses 60-120',
                expected='wled_start=60, wled_stop=120',
                observed=json.dumps(reversed_runs[0], sort_keys=True),
            )

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}translate/',
            body={
                'cabinet': self.cabinet_id,
                'logical_start': 1,
                'logical_end': 10,
                'mapping_hash': 'stale-hash',
            },
        )
        self._expect_status(
            'translate_stale_hash',
            response,
            {412},
            detail='a stale mapping hash is refused',
        )

    def phase_binding(self):
        """Verify native location binding resolution."""
        if not self.cabinet_id or not self.mapping_hash:
            self.recorder.skip('location_binding', detail='mapping not published')
            return

        response = self.admin.request(
            'GET', f'{PLUGIN_API}locations/{self.cabinet_location}/binding/'
        )
        payload = response.json or {}
        self.recorder.expect(
            'binding_cabinet_root',
            response.status == 200
            and payload.get('bound') is True
            and payload.get('role') == 'cabinet',
            expected='role=cabinet, bound=true',
            observed=json.dumps(
                {'role': payload.get('role'), 'bound': payload.get('bound')},
                sort_keys=True,
            ),
            evidence=response.summary(),
        )

        response = self.admin.request(
            'GET', f'{PLUGIN_API}locations/{self.drawer_locations[1]}/binding/'
        )
        payload = response.json or {}
        self.recorder.expect(
            'binding_drawer_locatable',
            response.status == 200
            and payload.get('role') == 'drawer'
            and payload.get('locatable') is True,
            expected='role=drawer, locatable=true',
            observed=json.dumps(
                {'role': payload.get('role'), 'locatable': payload.get('locatable')},
                sort_keys=True,
            ),
            evidence=response.summary(),
        )

    def phase_native_inventory(self):
        """Seed a native part and stock item bound to a plugin bin (for the browser).

        The bin binding is asserted first, then a real part and stock item are
        created over the admin API. The create payloads are derived from the
        deployed OPTIONS schema, so required fields come from the API itself
        rather than from assumptions. Finally, a locate session targeting the
        stock item proves the item resolves through its bin to the drawer.
        """
        if not self.cabinet_id or not self.mapping_hash or not self.bin_locations:
            self.recorder.skip(
                'native_inventory', detail='mapped cabinet or bins unavailable'
            )
            return

        bin_location = self.bin_locations[0]

        binding = self.admin.request(
            'GET', f'{PLUGIN_API}locations/{bin_location}/binding/'
        )
        payload = binding.json or {}
        self.recorder.expect(
            'binding_bin_locatable',
            binding.status == 200
            and payload.get('role') == 'bin'
            and payload.get('locatable') is True,
            expected='role=bin, locatable=true',
            observed=json.dumps(
                {'role': payload.get('role'), 'locatable': payload.get('locatable')},
                sort_keys=True,
            ),
            evidence=binding.summary(400),
        )

        category = self._create_from_schema(
            'native_part_category',
            f'{STOCK_API}part/category/',
            {'name': f'SL Integration {self.config.run_id} Category'},
        )
        self.part = self._create_from_schema(
            'native_part',
            f'{STOCK_API}part/',
            {
                'name': f'SL Integration {self.config.run_id} Part',
                'category': (category or {}).get('pk'),
                'active': True,
            },
        )
        self.stock_item = self._create_from_schema(
            'native_stock_item',
            f'{STOCK_API}stock/',
            {
                'part': (self.part or {}).get('pk'),
                'location': bin_location,
                'quantity': 1,
            },
        )

        if not self.stock_item:
            self.recorder.skip(
                'stock_item_locate_accepted', detail='stock item was not created'
            )
            return

        self.recorder.fixtures['stock_item'] = {
            'pk': self.stock_item.get('pk'),
            'part': (self.part or {}).get('pk'),
            'location': bin_location,
        }

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}locate-sessions/',
            body={
                'cabinet': self.cabinet_id,
                'target': {'kind': 'item', 'id': self.stock_item.get('pk')},
                'mode': 'simulate',
                'mapping_hash': self.mapping_hash,
                'idempotency_key': f'sl-{self.config.run_id}-item-1',
            },
        )
        self._expect_status(
            'stock_item_locate_accepted',
            response,
            {202},
            detail='a locate session targeting the stock item is accepted',
        )
        plan = (response.json or {}).get('plan') or {}
        self.recorder.expect(
            'stock_item_resolves_to_drawer',
            plan.get('drawer') == self.drawers.get('D2'),
            detail="the stock item's bin resolves to its drawer D2",
            expected=str(self.drawers.get('D2')),
            observed=str(plan.get('drawer')),
            evidence=response.summary(400),
        )

        session_id = (response.json or {}).get('id')

        if session_id:
            self.admin.request(
                'POST', f'{PLUGIN_API}locate-sessions/{session_id}/stop/', body={}
            )

    def phase_profiles(self):
        """Create locate and test profiles and verify the duration cap."""
        if not self.cabinet_id:
            self.recorder.skip('profiles', detail='no cabinet available')
            return

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}profiles/',
            body={
                'cabinet': self.cabinet_id,
                'name': 'Integration Locate',
                'purpose': 'locate',
                'rgb_r': 0,
                'rgb_g': 255,
                'rgb_b': 0,
                'brightness': 64,
                'duration_seconds': 120,
            },
        )
        self._expect_status('profile_create_locate', response, {201})
        self.locate_profile = (response.json or {}).get('id')

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}profiles/',
            body={
                'cabinet': self.cabinet_id,
                'name': 'Integration Test',
                'purpose': 'test',
                'rgb_r': 255,
                'rgb_g': 0,
                'rgb_b': 0,
                'brightness': 64,
                'duration_seconds': 5,
            },
        )
        self._expect_status('profile_create_test', response, {201})
        self.test_profile = (response.json or {}).get('id')

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}profiles/',
            body={
                'cabinet': self.cabinet_id,
                'name': 'Integration Too Long',
                'purpose': 'test',
                'duration_seconds': 60,
            },
        )
        self._expect_status(
            'profile_test_duration_cap',
            response,
            {400},
            detail='a test profile cannot exceed the ten second cap',
        )

        response = self.admin.request(
            'GET', f'{PLUGIN_API}profiles/?cabinet={self.cabinet_id}'
        )
        self.recorder.expect(
            'profile_list_filtered',
            response.status == 200 and (response.json or {}).get('count') == 2,
            expected='count=2',
            observed=str((response.json or {}).get('count')),
            evidence=response.summary(),
        )
        self.recorder.fixtures['profiles'] = {
            'locate': self.locate_profile,
            'test': self.test_profile,
        }

    def phase_cas_race(self):
        """Fire two concurrent aggregate writes with the same revision."""
        if not self.cabinet_id:
            self.recorder.skip('concurrent_cas', detail='no cabinet available')
            return

        revision = self.cabinet_revision
        results = []
        lock = threading.Lock()
        barrier = threading.Barrier(2)

        def worker(index):
            """Perform one racing patch of the cabinet name."""
            barrier.wait()

            try:
                response = self.admin.request(
                    'PATCH',
                    f'{PLUGIN_API}cabinets/{self.cabinet_id}/',
                    body={'name': f'SL Cabinet r{index}'},
                    headers={'If-Match': f'"{revision}"'},
                )
            except TransportError as exc:
                response = Response(0, {}, json.dumps({'transport_error': str(exc)}))

            with lock:
                results.append(response)

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(2)]

        for thread in threads:
            thread.start()

        for thread in threads:
            thread.join(timeout=self.config.http_timeout + 10)

        statuses = sorted(response.status for response in results)
        self.recorder.expect(
            'concurrent_cas_single_winner',
            statuses == [200, 412],
            detail=(
                'two concurrent If-Match writes must produce exactly one winner; '
                'any other outcome (including a database lock error) is reported here'
            ),
            expected='[200, 412]',
            observed=str(statuses),
            evidence=[response.summary(300) for response in results],
        )

        winner = next(
            (response for response in results if response.status == 200), None
        )

        if winner is not None:
            self.cabinet_revision = self._revision_from(winner, revision + 1)

    def phase_idempotency(self):
        """Verify idempotent replay of a create request.

        This asserts HTTP replay semantics only. ``plan.q_task_id`` is the id
        recorded at enqueue time; it is *not* evidence that the worker delivered
        the task exactly once, so single delivery is deliberately not claimed
        here (an in-container Django test covers that instead).
        """
        if not self.cabinet_id or not self.mapping_hash:
            self.recorder.skip(
                'session_idempotency', detail='no mapped cabinet available'
            )
            return

        baseline = self.admin.request(
            'GET', f'{PLUGIN_API}locate-sessions/?cabinet={self.cabinet_id}'
        )
        rows_before = (baseline.json or {}).get('count')

        payload = {
            'cabinet': self.cabinet_id,
            'target': {'kind': 'drawer', 'id': self.drawers['D2']},
            'profile': self.locate_profile,
            'mode': 'simulate',
            'mapping_hash': self.mapping_hash,
            'idempotency_key': f'sl-{self.config.run_id}-locate-1',
        }

        first = self.admin.request(
            'POST', f'{PLUGIN_API}locate-sessions/', body=payload
        )
        self._expect_status(
            'session_create',
            first,
            {202},
            detail='a simulated locate session is accepted for durable dispatch',
        )
        session = (first.json or {}).get('id')
        session_state = (first.json or {}).get('state')
        self.session_id = session
        self.recorder.fixtures['session'] = session
        self.recorder.expect(
            'session_queued',
            session_state == 'queued',
            expected='queued',
            observed=str(session_state),
            evidence=first.summary(),
        )

        if not session:
            return

        replay = self.admin.request(
            'POST', f'{PLUGIN_API}locate-sessions/', body=payload
        )
        self.recorder.expect(
            'session_idempotent_replay',
            replay.status == 200 and (replay.json or {}).get('id') == session,
            detail='the same key and body returns the same session with HTTP 200',
            expected=f'HTTP 200 with id={session}',
            observed=f'HTTP {replay.status}',
            evidence=replay.summary(),
        )

        conflict = dict(payload)
        conflict['duration_seconds'] = 30
        response = self.admin.request(
            'POST', f'{PLUGIN_API}locate-sessions/', body=conflict
        )
        self.recorder.expect(
            'session_idempotency_conflict',
            response.status == 409
            and (response.json or {}).get('code') == 'idempotency_conflict',
            expected='HTTP 409 idempotency_conflict',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        listing = self.admin.request(
            'GET', f'{PLUGIN_API}locate-sessions/?cabinet={self.cabinet_id}'
        )
        rows_after = (listing.json or {}).get('count')
        self.recorder.expect(
            'session_replay_adds_no_row',
            isinstance(rows_before, int) and rows_after == rows_before + 1,
            detail=(
                'replaying the create request added exactly one row (the original '
                'session) and no extra row for the replay'
            ),
            expected=f'count {rows_before} -> {rows_before + 1}'
            if isinstance(rows_before, int)
            else 'count delta of 1',
            observed=f'{rows_before} -> {rows_after}',
            evidence=listing.summary(400),
        )

        detail = self.admin.request('GET', f'{PLUGIN_API}locate-sessions/{session}/')
        plan = (detail.json or {}).get('plan') or {}
        task_id = plan.get('q_task_id')
        self.recorder.expect(
            'session_replay_task_id_recorded',
            isinstance(task_id, str) and bool(task_id),
            detail=(
                'replay only: the durable row records a task id at enqueue time. '
                'This is NOT evidence of exactly-once worker delivery.'
            ),
            expected='a non-empty plan.q_task_id at enqueue time',
            observed=json.dumps({'q_task_id': task_id}),
            evidence=detail.summary(400),
        )

        replay_detail = self.admin.request(
            'GET', f'{PLUGIN_API}locate-sessions/{session}/'
        )
        replay_task_id = ((replay_detail.json or {}).get('plan') or {}).get('q_task_id')
        self.recorder.expect(
            'session_replay_task_id_stable',
            replay_task_id == task_id,
            detail=(
                'replay only: the recorded task id is unchanged after the replay, '
                'so the replay did not re-dispatch. This is not a delivery-once '
                'proof; that is covered by an in-container Django test.'
            ),
            expected=str(task_id),
            observed=str(replay_task_id),
        )

    def phase_async_wait_stop(self):
        """Wait for the worker to run the session, measure latency, then stop it."""
        if not self.session_id:
            self.recorder.skip('async_wait', detail='no session available')
            return

        started = time.monotonic()
        observed, reached = self._wait_for(
            f'{PLUGIN_API}locate-sessions/{self.session_id}/', {'active'}
        )
        elapsed = time.monotonic() - started
        state = (observed or {}).get('state')

        self.recorder.expect(
            'async_session_became_active',
            reached,
            detail=(
                'the background worker executed the simulated session within the '
                'hard timeout; a failure here means no worker is draining the queue'
            ),
            expected=f'active within {self.config.async_timeout:g}s',
            observed=f'{state} after {elapsed:.1f}s',
            evidence=json.dumps(_redact(observed or {}), sort_keys=True, default=str)[
                :700
            ],
        )

        # Measured durable-dispatch latency. The compose stack now enables the
        # shared cache and four background workers, so the previous single-worker
        # starvation (quantised at the plugin's 55s reconciliation loop) should be
        # gone. The hard timeout stays generous; this check asserts the tighter
        # service level and records the real elapsed time.
        self.recorder.expect(
            'worker_queue_latency_within_30s',
            reached and elapsed <= 30.0,
            detail=(
                'measured durable-dispatch latency (locate-session create -> active) '
                'is within the 30s budget expected after the shared-cache and '
                'four-worker compose fix'
            ),
            expected='<= 30.0s',
            observed=f'{elapsed:.1f}s (state={state})',
            evidence=f'hard_timeout={self.config.async_timeout:g}s',
        )

        if not reached:
            self.recorder.bug(
                'durable dispatch exceeded the hard timeout',
                f'the session stayed in state {state!r} after {elapsed:.1f}s; verify '
                'a worker is running and sharing the cache and database',
            )

        stop = self.admin.request(
            'POST', f'{PLUGIN_API}locate-sessions/{self.session_id}/stop/', body={}
        )
        self.recorder.expect(
            'session_stop',
            stop.status == 202 and (stop.json or {}).get('state') == 'stopped',
            expected='HTTP 202 stopped',
            observed=f'HTTP {stop.status}',
            evidence=stop.summary(),
        )

    def phase_pixel_test(self):
        """Create and stop an explicit-range pixel test."""
        if not self.cabinet_id or not self.mapping_hash or not self.test_profile:
            self.recorder.skip(
                'pixel_test', detail='mapping or test profile unavailable'
            )
            return

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/pixel-tests/',
            body={
                'pattern': 'range',
                'cabinet': self.cabinet_id,
                'logical_start': 1,
                'logical_end': 5,
                'profile': self.test_profile,
                'mode': 'simulate',
                'mapping_hash': self.mapping_hash,
                'idempotency_key': f'sl-{self.config.run_id}-pixeltest-1',
            },
        )
        self._expect_status('pixel_test_create', response, {202})
        plan = (response.json or {}).get('plan') or {}
        self.recorder.expect(
            'pixel_test_plan',
            plan.get('kind') == 'pixel-test' and plan.get('logical_start') == 1,
            expected='plan.kind=pixel-test, logical_start=1',
            observed=json.dumps(
                {'kind': plan.get('kind'), 'logical_start': plan.get('logical_start')},
                sort_keys=True,
            ),
            evidence=response.summary(),
        )

        session_id = (response.json or {}).get('id')

        if session_id:
            # Wait for the worker to drive the session out of the queued state so
            # the stop exercises a deterministic state transition.
            self._wait_for(
                f'{PLUGIN_API}locate-sessions/{session_id}/',
                {'active', 'stopped', 'failed', 'expired'},
            )
            stop = self.admin.request(
                'POST', f'{PLUGIN_API}locate-sessions/{session_id}/stop/', body={}
            )
            self._expect_status('pixel_test_stop', stop, {202})

    def phase_cabinet_stop(self):
        """Verify the cabinet-level stop endpoint."""
        if not self.cabinet_id or not self.mapping_hash:
            self.recorder.skip('cabinet_stop', detail='mapping unavailable')
            return

        created = self.admin.request(
            'POST',
            f'{PLUGIN_API}locate-sessions/',
            body={
                'cabinet': self.cabinet_id,
                'target': {'kind': 'drawer', 'id': self.drawers['D1']},
                'mode': 'simulate',
                'mapping_hash': self.mapping_hash,
                'idempotency_key': f'sl-{self.config.run_id}-cabinet-stop-1',
            },
        )

        if created.status not in (200, 202):
            self.recorder.skip(
                'cabinet_stop',
                detail=f'could not create a session to stop (HTTP {created.status})',
            )
            return

        response = self.admin.request(
            'POST', f'{PLUGIN_API}cabinets/{self.cabinet_id}/stop/', body={}
        )
        self.recorder.expect(
            'cabinet_stop_stops_session',
            response.status == 202
            and (response.json or {}).get('stopped_session') is not None,
            expected='HTTP 202 with stopped_session',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

    def phase_observe_import_approve(self):
        """Observe a controller, preview and approve its configuration."""
        if not self.cabinet_id or len(self.controllers) != 2:
            self.recorder.skip('observe', detail='controllers unavailable')
            return

        controller_id = self.controllers['C1']
        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}controllers/{controller_id}/observe/',
            body={'mode': 'simulate'},
        )
        self._expect_status(
            'observe_job_created',
            response,
            {202},
            detail='durable simulated observe job',
        )
        job_id = (response.json or {}).get('id')

        if not job_id:
            return

        observed, reached = self._wait_for(f'{PLUGIN_API}jobs/{job_id}/', {'complete'})
        self.recorder.expect(
            'observe_job_completes',
            reached,
            detail='the worker completed the observe job within the timeout',
            expected='complete',
            observed=str((observed or {}).get('state')),
            evidence=json.dumps(_redact(observed or {}), sort_keys=True, default=str)[
                :700
            ],
        )

        if not reached:
            self.recorder.bug(
                'observe read job did not complete',
                'the read job did not reach complete; verify the worker is running',
            )
            return

        self.observation_id = ((observed or {}).get('result') or {}).get('observation')

        if not self.observation_id:
            return

        preview = self.admin.request(
            'POST',
            f'{PLUGIN_API}controllers/{controller_id}/import-preview/',
            body={'observation': self.observation_id},
        )
        self.recorder.expect(
            'import_preview_diff_hash',
            preview.status == 200 and bool((preview.json or {}).get('diff_hash')),
            expected='HTTP 200 with a diff_hash',
            observed=f'HTTP {preview.status}',
            evidence=preview.summary(),
        )

        approve = self.admin.request(
            'POST',
            f'{PLUGIN_API}controllers/{controller_id}/approve-configuration/',
            body={
                'observation': self.observation_id,
                'mapping_hash': self.mapping_hash,
            },
        )
        self._expect_status(
            'approve_configuration',
            approve,
            {200},
            detail='approve a supported simulated observation',
        )
        self.approved_fingerprint = (approve.json or {}).get('fingerprint', '')

    def phase_config_drift(self):
        """Verify drift detection and a clean re-publish."""
        if (
            not self.cabinet_id
            or not self.mapping_hash
            or len(self.controllers) != 2
            or not self.approved_fingerprint
        ):
            self.recorder.skip(
                'config_drift', detail='approved configuration unavailable'
            )
            return

        candidate = {
            'total_pixels': 180,
            'spans': [
                {
                    'logical_start': 1,
                    'length': 60,
                    'string': self.strings['S1'],
                    'string_offset': 0,
                    'direction': 1,
                },
                {
                    'logical_start': 61,
                    'length': 60,
                    'string': self.strings['S2'],
                    'string_offset': 0,
                    'direction': -1,
                },
                {
                    'logical_start': 121,
                    'length': 60,
                    'string': self.strings['S3'],
                    'string_offset': 0,
                    'direction': 1,
                },
            ],
            'expected_fingerprints': {self.controllers['C1']: 'drifted-fingerprint'},
        }
        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/mapping-publish/',
            body=candidate,
            headers=self._if_match(),
        )
        self.recorder.expect(
            'config_drift_detected',
            response.status == 409
            and (response.json or {}).get('code') == 'config_drift',
            detail='a drifted expected fingerprint blocks the publish (fail closed)',
            expected='HTTP 409 config_drift',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        candidate['expected_fingerprints'] = {
            self.controllers['C1']: self.approved_fingerprint
        }
        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/mapping-publish/',
            body=candidate,
            headers=self._if_match(),
        )
        self._expect_status(
            'mapping_republish_same_content',
            response,
            {201},
            detail='re-publishing the identical mapping is allowed with the approved fingerprint',
        )
        payload = response.json or {}
        self._track_revision(response)
        self.recorder.expect(
            'mapping_republish_no_address_change',
            payload.get('changed_count') == 0,
            detail='an identical re-publish changes no physical addresses',
            expected='changed_count=0',
            observed=str(payload.get('changed_count')),
            evidence=response.summary(),
        )

    def phase_fail_closed(self):
        """Verify every live-hardware entry point fails closed."""
        if not self.cabinet_id or len(self.controllers) != 2 or not self.drawers:
            self.recorder.skip('fail_closed', detail='controllers unavailable')
            return

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}cabinets/{self.cabinet_id}/arm/',
            body={'controllers': [self.controllers['C1']]},
        )
        self.recorder.expect(
            'arm_fails_closed',
            response.status == 503
            and (response.json or {}).get('code') == 'live_unavailable',
            expected='HTTP 503 live_unavailable',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}locate-sessions/',
            body={
                'cabinet': self.cabinet_id,
                'target': {'kind': 'drawer', 'id': self.drawers['D1']},
                'mode': 'live',
                'approve_live': True,
                'idempotency_key': f'sl-{self.config.run_id}-live-1',
            },
        )
        self.recorder.expect(
            'live_locate_fails_closed',
            response.status == 503
            and (response.json or {}).get('code') == 'live_unavailable',
            expected='HTTP 503 live_unavailable',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}controllers/{self.controllers["C1"]}/observe/',
            body={'mode': 'live'},
        )
        self.recorder.expect(
            'live_observe_fails_closed',
            response.status == 503
            and (response.json or {}).get('code') == 'live_unavailable',
            expected='HTTP 503 live_unavailable',
            observed=f'HTTP {response.status}',
            evidence=response.summary(),
        )

    def phase_discovery(self):
        """Run a bounded simulated discovery job."""
        if not self.cabinet_id:
            self.recorder.skip('discovery', detail='no cabinet available')
            return

        response = self.admin.request(
            'POST',
            f'{PLUGIN_API}discovery/',
            body={'cabinet': self.cabinet_id, 'mode': 'simulate'},
        )
        self._expect_status('discovery_job_created', response, {202})
        job_id = (response.json or {}).get('id')

        if not job_id:
            return

        observed, reached = self._wait_for(f'{PLUGIN_API}jobs/{job_id}/', {'complete'})
        self.recorder.expect(
            'discovery_job_completes',
            reached,
            expected='complete',
            observed=str((observed or {}).get('state')),
            evidence=json.dumps(_redact(observed or {}), sort_keys=True, default=str)[
                :700
            ],
        )

    def run(self):
        """Run all phases in order, isolating phase failures."""
        phases = (
            self.phase_connectivity,
            self.phase_native_tree,
            self.phase_permissions,
            self.phase_layout,
            self.phase_validation_guards,
            self.phase_electrical,
            self.phase_mapping,
            self.phase_binding,
            self.phase_native_inventory,
            self.phase_profiles,
            self.phase_cas_race,
            self.phase_idempotency,
            self.phase_async_wait_stop,
            self.phase_pixel_test,
            self.phase_cabinet_stop,
            self.phase_observe_import_approve,
            self.phase_config_drift,
            self.phase_fail_closed,
            self.phase_discovery,
        )

        for phase in phases:
            try:
                phase()
            except TransportError:
                raise
            except Exception as exc:
                self.recorder.fail(
                    f'phase:{phase.__name__}', detail=f'unexpected error: {exc!r}'
                )

    # endregion

    # region results

    def results(self):
        """Assemble the results document."""
        checks = self.recorder.checks
        summary = {
            'pass': sum(1 for check in checks if check['status'] == PASS),
            'fail': sum(1 for check in checks if check['status'] == FAIL),
            'skip': sum(1 for check in checks if check['status'] == SKIP),
        }
        summary['total'] = len(checks)

        return {
            'tool': 'contrib/storage-layout-integration/api_checks.py',
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'run_id': self.config.run_id,
            'base_url': self.config.base_url,
            'plugin_api': PLUGIN_API,
            'environment': {
                'http_timeout_s': self.config.http_timeout,
                'async_timeout_s': self.config.async_timeout,
                'verify_tls': self.config.verify_tls,
                'admin_user': self.config.admin_user,
                'readonly_user': self.config.readonly_user,
            },
            'summary': summary,
            'checks': checks,
            'fixtures': self.recorder.fixtures,
            'bugs': self.recorder.bugs,
            'notes': [
                'This run used real HTTP against the deployed backend; no plugin '
                'code was imported and no mocked API or hardware was used.',
                'Credentials and tokens are never written to this file.',
            ],
        }

    def write_results(self, results):
        """Write the results to ``SL_RESULTS_DIR`` and return the path."""
        results_dir = self.config.results_dir
        results_dir.mkdir(parents=True, exist_ok=True)
        run_path = results_dir / f'api_checks_{self.config.run_id}.json'
        latest_path = results_dir / 'latest.json'
        payload = json.dumps(results, indent=2, sort_keys=True, default=str)

        run_path.write_text(payload + '\n', encoding='utf-8')
        latest_path.write_text(payload + '\n', encoding='utf-8')

        return run_path

    def print_summary(self, results):
        """Print a concise human-readable summary to stdout."""
        summary = results['summary']
        print('')
        print('Storage Layout integration checks')
        print(f'  base URL : {results["base_url"]}')
        print(f'  run id   : {results["run_id"]}')
        print(
            f'  checks   : {summary["pass"]} passed, {summary["fail"]} failed, '
            f'{summary["skip"]} skipped (of {summary["total"]})'
        )

        for check in results['checks']:
            if check['status'] == FAIL:
                print(f'  FAIL {check["name"]}: {check["detail"]}')

        for bug in results['bugs']:
            print(f'  BUG  {bug["title"]}: {bug["detail"]}')

    # endregion


def main():
    """Run the integration checks and write the results file."""
    try:
        config = Config()
    except ConfigError as exc:
        print(f'configuration error: {exc}')
        return 2

    checks = IntegrationChecks(config)

    try:
        checks.run()
    except TransportError as exc:
        checks.recorder.fail('transport', detail=str(exc))

    results = checks.results()
    path = checks.write_results(results)
    checks.print_summary(results)
    print(f'  results  : {path}')

    return 0 if results['summary']['fail'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
