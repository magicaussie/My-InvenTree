# AI coding workflow — My-InvenTree

This document supplements [CONTRIBUTING.md](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md) and the existing project design specifications. It does not override security policy, contributor rules, or the owner's explicit instructions.

## Goals

- Minimise **wall-clock time to accepted functionality**, not merely token count.
- Use ChatGPT for architecture and code review; use the Zed coding agent for bounded implementation.
- Make GitHub the review handoff, with frequent **reviewable development-branch pushes**.
- Never confuse a pushed commit with approval to merge, deploy or operate hardware.

## Before starting a task

1. Run `git status --short --branch`, `git branch -vv`, `git remote -v` and `git log -1 --oneline`.
2. Identify the current task, its exact acceptance criteria, the authoritative design document and relevant files. Prefer symbol-targeted searches to repository-wide reading.
3. Preserve all local/untracked changes. If work is already in progress, use the current feature branch unless a separate branch is necessary and safe.
4. Do **not** create competing forks, reset branches, discard changes, or silently overwrite existing work.
5. For a design conflict or a change requiring a new persistence contract, stop and request an architectural decision before implementing.

## Execution: short checkpoints

- Aim for **15–25 minutes per checkpoint**, as a time budget rather than a correctness guarantee.
- Implement one coherent vertical slice with explicit inputs/outputs. Do not invent additional features.
- Prefer the existing React/Mantine, Django/DRF, native InvenTree location, and WLED simulation contracts.
- Do not replace the SVG editor with Fabric.js or another engine until an approved migration specification exists.
- Avoid unnecessary subagents, repeated repo exploration, repeated full-suite runs, and long narrative progress reports.
- If a defect survives **two evidence-based correction attempts**, stop with the failure evidence and a proposed next diagnostic; do not keep guessing.
- A checkpoint that hits the time budget should be reported as incomplete rather than rushed or falsely declared done.

## Testing

- Choose tests based on changed contracts; run the narrowest relevant tests first.
- Broaden to integration/browser/migration tests when the changed interfaces justify it.
- Use disposable/local test environments and WLED simulation only. Never claim physical hardware validation.
- Record commands, pass/fail counts and the first useful error; distinguish unrun tests from passing tests.
- Do not use AI-driven visual/browser testing for changes unrelated to the UI.
- Never skip a necessary security, permission, migration, or safety test merely to meet the time budget.

## GitHub handoff

- Commit a coherent checkpoint to the **active development branch** and push it when the working tree is safe to publish.
- Check for secrets, tokens, personal data, database dumps, logs, large generated artifacts, and local configuration before staging.
- Do not automatically merge into `master`, force-push, delete branches, open PRs, or create AI-generated issues. Existing [AGENTS.md](../../AGENTS.md) requires human review before PR creation.
- Do not push unfinished changes that would expose secrets or leave a misleading claim of completion. Mark incomplete checkpoints clearly.
- After pushing, provide this compact handoff:

```text
REPO: magicaussie/My-InvenTree
BRANCH: <branch>
COMMIT: <full SHA>
REVIEW URL: <GitHub commit or branch URL>
SCOPE: <one sentence>
FILES: <key paths>
TESTS: <commands and results; or explicitly not run>
BLOCKERS: <specific unresolved issues, or none>
NEXT: <one bounded recommended task>
```

## External review and corrections

ChatGPT reviews the pushed commit/diff and relevant surrounding source, not only screenshots or agent summaries. Reviews should identify exact files/symbols, root causes where supported, proposed code changes or pseudocode, compatibility constraints and focused acceptance tests.

Implement only the review's confirmed, in-scope corrections. If source evidence contradicts the proposed fix, explain the discrepancy before changing code. Push the correction to the same feature branch and return the new SHA.

## Safety boundaries

- No production deployment, live database migration, physical WLED/controller access, device reconfiguration or firmware changes without explicit owner authorisation.
- No automatic merging, destructive Git operations, or deletion of other agents' work.
- Preserve existing InvenTree inventory semantics and WLED safety behaviour.
- Broad tool permissions in Zed settings are **not** authorisation to perform destructive or live operations.

## Project-specific references

- Storage/WLED design and status: `docs/design/001 - Storage Layout & WLED.md`
- Storage layout plugin: `src/plugins/storage_layout/`
- Upstream contribution rules: `CONTRIBUTING.md`, `AGENTS.md`
