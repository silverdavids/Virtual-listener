const { firefox } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LEAGUES } = require('./league-monitor');
const { createProviderFeedClient } = require('./provider-feed-client');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const EVENTS_URL = 'https://globalbet.virtual-horizon.com/engine/shop/feed/events?locale=en_US&gameType=FOOTBALL_LEAGUE';
const EVENT_DETAIL_URL = 'https://globalbet.virtual-horizon.com/engine/shop/feed/event';
const DATA_DIR = 'data';
const EVENTS_DIR = path.join(DATA_DIR, 'events');

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

async function scrapeEvents(client) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(EVENTS_DIR, { recursive: true });

  for (const league of LEAGUES) {
    const eventsResponse = await client.fetch(`${EVENTS_URL}&leagueId=${league.id}`);
    const EVENTS_FILE = path.join(DATA_DIR, `events-football-league-${league.id}.json`);
    await fs.writeFile(EVENTS_FILE, `${JSON.stringify(eventsResponse.json, null, 2)}\n`, 'utf8');

    const eventIds = [...new Set([...extractEventIds(eventsResponse.json), ...Object.values(eventsResponse.json.events ?? {}).map(board => board.a).filter(Boolean)])];
    console.log(`Events list HTTP ${eventsResponse.status}`);
    console.log(`Events found: ${eventIds.length}`);

    for (const eventId of eventIds) {
      const detailUrl = `${EVENT_DETAIL_URL}/${eventId}?locale=en_US&leagueId=${league.id}`;
      const detailResponse = await client.fetch(detailUrl);
      const detailFile = path.join(EVENTS_DIR, `${league.id}-${eventId}.json`);

      await fs.writeFile(detailFile, `${JSON.stringify(detailResponse.json, null, 2)}\n`, 'utf8');
      console.log(`Fetched event ${eventId}: HTTP ${detailResponse.status}`);
    }
  }
}

async function main() {
  const browser = await firefox.launch({ headless: false });
  const page = await browser.newPage();
  const client = createProviderFeedClient(page);
  const rl = readline.createInterface({ input, output });

  try {
    await page.goto(SHOP_URL, { waitUntil: 'load' });

    await rl.question('Log in manually in the Firefox window, then press ENTER here to start scraping.');
    await scrapeEvents(client);
    await rl.question('Scrape finished. Press ENTER here to close the browser.');
  } finally {
    rl.close();
    client.dispose();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
