const fs = require('node:fs/promises');
const path = require('node:path');
const { getCanonicalMarketCode } = require('./providers/virtualhorizon/market-map');

const INPUT_FILE = path.join('data', 'normalized-events.json');
const OUTPUT_FILE = path.join('data', 'canonical-events.json');
const PROVIDER = 'VirtualHorizon';
const SPORT = 'FOOTBALL';

function normalizeSelectionName(name) {
  if (name === 'HOME') {
    return 'Home';
  }

  if (name === 'AWAY') {
    return 'Away';
  }

  if (name === 'DRAW') {
    return 'Draw';
  }

  return name;
}

function toIsoTime(timestamp) {
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapMarket(market) {
  return {
    code: getCanonicalMarketCode(market.marketName),
    name: market.marketName,
    selections: (market.selections ?? []).map((selection) => ({
      name: normalizeSelectionName(selection.name),
      odd: selection.odd,
    })),
  };
}

function mapEvent(event) {
  return {
    provider: PROVIDER,
    providerEventId: String(event.eventId),
    sport: SPORT,
    leagueId: event.leagueId,
    leagueName: event.leagueName,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    startTime: toIsoTime(event.startTime),
    markets: (event.markets ?? []).map(mapMarket),
  };
}

async function main() {
  const normalizedEvents = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));
  const canonicalEvents = normalizedEvents.map(mapEvent);

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(canonicalEvents, null, 2)}\n`, 'utf8');

  console.log(`mapped events: ${canonicalEvents.length}`);
  console.log(`saved: ${OUTPUT_FILE}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  mapEvent,
  mapMarket,
  normalizeSelectionName,
  toIsoTime,
};
