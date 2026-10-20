"""Owner-authorized Development-only workspace correction build/verification."""

import hashlib
import importlib.util
import json
import sys
import tarfile
from pathlib import Path

COMMIT = 'f099aa1d315a20807a88b3c62dc70c8ee4095b5b'
SHA = 'adb26809b481a1d0879d6b01b52a94182656b5340c953bba17646da68d98db0c'
ROOT = Path('/home/spetchal/myinventree-dev-workspace-f099aa1d3-v2')
RECORD = Path('/var/backups/myinventree-dev/workspace-f099aa1d3-evidence')
BASE = {
    'backend': 'sha256:8c4f55d8f6a607b06f91f9759c292c49fab6517d0d3810dcba0a8b71161d3f1b',
    'proxy': 'sha256:4b6cc8989850ce4f8ce75461c26e9852893e999896200694339799598661a4f4',
}


def helper():
    """Load existing activation checks with this correction's pinned evidence."""
    spec = importlib.util.spec_from_file_location(
        'prepare', ROOT / 'contrib/remote-development/prepare-002jq.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT, module.RECORD = ROOT, RECORD
    module.COMMIT, module.SHA, module.BASE = COMMIT, SHA, BASE
    return module


def main():
    """Build, tag or verify only the pinned Development correction."""
    mode = sys.argv[1]
    if mode == 'build':
        archive = Path('/home/spetchal/myinventree-workspace-f099aa1d3.tar')
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == SHA
        assert not ROOT.exists() and not RECORD.exists()
        ROOT.mkdir(mode=0o700)
        with tarfile.open(archive) as source:
            source.extractall(ROOT, filter='data')
            for member in source.getmembers():
                if member.isfile():
                    assert (ROOT / member.name).read_bytes() == source.extractfile(
                        member
                    ).read()
        h = helper()
        h.baseline(BASE)
        RECORD.mkdir(mode=0o700)
        (RECORD / 'source.txt').write_text(COMMIT + '\n' + SHA + '\n')
        (RECORD / 'runtime-before.json').write_text(json.dumps(h.runtime()))
        unrelated = sorted(
            line
            for line in h
            .output('ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}')
            .decode()
            .splitlines()
            if not line.split()[1].startswith('myinventree-dev-')
            and line.split()[1] != h.DB
        )
        (RECORD / 'unrelated-before.json').write_text(json.dumps(unrelated))
        original = Path(
            '/var/backups/myinventree-dev/002jq-responsive-19d148233-evidence/restore-migration-PASS.txt'
        )
        assert original.is_file()
        (RECORD / 'restore-migration-PASS.txt').write_bytes(original.read_bytes())
        (RECORD / 'restore-provenance.txt').write_text(
            'Inherited prior additive 0005 rehearsal, no fresh restore: '
            + str(original)
            + '\nOriginal backup: /var/backups/myinventree-dev/20261020T091716Z\n'
        )
        for target in ('backend', 'frontend'):
            h.docker(
                'build',
                '-f',
                'contrib/storage-layout-integration/Dockerfile',
                '--target',
                target,
                '-t',
                'localhost/myinventree-dev-' + target + ':workspace-f099aa1d3',
                '.',
                cwd=ROOT,
                timeout=1800,
            )
        images = {
            target: h.inspect(
                'localhost/myinventree-dev-' + target + ':workspace-f099aa1d3'
            )['Id']
            for target in ('backend', 'frontend')
        }
        (RECORD / 'candidate-images.json').write_text(json.dumps(images))
        h.baseline(BASE)
        print(json.dumps(images))
    elif mode == 'tag':
        h = helper()
        h.baseline(BASE)
        images = json.loads((RECORD / 'candidate-images.json').read_text())
        for service, target in [('backend', 'backend'), ('proxy', 'frontend')]:
            h.docker(
                'image',
                'tag',
                BASE[service],
                'localhost/myinventree-dev-'
                + target
                + ':rollback-before-workspace-f099aa1d3',
            )
            assert (
                h.inspect(
                    'localhost/myinventree-dev-'
                    + target
                    + ':rollback-before-workspace-f099aa1d3'
                )['Id']
                == BASE[service]
            )
        for target, image in images.items():
            h.docker(
                'image', 'tag', image, 'localhost/myinventree-dev-' + target + ':review'
            )
    elif mode == 'verify':
        helper().verify_activation()
    else:
        raise ValueError(mode)


if __name__ == '__main__':
    main()
