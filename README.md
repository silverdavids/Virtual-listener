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
- uses `/engine/shop/feed/events` only for startup bootstrap and recovery refreshes
- normalizes it to canonical platform events
- posts to `POST /api/provider-imports/virtual-horizon/events`
- posts the full `/feed/events` queue to `POST /api/provider-imports/virtual-horizon/feed-events-queue`

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

## Notes

- Credentials are never hardcoded.
- `auth.json` is ignored by Git and should remain local.
- Scraped response files under `data/` are ignored by Git.
# Virtual-listener
