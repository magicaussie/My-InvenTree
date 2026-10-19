"""Security tests for forced-command SSH dispatch."""

import importlib.machinery
import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

PATH = Path(__file__).with_name('ssh-dispatcher')
LOADER = importlib.machinery.SourceFileLoader('ssh_dispatcher', str(PATH))
SPEC = importlib.util.spec_from_loader('ssh_dispatcher', LOADER)
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


class DispatcherTests(unittest.TestCase):
    """Verify only canonical allowlisted commands reach the wrapper."""

    def test_exact_allowlist_invokes_wrapper(self):
        """Ensure every supported verb invokes only its fixed wrapper call."""
        for verb in sorted(MODULE.VERBS):
            with (
                self.subTest(verb=verb),
                patch.dict(
                    os.environ, {'SSH_ORIGINAL_COMMAND': f'inventree-deploy {verb}'}
                ),
                patch.object(
                    MODULE.subprocess,
                    'run',
                    return_value=type('R', (), {'returncode': 0})(),
                ) as run,
            ):
                self.assertEqual(MODULE.main(), 0)
                run.assert_called_once_with(
                    ['/usr/bin/sudo', '-n', MODULE.WRAPPER, verb], check=False
                )

    def test_rejects_shells_arguments_and_noncanonical_text(self):
        """Reject shells, extra arguments, and malformed commands."""
        invalid = (
            '',
            'inventree-deploy',
            'inventree-deploy up --build',
            'inventree-deploy  up',
            'inventree-deploy up; id',
            'sh',
            'sudo id',
            'inventree-deploy exec backend sh',
        )
        for command in invalid:
            with (
                self.subTest(command=command),
                patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}),
                patch.object(MODULE.subprocess, 'run') as run,
            ):
                self.assertEqual(MODULE.main(), 2)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
