const fs = require('node:fs/promises');
const path = require('node:path');

const INPUT_FILE = path.join('data', 'all-network.json');
const OUTPUT_FILE = path.join('data', 'normalized-events.json');
const FEED_URL_MARKER = '/engine/shop/feed/events';

function parseJsonBody(response) {
  const body = response.body ?? response.bodyPreview;

  if (!body) {
    throw new Error(`Feed response has no body: ${response.url}`);
  }

  return JSON.parse(body);
}

function findFeedResponse(networkEntries) {
  return networkEntries.find((entry) => entry.url && entry.url.includes(FEED_URL_MARKER));
}

function values(object) {
  if (!object || typeof object !== 'object') {
    return [];
  }

  return Array.isArray(object) ? object : Object.values(object);
}

function getLeague(feedEvent, fixture) {
  return fixture?.i?.a?.a ?? feedEvent?.f?.b?.a?.a ?? feedEvent?.league ?? {};
}

function getTeams(fixture) {
  const teams = fixture?.i?.a?.b ?? fixture?.teams ?? {};
  return {
    homeTeam: teams?.a?.a ?? teams?.home?.name ?? null,
    awayTeam: teams?.b?.a ?? teams?.away?.name ?? null,
  };
}

function normalizeMarkets(fixture) {
  const markets = fixture?.i?.a?.c ?? fixture?.i?.c ?? fixture?.markets ?? {};

  return values(markets)
    .filter((market) => market && typeof market === 'object')
    .map((market) => ({
      marketName: market.a ?? market.name ?? null,
      selections: values(market.b ?? market.selections)
        .filter((selection) => selection && typeof selection === 'object')
        .map((selection) => ({
          name: selection.a ?? selection.name ?? null,
          odd: selection.b ?? selection.odd ?? null,
        })),
    }))
    .filter((market) => market.marketName || market.selections.length > 0);
}

function getFixtures(feedEvent) {
  const container = feedEvent?.f?.b?.c?.c ?? feedEvent?.f?.b?.c ?? feedEvent?.events ?? feedEvent?.fixtures ?? [];

  return values(container)
    .map((item) => item?.b ?? item)
    .filter((fixture) => fixture && typeof fixture === 'object');
}

function normalizeEvent(feedEvent, fixture) {
  const league = getLeague(feedEvent, fixture);
  const { homeTeam, awayTeam } = getTeams(fixture);

  return {
    eventId: fixture.a ?? fixture.eventId ?? fixture.id ?? null,
    leagueId: league.d ?? league.id ?? null,
    leagueName: league.a ?? league.name ?? null,
    homeTeam,
    awayTeam,
    startTime: fixture.f ?? fixture.startTime ?? null,
    markets: normalizeMarkets(fixture),
  };
}

async function main() {
  const networkEntries = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));
  const feedResponse = findFeedResponse(networkEntries);

  if (!feedResponse) {
    throw new Error(`No response URL contains ${FEED_URL_MARKER}`);
  }

  const feed = parseJsonBody(feedResponse);
  const normalizedEvents = values(feed.events)
    .flatMap((feedEvent) => getFixtures(feedEvent).map((fixture) => normalizeEvent(feedEvent, fixture)));

  const firstEvent = normalizedEvents[0] ?? {};

  console.log(`total events: ${normalizedEvents.length}`);
  console.log(`league id: ${firstEvent.leagueId ?? ''}`);
  console.log(`league name: ${firstEvent.leagueName ?? ''}`);
  console.log(`first event id: ${firstEvent.eventId ?? ''}`);
  console.log(`first home team: ${firstEvent.homeTeam ?? ''}`);
  console.log(`first away team: ${firstEvent.awayTeam ?? ''}`);

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(normalizedEvents, null, 2)}\n`, 'utf8');
  console.log(`saved: ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  FEED_URL_MARKER,
  findFeedResponse,
  parseJsonBody,
  normalizeEvent,
  normalizeMarkets,
  getFixtures,
  values,
};
