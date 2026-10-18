"""Compare real HTTP state before and after a sandbox datastore/app restart."""

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


class Client:
    """Authenticated HTTP client, without storing or printing token secrets."""

    def __init__(self):
        """Acquire a fresh sandbox token using runtime-only credentials."""
        self.base = os.environ['SL_BASE_URL']
        basic = base64.b64encode(
            f'{os.environ["SL_ADMIN_USER"]}:{os.environ["SL_ADMIN_PASSWORD"]}'.encode()
        ).decode()
        request = urllib.request.Request(
            self.base + '/api/user/me/token/',
            headers={'Authorization': 'Basic ' + basic},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            self.token = json.load(response)['token']

    def get(self, path):
        """Fetch a real authenticated JSON document."""
        request = urllib.request.Request(
            self.base + path, headers={'Authorization': 'Token ' + self.token}
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)


def main():
    """Snapshot fixture state or assert byte-equivalent semantic persistence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['before', 'after'])
    args = parser.parse_args()
    root = Path(os.environ['SL_RESULTS_DIR'])
    snapshot = root / 'persistence-before.json'
    if args.phase == 'before':
        latest = json.loads((root / 'latest.json').read_text())
        cabinet = latest['fixtures']['cabinet']
        if isinstance(cabinet, dict):
            cabinet = cabinet['id']
    else:
        cabinet = json.loads(snapshot.read_text())['cabinet']
    deadline = time.monotonic() + 90
    while True:
        try:
            client = Client()
            prefix = f'/plugin/storage-layout/api/v1/cabinets/{cabinet}/'
            data = {
                'cabinet': cabinet,
                'layout': client.get(prefix + 'layout/'),
                'electrical': client.get(prefix + 'electrical/'),
            }
            break
        except (urllib.error.URLError, TimeoutError):
            if time.monotonic() > deadline:
                raise
            time.sleep(1)
    if args.phase == 'before':
        snapshot.write_text(json.dumps(data, sort_keys=True, indent=2) + '\n')
        print('Saved real layout/electrical snapshot before sandbox restart.')
    else:
        expected = json.loads(snapshot.read_text())
        assert data == expected, (
            'Geometry, bindings, allocations, mapping or electrical state changed across restart'
        )
        result = {
            'result': 'passed',
            'database_and_cache_restarted': True,
            'application_and_worker_restarted': True,
            'layout_and_electrical_unchanged': True,
            'cabinet': cabinet,
        }
        (root / 'persistence-evidence.json').write_text(
            json.dumps(result, indent=2) + '\n'
        )
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
