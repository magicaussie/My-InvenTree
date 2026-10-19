"""Safety checks for the runtime installer and fixed Compose policy."""

import subprocess
import unittest
from pathlib import Path

PACKAGE = Path(__file__).parent
INSTALLER = PACKAGE / 'install-runtime.sh'
COMPOSE = (PACKAGE / 'compose.yml').read_text()
MAIN_EXAMPLE = (PACKAGE / 'compose.main.yml.example').read_text()


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
            "INVENTREE_ALLOWED_HOSTS: '192.168.1.108,localhost,127.0.0.1'",
            'INVENTREE_SITE_URL: http://192.168.1.108:18081',
            "ports: ['192.168.1.108:18081:80']",
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
        source = INSTALLER.read_text()
        self.assertIn('LAN_IP=192.168.1.108', source)
        self.assertIn('for port in 18081 18082', source)
        self.assertIn('refusing deployment', source)
        self.assertIn('[ -x /usr/bin/ss ] || fail', source)
        self.assertIn('LISTENERS=$(/usr/bin/ss -H -ltn', source)
        self.assertIn('could not inspect TCP port', source)

    def test_main_example_is_separate_and_not_installer_managed(self):
        """Keep Main isolated in an example with no Dev installer integration."""
        self.assertIn('myinventree-main', (PACKAGE / 'README.md').read_text())
        self.assertIn('main-postgres:', MAIN_EXAMPLE)
        self.assertIn('main-redis:', MAIN_EXAMPLE)
        self.assertIn('main-app-data:', MAIN_EXAMPLE)
        self.assertIn("ports: ['192.168.1.108:18082:80']", MAIN_EXAMPLE)
        self.assertIn('http://192.168.1.108:18082', MAIN_EXAMPLE)
        self.assertIn('${MAIN_BACKEND_REPOSITORY:?', MAIN_EXAMPLE)
        self.assertIn('${MAIN_BACKEND_DIGEST:?', MAIN_EXAMPLE)
        self.assertIn('${MAIN_FRONTEND_REPOSITORY:?', MAIN_EXAMPLE)
        self.assertIn('${MAIN_FRONTEND_DIGEST:?', MAIN_EXAMPLE)
        self.assertIn('${MAIN_DB_PASSWORD:?', MAIN_EXAMPLE)
        self.assertNotIn('bootstrap:', MAIN_EXAMPLE)
        self.assertNotIn('SL_ADMIN_PASSWORD', MAIN_EXAMPLE)
        self.assertNotIn('SL_READONLY_PASSWORD', MAIN_EXAMPLE)
        self.assertNotIn('worker:', MAIN_EXAMPLE)
        self.assertNotIn('compose.main.yml.example', INSTALLER.read_text())
        self.assertNotIn('myinventree-main', INSTALLER.read_text())
        self.assertIn('compose.main.yml.example', (PACKAGE / 'README.md').read_text())
        self.assertIn('postgres:/var/lib/postgresql/data', COMPOSE)
        self.assertIn('redis:/data', COMPOSE)
        self.assertIn('app-data:/data', COMPOSE)
        self.assertIn('max-size: 10m', COMPOSE)
        self.assertIn('mem_limit:', COMPOSE)


if __name__ == '__main__':
    unittest.main()
