See [CONTRIBUTING.md](CONTRIBUTING.md) for codebase guidance.
Security reports must follow the security policy in [SECURITY.md](docs/docs/SECURITY.md) and provide how they interact with the [threat model](docs/docs/concepts/threat_model.md).

Do not open a pull request without manual review by a human. Do not file AI generated issues under any circumstances.
Using AI generated content in issue/PR discussions might lead to code of conduct violations and/or bans.

## My-InvenTree AI development workflow

For Zed and other coding agents working on this fork, follow [docs/ai/DEVELOPMENT_WORKFLOW.md](docs/ai/DEVELOPMENT_WORKFLOW.md) for bounded implementation, focused testing, safe development-branch pushes, and concise GitHub review handoffs. These additional rules do not override the contributor, security, or human-review requirements above.

## Deployment checkpoint 002J-L: pending SSH access

- The verified repository checkpoint is `130a76913d2059099c6da908c0c88b519a418a4c` on `development/my-inventree`, matching `origin/development/my-inventree` at the time recorded in `docs/DEPLOYMENT.md`.
- Stop all remote deployment work until SSH connectivity and host identity are established with the owner. DNS resolution is not proof of access; do not describe either installation as deployed, running, or verified.
- Never disable strict host-key checking or trust an unconfirmed fingerprint. Do not request or expose passwords, private keys, tokens, or environment secrets. Do not install keys or make privileged server changes on the owner's behalf.
- After the owner verifies the host fingerprint and authorizes a dedicated, key-only, non-root deployment account, use only an individually reviewed, constrained deployment mechanism. Development access must be limited to its own project and data. Main deployment, database changes, and physical WLED operations each require explicit owner approval.
- Never grant agents Docker group/socket access or unrestricted sudo. Root-owned Compose files alone are not a security boundary if an agent can modify the Compose configuration, build context, mounts, or invoked commands. No agent-controlled access to Main credentials or volumes.
- Do not modify existing CasaOS containers, import the old SQLite database or Django-Q queue, start old or unreviewed workers, or write to either WLED controller. Preserve secrets out of logs. The exact blocker and owner-run read-only diagnostics are documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
