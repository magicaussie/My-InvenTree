"""Read-only host verification; run via the approved administrator, never deploy sudoers."""

import hashlib
import json
import subprocess
import tarfile
from pathlib import Path


def docker(*args):
    """Capture Docker inspection without printing container environments."""
    return subprocess.check_output(['/usr/bin/docker', *args], text=True)


root = Path('/home/spetchal/myinventree-development-review')
archive = Path('/home/spetchal/myinventree-access-review/source.tar')
with tarfile.open(archive) as source:
    count = 0
    for member in source:
        path = root / member.name
        if member.isfile():
            assert path.read_bytes() == source.extractfile(member).read(), member.name
            count += 1
        elif member.issym():
            assert path.is_symlink() and path.readlink().as_posix() == member.linkname
print(
    f'PASS exact archive source: {count} files; sha256={hashlib.sha256(archive.read_bytes()).hexdigest()}'
)
ids = docker(
    'ps', '-aq', '--filter', 'label=com.docker.compose.project=myinventree-dev'
).split()
assert len(ids) == 5
containers = json.loads(docker('inspect', *ids))
for container in containers:
    name = container['Name'].lstrip('/')
    host = container['HostConfig']
    assert not host['Privileged']
    assert host['NetworkMode'] != 'host'
    assert not host.get('Devices')
    assert not host.get('CapAdd')
    assert 'no-new-privileges:true' in host['SecurityOpt']
    assert all(
        m['Type'] == 'volume' and m['Name'].startswith('myinventree-dev_')
        for m in container['Mounts']
    )
    assert not any('sock' in m['Destination'] for m in container['Mounts'])
    bindings = host.get('PortBindings') or {}
    if name == 'myinventree-dev-proxy-1':
        assert bindings == {
            '80/tcp': [{'HostIp': '192.168.1.108', 'HostPort': '18081'}]
        }
    else:
        assert not bindings
    assert not any('qcluster' in arg for arg in container['Config']['Cmd'])
    print(f'PASS container isolation: {name}; state={container["State"]["Status"]}')
before = (
    Path('/home/spetchal/myinventree-access-review/containers-before.txt')
    .read_text(encoding='utf-8')
    .splitlines()
)
after = docker('ps', '-a', '--format', '{{.ID}} {{.Names}}').splitlines()
unrelated = [
    line for line in after if not line.split()[1].startswith('myinventree-dev-')
]
assert set(before) == set(unrelated), 'unrelated container identity inventory changed'
print(f'PASS unrelated CasaOS container IDs/names unchanged: {len(before)}')
assert not docker(
    'ps', '-aq', '--filter', 'label=com.docker.compose.project=myinventree-main'
).strip()
print('PASS Main absent; never deployed')
