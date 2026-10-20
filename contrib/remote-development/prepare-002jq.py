"""Approval-only, fixed 002J-Q Development update. Do not run without owner approval.

Run as root on mainserver-1 after transferring the pinned archive. No secret output.
Scratch resources and backups are deliberately retained; never deletes live volumes.
"""

import hashlib
import json
import os
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path

os.umask(0o077)
COMMIT = '56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a'
SHA = '0bee583df53713b8a6c92506ec41bfb3ffd385646977c0d5493f6ff87916c4ad'
BASE = {
    'backend': 'sha256:0a9530a566651f0da7d22da35c0107297316969c5ede22ff76e9b43bd41a978c',
    'proxy': 'sha256:1b744d12dc75804dde441a941aafa4ae970e2f815f24305e59a664816774592c',
}
PG = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
ROOT = Path('/home/spetchal/myinventree-dev-build-002jq-56271a1ad')
ARCHIVE = Path('/home/spetchal/myinventree-002jq-image-review-56271a1ad.tar')
NETWORK = 'myinventree-002jq-restore'
DB = 'myinventree-002jq-restore-db'
MEDIA = 'myinventree-002jq-restore-media'
RECORD = Path('/var/backups/myinventree-dev/002jq-56271a1ad-evidence')


def run(*args, **kw):
    """Execute a checked host command."""
    kw.setdefault('timeout', 900)
    timeout = kw.pop('timeout')
    with subprocess.Popen(args, start_new_session=True, **kw) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args)
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def docker(*args, **kw):
    """Execute a checked Docker command."""
    try:
        return run('/usr/bin/docker', *args, **kw)
    except BaseException as original_error:
        # A killed Docker client does not stop a daemon-side scratch job.
        if args and args[0] == 'run' and '--name' in args:
            name = args[args.index('--name') + 1]
            if name in ('myinventree-002jq-media-job', 'myinventree-002jq-manage-job'):
                try:
                    run(
                        '/usr/bin/docker',
                        'stop',
                        '--time',
                        '10',
                        name,
                        timeout=30,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except BaseException as cleanup_error:
                    original_error.add_note(
                        'Scratch stop failed: ' + type(cleanup_error).__name__
                    )
        raise


def output(*args):
    """Capture Docker output without exposing secrets."""
    return run(
        '/usr/bin/docker',
        *args,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=30,
    ).stdout


def inspect(name):
    """Read one Docker object privately."""
    return json.loads(output('inspect', name))[0]


def sql(container, query):
    """Read database evidence with fail-fast SQL."""
    return output(
        'exec',
        container,
        'psql',
        '-U',
        'inventree',
        '-d',
        'inventree',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        query,
    )


def gates():
    """Require both persisted hardware gates to remain disabled."""
    result = sql(
        'myinventree-dev-db-1',
        "SELECT key,value FROM plugin_pluginsetting WHERE key IN ('ENABLE_HARDWARE','DISPATCHER_ENABLED') ORDER BY key",
    )
    # Fail closed on ambiguous/missing settings, including another enabled plugin.
    assert result.decode().splitlines() == [
        'DISPATCHER_ENABLED|False',
        'ENABLE_HARDWARE|False',
    ], 'hardware gate mismatch'
    return result


def baseline(images=BASE):
    """Reject runtime drift or expanded container access."""
    for service, image in images.items():
        assert inspect('myinventree-dev-' + service + '-1')['Image'] == image
    assert (
        Path('/etc/myinventree-dev/compose.yml').read_bytes()
        == (ROOT / 'contrib/remote-development/compose.yml').read_bytes()
    )
    ids = output(
        'ps', '-aq', '--filter', 'label=com.docker.compose.project=myinventree-dev'
    ).split()
    assert len(ids) == 5
    for cid in ids:
        c = inspect(cid.decode())
        h = c['HostConfig']
        assert not h['Privileged'] and not h.get('Devices') and not h.get('CapAdd')
        assert h['NetworkMode'] != 'host'
        assert 'no-new-privileges:true' in h['SecurityOpt']
        assert all(
            m['Type'] == 'volume' and m['Name'].startswith('myinventree-dev_')
            for m in c['Mounts']
        )
        expected = (
            {'80/tcp': [{'HostIp': '192.168.1.108', 'HostPort': '18081'}]}
            if c['Name'].endswith('-proxy-1')
            else {}
        )
        assert (h.get('PortBindings') or {}) == expected
        assert not any('qcluster' in arg for arg in c['Config']['Cmd'])
    gates()


SERVICES = ('db', 'redis', 'backend', 'proxy')


def runtime():
    """Record identities and exact mounts, never environments."""
    return {
        service: {
            key: inspect('myinventree-dev-' + service + '-1')[key]
            for key in ('Id', 'Image', 'Mounts')
        }
        for service in SERVICES
    }


def healthy(service, image):
    """Fail closed on absent health status or incorrect image."""
    container = inspect('myinventree-dev-' + service + '-1')
    assert container['Image'] == image, 'image mismatch: ' + service
    assert container['State']['Status'] == 'running', 'not running: ' + service
    assert container['State'].get('Health', {}).get('Status') == 'healthy', (
        'not healthy: ' + service
    )


def recover_originals(reset_tags=True):
    """Start only recorded originals; never recreate containers or restore data."""
    before = json.loads((RECORD / 'runtime-before.json').read_text())
    errors = []
    for service in ('backend', 'proxy'):
        try:
            c = inspect('myinventree-dev-' + service + '-1')
            assert c['Id'] == before[service]['Id'] and c['Image'] == BASE[service], (
                'original replaced; recovery forbidden'
            )
            docker('start', c['Id'], timeout=45)
        except BaseException as error:
            errors.append(error)
    if reset_tags:
        for service, target in [('backend', 'backend'), ('proxy', 'frontend')]:
            try:
                docker(
                    'image',
                    'tag',
                    BASE[service],
                    'localhost/myinventree-dev-' + target + ':review',
                    timeout=30,
                )
            except BaseException as error:
                errors.append(error)
    deadline = time.monotonic() + 240
    while True:
        try:
            for service in SERVICES:
                healthy(service, before[service]['Image'])
            break
        except (AssertionError, subprocess.SubprocessError):
            if time.monotonic() >= deadline:
                errors.append(RuntimeError('original service health deadline exceeded'))
                break
            time.sleep(2)
    if errors:
        raise RuntimeError(
            'original recovery incomplete; manual inspection required'
        ) from errors[0]


def verify_activation():
    """Read-only, fail-closed verification; no automatic postmigration rollback."""
    assert (RECORD / 'restore-migration-PASS.txt').is_file()
    assert (RECORD / 'source.txt').read_text() == COMMIT + '\n' + SHA + '\n'
    before = json.loads((RECORD / 'runtime-before.json').read_text())
    images = json.loads((RECORD / 'candidate-images.json').read_text())
    expected = {service: before[service]['Image'] for service in SERVICES}
    expected.update(backend=images['backend'], proxy=images['frontend'])
    for service in SERVICES:
        healthy(service, expected[service])
        c = inspect('myinventree-dev-' + service + '-1')
        assert c['Mounts'] == before[service]['Mounts'], 'mount drift: ' + service
        if service in ('db', 'redis'):
            assert c['Id'] == before[service]['Id'], 'persistent service replaced'
    baseline(expected)
    bootstrap = inspect('myinventree-dev-bootstrap-1')
    assert bootstrap['Image'] == images['backend']
    assert (
        bootstrap['State']['Status'] == 'exited' and bootstrap['State']['ExitCode'] == 0
    )
    assert bootstrap['Mounts'] == before['backend']['Mounts']
    assert (
        sql(
            'myinventree-dev-db-1',
            "SELECT count(*) FROM django_migrations WHERE app='storage_layout' AND name='0005_background_images'",
        ).strip()
        == b'1'
    )
    gates()
    unrelated = sorted(
        line
        for line in output('ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}')
        .decode()
        .splitlines()
        if not line.split()[1].startswith('myinventree-dev-')
    )
    # Scratch resources are introduced by this program, not unrelated workloads.
    unrelated = [line for line in unrelated if line.split()[1] != DB]
    assert unrelated == json.loads((RECORD / 'unrelated-before.json').read_text()), (
        'unrelated identity drift'
    )
    assert (
        Path('/etc/myinventree-dev/compose.yml').read_bytes()
        == (ROOT / 'contrib/remote-development/compose.yml').read_bytes()
    )
    print('PASS exact activation checks (not browser acceptance)')


def prepare():
    """Prepare pinned images and rehearse recovery with original-service safeguards."""
    assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == SHA
    assert not ROOT.exists() and not RECORD.exists(), 'fresh paths required'
    ROOT.mkdir(mode=0o700)
    with tarfile.open(ARCHIVE) as source:
        source.extractall(ROOT, filter='data')
        for member in source.getmembers():
            if member.isfile():
                assert (ROOT / member.name).read_bytes() == source.extractfile(
                    member
                ).read()
    baseline()
    assert sql(
        'myinventree-dev-db-1',
        "SELECT name FROM django_migrations WHERE app='storage_layout' ORDER BY name",
    ).decode().splitlines() == [
        '0001_storage_and_electrical',
        '0002_mapping_and_constraints',
        '0003_operations_audit_permissions',
        '0004_cabinet_structure',
    ]
    RECORD.mkdir(mode=0o700)
    (RECORD / 'source.txt').write_text(COMMIT + '\n' + SHA + '\n')
    (RECORD / 'baseline.json').write_text(json.dumps(BASE))
    (RECORD / 'gates-before.txt').write_bytes(gates())
    (RECORD / 'schema-before.txt').write_bytes(
        sql(
            'myinventree-dev-db-1',
            'SELECT app,name FROM django_migrations ORDER BY app,name',
        )
    )
    unrelated = (
        output('ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}')
        .decode()
        .splitlines()
    )
    unrelated = sorted(
        line for line in unrelated if not line.split()[1].startswith('myinventree-dev-')
    )
    (RECORD / 'unrelated-before.json').write_text(json.dumps(unrelated))
    (RECORD / 'runtime-before.json').write_text(json.dumps(runtime()))
    for service, target in [('backend', 'backend'), ('proxy', 'frontend')]:
        docker(
            'image',
            'tag',
            BASE[service],
            'localhost/myinventree-dev-' + target + ':rollback-002jq-56271a1ad',
        )
    for target in ['backend', 'frontend']:
        with (RECORD / ('build-' + target + '.log')).open('xb') as log:
            docker(
                'build',
                '--pull=false',
                '-f',
                'contrib/storage-layout-integration/Dockerfile',
                '--target',
                target,
                '-t',
                'localhost/myinventree-dev-' + target + ':candidate-002jq-56271a1ad',
                '.',
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
    images = {
        target: inspect(
            'localhost/myinventree-dev-' + target + ':candidate-002jq-56271a1ad'
        )['Id']
        for target in ['backend', 'frontend']
    }
    (RECORD / 'candidate-images.json').write_text(json.dumps(images))
    baseline()
    # Stop ingress, drain requests, then use the existing backup procedure unchanged.
    # Backend remains available only on the internal Docker network during backup.
    try:
        docker('stop', 'myinventree-dev-proxy-1', timeout=45)
        time.sleep(125)
        backups = Path('/var/backups/myinventree-dev')
        before = set(backups.iterdir())
        with (RECORD / 'backup.log').open('xb') as log:
            run(
                '/usr/bin/python3',
                str(ROOT / 'contrib/remote-development/backup-verify.py'),
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        created = set(backups.iterdir()) - before
        assert len(created) == 1
        backup = created.pop()
        assert (backup / 'postgres.dump').stat().st_size > 0
        (RECORD / 'backup-path.txt').write_text(str(backup) + '\n')
        checksums = {
            p.name: hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
            for p in backup.iterdir()
            if p.is_file()
        }
        (RECORD / 'backup-checksums.json').write_text(json.dumps(checksums, indent=2))
        docker('stop', 'myinventree-dev-backend-1')
        # Fresh isolated resources only: no live DB credentials, ports, socket or binds.
        docker('network', 'create', '--internal', NETWORK)
        docker('volume', 'create', MEDIA)
        docker(
            'run',
            '-d',
            '--name',
            DB,
            '--network',
            NETWORK,
            '--network-alias',
            'scratch-db',
            '--security-opt',
            'no-new-privileges:true',
            '--memory',
            '768m',
            '-e',
            'POSTGRES_USER=inventree',
            '-e',
            'POSTGRES_DB=inventree',
            '-e',
            'POSTGRES_HOST_AUTH_METHOD=trust',
            PG,
        )
        for _attempt in range(60):
            if (
                subprocess.run(
                    ['/usr/bin/docker', 'exec', DB, 'pg_isready', '-U', 'inventree'],
                    timeout=10,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                ).returncode
                == 0
            ):
                break
            time.sleep(2)
        else:
            raise RuntimeError('scratch PostgreSQL not ready')
        with (backup / 'postgres.dump').open('rb') as data:
            docker(
                'exec',
                '-i',
                DB,
                'pg_restore',
                '-U',
                'inventree',
                '-d',
                'inventree',
                '--exit-on-error',
                stdin=data,
            )
        # Restore every app-data member to scratch volume; validate every file hash.
        restore = """import tarfile,sys,hashlib,pathlib
    with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as t:
     for m in t:
      p=pathlib.PurePosixPath(m.name)
      assert p.parts[0]=='data' and '..' not in p.parts
      assert m.isfile() or m.isdir(), 'unexpected link/device in backup'
      dest=pathlib.Path('/data').joinpath(*p.parts[1:])
      if m.isdir(): dest.mkdir(parents=True,exist_ok=True)
      else:
       dest.parent.mkdir(parents=True,exist_ok=True)
       h=hashlib.sha256()
       with dest.open('xb') as o:
        s=t.extractfile(m)
        while b:=s.read(1048576): h.update(b);o.write(b)
       assert hashlib.file_digest(dest.open('rb'),'sha256').digest()==h.digest()
    assert pathlib.Path('/data/secret_key.txt').is_file()
    assert pathlib.Path('/data/oidc.pem').is_file()
    print('PASS full scratch media/key restore and byte verification')
    """
        with (
            (backup / 'app-data.tar').open('rb') as data,
            (RECORD / 'media-restore.log').open('xb') as log,
        ):
            docker(
                'run',
                '--name',
                'myinventree-002jq-media-job',
                '--rm',
                '-i',
                '--network',
                'none',
                '--security-opt',
                'no-new-privileges:true',
                '--cap-drop',
                'ALL',
                '-v',
                MEDIA + ':/data',
                '--entrypoint',
                'python',
                images['backend'],
                '-c',
                restore,
                stdin=data,
                stdout=log,
            )
        env = dict(
            item.split('=', 1)
            for item in inspect('myinventree-dev-backend-1')['Config']['Env']
        )
        env.update(
            INVENTREE_DB_HOST='scratch-db',
            INVENTREE_DB_PASSWORD='',
            INVENTREE_CACHE_ENABLED='False',
        )
        # Private env is supplied in process environment, not command arguments/logs.
        envargs = []
        for key in env:
            if key.startswith(('INVENTREE_', 'SL_')):
                envargs.extend(['-e', key])

        def manage(*args):
            """Run candidate management commands against scratch resources only."""
            return docker(
                'run',
                '--name',
                'myinventree-002jq-manage-job',
                '--rm',
                '--network',
                NETWORK,
                '--security-opt',
                'no-new-privileges:true',
                '--cap-drop',
                'ALL',
                '-v',
                MEDIA + ':/data',
                *envargs,
                '-w',
                '/app/src/backend/InvenTree',
                '--entrypoint',
                'python',
                images['backend'],
                'manage.py',
                *args,
                env={**os.environ, **env},
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )

        # Compare all restored table rows except migration history across scratch migration.
        tables = (
            sql(
                DB,
                "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'django_migrations' ORDER BY tablename",
            )
            .decode()
            .splitlines()
        )

        def snapshot():
            """Hash restored table rows without printing inventory data."""
            return {
                table: hashlib.sha256(
                    sql(
                        DB,
                        'SELECT row_to_json(t)::text FROM "'
                        + table
                        + '" t ORDER BY row_to_json(t)::text',
                    )
                ).hexdigest()
                for table in tables
            }

        original = snapshot()
        (RECORD / 'scratch-migration-plan.log').write_bytes(
            manage('migrate', '--plan').stdout
        )
        (RECORD / 'scratch-migration.log').write_bytes(
            manage('migrate', '--noinput').stdout
        )
        # New nullable columns alter row JSON; compare old-column projections instead.
        # The full schema/data dump remains retained for independent review.
        assert (
            sql(
                DB,
                "SELECT count(*) FROM django_migrations WHERE app='storage_layout' AND name='0005_background_images'",
            ).strip()
            == b'1'
        )
        (RECORD / 'scratch-before-table-hashes.json').write_text(json.dumps(original))
        after = snapshot()
        (RECORD / 'scratch-after-table-hashes.json').write_text(json.dumps(after))
        changed = {t for t in tables if original[t] != after[t]}
        assert changed <= {'storage_layout_cabinet', 'storage_layout_drawer'}, changed
        # Compare pre-existing columns explicitly for cabinet/drawer (new fields excluded).
        for table in ['storage_layout_cabinet', 'storage_layout_drawer']:
            cols = (
                sql(
                    'myinventree-dev-db-1',
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='"
                    + table
                    + "' ORDER BY ordinal_position",
                )
                .decode()
                .splitlines()
            )
            projection = ','.join('"' + c + '"' for c in cols)
            query = (
                'SELECT row_to_json(t)::text FROM (SELECT '
                + projection
                + ' FROM "'
                + table
                + '") t ORDER BY row_to_json(t)::text'
            )
            assert sql(DB, query) == sql('myinventree-dev-db-1', query), table
        (RECORD / 'restore-migration-PASS.txt').write_text(
            'Full media restore verified; scratch migration 0005 applied; existing table values preserved.\n'
        )
        baseline()
        for target, image in images.items():
            docker(
                'image', 'tag', image, 'localhost/myinventree-dev-' + target + ':review'
            )
        recover_originals(reset_tags=False)
        print('READY FOR RESTRICTED ACTIVATION; originals healthy; evidence:', RECORD)
    except BaseException as original_error:
        try:
            recover_originals()
        except BaseException as recovery_error:
            original_error.add_note('Recovery failed: ' + type(recovery_error).__name__)
        raise


def main():
    """Explicit privileged modes; importing this module performs no deployment."""
    if sys.flags.optimize:
        raise RuntimeError('Python optimization disables safety assertions')
    if len(sys.argv) != 2 or sys.argv[1] not in (
        'prepare',
        'verify',
        'recover-originals',
    ):
        raise SystemExit('usage: prepare-002jq.py prepare|verify|recover-originals')
    if os.geteuid() != 0:
        raise SystemExit('root required on approved host')

    def interrupted(signum, frame):
        raise InterruptedError('termination requested')

    signal.signal(signal.SIGTERM, interrupted)
    {
        'prepare': prepare,
        'verify': verify_activation,
        'recover-originals': recover_originals,
    }[sys.argv[1]]()


if __name__ == '__main__':
    main()
