# Virtual Scraper

Scrape the authenticated event feed from GlobalBet Virtual Horizon using Playwright.

## Setup

```sh
npm install
npx playwright install firefox
```

## Usage

Log in manually and save your authenticated browser session:

```sh
npm run login
```

After the Firefox window opens, complete login in the browser. Return to the terminal and press ENTER to save the session to `auth.json`.

Scrape the event feed:

```sh
npm run scrape:event
```

The response is saved to `data/event-744503573.json` when it is valid JSON, otherwise to `data/event-744503573.txt`.

## Auto Sync Pipeline

Run this after the Virtual API is listening. The React display commonly runs on
`http://localhost:3001`; only set the API base URL to that display URL if that
same server exposes `/api/provider-imports/health` and
`/api/provider-imports/virtual-horizon/events`. The scraper also posts the full
`/feed/events` board queue to
`/api/provider-imports/virtual-horizon/feed-events-queue`, and monitor-only
results packets to `/api/provider-imports/virtual-horizon/results`.

For automatic login, set credentials in your shell or create a local `.env` from `.env.example`. Do not commit real credentials.

```powershell
$env:VH_USERNAME="your-username"
$env:VH_PASSWORD="your-password"
```

```powershell
$env:REACT_DISPLAY_URL="http://localhost:3001"
$env:VIRTUAL_API_BASE_URL="http://localhost:3000"
$env:PROVIDER_IMPORT_QUEUE_URL="http://localhost:3000/api/provider-imports/virtual-horizon/feed-events-queue"
$env:PROVIDER_IMPORT_RESULTS_URL="http://localhost:3000/api/provider-imports/virtual-horizon/results"
$env:SYNC_INTERVAL_SECONDS="30"
npm run auto:sync
```

Browser supervision is enabled by default. To test recovery manually, close Firefox,
temporarily block the Virtual Horizon host, freeze the page, clear its cookies, stop
the internal API, and press Ctrl+C in separate runs. Confirm that only one Firefox
exists, provider outages use the longer offline delay, API-only outages do not cause
an immediate browser restart, authentication loss creates a fresh session, and
Ctrl+C leaves no Firefox child process.

If `VH_USERNAME` and `VH_PASSWORD` are present, the script opens the login page, fills the username and password, submits LOGIN, waits for a shop DOM marker or authenticated balance/feed response, and starts syncing.

Set `FORCE_MANUAL_LOGIN=true` to skip automatic login even when credentials are present. If automatic login times out, the script logs whether an authentication error banner is visible and saves `data/login-failed.png` plus `data/login-failed.html`.

If either credential is missing, it falls back to manual login: the script opens Firefox, loads Virtual Horizon, and waits while you log in manually. After pressing ENTER, it keeps a realtime response listener attached:

- treats authenticated `/engine/shop/feed/event/{id}` responses as the primary realtime source
- explicitly polls `/engine/shop/feed/events` for Champions (`21`) and EPL (`78`) every five seconds after the startup warm-up, alongside passive response capture
- normalizes it to canonical platform events
- posts to `POST /api/provider-imports/virtual-horizon/events`
- posts the full `/feed/events` queue to `POST /api/provider-imports/virtual-horizon/feed-events-queue`

Both competitions are monitored independently of the visible provider menu. Explicit
requests reuse the native feed's Authorization header in memory, only on the
Virtual Horizon origin; cookies alone are insufficient. Browser restart performs
login and restores both polling lanes. Current boards retain their event identity
until completion or provider replacement; recovery starts from provider order.
Current-board imports, queue snapshots, ordering, and duplicate tracking are
isolated by competition. Pending results use `(leagueId, providerEventId)` keys
and survive menu changes, refreshes, and browser restarts within the running process.
They are not persisted across termination of the Node process.

Each league has independent feed and results polling deadlines and in-flight
request tracking. A slow results request cannot hold up either league's feed.
Each results pass polls at most five overdue events per league, oldest-polled
first. Re-login resets scheduling and invalidates responses from older sessions
without clearing the result ledger.

Queue selection retains the current `(leagueId, providerEventId)` after its start
time, then appends upcoming boards in provider order. Week numbers can wrap or
repeat and are never identity keys. A board leaves on complete scored results,
an explicit valid finish/end time later than its start, or provider replacement.
The provider's compact `e` field, equal `d/e` values, countdowns and estimated
durations are not treated as authoritative expiry. Network requests carry an
ordering token so an older response arriving late cannot replace newer state.
`QUEUE-BOARD-CAPTURED`, `QUEUE-POST-BODY` and `QUEUE-POST-RESPONSE` expose board
identity, order, fixture counts and HTTP acceptance for diagnostics.

The endpoint URLs are unchanged. `leagueId` now consistently means the provider
competition ID (`"21"` or `"78"`), including on individual fixtures and queue
boards. `leagueNumber` retains the provider season number; it must not be used as
the competition identifier. Queue requests contain exactly one league. The API
must upsert current boards, queues, and results by competition and event, and
scope replacement/deletion to the imported league. Displays should offer
`21 → Champions` and `78 → EPL`, filtering fixtures by the selected `leagueId`.
The companion `Virtual-Api` already supports this contract. Its SQL migration is
not deployed; migration execution and deployment are outside this scraper task.
See `dual-league-verification.md` for scraper verification and the database-dependent
checks that remain pending.

`npm test` includes interleaved leagues, overlapping event IDs, duplicate concurrent
responses, queue retries, result isolation, and all three posting endpoints using
mocked HTTP responses. Diagnostic scrape commands also fetch both leagues and save
detail files as `data/events/{leagueId}-{eventId}.json`.

At startup the script prints the React display URL, API import URL, and health
endpoint. If the health endpoint is not reachable, posting is blocked with:
`Virtual API not reachable. Start the API server or set VIRTUAL_API_BASE_URL correctly.`

Useful local commands:

```powershell
npm run inspect
npm run analyze:feed
npm run map:canonical
npm run auto:sync
```

## Live-state persistence and recovery

Start the production scraper with `npm run auto:sync`.
`VIRTUAL_API_BASE_URL` selects the API; live updates are posted to
`POST /api/provider-imports/virtual-horizon/live-state` on that base URL.
`VH_LIVE_STATE_FILE` overrides the default `data/provider-live-state.json` path
(relative overrides resolve from the working directory). The file retains the
provider timeline and league/event lifecycle needed after a process restart;
it is not a cookie jar or a results-import ledger. Champions `21` and EPL `78`
remain isolated by `(leagueId, providerEventId)` even when event IDs overlap.

A missing state file starts empty. Empty, malformed or structurally invalid
files are quarantined as `<state-file>.corrupt-<timestamp>-<unique-id>.bak`.
The entire ledger is validated before any entry is restored. Warnings contain
only paths and a fixed explanation, never state contents. If quarantine fails,
the process continues with empty in-memory state and disables disk persistence
until restart, preserving the original file for recovery. Resolve permissions
or move the invalid file before restarting. Backups are not automatically deleted.

Writes serialize and validate the complete ledger first, then exclusively create
a unique temporary file in the same directory, write, flush (`fsync`), close,
and rename over the primary. Failures preserve the previous primary and attempt
to remove only that write's temporary file. Windows sharing/rename failures do
not trigger deletion of the primary. Writes are synchronous within the process;
overlapping flush calls are suppressed. Run only one scraper process per state
file: separate processes have distinct temporary files but do not merge ledgers.
File flushing does not guarantee directory-entry durability after power loss.

All runtime data, captures, backups, logs and evidence are ignored. The required
reviewed test fixture is `test-fixtures/provider-progress.json`; it contains event
data without authentication headers, cookies or account fields.

## Diagnostic authentication

`npm run live:scrape` uses manual browser login; `npm run scrape:event` starts
with local `auth.json`. Both attach a listener before navigation and reuse the
Authorization header from a successful native provider feed response, matching
`auto-sync.js`. Cookies alone were insufficient in the earlier dual-league
verification. Headers stay in memory, are restricted to provider feed URLs on
the provider origin, and are cleared on navigation or HTTP 401/403. Redirects
are refused; errors never include response bodies or credentials. Without an
authenticated native feed the diagnostic request fails with a login instruction.
The helper is regression-tested; a fresh provider-authenticated diagnostic run
is not part of this checkpoint's validation.

## Notes

- Credentials are never hardcoded.
- `auth.json` is ignored by Git and should remain local.
- Scraped response files under `data/` are ignored by Git.
# Virtual-listener
