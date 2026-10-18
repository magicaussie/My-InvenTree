"""Unit safety regressions for the disposable runner (not runtime evidence)."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import stack


class DriverSafetyTests(unittest.TestCase):
    """Keep generated secrets private and all Docker commands project-scoped."""

    def setUp(self):
        """Redirect generated credentials away from the actual test stack."""
        directory = tempfile.TemporaryDirectory(prefix='sl001-driver-unit-')
        self.addCleanup(directory.cleanup)
        self.runtime = Path(directory.name) / '.runtime'
        for key, value in {
            'RUNTIME': self.runtime,
            'STATE': self.runtime / 'stack.json',
            'ENV_FILE': self.runtime / 'stack.env',
        }.items():
            patch = mock.patch.object(stack, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_private_unique_credentials_and_non_overwriting_init(self):
        """Initialization creates private credentials and never replaces them."""
        with (
            mock.patch.object(stack.subprocess, 'run'),
            mock.patch.object(stack.socket, 'socket'),
        ):
            stack.initialize()
            original = stack.ENV_FILE.read_bytes()
            stack.initialize()
        self.assertEqual(stack.ENV_FILE.read_bytes(), original)
        self.assertEqual(stack.ENV_FILE.stat().st_mode & 0o777, 0o600)
        self.assertEqual(stack.RUNTIME.stat().st_mode & 0o777, 0o700)
        command = stack.compose()
        self.assertEqual(command[:3], ['docker', 'compose', '--project-name'])
        self.assertRegex(command[3], r'^sl001_[a-f0-9]{12}$')
        self.assertNotIn('PASSWORD', ' '.join(command))

    def test_refuses_unowned_project(self):
        """A modified runtime state cannot target an existing application."""
        self.runtime.mkdir()
        stack.STATE.write_text(json.dumps({'project': 'production'}))
        with self.assertRaises(ValueError):
            stack.compose()

    def test_docker_context_does_not_exclude_build_domain_source(self):
        """Build directories are actual InvenTree domains, not all artifacts."""
        patterns = (stack.HERE / 'Dockerfile.dockerignore').read_text().splitlines()
        self.assertNotIn('**/build', patterns)
        self.assertIn('**/.runtime', patterns)
        self.assertIn('**/node_modules', patterns)


if __name__ == '__main__':
    unittest.main()
