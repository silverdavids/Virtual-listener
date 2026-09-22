Historical verification report — September 11, 2026.

This records that day's code, test counts and deployment observations, not the
current deployed status. Links under `data/` reference excluded local evidence:
they are unavailable in a fresh checkout and are non-portable. Raw captures and
implementation copies are intentionally not part of the source checkpoint.

Implemented current-event retention and verified both start-time retention and result-driven rollover.

Scraper changes:

- `league-monitor.js` keeps the current league-qualified event identity while it remains eligible, puts it first, and appends other eligible boards in provider order. Only repeated `(leagueId, providerEventId)` identities are deduplicated; repeated weeks and season wrap survive.
- Started events remain eligible. Generic provider `e`, equal `d/e`, countdown zero and estimated durations cannot expire them. Explicit `finishTime`/`endTime` is used only when valid and strictly later than the event start. Complete scored results use the existing ledger's `resultsReceivedAt` marker; SQL import success is not required. Provider removal with next-board promotion also retires the previous identity.
- Each league independently tracks retired identities, queue contents, ordering and current-board posting. Requests are ordered when initiated, rather than by response completion time, with existing session-epoch checks retained. A late older request cannot overwrite a newer response.
- Board/POST/response diagnostics expose event identities, week order, fixture count and acceptance without credentials.

Validation:

- Complete scraper suite: **40 passed**, zero failures. Tests include retention after start, ambiguous timing, complete versus partial scored results, rollover, 38-to-1 wrap, duplicate weeks versus event IDs, league isolation, late network responses, re-login invalidation, fresh-browser recovery, serialized POST order and ten fixtures per board.
- Syntax checks and `git diff --check` passed.
- Two bounded live captures completed and their browser processes closed. The second capture spans start boundaries and actual result-driven rollover.

Live boundary evidence (2026-09-11, UTC):

| League | POST capture | Current event | Current start | Serialized weeks | Response |
|---|---|---|---|---|---|
| 78 EPL | 10:44:10.655 | 782365587 | 10:44:07 | 3,4,5,6 | 200, success=true, 40 fixtures |
| 21 Champions | 10:44:41.918 | 782364069 | 10:44:37 | 2,3,3,4,4,5,5 | 200, success=true, 70 fixtures |
| 78 EPL | 10:45:41.103 | 782367127 | 10:49:37 | 4,5,6 | 200, success=true, 30 fixtures |
| 21 Champions | 10:45:45.712 | 782362665 | 10:46:37 | 3,3,4,4,5,5 | 200, success=true, 60 fixtures |

The first two POSTs retain their current board after startAt/endAt have passed. The later two promote only after the result ledger reports ten expected scored fixtures for the preceding event. Provider responses still included those completed boards, so the live capture also verifies result-based exclusion. The historical 37,38,1,2 example is covered by regression tests; the live provider had advanced to the weeks above.

Exact serialized bodies, HTTP responses, both leagues' GET readbacks, and per-board tables (including startAt/endAt, current and queuePosition) are in [boundary evidence](data/queue-fix-boundary/evidence.md). Initial live evidence is in [first capture](data/queue-fix-live/evidence.md). The source log is `data/queue-fix-boundary.log`.

An additional API defect was proven during this validation. Before start, remote readbacks matched. After start, the remote API accepted the full corrected POST but omitted its active board: POST 16 sent EPL 3,4,5,6 and GET returned 4,5,6; POST 29 sent Champions 2,3,3,4,4,5,5 and GET omitted week 2. My intermediate statement that EPL's post-start readback matched was incorrect; the detailed comparison identified and corrected that claim.

Under the user's conditional authorization, the sibling `Virtual-Api/services/virtualEventStore.js` was updated after filesystem approval. Virtual Horizon `feed-events-queue` imports now honor position zero from the scraper and are not advanced by the API's display-timing scheduler. Other queue sources retain their existing rotation behavior. This also restores an active event if an earlier API version had already advanced past it. No display files changed. The existing timing fields remain available to display consumers; the change concerns queue ownership and rotation.

API validation:

- Full API `npm test` passed (display transforms, lifecycle contracts, league isolation).
- New `scripts/test-provider-managed-queue.js` passed: restoration of prematurely advanced state, timer retention, exact fixtures, repeated weeks, wrap and independent rollover.
- All **eight** captured wire bodies were replayed over local HTTP through the corrected API's actual routers, controller, validation, conversion, store and GET route. A future scheduler tick was forced before each GET. Every readback matched league ID, providerEventId, week, fixture count and order. See [local replay results](data/queue-api-local-replay.json). Only SQL persistence and snapshot disk writes were stubbed; this does not establish database persistence.

The remote API has **not been deployed** with the local API fix. Its captured post-start mismatches remain evidence of the old deployed behavior, not successful remote end-to-end verification. Deployment and a fresh remote readback are still needed to establish that the live service preserves the corrected queues. No remote deployment or SQL migration was performed.
