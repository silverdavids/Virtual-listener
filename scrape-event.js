const { firefox } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const AUTH_FILE = 'auth.json';
const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const EVENTS_URL = 'https://globalbet.virtual-horizon.com/engine/shop/feed/events?locale=en_US&gameType=FOOTBALL_LEAGUE&leagueId=21';
const EVENT_DETAIL_URL = 'https://globalbet.virtual-horizon.com/engine/shop/feed/event';
const DATA_DIR = 'data';
const EVENTS_FILE = path.join(DATA_DIR, 'events-football-league-21.json');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const WAIT_AFTER_LOAD_MS = 30_000;

function normalizeEventId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 999) {
    return String(value);
  }

  if (typeof value === 'string' && /^\d{4,}$/.test(value)) {
    return value;
  }

  return null;
}

function isLikelyEventObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const eventKeys = [
    'eventId',
    'eventName',
    'startTime',
    'eventTime',
    'kickoffTime',
    'competitors',
    'homeCompetitor',
    'awayCompetitor',
    'markets',
  ];

  return eventKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function extractEventIds(payload) {
  const eventIds = new Set();

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const explicitEventId = normalizeEventId(value.eventId);
    if (explicitEventId) {
      eventIds.add(explicitEventId);
    }

    const objectId = normalizeEventId(value.id);
    if (objectId && isLikelyEventObject(value)) {
      eventIds.add(objectId);
    }

    for (const [key, child] of Object.entries(value)) {
      const keyEventId = normalizeEventId(key);
      if (keyEventId && isLikelyEventObject(child)) {
        eventIds.add(keyEventId);
      }

      visit(child);
    }
  }

  visit(payload);
  return [...eventIds];
}

function logNonOkResponse(label, response) {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  console.log(`${label} non-200 body preview:`);
  console.log(response.body.slice(0, 500));
}

async function fetchFromPage(page, url) {
  const response = await page.evaluate(async (requestUrl) => {
    const fetchResponse = await fetch(requestUrl, {
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
      },
    });

    return {
      status: fetchResponse.status,
      contentType: fetchResponse.headers.get('content-type'),
      body: await fetchResponse.text(),
    };
  }, url);

  try {
    return {
      ...response,
      json: JSON.parse(response.body),
    };
  } catch {
    throw new Error(`Expected JSON from ${url}, but received HTTP ${response.status}. Body: ${response.body.slice(0, 500)}`);
  }
}

async function main() {
  await fs.access(AUTH_FILE).catch(() => {
    throw new Error(`Missing ${AUTH_FILE}. Run "npm run login" first.`);
  });

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(EVENTS_DIR, { recursive: true });

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  try {
    await page.goto(SHOP_URL, { waitUntil: 'load' });
    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);

    const eventsResponse = await fetchFromPage(page, EVENTS_URL);
    logNonOkResponse('Events list', eventsResponse);
    await fs.writeFile(EVENTS_FILE, `${JSON.stringify(eventsResponse.json, null, 2)}\n`, 'utf8');

    const eventIds = extractEventIds(eventsResponse.json);
    console.log(`Events list HTTP ${eventsResponse.status}`);
    console.log(`Events found: ${eventIds.length}`);

    for (const eventId of eventIds) {
      const detailUrl = `${EVENT_DETAIL_URL}/${eventId}?locale=en_US`;
      const detailResponse = await fetchFromPage(page, detailUrl);
      const detailFile = path.join(EVENTS_DIR, `${eventId}.json`);

      logNonOkResponse(`Event ${eventId}`, detailResponse);
      await fs.writeFile(detailFile, `${JSON.stringify(detailResponse.json, null, 2)}\n`, 'utf8');
      console.log(`Fetched event ${eventId}: HTTP ${detailResponse.status}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
