"""Local-only tests: every external process is forbidden unless explicitly mocked."""

import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class PreparationTests(unittest.TestCase):
    """Verify deployment safeguards without running external processes."""

    def setUp(self):
        """Load an isolated module with subprocess execution forbidden."""
        self.external = patch(
            'subprocess.Popen', side_effect=AssertionError('external process forbidden')
        )
        self.external.start()
        self.addCleanup(self.external.stop)
        spec = importlib.util.spec_from_file_location(
            'prepare', Path(__file__).with_name('prepare-002jq.py')
        )
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.m.RECORD = Path(self.tmp.name)
        self.before = {
            s: {
                'Id': s,
                'Image': self.m.BASE.get(s, s),
                'Mounts': [],
                'State': {'Status': 'exited'},
            }
            for s in self.m.SERVICES
        }
        (self.m.RECORD / 'runtime-before.json').write_text(json.dumps(self.before))

    def test_import_does_not_execute(self):
        """Import without creating deployment records or executing commands."""
        self.assertFalse((self.m.RECORD / 'source.txt').exists())

    def test_recovery_attempts_both_starts_and_health(self):
        """Restart both original services and verify all four services."""
        with (
            patch.object(
                self.m,
                'inspect',
                side_effect=lambda name: self.before[
                    'backend' if 'backend' in name else 'proxy'
                ],
            ),
            patch.object(self.m, 'docker') as docker,
            patch.object(self.m, 'healthy') as health,
        ):
            self.m.recover_originals(False)
        self.assertEqual(docker.call_count, 2)
        self.assertEqual(health.call_count, 4)

    def test_failed_start_does_not_skip_other_start(self):
        """Attempt the second restart even when the first restart fails."""
        with (
            patch.object(
                self.m,
                'inspect',
                side_effect=lambda name: self.before[
                    'backend' if 'backend' in name else 'proxy'
                ],
            ),
            patch.object(
                self.m, 'docker', side_effect=[RuntimeError('start'), None]
            ) as docker,
            patch.object(self.m, 'healthy'),
        ):
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                self.m.recover_originals(False)
        self.assertEqual(docker.call_count, 2)

    def test_replaced_containers_never_started(self):
        """Reject replacement containers rather than starting them."""
        with (
            patch.object(
                self.m, 'inspect', return_value={'Id': 'replaced', 'Image': 'other'}
            ),
            patch.object(self.m, 'docker') as docker,
            patch.object(self.m, 'healthy'),
        ):
            with self.assertRaises(RuntimeError):
                self.m.recover_originals(False)
        docker.assert_not_called()

    def test_recovery_running_is_idempotent(self):
        """Never start an already-running original, including repeated recovery."""
        for row in self.before.values():
            row['State']['Status'] = 'running'
        with (
            patch.object(
                self.m,
                'inspect',
                side_effect=lambda name: self.before[
                    'backend' if 'backend' in name else 'proxy'
                ],
            ),
            patch.object(self.m, 'docker') as docker,
            patch.object(self.m, 'healthy'),
        ):
            self.m.recover_originals(False)
            self.m.recover_originals(False)
        docker.assert_not_called()

    def test_recovery_inspection_failure_uses_recorded_id(self):
        """A failed name lookup can only fall back to the original ID."""

        def lookup(name):
            if name.startswith('myinventree-'):
                raise subprocess.CalledProcessError(1, 'inspect')
            return self.before[name]

        with (
            patch.object(self.m, 'inspect', side_effect=lookup),
            patch.object(self.m, 'docker') as docker,
            patch.object(
                self.m,
                'healthy',
                side_effect=[ValueError('bad JSON'), None, None, None, None],
            ),
            patch.object(self.m.time, 'sleep'),
        ):
            self.m.recover_originals(False)
        self.assertEqual(
            [call.args for call in docker.call_args_list],
            [('start', 'backend'), ('start', 'proxy')],
        )

    def test_recovery_both_inspections_fail_still_checks_health(self):
        """Inspection errors are collected without skipping other services."""
        with (
            patch.object(
                self.m, 'inspect', side_effect=ValueError('bad JSON')
            ) as inspect,
            patch.object(self.m, 'docker') as docker,
            patch.object(self.m, 'healthy') as health,
        ):
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                self.m.recover_originals(False)
        self.assertEqual(inspect.call_count, 4)
        self.assertEqual(health.call_count, 4)
        docker.assert_not_called()

    def test_media_restore_exact_program(self):
        """Compile and execute the deployed -c text using only disposable files."""
        compile(self.m.MEDIA_RESTORE, '<media-restore>', 'exec')
        # Explicitly allow only the local Python child for this isolated test.
        self.external.stop()

        def execute(entries):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                for name, kind, content in entries:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.size = len(content) if kind == tarfile.REGTYPE else 0
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        member.linkname = '/tmp/outside'
                    archive.addfile(member, io.BytesIO(content))
            destination = Path(tempfile.mkdtemp(dir=self.tmp.name))
            result = subprocess.run(
                [sys.executable, '-c', self.m.MEDIA_RESTORE, str(destination)],
                input=data.getvalue(),
                capture_output=True,
                timeout=10,
                check=False,
            )
            return result, destination

        normal = [
            ('data', tarfile.DIRTYPE, b''),
            ('data/media', tarfile.DIRTYPE, b''),
            ('data/media/image.png', tarfile.REGTYPE, bytes(range(256)) * 5000),
            ('data/media/empty', tarfile.REGTYPE, b''),
            ('data/secret_key.txt', tarfile.REGTYPE, b'disposable secret'),
            ('data/oidc.pem', tarfile.REGTYPE, b'disposable key'),
        ]
        result, dest = execute(normal)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b'PASS full scratch', result.stdout)
        for name, kind, content in normal:
            path = dest.joinpath(*Path(name).parts[1:])
            if kind == tarfile.DIRTYPE:
                self.assertTrue(path.is_dir())
            else:
                self.assertEqual(path.read_bytes(), content)
        for key in ('secret_key.txt', 'oidc.pem'):
            with self.subTest(missing=key):
                result, _ = execute([
                    entry for entry in normal if entry[0] != 'data/' + key
                ])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'missing expected key', result.stderr)
        for name, kind in [
            ('../outside', tarfile.REGTYPE),
            ('data/../outside', tarfile.REGTYPE),
            ('/data/outside', tarfile.REGTYPE),
            ('other/file', tarfile.REGTYPE),
            ('data/link', tarfile.SYMTYPE),
            ('data/hard', tarfile.LNKTYPE),
            ('data/device', tarfile.CHRTYPE),
            ('data/fifo', tarfile.FIFOTYPE),
        ]:
            with self.subTest(name=name, kind=kind):
                result, _ = execute([(name, kind, b'')])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'unsafe archive entry', result.stderr)
        result, _ = execute([*normal, normal[-1]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'duplicate archive entry', result.stderr)

    def test_health_missing_wrong_image_or_stopped_rejected(self):
        """Reject missing health, incorrect images and stopped containers."""
        for state, image in [
            ({'Status': 'running'}, 'expected'),
            ({'Status': 'running', 'Health': {'Status': 'healthy'}}, 'wrong'),
            ({'Status': 'exited', 'Health': {'Status': 'healthy'}}, 'expected'),
        ]:
            with (
                self.subTest(state=state, image=image),
                patch.object(
                    self.m, 'inspect', return_value={'Image': image, 'State': state}
                ),
            ):
                with self.assertRaises(AssertionError):
                    self.m.healthy('backend', 'expected')

    def test_recovery_health_deadline(self):
        """Bound recovery health polling by its deadline."""
        with (
            patch.object(
                self.m,
                'inspect',
                side_effect=lambda name: self.before[
                    'backend' if 'backend' in name else 'proxy'
                ],
            ),
            patch.object(self.m, 'docker'),
            patch.object(self.m, 'healthy', side_effect=AssertionError('unhealthy')),
            patch.object(self.m.time, 'monotonic', side_effect=[0, 241]),
        ):
            with self.assertRaises(RuntimeError):
                self.m.recover_originals(False)

    def test_scratch_cleanup_preserves_exception(self):
        """Preserve the initial failure when scratch cleanup also fails."""
        failure = TimeoutError('original')
        with patch.object(
            self.m, 'run', side_effect=[failure, RuntimeError('cleanup')]
        ):
            with self.assertRaises(TimeoutError) as caught:
                self.m.docker('run', '--name', 'myinventree-002jq-manage-job')
        self.assertIs(caught.exception, failure)

    def test_activation_success_and_each_gate_rejected(self):
        """Accept the expected activation and reject each violated gate."""
        m = self.m
        (m.RECORD / 'restore-migration-PASS.txt').touch()
        (m.RECORD / 'source.txt').write_text(m.COMMIT + '\n' + m.SHA + '\n')
        (m.RECORD / 'candidate-images.json').write_text(
            json.dumps({'backend': 'new-backend', 'frontend': 'new-proxy'})
        )
        (m.RECORD / 'unrelated-before.json').write_text(json.dumps(['other unrelated']))
        for failure in (
            None,
            'image',
            'health',
            'mount',
            'identity',
            'bootstrap',
            'migration',
            'gates',
            'unrelated',
            'policy',
        ):
            containers = {
                'myinventree-dev-' + service + '-1': {
                    **row,
                    'Image': {'backend': 'new-backend', 'proxy': 'new-proxy'}.get(
                        service, row['Image']
                    ),
                    'State': {'Status': 'running', 'Health': {'Status': 'healthy'}},
                }
                for service, row in self.before.items()
            }
            containers['myinventree-dev-bootstrap-1'] = {
                'Image': 'new-backend',
                'Mounts': [],
                'State': {'Status': 'exited', 'ExitCode': 0},
            }
            backend = containers['myinventree-dev-backend-1']
            if failure == 'image':
                backend['Image'] = 'wrong'
            if failure == 'health':
                backend['State']['Health']['Status'] = 'unhealthy'
            if failure == 'mount':
                backend['Mounts'] = [{'Name': 'wrong'}]
            if failure == 'identity':
                containers['myinventree-dev-db-1']['Id'] = 'replaced'
            if failure == 'bootstrap':
                containers['myinventree-dev-bootstrap-1']['State']['ExitCode'] = 1
            with (
                self.subTest(failure=failure),
                patch.object(m, 'inspect', side_effect=containers.__getitem__),
                patch.object(
                    m,
                    'baseline',
                    side_effect=AssertionError('policy')
                    if failure == 'policy'
                    else None,
                ),
                patch.object(
                    m, 'sql', return_value=b'0' if failure == 'migration' else b'1'
                ),
                patch.object(
                    m,
                    'gates',
                    side_effect=AssertionError('gates') if failure == 'gates' else None,
                ),
                patch.object(
                    m,
                    'output',
                    return_value=b'changed unrelated'
                    if failure == 'unrelated'
                    else b'other unrelated',
                ),
                patch.object(Path, 'read_bytes', return_value=b'compose'),
            ):
                if failure:
                    with self.assertRaises(AssertionError):
                        m.verify_activation()
                else:
                    m.verify_activation()

    def test_verify_without_rehearsal_fails_without_commands(self):
        """Reject activation verification without recorded rehearsal evidence."""
        with self.assertRaises(AssertionError):
            self.m.verify_activation()


if __name__ == '__main__':
    unittest.main()
