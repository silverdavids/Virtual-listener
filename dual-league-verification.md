Checkpoint reconciliation — September 22, 2026. The capture and 32-test results
below are historical observations from the earlier dual-league pass, not current
production verification. The current source retains provider order as described
below. Live-state persistence and diagnostic authentication are documented in
README.md. Excluded `data/` evidence is local and unavailable in a fresh checkout.

This verification pass is scoped to `virtual-scraper`. The already updated
`Virtual-Api` repository was read only to confirm request contracts. No API or
display files were changed in this pass. The SQL migration was not executed,
validated again, or deployed.

**Scraper root cause**

The original response listener captured feeds but used a single latest board and
posting state, then gated posting against the one visible fixture list. That
allowed an off-screen league's data to be ignored or overwritten downstream.
Competition identity could also be replaced with the season number, queue imports
defaulted to league `21`, and results were tracked by event ID alone. Explicit
requests using only cookies failed because native provider feeds use an
Authorization header.

The follow-up audit also found that a single polling lock covered both leagues
and all pending results. Slow requests could therefore suppress timely monitoring
of the other league. This pass replaces that lock with independent scheduling and
rejects stale responses across re-login.

**Capture and state isolation**

- After login warm-up, authenticated requests explicitly visit the provider feed
  URLs for Champions (`21`) and EPL (`78`). No positional menu selectors are used.
  The native Authorization header stays in memory and is sent only on the provider
  origin.
- Passive captures, including feeds without a league query parameter, enter the
  same per-league processing path. Payload identity is checked against an explicit
  requested league; mixed captures are grouped by their payload league IDs.
- Current-board selection retains the current league-qualified identity while
  eligible, then appends remaining eligible boards in provider order. Recovery
  selects the first eligible provider board, never sorts by week or start time.
  Complete scored results, a valid explicit finish time later than start, or
  provider replacement permit rollover. Kickoff, countdown zero and compact `e`
  alone do not retire a board. Repeated weeks with distinct event IDs survive.
- Each league has its own board map, current board, capture ordering, serialized
  import queue, queue hash, posted-event deduplication, and posting metadata.
  Board and result-ledger keys include `(leagueId, providerEventId)`.
- Each league independently schedules feed refresh and result polling every five
  seconds. Each has separate deadlines and in-flight request tracking for these
  two operations. Slow Champions requests do not block EPL, and results do not
  block feed refresh. Results polling rotates through at most five pending events
  per league per pass, oldest-polled first.
- Browser restart creates monitoring for both leagues. Re-login invalidates old
  request generations and resets both schedules. Late responses cannot update
  the new session. The process-level result ledger is not cleared by league
  refresh, re-login, or browser restart. It remains in memory and is not durable
  across termination of the Node process.
- Existing market mapping, canonical validation, timing helpers, browser health,
  authentication, and retry functions remain in use. A DOM-specific compatibility
  view supplies the visible-board scheduler without owning off-screen feeds.

**Confirmed API contract**

Endpoint URLs and shapes remain unchanged. Current boards contain `events[]`;
queue imports contain `provider`, `source`, `leagueId`, `capturedAt`, and `boards[]`.
Each queue board includes `providerEventId`, `weekNumber`, `firstMatch`, `startAt`,
`endAt`, `nextRefreshAt`, and `matches[]`. Results include `providerEventId`,
`leagueId`, and matches with `providerMatchId`, `home`, `away`, `homeScore`, and
`awayScore`.

`leagueId` and `providerLeagueId` identify competition `"21"` or `"78"`;
`leagueNumber` is separate season metadata. Queue requests contain one league.
No demonstrable contract incompatibility requiring an API change was found.

**Files**

This follow-up changes `auto-sync.js`, `league-monitor.js`,
`test-league-monitor.js`, `README.md`, and this report. Existing scraper changes
from the earlier implementation remain in `live-scrape.js`, `scrape-event.js`, and
`.gitignore`; diagnostic commands fetch both leagues and use league-prefixed
detail filenames. Earlier API changes are left untouched.

**Tests and live evidence**

`npm test`: 32 tests passed. These cover parser identity, mixed feeds, independent
queues, overlapping event IDs, duplicate concurrent captures, failed import
retries, result isolation, current-board selection, blocked-request scheduling,
warm-up, re-login invalidation, and real posting functions exercised with mocked
HTTP responses at all three endpoints. Syntax validation passed. The sandbox
blocked Node test workers with `spawn EPERM`; the approved rerun passed.

A new bounded fresh-login run captured both competitions and independently posted
current boards and queues to the API configured in `.env`. Actual log excerpts:

```text
LEAGUE-DISCOVERED name=Champions league=21
LEAGUE-DISCOVERED name=EPL league=78
QUEUE-IMPORT-POSTED league=78 boardCount=3
QUEUE-IMPORT-POSTED league=21 boardCount=6
VIRTUAL-API-POSTED league=78 providerEventId=780394550 source=feed-events-passive week=7 firstMatch=CRY vs WOL
VIRTUAL-API-POSTED league=21 providerEventId=780392602 source=feed-events-passive week=36 firstMatch=FCB vs LIV
```

The local live-run log is `data/dual-league-scoped-verification.log` (gitignored).
HTTP import acceptance is distinct from successful asynchronous SQL persistence.

**Waiting on SQL migration / remaining live checks**

The migration remains undeployed, as instructed. Durable simultaneous current-board
identity and successful result persistence must be rechecked after its separate
deployment. An earlier live run received `409: Board was not found` for a complete
result packet; no claim is made that this scraper-only pass fixes that server-side
condition. Failed result imports stay tracked under the existing retry limits.

Successful result posts for both leagues are verified using mocked HTTP responses.
The bounded live check does not establish completed result delivery for both
leagues or an actual crash/re-login cycle; recovery scheduling and state isolation
are covered by the automated tests.
