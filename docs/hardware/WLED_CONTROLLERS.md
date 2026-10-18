# WLED controller hardware reference

## Owner-reported inventory

Source: owner-supplied Checkpoint 002J-C task, recorded 2026-10-18. These counts are authoritative owner reports, not independently verified wiring.

| Controller | HTTP origin | Owner string label | Pixels |
|---|---|---|---:|
| 1 | http://192.168.1.40 | 1 | 546 |
| 1 | http://192.168.1.40 | 2 | 615 |
| 2 | http://192.168.1.71 | 1 | 528 |
| 2 | http://192.168.1.71 | 2 | 668 |

Totals: controller 1 **1,161**; controller 2 **1,196**; combined **2,357** pixels.

String numbers are the owner's labels. Do not infer contiguous ranges or output numbering from owner counts alone. Read-only bus configuration below independently reports contiguous logical ranges, but physical output-to-string assignment, pixel order and cabinet/drawer wiring remain unconfirmed.

## Read-only discovery (2026-10-18)

Queried only `http://192.168.1.40` and `http://192.168.1.71`, using Python `urllib.request.urlopen(..., timeout=2)`, with `GET /json/info`, `GET /json/state`, and `GET /json/cfg`. All three endpoints returned valid JSON from both controllers. The `/json/cfg` responses were parsed in memory; only whitelisted LED bus fields were emitted/recorded, and raw responses were not retained.

| Controller | Reachability / version | Reported LED count | Current reported segment |
|---|---|---:|---|
| 1 (`192.168.1.40`) | Online; WLED 16.0.1 | 1,161 | Segment 0: start 0, stop 1,161 (exclusive), length 1,161; enabled |
| 2 (`192.168.1.71`) | Online; WLED 16.0.1 | 1,196 | Segment 0: start 0, stop 1,196 (exclusive), length 1,196; enabled |

The device-reported totals match the owner-reported controller totals (1,161 and 1,196); no total-count mismatch was observed. The state response reports one segment spanning the full logical index range on each controller. Current reported master brightness is 128 on both; this is a read-only observation, not a test setting.

The sanitized `hw.led.ins` configuration contained two buses per controller:

| Controller | Bus entry order | Start | Length | Exclusive stop | Owner-count match |
|---|---:|---:|---:|---:|---|
| 1 (`192.168.1.40`) | 1 | 0 | 546 | 546 | Owner string 1 count (546) |
| 1 (`192.168.1.40`) | 2 | 546 | 615 | 1,161 | Owner string 2 count (615) |
| 2 (`192.168.1.71`) | 1 | 0 | 528 | 528 | Owner string 1 count (528) |
| 2 (`192.168.1.71`) | 2 | 528 | 668 | 1,196 | Owner string 2 count (668) |

For all four bus entries, the sanitized response reported `type=22`, `order=0`, `rev=false`, `skip=0`, `freq=0`, and `ref=false`; no `pin` field was present. The two bus lengths on each device sum exactly to its reported total, and each length exactly matches one owner's string count. Thus the **configuration-based logical index candidates** are controller 1 string-count 546: `[0,546)`, count 615: `[546,1161)`; controller 2 count 528: `[0,528)`, count 668: `[528,1196)`. These are verified configured bus ranges and count matches, not verification that owner string labels identify those physical outputs or that physical pixel order/wiring matches them. Keep physical string-to-bus assignment and illumination **unverified**; do not claim physical mapping from matching lengths alone.

## Verification status

Device connectivity, WLED version, reported totals, logical segment bounds and configured bus ranges are verified by HTTP responses. The physical identity/route of the owner-named strings, optical output, and physical pixel direction remain **unverified**: no camera/observer evidence was captured. Runtime acknowledgements prove that commands were applied by the active backend/worker, not what a person would see.

### Historical read-only discovery and superseding live results (2026-10-18 UTC)

The discovery above was read-only **at the time it was performed**. It remains valid as historical configuration evidence, but its “read-only only / no test attempted” acceptance conclusion is superseded by the later Checkpoint 002J-D live results below. Timestamps in this section use UTC timestamps in the evidence, not the host operating-system date.

The eight-boundary run issued real HTTP requests through the application with the qcluster worker active. Each test successfully reached the active runtime state at brightness 8, RGB `(255, 0, 0)`, for 2 seconds; service stop was confirmed for each. The chosen singleton logical indices test each bus's first and last logical pixel, with one-based logical numbering and zero-based WLED indices:

| Controller | Bus | Tested logical pixel (one-based) | WLED pixel index | Exact WLED interval `[start, stop)` | Result |
|---|---:|---:|---:|---:|---|
| 1 | 1 | 1 | 0 | `[0, 1)` | Active, then stop confirmed |
| 1 | 1 | 546 | 545 | `[545, 546)` | Active, then stop confirmed |
| 1 | 2 | 547 | 546 | `[546, 547)` | Active, then stop confirmed |
| 1 | 2 | 1161 | 1160 | `[1160, 1161)` | Active, then stop confirmed |
| 2 | 1 | 1162 | 0 | `[0, 1)` | Active, then stop confirmed |
| 2 | 1 | 1689 | 527 | `[527, 528)` | Active, then stop confirmed |
| 2 | 2 | 1690 | 528 | `[528, 529)` | Active, then stop confirmed |
| 2 | 2 | 2357 | 1195 | `[1195, 1196)` | Active, then stop confirmed |

Runtime acknowledgements in the evidence span **2026-10-18 13:44:24–13:44:53 UTC**. The service stop action is a clear/off operation; it does **not** restore the pre-test captured runtime state.

A separate explicit commissioning capture/restore step then ran. The two controllers' captured runtime fields were restored and read back as confirmed: master on/brightness, segment bounds/on/brightness, black RGB channels, effects and controls, nightlight state, and unfrozen state. Persistent configuration hashes were unchanged for both controllers. No persistent WLED configuration was written. This explicit restore must not be conflated with service stop: service stop leaves output off/black/unfrozen, while the separate commissioning restoration returns the captured runtime fields.

Later live location runs used brightness 8, green RGB `(0, 24, 0)`, duration 2 seconds. Drawer targeting and bin-native-location targeting both reached `active` and were then stopped. Bin targeting used the native location target (the bin's location); the API does not support a direct `kind=bin` target. These are backend/runtime results only and do not verify which physical drawer/bin/string lit.

No owner-permission blocker remained for these controlled tests. Do not interpret this as optical or physical-string verification.

### Remaining physical observation

When an observer/camera is available, confirm and record the physical string identity/route and whether pixel order is forward or reversed for each bus. Until then, physical string-to-bus assignment, visible colour, and direction remain **pending optical observation**. Do not infer them from HTTP success, runtime acknowledgements, matching counts, or bus order alone.

Never record credentials, tokens, SSIDs, MAC addresses, raw device configuration, or raw configuration hashes in this document.
