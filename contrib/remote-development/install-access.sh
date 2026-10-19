#!/bin/sh
# Install only the constrained SSH access boundary. Run as root from this
# reviewed package directory. This does not install or approve Compose.
set -eu

ACCOUNT=inventree-deploy
HOME_DIR=/var/lib/inventree-deploy
POLICY_DIR=/etc/myinventree-dev
AUTH_DIR=$HOME_DIR/.ssh
AUTH_FILE=$AUTH_DIR/authorized_keys
DISPATCHER=/usr/local/libexec/myinventree-dev-ssh
WRAPPER=/usr/local/sbin/inventree-deploy
SUDOERS=/etc/sudoers.d/myinventree-deploy
SSHD_POLICY=/etc/ssh/sshd_config.d/00-myinventree-deploy.conf
PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SUDOERS_SOURCE=$PACKAGE_DIR/sudoers.example
DISPATCHER_SOURCE=$PACKAGE_DIR/ssh-dispatcher
WRAPPER_SOURCE=$PACKAGE_DIR/deploy-wrapper

fail() { printf '%s\n' "install-access: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'must run as root (normally via sudo)'
[ "$#" -eq 1 ] || fail "usage: $0 /path/to/dedicated_ed25519_key.pub"
PUBKEY=$1
[ -f "$PUBKEY" ] && [ ! -L "$PUBKEY" ] && [ -r "$PUBKEY" ] || fail 'public key must be a readable regular, non-symlink file'
[ -f "$SUDOERS_SOURCE" ] && [ -f "$DISPATCHER_SOURCE" ] && [ -f "$WRAPPER_SOURCE" ] || fail 'run from the intact reviewed package'

# Accept one ordinary public-key record only. Key bytes are never printed.
KEY_LINE=$(cat -- "$PUBKEY") || fail 'cannot read public key'
[ -n "$KEY_LINE" ] || fail 'public key file is empty'
[ "$(printf '%s\n' "$KEY_LINE" | wc -l | tr -d ' ')" -eq 1 ] || fail 'public key file must contain exactly one line'
set -- $KEY_LINE
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail 'expected one SSH public-key record'
[ "$1" = ssh-ed25519 ] || fail 'only Ed25519 public keys are accepted'
/usr/bin/ssh-keygen -l -f "$PUBKEY" >/dev/null 2>&1 || fail 'ssh-keygen could not validate the public key'
case "$2" in *[!A-Za-z0-9+/=]*|'') fail 'malformed public-key data' ;; esac

# Refuse every pre-existing identity or privileged destination. No overwrites.
if getent passwd "$ACCOUNT" >/dev/null 2>&1; then fail "account $ACCOUNT already exists"; fi
for path in "$HOME_DIR" "$POLICY_DIR" "$AUTH_DIR" "$AUTH_FILE" "$DISPATCHER" "$WRAPPER" "$SUDOERS" "$SSHD_POLICY"; do
    [ ! -e "$path" ] && [ ! -L "$path" ] || fail "destination already exists: $path"
done

# Parse/validate the exact sudo policy before making any system changes.
TMP=$(mktemp /run/myinventree-deploy.sudoers.XXXXXX)
cleanup() { rm -f -- "$TMP"; }
trap cleanup EXIT HUP INT TERM
install -o root -g root -m 0440 "$SUDOERS_SOURCE" "$TMP"
/usr/sbin/visudo -cf "$TMP" >/dev/null || fail 'sudoers validation failed; no installation performed'

# Install the immutable entry points before creating the account/key access.
install -d -o root -g root -m 0700 "$POLICY_DIR"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$DISPATCHER_SOURCE" "$DISPATCHER"
install -o root -g root -m 0755 "$WRAPPER_SOURCE" "$WRAPPER"
install -o root -g root -m 0440 "$TMP" "$SUDOERS"
useradd --system --no-create-home --home-dir "$HOME_DIR" --shell /bin/sh --password '!' "$ACCOUNT"
install -d -o root -g root -m 0755 "$HOME_DIR"
install -d -o root -g root -m 0755 "$AUTH_DIR"
umask 077
printf 'restrict,command="%s" %s\n' "$DISPATCHER" "$KEY_LINE" > "$AUTH_FILE"
chown root:root "$AUTH_FILE"
chmod 0644 "$AUTH_FILE"

# Validate the installed policy as a final check; revert access-critical files
# on failure rather than report success with an invalid sudo policy.
if ! /usr/sbin/visudo -c >/dev/null; then
    rm -f -- "$SUDOERS" "$AUTH_FILE"
    userdel "$ACCOUNT" || true
    fail 'global sudoers validation failed; removed account/key/policy entry'
fi
# Apply account-wide restrictions as well as the forced authorized key. The
# early drop-in wins OpenSSH's first-obtained-value rule for Match settings.
install -o root -g root -m 0644 "$PACKAGE_DIR/sshd-deploy.conf" "$SSHD_POLICY"
if ! /usr/sbin/sshd -t; then
    rm -f -- "$SSHD_POLICY" "$AUTH_FILE"
    fail 'sshd validation failed; removed SSH policy/key, daemon not reloaded'
fi
EFFECTIVE=$(/usr/sbin/sshd -T -C user=inventree-deploy,host=mainserver-1,addr=100.98.254.48)
for setting in \
    'forcecommand /usr/local/libexec/myinventree-dev-ssh' \
    'authenticationmethods publickey' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    'pubkeyauthentication yes' \
    'authorizedkeysfile /var/lib/inventree-deploy/.ssh/authorized_keys' \
    'authorizedkeyscommand none' \
    'trustedusercakeys none' \
    'disableforwarding yes' \
    'permittty no' \
    'permituserrc no' \
    'permituserenvironment no'; do
    if ! printf '%s\n' "$EFFECTIVE" | grep -Fxq "$setting"; then
        rm -f -- "$SSHD_POLICY" "$AUTH_FILE"
        fail "effective SSH policy mismatch: $setting; daemon not reloaded"
    fi
done
# Reload, never restart: existing administrative sessions remain available.
systemctl reload ssh || fail 'SSH reload failed; inspect service before proceeding'
printf '%s\n' 'Constrained Development SSH access installed.' \
    'Compose/configuration was not installed, validated, or approved.' \
    'Verify AuthorizedKeysFile for this account and confirm groups with id and sudo -l.'
