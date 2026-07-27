const fs = require('node:fs/promises');
const path = require('node:path');
const { getCanonicalMarketCode } = require('./providers/virtualhorizon/market-map');
const { normalizeProviderTimestamp } = require('./provider-timestamp');

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
  return normalizeProviderTimestamp(timestamp);
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

function mapEvent(event, context = {}) {
  const providerMatchId = String(event.eventId);
  const startTime = normalizeProviderTimestamp(event.startTime, {
    providerEventId: context.providerEventId || event.providerEventId,
    providerMatchId,
  });

  if (!startTime) {
    console.error('[virtual-horizon] invalid event startTime', {
      providerEventId: context.providerEventId || event.providerEventId,
      providerMatchId,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      rawStartTime: event.startTime,
      rawStartTimeType: event.startTime instanceof Date
        ? 'Date'
        : typeof event.startTime,
      sourceField: event.startTimeSourceField,
      availableCandidateTimestampFields: event.availableCandidateTimestampFields,
    });
  }

  return {
    provider: PROVIDER,
    providerEventId: String(event.eventId),
    providerMatchId,
    sport: SPORT,
    leagueId: event.leagueId,
    leagueName: event.leagueName,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    startTime,
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
