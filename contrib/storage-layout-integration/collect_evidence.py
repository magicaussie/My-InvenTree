"""Publish only sanitised integration evidence, never runtime authentication."""

import datetime
import json
import re

from stack import ENV_FILE, HERE, RUNTIME


def main():
    """Verify passed logs and extract a compact non-secret evidence bundle."""
    api = json.loads((RUNTIME / 'latest.json').read_text())
    assert api['summary']['fail'] == 0 and api['summary']['skip'] == 0
    worker = json.loads((RUNTIME / 'worker-evidence.json').read_text())
    persistence = json.loads((RUNTIME / 'persistence-evidence.json').read_text())
    isolation = json.loads((RUNTIME / 'isolation.json').read_text())
    assert worker['result'] == persistence['result'] == 'passed'
    log_names = [
        'api.log',
        'browser.log',
        'worker.log',
        'postgres-tests.log',
        'postgres-migrations.log',
        'persistence-after.log',
    ]
    logs = {name: (RUNTIME / name).read_text() for name in log_names}
    if (RUNTIME / 'cleanup.log').exists():
        logs['cleanup.log'] = (RUNTIME / 'cleanup.log').read_text()
    assert '7 passed' in logs['browser.log']
    counts = {}
    for name in ['postgres-tests.log', 'postgres-migrations.log']:
        assert re.search(r'\nOK\b', logs[name]) and 'FAILED (' not in logs[name]
        counts[name] = int(re.search(r'Ran (\d+) tests', logs[name]).group(1))
    result = {
        'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'basis': 'Source-built Docker services, real PostgreSQL/Redis/Q worker and real host browser; no intercepted API.',
        'api': api,
        'postgres_tests': counts['postgres-tests.log'],
        'postgres_migration_tests': counts['postgres-migrations.log'],
        'real_browser_tests': {
            'passed': 7,
            'failed': 0,
            'skipped': 0,
            'engine': 'Chromium',
        },
        'worker': worker,
        'restart_persistence': persistence,
        'isolation': isolation,
        'untested': [
            'Physical WLED hardware and optical/electrical behaviour (prohibited)',
            'Live hardware dispatch and recovery (disabled)',
            'Firefox/WebKit',
            'MariaDB (not part of this PostgreSQL task)',
            'Full unrelated InvenTree core suite',
            'Host power-loss, kernel/network-partition and production load qualification',
        ],
    }
    cleanup = RUNTIME / 'cleanup-evidence.json'
    if cleanup.exists():
        result['cleanup'] = json.loads(cleanup.read_text())
    encoded = json.dumps(result, indent=2, sort_keys=True) + '\n'
    # Keep successful integration output plus concise test-run tails; never
    # copy browser auth state, traces, credentials, or unrestricted HTTP dumps.
    transcript = '\n'.join(
        f'=== {name} ===\n{text[-7000:]}' for name, text in logs.items()
    )
    transcript = (
        '\n'.join(line.rstrip() for line in transcript.splitlines()).rstrip() + '\n'
    )
    secrets = [
        line.split('=', 1)[1]
        for line in ENV_FILE.read_text().splitlines()
        if 'PASSWORD=' in line
    ]
    for secret in secrets:
        assert secret not in encoded and secret not in transcript
    destination = HERE / 'evidence'
    destination.mkdir(exist_ok=True)
    (destination / 'verified.json').write_text(encoded)
    (destination / 'integration.log').write_text(transcript)
    print(
        f'Wrote sanitised evidence: {counts}, {api["summary"]}, 7 real browser passes.'
    )


if __name__ == '__main__':
    main()
