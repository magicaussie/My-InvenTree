# Checkpoint 002J-D — independent review handoff

Repository: `magicaussie/My-InvenTree`
Branch: `development/my-inventree`
Base: `f118c6a4c655173d798788eaa6b75e1b9618a5ab`

## Source reconciliation

The deleted `/home/spetchal/Code/My-InvenTree` path was not recreated. Development
is now at `/media/spetchal/New Volume1/My-InvenTree-development-002JD`, on the
separately mounted `/dev/sdb1` filesystem. The original recovery archive was not
modified; all four reconstructed-file hashes still match its recorded manifest.

Recovered transcripts predate some of the confirmed baseline's changes. Blind
replay would remove bounds checks, rename exception classes and discard tests.
Those candidates were rejected. Recorded services/error-translation/cleanup tests
already present in the baseline were retained. The four reconciled files are
baseline-preserving, reviewed implementation candidates, **not proven exact final
bytes of the deleted worktree**:

- `wled.py`: baseline plus explicit commissioning capture/restore and earlier
  cleanup activation before the master-on write.
- `services.py`: baseline plus the observed stop/watchdog race correction.
- `test_wled.py`: all baseline tests retained, plus capture/restore, malformed
  snapshot and master-on read-back failure coverage.
- `test_services.py`: all baseline tests retained, plus watchdog-completed stop
  idempotence with a newer reservation, proving no stale hardware access.

No obsolete custom isolation/acceptance helpers were imported. Historical
untracked task/isolation-helper final-file identity remains unproven; none is
needed to restore this application checkpoint. Other lost uncommitted source
cannot be ruled out solely from transcripts.

## Changed behavior and limits

`WledAdapter.capture_state()` is read-only and captures writable runtime fields.
`restore_state()` keeps the master off during geometry restoration, removes
extra segments, restores master brightness/on last, and confirms captured fields
through read-back. It writes only `/json/state`, not presets or configuration.
Frozen individual-pixel snapshots are refused because those pixel colours are
not available from the state API. Effect phase and elapsed nightlight time are
not recoverable. A timeout/mismatch is unconfirmed, not a restoration success.

These are explicit commissioning operations. They do not change the established
production stop contract: stop means off/black/unfrozen. There is no new durable
snapshot model or automatic prior-state restoration on normal session stop.

The live run exposed an idempotent-stop race with watchdog expiry. `_stop_live`
now refreshes after a reservation-lock refusal and accepts an already-terminal
session, without clearing a newer owner's output. Nonterminal ownership failures
still raise `cabinet_busy`.

## Test evidence

Commands use the existing Python 3.12 venv, the restored plugin on `PYTHONPATH`
and disposable configuration/database on the separate volume:

```text
python src/backend/InvenTree/manage.py test storage_layout.tests.test_wled storage_layout.tests.test_services --keepdb --settings=storage_layout.test_settings --noinput
python src/backend/InvenTree/manage.py test storage_layout.tests --keepdb --exclude-tag migration_test --settings=storage_layout.test_settings --noinput
python src/backend/InvenTree/manage.py test storage_layout.tests.test_migrations --settings=storage_layout.test_settings --noinput
python src/backend/InvenTree/manage.py makemigrations storage_layout --check --dry-run --settings=storage_layout.test_settings
```

- Final focused adapter/services: **228 tests, OK**.
- Final non-migration plugin suite: **527 tests run, OK, one skipped**.
- Migration lifecycle: **6 tests, OK**. No model changes detected.
- Existing real Django HTTP + qcluster simulation harness: **56 requests passed**,
  covering cabinet/drawer/bin creation, layout updates, topology/mapping,
  profiles, diagnostics, worker execution and expected error responses.
- No frontend source changed. Old frontend/browser results are historical,
  not newly executed browser acceptance.
- Configured Git hooks run normally before publication; no bypass flags.

## Shared-cache and worker result

The web and worker use the same standard Django `FileBasedCache` path. An
independent Django process observed the worker's heartbeat. This resolved the
original process-local-cache dispatcher failure. A long watchdog monopolizes
InvenTree's default single SQLite worker; the disposable integration settings
therefore explicitly use two workers and a dedicated queue name, timeout 300 s,
retry 450 s. No production configuration was changed. This is not production
SQLite concurrency qualification; production shared-cache/database deployment
requirements still apply. A stale disposable watchdog lease was removed only
after the corresponding prior child processes had terminated.

## Real-controller results

Both controllers responded as WLED `16.0.1`, totals 1161 and 1196. The hardware
reference records all bus ranges and the eight tested boundary intervals.
Each single-pixel test used red RGB `(255,0,0)`, brightness **8/255**, duration
**2 seconds**, through real Django HTTP and qcluster. All eight reached `active`,
then `stopped` with off/nightlight-disabled read-back. Later drawer and
bin-native-location locate used green `(0,24,0)`, brightness 8, duration 2 s;
both reached active and stopped. The fixture's drawer allocation spans all four
buses; this is not evidence of commissioned physical drawer wiring.

The direct `kind=bin` request was correctly rejected; supported bin locate uses
its native stock-location binding. A rate-limit rejection during the combined
run was respected; the remaining locate/profile checks passed separately. Both
controllers' captured writable runtime fields were restored and confirmed after
runs. Persistent configuration hashes matched before/after. No persistent
controller configuration, firmware or network settings were written.

**Optical result: pending.** No camera/owner observation was captured. Successful
commands and runtime read-back do not prove light emission, visible colour,
physical string identity, direction, cabinet/bin wiring or lack of unintended
illumination. This checkpoint must not be called physical commissioning PASS.

## Evidence locations

Private source transcripts, databases, cookies and raw logs remain outside Git.
Reconciliation root:
`/media/spetchal/New Volume1/My-InvenTree-reconciliation-002JD/`.

- `runtime/eight-boundary-tests-evidence.json`: all eight active/stop results;
  its enclosing run later hit the recorded throttle rejection.
- `runtime/authorized-live-evidence.json`: completed later locate/profile run,
  configuration hash equality and confirmed runtime restoration.
- `runtime/adapter-restoration-results.json`: final restored fields per host.
- `runtime/heartbeat-evidence.json`: cross-process worker heartbeat proof.
- `runtime/focused-tests.log`, `runtime/regression-tests.log`,
  `runtime/migration-tests.log`: executed test results.
- `http-regression/http-evidence.json`: 56-request real HTTP simulation pass.
- `final-candidates/`, `final-candidate-sha256.json`,
  `final-baseline-relative.patch`, `RECONCILIATION-REVIEW.md`: reviewed source,
  hashes, reversible patch and provenance outside the immutable recovery archive.

Stop here for independent ChatGPT review. No merge or deployment. Remaining
physical evidence requires an observer; no further permission for the already
authorised temporary tests is requested.
