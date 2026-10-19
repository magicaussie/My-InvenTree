"""Administrator-only Dev backup and isolated restore proof; grants no deploy rights."""

import datetime
import os
import shutil
import subprocess
from pathlib import Path

os.umask(0o077)
root = Path('/var/backups/myinventree-dev')
root.mkdir(mode=0o700, exist_ok=True)
assert root.stat().st_uid == 0 and root.stat().st_mode & 0o777 == 0o700
backup = root / datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(mode=0o700)


def run(*args, **kwargs):
    """Run only fixed Dev container commands, failing on any error."""
    return subprocess.run(['/usr/bin/docker', 'exec', *args], check=True, **kwargs)


with (backup / 'postgres.dump').open('xb') as output:
    run(
        'myinventree-dev-db-1',
        'pg_dump',
        '-U',
        'inventree',
        '-d',
        'inventree',
        '-Fc',
        stdout=output,
    )
with (backup / 'app-data.tar').open('xb') as output:
    run(
        'myinventree-dev-backend-1',
        'python',
        '-c',
        "import tarfile,sys; t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|'); t.add('/data',arcname='data'); t.close()",
        stdout=output,
    )
shutil.copyfile('/etc/myinventree-dev/runtime.env', backup / 'runtime.env')
shutil.copyfile('/etc/myinventree-dev/compose.yml', backup / 'compose.yml')
# Restore to a dedicated scratch database, never replacing the running database.
run('myinventree-dev-db-1', 'createdb', '-U', 'inventree', 'dev_002jl_restore_verify')
try:
    with (backup / 'postgres.dump').open('rb') as source:
        run(
            '-i',
            'myinventree-dev-db-1',
            'pg_restore',
            '-U',
            'inventree',
            '-d',
            'dev_002jl_restore_verify',
            '--exit-on-error',
            stdin=source,
        )
    result = subprocess.check_output(
        [
            '/usr/bin/docker',
            'exec',
            'myinventree-dev-db-1',
            'psql',
            '-U',
            'inventree',
            '-d',
            'dev_002jl_restore_verify',
            '-Atc',
            "SELECT width_units, height_units, revision FROM storage_layout_cabinet WHERE slug='dev-002jl-persistence'",
        ],
        text=True,
    ).strip()
    assert result, 'persisted cabinet missing from restored database'
    print(f'PASS isolated database restore: cabinet width|height|revision={result}')
finally:
    run('myinventree-dev-db-1', 'dropdb', '-U', 'inventree', 'dev_002jl_restore_verify')
import tarfile

with tarfile.open(backup / 'app-data.tar') as data:
    names = data.getnames()
    assert 'data/secret_key.txt' in names and 'data/oidc.pem' in names
    assert any(name.startswith('data/media') for name in names)
    for member in data:
        if member.isfile():
            stream = data.extractfile(member)
            while stream.read(1024 * 1024):
                pass
print(f'PASS private Dev backup and readable app archive: {backup}')
