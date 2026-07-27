const assert = require('node:assert/strict');
const test = require('node:test');

const autoSync = require('./auto-sync');

const {
  buildResultMonitorPayload,
  recordResultLedgerObservation,
  registerResultLedgerEventBoard,
} = autoSync.__test;

const {
  classifyBrowserErrorPage,
  createBrowserErrorConfirmationState,
  detectBrowserErrorPage,
  inspectPageState,
} = autoSync;

function fakeLocator(text = '') {
  return {
    innerText: async () => text,
    first() {
      return this;
    },
    filter() {
      return this;
    },
    isVisible: async () => false,
  };
}

function fakePage({ url, title = '', bodyText = '', evaluateThrows = true }) {
  return {
    url: () => url,
    title: async () => title,
    isClosed: () => false,
    locator: () => fakeLocator(bodyText),
    getByText: () => fakeLocator(bodyText),
    evaluate: async () => {
      if (evaluateThrows) throw new Error('dom unavailable');
      return {
        url,
        authenticationTextVisible: false,
        authenticatedContentVisible: true,
        textSample: bodyText,
      };
    },
  };
}

test('detects about:neterror', async () => {
  const result = await detectBrowserErrorPage(fakePage({
    url: 'about:neterror?e=dnsNotFound&u=https%3A//globalbet.virtual-horizon.com/',
    title: 'Server Not Found',
    bodyText: 'Server Not Found',
  }));

  assert.equal(result.detected, true);
  assert.equal(result.type, 'neterror');
});

test('detects about:certerror', async () => {
  const result = await detectBrowserErrorPage(fakePage({
    url: 'about:certerror?e=nssBadCert',
    title: 'Secure Connection Failed',
    bodyText: 'Secure Connection Failed',
  }));

  assert.equal(result.detected, true);
  assert.equal(result.type, 'certerror');
});

test('does not detect Horizon URL', () => {
  const result = classifyBrowserErrorPage({
    url: 'https://globalbet.virtual-horizon.com/client/shop.jsp',
    title: 'Virtual Horizon',
    bodyText: 'BALANCE FOOTBALL LEAGUE WEEK',
  });

  assert.equal(result.detected, false);
});

test('does not detect about:blank', () => {
  const result = classifyBrowserErrorPage({
    url: 'about:blank',
    title: '',
    bodyText: '',
  });

  assert.equal(result.detected, false);
});

test('confirmation timer prevents immediate restart', () => {
  const confirmation = createBrowserErrorConfirmationState(30_000);
  const first = confirmation.observe({
    detected: true,
    type: 'neterror',
    url: 'about:neterror?e=dnsNotFound',
    title: 'Server Not Found',
  }, 1000);
  const later = confirmation.observe({
    detected: true,
    type: 'neterror',
    url: 'about:neterror?e=dnsNotFound',
    title: 'Server Not Found',
  }, 20_000);

  assert.equal(first.confirmed, false);
  assert.equal(later.confirmed, false);
});

test('persistent error causes exactly one guarded restart', () => {
  const confirmation = createBrowserErrorConfirmationState(30_000);
  let restartRequested = false;
  let restarts = 0;
  const requestRestart = () => {
    if (restartRequested) return false;
    restartRequested = true;
    restarts += 1;
    return true;
  };
  const error = {
    detected: true,
    type: 'neterror',
    url: 'about:neterror?e=dnsNotFound',
    title: 'Server Not Found',
  };

  assert.equal(confirmation.observe(error, 1000).confirmed, false);
  if (confirmation.observe(error, 31_000).confirmed) requestRestart();
  if (confirmation.observe(error, 45_000).confirmed) requestRestart();

  assert.equal(restarts, 1);
});

test('successful provider response clears the error state', () => {
  const confirmation = createBrowserErrorConfirmationState(30_000);
  const error = {
    detected: true,
    type: 'neterror',
    url: 'about:neterror?e=dnsNotFound',
    title: 'Server Not Found',
  };

  assert.equal(confirmation.observe(error, 1000).detected, true);
  confirmation.clear();
  assert.equal(confirmation.observe(error, 20_000).confirmed, false);
});

test('error page is never classified as authenticated', async () => {
  const state = await inspectPageState(fakePage({
    url: 'about:neterror?e=dnsNotFound',
    title: 'Problem loading page',
    bodyText: 'Server Not Found BALANCE FOOTBALL LEAGUE WEEK',
    evaluateThrows: false,
  }));

  assert.equal(state.browserErrorPage, true);
  assert.equal(state.authenticatedApp, false);
  assert.equal(state.loginPage, false);
});

test('result monitor payload uses matched board leagueNumber and preserves leagueId', () => {
  const providerEventId = 'result-event-9485';
  const packet = {
    providerEventId,
    resultsPayload: {
      provider: 'VirtualHorizon',
      source: 'event-detail-results',
      providerEventId,
      leagueId: '21',
      leagueNumber: '21',
      leagueName: 'Football League',
      eventType: 'RESULTS',
      matches: Array.from({ length: 10 }, (_, index) => ({
        index: index + 1,
        providerMatchId: `match-${index + 1}`,
        home: `Home ${index + 1}`,
        away: `Away ${index + 1}`,
        teams: `Home ${index + 1} vs Away ${index + 1}`,
        hasScore: true,
        homeScore: index,
        awayScore: index + 1,
        resultCode: null,
      })),
    },
  };

  registerResultLedgerEventBoard({
    providerEventId,
    leagueId: '21',
    leagueNumber: '9485',
    leagueName: 'Football League',
    weekNumber: '7',
    firstMatch: 'Home 1 vs Away 1',
    events: Array.from({ length: 10 }, (_, index) => ({
      leagueId: '21',
      leagueNumber: '9485',
      matchId: `match-${index + 1}`,
    })),
  });

const monitorPayload = buildResultMonitorPayload(packet);
const observation = recordResultLedgerObservation(
  packet,
  monitorPayload,
);

assert.equal(observation.isComplete, true);

  assert.equal(packet.resultsPayload.leagueId, '21');
  assert.equal(packet.resultsPayload.leagueNumber, '9485');
  assert.equal(monitorPayload.leagueId, '21');
  assert.equal(monitorPayload.leagueNumber, '9485');
  assert.equal(monitorPayload.matches.length, 10);
  assert.equal(new Set(monitorPayload.matches.map((match) => match.providerMatchId)).size, 10);
});
