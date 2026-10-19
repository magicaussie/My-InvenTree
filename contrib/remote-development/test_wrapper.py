"""Security tests for the constrained Compose deployment wrapper."""

import importlib.machinery
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

WRAPPER = Path(__file__).with_name('deploy-wrapper')
LOADER = importlib.machinery.SourceFileLoader('deploy_wrapper', str(WRAPPER))
SPEC = importlib.util.spec_from_loader('deploy_wrapper', LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


class WrapperPolicyTests(unittest.TestCase):
    """Verify wrapper input is constrained to the reviewed lifecycle verbs."""

    def test_rejects_arbitrary_or_extra_arguments_without_execution(self):
        """Reject arbitrary commands and arguments without running Docker."""
        for args in (
            [],
            ['exec'],
            ['up', '--build'],
            ['run', 'app'],
            ['status', '--project-name', 'other'],
        ):
            with self.subTest(args=args), patch.object(MODULE.subprocess, 'run') as run:
                self.assertEqual(MODULE.main(args), 2)
                run.assert_not_called()

    def test_restart_excludes_one_shot_bootstrap(self):
        """Keep migration/seed out of routine restarts and preserve sessions."""
        with patch.object(
            MODULE.subprocess,
            'run',
            return_value=type('Result', (), {'returncode': 0})(),
        ) as run:
            self.assertEqual(MODULE.main(['restart']), 0)
        self.assertEqual(
            run.call_args.args[0][8:], ['restart', 'db', 'redis', 'backend', 'proxy']
        )

    def test_up_uses_only_fixed_compose_policy(self):
        """Ensure up invokes Compose with only the root-owned policy paths."""
        with patch.object(
            MODULE.subprocess,
            'run',
            return_value=type('Result', (), {'returncode': 0})(),
        ) as run:
            self.assertEqual(MODULE.main(['up']), 0)
        command = run.call_args.args[0]
        self.assertEqual(
            command[:6],
            [
                '/usr/bin/docker',
                'compose',
                '--project-name',
                'myinventree-dev',
                '--file',
                '/etc/myinventree-dev/compose.yml',
            ],
        )
        self.assertEqual(
            command[6:9], ['--env-file', '/etc/myinventree-dev/runtime.env', 'up']
        )
        self.assertEqual(command[9:], ['-d', '--wait', '--wait-timeout', '300'])
        self.assertEqual(run.call_args.kwargs['cwd'], '/etc/myinventree-dev')


if __name__ == '__main__':
    unittest.main()
