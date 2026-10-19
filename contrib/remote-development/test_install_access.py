"""Safety checks for the privileged access installer."""

import subprocess
import unittest
from pathlib import Path

PACKAGE = Path(__file__).parent
INSTALLER = PACKAGE / 'install-access.sh'


class InstallerSafetyTests(unittest.TestCase):
    """Verify the installer enforces its account and filesystem policy."""

    def test_shell_syntax(self):
        """Require valid POSIX shell syntax."""
        result = subprocess.run(
            ['sh', '-n', str(INSTALLER)], check=False, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_requires_exactly_one_public_key_argument_and_root(self):
        """Require a single validated public key and administrator execution."""
        source = INSTALLER.read_text()
        self.assertIn('[ "$(id -u)" -eq 0 ]', source)
        self.assertIn('[ "$#" -eq 1 ]', source)
        self.assertIn('public key must be a readable regular, non-symlink file', source)
        self.assertIn('public key file must contain exactly one line', source)
        self.assertIn('[ "$1" = ssh-ed25519 ]', source)
        self.assertIn('/usr/bin/ssh-keygen -l -f "$PUBKEY" >/dev/null 2>&1', source)
        self.assertIn('ACCOUNT=inventree-deploy', source)
        self.assertIn('HOME_DIR=/var/lib/inventree-deploy', source)
        self.assertIn(
            'inventree-deploy ALL=(root)', (PACKAGE / 'sudoers.example').read_text()
        )

    def test_refuses_existing_identity_and_paths_before_install(self):
        """Ensure existing identities and destinations are refused up front."""
        source = INSTALLER.read_text()
        refusal = source.index('if getent passwd "$ACCOUNT"')
        validation = source.index('/usr/sbin/visudo -cf "$TMP"')
        first_install = source.index('install -d -o root -g root -m 0700 "$POLICY_DIR"')
        self.assertLess(refusal, validation)
        self.assertLess(validation, first_install)
        for path in (
            '$HOME_DIR',
            '$POLICY_DIR',
            '$AUTH_DIR',
            '$AUTH_FILE',
            '$DISPATCHER',
            '$WRAPPER',
            '$SUDOERS',
        ):
            self.assertIn(
                path,
                source[
                    source.index('for path in') : source.index(
                        'done', source.index('for path in')
                    )
                ],
            )

    def test_key_is_forced_and_system_paths_are_root_controlled(self):
        """Check forced-command and non-writable SSH key permissions."""
        source = INSTALLER.read_text()
        self.assertIn('restrict,command="%s" %s', source)
        self.assertIn('install -d -o root -g root -m 0755 "$HOME_DIR"', source)
        self.assertIn('install -d -o root -g root -m 0755 "$AUTH_DIR"', source)
        self.assertIn('chown root:root "$AUTH_FILE"', source)
        self.assertIn('chmod 0644 "$AUTH_FILE"', source)
        self.assertIn('--shell /bin/sh --password \'!\' "$ACCOUNT"', source)
        self.assertIn('install -o root -g root -m 0440 "$TMP" "$SUDOERS"', source)


if __name__ == '__main__':
    unittest.main()
