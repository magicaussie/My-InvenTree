# Remote Development access and runtime review package

This is a **Development-only proposal**, not a deployed service. The package contains a forced-command SSH boundary and a fixed Compose policy using the existing `contrib/storage-layout-integration/Dockerfile`, `bootstrap.py`, and `seed.py`. It does not configure sshd, contact a server, build/import images, start containers, or approve deployment to Main. Installing the access boundary alone does not approve or install the runtime; review and approve both scripts and the Compose policy before the administrator runs them.

The `inventree-deploy` account has a locked password and `/bin/sh`, is not a member of Docker/sudo/LXD groups, and can issue only `up|stop|start|restart|status|logs` through a forced key and exact sudoers entries. Compose policy and runtime env are root-owned mode `0600` under `/etc/myinventree-dev` (`0700`). The deployment identity cannot alter the Compose file, env, image build context, mounts, or wrapper. Docker remains a privileged host boundary; only the trusted administrator builds/imports images. No generic docker/compose command, `exec`, build, pull, shell, volume deletion, or Main project operation is available.

## Workstation: create and upload the dedicated public key

Run on the trusted workstation. This guard exits before generation if either destination already exists. The private key never needs to be displayed or uploaded.

```sh
set -eu
install -d -m 0700 "$HOME/.ssh"
if [ -e "$HOME/.ssh/myinventree-development-deploy_ed25519" ] || \
   [ -e "$HOME/.ssh/myinventree-development-deploy_ed25519.pub" ]; then
  printf '%s\n' 'Refusing to overwrite existing key files' >&2
  exit 1
fi
ssh-keygen -t ed25519 -a 100 -f "$HOME/.ssh/myinventree-development-deploy_ed25519" -C 'myinventree-development-deploy'
ssh-keygen -lf "$HOME/.ssh/myinventree-development-deploy_ed25519.pub"
```

After independently verifying the host key for `mainserver-1`, and only after the owner approves this public-key upload, stage the **public** key at the exact path below. Use a verified `known_hosts` entry; do not disable strict checking or accept an unknown fingerprint blindly.

```sh
scp -o StrictHostKeyChecking=yes \
  "$HOME/.ssh/myinventree-development-deploy_ed25519.pub" \
  spetchal@mainserver-1:/home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub
```

## Administrator: combined access and runtime installation

Perform on `mainserver-1` from the exact reviewed source checkout. Recheck the repository revision and manually review the package, integration Dockerfile, bootstrap, seed, and host inventory first. This package does not install or change sshd configuration: verify the effective `AuthorizedKeysFile` for the account is the root-controlled `/var/lib/inventree-deploy/.ssh/authorized_keys`; validate sshd config separately if changed. Never grant this account Docker, sudo, or LXD group membership.

### Build and import reviewed images

As the trusted administrator, from the reviewed source checkout on the server (not through the constrained account), build the backend and frontend stages using the exact integration Dockerfile. Do not build via remote agent or give the deployment account access to the Docker socket. `pull_policy: never` means runtime deployment will not fetch images. Pin the checkout and inspect build output as part of the owner review; image tags below are the fixed local tags expected by Compose.

```sh
cd /path/to/reviewed/My-InvenTree
sudo docker build --pull=false --file contrib/storage-layout-integration/Dockerfile --target backend --tag localhost/myinventree-dev-backend:review .
sudo docker build --pull=false --file contrib/storage-layout-integration/Dockerfile --target frontend --tag localhost/myinventree-dev-frontend:review .
sudo docker image inspect localhost/myinventree-dev-backend:review localhost/myinventree-dev-frontend:review
```

The Dockerfile uses pinned base image digests and builds frontend assets and the Storage Layout plugin from this checkout. `--pull=false` avoids replacing those pinned inputs implicitly; the administrator must ensure required base images are already available and manually review/update the Dockerfile pins when appropriate.

### Install access and root-fixed runtime

From the reviewed package directory, the administrator runs both commands. The first validates sudoers with `visudo` before installing the locked account/key boundary, refuses existing identities/paths, and installs forced SSH dispatch. The second requires that account/policy directory, refuses existing Compose/env paths, creates random runtime credentials without printing them, renders Compose config without starting services, and installs root-only policy and env files. Both are explicit privileged owner actions.

```sh
cd /path/to/reviewed/My-InvenTree/contrib/remote-development
sudo ./install-access.sh /home/spetchal/myinventree-access-review/myinventree-development-deploy_ed25519.pub
sudo ./install-runtime.sh
```

The runtime installer runs `docker compose config --quiet` but does not start anything. After the owner approves the resulting package and confirms the two local images, start Development as the administrator using the same constrained wrapper lifecycle entrypoint:

```sh
sudo /usr/local/sbin/inventree-deploy up
```

Thereafter the dedicated forced SSH key can invoke the ordinary constrained lifecycle verbs without repeated owner approval; this permission is only for the fixed Development Compose policy. Never use it to modify policy, images, bootstrap, host settings, or Main. `status`, `logs`, `stop`, `start`, and `restart` are similarly constrained.

Installed key permissions are `/var/lib/inventree-deploy` and `.ssh` root-owned `0755`, `authorized_keys` root-owned `0644` (sshd can read, account cannot write); entrypoints root-owned `0755`; sudoers root-owned `0440`; policy directory root-owned `0700`; `compose.yml` and `runtime.env` root-owned `0600`. Check actual ownership/modes, groups, `sudo -l -U inventree-deploy`, `visudo -c`, and effective sshd key path before enabling access.

## Runtime behavior and limits

- The Development URL is `http://192.168.1.108:18081`. The Compose project and volume names are fixed to `myinventree-dev`; it uses its own PostgreSQL, Redis AOF, and `/data` named volumes. DB/Redis are only on an internal network. The only published port is proxy `192.168.1.108:18081`.
- Backend and proxy use the production built images from the integration Dockerfile. No build context or host bind mounts are present in Compose. Backend capabilities are dropped; services use `no-new-privileges`, bounded logs, memory limits, restart/health policies. These controls reduce container privileges but do **not** make a Docker daemon safe to expose to the deployment account.
- One-shot bootstrap waits for healthy DB/Redis, runs core migrations and the existing seed, then collectstatic/collectplugins; backend waits for successful completion. Seed creates/updates `sl_admin` and `sl_readonly` and assigns stable passwords from root-only env, seeds its integration locations, enables plugin feature gates and explicitly forces `ENABLE_HARDWARE=False` and `DISPATCHER_ENABLED=False`. Its password updates repeat on a later bootstrap; fixed random values prevent drift. Account passwords are not printed. The environment includes those credentials for backend/bootstrap, so treat `/etc/myinventree-dev/runtime.env` as highly sensitive. Retrieve credentials only through an owner-approved secure method; never expose them in logs/chat.
- **No worker is present or approved.** The application still has its own background-worker setting; this proposal does not start Django-Q/qcluster. Do not add a worker until queue/scheduler startup effects are reviewed. No WLED controller writes are performed or approved.
- The Dockerfile sets `INVENTREE_SECRET_KEY_FILE=/data/secret_key.txt`; the application is expected to generate its persistent key at first boot using the existing image behavior. The runtime installer does not overwrite or read it. The DB password uses the application's supported `INVENTREE_DB_PASSWORD` env and matching PostgreSQL password.
- No database backup/restore procedure has been exercised, no live service health or browser behavior has been confirmed, and no host firewall/TLS/CasaOS routing is modified. The package does not configure external ingress. The runtime installer fails closed unless `192.168.1.108` is present and `ss` successfully confirms both `18081` and `18082` have no listening TCP sockets; it does not stop or alter existing services.
- Main is not configured for deployment or approved. `compose.main.yml.example` is an independent, non-executable example only, with project `myinventree-main` and URL `http://192.168.1.108:18082`. It is not copied, rendered, validated, or installed by either installer and cannot be invoked through the Development wrapper. It requires separately supplied immutable application image digests and an independent owner-managed secrets env file. It contains no bootstrap, seed, test-account setup, or worker service. Database migrations and initial administration setup must be completed separately under explicit owner approval before any separately authorized start. The Main template grants no installer or deployment-account rights.

## Local validation

```sh
python3 -m unittest discover -s contrib/remote-development -p 'test_*.py' -v
sh -n contrib/remote-development/install-access.sh
sh -n contrib/remote-development/install-runtime.sh
```

Tests inspect command allowlists, shell syntax, install refusals/permissions, fixed runtime policy and secret creation logic. They do not invoke Docker, sudo, SSH, or perform host writes. Render Compose on the target only through the reviewed runtime installer; no remote action has been performed from this workspace.
