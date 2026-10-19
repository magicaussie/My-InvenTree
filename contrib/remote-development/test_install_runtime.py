"""Safety checks for the runtime installer and fixed Compose policy."""

import subprocess
import unittest
from pathlib import Path

PACKAGE = Path(__file__).parent
INSTALLER = PACKAGE / 'install-runtime.sh'
COMPOSE = (PACKAGE / 'compose.yml').read_text()


class RuntimePackageTests(unittest.TestCase):
    """Verify runtime setup is fixed, isolated, and secret-safe."""

    def test_shell_syntax_and_no_argument_policy(self):
        """Require valid shell syntax and administrator-only no-argument use."""
        result = subprocess.run(
            ['sh', '-n', str(INSTALLER)], check=False, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        source = INSTALLER.read_text()
        self.assertIn('[ "$#" -eq 0 ]', source)
        self.assertIn('[ "$(id -u)" -eq 0 ]', source)

    def test_runtime_secrets_are_generated_and_root_only(self):
        """Require generated runtime credentials to remain root-readable only."""
        source = INSTALLER.read_text()
        self.assertIn('secrets.token_urlsafe(48)', source)
        for name in (
            'POSTGRES_PASSWORD',
            'INVENTREE_DB_PASSWORD',
            'SL_ADMIN_PASSWORD',
            'SL_READONLY_PASSWORD',
        ):
            self.assertIn(f"'{name}'", source)
        self.assertIn('chmod 0600 "$TMP/runtime.env"', source)
        self.assertIn('chmod 0600 "$ENV_TARGET"', source)
        self.assertNotIn('print(value', source)

    def test_existing_targets_refused_before_policy_write(self):
        """Require validation before installing files into protected paths."""
        source = INSTALLER.read_text()
        refusal = source.index('[ ! -e "$COMPOSE_TARGET" ]')
        validation = source.index('config --quiet')
        install = source.index('( set -C; cat "$TMP/compose.yml" > "$COMPOSE_TARGET" )')
        self.assertLess(refusal, validation)
        self.assertLess(validation, install)

    def test_fixed_isolated_persistent_compose_policy(self):
        """Check fixed images, isolation, hardware gates, and persistence policy."""
        required = (
            'image: localhost/myinventree-dev-backend:review',
            'image: localhost/myinventree-dev-frontend:review',
            'pull_policy: never',
            'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?runtime.env is required}',
            'INVENTREE_SECRET_KEY_FILE: /data/secret_key.txt',
            "INVENTREE_ALLOWED_HOSTS: '100.98.254.48,localhost,127.0.0.1'",
            'INVENTREE_SITE_URL: http://100.98.254.48:18081',
            "ports: ['100.98.254.48:18081:80']",
            "command: [redis-server, --appendonly, 'yes', --appendfsync, everysec]",
            'condition: service_completed_successfully',
            'ENABLE_HARDWARE: False',
            'DISPATCHER_ENABLED: False',
        )
        for item in required:
            if item in ('ENABLE_HARDWARE: False', 'DISPATCHER_ENABLED: False'):
                # These enforced DB settings live in the copied integration seed.
                seed = (
                    PACKAGE.parent / 'storage-layout-integration' / 'seed.py'
                ).read_text()
                self.assertIn(item.split(':')[0], seed)
            else:
                self.assertIn(item, COMPOSE)
        self.assertNotIn('\n  worker:', COMPOSE)
        self.assertIn('postgres:/var/lib/postgresql/data', COMPOSE)
        self.assertIn('redis:/data', COMPOSE)
        self.assertIn('app-data:/data', COMPOSE)
        self.assertIn('max-size: 10m', COMPOSE)
        self.assertIn('mem_limit:', COMPOSE)


if __name__ == '__main__':
    unittest.main()
