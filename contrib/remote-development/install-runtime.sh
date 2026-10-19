#!/bin/sh
# Install a fixed Dev Compose policy and private runtime credentials. Root only.
set -eu

ACCOUNT=inventree-deploy
POLICY_DIR=/etc/myinventree-dev
COMPOSE_TARGET=$POLICY_DIR/compose.yml
ENV_TARGET=$POLICY_DIR/runtime.env
PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
fail() { printf '%s\n' "install-runtime: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'must run as root (normally via sudo)'
[ "$#" -eq 0 ] || fail 'takes no arguments'
getent passwd "$ACCOUNT" >/dev/null 2>&1 || fail "required account $ACCOUNT is absent; install access first"
[ "$(id -nG "$ACCOUNT" | tr ' ' '\n' | grep -E '^(docker|sudo|lxd)$' || true)" = '' ] || fail "$ACCOUNT must not belong to docker, sudo, or lxd"
[ -d "$POLICY_DIR" ] && [ ! -L "$POLICY_DIR" ] || fail 'expected root-installed policy directory'
[ "$(stat -c '%U:%G:%a' "$POLICY_DIR")" = root:root:700 ] || fail 'policy directory must be root:root mode 0700'
[ -f "$PACKAGE_DIR/compose.yml" ] && [ ! -L "$PACKAGE_DIR/compose.yml" ] || fail 'reviewed compose.yml is missing or not regular'
[ ! -e "$COMPOSE_TARGET" ] && [ ! -L "$COMPOSE_TARGET" ] || fail "refusing existing destination $COMPOSE_TARGET"
[ ! -e "$ENV_TARGET" ] && [ ! -L "$ENV_TARGET" ] || fail "refusing existing destination $ENV_TARGET"
[ -x /usr/local/sbin/inventree-deploy ] || fail 'constrained wrapper is not installed'
[ -x /usr/bin/docker ] || fail 'Docker CLI is missing'

TMP=$(mktemp -d "$POLICY_DIR/.runtime.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM
chmod 0700 "$TMP"
python3 - "$TMP/runtime.env" <<'PY'
import secrets
import sys
from pathlib import Path

path = Path(sys.argv[1])
values = {
    'POSTGRES_PASSWORD': secrets.token_urlsafe(48),
    'INVENTREE_DB_PASSWORD': None,
    'SL_ADMIN_PASSWORD': secrets.token_urlsafe(48),
    'SL_READONLY_PASSWORD': secrets.token_urlsafe(48),
}
values['INVENTREE_DB_PASSWORD'] = values['POSTGRES_PASSWORD']
with path.open('x', encoding='ascii') as handle:
    for key, value in values.items():
        handle.write(f'{key}={value}\n')
PY
chown root:root "$TMP/runtime.env"
chmod 0600 "$TMP/runtime.env"
install -o root -g root -m 0600 "$PACKAGE_DIR/compose.yml" "$TMP/compose.yml"
# Validate without contacting a registry or creating/starting containers.
/usr/bin/docker compose --project-name myinventree-dev --file "$TMP/compose.yml" \
    --env-file "$TMP/runtime.env" config --quiet || fail 'Compose policy validation failed'
# Both destinations were checked before staging; install with exclusive creation.
( set -C; cat "$TMP/compose.yml" > "$COMPOSE_TARGET" ) || fail 'could not install Compose policy without overwriting'
chown root:root "$COMPOSE_TARGET"
chmod 0600 "$COMPOSE_TARGET"
( set -C; cat "$TMP/runtime.env" > "$ENV_TARGET" ) || fail 'could not install runtime env without overwriting'
chown root:root "$ENV_TARGET"
chmod 0600 "$ENV_TARGET"
printf '%s\n' 'Fixed Development runtime policy and private credentials installed.' \
    'No services were started. Owner must import the reviewed images, then invoke the constrained wrapper: sudo /usr/local/sbin/inventree-deploy up'
