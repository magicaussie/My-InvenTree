"""Bootstrap only the disposable Compose stack's new database and assets."""

import subprocess
import sys
from pathlib import Path

ROOT = Path('/app')
MANAGE = ROOT / 'src/backend/InvenTree/manage.py'


def main():
    """Migrate core, activate/migrate the plugin, then collect its assets."""
    commands = [
        ['migrate', '--noinput'],
        [
            'shell',
            '-c',
            "exec(open('/app/contrib/storage-layout-integration/seed.py').read())",
        ],
        ['collectstatic', '--noinput'],
        ['collectplugins'],
    ]
    for command in commands:
        subprocess.run([sys.executable, str(MANAGE), *command], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
