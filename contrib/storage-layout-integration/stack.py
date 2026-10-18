"""Project-scoped disposable Docker integration driver; never global cleanup."""

import argparse
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / '.runtime'
STATE = RUNTIME / 'stack.json'
ENV_FILE = RUNTIME / 'stack.env'


def initialize():
    """Check Docker and reserve a fresh unique project with private credentials."""
    subprocess.run(['docker', 'version'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'compose', 'version'], check=True)
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    RUNTIME.chmod(0o700)
    if STATE.exists():
        print('Existing isolated project state retained; no credentials overwritten.')
        return
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 18761))
    project = f'sl001_{secrets.token_hex(6)}'
    values = {
        'SL_PROJECT': project,
        'SL_ADMIN_USER': 'sl_admin',
        'SL_ADMIN_PASSWORD': secrets.token_urlsafe(32),
        'SL_READONLY_USER': 'sl_readonly',
        'SL_READONLY_PASSWORD': secrets.token_urlsafe(32),
        'INVENTREE_DB_PASSWORD': secrets.token_urlsafe(32),
    }
    ENV_FILE.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    ENV_FILE.chmod(0o600)
    STATE.write_text(json.dumps({'project': project, 'port': 18761}, indent=2) + '\n')
    STATE.chmod(0o600)
    print(
        f'Created disposable project {project}; credentials are in the private ignored runtime directory.'
    )


def environment():
    """Read generated credentials without emitting them into logs."""
    values = os.environ.copy()
    for line in ENV_FILE.read_text().splitlines():
        key, value = line.split('=', 1)
        values[key] = value
    values['SL_BASE_URL'] = 'http://127.0.0.1:18761'
    values['SL_RESULTS_DIR'] = str(RUNTIME)
    return values


def compose():
    """Return a command pinned to this saved project, file and environment."""
    state = json.loads(STATE.read_text())
    project = state['project']
    if not re.fullmatch(r'sl001_[a-f0-9]{12}', project):
        raise ValueError('Refusing an unrecognised Compose project name')
    return [
        'docker',
        'compose',
        '--project-name',
        project,
        '--env-file',
        str(ENV_FILE),
        '--file',
        str(HERE / 'compose.yml'),
    ]


def run(command, name=None, timeout=1200, env=None):
    """Run a finite command, preserving redacted-safe build/test evidence."""
    result = subprocess.run(
        command,
        cwd=HERE,
        env=env,
        timeout=timeout,
        check=False,
        capture_output=True,
        text=True,
    )
    text = result.stdout + result.stderr
    for key, value in (env or {}).items():
        if ('PASSWORD' in key or 'SECRET' in key) and value:
            text = text.replace(value, '[REDACTED]')
    print(text, end='')
    if name:
        (RUNTIME / f'{name}.log').write_text(text)
        (RUNTIME / f'{name}-exit.json').write_text(
            json.dumps({'exit_code': result.returncode}) + '\n'
        )
    return result.returncode


def isolation_evidence(command, env):
    """Inspect exclusively this project's containers and verify its boundary."""
    project = json.loads(STATE.read_text())['project']
    ids = subprocess.check_output(
        [
            'docker',
            'ps',
            '-aq',
            '--filter',
            f'label=com.docker.compose.project={project}',
        ],
        text=True,
    ).split()
    if not ids:
        raise AssertionError('The isolated project has no containers')
    containers = json.loads(
        subprocess.check_output(['docker', 'inspect', *ids], text=True)
    )
    evidence = []
    for container in containers:
        service = container['Config']['Labels']['com.docker.compose.service']
        assert container['Config']['Labels']['com.docker.compose.project'] == project
        mounts = container.get('Mounts', [])
        for mount in mounts:
            assert mount['Type'] == 'volume' and mount['Name'].startswith(
                project + '_'
            ), mount
            assert 'docker.sock' not in mount['Destination']
        bindings = container['HostConfig'].get('PortBindings') or {}
        if service == 'frontend':
            assert bindings == {
                '80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18761'}]
            }, bindings
            assert container['NetworkSettings']['Ports']['80/tcp'], (
                'Port was not actually published'
            )
        else:
            assert not bindings, (service, bindings)
            assert set(container['NetworkSettings']['Networks']) == {
                project + '_isolated'
            }
        evidence.append({
            'service': service,
            'image': container['Image'],
            'published_ports': bindings,
            'mounts_are_project_owned': True,
        })
    network = json.loads(
        subprocess.check_output(
            ['docker', 'network', 'inspect', project + '_isolated'], text=True
        )
    )[0]
    assert network['Internal'] is True
    result = {
        'project': project,
        'internal_application_network': True,
        'existing_applications_inspected': False,
        'containers': evidence,
    }
    (RUNTIME / 'isolation.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 0


def main():
    """Build/run/test only this driver's temporary stack."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        'action',
        choices=[
            'init',
            'build',
            'up',
            'status',
            'logs',
            'api',
            'browser',
            'worker',
            'backend-tests',
            'migrations',
            'isolation',
            'snapshot',
            'verify-persistence',
            'restart',
            'down',
            'destroy',
        ],
    )
    args = parser.parse_args()
    if args.action == 'init':
        initialize()
        return 0
    command = compose()
    env = environment()
    if args.action == 'build':
        return run([*command, 'build', 'backend', 'frontend'], 'build', env=env)
    if args.action == 'up':
        return run(
            [*command, 'up', '-d', '--wait', '--wait-timeout', '600'], 'up', env=env
        )
    if args.action == 'isolation':
        return isolation_evidence(command, env)
    if args.action == 'status':
        return run([*command, 'ps', '--all'], env=env)
    if args.action == 'logs':
        result = subprocess.run(
            [*command, 'logs', '--no-color'],
            cwd=HERE,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        text = result.stdout + result.stderr
        for key, value in env.items():
            if ('PASSWORD' in key or 'SECRET' in key) and value:
                text = text.replace(value, '[REDACTED]')
        (RUNTIME / 'compose.log').write_text(text)
        print(f'Saved redacted project-only logs to {RUNTIME / "compose.log"}')
        return result.returncode
    if args.action == 'api':
        return run([sys.executable, str(HERE / 'api_checks.py')], 'api', env=env)
    if args.action == 'browser':
        frontend = HERE.parents[1] / 'src/plugins/storage_layout/frontend'
        env['NODE_PATH'] = str(frontend / 'node_modules')
        return run(
            [
                str(frontend / 'node_modules/.bin/playwright'),
                'test',
                '--config',
                str(HERE / 'playwright.config.ts'),
            ],
            'browser',
            env=env,
        )
    if args.action == 'worker':
        source_files = [
            'src/backend/InvenTree/plugin/base/integration/AppMixin.py',
            'src/plugins/storage_layout/storage_layout/services.py',
            'src/plugins/storage_layout/storage_layout/validation.py',
            'src/plugins/storage_layout/frontend/src/components/DrawerDesigner.tsx',
        ]
        source_hashes = {
            path: hashlib.sha256((HERE.parents[1] / path).read_bytes()).hexdigest()
            for path in source_files
        }
        result = subprocess.run(
            [
                *command,
                'exec',
                '-T',
                '-e',
                'SL_EXPECTED_SOURCE_HASHES=' + json.dumps(source_hashes),
                'backend',
                'python',
                'src/backend/InvenTree/manage.py',
                'shell',
            ],
            input=(HERE / 'worker_checks.py').read_text(),
            cwd=HERE,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        (RUNTIME / 'worker.log').write_text(result.stdout + result.stderr)
        print(result.stdout)
        if result.returncode:
            print(result.stderr, file=sys.stderr)
        for line in result.stdout.splitlines():
            if line.startswith('SL_WORKER_EVIDENCE='):
                (RUNTIME / 'worker-evidence.json').write_text(
                    line.split('=', 1)[1] + '\n'
                )
        return result.returncode
    if args.action == 'migrations':
        return run(
            [
                *command,
                'exec',
                '-T',
                'backend',
                'python',
                'src/backend/InvenTree/manage.py',
                'test',
                'storage_layout.tests.test_migrations',
                '--noinput',
                '--tag',
                'migration_test',
                '--settings=storage_layout.test_settings',
            ],
            'postgres-migrations',
            env=env,
        )
    if args.action == 'backend-tests':
        return run(
            [
                *command,
                'exec',
                '-T',
                'backend',
                'python',
                'src/backend/InvenTree/manage.py',
                'test',
                'storage_layout.tests',
                'users.tests.RuleSetModelTest',
                'plugin.test_api.PluginDetailAPITest.test_plugin_filter_by_mixin',
                '--settings=storage_layout.test_settings',
                '--keepdb',
                '--exclude-tag',
                'migration_test',
            ],
            'postgres-tests',
            env=env,
        )
    if args.action in ('snapshot', 'verify-persistence'):
        phase = 'before' if args.action == 'snapshot' else 'after'
        return run(
            [sys.executable, str(HERE / 'persistence.py'), phase],
            f'persistence-{phase}',
            env=env,
        )
    if args.action == 'restart':
        result = run(
            [*command, 'restart', 'db', 'redis'], 'restart-datastores', env=env
        )
        if result:
            return result
        import time

        for service in ('db', 'redis'):
            deadline = time.monotonic() + 60
            while True:
                container = subprocess.check_output(
                    [*command, 'ps', '-q', service], text=True
                ).strip()
                health = subprocess.check_output(
                    [
                        'docker',
                        'inspect',
                        '--format',
                        '{{.State.Health.Status}}',
                        container,
                    ],
                    text=True,
                ).strip()
                if health == 'healthy':
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'{service} did not recover after restart')
                time.sleep(1)
        return run(
            [*command, 'restart', 'backend', 'worker', 'frontend'], 'restart', env=env
        )
    if args.action == 'down':
        return run([*command, 'down', '--timeout', '30'], env=env)
    if args.action == 'destroy':
        result = run(
            [*command, 'down', '--volumes', '--timeout', '30'], 'cleanup', env=env
        )
        if result:
            return result
        project = json.loads(STATE.read_text())['project']
        scoped = f'label=com.docker.compose.project={project}'
        for query in [
            ['docker', 'ps', '-aq', '--filter', scoped],
            ['docker', 'volume', 'ls', '-q', '--filter', scoped],
            ['docker', 'network', 'ls', '-q', '--filter', scoped],
        ]:
            assert not subprocess.check_output(query, text=True).strip(), (
                'Project resources remain after cleanup'
            )
        evidence = {
            'project': project,
            'project_containers_removed': True,
            'project_named_volumes_removed': True,
            'project_networks_removed': True,
            'images_and_build_cache_retained': True,
            'docker_wide_cleanup': False,
        }
        (RUNTIME / 'cleanup-evidence.json').write_text(
            json.dumps(evidence, indent=2) + '\n'
        )
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
