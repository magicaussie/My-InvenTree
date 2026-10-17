# 006 — Data Migration

**Status:** DRAFT  
**Repository:** magicaussie/My-InvenTree  
**Implementation authorised:** No

## Purpose
Read-only assessment, staged import, reconciliation and cutover.

## Requirements
- [ ] Review existing InvenTree features, source code, plugin interfaces and relevant WLEDger behaviour before implementing.
- [ ] Document confirmed requirements separately from proposals and unresolved questions.
- [ ] Define models, API behaviour, UI interactions, permissions, failure handling and tests where applicable.
- [ ] Preserve existing WLEDger data and operation until verified migration.
- [ ] No live WLED hardware commands without explicit approval.

## Confirmed design constraints
- One existing GitHub repository and one main development line; no unnecessary forks or branches.
- Prefer native InvenTree APIs and plugins; modify core only with documented justification.
- Keep documentation concise and project-specific.

## Decisions and proposals
_To be reviewed. Do not treat proposals as approved._

## Open questions
- [ ] Confirm detailed functional requirements and acceptance criteria.
- [ ] Identify integration boundaries and dependencies.

## Implementation tracking
- [ ] Source audit complete
- [ ] Design reviewed
- [ ] Design approved
- [ ] Implementation complete
- [ ] Automated tests passed
- [ ] User acceptance verified

## Change log
- 2026-10-17: Initial draft created.
