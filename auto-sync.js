const { firefox } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { getFixtures, normalizeEvent, values } = require('./analyze-feed');
const { mapEvent, toIsoTime } = require('./canonical-market-mapper');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile('.env');

const LOGIN_URL = 'https://globalbet.virtual-horizon.com/';
const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const VH_USERNAME = process.env.VH_USERNAME;
const VH_PASSWORD = process.env.VH_PASSWORD;
const FORCE_MANUAL_LOGIN = parseEnvBoolean(process.env.FORCE_MANUAL_LOGIN, false);
const TEST_BLOCK_FEED_EVENTS = parseEnvBoolean(process.env.TEST_BLOCK_FEED_EVENTS, false);
const LOG_ODDS_DETAILS = process.env.LOG_ODDS_DETAILS === 'true';
const LOG_RESULT_RAW_DUMP = process.env.LOG_RESULT_RAW_DUMP === 'true';
const LOG_RESULT_SUMMARY = process.env.LOG_RESULT_SUMMARY !== 'false';
const TRACE_NETWORK = parseEnvBoolean(process.env.TRACE_NETWORK, false);
const TRACE_TRANSITION = parseEnvBoolean(process.env.TRACE_TRANSITION, false);
const TRACE_TRANSITION_PROOF = parseEnvBoolean(process.env.TRACE_TRANSITION_PROOF, false);
const CAPTURE_RESULT_EVENT_DETAIL = parseEnvBoolean(process.env.CAPTURE_RESULT_EVENT_DETAIL, false);
const REACT_DISPLAY_URL = normalizeBaseUrl(process.env.REACT_DISPLAY_URL || process.env.VIRTUAL_DISPLAY_URL || 'http://localhost:3001');
const VIRTUAL_API_BASE_URL = normalizeBaseUrl(process.env.VIRTUAL_API_BASE_URL || process.env.VIRTUAL_API_URL || 'http://localhost:3000');
const PROVIDER_IMPORT_EVENTS_URL = `${VIRTUAL_API_BASE_URL}/api/provider-imports/virtual-horizon/events`;
const PROVIDER_IMPORT_QUEUE_URL = normalizeUrl(
  process.env.PROVIDER_IMPORT_QUEUE_URL,
  `${VIRTUAL_API_BASE_URL}/api/provider-imports/virtual-horizon/feed-events-queue`,
);
const PROVIDER_IMPORT_RESULTS_URL = normalizeUrl(
  process.env.PROVIDER_IMPORT_RESULTS_URL,
  `${VIRTUAL_API_BASE_URL}/api/provider-imports/virtual-horizon/results`,
);
const PROVIDER_IMPORT_HEALTH_URL = `${VIRTUAL_API_BASE_URL}/api/provider-imports/health`;
const CYCLE_POLL_SECONDS = Math.min(3, Math.max(2, parseEnvSeconds(process.env.CYCLE_POLL_SECONDS, 3)));
const FULL_FEED_REFRESH_SECONDS = parseEnvSeconds(process.env.FULL_FEED_REFRESH_SECONDS, 300);
const FEED_URL_MARKER = '/engine/shop/feed/events';
const EVENT_DETAIL_URL_MARKER = '/engine/shop/feed/event/';
const BALANCE_URL_MARKER = '/engine/shop/account/balance';
const LOGIN_TIMEOUT_MS = 30_000;
const STARTUP_EVENT_DETAIL_WAIT_MS = 20_000;
const TRANSITION_TEXT = 'NO MORE BETS, GAME IS KICKING OFF';
const SKIP_TO_NEXT_GAMES_TEXT = 'Skip to next games (Esc)';
const FEED_PATH = '/engine/shop/feed/events?locale=en_US&gameType=FOOTBALL_LEAGUE&leagueId=21';
const FEED_EVENTS_SOFT_REFRESH_MS = 30_000;
const FEED_EVENTS_INACTIVITY_RELOAD_MS = 120_000;
const STARTUP_FEED_WARMUP_MS = 3_000;
const DOM_TRANSITION_FEED_WAIT_MS = 2_000;
const FEED_REFRESH_NEAR_CYCLE_END_MS = 5_000;
const FEED_REFRESH_RETRY_MS = 8_000;
const DOM_REFRESH_FEED_WAIT_MS = 15_000;
const STARTUP_RESYNC_WINDOW_MS = 60_000;
const VISIBLE_COUNTDOWN_REFRESH_WINDOW_SECONDS = 8;
const VISIBLE_COUNTDOWN_MAX_WAIT_MS = 30_000;
const UI_SETTLE_AFTER_TRANSITION_MS = 3_000;
const VISIBLE_MATCH_CHANGE_TIMEOUT_MS = 10_000;
const EVENT_DETAIL_HEARTBEAT_STALE_MS = 120_000;
const PREVIOUS_CYCLE_RESULT_WATCH_MS = 120_000;
const MAX_CONSECUTIVE_FAILED_CYCLES = 3;
const POST_DOM_CHANGE_SETTLE_MS = 5_000;
const POST_DOM_CHANGE_MAX_RETRIES = 8;
const POST_DOM_CHANGE_RETRY_WAIT_MS = 5_000;
const DOM_CYCLE_WAIT_SECONDS = 10;
const CYCLE_ROLLOVER_DELAY_MS = 10_000;
const CYCLE_PASSIVE_FEED_WAIT_MS = 10_000;
const CYCLE_MISMATCH_RETRY_WAIT_MS = 5_000;
const TRANSITION_NETWORK_FILE = path.join('data', 'transition-network.json');
const FEED_EVENTS_SOURCE = 'feed-events-passive';
const VH_HEALTH_CHECK_INTERVAL_MS = parseEnvMilliseconds(process.env.VH_HEALTH_CHECK_INTERVAL_MS, 15_000);
const VH_EVENT_STALE_MS = parseEnvMilliseconds(process.env.VH_EVENT_STALE_MS, 90_000);
const VH_PAGE_STALE_MS = parseEnvMilliseconds(process.env.VH_PAGE_STALE_MS, 120_000);
const VH_RESTART_DELAY_MS = parseEnvMilliseconds(process.env.VH_RESTART_DELAY_MS, 8_000);
const VH_OFFLINE_RETRY_DELAY_MS = parseEnvMilliseconds(process.env.VH_OFFLINE_RETRY_DELAY_MS, 30_000);
const VH_MAX_CONSECUTIVE_FAILURES = parseEnvMilliseconds(process.env.VH_MAX_CONSECUTIVE_FAILURES, 3);
const VH_BROWSER_CLOSE_TIMEOUT_MS = parseEnvMilliseconds(process.env.VH_BROWSER_CLOSE_TIMEOUT_MS, 10_000);
const VH_HEALTH_OPERATION_TIMEOUT_MS = Math.min(VH_HEALTH_CHECK_INTERVAL_MS, 10_000);
const VH_NETWORK_OFFLINE_CONFIRM_MS = parseEnvMilliseconds(process.env.VH_NETWORK_OFFLINE_CONFIRM_MS, 120_000);
const VH_AUTH_FAILURE_CONFIRM_MS = parseEnvMilliseconds(process.env.VH_AUTH_FAILURE_CONFIRM_MS, 60_000);
const VH_AUTH_FAILURE_MIN_COUNT = parseEnvInteger(process.env.VH_AUTH_FAILURE_MIN_COUNT, 3);
const VH_RELOGIN_COOLDOWN_MS = parseEnvMilliseconds(process.env.VH_RELOGIN_COOLDOWN_MS, 180_000);
const VH_RESULT_GRACE_MS = parseEnvMilliseconds(process.env.VH_RESULT_GRACE_MS, 300_000);
const VH_RESULT_LEDGER_CHECK_MS = parseEnvMilliseconds(process.env.VH_RESULT_LEDGER_CHECK_MS, 30_000);
const VH_RESULT_LEDGER_RETENTION_MS = parseEnvMilliseconds(process.env.VH_RESULT_LEDGER_RETENTION_MS, 86_400_000);
const VH_RESULT_POST_RETRY_MS = parseEnvMilliseconds(process.env.VH_RESULT_POST_RETRY_MS, 60_000);
const VH_RESULT_POST_MAX_ATTEMPTS = parseEnvInteger(process.env.VH_RESULT_POST_MAX_ATTEMPTS, 10);
const VH_NETWORK_ERROR_RELOAD_MS = parseEnvMilliseconds(process.env.VH_NETWORK_ERROR_RELOAD_MS, 30_000);
const VH_NETWORK_ERROR_MAX_RELOADS = parseEnvInteger(process.env.VH_NETWORK_ERROR_MAX_RELOADS, 5);
const VH_NETWORK_ERROR_RESTART_AFTER_MS = parseEnvMilliseconds(process.env.VH_NETWORK_ERROR_RESTART_AFTER_MS, 600_000);
const VH_BROWSER_ERROR_CONFIRM_MS = parseEnvMilliseconds(process.env.VH_BROWSER_ERROR_CONFIRM_MS, 30_000);
const VH_BROWSER_RESTART_COOLDOWN_MS = parseEnvMilliseconds(process.env.VH_BROWSER_RESTART_COOLDOWN_MS, 60_000);

let shutdownRequested = false;
let shutdownInProgress = false;
let activeSession = null;
let browserSessionNumber = 0;
let browserRestartCount = 0;
let lastRestartReason = null;
let lastBrowserErrorRestartAt = 0;
const resultCompletenessLedger = new Map();

function parseEnvMilliseconds(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function promiseWithTimeout(promise, timeoutMs, label = 'operation') {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeError(error) {
  return String(error?.message || error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

async function checkHostReachability(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, error: safeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInspectableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function classifyBrowserErrorPage({ url = '', title = '', bodyText = '' } = {}) {
  const normalizedUrl = String(url || '');
  const normalizedTitle = normalizeInspectableText(title);
  const normalizedBody = normalizeInspectableText(bodyText);
  const combinedText = `${normalizedTitle} ${normalizedBody}`;

  const urlPatterns = [
    { type: 'neterror', regex: /^about:neterror\b/i },
    { type: 'certerror', regex: /^about:certerror\b/i },
    { type: 'blocked', regex: /^about:blocked\b/i },
  ];
  const urlMatch = urlPatterns.find(({ regex }) => regex.test(normalizedUrl));
  if (urlMatch) {
    return {
      detected: true,
      type: urlMatch.type,
      url: normalizedUrl,
      title: normalizedTitle,
      matched: normalizedUrl.split(/[?#]/, 1)[0],
    };
  }

  const textPatterns = [
    { type: 'problem-loading-page', regex: /problem loading page/i, scope: normalizedTitle },
    { type: 'server-not-found', regex: /server not found/i, scope: combinedText },
    { type: 'unable-to-connect', regex: /unable to connect/i, scope: combinedText },
    { type: 'secure-connection-failed', regex: /secure connection failed/i, scope: combinedText },
  ];
  const textMatch = textPatterns.find(({ regex, scope }) => regex.test(scope));
  if (textMatch) {
    return {
      detected: true,
      type: textMatch.type,
      url: normalizedUrl,
      title: normalizedTitle,
      matched: textMatch.type,
    };
  }

  return {
    detected: false,
    type: null,
    url: normalizedUrl,
    title: normalizedTitle,
    matched: '',
  };
}

async function detectBrowserErrorPage(page) {
  assertUsablePage(page);

  const url = page.url();
  const [title, bodyText] = await Promise.all([
    page.title().catch(() => ''),
    page.locator('body').innerText({ timeout: 1000 }).catch(() => ''),
  ]);

  return classifyBrowserErrorPage({ url, title, bodyText });
}

function createBrowserErrorConfirmationState(confirmMs = VH_BROWSER_ERROR_CONFIRM_MS) {
  return {
    firstAt: 0,
    lastSeenAt: 0,
    signature: '',
    error: null,
    lastWarningAt: 0,
    observe(error, now = Date.now()) {
      if (!error?.detected) {
        this.clear();
        return { detected: false, confirmed: false, durationMs: 0 };
      }

      const signature = `${error.type || 'unknown'}:${String(error.url || '').split(/[?#]/, 1)[0]}`;
      if (signature !== this.signature) {
        this.firstAt = now;
        this.signature = signature;
        this.lastWarningAt = 0;
      }
      this.lastSeenAt = now;
      this.error = error;

      const durationMs = now - this.firstAt;
      return {
        detected: true,
        confirmed: durationMs >= confirmMs,
        durationMs,
        remainingMs: Math.max(0, confirmMs - durationMs),
        error,
      };
    },
    clear() {
      this.firstAt = 0;
      this.lastSeenAt = 0;
      this.signature = '';
      this.error = null;
      this.lastWarningAt = 0;
    },
  };
}

class BrowserRestartError extends Error {
  constructor(reason, details = {}) {
    super(`browser restart requested: ${reason}`);
    this.name = 'BrowserRestartError';
    this.reason = reason;
    this.details = details;
  }
}

const FEED_SELECTION_LABELS = {
  WINNER: {
    HOME: '1',
    DRAW: 'X',
    AWAY: '2',
  },
  DOUBLE_CHANCE: {
    HOME_OR_DRAW: '1X',
    HOME_OR_AWAY: '12',
    AWAY_OR_DRAW: 'X2',
  },
  GOAL_NO_GOAL: {
    GOAL: 'GG',
    NO_GOAL: 'NG',
  },
  OVER_UNDER: {
    'OVER_2.5': 'OV 2.5',
    'UNDER_2.5': 'UN 2.5',
  },
};

const FEED_SELECTION_ORDER = {
  WINNER: ['1', 'X', '2'],
  DOUBLE_CHANCE: ['1X', '12', 'X2'],
  GOAL_NO_GOAL: ['GG', 'NG'],
  OVER_UNDER: ['OV 2.5', 'UN 2.5'],
};

const FEED_MARKET_CODES = {
  WINNER: '1X2',
  DOUBLE_CHANCE: 'DC',
  GOAL_NO_GOAL: 'BTS',
  OVER_UNDER: 'OU',
  SCORE: 'CS',
  GOALS: 'TG',
};

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeUrl(value, fallback) {
  return String(value || fallback || '');
}

const USERNAME_SELECTORS = [
  'input[name="userName"]',
  'input.login-input',
  'input[name="username"]',
  'input[name="login"]',
  'input[name="user"]',
  'input[id*="user" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="login" i]',
  'input[type="text"]',
  'input:not([type])',
];

function isAuthenticationFailureMessage(value) {
  return /(?:403|401|PlayerNotAuthenticatedException|authentication required|not authenticated|session expired)/i.test(String(value || ''));
}

const PASSWORD_SELECTORS = [
  'input[name="pass"]',
  'input.password-input',
  'input[name="password"]',
  'input[id*="pass" i]',
  'input[placeholder*="pass" i]',
  'input[type="password"]',
];

function hashCanonicalEvents(canonicalEvents) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalEvents))
    .digest('hex');
}

function parseEnvSeconds(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeMatchToken(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getFeedDiscoveryEvents(feed) {
  return values(feed.events)
    .flatMap((feedEvent) => getFixtures(feedEvent).map((fixture) => {
      const teams = fixture?.i?.a?.b ?? fixture?.teams ?? {};
      return {
        matchId: String(fixture.a ?? fixture.eventId ?? fixture.id ?? ''),
        homeTeam: teams?.a?.a ?? teams?.home?.name ?? null,
        awayTeam: teams?.b?.a ?? teams?.away?.name ?? null,
        startTime: fixture.f ?? fixture.startTime ?? null,
      };
    }))
    .filter((event) => event.matchId || event.homeTeam || event.awayTeam);
}

function normalizeFeedName(value) {
  return String(value || '').trim();
}

function normalizeFeedMarketName(value) {
  return normalizeFeedName(value).toUpperCase();
}

function getCurrentFeedBoard(feed) {
  return values(feed?.events)[0] ?? null;
}

function mapFeedSelectionName(marketName, selectionName) {
  const normalizedMarket = normalizeFeedMarketName(marketName);
  const normalizedSelection = normalizeFeedMarketName(selectionName);
  return FEED_SELECTION_LABELS[normalizedMarket]?.[normalizedSelection] ?? selectionName;
}

function mapFeedMarketCode(marketName) {
  const normalizedMarket = normalizeFeedMarketName(marketName);
  return FEED_MARKET_CODES[normalizedMarket] ?? normalizedMarket;
}

function sortFeedSelections(marketName, selections) {
  const order = FEED_SELECTION_ORDER[normalizeFeedMarketName(marketName)];
  if (!order) {
    return selections;
  }

  return [...selections].sort((left, right) => {
    const leftIndex = order.indexOf(left.name);
    const rightIndex = order.indexOf(right.name);
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
}

function mapFeedMarket(market) {
  const marketName = market?.a ?? market?.name ?? '';
  const selections = sortFeedSelections(marketName, values(market?.b ?? market?.selections)
    .filter((selection) => selection && typeof selection === 'object')
    .map((selection) => ({
      name: mapFeedSelectionName(marketName, selection.a ?? selection.name),
      providerName: selection.a ?? selection.name ?? null,
      odd: selection.b ?? selection.odd ?? null,
    }))
    .filter((selection) => selection.name || selection.odd !== null));

  return {
    code: mapFeedMarketCode(marketName),
    name: marketName,
    selections,
  };
}

function toFeedIsoTime(timestamp) {
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    return null;
  }

  const date = new Date(numericTimestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'string' && /[a-z:-]/i.test(value)) {
    const parsedDate = Date.parse(value);
    return Number.isNaN(parsedDate) ? null : parsedDate;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue;
}

function toCycleSeconds(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

function mapFeedMatch(row, boardMeta) {
  const match = row?.b ?? row;
  const teams = match?.i?.a?.b ?? {};
  const homeTeam = teams?.a?.a ?? null;
  const awayTeam = teams?.b?.a ?? null;
  const markets = values(match?.i?.a?.c ?? {})
    .filter((market) => market && typeof market === 'object')
    .map(mapFeedMarket)
    .filter((market) => market.name || market.selections.length > 0);

  return {
    provider: 'VirtualHorizon',
    providerEventId: String(boardMeta.providerEventId ?? ''),
    eventId: String(boardMeta.providerEventId ?? ''),
    matchId: String(match?.a ?? ''),
    sport: 'FOOTBALL',
    leagueId: String(boardMeta.leagueNumber ?? ''),
    leagueNumber: String(boardMeta.leagueNumber ?? ''),
    providerLeagueId: String(boardMeta.providerLeagueId ?? ''),
    leagueName: boardMeta.leagueName,
    homeTeam,
    awayTeam,
    startTime: toFeedIsoTime(match?.f || boardMeta.startTime),
    status: match?.c ?? null,
    markets,
  };
}

function parseFeedEventsBoardFromBoard(board) {
  if (!board) {
    throw new Error('feed-events response missing events[0]');
  }

  const matches = values(board?.f?.b?.c?.c);
  const firstMatch = matches[0]?.b ?? matches[0] ?? {};
  const firstTeams = firstMatch?.i?.a?.b ?? {};
  const providerLeagueId = board?.f?.b?.a?.a?.d ?? board?.f?.b?.a?.d ?? null;
  const leagueNumber = board?.f?.b?.c?.e || providerLeagueId || null;
  const weekNumber = board?.f?.b?.c?.a ?? null;
  const boardMeta = {
    source: FEED_EVENTS_SOURCE,
    provider: 'VirtualHorizon',
    providerEventId: String(board?.a ?? ''),
    leagueName: board?.f?.b?.a?.a?.a ?? board?.f?.b?.a?.a ?? null,
    providerLeagueId: providerLeagueId === null || providerLeagueId === undefined ? null : String(providerLeagueId),
    weekNumber: weekNumber === null || weekNumber === undefined ? null : String(weekNumber),
    leagueNumber: leagueNumber === null || leagueNumber === undefined ? null : String(leagueNumber),
    startTime: board?.d ?? null,
    endTime: board?.e ?? board?.endTime ?? board?.finishTime ?? null,
    countdownSeconds: toCycleSeconds(board?.countdown ?? board?.countdownSeconds ?? board?.remainingSeconds ?? board?.remainingTime),
    firstMatch: `${firstTeams?.a?.a ?? ''} vs ${firstTeams?.b?.a ?? ''}`,
  };

  const events = matches
    .map((row) => mapFeedMatch(row, boardMeta))
    .filter((event) => event.matchId || event.homeTeam || event.awayTeam);

  return {
    ...boardMeta,
    leagueId: String(boardMeta.leagueNumber ?? ''),
    events,
  };
}

function parseFeedEventsBoard(feed) {
  return parseFeedEventsBoardFromBoard(getCurrentFeedBoard(feed));
}

function parseFeedEventsBoards(feed) {
  return values(feed?.events)
    .map((board) => {
      try {
        return parseFeedEventsBoardFromBoard(board);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function formatFeedOdd(value) {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function getFeedMarketSelectionMap(event, code) {
  const market = (event.markets ?? []).find((candidate) => candidate.code === code);
  const selections = new Map();

  (market?.selections ?? []).forEach((selection) => {
    selections.set(selection.name, formatFeedOdd(selection.odd));
  });

  return selections;
}

function formatFeedMarketOdds(selectionMap, labels) {
  return labels
    .map(([label, selectionName]) => `${label}=${selectionMap.get(selectionName) ?? '-'}`)
    .join(' ');
}

function logFeedEventsOddsQueue(responseId, boardPayloads) {
  if (!LOG_ODDS_DETAILS) {
    return;
  }

  console.log(`FEED-ODDS-QUEUE responseId=${responseId} boardCount=${boardPayloads.length}`);
  boardPayloads.forEach((boardPayload, boardIndex) => {
    const displayBoardIndex = boardIndex + 1;
    console.log(
      `FEED-ODDS-BOARD index=${displayBoardIndex} providerEventId=${boardPayload.providerEventId || 'not found'} ` +
        `week=${boardPayload.weekNumber || 'not found'} firstMatch="${boardPayload.firstMatch || 'not found'}" ` +
        `matchCount=${boardPayload.events?.length ?? 0}`,
    );

    (boardPayload.events ?? []).slice(0, 10).forEach((event, matchIndex) => {
      const teams = event.homeTeam || event.awayTeam
        ? `${event.homeTeam || ''} vs ${event.awayTeam || ''}`
        : 'not found';
      const main = formatFeedMarketOdds(getFeedMarketSelectionMap(event, '1X2'), [
        ['1', '1'],
        ['X', 'X'],
        ['2', '2'],
      ]);
      const dc = formatFeedMarketOdds(getFeedMarketSelectionMap(event, 'DC'), [
        ['1X', '1X'],
        ['12', '12'],
        ['X2', 'X2'],
      ]);
      const bts = formatFeedMarketOdds(getFeedMarketSelectionMap(event, 'BTS'), [
        ['GG', 'GG'],
        ['NG', 'NG'],
      ]);
      const ou25 = formatFeedMarketOdds(getFeedMarketSelectionMap(event, 'OU'), [
        ['OV', 'OV 2.5'],
        ['UN', 'UN 2.5'],
      ]);

      console.log(
        `FEED-ODDS-MATCH boardIndex=${displayBoardIndex} matchIndex=${matchIndex + 1} ` +
          `teams="${teams}" main="${main}" dc="${dc}" bts="${bts}" ou25="${ou25}"`,
      );
    });
  });
}

function toQueueIsoTime(value) {
  const epochMs = toEpochMs(value);
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function mapFeedQueueMatch(event) {
  return {
    providerEventId: event.providerEventId,
    eventId: event.eventId,
    matchId: event.matchId,
    sport: event.sport,
    leagueId: event.leagueId,
    leagueNumber: event.leagueNumber,
    providerLeagueId: event.providerLeagueId,
    leagueName: event.leagueName,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    startTime: event.startTime,
    status: event.status,
    markets: event.markets,
  };
}

function buildFeedEventsQueuePayload(boardPayloads, capturedAt) {
  return {
    provider: 'VirtualHorizon',
    source: 'feed-events-queue',
    leagueId: String(boardPayloads[0]?.leagueNumber || '21'),
    capturedAt: new Date(capturedAt).toISOString(),
    boards: boardPayloads.map((boardPayload, index) => {
      const nextBoardPayload = boardPayloads[index + 1] ?? null;
      const endAt = toQueueIsoTime(boardPayload.endTime);

      return {
        providerEventId: boardPayload.providerEventId,
        weekNumber: boardPayload.weekNumber,
        firstMatch: boardPayload.firstMatch,
        startAt: toQueueIsoTime(boardPayload.startTime),
        endAt,
        nextRefreshAt: endAt ?? toQueueIsoTime(nextBoardPayload?.startTime),
        matches: (boardPayload.events ?? []).map(mapFeedQueueMatch),
      };
    }),
  };
}

function getEventDetailObject(feed) {
  return feed?.event ?? feed?.data?.event ?? feed?.data ?? feed;
}

function getEventDetailMatchRows(event) {
  const container = event?.f?.b?.c;

  if (Array.isArray(container)) {
    return container;
  }

  if (Array.isArray(container?.c)) {
    return container.c;
  }

  return values(container);
}

function normalizeRawResultRows(rows) {
  if (!rows) {
    return [];
  }

  if (Array.isArray(rows)) {
    return rows;
  }

  return values(rows);
}

function rowHasVirtualHorizonMatchObject(row) {
  const matchObj = row?.b;
  return Boolean(
    matchObj &&
      typeof matchObj === 'object' &&
      (
        Object.prototype.hasOwnProperty.call(matchObj, 'i') ||
        Object.prototype.hasOwnProperty.call(matchObj, 'd') ||
        Object.prototype.hasOwnProperty.call(matchObj, 'c')
      )
  );
}

function getRawEventDetailResultRowsFromPayload(payload) {
  const rowCandidates = [
    payload?.event?.f?.b?.c?.c,
    payload?.data?.event?.f?.b?.c?.c,
    payload?.data?.f?.b?.c?.c,
    payload?.f?.b?.c?.c,
  ];

  for (const candidate of rowCandidates) {
    const rows = normalizeRawResultRows(candidate).filter((row) => row && typeof row === 'object');

    if (rows.some(rowHasVirtualHorizonMatchObject)) {
      return rows;
    }
  }

  return [];
}

function getRawEventDetailResultRows(event) {
  return normalizeRawResultRows(event?.f?.b?.c?.c);
}

function getVirtualHorizonResultMatchObject(matchRow) {
  const matchObj = rowHasVirtualHorizonMatchObject(matchRow)
    ? matchRow.b
    : matchRow;

  if (!matchObj || typeof matchObj !== 'object') {
    return null;
  }

  if (matchObj.d !== undefined) {
    return matchObj;
  }

  const preservedResult = matchObj?.i?.a?.d;
  if (preservedResult !== undefined) {
    return {
      ...matchObj,
      d: preservedResult,
    };
  }

  return matchObj;
}

function getCollectionLength(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).length;
  }

  return 0;
}

function logEventDetailShape(cycle, eventFeedId, event, matches) {
  const firstMatch = matches[0]?.b ?? matches[0] ?? {};
  const firstTeams = firstMatch?.i?.a?.b ?? {};
  const homeTeam = firstTeams?.a?.a ?? firstTeams?.home?.name ?? '';
  const awayTeam = firstTeams?.b?.a ?? firstTeams?.away?.name ?? '';

  console.log(`cycle=${cycle} source=event-detail eventFeedId=${eventFeedId} eventKeys=${JSON.stringify(Object.keys(event || {}))}`);
  console.log(`cycle=${cycle} source=event-detail eventFeedId=${eventFeedId} event.f.keys=${JSON.stringify(Object.keys(event?.f || {}))}`);
  console.log(`cycle=${cycle} source=event-detail eventFeedId=${eventFeedId} event.f.b.keys=${JSON.stringify(Object.keys(event?.f?.b || {}))}`);
  console.log(
    `cycle=${cycle} source=event-detail eventFeedId=${eventFeedId} lengths f.b.c=${getCollectionLength(event?.f?.b?.c)} f.b.c.c=${getCollectionLength(event?.f?.b?.c?.c)} matches=${matches.length}`,
  );
  console.log(`cycle=${cycle} source=event-detail eventFeedId=${eventFeedId} first parsed match: ${homeTeam} vs ${awayTeam}`);
}

function logEventDetailRealtimeSummary(cycle, eventFeedId, event, matches, canonicalEvents) {
  const firstCanonicalEvent = canonicalEvents[0] ?? {};
  const league = event?.f?.b?.a?.a ?? event?.league ?? {};
  const firstMatch = getFirstText(canonicalEvents);
  const leagueId = firstCanonicalEvent.leagueId ?? league.d ?? league.id ?? '';

  console.log(
    `cycle=${cycle} source=event-detail-realtime eventFeedId=${eventFeedId} first match="${firstMatch}" match count=${matches.length} league id=${leagueId}`,
  );
}

function normalizeEventDetailToCanonical(feed, eventFeedId = '') {
  const event = getEventDetailObject(feed);
  const matches = getEventDetailMatchRows(event);
  const weekNumber = getEventDetailWeek(event);

  return matches
    .map((match) => match?.b ?? match)
    .filter((match) => match && typeof match === 'object')
    .map((match) => normalizeEvent(event, match))
    .map((normalizedEvent) => {
      const canonicalEvent = mapEvent(normalizedEvent);
      return {
        ...canonicalEvent,
        providerEventId: String(eventFeedId || canonicalEvent.providerEventId),
        matchId: canonicalEvent.providerEventId,
        weekNumber: weekNumber || canonicalEvent.weekNumber,
      };
    });
}

function parseCapturedEventDetail(capturedEventDetail) {
  if (!capturedEventDetail.json) {
    capturedEventDetail.json = JSON.parse(capturedEventDetail.body);
  }

  const event = getEventDetailObject(capturedEventDetail.json);
  const matches = getEventDetailMatchRows(event);
  const eventFeedId = capturedEventDetail.eventFeedId ?? event?.a ?? '';
  const canonicalEvents = normalizeEventDetailToCanonical(capturedEventDetail.json, eventFeedId);

  return {
    event,
    matches,
    canonicalEvents,
    eventFeedId,
  };
}

function getEventDetailWeek(event) {
  const week = event?.f?.b?.c?.a ?? event?.weekNumber ?? event?.week ?? null;
  return week === null || week === undefined ? '' : String(week);
}

function getEventDetailFirstMatchText(matches, canonicalEvents = []) {
  const firstMatch = matches?.[0]?.b ?? matches?.[0] ?? null;
  const teams = firstMatch?.i?.a?.b ?? firstMatch?.teams ?? null;
  const homeTeam = teams?.a?.a ?? teams?.home?.name ?? canonicalEvents[0]?.homeTeam ?? '';
  const awayTeam = teams?.b?.a ?? teams?.away?.name ?? canonicalEvents[0]?.awayTeam ?? '';
  return `${homeTeam ?? ''} vs ${awayTeam ?? ''}`;
}

function getResultMatchTeams(match, canonicalEvent = {}) {
  const row = match?.b ?? match ?? {};
  const teams = row?.i?.a?.b ?? row?.teams ?? {};
  const homeTeam = teams?.a?.a ?? teams?.home?.name ?? canonicalEvent.homeTeam ?? '';
  const awayTeam = teams?.b?.a ?? teams?.away?.name ?? canonicalEvent.awayTeam ?? '';
  return `${homeTeam ?? ''} vs ${awayTeam ?? ''}`;
}

function collectResultScoreFields(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object') {
    return output;
  }

  Object.entries(value).forEach(([key, child]) => {
    const pathKey = prefix ? `${prefix}.${key}` : key;

    if (/score|result|goal|homeScore|awayScore|final|ft|winner/i.test(key)) {
      if (child === null || typeof child !== 'object') {
        output[pathKey] = child;
      } else if (Object.keys(output).length < 25) {
        output[pathKey] = child;
      }
    }

    if (child && typeof child === 'object' && Object.keys(output).length < 25) {
      collectResultScoreFields(child, pathKey, output);
    }
  });

  return output;
}

function getCompactScore(scoreFields) {
  const entries = Object.entries(scoreFields ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 6);

  if (entries.length === 0) {
    return 'not found';
  }

  return entries.map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' ');
}

function collectResultStatusValues(value, output = []) {
  if (!value || typeof value !== 'object') {
    return output;
  }

  Object.entries(value).forEach(([key, child]) => {
    if (/status|state|result/i.test(key) && (typeof child === 'string' || typeof child === 'number')) {
      output.push(String(child));
    }

    if (child && typeof child === 'object' && output.length < 100) {
      collectResultStatusValues(child, output);
    }
  });

  return output;
}

function isResultLikeState(value) {
  return /^(RESULT|RESULTS|FINISHED|ENDED|SETTLED)$/i.test(String(value || '').trim());
}

function summarizeResultEventDetail(json, url) {
  const event = getEventDetailObject(json);
  const matches = getEventDetailMatchRows(event);
  const eventFeedId = String(event?.a ?? extractEventFeedIdFromUrl(url) ?? '');
  const canonicalEvents = normalizeEventDetailToCanonical(json, eventFeedId);
  const eventState = event?.c ?? event?.status ?? event?.state ?? '';
  const boardState = event?.f?.b?.c?.b ?? event?.f?.b?.c?.status ?? event?.f?.b?.c?.state ?? '';
  const statusValues = collectResultStatusValues(event);
  const matchSummaries = matches.map((match, index) => {
    const row = match?.b ?? match ?? {};
    const scoreFields = collectResultScoreFields(row);

    return {
      index: index + 1,
      teams: getResultMatchTeams(row, canonicalEvents[index]),
      status: row?.c ?? row?.status ?? row?.state ?? '',
      score: getCompactScore(scoreFields),
      rawScoreFields: scoreFields,
    };
  });
  const matchStatuses = matchSummaries.map((match) => match.status).filter((status) => status !== '');
  const lastStates = [
    eventState,
    boardState,
    ...matchStatuses,
    ...statusValues,
  ].filter((state) => state !== '');
  const hasResultKeyword = lastStates.some(isResultLikeState);
  const hasClosedMatchStatus = matchStatuses.some((status) => (
    status && !/^(RACING|ACCEPTING_TICKETS)$/i.test(String(status))
  ));
  const hasScoreFields = matchSummaries.some((match) => Object.keys(match.rawScoreFields).length > 0);

  return {
    providerEventId: eventFeedId,
    week: getEventDetailWeek(event),
    eventState,
    boardState,
    matchCount: matches.length,
    matchSummaries,
    lastStates: Array.from(new Set(lastStates.map(String))),
    resultLike: hasResultKeyword || hasClosedMatchStatus || hasScoreFields,
  };
}

function getEventDetailPacketMatches(json) {
  return getEventDetailMatchRows(getEventDetailObject(json))
    .map((match) => match?.b ?? match)
    .filter((match) => match && typeof match === 'object');
}

function getFirstEventDetailPacketMatch(json) {
  const firstMatch = getRawEventDetailResultRowsFromPayload(json)[0] ?? null;
  return firstMatch ?? null;
}

async function dumpResultsFirstMatchJson(json, url) {
  if (!LOG_RESULT_RAW_DUMP) {
    return null;
  }

  const event = getEventDetailObject(json);
  const eventType = json?.event?.c ?? event?.c ?? '';

  if (eventType !== 'RESULTS') {
    return null;
  }

  const providerEventId = String(json?.event?.a ?? event?.a ?? extractEventFeedIdFromUrl(url) ?? 'unknown');
  const firstMatch = getFirstEventDetailPacketMatch(json);
  const safeProviderEventId = providerEventId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  const capturedAt = new Date().toISOString();
  const safeTimestamp = capturedAt.replace(/[:.]/g, '-');

  await fs.promises.mkdir(path.join('data', 'captured'), { recursive: true });
  const filePath = path.join('data', 'captured', `results-first-match-${safeProviderEventId}-${safeTimestamp}.json`);
  await fs.promises.writeFile(filePath, `${JSON.stringify(firstMatch, null, 2)}\n`, 'utf8');

  console.log('==============================');
  console.log('RESULTS FIRST MATCH RAW DUMP');
  console.log(`eventId=${providerEventId || 'not found'}`);
  console.log(`url=${url || 'not found'}`);
  console.log(`file=${filePath}`);
  console.log(`match.topLevelKeys=${JSON.stringify(Object.keys(firstMatch || {}))}`);
  console.log(`match.c=${JSON.stringify(firstMatch?.c)}`);
  console.log(`match.i=${JSON.stringify(firstMatch?.i, null, 2)}`);
  console.log(`match.i.d=${JSON.stringify(firstMatch?.i?.d, null, 2)}`);
  console.log(`match.i.a=${JSON.stringify(firstMatch?.i?.a, null, 2)}`);
  if (firstMatch?.b && typeof firstMatch.b === 'object') {
    console.log(`match.b.topLevelKeys=${JSON.stringify(Object.keys(firstMatch.b))}`);
    console.log(`match.b.c=${JSON.stringify(firstMatch.b?.c)}`);
    console.log(`match.b.i=${JSON.stringify(firstMatch.b?.i, null, 2)}`);
    console.log(`match.b.i.d=${JSON.stringify(firstMatch.b?.i?.d, null, 2)}`);
    console.log(`match.b.i.a=${JSON.stringify(firstMatch.b?.i?.a, null, 2)}`);
  }
  console.log('match.full=');
  console.log(JSON.stringify(firstMatch, null, 2));
  console.log('==============================');

  return filePath;
}

function getResultPacketTeams(match) {
  const teams = match?.i?.a?.b ?? match?.teams ?? {};
  const homeTeam = teams?.a?.a ?? teams?.home?.name ?? '';
  const awayTeam = teams?.b?.a ?? teams?.away?.name ?? '';
  return `${homeTeam ?? ''} vs ${awayTeam ?? ''}`;
}

function getVirtualHorizonResultScore(result) {
  const homeScore = Number(result?.a);
  const awayScore = Number(result?.b);

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
    return null;
  }

  return {
    homeScore,
    awayScore,
    resultCode: result?.c ?? null,
  };
}

let resultFirstMatchDumped = false;

function classifyEventDetailPacket(json, url) {
  const payloadEvent = json?.event ?? null;
  const event = getEventDetailObject(json);
  const eventType = payloadEvent?.c ?? event?.c ?? '';
  const providerEventId = String(payloadEvent?.a ?? event?.a ?? extractEventFeedIdFromUrl(url) ?? '');
  const leagueId = String(
    event?.f?.b?.a?.a?.d ??
      event?.f?.b?.a?.d ??
      event?.leagueId ??
      event?.providerLeagueId ??
      '',
  );
  const leagueName = event?.f?.b?.a?.a?.a ?? event?.f?.b?.a?.a ?? event?.leagueName ?? '';
  const matchRows = getRawEventDetailResultRowsFromPayload(json);
  const firstRawMatch = getFirstEventDetailPacketMatch(json);
  const results = matchRows.map((row, index) => {
    const matchRow = row;
    const matchObj = getVirtualHorizonResultMatchObject(matchRow);
    const resultObject = matchObj?.d ?? null;
    const score = getVirtualHorizonResultScore(resultObject);
    const hasScore = Boolean(score);
    const home = matchObj?.i?.a?.b?.a?.a ?? '';
    const away = matchObj?.i?.a?.b?.b?.a ?? '';
    const matchStatus = matchObj?.c;

    return {
      index: index + 1,
      providerMatchId: String(matchObj?.a ?? matchObj?.matchId ?? ''),
      home,
      away,
      teams: `${home ?? ''} vs ${away ?? ''}`,
      status: matchStatus,
      hasResultObject: Boolean(resultObject && typeof resultObject === 'object'),
      hasScore,
      homeScore: score?.homeScore ?? null,
      awayScore: score?.awayScore ?? null,
      resultCode: score?.resultCode ?? null,
      rawResult: resultObject,
    };
  });
  const hasResultEventStatus = eventType === 'RESULTS' || eventType === 'COMPLETED';
  const hasResultMatchStatus = results.some((match) => (
    match.status === 'DISPLAY_RESULTS' || match.status === 'COMPLETED'
  ));
  const hasScore = results.some((match) => match.hasScore);
  const isResultCandidate = hasResultEventStatus || hasResultMatchStatus || hasScore;
  const hasResults = hasResultEventStatus && results.length > 0 && hasScore;

  return {
    providerEventId,
    eventType,
    isResultCandidate,
    hasResults,
    matchCount: matchRows.length,
    firstRawMatch,
    resultsPayload: {
      provider: 'VirtualHorizon',
      source: 'event-detail-results',
      providerEventId,
      leagueId,
      leagueName,
      eventType,
      capturedAt: new Date().toISOString(),
      matches: results,
    },
  };
}

function logResultCandidateBypassMismatch(packet, domFirst, feedFirst) {
  console.log(
    `RESULT-CANDIDATE-BYPASS-MISMATCH providerEventId=${packet.providerEventId || 'not found'} ` +
      `domFirst=${domFirst || 'not found'} feedFirst=${feedFirst || 'not found'} ` +
      `eventStatus=${packet.eventType || 'not found'}`,
  );
}

function isKnownFirstMatchMismatch(domFirst, feedFirst) {
  return Boolean(
    domFirst &&
      feedFirst &&
      domFirst !== 'not found' &&
      feedFirst !== 'not found' &&
      domFirst !== feedFirst,
  );
}

function buildResultMonitorPayload(packet) {
  return {
    provider: 'VirtualHorizon',
    providerEventId: packet.providerEventId,
    leagueId: packet.resultsPayload.leagueId,
    leagueName: packet.resultsPayload.leagueName,
    source: 'event-detail-results',
    receivedAt: new Date().toISOString(),
    matches: packet.resultsPayload.matches
      .filter((match) => match.hasScore)
      .map((match) => ({
        providerMatchId: match.providerMatchId,
        home: match.home,
        away: match.away,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        resultCode: match.resultCode,
      })),
  };
}

function logResultCandidate(packet) {
  if (
    !resultFirstMatchDumped &&
    (packet.eventType === 'RESULTS' || packet.eventType === 'COMPLETED')
  ) {
    resultFirstMatchDumped = true;
    console.log('RESULT-FIRST-MATCH', JSON.stringify(packet.firstRawMatch ?? null, null, 2));
  }

  if (!LOG_RESULT_SUMMARY) {
    return;
  }

  const firstMatch = packet.resultsPayload.matches[0] ?? {};
  const hasScore = packet.resultsPayload.matches.some((match) => match.hasScore);

  console.log(
    `RESULT-CANDIDATE providerEventId=${packet.providerEventId || 'not found'} ` +
      `eventStatus=${packet.eventType || 'not found'} matchStatus=${firstMatch.status || 'not found'} ` +
      `hasScore=${hasScore ? 'true' : 'false'}`,
  );
}

function logResultScores(packet) {
  if (!LOG_RESULT_SUMMARY) {
    return;
  }

  packet.resultsPayload.matches.forEach((match) => {
    if (!match.hasScore) {
      return;
    }

    console.log(
      `RESULT-SCORE providerMatchId=${match.providerMatchId || 'not found'} ` +
        `teams="${match.teams || 'not found'}" score=${match.homeScore ?? '-'}-${match.awayScore ?? '-'} ` +
        `resultCode=${match.resultCode ?? '-'}`,
    );
  });
}

function normalizeProviderEventId(value) {
  return String(value ?? '').trim();
}

function isNumericScore(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function createResultLedgerEntry(providerEventId) {
  const now = Date.now();
  return {
    providerEventId,
    leagueId: '',
    leagueName: '',
    weekNumber: '',
    firstMatch: '',
    expectedMatchCount: null,
    eventSource: '',
    eventPostedAt: null,
    eventPostSucceeded: false,
    eventRegistrationObserved: false,
    scheduledStartAt: null,
    scheduledEndAt: null,
    firstResultSeenAt: null,
    lastResultSeenAt: null,
    resultsReceivedAt: null,
    receivedMatchCount: 0,
    resultProviderMatchIds: [],
    resultPostAttemptedAt: null,
    resultPostSucceededAt: null,
    resultPostFailedAt: null,
    resultPostAttempts: 0,
    lastResultPostError: null,
    lastResultPayload: null,
    retryInProgress: false,
    status: 'EVENT_CAPTURED',
    lastUpdatedAt: now,
    lastOverdueLogAt: 0,
    resultRowsByProviderMatchId: {},
  };
}

function getResultLedgerEntry(providerEventId) {
  const normalizedProviderEventId = normalizeProviderEventId(providerEventId);
  if (!normalizedProviderEventId) {
    return null;
  }

  if (!resultCompletenessLedger.has(normalizedProviderEventId)) {
    resultCompletenessLedger.set(normalizedProviderEventId, createResultLedgerEntry(normalizedProviderEventId));
  }

  return resultCompletenessLedger.get(normalizedProviderEventId);
}

function updateMissingLedgerMetadata(entry, metadata = {}) {
  if (!entry) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'expectedMatchCount') {
      if (!Number.isFinite(entry.expectedMatchCount) || entry.expectedMatchCount <= 0) {
        entry.expectedMatchCount = value;
      }
      continue;
    }
    if (!entry[key]) entry[key] = value;
  }
  entry.lastUpdatedAt = Date.now();
}

function getBoardScheduledStartAt(boardPayload) {
  const startAtMs = toEpochMs(boardPayload?.startTime ?? boardPayload?.events?.[0]?.startTime);
  return startAtMs ? new Date(startAtMs).toISOString() : null;
}

function getBoardScheduledEndAt(boardPayload, cycleTiming = null) {
  const endAtMs = cycleTiming?.endAtMs ?? toEpochMs(boardPayload?.endTime);
  return endAtMs ? new Date(endAtMs).toISOString() : null;
}

function registerResultLedgerEventBoard(boardPayload, result = {}, source = FEED_EVENTS_SOURCE) {
  const providerEventId = normalizeProviderEventId(boardPayload?.providerEventId ?? result.providerEventId);
  const entry = getResultLedgerEntry(providerEventId);
  if (!entry) return null;

  const expectedMatchCount = Array.isArray(boardPayload?.events) && boardPayload.events.length > 0
    ? boardPayload.events.length
    : null;
  updateMissingLedgerMetadata(entry, {
    leagueId: String(boardPayload?.leagueNumber ?? boardPayload?.leagueId ?? ''),
    leagueName: boardPayload?.leagueName ?? boardPayload?.events?.[0]?.leagueName ?? '',
    weekNumber: String(boardPayload?.weekNumber ?? ''),
    firstMatch: boardPayload?.firstMatch ?? '',
    expectedMatchCount,
    scheduledStartAt: getBoardScheduledStartAt(boardPayload),
    scheduledEndAt: getBoardScheduledEndAt(boardPayload, result.cycleTiming),
  });

  entry.eventSource = source;
  entry.eventPostedAt = new Date().toISOString();
  entry.eventPostSucceeded = true;
  entry.eventRegistrationObserved = true;
  if (entry.status === 'EVENT_CAPTURED') entry.status = 'EVENT_POSTED';
  if (!entry.resultsReceivedAt && !entry.resultPostSucceededAt) entry.status = 'AWAITING_RESULTS';
  entry.lastUpdatedAt = Date.now();

  console.log(
    `RESULT-LEDGER-REGISTERED providerEventId=${entry.providerEventId} ` +
      `week=${entry.weekNumber || 'not found'} expected=${entry.expectedMatchCount ?? 'unknown'} ` +
      `endAt=${entry.scheduledEndAt || 'unknown'} source=${source}`,
  );
  return entry;
}

function registerResultLedgerCanonicalEvents(canonicalEvents, result = {}, source = 'event-detail') {
  if (!Array.isArray(canonicalEvents) || canonicalEvents.length === 0) return null;
  const firstEvent = canonicalEvents[0] ?? {};
  const boardPayload = {
    providerEventId: result.providerEventId ?? result.eventFeedId ?? firstEvent.providerEventId ?? firstEvent.eventId,
    leagueNumber: firstEvent.leagueNumber ?? firstEvent.leagueId,
    leagueId: firstEvent.leagueId,
    leagueName: firstEvent.leagueName,
    weekNumber: firstEvent.weekNumber,
    firstMatch: firstEvent.firstMatch ?? getFirstText(canonicalEvents),
    startTime: firstEvent.startTime,
    endTime: result.endTime ?? null,
    events: canonicalEvents,
  };
  return registerResultLedgerEventBoard(boardPayload, result, source);
}

function getResultPayloadExpectedMatchCount(packet, monitorPayload) {
  const payloadCount = packet?.resultsPayload?.matches?.length ?? monitorPayload?.matches?.length ?? null;
  return payloadCount || 10;
}

function recordResultLedgerObservation(packet, monitorPayload) {
  const providerEventId = normalizeProviderEventId(packet?.providerEventId ?? monitorPayload?.providerEventId);
  const entry = getResultLedgerEntry(providerEventId);
  if (!entry) return null;

  const now = Date.now();
  if (!entry.eventRegistrationObserved && !entry.firstResultSeenAt) {
    console.log(
      `RESULT-LEDGER-PROVISIONAL providerEventId=${providerEventId} ` +
        `expected=${getResultPayloadExpectedMatchCount(packet, monitorPayload)} reason=result-seen-before-event-registration`,
    );
  }

  updateMissingLedgerMetadata(entry, {
    leagueId: packet?.resultsPayload?.leagueId ?? monitorPayload?.leagueId,
    leagueName: packet?.resultsPayload?.leagueName ?? monitorPayload?.leagueName,
    expectedMatchCount: getResultPayloadExpectedMatchCount(packet, monitorPayload),
    firstMatch: packet?.resultsPayload?.matches?.[0]?.teams,
  });

  entry.firstResultSeenAt = entry.firstResultSeenAt ?? new Date(now).toISOString();
  entry.lastResultSeenAt = new Date(now).toISOString();
  entry.lastResultPayload = monitorPayload;

  (monitorPayload?.matches ?? []).forEach((match) => {
    const providerMatchId = normalizeProviderEventId(match.providerMatchId);
    if (!providerMatchId) return;
    entry.resultRowsByProviderMatchId[providerMatchId] = {
      providerMatchId,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      home: match.home,
      away: match.away,
      resultCode: match.resultCode,
    };
  });

  entry.resultProviderMatchIds = Object.keys(entry.resultRowsByProviderMatchId);
  entry.receivedMatchCount = entry.resultProviderMatchIds.length;
  const expected = entry.expectedMatchCount ?? getResultPayloadExpectedMatchCount(packet, monitorPayload);
  const completeScores = entry.resultProviderMatchIds.every((providerMatchId) => {
    const row = entry.resultRowsByProviderMatchId[providerMatchId];
    return providerMatchId && isNumericScore(row?.homeScore) && isNumericScore(row?.awayScore);
  });
  const isComplete = entry.receivedMatchCount === expected && completeScores;

  if (isComplete) {
    entry.resultsReceivedAt = entry.resultsReceivedAt ?? new Date(now).toISOString();
  } else if (entry.receivedMatchCount > 0) {
    entry.status = 'PARTIAL_RESULTS';
  }

  entry.lastUpdatedAt = now;
  console.log(
    `RESULT-LEDGER-UPDATE providerEventId=${providerEventId} received=${entry.receivedMatchCount} ` +
      `expected=${expected} state=${packet?.eventType || 'unknown'}`,
  );
  if (!isComplete) {
    console.log(
      `RESULT-PARTIAL providerEventId=${providerEventId} expected=${expected} ` +
        `received=${entry.receivedMatchCount} missing=${Math.max(0, expected - entry.receivedMatchCount)}`,
    );
  }
  return { entry, isComplete, expected };
}

function markResultPostAttempt(entry) {
  entry.resultPostAttempts += 1;
  entry.resultPostAttemptedAt = new Date().toISOString();
  entry.lastUpdatedAt = Date.now();
}

function markResultPostSuccess(entry, monitorPayload) {
  const now = Date.now();
  entry.resultPostSucceededAt = new Date(now).toISOString();
  entry.resultPostFailedAt = null;
  entry.lastResultPostError = null;
  entry.lastResultPayload = monitorPayload;
  entry.status = 'RESULTS_COMPLETE';
  entry.lastUpdatedAt = now;
  console.log(
    `RESULT-POST-SUCCESS providerEventId=${entry.providerEventId} ` +
      `matches=${monitorPayload.matches.length} attempt=${entry.resultPostAttempts}`,
  );
  console.log(`RESULT-COMPLETE providerEventId=${entry.providerEventId} expected=${entry.expectedMatchCount ?? monitorPayload.matches.length} received=${entry.receivedMatchCount}`);
}

function markResultPostFailure(entry, monitorPayload, error) {
  const now = Date.now();
  entry.resultPostFailedAt = new Date(now).toISOString();
  entry.lastResultPostError = safeError(error);
  entry.lastResultPayload = monitorPayload;
  entry.status = 'RESULT_POST_FAILED';
  entry.lastUpdatedAt = now;
  console.log(
    `RESULT-POST-FAILED providerEventId=${entry.providerEventId} matches=${monitorPayload.matches.length} ` +
      `attempt=${entry.resultPostAttempts} error="${entry.lastResultPostError}"`,
  );
}

async function postResultMonitorPayloadWithLedger(entry, monitorPayload, { retry = false } = {}) {
  if (!entry) {
    return postResultMonitorPayload(monitorPayload);
  }

  markResultPostAttempt(entry);
  if (retry) {
    console.log(`RESULT-POST-RETRY providerEventId=${entry.providerEventId} attempt=${entry.resultPostAttempts}`);
  }

  try {
    const monitorResult = await postResultMonitorPayload(monitorPayload);
    markResultPostSuccess(entry, monitorPayload);
    return monitorResult;
  } catch (error) {
    markResultPostFailure(entry, monitorPayload, error);
    throw error;
  }
}

async function retryResultLedgerPost(entry) {
  if (!entry || entry.retryInProgress || entry.status !== 'RESULT_POST_FAILED') return;
  if (!entry.lastResultPayload || entry.resultPostSucceededAt) return;
  if (entry.resultPostAttempts >= VH_RESULT_POST_MAX_ATTEMPTS) return;
  const failedAtMs = Date.parse(entry.resultPostFailedAt || '');
  if (Number.isFinite(failedAtMs) && Date.now() - failedAtMs < VH_RESULT_POST_RETRY_MS) return;

  entry.retryInProgress = true;
  try {
    await postResultMonitorPayloadWithLedger(entry, entry.lastResultPayload, { retry: true });
  } catch {
    // Failure is recorded by postResultMonitorPayloadWithLedger.
  } finally {
    entry.retryInProgress = false;
  }
}

function getResultLedgerCounts() {
  const counts = {
    tracked: resultCompletenessLedger.size,
    awaiting: 0,
    partial: 0,
    complete: 0,
    overdue: 0,
    postFailed: 0,
  };
  for (const entry of resultCompletenessLedger.values()) {
    if (entry.status === 'AWAITING_RESULTS') counts.awaiting += 1;
    else if (entry.status === 'PARTIAL_RESULTS') counts.partial += 1;
    else if (entry.status === 'RESULTS_COMPLETE') counts.complete += 1;
    else if (entry.status === 'RESULTS_OVERDUE') counts.overdue += 1;
    else if (entry.status === 'RESULT_POST_FAILED') counts.postFailed += 1;
  }
  return counts;
}

function getPendingEndedResultCount(now = Date.now()) {
  let count = 0;
  for (const entry of resultCompletenessLedger.values()) {
    if (!['AWAITING_RESULTS', 'PARTIAL_RESULTS', 'RESULT_POST_FAILED', 'RESULTS_OVERDUE'].includes(entry.status)) continue;
    const endAtMs = Date.parse(entry.scheduledEndAt || '');
    if (Number.isFinite(endAtMs) && now > endAtMs + VH_RESULT_GRACE_MS) count += 1;
  }
  return count;
}

async function checkResultCompletenessLedger() {
  const now = Date.now();
  for (const [providerEventId, entry] of resultCompletenessLedger.entries()) {
    if (entry.status === 'RESULTS_COMPLETE') {
      const succeededAtMs = Date.parse(entry.resultPostSucceededAt || '');
      if (Number.isFinite(succeededAtMs) && now - succeededAtMs >= VH_RESULT_LEDGER_RETENTION_MS) {
        resultCompletenessLedger.delete(providerEventId);
        console.log(`RESULT-LEDGER-REMOVED providerEventId=${providerEventId} reason=retention-expired`);
      }
      continue;
    }

    if (entry.status === 'RESULT_POST_FAILED') {
      await retryResultLedgerPost(entry);
    }

    if (!['AWAITING_RESULTS', 'PARTIAL_RESULTS', 'RESULT_POST_FAILED', 'RESULTS_OVERDUE'].includes(entry.status)) {
      continue;
    }

    const endAtMs = Date.parse(entry.scheduledEndAt || '');
    if (!Number.isFinite(endAtMs) || now <= endAtMs + VH_RESULT_GRACE_MS) {
      continue;
    }

    const expected = entry.expectedMatchCount ?? 10;
    const missing = Math.max(0, expected - entry.receivedMatchCount);
    const endedAgoMs = now - endAtMs;
    if (entry.status !== 'RESULTS_OVERDUE' || now - entry.lastOverdueLogAt >= VH_RESULT_LEDGER_CHECK_MS * 4) {
      console.log(
        `RESULTS-OVERDUE providerEventId=${providerEventId} expected=${expected} ` +
          `received=${entry.receivedMatchCount} missing=${missing} endedAgoMs=${endedAgoMs}`,
      );
      entry.lastOverdueLogAt = now;
    }
    if (entry.status !== 'RESULT_POST_FAILED') entry.status = 'RESULTS_OVERDUE';
    entry.lastUpdatedAt = now;
  }

  const counts = getResultLedgerCounts();
  console.log(
    `RESULT-LEDGER-SUMMARY tracked=${counts.tracked} awaiting=${counts.awaiting} partial=${counts.partial} ` +
      `complete=${counts.complete} overdue=${counts.overdue} postFailed=${counts.postFailed}`,
  );
}

async function processResultMonitorPacket(packet) {
  logResultScores(packet);
  const monitorPayload = buildResultMonitorPayload(packet);
  const observation = recordResultLedgerObservation(packet, monitorPayload);
  let monitorResult = null;

  if (!observation?.isComplete) {
    return {
      monitorPayload,
      monitorResult,
    };
  }

  try {
    monitorResult = await postResultMonitorPayloadWithLedger(observation.entry, monitorPayload);
    console.log(
      `RESULT-MONITOR-POSTED providerEventId=${monitorPayload.providerEventId || 'not found'} ` +
        `matches=${monitorPayload.matches.length} ok=${monitorResult.ok ?? 'unknown'}`,
    );
  } catch (error) {
    console.log(
      `RESULT-MONITOR-NOT-POSTED providerEventId=${monitorPayload.providerEventId || 'not found'} ` +
        `reason=${error.message || error}`,
    );
  }

  return {
    monitorPayload,
    monitorResult,
  };
}

async function captureResultEventDetailJson(summary, json) {
  await fs.promises.mkdir(path.join('data', 'captured'), { recursive: true });
  const safeProviderEventId = String(summary.providerEventId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const filePath = path.join('data', 'captured', `result-event-${safeProviderEventId}.json`);
  await fs.promises.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return filePath;
}

function logVirtualApiPosted({ providerEventId, week, firstMatch, batchId }) {
  console.log(
    `VIRTUAL-API-POSTED providerEventId=${providerEventId || 'not found'} ` +
      `week=${week || 'not found'} firstMatch=${firstMatch || 'not found'} batchId=${batchId || ''}`,
  );
}

function logVirtualApiNotPosted({ source, reason, providerEventId, domFirst, feedFirst }) {
  const sourcePart = source ? `source=${source} ` : '';
  console.log(
    `VIRTUAL-API-NOT-POSTED ${sourcePart}reason=${reason || 'not-posted'} ` +
      `providerEventId=${providerEventId || 'not found'} domFirst=${domFirst || 'not found'} feedFirst=${feedFirst || 'not found'}`,
  );
}

function logStatusWaitingCountdown(secondsRemaining) {
  console.log(`STATUS posted=false waiting=countdown secondsRemaining=${secondsRemaining ?? 'not found'}`);
}

function logStatusPosted(providerEventId) {
  console.log(`STATUS posted=true providerEventId=${providerEventId || 'not found'}`);
}

function extractEventFeedIdFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const markerIndex = pathname.indexOf(EVENT_DETAIL_URL_MARKER);

    if (markerIndex === -1) {
      return '';
    }

    return decodeURIComponent(pathname.slice(markerIndex + EVENT_DETAIL_URL_MARKER.length).split('/')[0] || '');
  } catch {
    return '';
  }
}

function getJsonFirstRow(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  if (!value || typeof value !== 'object') {
    return value ?? null;
  }

  if (Array.isArray(value.events)) {
    return value.events[0] ?? null;
  }

  if (Array.isArray(value.data)) {
    return value.data[0] ?? null;
  }

  if (Array.isArray(value.items)) {
    return value.items[0] ?? null;
  }

  return Object.fromEntries(Object.entries(value).slice(0, 5));
}

function classifyTraceNetworkUrl(url) {
  if (url.includes(FEED_URL_MARKER)) {
    return 'feed-events';
  }

  if (url.includes(EVENT_DETAIL_URL_MARKER)) {
    return 'event-detail';
  }

  return 'other';
}

function summarizeTraceFeedEvents(json) {
  const boardPayload = parseFeedEventsBoards(json)[0] ?? parseFeedEventsBoard(json);
  const counts = getBoardPayloadCounts(boardPayload);

  return {
    providerEventId: boardPayload?.providerEventId ?? '',
    week: boardPayload?.weekNumber ?? '',
    firstMatch: boardPayload?.firstMatch ?? '',
    eventCount: counts.eventCount,
  };
}

function summarizeTraceEventDetail(json, url) {
  const event = getEventDetailObject(json);
  const eventFeedId = String(event?.a ?? extractEventFeedIdFromUrl(url) ?? '');
  const parsedEventDetail = parseCapturedEventDetail({
    json,
    eventFeedId,
  });
  const counts = getCanonicalEventCounts(parsedEventDetail.canonicalEvents);

  return {
    providerEventId: eventFeedId,
    week: getEventDetailWeek(parsedEventDetail.event),
    firstMatch: getEventDetailFirstMatchText(parsedEventDetail.matches, parsedEventDetail.canonicalEvents),
    marketCount: counts.marketCount,
    selectionCount: counts.selectionCount,
  };
}

function createNetworkTraceRecorder(page) {
  assertUsablePage(page);

  if (!TRACE_NETWORK) {
    return null;
  }

  const pending = [];

  const onResponse = (response) => {
    const url = response.url();

    if (!url.includes('/engine/shop/feed/')) {
      return;
    }

    const capturePromise = (async () => {
      const time = new Date().toISOString();
      const type = classifyTraceNetworkUrl(url);
      let body = '';
      let contentLength = response.headers()['content-length'] ?? '';
      let parseFailed = false;
      let summary = null;

      try {
        body = await response.text();
        contentLength = contentLength || String(Buffer.byteLength(body, 'utf8'));

        const json = JSON.parse(body);
        if (type === 'feed-events') {
          summary = summarizeTraceFeedEvents(json);
        } else if (type === 'event-detail') {
          summary = summarizeTraceEventDetail(json, url);
        }
      } catch {
        parseFailed = true;
        if (!contentLength && body) {
          contentLength = String(Buffer.byteLength(body, 'utf8'));
        }
      }

      const lines = [
        '==============================',
        'NETWORK RESPONSE',
        `time=${time}`,
        `status=${response.status()}`,
        `url=${url}`,
        `contentLength=${contentLength || 'not found'}`,
        `type=${type}`,
      ];

      if (parseFailed) {
        lines.push(`time=${time} PARSE FAILED`);
      } else if (type === 'feed-events') {
        lines.push(`providerEventId=${summary?.providerEventId || 'not found'}`);
        lines.push(`week=${summary?.week || 'not found'}`);
        lines.push(`firstMatch=${summary?.firstMatch || 'not found'}`);
        lines.push(`eventCount=${summary?.eventCount ?? 'not found'}`);
      } else if (type === 'event-detail') {
        lines.push(`providerEventId=${summary?.providerEventId || 'not found'}`);
        lines.push(`week=${summary?.week || 'not found'}`);
        lines.push(`firstMatch=${summary?.firstMatch || 'not found'}`);
        if (LOG_ODDS_DETAILS) {
          lines.push(`marketCount=${summary?.marketCount ?? 'not found'}`);
          lines.push(`selectionCount=${summary?.selectionCount ?? 'not found'}`);
        }
      }

      lines.push('==============================');
      console.log(lines.join('\n'));
    })();

    pending.push(capturePromise);
  };

  page.on('response', onResponse);
  console.log(`time=${new Date().toISOString()} TRACE_NETWORK=true. Network Trace Mode enabled.`);

  return {
    dispose() {
      page.off('response', onResponse);
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

function isTransitionTraceUrl(url) {
  return (
    url.includes('/engine/shop/feed/') ||
    url.includes('/engine/shop/account/') ||
    url.includes('jackpot') ||
    url.includes('verifyAuthSession') ||
    url.includes('data:image/svg+xml')
  );
}

function summarizeTransitionEventDetail(json, url) {
  const event = getEventDetailObject(json);
  const eventFeedId = String(event?.a ?? extractEventFeedIdFromUrl(url) ?? '');
  const parsedEventDetail = parseCapturedEventDetail({
    json,
    eventFeedId,
  });
  const firstMatch = parsedEventDetail.matches?.[0]?.b ?? parsedEventDetail.matches?.[0] ?? {};

  return {
    providerEventId: eventFeedId,
    eventStatus: event?.c ?? event?.status ?? 'not found',
    week: getEventDetailWeek(parsedEventDetail.event),
    firstMatch: getEventDetailFirstMatchText(parsedEventDetail.matches, parsedEventDetail.canonicalEvents),
    matchStatus: firstMatch?.c ?? firstMatch?.status ?? 'not found',
  };
}

function createTransitionTraceRecorder(page, options = {}) {
  assertUsablePage(page);

  if (!TRACE_TRANSITION) {
    return null;
  }

  const readTransitionVisibleFirstMatch = options.readVisibleFirstMatch ?? null;
  const readTransitionVisibleCountdown = options.readVisibleCountdown ?? null;
  let active = false;
  let sequence = 0;
  let startedAt = 0;
  let oldFirst = '';
  let domChangedAt = 0;
  let latestDomFirst = '';
  let lastDomLoggedAt = 0;
  let armedUntilCountdownReset = false;
  let domInterval = null;
  let domReadInProgress = false;
  const eventDetails = [];
  const eventStatusesByProviderEventId = new Map();
  const loggedNotPostedKeys = new Set();
  const pending = [];

  const resetWindow = () => {
    if (domInterval) {
      clearInterval(domInterval);
      domInterval = null;
    }
    active = false;
    startedAt = 0;
    oldFirst = '';
    domChangedAt = 0;
    latestDomFirst = '';
    lastDomLoggedAt = 0;
    eventDetails.length = 0;
    eventStatusesByProviderEventId.clear();
    loggedNotPostedKeys.clear();
  };

  const readAndLogDom = async () => {
    if (!active || domReadInProgress || !readTransitionVisibleFirstMatch || !readTransitionVisibleCountdown) {
      return;
    }

    domReadInProgress = true;
    try {
      const visibleFirstMatch = await readTransitionVisibleFirstMatch().catch(() => null);
      const countdown = await readTransitionVisibleCountdown().catch(() => ({ found: false }));
      traceApi.updateDom(visibleFirstMatch, countdown);
    } finally {
      domReadInProgress = false;
    }
  };

  const endWindow = () => {
    if (!active) {
      return;
    }

    const domFirst = latestDomFirst || oldFirst || 'not found';
    const matchingEventDetailSeen = eventDetails.some((entry) => entry.firstMatch === domFirst);
    if (!matchingEventDetailSeen) {
      console.log(`TRANSITION-NO-ACTIVITY no /feed/event response seen for domFirst=${domFirst}`);
    }

    resetWindow();
  };

  const onRequest = (request) => {
    if (!active) {
      return;
    }

    const url = request.url();
    if (!isTransitionTraceUrl(url)) {
      return;
    }

    sequence += 1;
    console.log(`TRANSITION-REQUEST #${sequence} method=${request.method()} url=${url} time=${new Date().toISOString()}`);
  };

  const onResponse = (response) => {
    if (!active) {
      return;
    }

    const url = response.url();
    if (!isTransitionTraceUrl(url)) {
      return;
    }

    const capturePromise = (async () => {
      sequence += 1;
      const type = classifyTraceNetworkUrl(url);
      console.log(
        `TRANSITION-RESPONSE #${sequence} status=${response.status()} type=${type} url=${url} time=${new Date().toISOString()}`,
      );

      if (type !== 'event-detail') {
        return;
      }

      try {
        const json = JSON.parse(await response.text());
        const summary = summarizeTransitionEventDetail(json, url);
        eventDetails.push(summary);
        eventStatusesByProviderEventId.set(summary.providerEventId, summary.eventStatus);
        console.log(
          `TRANSITION-EVENT-DETAIL providerEventId=${summary.providerEventId || 'not found'} ` +
            `eventStatus=${summary.eventStatus || 'not found'} week=${summary.week || 'not found'} ` +
            `firstMatch=${summary.firstMatch || 'not found'} matchStatus=${summary.matchStatus || 'not found'}`,
        );
      } catch (error) {
        console.log(`TRANSITION-EVENT-DETAIL-PARSE-FAILED url=${url} reason=${error.message || error}`);
      }
    })();

    pending.push(capturePromise);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  console.log(`time=${new Date().toISOString()} TRACE_TRANSITION=true. Transition Trace Mode enabled.`);

  const traceApi = {
    start(visibleFirstMatch, countdown) {
      if (active || armedUntilCountdownReset) {
        return;
      }

      active = true;
      startedAt = Date.now();
      oldFirst = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : 'not found';
      latestDomFirst = oldFirst;
      console.log(
        `TRANSITION-START oldFirst=${oldFirst} countdown=${countdown?.text ?? countdown?.totalSeconds ?? 'not found'} ` +
          `time=${new Date().toISOString()}`,
      );
      domInterval = setInterval(() => {
        readAndLogDom().catch((error) => {
          console.log(`TRANSITION-DOM error=${error.message || error} time=${new Date().toISOString()}`);
        });
      }, 1000);
      domInterval.unref?.();
    },
    updateDom(visibleFirstMatch, countdown) {
      if (!active) {
        if (!countdown?.found || countdown.totalSeconds > 10) {
          armedUntilCountdownReset = false;
        }
        return;
      }

      const now = Date.now();
      const firstMatch = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : 'not found';
      latestDomFirst = firstMatch;

      if (firstMatch !== oldFirst && !domChangedAt) {
        domChangedAt = now;
      }

      if (now - lastDomLoggedAt >= 1000) {
        lastDomLoggedAt = now;
        console.log(
          `TRANSITION-DOM firstMatch=${firstMatch} countdown=${countdown?.text ?? countdown?.totalSeconds ?? 'not found'} ` +
            `week=${visibleFirstMatch?.visibleWeek ?? 'not found'} time=${new Date().toISOString()}`,
        );
      }

      if ((domChangedAt && now - domChangedAt >= 20_000) || now - startedAt >= 30_000) {
        armedUntilCountdownReset = true;
        endWindow();
      }
    },
    recordEventDetailResult(result) {
      if (!active || result?.source !== 'event-detail' || result.posted) {
        return;
      }

      const providerEventId = result.providerEventId || result.eventFeedId || '';
      const key = `${providerEventId}:${result.reason || 'not-posted'}:${result.domFirst || ''}:${result.feedFirst || ''}`;
      if (loggedNotPostedKeys.has(key)) {
        return;
      }

      loggedNotPostedKeys.add(key);
      console.log(
        `TRANSITION-NOT-POSTED reason=${result.reason || 'not-posted'} providerEventId=${providerEventId || 'not found'} ` +
          `domFirst=${result.domFirst || 'not found'} feedFirst=${result.feedFirst || 'not found'} ` +
          `eventStatus=${eventStatusesByProviderEventId.get(providerEventId) || 'not found'}`,
      );
    },
    dispose() {
      if (domInterval) {
        clearInterval(domInterval);
        domInterval = null;
      }
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };

  return traceApi;
}

function createTransitionProofRecorder(page, options = {}) {
  assertUsablePage(page);

  if (!TRACE_TRANSITION_PROOF) {
    return null;
  }

  const readTransitionVisibleFirstMatch = options.readVisibleFirstMatch ?? null;
  const readTransitionVisibleCountdown = options.readVisibleCountdown ?? null;
  let active = false;
  let armedUntilCountdownReset = false;
  let startedAt = 0;
  let oldFirst = '';
  let latestDomFirst = '';
  let domChangedAt = 0;
  let domChangedFirst = '';
  let notPostedLogged = false;
  let responseId = 0;
  let lastDomLoggedAt = 0;
  let domInterval = null;
  let domReadInProgress = false;
  let latestFeedBoardList = [];
  const pending = [];

  const resetWindow = () => {
    if (domInterval) {
      clearInterval(domInterval);
      domInterval = null;
    }
    active = false;
    startedAt = 0;
    oldFirst = '';
    latestDomFirst = '';
    domChangedAt = 0;
    domChangedFirst = '';
    notPostedLogged = false;
    lastDomLoggedAt = 0;
    latestFeedBoardList = [];
  };

  const getNotPostedReason = () => {
    if (!domChangedFirst) {
      return 'dom-not-changed';
    }

    return latestFeedBoardList.some((board) => board.firstMatch === domChangedFirst)
      ? 'feed-match-seen-no-post'
      : 'dom-not-found-in-feed';
  };

  const compareDomToLatestFeed = (firstMatch) => {
    const found = latestFeedBoardList.find((board) => board.firstMatch === firstMatch);

    if (found) {
      console.log(
        `DOM-FOUND-IN-FEED providerEventId=${found.providerEventId || 'not found'} ` +
          `week=${found.weekNumber || 'not found'} firstMatch=${found.firstMatch || 'not found'}`,
      );
    } else {
      console.log(`DOM-NOT-FOUND-IN-FEED firstMatch=${firstMatch || 'not found'}`);
    }
  };

  const updateDomState = (visibleFirstMatch, countdown, options = {}) => {
    if (!active) {
      if (!countdown?.found || countdown.totalSeconds > 10) {
        armedUntilCountdownReset = false;
      }
      return;
    }

    const now = Date.now();
    const firstMatch = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : 'not found';
    latestDomFirst = firstMatch;
    if (options.forceLog || now - lastDomLoggedAt >= 1000) {
      lastDomLoggedAt = now;
      console.log(`TRANSITION-DOM firstMatch=${firstMatch} countdown=${countdown?.text ?? countdown?.totalSeconds ?? 'not found'}`);
    }

    if (!domChangedAt && oldFirst && firstMatch && firstMatch !== 'not found' && firstMatch !== oldFirst) {
      domChangedAt = now;
      domChangedFirst = firstMatch;
      console.log(`DOM-CHANGED oldFirst=${oldFirst} newFirst=${firstMatch}`);
      compareDomToLatestFeed(firstMatch);
    }

    if (domChangedAt && !notPostedLogged && now - domChangedAt >= 10_000) {
      notPostedLogged = true;
      console.log(`TRANSITION-NOT-POSTED newFirst=${domChangedFirst || 'not found'} reason=${getNotPostedReason()}`);
    }

    if (now - startedAt >= 25_000) {
      armedUntilCountdownReset = true;
      resetWindow();
    }
  };

  const readAndLogDom = async () => {
    if (!active || domReadInProgress || !readTransitionVisibleFirstMatch || !readTransitionVisibleCountdown) {
      return;
    }

    domReadInProgress = true;
    try {
      const visibleFirstMatch = await readTransitionVisibleFirstMatch().catch(() => null);
      const countdown = await readTransitionVisibleCountdown().catch(() => ({ found: false }));
      updateDomState(visibleFirstMatch, countdown);
    } finally {
      domReadInProgress = false;
    }
  };

  const onResponse = (response) => {
    if (!active) {
      return;
    }

    const url = response.url();
    if (!url.includes(FEED_URL_MARKER) && !url.includes(EVENT_DETAIL_URL_MARKER)) {
      return;
    }

    const currentResponseId = responseId + 1;
    responseId = currentResponseId;
    console.log(`TRANSITION-PROOF-RESPONSE responseId=${currentResponseId} status=${response.status()} url=${url}`);

    if (!url.includes(FEED_URL_MARKER)) {
      return;
    }

    const capturePromise = (async () => {
      let boardPayloads = [];

      try {
        boardPayloads = parseFeedEventsBoards(JSON.parse(await response.text()));
      } catch (error) {
        console.log(`FEED-BOARD-LIST responseId=${currentResponseId} PARSE-FAILED reason=${error.message || error}`);
        return;
      }

      latestFeedBoardList = boardPayloads;
      console.log(`FEED-BOARD-LIST responseId=${currentResponseId}`);
      boardPayloads.forEach((payload, index) => {
        console.log(
          `${index + 1} providerEventId=${payload.providerEventId || 'not found'} ` +
            `week=${payload.weekNumber || 'not found'} firstMatch=${payload.firstMatch || 'not found'}`,
        );
      });

      if (domChangedFirst) {
        compareDomToLatestFeed(domChangedFirst);
      }
    })();

    pending.push(capturePromise);
  };

  page.on('response', onResponse);
  console.log(`time=${new Date().toISOString()} TRACE_TRANSITION_PROOF=true. Transition Proof Mode enabled.`);

  return {
    start(visibleFirstMatch, countdown) {
      if (active || armedUntilCountdownReset) {
        return;
      }

      active = true;
      startedAt = Date.now();
      oldFirst = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : 'not found';
      latestDomFirst = oldFirst;
      console.log(`TRANSITION-PROOF-START oldFirst=${oldFirst} countdown=${countdown?.text ?? countdown?.totalSeconds ?? 'not found'}`);
      updateDomState(visibleFirstMatch, countdown, { forceLog: true });
      domInterval = setInterval(() => {
        readAndLogDom().catch((error) => {
          console.log(`TRANSITION-DOM error=${error.message || error}`);
        });
      }, 1000);
      domInterval.unref?.();
    },
    updateDom(visibleFirstMatch, countdown) {
      updateDomState(visibleFirstMatch, countdown);
    },
    recordFeedEventsPost(result) {
      if (!active || result?.source !== FEED_EVENTS_SOURCE || !result.posted) {
        return;
      }

      console.log(
        `TRANSITION-POSTED source=feed-events providerEventId=${result.providerEventId || 'not found'} ` +
          `firstMatch=${result.firstMatch || result.feedFirst || 'not found'}`,
      );

      if (domChangedFirst && (result.firstMatch === domChangedFirst || result.feedFirst === domChangedFirst)) {
        notPostedLogged = true;
      }
    },
    dispose() {
      if (domInterval) {
        clearInterval(domInterval);
        domInterval = null;
      }
      page.off('response', onResponse);
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

function createResultEventDetailCapture(page, options = {}) {
  assertUsablePage(page);

  if (!CAPTURE_RESULT_EVENT_DETAIL) {
    return null;
  }

  const getCycle = options.getCycle ?? (() => 0);
  const pending = [];
  const latestByProviderEventId = new Map();
  const resultSeenCycles = new Set();
  const loggedNotSeen = new Set();

  const onResponse = (response) => {
    const url = response.url();

    if (!url.includes(EVENT_DETAIL_URL_MARKER)) {
      return;
    }

    const capturePromise = (async () => {
      let json = null;
      let summary = null;

      try {
        json = await response.json();
        summary = summarizeResultEventDetail(json, url);
      } catch (error) {
        console.log(`RESULT-CAPTURE-PARSE-FAILED url=${url} reason=${error.message || error}`);
        return;
      }

      latestByProviderEventId.set(summary.providerEventId, {
        cycle: getCycle(),
        summary,
        capturedAt: Date.now(),
      });

      if (!summary.resultLike) {
        return;
      }

      resultSeenCycles.add(getCycle());
      const filePath = await captureResultEventDetailJson(summary, json);
      console.log(
        `RESULT-CAPTURED providerEventId=${summary.providerEventId || 'not found'} week=${summary.week || 'not found'} ` +
          `eventState=${summary.eventState || 'not found'} boardState=${summary.boardState || 'not found'} ` +
          `matchCount=${summary.matchCount} file=${filePath}`,
      );
      summary.matchSummaries.forEach((match) => {
        console.log(
          `RESULT-MATCH index=${match.index} teams="${match.teams || 'not found'}" ` +
            `status=${match.status || 'not found'} score=${match.score || 'not found'} ` +
            `rawScoreFields=${JSON.stringify(match.rawScoreFields)}`,
        );
      });
    })();

    pending.push(capturePromise);
  };

  page.on('response', onResponse);
  console.log(`time=${new Date().toISOString()} CAPTURE_RESULT_EVENT_DETAIL=true. Result event-detail capture enabled.`);

  return {
    markCycle(providerEventId) {
      if (!providerEventId) {
        return;
      }

      const cycle = getCycle();
      const key = `${cycle}:${providerEventId}`;
      if (loggedNotSeen.has(key) || resultSeenCycles.has(cycle)) {
        return;
      }

      const latest = latestByProviderEventId.get(String(providerEventId));
      console.log(
        `RESULT-NOT-SEEN providerEventId=${providerEventId} ` +
          `lastStates=${JSON.stringify(latest?.summary?.lastStates ?? [])}`,
      );
      loggedNotSeen.add(key);
    },
    dispose() {
      page.off('response', onResponse);
    },
    async flush() {
      await Promise.allSettled(pending);
    },
  };
}

function summarizeJsonFirstRow(body, contentType) {
  const trimmedBody = body.trim();
  const looksLikeJson = trimmedBody.startsWith('{') || trimmedBody.startsWith('[');

  if (!contentType.toLowerCase().includes('json') && !looksLikeJson) {
    return null;
  }

  try {
    return getJsonFirstRow(JSON.parse(trimmedBody));
  } catch {
    return null;
  }
}

function rankTransitionEndpoints(entries) {
  const rankings = new Map();

  entries.forEach((entry) => {
    const current = rankings.get(entry.url) ?? {
      url: entry.url,
      count: 0,
      totalResponseSize: 0,
      maxResponseSize: 0,
    };

    current.count += 1;
    current.totalResponseSize += entry.responseSize;
    current.maxResponseSize = Math.max(current.maxResponseSize, entry.responseSize);
    rankings.set(entry.url, current);
  });

  return Array.from(rankings.values())
    .map((entry) => ({
      ...entry,
      averageResponseSize: entry.count ? Math.round(entry.totalResponseSize / entry.count) : 0,
    }))
    .sort((a, b) => b.count - a.count || b.totalResponseSize - a.totalResponseSize);
}

function createTransitionNetworkRecorder(page) {
  assertUsablePage(page);

  const entries = [];
  const pending = [];
  const startedAt = new Date().toISOString();

  const onResponse = (response) => {
    const request = response.request();
    const resourceType = request.resourceType();

    if (resourceType !== 'xhr' && resourceType !== 'fetch') {
      return;
    }

    const capturePromise = (async () => {
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      let body = '';
      let bodyError = null;

      try {
        body = await response.text();
      } catch (error) {
        bodyError = error.message || String(error);
      }

      const entry = {
        url: response.url(),
        method: request.method(),
        status: response.status(),
        responseSize: Buffer.byteLength(body, 'utf8'),
        contentType,
        jsonFirstRow: bodyError ? null : summarizeJsonFirstRow(body, contentType),
        bodyError,
      };

      entries.push(entry);
      console.log(
        `transition network: ${entry.method} ${entry.status} ${entry.responseSize}b ${entry.url}` +
          (entry.jsonFirstRow ? ` firstJsonRow=${JSON.stringify(entry.jsonFirstRow).slice(0, 500)}` : ''),
      );
    })();

    pending.push(capturePromise);
  };

  page.on('response', onResponse);

  return {
    async stop(finalVisibleMatch) {
      page.off('response', onResponse);
      await Promise.allSettled(pending);

      const rankings = rankTransitionEndpoints(entries);
      const payload = {
        startedAt,
        endedAt: new Date().toISOString(),
        finalVisibleFirstRow: finalVisibleMatch,
        entries,
        rankings,
      };

      await fs.promises.mkdir(path.dirname(TRANSITION_NETWORK_FILE), { recursive: true });
      await fs.promises.writeFile(TRANSITION_NETWORK_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

      console.log(`saved transition network capture to ${TRANSITION_NETWORK_FILE}`);
      console.log('transition endpoints by frequency/size:');
      rankings.slice(0, 20).forEach((entry) => {
        console.log(
          `${entry.count}x total=${entry.totalResponseSize}b max=${entry.maxResponseSize}b avg=${entry.averageResponseSize}b ${entry.url}`,
        );
      });

      return payload;
    },
  };
}

function createFeedEventsCapture(page, options = {}) {
  assertUsablePage(page);

  const captures = [];
  const pending = [];
  const processedResults = [];
  const processedWaiters = [];
  const feedEventsByProviderEventId = new Map();
  const feedEventsByWeekNumber = new Map();
  const feedEventsByFirstMatch = new Map();
  const feedEventsByCompositeKey = new Map();
  let latestFeedEventsRaw = null;
  let latestMappedFeed = null;
  let feedEventsResponseId = 0;

  const getCycle = options.getCycle ?? (() => 0);
  const lastPostedState = options.lastPostedState;
  const onFeedEvents200 = options.onFeedEvents200 ?? (() => {});
  const onProcessed = options.onProcessed ?? (() => {});
  const onAuthenticationFailure = options.onAuthenticationFailure ?? (() => {});
  const getVisibleFirstMatch = options.getVisibleFirstMatch ?? null;
  const getLatestVisibleCountdown = options.getLatestVisibleCountdown ?? (() => null);
  const getLatestVisibleCountdownInitialized = options.getLatestVisibleCountdownInitialized ?? (() => true);
  const initializeLatestVisibleCountdown = options.initializeLatestVisibleCountdown ?? (async () => getLatestVisibleCountdown());
  const getRolloverState = options.getRolloverState ?? (() => ({ stable: true, visibleFirstMatch: null }));
  const getPendingDomRefresh = options.getPendingDomRefresh ?? (() => ({ pending: false }));
  const clearPendingDomRefresh = options.clearPendingDomRefresh ?? (() => {});
  const getLastRolloverPostFailed = options.getLastRolloverPostFailed ?? (() => false);
  const clearLastRolloverPostFailed = options.clearLastRolloverPostFailed ?? (() => {});
  const markStartupInitialPost = options.markStartupInitialPost ?? (() => {});
  const getFeedEventsPostingEnabled = options.getFeedEventsPostingEnabled ?? (() => true);
  const storeFeedEventsBoardPayload = (capture, boardPayload) => {
    if (!boardPayload) {
      return;
    }

    const entry = {
      ...boardPayload,
      capture,
      storedAt: Date.now(),
    };

    if (boardPayload.providerEventId) {
      if (!feedEventsByProviderEventId.has(boardPayload.providerEventId)) {
        feedEventsByProviderEventId.set(boardPayload.providerEventId, []);
      }
      feedEventsByProviderEventId.get(boardPayload.providerEventId).push(entry);
    }

    if (boardPayload.weekNumber) {
      if (!feedEventsByWeekNumber.has(boardPayload.weekNumber)) {
        feedEventsByWeekNumber.set(boardPayload.weekNumber, []);
      }
      feedEventsByWeekNumber.get(boardPayload.weekNumber).push(entry);
    }

    if (boardPayload.firstMatch) {
      if (!feedEventsByFirstMatch.has(boardPayload.firstMatch)) {
        feedEventsByFirstMatch.set(boardPayload.firstMatch, []);
      }
      feedEventsByFirstMatch.get(boardPayload.firstMatch).push(entry);
    }

    const compositeKey = [
      boardPayload.providerEventId || 'unknown',
      boardPayload.weekNumber || 'unknown',
      boardPayload.firstMatch || 'unknown',
    ].join('|');
    if (!feedEventsByCompositeKey.has(compositeKey)) {
      feedEventsByCompositeKey.set(compositeKey, []);
    }
    feedEventsByCompositeKey.get(compositeKey).push(entry);

    console.log(
      `FEED-EVENTS-ITEM providerEventId=${boardPayload.providerEventId || 'not found'} ` +
        `week=${boardPayload.weekNumber || 'not found'} firstMatch=${boardPayload.firstMatch || 'not found'}`,
    );
  };
  const recordProcessedResult = (capture, result) => {
    const entry = {
      processedAt: Date.now(),
      capture,
      result,
    };

    processedResults.push(entry);
    while (processedResults.length > 50) {
      processedResults.shift();
    }

    processedWaiters.slice().forEach((waiter) => waiter(entry));
  };

  const waitForNextFeedEvents200 = async (cycle, reason) => {
    try {
      const response = await page.waitForResponse((candidate) => {
        return (
          candidate.url().includes(FEED_URL_MARKER) &&
          candidate.request().method() === 'GET' &&
          candidate.status() === 200
        );
      }, { timeout: FEED_REFRESH_RETRY_MS });

      console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} next-feed-events-200 reason=${reason} url=${response.url()}`);
      return true;
    } catch (error) {
      console.log(
        `cycle=${cycle} source=${FEED_EVENTS_SOURCE} next-feed-events-wait-timeout ` +
          `reason=${reason} timeoutMs=${FEED_REFRESH_RETRY_MS}`,
      );
      return false;
    }
  };

  const onResponse = (response) => {
    if (!response.url().includes(FEED_URL_MARKER)) {
      return;
    }

    const capturePromise = (async () => {
      const request = response.request();

      if (request.method() !== 'GET') {
        return;
      }

      if (response.status() === 401 || response.status() === 403) {
        const body = await response.text().catch(() => '');
        console.log(
          `cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} skipped reason=auth-failure status=${response.status()} ` +
            `${response.statusText()} ${body.slice(0, 500)}`,
        );
        onAuthenticationFailure({
          reason: `feed-events-${response.status()}-${body.match(/PlayerNotAuthenticatedException/i)?.[0] ?? 'auth-failed'}`,
          status: response.status(),
          url: response.url(),
        });
        return;
      }

      if (response.status() !== 200) {
        console.log(`cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} skipped reason=status-${response.status()} url=${response.url()}`);
        return;
      }

      const json = await response.json();
      feedEventsResponseId += 1;
      let boardPayload = null;
      let boardPayloads = [];
      try {
        boardPayloads = parseFeedEventsBoards(json);
        boardPayload = boardPayloads[0] ?? null;
      } catch (error) {
        console.log(`cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} map failed reason=${error.message || error}`);
      }
      console.log(
        `FEED-CAPTURED providerEventId=${boardPayload?.providerEventId ?? 'not found'} ` +
          `firstMatch=${boardPayload?.firstMatch ?? 'not found'} week=${boardPayload?.weekNumber ?? 'not found'}`,
      );
      logFeedEventsOddsQueue(feedEventsResponseId, boardPayloads);
      const capture = {
        url: response.url(),
        json,
        boardPayload,
        capturedAt: Date.now(),
        generation: lastPostedState?.generation ?? 0,
        mode: 'response-listener',
      };
      postFeedEventsQueueInBackground(getCycle(), boardPayloads, capture.capturedAt);

      latestFeedEventsRaw = json;
      latestMappedFeed = boardPayload;
      captures.push(capture);
      boardPayloads.forEach((payload) => {
        storeFeedEventsBoardPayload(capture, payload);
      });
      console.log(
        `FEED-STORED providerEventId=${boardPayload?.providerEventId ?? 'not found'} firstMatch=${boardPayload?.firstMatch ?? 'not found'}`,
      );
      onFeedEvents200(capture);

      if (!lastPostedState) {
        return;
      }

      const passiveVisibleFirstMatch = boardPayload && getVisibleFirstMatch
        ? await getVisibleFirstMatch().catch(() => null)
        : null;
      const passiveDomFirst = passiveVisibleFirstMatch ? getVisibleText(passiveVisibleFirstMatch) : '';
      const domMatchedBoardPayload = passiveDomFirst
        ? boardPayloads.find((payload) => payload?.firstMatch === passiveDomFirst) ?? null
        : null;
      const feedEventsMatchesDom = Boolean(domMatchedBoardPayload);
      const pendingDomRefresh = getPendingDomRefresh();

      if (domMatchedBoardPayload && passiveVisibleFirstMatch) {
        const wasInitialFeedPost = !lastPostedState.providerEventId;
        const wasRolloverRetryPost = getLastRolloverPostFailed();
        const result = await postFeedEventsBoard(getCycle(), domMatchedBoardPayload, lastPostedState, {
          feedReceivedAt: capture.capturedAt,
          generation: capture.generation,
          visibleFirstMatch: passiveVisibleFirstMatch,
          previousCycleTiming: options.getPreviousCycleTiming?.() ?? null,
        });

        if (result?.posted) {
          if (wasInitialFeedPost) {
            result.initialPost = true;
            markStartupInitialPost(passiveDomFirst);
            console.log(`cycle=${getCycle()} ACTION initial-post`);
          }
          if (wasRolloverRetryPost) {
            clearLastRolloverPostFailed();
            console.log(`cycle=${getCycle()} ACTION late-cycle-post-success`);
          }
        } else {
          logFeedEventsVirtualApiNotPosted(result);
        }

        if (pendingDomRefresh.pending && (result?.posted || result?.mismatch)) {
          clearPendingDomRefresh();
        }
        recordProcessedResult(capture, result);
        onProcessed(result);
        return;
      }

      if (!getFeedEventsPostingEnabled() && !feedEventsMatchesDom) {
        const reason = 'event-detail-primary';
        console.log(
          `cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} discovery-only reason=${reason} ` +
            `providerEventId=${boardPayload?.providerEventId ?? 'not found'} week=${boardPayload?.weekNumber ?? 'not found'}`,
        );
        console.log(`FEED-POST-GATED reason=${reason}`);
        recordProcessedResult(capture, {
          posted: false,
          source: FEED_EVENTS_SOURCE,
          discoveryOnly: true,
          reason,
          providerEventId: boardPayload?.providerEventId ?? '',
          domFirst: passiveDomFirst,
          feedFirst: boardPayload?.firstMatch ?? '',
        });
        logFeedEventsVirtualApiNotPosted({
          reason,
          providerEventId: boardPayload?.providerEventId ?? '',
          domFirst: passiveDomFirst,
          feedFirst: boardPayload?.firstMatch ?? '',
        });
        return;
      }

      if (boardPayload && !pendingDomRefresh.pending && !lastPostedState.providerEventId && getVisibleFirstMatch) {
        const initialVisibleFirstMatch = passiveVisibleFirstMatch ?? await getVisibleFirstMatch().catch(() => null);
        const domFirst = initialVisibleFirstMatch ? getVisibleText(initialVisibleFirstMatch) : '';
        const feedFirst = boardPayload.firstMatch ?? '';

        if (initialVisibleFirstMatch) {
          if (domFirst && feedFirst && domFirst === feedFirst) {
            const result = await handleFeedEventsResponse(getCycle(), json, lastPostedState, {
              feedReceivedAt: capture.capturedAt,
              generation: capture.generation,
              visibleFirstMatch: initialVisibleFirstMatch,
              previousCycleTiming: options.getPreviousCycleTiming?.() ?? null,
            });

            if (result?.posted) {
              result.initialPost = true;
              markStartupInitialPost(domFirst);
              console.log(`cycle=${getCycle()} ACTION initial-post`);
            } else {
              logFeedEventsVirtualApiNotPosted(result);
            }

            recordProcessedResult(capture, result);
            onProcessed(result);
            return;
          }
        }

        console.log(
          `cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} skipped reason=initial-warmup-mismatch ` +
            `domFirst=${domFirst || 'not found'} feedFirst=${feedFirst || 'not found'}`,
        );
        console.log('FEED-POST-GATED reason=initial-warmup-mismatch');
        logFeedEventsVirtualApiNotPosted({
          reason: 'initial-warmup-mismatch',
          domFirst,
          feedFirst,
          providerEventId: boardPayload.providerEventId,
        });
      }

      const countdownWasInitialized = getLatestVisibleCountdownInitialized();
      const latestVisibleCountdown = countdownWasInitialized
        ? getLatestVisibleCountdown()
        : await initializeLatestVisibleCountdown();
      if (
        boardPayload &&
        !pendingDomRefresh.pending &&
        getLastRolloverPostFailed() &&
        getVisibleFirstMatch
      ) {
        const lateVisibleFirstMatch = await getVisibleFirstMatch().catch(() => null);
        const lateBoardPayload = boardPayload;
        const currentDomFirst = lateVisibleFirstMatch ? getVisibleText(lateVisibleFirstMatch) : '';
        const feedFirst = lateBoardPayload.firstMatch ?? '';
        const providerEventId = lateBoardPayload.providerEventId ?? '';

        if (
          currentDomFirst &&
          feedFirst &&
          currentDomFirst === feedFirst &&
          providerEventId &&
          providerEventId !== lastPostedState.providerEventId
        ) {
          const result = await handleFeedEventsResponse(getCycle(), json, lastPostedState, {
            feedReceivedAt: capture.capturedAt,
            generation: capture.generation,
            visibleFirstMatch: lateVisibleFirstMatch,
            previousCycleTiming: options.getPreviousCycleTiming?.() ?? null,
          });

          if (result?.posted) {
            clearLastRolloverPostFailed();
            console.log(`cycle=${getCycle()} ACTION late-cycle-post-success`);
          } else {
            logFeedEventsVirtualApiNotPosted(result);
          }

          recordProcessedResult(capture, result);
          onProcessed(result);
          return;
        }
      }
      if (
        !feedEventsMatchesDom &&
        !pendingDomRefresh.pending &&
        latestVisibleCountdown &&
        latestVisibleCountdown.found &&
        latestVisibleCountdown.totalSeconds > 0
      ) {
        const reason = countdownWasInitialized ? 'countdown-not-ready' : 'countdown-not-ready-startup';
        console.log(
          `source=${FEED_EVENTS_SOURCE} ignored reason=${reason} secondsRemaining=${latestVisibleCountdown.totalSeconds}`,
        );
        console.log(`FEED-POST-GATED reason=${reason}`);
        logFeedEventsVirtualApiNotPosted({
          reason,
          domFirst: passiveDomFirst,
          feedFirst: boardPayload?.firstMatch ?? '',
          providerEventId: boardPayload?.providerEventId ?? '',
        });
        return;
      }

      const rolloverState = getRolloverState();
      const isRolloverWindow =
        latestVisibleCountdown &&
        latestVisibleCountdown.found &&
        latestVisibleCountdown.totalSeconds <= 0;
      if (
        !feedEventsMatchesDom &&
        !pendingDomRefresh.pending &&
        isRolloverWindow &&
        !rolloverState.stable
      ) {
        console.log(`source=${FEED_EVENTS_SOURCE} ignored reason=rollover-not-stable`);
        console.log('FEED-POST-GATED reason=rollover-not-stable');
        logFeedEventsVirtualApiNotPosted({
          reason: 'rollover-not-stable',
          domFirst: passiveDomFirst,
          feedFirst: boardPayload?.firstMatch ?? '',
          providerEventId: boardPayload?.providerEventId ?? '',
        });
        return;
      }

      const visibleFirstMatch = pendingDomRefresh.pending && pendingDomRefresh.visibleFirstMatch
        ? {
          ...pendingDomRefresh.visibleFirstMatch,
          text: pendingDomRefresh.firstMatch || getVisibleText(pendingDomRefresh.visibleFirstMatch),
        }
        : feedEventsMatchesDom
        ? passiveVisibleFirstMatch
        : isRolloverWindow && rolloverState.stable && rolloverState.visibleFirstMatch
        ? rolloverState.visibleFirstMatch
        : getVisibleFirstMatch ? await getVisibleFirstMatch().catch(() => null) : undefined;
      const result = await handleFeedEventsResponse(getCycle(), json, lastPostedState, {
        feedReceivedAt: capture.capturedAt,
        generation: capture.generation,
        visibleFirstMatch,
        previousCycleTiming: options.getPreviousCycleTiming?.() ?? null,
      });
      if (result?.reason === 'visible-feed-mismatch') {
        console.log(`cycle=${getCycle()} source=${FEED_EVENTS_SOURCE} visible-feed-mismatch waiting-for-dom-scheduler`);
      }
      if (!result?.posted) {
        logFeedEventsVirtualApiNotPosted(result);
      }
      if (pendingDomRefresh.pending && (result?.posted || result?.mismatch)) {
        clearPendingDomRefresh();
      }
      recordProcessedResult(capture, result);
      onProcessed(result);
    })().catch((error) => {
      console.log(`feed-events capture failed: ${error.message || error}`);
      logFeedPostGated(error.message || String(error));
      const result = {
        posted: false,
        source: FEED_EVENTS_SOURCE,
        failed: true,
        authExpired: isAuthenticationFailureMessage(error.message || error),
        reason: error.message || String(error),
      };
      recordProcessedResult(null, result);
      onProcessed(result);
    });

    pending.push(capturePromise);
  };

  page.on('response', onResponse);

  return {
    async latestSince(timestamp) {
      await Promise.allSettled(pending);
      const recentCaptures = captures.filter((capture) => capture.capturedAt >= timestamp);
      return recentCaptures[recentCaptures.length - 1] ?? null;
    },
    async latest() {
      await Promise.allSettled(pending);
      return captures[captures.length - 1] ?? null;
    },
    async latestMapped() {
      await Promise.allSettled(pending);
      return latestMappedFeed;
    },
    findByFirstMatch(firstMatch) {
      const matches = feedEventsByFirstMatch.get(firstMatch) ?? [];
      return matches[matches.length - 1] ?? null;
    },
    knownFirstMatches() {
      return Array.from(feedEventsByFirstMatch.keys());
    },
    async waitForProcessedSince(timestamp, timeoutMs = 10_000) {
      const isAfterTimestamp = (entry) => (entry.capture?.capturedAt ?? entry.processedAt) >= timestamp;
      const existing = processedResults.find(isAfterTimestamp);
      if (existing) {
        return existing;
      }

      return new Promise((resolve) => {
        const waiter = (entry) => {
          if (!isAfterTimestamp(entry)) {
            return;
          }

          clearTimeout(timeout);
          const index = processedWaiters.indexOf(waiter);
          if (index !== -1) {
            processedWaiters.splice(index, 1);
          }
          resolve(entry);
        };
        const timeout = setTimeout(() => {
          const index = processedWaiters.indexOf(waiter);
          if (index !== -1) {
            processedWaiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);

        processedWaiters.push(waiter);
      });
    },
    clear(options = {}) {
      const latestCapture = captures[captures.length - 1] ?? null;
      const shouldPreserveLatest = Boolean(
        options.preserveLatest &&
          latestCapture &&
          (!options.matchFirst || latestCapture.boardPayload?.firstMatch === options.matchFirst),
      );

      captures.length = 0;
      processedResults.length = 0;
      if (shouldPreserveLatest) {
        const preservedCapture = {
          ...latestCapture,
          generation: options.generation ?? latestCapture.generation,
        };
        captures.push(preservedCapture);
        latestFeedEventsRaw = preservedCapture.json;
        latestMappedFeed = preservedCapture.boardPayload ?? latestMappedFeed;
        return true;
      } else {
        latestFeedEventsRaw = null;
        latestMappedFeed = null;
      }

      return false;
    },
    dispose() {
      page.off('response', onResponse);
    },
  };
}

function createEventDetailCapture(page, options = {}) {
  assertUsablePage(page);

  const captures = [];
  const pending = [];
  const processedResults = [];
  const processedWaiters = [];

  const getCycle = options.getCycle ?? (() => 0);
  const getVisibleFirstMatch = options.getVisibleFirstMatch ?? null;
  const lastPostedHashes = options.lastPostedHashes ?? new Map();
  const eventDetailCache = options.eventDetailCache ?? null;
  const getLastPostedFeedProviderEventId = options.getLastPostedFeedProviderEventId ?? (() => '');
  const getPreviousCycleResultWatch = options.getPreviousCycleResultWatch ?? (() => null);
  const onProcessed = options.onProcessed ?? (() => {});
  const onCaptured = options.onCaptured ?? (() => {});
  const onAuthenticationFailure = options.onAuthenticationFailure ?? (() => {});

  const readVisibleFirstMatchWithRetry = async () => {
    if (!getVisibleFirstMatch) {
      return null;
    }

    let visibleFirstMatch = await getVisibleFirstMatch().catch(() => null);
    if (visibleFirstMatch) {
      return visibleFirstMatch;
    }

    for (const delaySeconds of [1, 2, 3]) {
      await sleep(delaySeconds * 1000);
      visibleFirstMatch = await getVisibleFirstMatch().catch(() => null);
      if (visibleFirstMatch) {
        return visibleFirstMatch;
      }
    }

    return null;
  };

  const recordProcessedResult = (capture, result) => {
    const entry = {
      processedAt: Date.now(),
      capture,
      result,
    };

    processedResults.push(entry);
    while (processedResults.length > 50) {
      processedResults.shift();
    }

    processedWaiters.slice().forEach((waiter) => waiter(entry));
  };

  const onResponse = (response) => {
    if (!response.url().includes(EVENT_DETAIL_URL_MARKER)) {
      return;
    }

    const capturePromise = (async () => {
      const request = response.request();

      if (request.method() !== 'GET') {
        return;
      }

      if (response.status() === 401 || response.status() === 403) {
        const body = await response.text().catch(() => '');
        const reason = `auth-failure status=${response.status()}`;
        console.log(
          `cycle=${getCycle()} source=event-detail skipped reason=${reason} ` +
            `${response.statusText()} ${body.slice(0, 500)}`,
        );
        logVirtualApiNotPosted({
          reason,
          providerEventId: extractEventFeedIdFromUrl(response.url()),
          domFirst: 'not found',
          feedFirst: 'not found',
        });
        onAuthenticationFailure({
          reason: `event-detail-${response.status()}-${body.match(/PlayerNotAuthenticatedException/i)?.[0] ?? 'auth-failed'}`,
          status: response.status(),
          url: response.url(),
        });
        return;
      }

      if (response.status() !== 200) {
        const reason = `status-${response.status()}`;
        console.log(`cycle=${getCycle()} source=event-detail skipped reason=${reason} url=${response.url()}`);
        logVirtualApiNotPosted({
          reason,
          providerEventId: extractEventFeedIdFromUrl(response.url()),
          domFirst: 'not found',
          feedFirst: 'not found',
        });
        return;
      }

      const json = await response.json();
      const event = getEventDetailObject(json);
      const eventFeedId = String(event?.a ?? extractEventFeedIdFromUrl(response.url()) ?? '');
      await dumpResultsFirstMatchJson(json, response.url());
      const eventDetailPacket = classifyEventDetailPacket(json, response.url());
      const previousCycleResultWatch = getPreviousCycleResultWatch();
      const isPreviousCycleResultWatchResponse = Boolean(
        previousCycleResultWatch?.providerEventId &&
          Date.now() <= previousCycleResultWatch.until &&
          String(eventFeedId) === String(previousCycleResultWatch.providerEventId),
      );
      const capture = {
        url: response.url(),
        json,
        eventFeedId,
        capturedAt: Date.now(),
        mode: 'response-listener',
      };
      let resultCandidateMismatchLogged = false;

      if (eventDetailPacket.isResultCandidate) {
        logResultCandidate(eventDetailPacket);
        const candidateVisibleFirstMatch = await readVisibleFirstMatchWithRetry().catch(() => null);
        const candidateDomFirst = candidateVisibleFirstMatch ? getVisibleText(candidateVisibleFirstMatch) : 'not found';
        const candidateFeedFirst = eventDetailPacket.resultsPayload.matches[0]?.teams || 'not found';

        if (isKnownFirstMatchMismatch(candidateDomFirst, candidateFeedFirst)) {
          logResultCandidateBypassMismatch(eventDetailPacket, candidateDomFirst, candidateFeedFirst);
          resultCandidateMismatchLogged = true;
        }
      }

      if (eventDetailPacket.hasResults) {
        captures.push(capture);
        onCaptured(capture);
        const { monitorPayload, monitorResult } = await processResultMonitorPacket(eventDetailPacket);
        const result = {
          posted: false,
          source: 'event-detail-results',
          skipped: true,
          reason: 'results-packet-detected',
          providerEventId: eventDetailPacket.providerEventId,
          eventFeedId: eventDetailPacket.providerEventId,
          eventType: eventDetailPacket.eventType,
          matchCount: eventDetailPacket.matchCount,
          resultsPayload: eventDetailPacket.resultsPayload,
          monitorPayload,
          monitorResult,
        };
        recordProcessedResult(capture, result);
        onProcessed(result);
        return;
      }

      if (isPreviousCycleResultWatchResponse) {
        captures.push(capture);
        onCaptured(capture);
        const result = {
          posted: false,
          source: 'previous-cycle-result-watch',
          skipped: true,
          reason: 'watching-for-results',
          providerEventId: eventFeedId,
          eventFeedId,
          eventType: eventDetailPacket.eventType,
        };
        recordProcessedResult(capture, result);
        onProcessed(result);
        return;
      }

      const parsedEventDetail = parseCapturedEventDetail(capture);
      const week = getEventDetailWeek(parsedEventDetail.event);
      const firstMatch = getEventDetailFirstMatchText(parsedEventDetail.matches, parsedEventDetail.canonicalEvents);

      captures.push(capture);
      onCaptured(capture);
      console.log(`EVENT-DETAIL-CAPTURED providerEventId=${eventFeedId} week=${week || 'not found'} firstMatch=${firstMatch}`);
      logEventDetailShape(getCycle(), eventFeedId, parsedEventDetail.event, parsedEventDetail.matches);
      logEventDetailRealtimeSummary(
        getCycle(),
        eventFeedId,
        parsedEventDetail.event,
        parsedEventDetail.matches,
        parsedEventDetail.canonicalEvents,
      );

      const visibleFirstMatch = await readVisibleFirstMatchWithRetry();
      cacheParsedEventDetail(getCycle(), eventDetailCache, capture, parsedEventDetail, visibleFirstMatch);
      const domFirst = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : 'not found';
      const feedFirst = getFirstText(parsedEventDetail.canonicalEvents);
      let result = null;
      const alreadyPostedFromFeedEvents = String(getLastPostedFeedProviderEventId() || '') === String(eventFeedId || '');

      if (alreadyPostedFromFeedEvents) {
        result = {
          posted: false,
          source: 'event-detail',
          skipped: true,
          reason: 'already-posted-from-feed-events',
          eventFeedId,
          providerEventId: eventFeedId,
          week,
          domFirst,
          feedFirst,
          matchesVisible: canonicalMatchesVisible(parsedEventDetail.canonicalEvents[0] ?? {}, visibleFirstMatch),
        };
        logVirtualApiNotPosted({
          source: 'event-detail',
          reason: result.reason,
          providerEventId: eventFeedId,
          domFirst,
          feedFirst,
        });
        recordProcessedResult(capture, result);
        onProcessed(result);
        return;
      }

      const matchesVisible = canonicalMatchesVisible(parsedEventDetail.canonicalEvents[0] ?? {}, visibleFirstMatch);

      if (!matchesVisible) {
        if (eventDetailPacket.isResultCandidate) {
          if (!resultCandidateMismatchLogged && isKnownFirstMatchMismatch(domFirst, feedFirst)) {
            logResultCandidateBypassMismatch(eventDetailPacket, domFirst, feedFirst);
          }
        } else {
          const reason = visibleFirstMatch ? 'visible-mismatch' : 'dom-first-not-found-after-retry';
          result = {
            posted: false,
            source: 'event-detail',
            skipped: true,
            reason,
            eventFeedId,
            providerEventId: eventFeedId,
            week,
            domFirst,
            feedFirst,
          };
          logVirtualApiNotPosted({
            reason,
            providerEventId: eventFeedId,
            domFirst,
            feedFirst,
          });
          recordProcessedResult(capture, result);
          onProcessed(result);
          return;
        }
      }

      result = {
        posted: false,
        source: 'event-detail',
        skipped: true,
        reason: 'event-detail-monitor-only',
        eventFeedId,
        providerEventId: eventFeedId,
        week,
        domFirst,
        feedFirst,
        matchesVisible,
      };

      logVirtualApiNotPosted({
        source: 'event-detail',
        reason: result.reason,
        providerEventId: eventFeedId,
        domFirst,
        feedFirst,
      });

      recordProcessedResult(capture, result);
      onProcessed(result);
    })().catch((error) => {
      console.log(`event-detail capture failed: ${error.message || error}`);
      const result = {
        posted: false,
        source: 'event-detail',
        failed: true,
        authExpired: isAuthenticationFailureMessage(error.message || error),
        reason: error.message || String(error),
      };
      logVirtualApiNotPosted({
        reason: result.reason,
        providerEventId: '',
        domFirst: 'not found',
        feedFirst: 'not found',
      });
      recordProcessedResult(null, result);
      onProcessed(result);
    });

    pending.push(capturePromise);
  };

  page.on('response', onResponse);

  return {
    async latest() {
      await Promise.allSettled(pending);
      return captures[captures.length - 1] ?? null;
    },
    async allSince(timestamp) {
      await Promise.allSettled(pending);
      return captures.filter((capture) => capture.capturedAt >= timestamp);
    },
    async waitForProcessedSince(timestamp, timeoutMs = 10_000) {
      const isAfterTimestamp = (entry) => (entry.capture?.capturedAt ?? entry.processedAt) >= timestamp;
      const existing = processedResults.find(isAfterTimestamp);
      if (existing) {
        return existing;
      }

      return new Promise((resolve) => {
        const waiter = (entry) => {
          if (!isAfterTimestamp(entry)) {
            return;
          }

          clearTimeout(timeout);
          const index = processedWaiters.indexOf(waiter);
          if (index !== -1) {
            processedWaiters.splice(index, 1);
          }
          resolve(entry);
        };
        const timeout = setTimeout(() => {
          const index = processedWaiters.indexOf(waiter);
          if (index !== -1) {
            processedWaiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);

        processedWaiters.push(waiter);
      });
    },
    clear() {
      captures.length = 0;
      processedResults.length = 0;
    },
    dispose() {
      page.off('response', onResponse);
    },
  };
}

function createSessionAuthMonitor(page, options = {}) {
  assertUsablePage(page);

  const getCycle = options.getCycle ?? (() => 0);
  const onAuthenticationFailure = options.onAuthenticationFailure ?? (() => {});

  const onResponse = (response) => {
    if (!response.url().includes(BALANCE_URL_MARKER)) {
      return;
    }

    if (response.status() === 401 || response.status() === 403) {
      console.log(
        `cycle=${getCycle()} source=session-auth skipped reason=auth-failure status=${response.status()} ` +
          `${response.statusText()} url=${response.url()}`,
      );
      onAuthenticationFailure({
        reason: `balance-${response.status()}`,
        status: response.status(),
        url: response.url(),
      });
    }
  };

  page.on('response', onResponse);

  return {
    dispose() {
      page.off('response', onResponse);
    },
  };
}

function assertUsablePage(page) {
  if (!page) {
    throw new Error('Playwright page is not available');
  }

  if (page.isClosed && page.isClosed()) {
    throw new Error('Playwright page is closed');
  }
}

async function getFirstVisibleLocator(page, selectors, timeout = 5000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {
      // Try the next selector.
    }
  }

  return null;
}

async function fillLoginField(page, selectors, value, label) {
  const locator = await getFirstVisibleLocator(page, selectors);

  if (!locator) {
    throw new Error(`Could not find ${label} field`);
  }

  try {
    await locator.fill(value, { timeout: 5000 });
    return;
  } catch {
    await locator.click({ timeout: 5000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(value, { delay: 35 });
  }
}

async function clickLoginButton(page) {
  const strategies = [
    {
      label: 'button.shop-login-button',
      locator: () => page.locator('button.shop-login-button').first(),
    },
    {
      label: 'text=LOGIN',
      locator: () => page.getByText('LOGIN', { exact: true }).first(),
    },
  ];

  for (const strategy of strategies) {
    const locator = strategy.locator();

    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await locator.click({ timeout: 5000 });
      console.log(`Login submitted via ${strategy.label}.`);
      return strategy.label;
    } catch (error) {
      console.log(`Login submit via ${strategy.label} failed: ${error.message || error}`);
    }
  }

  await page.keyboard.press('Enter');
  console.log('Login submitted via Enter fallback.');
  return 'Enter fallback';
}

async function waitForLoginForm(page) {
  const usernameField = await getFirstVisibleLocator(page, USERNAME_SELECTORS, LOGIN_TIMEOUT_MS);

  if (!usernameField) {
    throw new Error('Login form did not load');
  }
}

function isLoginSuccessResponse(response) {
  const url = response.url();

  return (
    response.ok() &&
    (
      url.includes(BALANCE_URL_MARKER) ||
      url.includes(FEED_URL_MARKER) ||
      url.includes(EVENT_DETAIL_URL_MARKER)
    )
  );
}

async function waitForLoginDomSuccess(page, timeout = LOGIN_TIMEOUT_MS) {
  return page.waitForFunction(
    ({ username }) => {
      const text = document.body?.innerText || '';
      const normalizedText = text.toUpperCase();
      const normalizedUsername = String(username || '').toUpperCase();
      const onShopPage = window.location.pathname.endsWith('/client/shop.jsp');
      const hasKnownUser = normalizedText.includes('KINGDOM01') || (normalizedUsername && normalizedText.includes(normalizedUsername));
      const hasBalanceHeader = /\bBALANCE\b/i.test(text);

      return hasKnownUser || (onShopPage && hasBalanceHeader);
    },
    { username: VH_USERNAME },
    { timeout },
  );
}

async function waitForLoginSuccess(page) {
  const networkSuccess = page.waitForResponse(isLoginSuccessResponse, { timeout: LOGIN_TIMEOUT_MS }).then((response) => ({
    type: 'network',
    detail: `${response.status()} ${response.url()}`,
  }));
  const domSuccess = waitForLoginDomSuccess(page).then(() => ({
    type: 'dom',
    detail: 'shop username/balance marker visible',
  }));

  return Promise.race([networkSuccess, domSuccess]);
}

async function detectAuthenticationErrorBanner(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
  const match = bodyText.match(
    /(?:PlayerNotAuthenticatedException|authentication required|not authenticated|invalid\s+(?:username|password|credentials)|incorrect\s+(?:username|password|credentials)|login\s+failed|session\s+expired|wrong\s+(?:username|password|credentials))/i,
  );

  return {
    present: Boolean(match),
    text: match ? match[0] : '',
  };
}

async function saveLoginFailureArtifacts(page) {
  await fs.promises.mkdir('data', { recursive: true });
  await page.screenshot({ path: path.join('data', 'login-failed.png'), fullPage: true }).catch((error) => {
    console.log(`Could not save login failure screenshot: ${error.message || error}`);
  });
  await fs.promises.writeFile(path.join('data', 'login-failed.html'), await page.content(), 'utf8').catch((error) => {
    console.log(`Could not save login failure HTML: ${error.message || error}`);
  });
}

async function automaticLogin(page) {
  console.log('VH_USERNAME and VH_PASSWORD found. Attempting automatic login.');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await waitForLoginForm(page);
  await fillLoginField(page, USERNAME_SELECTORS, VH_USERNAME, 'username');
  await fillLoginField(page, PASSWORD_SELECTORS, VH_PASSWORD, 'password');

  const successWait = waitForLoginSuccess(page);
  await clickLoginButton(page);

  try {
    const success = await successWait;
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    console.log(`Automatic login completed via ${success.type}: ${success.detail}`);
  } catch (error) {
    const authError = await detectAuthenticationErrorBanner(page);
    console.log(`Authentication error banner present: ${authError.present}${authError.text ? ` (${authError.text})` : ''}`);
    await saveLoginFailureArtifacts(page);
    console.log('Saved login failure artifacts: data/login-failed.png and data/login-failed.html');
    throw error;
  }
}

async function manualLogin(page, rl) {
  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' });
  console.log('Login manually, wait for fixtures to load, then press ENTER to start auto-sync.');
  await rl.question('');
}

async function reloadShopPage(page) {
  assertUsablePage(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
}

async function skipToNextGames(page) {
  assertUsablePage(page);
  const skipButton = page.getByText(SKIP_TO_NEXT_GAMES_TEXT, { exact: false }).first();

  try {
    if (await skipButton.isVisible({ timeout: 1500 })) {
      await skipButton.click({ timeout: 5000 });
      return;
    }
  } catch {
    // Fall through to Escape when the rendered button is not directly clickable.
  }

  await page.keyboard.press('Escape');
}

async function readVisibleFirstMatch(page) {
  assertUsablePage(page);
  const result = await page.evaluate(() => {
    const excludedTokens = new Set([
      'AUTHENTICATION',
      'LOGIN',
      'SPACE',
      'HOME',
      'AWAY',
      'DRAW',
      'OVER',
      'UNDER',
      'GOAL',
      'GOALS',
      'WINNER',
      'SCORE',
      'LEAGUE',
    ]);

    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const matchPattern = /\b([A-Z0-9]{2,5})\s+vs\.?\s+([A-Z0-9]{2,5})\b/i;
    const marketPattern = /\b(?:HOME|AWAY|DRAW|OVER|UNDER|GOALS?|SCORE|WINNER|ODDS)\b/i;
    const timerPattern = /\b(?:(?:\d{1,2}:)?[0-5]?\d:[0-5]\d|NO MORE BETS,?\s+GAME IS KICKING OFF)\b/i;
    const leaguePattern = /\b(?:LEAGUE|LIGA|LIGUE|FOOTBALL|WEEK)\b/i;
    const parseCountdownSeconds = (text) => {
      const normalized = normalizeText(text);
      const clockMatch = normalized.match(/\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/);
      if (clockMatch) {
        return (Number(clockMatch[1] || 0) * 3600) + (Number(clockMatch[2]) * 60) + Number(clockMatch[3]);
      }

      const labelledMatch = normalized.match(/\b(\d{1,2})\s*(?:m|min|minute)s?\s*(?:(\d{1,2})\s*(?:s|sec|second)s?)?\b/i);
      if (labelledMatch) {
        return (Number(labelledMatch[1]) * 60) + Number(labelledMatch[2] || 0);
      }

      if (/NO MORE BETS|KICKING OFF/i.test(normalized)) {
        return 0;
      }

      return null;
    };
    const getVisibleMetadata = () => {
      const bodyText = normalizeText(document.body.innerText || '');
      const weekMatch = bodyText.match(/\bWEEK\s+(\d+)\b/i);
      const leagueNumberMatch = bodyText.match(/\bLeague\s+(\d{3,})\b/i) ||
        bodyText.match(/\b(?:LEAGUE|LIGA|LIGUE)\D{0,12}(\d{3,})\b/i);
      const countdownMatch = bodyText.match(/\b(?:(?:\d{1,2}:)?[0-5]?\d:[0-5]\d|NO MORE BETS, GAME IS KICKING OFF)\b/i);
      const countdownText = countdownMatch ? countdownMatch[0] : null;

      return {
        visibleLeague: leagueNumberMatch ? leagueNumberMatch[1] : null,
        visibleWeek: weekMatch ? weekMatch[1] : null,
        countdownText,
        countdownSeconds: parseCountdownSeconds(countdownText),
      };
    };
    const hasVisibleStyle = (element) => {
      let current = element;
      while (current && current !== document.documentElement) {
        const currentStyle = window.getComputedStyle(current);
        if (
          currentStyle.visibility === 'hidden' ||
          currentStyle.display === 'none' ||
          Number(currentStyle.opacity) === 0 ||
          current.hidden ||
          current.getAttribute('aria-hidden') === 'true'
        ) {
          return false;
        }

        current = current.parentElement;
      }

      return true;
    };
    const isVisible = (element) => {
      if (!hasVisibleStyle(element)) {
        return false;
      }

      const rect = element.getBoundingClientRect();

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0 &&
        rect.bottom <= window.innerHeight
      );
    };
    const isTeamCode = (value) => {
      const text = normalizeText(value).toUpperCase();

      return /^[A-Z0-9]{2,5}$/.test(text) && !excludedTokens.has(text);
    };
    const getRectInfo = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    const isViewportBox = (rect) => (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
    const extractMatch = (text) => {
      const match = normalizeText(text).match(matchPattern);
      if (!match || !isTeamCode(match[1]) || !isTeamCode(match[2])) {
        return null;
      }

      return {
        homeTeam: match[1].toUpperCase(),
        awayTeam: match[2].toUpperCase(),
        text: `${match[1].toUpperCase()} vs ${match[2].toUpperCase()}`,
      };
    };
    const findActiveHeaderBottom = (visibleElements) => {
      const headerCandidates = visibleElements
        .map((element) => {
          const text = normalizeText(element.innerText || element.textContent);
          const rect = getRectInfo(element);

          if (
            text &&
            text.length <= 220 &&
            (leaguePattern.test(text) || timerPattern.test(text)) &&
            !matchPattern.test(text) &&
            isViewportBox(rect)
          ) {
            return rect.bottom;
          }

          return null;
        })
        .filter((bottom) => bottom !== null && bottom <= Math.max(240, window.innerHeight * 0.45));

      return headerCandidates.length ? Math.max(...headerCandidates) : 0;
    };
    const chooseRowElement = (element) => {
      let current = element;
      let best = element;

      for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
        if (!isVisible(current)) {
          break;
        }

        const text = normalizeText(current.innerText || current.textContent);
        const rect = getRectInfo(current);

        if (
          text &&
          matchPattern.test(text) &&
          text.length <= 260 &&
          rect.height <= 120 &&
          rect.width >= 60 &&
          isViewportBox(rect)
        ) {
          best = current;
        }

        current = current.parentElement;
      }

      return best;
    };
    const isLikelyHiddenWeekPanelRow = (element) => {
      let current = element.parentElement;

      for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
        if (!hasVisibleStyle(current)) {
          return true;
        }

        const rect = getRectInfo(current);

        if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) {
          return true;
        }

        current = current.parentElement;
      }

      return false;
    };
    const makeCandidate = (element, source, activeHeaderBottom) => {
      const rowElement = chooseRowElement(element);
      const rowText = normalizeText(rowElement.innerText || rowElement.textContent);
      const extracted = extractMatch(rowText) || extractMatch(element.innerText || element.textContent);
      const rect = getRectInfo(rowElement);

      if (!extracted || !isViewportBox(rect) || isLikelyHiddenWeekPanelRow(rowElement)) {
        return null;
      }

      if (rect.top < activeHeaderBottom - 4) {
        return null;
      }

      const compactMarketRow = rowText.length <= 220 && marketPattern.test(rowText) && /\b\d+[.,]\d{2}\b/.test(rowText);
      if (compactMarketRow && rowText.indexOf(extracted.text) === -1) {
        return null;
      }

      return {
        ...extracted,
        y: Math.round(rect.top),
        x: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: true,
        source,
      };
    };

    const visibleElements = Array.from(document.querySelectorAll('body *')).filter(isVisible);
    const activeHeaderBottom = findActiveHeaderBottom(visibleElements);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
      if (!candidate) {
        return;
      }

      const key = `${candidate.text}|${candidate.y}|${candidate.x}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      candidates.push(candidate);
    };
    const collectCandidates = (minimumY) => {
      visibleElements.forEach((element) => {
        const text = normalizeText(element.innerText || element.textContent);
        if (text && text.length <= 260 && matchPattern.test(text)) {
          addCandidate(makeCandidate(element, 'row-text', minimumY));
        }
      });

      const tokenItems = visibleElements
        .map((element) => {
          const text = normalizeText(element.innerText || element.textContent);
          const rect = getRectInfo(element);
          return {
            element,
            text,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((item) => item.text && item.text.length <= 40 && item.top >= minimumY - 4);
      const tokens = tokenItems
        .filter((item) => /^vs\.?$/i.test(item.text) || isTeamCode(item.text))
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const rows = [];

      tokens.forEach((token) => {
        let row = rows.find((candidate) => Math.abs(candidate.top - token.top) <= 28);
        if (!row) {
          row = { top: token.top, tokens: [] };
          rows.push(row);
        }

        row.tokens.push(token);
      });

      for (const row of rows.sort((a, b) => a.top - b.top)) {
        const sortedTokens = row.tokens.sort((a, b) => a.left - b.left);
        const vsIndex = sortedTokens.findIndex((token) => /^vs\.?$/i.test(token.text));

        if (vsIndex === -1) {
          continue;
        }

        const home = [...sortedTokens.slice(0, vsIndex)].reverse().find((token) => isTeamCode(token.text));
        const away = sortedTokens.slice(vsIndex + 1).find((token) => isTeamCode(token.text));

        if (home && away) {
          addCandidate(makeCandidate(home.element, 'token-row', minimumY) || {
            homeTeam: home.text.toUpperCase(),
            awayTeam: away.text.toUpperCase(),
            text: `${home.text.toUpperCase()} vs ${away.text.toUpperCase()}`,
            y: Math.round(row.top),
            x: Math.round(Math.min(home.left, away.left)),
            width: Math.round((away.left + away.width) - home.left),
            height: Math.round(Math.max(home.height, away.height)),
            visible: true,
            source: 'token-row',
          });
        }
      }
    };

    collectCandidates(activeHeaderBottom);
    if (candidates.length === 0 && activeHeaderBottom > 0) {
      collectCandidates(0);
    }

    const sortedCandidates = candidates
      .filter((candidate) => candidate.visible && candidate.text)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const selected = sortedCandidates[0] ?? null;

    return {
      match: selected
        ? {
          homeTeam: selected.homeTeam,
          awayTeam: selected.awayTeam,
          text: selected.text,
          ...getVisibleMetadata(),
        }
        : null,
      debugCandidates: sortedCandidates.slice(0, 8).map((candidate) => ({
        y: candidate.y,
        text: candidate.text,
        visible: candidate.visible,
        selected: Boolean(selected && selected.text === candidate.text && selected.y === candidate.y && selected.x === candidate.x),
      })),
    };
  });

  if (LOG_ODDS_DETAILS && result?.debugCandidates) {
    console.log('readVisibleFirstMatch candidates:');
    if (result.debugCandidates.length === 0) {
      console.log('(none)');
    } else {
      result.debugCandidates.forEach((candidate, index) => {
        const selected = candidate.selected ? ' selected=true' : '';
        console.log(`${index + 1} y=${candidate.y} text="${candidate.text}" visible=${candidate.visible}${selected}`);
      });
    }
  }

  return result?.match ?? null;
}

async function readVisibleCountdown(page) {
  assertUsablePage(page);
  return page.evaluate(() => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const timerPattern = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/;
    const closedPattern = /\bNO MORE BETS,?\s+GAME IS KICKING OFF\b/i;
    const weekPattern = /\bWEEK\s+\d+\b/i;
    const leaguePattern = /\b(?:LEAGUE|LIGA|LIGUE|FOOTBALL)\b/i;
    const matchPattern = /\b[A-Z0-9]{2,5}\s+vs\.?\s+[A-Z0-9]{2,5}\b/i;
    const accountPattern = /\b(?:ACCOUNT|BALANCE|USERNAME|USER|LOGOUT|LOGIN|SESSION|CASHIER|DEPOSIT|WITHDRAW)\b/i;
    const marketPattern = /\b(?:HOME|AWAY|DRAW|OVER|UNDER|GOALS?|SCORE|WINNER|ODDS)\b/i;

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight &&
        rect.right >= 0 &&
        rect.left <= window.innerWidth
      );
    };
    const parseCountdown = (text) => {
      const normalized = normalizeText(text);
      const clockMatch = normalized.match(timerPattern);

      if (clockMatch) {
        const totalSeconds =
          (Number(clockMatch[1] || 0) * 3600) +
          (Number(clockMatch[2]) * 60) +
          Number(clockMatch[3]);

        return {
          text: clockMatch[0],
          totalSeconds,
          minutes: Math.floor((totalSeconds % 3600) / 60),
          seconds: totalSeconds % 60,
          found: true,
        };
      }

      if (closedPattern.test(normalized)) {
        return {
          text: 'NO MORE BETS, GAME IS KICKING OFF',
          totalSeconds: 0,
          minutes: 0,
          seconds: 0,
          found: true,
        };
      }

      return null;
    };
    const getElementText = (element) => normalizeText(element.innerText || element.textContent);
    const hasOwnTimerText = (element) => {
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(' ');
      const normalizedOwnText = normalizeText(ownText);

      if (timerPattern.test(normalizedOwnText) || closedPattern.test(normalizedOwnText)) {
        return true;
      }

      const text = getElementText(element);
      const visibleChildren = Array.from(element.children).filter(isVisible);

      return (
        text.length <= 80 &&
        (timerPattern.test(text) || closedPattern.test(text)) &&
        !visibleChildren.some((child) => {
          const childText = normalizeText(child.innerText || child.textContent);
          return timerPattern.test(childText) || closedPattern.test(childText);
        })
      );
    };
    const getVisibleElements = () => Array.from(document.querySelectorAll('body *')).filter(isVisible);
    const getAncestorInfo = (element, maxDepth = 8) => {
      const ancestors = [];
      let current = element;

      for (let depth = 0; current && current !== document.body && depth < maxDepth; depth += 1) {
        if (isVisible(current)) {
          ancestors.push({
            element: current,
            text: getElementText(current),
            rect: current.getBoundingClientRect(),
          });
        }

        current = current.parentElement;
      }

      return ancestors;
    };
    const distanceBetweenRects = (a, b) => {
      const ax = a.left + (a.width / 2);
      const ay = a.top + (a.height / 2);
      const bx = b.left + (b.width / 2);
      const by = b.top + (b.height / 2);

      return Math.hypot(ax - bx, ay - by);
    };
    const isCompactTimerCandidate = (element) => {
      const text = getElementText(element);
      const rect = element.getBoundingClientRect();

      return (
        hasOwnTimerText(element) &&
        timerPattern.test(text) &&
        text.length <= 40 &&
        rect.width <= 220 &&
        rect.height <= 140
      );
    };
    const hasAccountContext = (ancestors) => ancestors.some((ancestor) => {
      if (ancestor.text.length > 240) {
        return false;
      }

      return accountPattern.test(ancestor.text);
    });
    const isInsideOddsOrTableRow = (element, ancestors) => {
      const tableLikeAncestor = element.closest('tr, [role="row"], [role="gridcell"], [role="cell"]');
      if (tableLikeAncestor) {
        const tableLikeText = getElementText(tableLikeAncestor);
        if (
          tableLikeText.length <= 260 &&
          (matchPattern.test(tableLikeText) || marketPattern.test(tableLikeText) || /\b\d+[.,]\d{2}\b/.test(tableLikeText))
        ) {
          return true;
        }
      }

      if (element.closest('table')) {
        return true;
      }

      return ancestors.some((ancestor) => (
        ancestor.text.length <= 220 &&
        matchPattern.test(ancestor.text) &&
        (marketPattern.test(ancestor.text) || /\b\d+[.,]\d{2}\b/.test(ancestor.text))
      ));
    };
    const isCircularTimerPanel = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const radius = parseFloat(style.borderTopLeftRadius || '0');
      const nearlySquare = rect.width > 24 && rect.height > 24 && Math.abs(rect.width - rect.height) <= Math.max(18, rect.width * 0.4);
      const coloredPanel = /(rgb\(0,\s*0,\s*0\)|rgb\(.*(?:1[0-9]{2}|2[0-5]{2}),\s*[0-9]{1,2},\s*[0-9]{1,2}\))/i.test(style.backgroundColor || '');

      return nearlySquare && (radius >= Math.min(rect.width, rect.height) * 0.25 || coloredPanel);
    };
    const findWeekHeader = (element) => {
      let current = element;

      for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
        if (!isVisible(current)) {
          current = current.parentElement;
          continue;
        }

        const text = normalizeText(current.innerText || current.textContent);
        const rect = current.getBoundingClientRect();

        if (
          weekPattern.test(text) &&
          (timerPattern.test(text) || closedPattern.test(text)) &&
          text.length <= 240 &&
          rect.height <= Math.max(180, window.innerHeight * 0.35)
        ) {
          return { element: current, text, rect };
        }

        current = current.parentElement;
      }

      return null;
    };

    const visibleElements = getVisibleElements();
    const timerElements = visibleElements.filter(hasOwnTimerText);
    const weekHeaderCandidates = timerElements
      .map((element) => {
        const text = getElementText(element);
        const parsed = parseCountdown(text);
        const header = findWeekHeader(element);

        if (!parsed || !header) {
          return null;
        }

        const timerRect = element.getBoundingClientRect();
        const headerText = header.text;
        const containsFixtureText = /\b[A-Z0-9]{2,5}\s+vs\.?\s+[A-Z0-9]{2,5}\b/i.test(headerText);
        const containsMarketText = /\b(?:HOME|AWAY|DRAW|OVER|UNDER|GOALS?|SCORE)\b/i.test(headerText);

        return {
          countdown: { ...parsed, reason: 'week-header' },
          top: header.rect.top,
          left: header.rect.left,
          score:
            1000 -
            Math.max(0, header.rect.top) -
            (headerText.length / 4) -
            (containsFixtureText ? 250 : 0) -
            (containsMarketText ? 150 : 0) -
            (timerRect.height > 80 ? 50 : 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.top - b.top || a.left - b.left);

    if (weekHeaderCandidates[0]) {
      return weekHeaderCandidates[0].countdown;
    }

    const leagueRects = visibleElements
      .map((element) => {
        const text = getElementText(element);
        return text.length <= 220 && leaguePattern.test(text)
          ? { element, text, rect: element.getBoundingClientRect() }
          : null;
      })
      .filter(Boolean);
    const matchRects = visibleElements
      .map((element) => {
        const text = getElementText(element);
        return text.length <= 180 && matchPattern.test(text)
          ? { element, text, rect: element.getBoundingClientRect() }
          : null;
      })
      .filter(Boolean);
    const fallbackCandidates = visibleElements
      .filter(isCompactTimerCandidate)
      .map((element) => {
        const text = getElementText(element);
        const parsed = parseCountdown(text);

        if (!parsed) {
          return null;
        }

        const rect = element.getBoundingClientRect();
        const ancestors = getAncestorInfo(element, 8);
        const compactAncestors = ancestors.filter((ancestor) => ancestor.text.length <= 260);
        const hasLeagueContext = compactAncestors.some((ancestor) => leaguePattern.test(ancestor.text));
        const hasMatchContext = compactAncestors.some((ancestor) => matchPattern.test(ancestor.text));
        const nearestLeagueDistance = leagueRects.length
          ? Math.min(...leagueRects.map((item) => distanceBetweenRects(rect, item.rect)))
          : Number.POSITIVE_INFINITY;
        const nearestMatchDistance = matchRects.length
          ? Math.min(...matchRects.map((item) => distanceBetweenRects(rect, item.rect)))
          : Number.POSITIVE_INFINITY;
        const nearLeague = nearestLeagueDistance <= Math.max(260, window.innerWidth * 0.25);
        const nearMatchList = nearestMatchDistance <= Math.max(380, window.innerWidth * 0.35);
        const circularPanel = isCircularTimerPanel(element) || ancestors.some((ancestor) => isCircularTimerPanel(ancestor.element));
        const accountContext = hasAccountContext(compactAncestors);

        if (isInsideOddsOrTableRow(element, compactAncestors)) {
          return null;
        }

        if (accountContext && !hasLeagueContext && !nearLeague && !nearMatchList) {
          return null;
        }

        if (!hasLeagueContext && !hasMatchContext && !nearLeague && !nearMatchList && !circularPanel) {
          return null;
        }

        return {
          countdown: { ...parsed, reason: 'league-panel-fallback' },
          top: rect.top,
          left: rect.left,
          score:
            500 +
            (hasLeagueContext ? 220 : 0) +
            (hasMatchContext ? 120 : 0) +
            (nearLeague ? 180 : 0) +
            (nearMatchList ? 120 : 0) +
            (circularPanel ? 180 : 0) -
            (accountContext ? 180 : 0) -
            (nearestLeagueDistance === Number.POSITIVE_INFINITY ? 0 : nearestLeagueDistance / 8) -
            (nearestMatchDistance === Number.POSITIVE_INFINITY ? 0 : nearestMatchDistance / 12) -
            Math.max(0, rect.top) / 20,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.top - b.top || a.left - b.left);

    return fallbackCandidates[0]?.countdown ?? { found: false };
  });
}

function logVisibleCountdown(cycle, countdown) {
  if (countdown?.found) {
    const reason = countdown.reason ? ` reason=${countdown.reason}` : '';
    console.log(`cycle=${cycle} countdown=${countdown.text} secondsRemaining=${countdown.totalSeconds}${reason}`);
    return;
  }

  console.log(`cycle=${cycle} countdown=not-found`);
}

async function waitForVisibleFirstMatchDifferent(page, oldFirstMatch, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const nextMatch = await readVisibleFirstMatch(page).catch(() => null);
    const nextText = nextMatch ? getVisibleText(nextMatch) : '';

    if (nextText && nextText !== oldFirstMatch) {
      return nextMatch;
    }

    await sleep(500);
  }

  return null;
}

async function settleVisibleFirstMatch(page, expectedFirstMatch, settleMs = 3000) {
  await sleep(settleMs);
  const latestMatch = await readVisibleFirstMatch(page).catch(() => null);
  const latestText = latestMatch ? getVisibleText(latestMatch) : '';

  if (latestText && latestText !== expectedFirstMatch) {
    return {
      visibleFirstMatch: latestMatch,
      firstMatch: latestText,
      changed: true,
    };
  }

  return {
    visibleFirstMatch: latestMatch ?? null,
    firstMatch: latestText || expectedFirstMatch,
    changed: false,
  };
}

async function waitForVisibleFirstMatchChange(page, previousMatch, timeoutMs = VISIBLE_MATCH_CHANGE_TIMEOUT_MS) {
  assertUsablePage(page);

  const previousText = previousMatch ? previousMatch.text : null;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const nextMatch = await readVisibleFirstMatch(page).catch(() => null);

    if (nextMatch && (!previousText || nextMatch.text !== previousText)) {
      return nextMatch;
    }

    await sleep(500);
  }

  return readVisibleFirstMatch(page).catch(() => null);
}

async function triggerVisibleFirstDetailLoad(cycle, page, visibleFirstMatch) {
  assertUsablePage(page);

  if (!visibleFirstMatch) {
    return false;
  }

  const target = await page.evaluate(({ homeTeam, awayTeam }) => {
    const excludedTokens = new Set([
      'AUTHENTICATION',
      'LOGIN',
      'SPACE',
      'HOME',
      'AWAY',
      'DRAW',
      'OVER',
      'UNDER',
      'GOAL',
      'GOALS',
      'WINNER',
      'SCORE',
      'LEAGUE',
    ]);
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeToken = (value) => normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight
      );
    };
    const isTeamCode = (value) => {
      const text = normalizeToken(value);
      return /^[A-Z0-9]{2,5}$/.test(text) && !excludedTokens.has(text);
    };
    const getCommonAncestor = (elements) => {
      let candidate = elements[0] ?? null;

      while (candidate && !elements.every((element) => candidate.contains(element))) {
        candidate = candidate.parentElement;
      }

      return candidate;
    };

    const elements = Array.from(document.querySelectorAll('body *'))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          text: normalizeText(element.innerText || element.textContent),
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => item.text && item.text.length <= 120);

    const fullTextMatch = elements.find((item) => {
      const text = normalizeText(item.text).toUpperCase();
      return text.includes(`${homeTeam} VS ${awayTeam}`) || text.includes(`${homeTeam} VS. ${awayTeam}`);
    });

    if (fullTextMatch) {
      const rect = fullTextMatch.element.getBoundingClientRect();
      return {
        x: Math.max(1, rect.left + Math.min(18, rect.width / 2)),
        y: rect.top + rect.height / 2,
      };
    }

    const tokens = elements
      .filter((item) => /^vs\.?$/i.test(item.text) || isTeamCode(item.text) || /^\d+$/.test(item.text))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const rows = [];

    tokens.forEach((token) => {
      let row = rows.find((candidate) => Math.abs(candidate.top - token.top) <= 28);
      if (!row) {
        row = { top: token.top, tokens: [] };
        rows.push(row);
      }

      row.tokens.push(token);
    });

    for (const row of rows.sort((a, b) => a.top - b.top)) {
      const sortedTokens = row.tokens.sort((a, b) => a.left - b.left);
      const vsIndex = sortedTokens.findIndex((token) => /^vs\.?$/i.test(token.text));

      if (vsIndex === -1) {
        continue;
      }

      const home = [...sortedTokens.slice(0, vsIndex)].reverse().find((token) => normalizeToken(token.text) === homeTeam);
      const away = sortedTokens.slice(vsIndex + 1).find((token) => normalizeToken(token.text) === awayTeam);

      if (!home || !away) {
        continue;
      }

      const rowElement = getCommonAncestor([home.element, sortedTokens[vsIndex].element, away.element]);
      const rect = rowElement?.getBoundingClientRect();
      const top = Math.min(home.top, sortedTokens[vsIndex].top, away.top);
      const height = Math.max(home.height, sortedTokens[vsIndex].height, away.height);
      const y = rect && rect.height > 0 ? rect.top + rect.height / 2 : top + height / 2;
      const x = Math.max(1, Math.min(home.left - 24, rect ? rect.left + 18 : home.left));

      return { x, y };
    }

    return null;
  }, {
    homeTeam: normalizeMatchToken(visibleFirstMatch.homeTeam),
    awayTeam: normalizeMatchToken(visibleFirstMatch.awayTeam),
  });

  if (!target) {
    console.log(`cycle=${cycle} trigger-detail-ui visibleFirst=${getVisibleText(visibleFirstMatch)} skipped reason=row-target-not-found`);
    return false;
  }

  console.log(`cycle=${cycle} trigger-detail-ui visibleFirst=${getVisibleText(visibleFirstMatch)}`);
  await page.mouse.click(target.x, target.y).catch(async () => {
    await page.mouse.click(target.x + 40, target.y);
  });
  return true;
}

async function triggerCurrentBoardFeedRefresh(cycle, page, visibleFirstMatch, reason, options = {}) {
  assertUsablePage(page);
  const responseMarker = options.responseMarker ?? FEED_URL_MARKER;
  const responseLabel = responseMarker === EVENT_DETAIL_URL_MARKER ? 'event-detail' : 'feed-events';

  const targets = await page.evaluate(({ visibleWeek, visibleLeague }) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight
      );
    };
    const clickableAncestor = (element) => {
      let candidate = element;

      while (candidate && candidate !== document.body) {
        const tagName = candidate.tagName.toLowerCase();
        const role = candidate.getAttribute('role') || '';
        const className = String(candidate.className || '');

        if (
          tagName === 'button' ||
          tagName === 'a' ||
          role === 'tab' ||
          role === 'button' ||
          /(?:active|selected|current|week|league|tab)/i.test(className)
        ) {
          return candidate;
        }

        candidate = candidate.parentElement;
      }

      return element;
    };
    const targetInfo = (element) => {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: normalizeText(element.innerText || element.textContent).slice(0, 80),
        top: rect.top,
        left: rect.left,
      };
    };
    const elements = Array.from(document.querySelectorAll('body *'))
      .filter(isVisible)
      .map((element) => ({
        element,
        text: normalizeText(element.innerText || element.textContent),
      }))
      .filter((item) => item.text && item.text.length <= 80);

    const candidates = [];
    if (visibleWeek) {
      candidates.push(new RegExp(`\\bWEEK\\s+${visibleWeek}\\b`, 'i'));
      candidates.push(new RegExp(`^${visibleWeek}$`, 'i'));
    }
    if (visibleLeague) {
      candidates.push(new RegExp(`\\bLEAGUE\\s+${visibleLeague}\\b`, 'i'));
      candidates.push(new RegExp(`^${visibleLeague}$`, 'i'));
    }

    const match = candidates
      .flatMap((pattern) => elements.filter((item) => pattern.test(item.text)))
      .map((item) => clickableAncestor(item.element))
      .find(Boolean);
    const fallback = match || elements
      .map((item) => clickableAncestor(item.element))
      .find((element) => {
        const className = String(element.className || '');
        const role = element.getAttribute('role') || '';
        return role === 'tab' || /(?:active|selected|current).*(?:week|league|tab)|(?:week|league|tab).*(?:active|selected|current)/i.test(className);
      });

    const tabTargets = [];
    const seenTargets = new Set();
    elements
      .map((item) => clickableAncestor(item.element))
      .filter(Boolean)
      .forEach((element) => {
        const className = String(element.className || '');
        const role = element.getAttribute('role') || '';
        const text = normalizeText(element.innerText || element.textContent);
        const isWeekLike = role === 'tab' || /\bWEEK\b/i.test(text) || /(?:week|league|tab)/i.test(className);

        if (!isWeekLike) {
          return;
        }

        const rect = element.getBoundingClientRect();
        const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
        if (seenTargets.has(key)) {
          return;
        }

        seenTargets.add(key);
        tabTargets.push({
          element,
          info: targetInfo(element),
          selected: element === fallback || /(?:active|selected|current)/i.test(className) || element.getAttribute('aria-selected') === 'true',
        });
      });

    const active = targetInfo(fallback);
    const alternate = tabTargets
      .filter((item) => active && (Math.abs(item.info.x - active.x) > 2 || Math.abs(item.info.y - active.y) > 2))
      .sort((a, b) => Math.abs(a.info.top - (active?.top ?? 0)) - Math.abs(b.info.top - (active?.top ?? 0)) || a.info.left - b.info.left)[0]?.info ?? null;

    return {
      active,
      alternate,
    };
  }, {
    visibleWeek: visibleFirstMatch?.visibleWeek ?? null,
    visibleLeague: visibleFirstMatch?.visibleLeague ?? null,
  });

  if (!targets?.active) {
    console.log(
      `cycle=${cycle} trigger-feed-refresh skipped reason=target-not-found domFirst=${getVisibleText(visibleFirstMatch)}`,
    );
  }

  const waitForFeedEventsResponse = async (method, action, timeoutMs = 3_000) => {
    const startedAt = Date.now();
    console.log(`cycle=${cycle} trigger-feed-refresh method=${method}`);
    const responsePromise = page.waitForResponse((candidate) => (
      candidate.url().includes(responseMarker) &&
      candidate.request().method() === 'GET' &&
      candidate.status() === 200
    ), { timeout: timeoutMs }).catch(() => null);

    await action().catch((error) => {
      console.log(`cycle=${cycle} trigger-feed-refresh method=${method} action-error=${error.message || error}`);
    });

    const response = await responsePromise;
    if (response) {
      console.log(`cycle=${cycle} ${responseLabel}-response-after-refresh ms=${Date.now() - startedAt}`);
      return true;
    }

    return false;
  };

  if (targets?.active) {
    console.log(
      `cycle=${cycle} trigger-feed-refresh reason=${reason} domFirst=${getVisibleText(visibleFirstMatch)} target=${targets.active.text}`,
    );
    const activeClicked = await waitForFeedEventsResponse('active-week-click', async () => {
      await page.mouse.click(targets.active.x, targets.active.y).catch(async () => {
        await page.mouse.click(Math.max(1, targets.active.x - 20), targets.active.y);
      });
    });

    if (activeClicked) {
      return true;
    }
  }

  if (options.activeOnly) {
    return false;
  }

  if (targets?.alternate && targets?.active) {
    const toggled = await waitForFeedEventsResponse('week-tab-toggle', async () => {
      await page.mouse.click(targets.alternate.x, targets.alternate.y);
      await sleep(250);
      await page.mouse.click(targets.active.x, targets.active.y);
    });

    if (toggled) {
      return true;
    }
  }

  if (!options.allowReloadFallback) {
    return false;
  }

  return waitForFeedEventsResponse('page-reload-fallback', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
  }, 15_000);
}

async function requestEventDetailByProviderEventId(cycle, page, providerEventId, reason) {
  assertUsablePage(page);

  if (!providerEventId) {
    return false;
  }

  console.log(
    `cycle=${cycle} ACTIVE-EVENT-DETAIL-FETCH-DISABLED ` +
      `providerEventId=${providerEventId} reason=${reason}`,
  );
  return false;
}

function canonicalMatchesVisible(firstCanonicalEvent, visibleFirstMatch) {
  if (!visibleFirstMatch) {
    return false;
  }

  return (
    normalizeMatchToken(firstCanonicalEvent.homeTeam) === normalizeMatchToken(visibleFirstMatch.homeTeam) &&
    normalizeMatchToken(firstCanonicalEvent.awayTeam) === normalizeMatchToken(visibleFirstMatch.awayTeam)
  );
}

function hasMarketSelections(event) {
  return (event.markets ?? []).some((market) => (market.selections ?? []).length > 0);
}

function validateCanonicalEvents(canonicalEvents) {
  if (!Array.isArray(canonicalEvents) || canonicalEvents.length === 0) {
    return {
      valid: false,
      reason: 'events=0',
    };
  }

  for (const [index, event] of canonicalEvents.entries()) {
    const missing = [];

    if (event.leagueId === null || event.leagueId === undefined || event.leagueId === '') missing.push('leagueId');
    if (!event.leagueName) missing.push('leagueName');
    if (!event.homeTeam) missing.push('homeTeam');
    if (!event.awayTeam) missing.push('awayTeam');
    if (!event.startTime) missing.push('startTime');
    if (!hasMarketSelections(event)) missing.push('marketSelections');

    if (missing.length > 0) {
      return {
        valid: false,
        reason: `event[${index}] missing ${missing.join(',')}`,
      };
    }
  }

  return {
    valid: true,
    reason: '',
  };
}

function getFirstText(canonicalEvents) {
  const firstEvent = canonicalEvents[0] ?? {};
  return `${firstEvent.homeTeam ?? ''} vs ${firstEvent.awayTeam ?? ''}`;
}

function getVisibleText(visibleFirstMatch) {
  if (!visibleFirstMatch) {
    return 'not found';
  }

  return visibleFirstMatch.text ?? `${visibleFirstMatch.homeTeam ?? ''} vs ${visibleFirstMatch.awayTeam ?? ''}`;
}

function logVisibleSnapshot(cycle, visibleFirstMatch) {
  console.log(`cycle=${cycle} visibleLeague=${visibleFirstMatch?.visibleLeague ?? 'not found'}`);
  console.log(`cycle=${cycle} visibleWeek=${visibleFirstMatch?.visibleWeek ?? 'not found'}`);
  console.log(`cycle=${cycle} visibleFirst=${getVisibleText(visibleFirstMatch)}`);
  console.log(`cycle=${cycle} visibleCountdown=${visibleFirstMatch?.countdownText ?? 'not found'} seconds=${visibleFirstMatch?.countdownSeconds ?? 'not found'}`);
}

function applyVisibleMetadataToCanonicalEvents(canonicalEvents, visibleFirstMatch) {
  if (!visibleFirstMatch) {
    return canonicalEvents;
  }

  const firstMatch = getVisibleText(visibleFirstMatch);

  return canonicalEvents.map((event) => ({
    ...event,
    leagueNumber: visibleFirstMatch.visibleLeague ?? event.leagueNumber ?? event.leagueId ?? null,
    weekNumber: visibleFirstMatch.visibleWeek ?? event.weekNumber ?? null,
    firstMatch,
    visibleLeague: visibleFirstMatch.visibleLeague ?? null,
    visibleWeek: visibleFirstMatch.visibleWeek ?? null,
    visibleFirst: firstMatch,
  }));
}

function getVisibleMatchCacheKey(visibleFirstMatch) {
  return getEventDetailCacheKey({
    leagueNumber: visibleFirstMatch?.visibleLeague,
    weekNumber: visibleFirstMatch?.visibleWeek,
    firstMatch: getVisibleText(visibleFirstMatch),
  });
}

function getEventDetailCacheKey({ leagueNumber, weekNumber, firstMatch }) {
  return [
    String(leagueNumber ?? 'unknown'),
    String(weekNumber ?? 'unknown'),
    normalizeMatchToken(firstMatch),
  ].join('|');
}

function getCanonicalFirstMatchText(canonicalEvents) {
  const firstEvent = canonicalEvents[0] ?? {};
  return `${firstEvent.homeTeam ?? ''} vs ${firstEvent.awayTeam ?? ''}`;
}

function cacheParsedEventDetail(cycle, eventDetailCache, capture, parsedEventDetail, visibleFirstMatch = null) {
  if (!eventDetailCache) {
    return;
  }

  const firstEvent = parsedEventDetail.canonicalEvents[0] ?? null;
  const firstMatch = getCanonicalFirstMatchText(parsedEventDetail.canonicalEvents);
  const cacheKey = getEventDetailCacheKey({
    leagueNumber: visibleFirstMatch?.visibleLeague,
    weekNumber: visibleFirstMatch?.visibleWeek,
    firstMatch,
  });

  if (!firstEvent) {
    return;
  }

  eventDetailCache.set(cacheKey, {
    capture,
    parsedEventDetail,
    providerEventId: parsedEventDetail.eventFeedId,
    leagueNumber: visibleFirstMatch?.visibleLeague ?? null,
    weekNumber: visibleFirstMatch?.visibleWeek ?? null,
    leagueName: firstEvent.leagueName ?? null,
    firstMatch,
    eventFeedId: parsedEventDetail.eventFeedId,
    cachedAt: Date.now(),
  });
  console.log(
    `cycle=${cycle} source=event-detail cache-add key=${cacheKey} firstMatch=${firstMatch} ` +
      `providerEventId=${parsedEventDetail.eventFeedId}`,
  );
}

async function postCachedEventDetailForVisibleFirst(cycle, eventDetailCache, visibleFirstMatch, lastPostedHashes) {
  const visibleFirst = getVisibleText(visibleFirstMatch);
  const cached = eventDetailCache?.get(getVisibleMatchCacheKey(visibleFirstMatch));

  if (!cached) {
    console.log(`cycle=${cycle} source=event-detail cache-miss visibleFirst=${visibleFirst}`);
    return {
      posted: false,
      source: 'event-detail',
      reason: 'cache-miss',
      cacheMiss: true,
    };
  }

  console.log(`cycle=${cycle} source=event-detail cache-hit visibleFirst=${visibleFirst} detailFirst=${cached.firstMatch}`);
  return processCapturedEventDetail(cycle, cached.capture, lastPostedHashes, {
    parsedEventDetail: cached.parsedEventDetail,
    visibleFirstMatch,
  });
}

function logSourceResult(cycle, source, canonicalEvents, status, reason, extra = {}) {
  const first = getFirstText(canonicalEvents);
  const eventFeedId = extra.eventFeedId ? ` eventFeedId=${extra.eventFeedId}` : '';
  const batchId = extra.batchId ? ` batchId=${extra.batchId}` : '';
  const errors = extra.errors ? ` errors=${JSON.stringify(extra.errors)}` : '';

  console.log(
    `cycle=${cycle} source=${source}${eventFeedId} first=${first} events=${canonicalEvents.length} ${status} reason=${reason}${batchId}${errors}`,
  );
}

function logSocketUpdateEmission(cycle, source, canonicalEvents, result) {
  if (source !== 'event-detail') {
    return;
  }

  console.log(
    `cycle=${cycle} source=${source} socket update emitted first="${getFirstText(canonicalEvents)}" events=${canonicalEvents.length} batchId=${result.batchId ?? ''}`,
  );
}

function getCanonicalEventCounts(canonicalEvents) {
  const marketCount = canonicalEvents.reduce((total, event) => total + (event.markets ?? []).length, 0);
  const selectionCount = canonicalEvents.reduce(
    (total, event) => total + (event.markets ?? []).reduce((marketTotal, market) => marketTotal + (market.selections ?? []).length, 0),
    0,
  );

  return {
    eventCount: canonicalEvents.length,
    marketCount,
    selectionCount,
  };
}

function getBoardPayloadCounts(boardPayload) {
  return getCanonicalEventCounts(boardPayload.events ?? []);
}

function getFeedCycleTiming(boardPayload, feedReceivedAt, visibleFirstMatch = null, previousTiming = null) {
  const feedStartAtMs = toEpochMs(boardPayload?.startTime ?? boardPayload?.events?.[0]?.startTime);
  let feedEndAtMs = toEpochMs(boardPayload?.endTime);
  const countdownSeconds = boardPayload?.countdownSeconds ?? visibleFirstMatch?.countdownSeconds ?? null;
  let durationMs = previousTiming?.durationMs ?? null;

  if (previousTiming?.startAtMs && feedStartAtMs && feedStartAtMs > previousTiming.startAtMs) {
    const observedDurationMs = feedStartAtMs - previousTiming.startAtMs;
    if (observedDurationMs >= 10_000 && observedDurationMs <= 20 * 60_000) {
      durationMs = observedDurationMs;
    }
  }

  if (!feedEndAtMs && Number.isFinite(countdownSeconds)) {
    feedEndAtMs = feedReceivedAt + (countdownSeconds * 1000);
  }

  if (!feedEndAtMs && feedStartAtMs && durationMs) {
    feedEndAtMs = feedStartAtMs + durationMs;
  }

  const nextRefreshAt = feedEndAtMs
    ? Math.max(feedReceivedAt + 1000, feedEndAtMs - FEED_REFRESH_NEAR_CYCLE_END_MS)
    : null;

  return {
    providerEventId: boardPayload?.providerEventId ?? '',
    startAtMs: feedStartAtMs,
    endAtMs: feedEndAtMs,
    durationMs,
    countdownSeconds,
    nextRefreshAt,
    source: feedEndAtMs
      ? (boardPayload?.endTime ? 'feed-endTime' : Number.isFinite(countdownSeconds) ? 'countdown' : 'estimated-duration')
      : 'unknown',
  };
}

function describeCycleTiming(timing) {
  if (!timing) {
    return 'timing=unknown';
  }

  return [
    `timingSource=${timing.source}`,
    `startAt=${timing.startAtMs ? new Date(timing.startAtMs).toISOString() : 'unknown'}`,
    `endAt=${timing.endAtMs ? new Date(timing.endAtMs).toISOString() : 'unknown'}`,
    `durationMs=${timing.durationMs ?? 'unknown'}`,
    `countdownSeconds=${timing.countdownSeconds ?? 'unknown'}`,
    `nextRefreshAt=${timing.nextRefreshAt ? new Date(timing.nextRefreshAt).toISOString() : 'unknown'}`,
  ].join(' ');
}

function createStartupWarmupState(startedAt = null) {
  return {
    startedAt,
    skippedCaptures: 0,
    pendingWarmupFeed: null,
  };
}

function resetStartupWarmupState(lastPostedState, startedAt = Date.now()) {
  lastPostedState.startupWarmup = createStartupWarmupState(startedAt);
}

function setPendingWarmupFeed(cycle, lastPostedState, pendingWarmupFeed, reason) {
  if (!lastPostedState.startupWarmup) {
    resetStartupWarmupState(lastPostedState, null);
  }

  const previousPending = lastPostedState.startupWarmup.pendingWarmupFeed;
  if (previousPending && pendingWarmupFeed.feedReceivedAt < previousPending.feedReceivedAt) {
    return false;
  }

  lastPostedState.startupWarmup.pendingWarmupFeed = pendingWarmupFeed;
  console.log(
    `cycle=${cycle} source=${FEED_EVENTS_SOURCE} startup-warmup-cache ` +
      `providerEventId=${pendingWarmupFeed.providerEventId} week=${pendingWarmupFeed.weekNumber ?? 'not found'} ` +
      `firstMatch=${pendingWarmupFeed.firstMatch} reason=${reason}`,
  );
  return true;
}

function captureStartupWarmupSkip(cycle, lastPostedState, boardPayload, feedReceivedAt, generation) {
  if (!lastPostedState.startupWarmup) {
    resetStartupWarmupState(lastPostedState, null);
  }

  lastPostedState.startupWarmup.skippedCaptures += 1;
  setPendingWarmupFeed(cycle, lastPostedState, {
    boardPayload,
    providerEventId: boardPayload.providerEventId,
    weekNumber: boardPayload.weekNumber,
    firstMatch: boardPayload.firstMatch,
    feedReceivedAt,
    generation,
  }, 'startup-warmup-skip');
}

function shouldSkipStartupWarmup(lastPostedState, feedReceivedAt) {
  const warmup = lastPostedState.startupWarmup;

  if (!warmup || !Number.isFinite(warmup.startedAt)) {
    return {
      skip: true,
      warmupAgeMs: null,
    };
  }

  const warmupAgeMs = feedReceivedAt - warmup.startedAt;
  return {
    skip: warmupAgeMs < STARTUP_FEED_WARMUP_MS,
    warmupAgeMs,
  };
}

async function releasePendingStartupWarmupFeed(cycle, lastPostedState, visibleFirstMatch = null) {
  const warmup = lastPostedState.startupWarmup;
  const pendingWarmupFeed = warmup?.pendingWarmupFeed;

  if (!pendingWarmupFeed || !Number.isFinite(warmup?.startedAt)) {
    return null;
  }

  const warmupAgeMs = Date.now() - warmup.startedAt;
  if (warmupAgeMs < STARTUP_FEED_WARMUP_MS) {
    return null;
  }

  if (pendingWarmupFeed.generation !== lastPostedState.generation) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} startup-warmup-release skipped reason=stale-feed-generation ` +
        `providerEventId=${pendingWarmupFeed.providerEventId}`,
    );
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      skipped: true,
      reason: 'stale-feed-generation',
    };
  }

  console.log(
    `cycle=${cycle} source=${FEED_EVENTS_SOURCE} startup-warmup-release ` +
      `providerEventId=${pendingWarmupFeed.providerEventId} week=${pendingWarmupFeed.weekNumber ?? 'not found'} ` +
      `firstMatch=${pendingWarmupFeed.firstMatch} warmupAgeMs=${warmupAgeMs}`,
  );

  return postFeedEventsBoard(cycle, pendingWarmupFeed.boardPayload, lastPostedState, {
    feedReceivedAt: pendingWarmupFeed.feedReceivedAt,
    generation: pendingWarmupFeed.generation,
    bypassStartupWarmup: true,
    visibleFirstMatch,
  });
}

function validateFeedBoardPayload(boardPayload) {
  if (!boardPayload || typeof boardPayload !== 'object') {
    return {
      valid: false,
      reason: 'missing board payload',
    };
  }

  if (!boardPayload.providerEventId) {
    return {
      valid: false,
      reason: 'missing providerEventId',
    };
  }

  if (!boardPayload.leagueNumber) {
    return {
      valid: false,
      reason: 'missing-league-id',
    };
  }

  if (!Array.isArray(boardPayload.events) || boardPayload.events.length === 0) {
    return {
      valid: false,
      reason: 'events=0',
    };
  }

  for (const [index, event] of boardPayload.events.entries()) {
    const missing = [];
    if (!event.provider) missing.push('provider');
    if (!event.providerEventId) missing.push('providerEventId');
    if (!event.matchId) missing.push('matchId');
    if (!event.eventId) missing.push('eventId');
    if (!event.sport) missing.push('sport');
    if (!event.leagueId) missing.push('leagueId');
    if (!event.leagueNumber) missing.push('leagueNumber');
    if (!event.providerLeagueId) missing.push('providerLeagueId');
    if (!event.leagueName) missing.push('leagueName');
    if (!event.homeTeam) missing.push('homeTeam');
    if (!event.awayTeam) missing.push('awayTeam');
    if (!event.startTime) missing.push('startTime');
    if (!hasMarketSelections(event)) missing.push('marketSelections');

    if (missing.length > 0) {
      return {
        valid: false,
        reason: `event[${index}] missing ${missing.join(',')}`,
      };
    }
  }

  return {
    valid: true,
    reason: '',
  };
}

function isVirtualApiUnreachableError(error) {
  return /Virtual API not reachable|ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(String(error?.message || error || ''));
}

function logFeedPostGated(reason) {
  console.log(`FEED-POST-GATED reason=${reason}`);
}

function logFeedEventsVirtualApiNotPosted(result = {}) {
  console.log(
    `VIRTUAL-API-NOT-POSTED source=${FEED_EVENTS_SOURCE} reason=${result.reason || 'not-posted'} ` +
      `domFirst=${result.domFirst || 'not found'} feedFirst=${result.feedFirst || result.firstMatch || 'not found'} ` +
      `providerEventId=${result.providerEventId || 'not found'}`,
  );
}

async function postFeedEventsBoard(cycle, boardPayload, lastPostedState, meta = {}) {
  const validation = validateFeedBoardPayload(boardPayload);
  const counts = getBoardPayloadCounts(boardPayload);
  const feedReceivedAt = meta.feedReceivedAt ?? Date.now();
  const generation = meta.generation ?? lastPostedState.generation ?? 0;
  const visibleFirstMatch = meta.visibleFirstMatch ?? null;
  const firstFeedEvent = boardPayload.events?.[0] ?? {};
  const feedFirst = boardPayload.firstMatch;
  const domFirst = visibleFirstMatch ? getVisibleText(visibleFirstMatch) : '';
  const matchesVisible = visibleFirstMatch ? canonicalMatchesVisible(firstFeedEvent, visibleFirstMatch) : false;
  const cycleTiming = getFeedCycleTiming(boardPayload, feedReceivedAt, visibleFirstMatch, meta.previousCycleTiming);
  const feedResultMeta = {
    providerEventId: boardPayload.providerEventId,
    firstMatch: boardPayload.firstMatch,
    week: boardPayload.weekNumber,
    weekNumber: boardPayload.weekNumber,
    feedFirst,
    domFirst,
    matchesVisible,
    cycleTiming,
  };

  if (!validation.valid) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload?.providerEventId ?? ''} skipped reason=${validation.reason}`,
    );
    logFeedPostGated(validation.reason);
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: validation.reason,
      invalid: true,
      ...feedResultMeta,
    };
  }

  if (generation !== lastPostedState.generation) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} skipped reason=stale-feed-generation`,
    );
    logFeedPostGated('stale-feed-generation');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'stale-feed-generation',
      skipped: true,
      ...feedResultMeta,
    };
  }

  if (domFirst && feedFirst && domFirst !== feedFirst) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} domFirst=${domFirst} feedFirst=${feedFirst} ` +
        'skipped reason=visible-feed-mismatch',
    );
    logFeedPostGated('visible-feed-mismatch');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      skipped: true,
      mismatch: true,
      reason: 'visible-feed-mismatch',
      ...feedResultMeta,
    };
  }

  if (feedReceivedAt < lastPostedState.latestSeenFeedReceivedAt) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} skipped reason=out-of-order-feed`,
    );
    logFeedPostGated('out-of-order-feed');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'out-of-order-feed',
      skipped: true,
      ...feedResultMeta,
    };
  }

  if (lastPostedState.providerEventId === boardPayload.providerEventId) {
    console.log(
      `cycle=${cycle} ACTION no-repeat providerEventId=${boardPayload.providerEventId}`,
    );
    logFeedPostGated('repeat-providerEventId');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'repeat-providerEventId',
      skipped: true,
      noRepeat: true,
      ...feedResultMeta,
    };
  }

  lastPostedState.latestSeenFeedReceivedAt = feedReceivedAt;
  lastPostedState.latestSeenProviderEventId = boardPayload.providerEventId;
  await sleep(250);

  if (generation !== lastPostedState.generation || feedReceivedAt < lastPostedState.latestSeenFeedReceivedAt) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} skipped reason=out-of-order-feed`,
    );
    logFeedPostGated('out-of-order-feed');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'out-of-order-feed',
      skipped: true,
      ...feedResultMeta,
    };
  }

  if (lastPostedState.providerEventId === boardPayload.providerEventId) {
    console.log(
      `cycle=${cycle} ACTION no-repeat providerEventId=${boardPayload.providerEventId}`,
    );
    logFeedPostGated('repeat-providerEventId');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'repeat-providerEventId',
      skipped: true,
      noRepeat: true,
      ...feedResultMeta,
    };
  }

  const oddsHash = hashCanonicalEvents(boardPayload);
  if (lastPostedState.providerEventId === boardPayload.providerEventId && lastPostedState.oddsHash === oddsHash) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} firstMatch=${boardPayload.firstMatch} skipped reason=unchanged`,
    );
    logFeedPostGated('unchanged');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      reason: 'unchanged',
      hash: oddsHash,
      ...feedResultMeta,
    };
  }

  if (TEST_BLOCK_FEED_EVENTS) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} skipped reason=test-mode-posting-disabled`,
    );
    logFeedPostGated('test-mode-posting-disabled');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      skipped: true,
      reason: 'test-mode-posting-disabled',
      hash: oddsHash,
      ...feedResultMeta,
    };
  }

  const detailCounts = LOG_ODDS_DETAILS
    ? ` eventCount=${counts.eventCount} marketCount=${counts.marketCount} selectionCount=${counts.selectionCount}`
    : '';
  console.log(
    `POSTING source=${FEED_EVENTS_SOURCE} league=${boardPayload.leagueNumber ?? 'not found'} week=${boardPayload.weekNumber ?? 'not found'} ` +
      `providerEventId=${boardPayload.providerEventId} firstMatch=${boardPayload.firstMatch}${detailCounts} ` +
      describeCycleTiming(cycleTiming),
  );

  let result;

  try {
    result = await postCanonicalEvents(boardPayload);
  } catch (error) {
    const reason = isVirtualApiUnreachableError(error) ? 'virtual-api-unreachable-drop-payload' : (error.message || String(error));
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} skipped reason=${reason}`,
    );
    logFeedPostGated(reason);
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      dropped: true,
      reason,
      ...feedResultMeta,
    };
  }

  lastPostedState.providerEventId = boardPayload.providerEventId;
  lastPostedState.oddsHash = oddsHash;
  if (lastPostedState.startupWarmup?.pendingWarmupFeed?.feedReceivedAt <= feedReceivedAt) {
    lastPostedState.startupWarmup.pendingWarmupFeed = null;
  }
  console.log(
    `cycle=${cycle} source=${FEED_EVENTS_SOURCE} first=${boardPayload.firstMatch} events=${counts.eventCount} posted reason=ok batchId=${result.batchId ?? ''} errors=${JSON.stringify(result.errors ?? [])}`,
  );
  console.log(
    `VIRTUAL-API-POSTED source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId || 'not found'} ` +
      `week=${boardPayload.weekNumber || 'not found'} firstMatch=${boardPayload.firstMatch || 'not found'}`,
  );
  registerResultLedgerEventBoard(boardPayload, { ...feedResultMeta, cycleTiming }, FEED_EVENTS_SOURCE);

  return {
    posted: true,
    source: FEED_EVENTS_SOURCE,
    hash: oddsHash,
    batchId: result.batchId ?? '',
    result,
    ...feedResultMeta,
  };
}

async function handleFeedEventsResponse(cycle, json, lastPostedState, meta = {}) {
  const board = getCurrentFeedBoard(json);
  if (!board) {
    console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} skipped reason=missing-board`);
    logFeedPostGated('missing-board');
    return {
      posted: false,
      source: FEED_EVENTS_SOURCE,
      skipped: true,
      reason: 'missing-board',
    };
  }

  const boardPayload = parseFeedEventsBoard(json);
  const counts = getBoardPayloadCounts(boardPayload);
  if (meta.visibleFirstMatch !== undefined) {
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} domFirst=${getVisibleText(meta.visibleFirstMatch)} ` +
        `feedFirst=${boardPayload.firstMatch}`,
    );
  }

  console.log(
    `cycle=${cycle} source=${FEED_EVENTS_SOURCE} providerEventId=${boardPayload.providerEventId} ` +
      `league=${boardPayload.leagueNumber ?? 'not found'} week=${boardPayload.weekNumber ?? 'not found'} ` +
      `firstMatch=${boardPayload.firstMatch} eventCount=${counts.eventCount}`,
  );

  return postFeedEventsBoard(cycle, boardPayload, lastPostedState, meta);
}

async function postCanonicalEventsForSource(cycle, source, canonicalEvents, lastPostedHashes, extra = {}) {
  if (source !== 'event-detail') {
    logSourceResult(cycle, source, canonicalEvents, 'skipped', `${source} is not a primary odds source`, extra);
    return {
      posted: false,
      source,
      skipped: true,
      reason: `${source} is not a primary odds source`,
    };
  }

  const validation = validateCanonicalEvents(canonicalEvents);

  if (!validation.valid) {
    logSourceResult(cycle, source, canonicalEvents, 'skipped', validation.reason, extra);
    return {
      posted: false,
      source,
      reason: validation.reason,
      invalid: true,
    };
  }

  const visibleFirstMatch = extra.visibleFirstMatch ?? null;
  const eventsToPost = applyVisibleMetadataToCanonicalEvents(canonicalEvents, visibleFirstMatch);
  const first = getFirstText(eventsToPost);
  const visible = getVisibleText(visibleFirstMatch);

  if (!canonicalMatchesVisible(eventsToPost[0] ?? {}, visibleFirstMatch)) {
    throw new Error(`POST blocked: source=${source} first=${first} visible=${visible}`);
  }

  const nextHash = hashCanonicalEvents(eventsToPost);

  if (lastPostedHashes.get(source) === nextHash) {
    logSourceResult(cycle, source, eventsToPost, 'skipped', 'unchanged', extra);
    return {
      posted: false,
      source,
      reason: 'unchanged',
      hash: nextHash,
    };
  }

  if (TEST_BLOCK_FEED_EVENTS) {
    logSourceResult(cycle, source, eventsToPost, 'skipped', 'test-mode-posting-disabled', extra);
    return {
      posted: false,
      source,
      skipped: true,
      reason: 'test-mode-posting-disabled',
      hash: nextHash,
    };
  }

  const counts = getCanonicalEventCounts(eventsToPost);
  const firstEvent = eventsToPost[0] ?? {};
  const detailCounts = LOG_ODDS_DETAILS
    ? ` eventCount=${counts.eventCount} marketCount=${counts.marketCount} selectionCount=${counts.selectionCount}`
    : '';
  console.log(
    `POSTING source=${source} league=${firstEvent.leagueNumber ?? 'not found'} week=${firstEvent.weekNumber ?? 'not found'} ` +
      `providerEventId=${extra.eventFeedId ?? firstEvent.providerEventId ?? ''} firstMatch=${firstEvent.firstMatch ?? first}${detailCounts}`,
  );

  const result = await postCanonicalEvents(eventsToPost);
  lastPostedHashes.set(source, nextHash);
  logSocketUpdateEmission(cycle, source, eventsToPost, result);
  logSourceResult(cycle, source, eventsToPost, 'posted', 'ok', {
    ...extra,
    batchId: result.batchId,
    errors: result.errors ?? [],
  });
  registerResultLedgerCanonicalEvents(eventsToPost, { ...extra, result }, source);

  return {
    posted: true,
    source,
    hash: nextHash,
    result,
  };
}

async function countVisibleFixtureRows(page) {
  const firstVisibleMatch = await readVisibleFirstMatch(page).catch(() => null);
  return firstVisibleMatch ? 1 : 0;
}

async function processCapturedEventDetail(cycle, capturedEventDetail, lastPostedHashes, options = {}) {
  if (!capturedEventDetail) {
    return {
      posted: false,
      missing: true,
      reason: 'missing',
    };
  }

  if (!capturedEventDetail.json) {
    capturedEventDetail.json = JSON.parse(capturedEventDetail.body);
  }

  await dumpResultsFirstMatchJson(capturedEventDetail.json, capturedEventDetail.url);
  const eventDetailPacket = classifyEventDetailPacket(capturedEventDetail.json, capturedEventDetail.url);
  const visibleFirstMatch = options.visibleFirstMatch ?? null;
  const visibleFirstText = visibleFirstMatch ? visibleFirstMatch.text : '';
  const resultCandidateFirstText = eventDetailPacket.resultsPayload.matches[0]?.teams || 'not found';
  const resultCandidateMatchesVisible = (
    visibleFirstText &&
    resultCandidateFirstText &&
    resultCandidateFirstText !== 'not found' &&
    visibleFirstText === resultCandidateFirstText
  );

  if (eventDetailPacket.isResultCandidate) {
    logResultCandidate(eventDetailPacket);
  }

  if (eventDetailPacket.isResultCandidate && isKnownFirstMatchMismatch(visibleFirstText, resultCandidateFirstText)) {
    logResultCandidateBypassMismatch(
      eventDetailPacket,
      visibleFirstText || 'not found',
      resultCandidateFirstText || 'not found',
    );
  }

  if (eventDetailPacket.hasResults) {
    const { monitorPayload, monitorResult } = await processResultMonitorPacket(eventDetailPacket);
    return {
      posted: false,
      source: 'event-detail-results',
      skipped: true,
      reason: 'results-packet-detected',
      eventFeedId: eventDetailPacket.providerEventId,
      providerEventId: eventDetailPacket.providerEventId,
      eventType: eventDetailPacket.eventType,
      matchCount: eventDetailPacket.matchCount,
      resultsPayload: eventDetailPacket.resultsPayload,
      monitorPayload,
      monitorResult,
      domFirst: visibleFirstText || 'not found',
      feedFirst: resultCandidateFirstText,
      matchesVisible: Boolean(resultCandidateMatchesVisible),
    };
  }

  const { event, matches, canonicalEvents, eventFeedId } = options.parsedEventDetail ?? parseCapturedEventDetail(capturedEventDetail);
  logEventDetailShape(cycle, eventFeedId, event, matches);
  logEventDetailRealtimeSummary(cycle, eventFeedId, event, matches, canonicalEvents);

  const detailFirstText = getFirstText(canonicalEvents);
  console.log(`cycle=${cycle} source=event-detail visibleFirst=${visibleFirstText || 'not found'} detailFirst=${detailFirstText}`);
  const matchesVisible = canonicalMatchesVisible(canonicalEvents[0] ?? {}, visibleFirstMatch);

  if (!matchesVisible && eventDetailPacket.isResultCandidate && isKnownFirstMatchMismatch(visibleFirstText, detailFirstText)) {
    logResultCandidateBypassMismatch(eventDetailPacket, visibleFirstText || 'not found', detailFirstText || 'not found');
  }

  if (!matchesVisible && !eventDetailPacket.isResultCandidate) {
    console.log(
      `cycle=${cycle} source=event-detail skipped reason=visible-mismatch visibleFirst=${visibleFirstText || 'not found'} detailFirst=${detailFirstText}`,
    );
    return {
      posted: false,
      source: 'event-detail',
      skipped: true,
      reason: 'visible-mismatch',
      eventFeedId,
    };
  }

  logVirtualApiNotPosted({
    source: 'event-detail',
    reason: 'event-detail-monitor-only',
    providerEventId: eventFeedId,
    domFirst: visibleFirstText || 'not found',
    feedFirst: detailFirstText,
  });
  return {
    posted: false,
    source: 'event-detail',
    skipped: true,
    reason: 'event-detail-monitor-only',
    eventFeedId,
    providerEventId: eventFeedId,
    domFirst: visibleFirstText,
    feedFirst: detailFirstText,
  };
}

function getCapturedEventDetailFirstMatch(capturedEventDetail) {
  if (!capturedEventDetail) {
    return null;
  }

  try {
    const { canonicalEvents } = parseCapturedEventDetail(capturedEventDetail);
    return canonicalEvents[0] ?? null;
  } catch {
    return null;
  }
}

async function inspectCapturedFeed(cycle, capturedFeed, visibleFirstMatch) {
  if (!capturedFeed) {
    return {
      posted: false,
      source: 'feed-events',
      missing: true,
      reason: 'missing',
      candidateMatchIds: [],
    };
  }

  const discoveryEvents = getFeedDiscoveryEvents(capturedFeed.json);
  const firstDiscoveryEvent = discoveryEvents[0] ?? {};
  const canonicalText = `${firstDiscoveryEvent.homeTeam ?? ''} vs ${firstDiscoveryEvent.awayTeam ?? ''}`;
  const candidateMatchIds = getUniqueCandidateMatchIds(discoveryEvents.map((event) => event.matchId));

  console.log(`transition fetch mode: ${capturedFeed.mode ?? 'unknown'}`);
  console.log(`cycle=${cycle} feedUrl=${capturedFeed.url}`);
  console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} candidateMatchIds=${JSON.stringify(candidateMatchIds)}`);
  console.log(`visible: ${visibleFirstMatch ? visibleFirstMatch.text : 'not found'}`);
  console.log(`feed: ${canonicalText}`);
  console.log(`visible first row: ${visibleFirstMatch ? visibleFirstMatch.text : 'not found'}`);
  console.log(`cycle=${cycle} first matchId=${firstDiscoveryEvent.matchId ?? ''}`);
  console.log(`cycle=${cycle} first homeTeam=${firstDiscoveryEvent.homeTeam ?? ''} awayTeam=${firstDiscoveryEvent.awayTeam ?? ''}`);
  console.log(`cycle=${cycle} first startTime=${firstDiscoveryEvent.startTime ?? ''}`);
  console.log(`canonical first event: ${canonicalText}`);
  console.log(`first canonical event: ${canonicalText}`);

  if (!canonicalMatchesVisible(firstDiscoveryEvent, visibleFirstMatch)) {
    console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} first=${canonicalText} events=${discoveryEvents.length} skipped reason=visible/feed mismatch`);
    return {
      posted: false,
      source: 'feed-events',
      mismatch: true,
      reason: 'visible/feed mismatch',
      candidateMatchIds,
    };
  }

  console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} first=${canonicalText} events=${discoveryEvents.length} skipped reason=feed-events used for discovery only`);
  return {
    posted: false,
    source: 'feed-events',
    discoveryOnly: true,
    reason: 'feed-events used for discovery only',
    matchId: firstDiscoveryEvent.matchId ?? null,
    firstMatch: firstDiscoveryEvent,
    eventCount: discoveryEvents.length,
    candidateMatchIds,
  };
}

async function isTransitionPopupVisible(page) {
  assertUsablePage(page);

  return page
    .getByText(TRANSITION_TEXT, { exact: false })
    .first()
    .isVisible({ timeout: 250 })
    .catch(() => false);
}

async function isLoginPageVisible(page) {
  assertUsablePage(page);

  try {
    const currentUrl = new URL(page.url());
    if (currentUrl.pathname === '/' || /login/i.test(currentUrl.pathname)) {
      return true;
    }
  } catch {
    // Fall through to form detection.
  }

  const loginField = await getFirstVisibleLocator(page, USERNAME_SELECTORS, 500);
  return Boolean(loginField);
}

async function inspectLoginPageEvidence(page) {
  assertUsablePage(page);

  const [usernameField, passwordField] = await Promise.all([
    getFirstVisibleLocator(page, USERNAME_SELECTORS, 500).catch(() => null),
    getFirstVisibleLocator(page, PASSWORD_SELECTORS, 500).catch(() => null),
  ]);
  const loginButtonVisible = await Promise.any([
    page.locator('button.shop-login-button').first().isVisible({ timeout: 500 }),
    page.getByText('LOGIN', { exact: true }).first().isVisible({ timeout: 500 }),
    page.locator('button').filter({ hasText: /login/i }).first().isVisible({ timeout: 500 }),
  ]).catch(() => false);
  const pageState = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const normalized = text.replace(/\s+/g, ' ').trim();
    const url = window.location.href;
    return {
      url,
      authenticationTextVisible: /\b(?:AUTHENTICATION|LOGIN|USERNAME|PASSWORD)\b/i.test(normalized),
      authenticatedContentVisible: /\b(?:BALANCE|NO MORE BETS|SKIP TO NEXT GAMES|FOOTBALL|LEAGUE|WEEK)\b/i.test(normalized),
      textSample: normalized.slice(0, 160),
    };
  }).catch(() => ({
    url: '',
    authenticationTextVisible: false,
    authenticatedContentVisible: false,
    textSample: '',
  }));

  const usernameVisible = Boolean(usernameField);
  const passwordVisible = Boolean(passwordField);
  const strongFieldEvidence = usernameVisible && passwordVisible && loginButtonVisible;
  const confident = strongFieldEvidence && !pageState.authenticatedContentVisible;

  return {
    usernameVisible,
    passwordVisible,
    loginButtonVisible,
    authenticationTextVisible: pageState.authenticationTextVisible,
    authenticatedContentVisible: pageState.authenticatedContentVisible,
    url: pageState.url,
    confident,
  };
}

function isAuthenticatedShopEvidence(loginEvidence) {
  if (!loginEvidence || loginEvidence.confident) {
    return false;
  }

  try {
    const currentUrl = new URL(loginEvidence.url || '');
    if (currentUrl.pathname.endsWith('/client/shop.jsp')) {
      return true;
    }
  } catch {
    // Fall through to content evidence.
  }

  return Boolean(loginEvidence.authenticatedContentVisible);
}

async function isBrowserNetworkErrorPage(page) {
  assertUsablePage(page);

  const url = page.url();
  const [title, bodyText] = await Promise.all([
    page.title().catch(() => ''),
    page.locator('body').innerText({ timeout: 1000 }).catch(() => ''),
  ]);
  const normalizedBody = String(bodyText || '').replace(/\s+/g, ' ');
  const hasNetworkErrorText = (
    /server not found/i.test(title) ||
    /can't connect to the server|can’t connect to the server/i.test(normalizedBody) ||
    /try again/i.test(normalizedBody)
  );
  const hasNormalHorizonContent = /\b(?:BALANCE|NO MORE BETS|SKIP TO NEXT GAMES|FOOTBALL|LEAGUE|WEEK|AUTHENTICATION|LOGIN)\b/i.test(normalizedBody);

  return (
    String(url || '').startsWith('about:neterror') ||
    (hasNetworkErrorText && !hasNormalHorizonContent)
  );
}

async function detectCurrentBrowserErrorPage(page) {
  return detectBrowserErrorPage(page);
}

async function inspectPageState(page) {
  assertUsablePage(page);

  const [browserError, loginEvidence, visibleFirstMatch, visibleCountdown] = await Promise.all([
    detectCurrentBrowserErrorPage(page).catch(() => ({ detected: false, type: null, url: page.url(), title: '' })),
    inspectLoginPageEvidence(page).catch(() => ({ confident: false, authenticatedContentVisible: false })),
    readVisibleFirstMatch(page).catch(() => null),
    readVisibleCountdown(page).catch(() => ({ found: false })),
  ]);
  const browserErrorPage = Boolean(browserError?.detected);
  const authenticatedApp = !browserErrorPage && !loginEvidence.confident && (
    isAuthenticatedShopEvidence(loginEvidence) ||
    Boolean(visibleFirstMatch) ||
    Boolean(visibleCountdown?.found)
  );
  const loginPage = !browserErrorPage && Boolean(loginEvidence.confident);

  return {
    browserErrorPage,
    browserError,
    loginPage,
    authenticatedApp,
    blankOrUnknown: !browserErrorPage && !loginPage && !authenticatedApp,
    loginEvidence,
    visibleFirstMatch,
    visibleCountdown,
    url: page.url(),
  };
}

async function getBalanceAuthStatus(page) {
  assertUsablePage(page);

  return page.evaluate(async (balancePath) => {
    const response = await fetch(new URL(balancePath, window.location.origin).toString(), {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });

    return {
      status: response.status,
      ok: response.ok,
    };
  }, BALANCE_URL_MARKER).catch((error) => ({
    status: null,
    ok: false,
    error: error.message || String(error),
  }));
}

async function getSessionExpiryReason(page, lastEventDetailAt) {
  const visibleRows = await countVisibleFixtureRows(page);
  const balanceStatus = await getBalanceAuthStatus(page);
  const eventDetailAgeMs = Date.now() - lastEventDetailAt;

  const loginEvidence = await inspectLoginPageEvidence(page).catch(() => ({ confident: false }));

  if (loginEvidence.confident) {
    return 'confirmed-login-form';
  }

  if (await isLoginPageVisible(page)) {
    if (balanceStatus.status === 401 || balanceStatus.status === 403) {
      return `balance-${balanceStatus.status}`;
    }

    if (balanceStatus.status === 405 || balanceStatus.ok) {
      return null;
    }

    return visibleRows === 0 && eventDetailAgeMs > EVENT_DETAIL_HEARTBEAT_STALE_MS
      ? 'login-page-or-form-visible-and-authenticated-feed-missing'
      : null;
  }

  if (balanceStatus.status === 401 || balanceStatus.status === 403) {
    return `balance-${balanceStatus.status}`;
  }

  if (visibleRows === 0 && eventDetailAgeMs > EVENT_DETAIL_HEARTBEAT_STALE_MS) {
    return `no-visible-fixtures-and-event-detail-stale-${Math.round(eventDetailAgeMs / 1000)}s`;
  }

  return null;
}

async function waitForEventDetailMatch(eventDetailCapture, visibleFirstMatch, options = {}) {
  const timeoutMs = options.timeoutMs ?? STARTUP_EVENT_DETAIL_WAIT_MS;
  const startedAt = options.since ?? Date.now();
  const eventDetailCache = options.eventDetailCache ?? null;

  if (!visibleFirstMatch) {
    return null;
  }

  const cached = eventDetailCache?.get(getVisibleMatchCacheKey(visibleFirstMatch));
  if (cached) {
    console.log(`source=event-detail cache-hit visibleFirst=${getVisibleText(visibleFirstMatch)} detailFirst=${cached.firstMatch}`);
    return cached.capture;
  }

  if (options.includeExisting) {
    const existingEventDetail = await eventDetailCapture.latest();
    const existingDetailFirst = getCapturedEventDetailFirstMatch(existingEventDetail);
    if (existingDetailFirst) {
      const existingDetailFirstText = `${existingDetailFirst.homeTeam ?? ''} vs ${existingDetailFirst.awayTeam ?? ''}`;
      console.log(
        `source=event-detail visibleFirst=${getVisibleText(visibleFirstMatch)} detailFirst=${existingDetailFirstText} ` +
          `status=${canonicalMatchesVisible(existingDetailFirst, visibleFirstMatch) ? 'matched' : 'waiting'}`,
      );
    }

    if (existingDetailFirst && canonicalMatchesVisible(existingDetailFirst, visibleFirstMatch)) {
      return existingEventDetail;
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    const currentCached = eventDetailCache?.get(getVisibleMatchCacheKey(visibleFirstMatch));
    if (currentCached) {
      console.log(`source=event-detail cache-hit visibleFirst=${getVisibleText(visibleFirstMatch)} detailFirst=${currentCached.firstMatch}`);
      return currentCached.capture;
    }

    const eventDetails = await eventDetailCapture.allSince(startedAt);
    const matchingEventDetail = eventDetails.find((eventDetail) => {
      const firstMatch = getCapturedEventDetailFirstMatch(eventDetail);
      return firstMatch && canonicalMatchesVisible(firstMatch, visibleFirstMatch);
    });
    const latestEventDetail = eventDetails[eventDetails.length - 1] ?? null;
    const detailFirst = getCapturedEventDetailFirstMatch(latestEventDetail);
    const detailFirstText = detailFirst ? `${detailFirst.homeTeam ?? ''} vs ${detailFirst.awayTeam ?? ''}` : 'not found';

    if (latestEventDetail) {
      console.log(
        `source=event-detail visibleFirst=${getVisibleText(visibleFirstMatch)} detailFirst=${detailFirstText} ` +
          `status=${canonicalMatchesVisible(detailFirst ?? {}, visibleFirstMatch) ? 'matched' : 'waiting'}`,
      );
    }

    if (matchingEventDetail) {
      return matchingEventDetail;
    }

    await sleep(500);
  }

  return null;
}

function getUniqueCandidateMatchIds(candidateMatchIds) {
  return Array.from(new Set((candidateMatchIds ?? [])
    .map((matchId) => String(matchId ?? '').trim())
    .filter((matchId) => matchId && matchId !== 'null' && matchId !== 'undefined')));
}

async function triggerFeedFirstDetailAndWait(cycle, page, feedResult, visibleFirstMatch, eventDetailCapture, lastPostedHashes, eventDetailCache) {
  if (!feedResult || feedResult.mismatch || !visibleFirstMatch) {
    return {
      posted: false,
      source: 'event-detail',
      reason: 'trigger-detail unavailable',
    };
  }

  return triggerVisibleDetailAndWait(cycle, page, visibleFirstMatch, eventDetailCapture, lastPostedHashes, eventDetailCache);
}

async function triggerVisibleDetailAndWait(cycle, page, visibleFirstMatch, eventDetailCapture, lastPostedHashes, eventDetailCache) {
  if (!visibleFirstMatch) {
    return {
      posted: false,
      source: 'event-detail',
      reason: 'trigger-detail unavailable',
    };
  }

  const waitStartedAt = Date.now();
  const urlBeforeTrigger = page.url();
  const triggered = await triggerVisibleFirstDetailLoad(cycle, page, visibleFirstMatch);
  if (!triggered) {
    return {
      posted: false,
      source: 'event-detail',
      reason: 'trigger-detail failed',
    };
  }

  let matchingEventDetail = null;

  try {
    matchingEventDetail = await waitForEventDetailMatch(eventDetailCapture, visibleFirstMatch, {
      eventDetailCache,
      since: waitStartedAt,
      timeoutMs: VISIBLE_MATCH_CHANGE_TIMEOUT_MS,
    });
  } finally {
    if (page.url() !== urlBeforeTrigger) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5_000 }).catch((error) => {
        console.log(`cycle=${cycle} trigger-detail return skipped reason=${error.message || error}`);
      });
    }
  }

  return matchingEventDetail
    ? processCapturedEventDetail(cycle, matchingEventDetail, lastPostedHashes, { visibleFirstMatch })
    : {
        posted: false,
        source: 'event-detail',
        reason: 'waiting for event-detail response',
      };
}

async function runInitialSync(cycle, page, eventDetailCapture, feedEventsCapture, lastPostedHashes, eventDetailCache) {
  const visibleFirstMatch = await readVisibleFirstMatch(page).catch(() => null);
  logVisibleSnapshot(cycle, visibleFirstMatch);
  const feedEvents = await feedEventsCapture.latest();
  let feedResult = null;

  if (feedEvents) {
    feedResult = await inspectCapturedFeed(cycle, feedEvents, visibleFirstMatch);
  }

  if (feedEvents) {
    console.log('startup feed-events captured for discovery only; checking passive event-detail cache.');
  }

  const cachedResult = await postCachedEventDetailForVisibleFirst(cycle, eventDetailCache, visibleFirstMatch, lastPostedHashes);
  if (cachedResult.posted || cachedResult.reason === 'unchanged') {
    return cachedResult;
  }

  if (feedResult && !feedResult.mismatch) {
    const triggeredResult = await triggerFeedFirstDetailAndWait(
      cycle,
      page,
      feedResult,
      visibleFirstMatch,
      eventDetailCapture,
      lastPostedHashes,
      eventDetailCache,
    );

    if (triggeredResult.posted || triggeredResult.reason === 'unchanged') {
      return triggeredResult;
    }
  }

  const startupEventDetail = await waitForEventDetailMatch(eventDetailCapture, visibleFirstMatch, {
    eventDetailCache,
    includeExisting: true,
    timeoutMs: STARTUP_EVENT_DETAIL_WAIT_MS,
  });
  if (startupEventDetail) {
    const eventDetailResult = await processCapturedEventDetail(cycle, startupEventDetail, lastPostedHashes, { visibleFirstMatch });

    if (eventDetailResult.posted || eventDetailResult.reason === 'unchanged') {
      return eventDetailResult;
    }
  }

  return {
    posted: false,
    source: 'event-detail',
    reason: 'waiting for event-detail response',
  };
}

async function maybeRunFullFeedRefresh(cycle, page, lastFullFeedRefreshAt, eventDetailCapture, lastPostedHashes, eventDetailCache) {
  return {
    ran: false,
    disabled: true,
    lastFullFeedRefreshAt,
  };
}

async function handleTransition(cycle, page, eventDetailCapture, feedEventsCapture, lastPostedHashes, eventDetailCache) {
  const previousVisibleMatch = await readVisibleFirstMatch(page).catch(() => null);
  const waitStartedAt = Date.now();

  console.log('cycle transition detected');
  await skipToNextGames(page);
  await sleep(UI_SETTLE_AFTER_TRANSITION_MS);

  const nextVisibleMatch = await waitForVisibleFirstMatchChange(page, previousVisibleMatch);
  console.log(`transition visible first row: ${nextVisibleMatch ? nextVisibleMatch.text : 'not found'}`);
  logVisibleSnapshot(cycle, nextVisibleMatch);

  if (nextVisibleMatch) {
    const cachedResult = await postCachedEventDetailForVisibleFirst(cycle, eventDetailCache, nextVisibleMatch, lastPostedHashes);
    if (cachedResult.posted || cachedResult.reason === 'unchanged') {
      return cachedResult;
    }

    const feedEvents = await feedEventsCapture.latest();
    if (feedEvents) {
      const feedResult = await inspectCapturedFeed(cycle, feedEvents, nextVisibleMatch);
      if (!feedResult.mismatch) {
        const triggeredResult = await triggerFeedFirstDetailAndWait(
          cycle,
          page,
          feedResult,
          nextVisibleMatch,
          eventDetailCapture,
          lastPostedHashes,
          eventDetailCache,
        );

        if (triggeredResult.posted || triggeredResult.reason === 'unchanged') {
          return triggeredResult;
        }
      }
    }

    const matchingEventDetail = await waitForEventDetailMatch(eventDetailCapture, nextVisibleMatch, {
      eventDetailCache,
      since: waitStartedAt,
      timeoutMs: VISIBLE_MATCH_CHANGE_TIMEOUT_MS,
    });

    if (matchingEventDetail) {
      return processCapturedEventDetail(cycle, matchingEventDetail, lastPostedHashes, {
        visibleFirstMatch: nextVisibleMatch,
      });
    }
  }

  console.log(
    `cycle=${cycle} source=event-detail visibleFirst=${getVisibleText(nextVisibleMatch)} detailFirst=not found skipped reason=waiting for matching event-detail response`,
  );
  return {
    posted: false,
    source: 'event-detail',
    reason: 'waiting for event-detail response',
  };
}

async function waitForVisibleFixturesOrBalance(page, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const visibleRows = await countVisibleFixtureRows(page).catch(() => 0);
    if (visibleRows > 0) {
      return {
        ok: true,
        reason: 'visible-fixtures',
        visibleRows,
      };
    }

    const balanceStatus = await getBalanceAuthStatus(page).catch(() => ({ ok: false }));
    if (balanceStatus.ok) {
      return {
        ok: true,
        reason: 'account-balance',
        visibleRows,
      };
    }

    await sleep(500);
  }

  return {
    ok: false,
    reason: 'timeout',
    visibleRows: 0,
  };
}

async function waitForFeedEventsReady(feedEventsCapture, timeoutMs = 30_000, expectedGeneration = null) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const capturedFeed = await feedEventsCapture?.latest();
    if (capturedFeed && (expectedGeneration === null || capturedFeed.generation === expectedGeneration)) {
      try {
        const boardPayload = parseFeedEventsBoard(capturedFeed.json);
        return {
          ok: true,
          reason: FEED_EVENTS_SOURCE,
          eventCount: boardPayload.events.length,
          providerEventId: boardPayload.providerEventId,
        };
      } catch (error) {
        if (isAuthenticationFailureMessage(error.message || error)) {
          return {
            ok: false,
            reason: error.message || String(error),
            authExpired: true,
          };
        }

        return {
          ok: false,
          reason: error.message || String(error),
        };
      }
    }

    await sleep(500);
  }

  return {
    ok: false,
    reason: 'timeout',
  };
}

async function readLatestFeedClockSnapshot(feedEventsCapture, expectedGeneration = null) {
  const capturedFeed = await feedEventsCapture?.latest().catch(() => null);
  if (!capturedFeed || (expectedGeneration !== null && capturedFeed.generation !== expectedGeneration)) {
    return null;
  }

  try {
    const boardPayload = parseFeedEventsBoard(capturedFeed.json);
    return {
      providerEventId: boardPayload.providerEventId ?? '',
      week: boardPayload.weekNumber ?? '',
      startTime: boardPayload.startTime ?? boardPayload.events?.[0]?.startTime ?? '',
      endTime: boardPayload.endTime ?? '',
    };
  } catch {
    return null;
  }
}

function logDomFeedActionSnapshot(cycle, domSnapshot, feedSnapshot, action) {
  console.log(`cycle=${cycle} DOM countdown=${domSnapshot.countdown} firstMatch=${domSnapshot.firstMatch} week=${domSnapshot.week}`);
  console.log(
    `cycle=${cycle} FEED providerEventId=${feedSnapshot?.providerEventId || 'not found'} ` +
      `week=${feedSnapshot?.week || 'not found'} endTime=${feedSnapshot?.endTime || 'not found'} ` +
      `startTime=${feedSnapshot?.startTime || 'not found'}`,
  );
  console.log(`cycle=${cycle} ACTION ${action || 'none'}`);
}

async function recoverPage(cycle, page) {
  console.log(`cycle=${cycle} recovery=reloading-page reason=failed-cycles-or-no-visible-fixtures`);
  await reloadShopPage(page);
  await waitForVisibleFirstMatchChange(page, null, VISIBLE_MATCH_CHANGE_TIMEOUT_MS).catch(() => null);
  const ready = await waitForVisibleFixturesOrBalance(page, 10_000);
  console.log(`cycle=${cycle} recovery=reload-result ok=${ready.ok} reason=${ready.reason} visibleRows=${ready.visibleRows}`);
  return ready.ok;
}

async function recoverPageIfNeeded(cycle, page, reason) {
  const visibleRowCount = await countVisibleFixtureRows(page);
  console.log(`cycle=${cycle} recovery-check visibleRows=${visibleRowCount} reason=${reason}`);

  if (visibleRowCount > 0) {
    console.log(`cycle=${cycle} recovery=skipped reason=visible-fixtures-present visibleRows=${visibleRowCount}`);
    return false;
  }

  return recoverPage(cycle, page);
}

async function shouldRecoverForStaleEventDetail(page, lastEventDetailAt) {
  const eventDetailAgeMs = Date.now() - lastEventDetailAt;

  if (eventDetailAgeMs <= EVENT_DETAIL_HEARTBEAT_STALE_MS) {
    return {
      recover: false,
      eventDetailAgeMs,
      visibleRowCount: null,
    };
  }

  const visibleRowCount = await countVisibleFixtureRows(page).catch(() => 0);

  return {
    recover: visibleRowCount === 0,
    eventDetailAgeMs,
    visibleRowCount,
  };
}

function isSuccessfulSourceResult(result) {
  return (
    (result?.source === 'event-detail' || result?.source === FEED_EVENTS_SOURCE) &&
    (result.posted || result.reason === 'unchanged')
  );
}

async function postCanonicalEvents(canonicalEvents) {
  if (TEST_BLOCK_FEED_EVENTS) {
    console.log('TEST MODE ACTIVE: posting disabled');
    return {
      batchId: '',
      testMode: true,
      skipped: true,
      errors: [],
    };
  }

  const reachable = await checkVirtualApiReachable();

  if (!reachable) {
    const message = 'Virtual API not reachable. Start the API server or set VIRTUAL_API_BASE_URL correctly.';
    console.log(`postCanonicalEvents target URL: ${PROVIDER_IMPORT_EVENTS_URL}`);
    console.log('postCanonicalEvents error name: Error');
    console.log(`postCanonicalEvents error message: ${message}`);
    console.log(message);
    throw new Error(message);
  }

  let response;

  try {
    response = await fetch(PROVIDER_IMPORT_EVENTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(canonicalEvents),
    });
  } catch (error) {
    console.log(`postCanonicalEvents target URL: ${PROVIDER_IMPORT_EVENTS_URL}`);
    console.log(`postCanonicalEvents error name: ${error.name || ''}`);
    console.log(`postCanonicalEvents error message: ${error.message || error}`);
    throw error;
  }

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`Import failed: ${response.status} ${response.statusText} ${text}`);
    console.log(`postCanonicalEvents target URL: ${PROVIDER_IMPORT_EVENTS_URL}`);
    console.log(`postCanonicalEvents error name: ${error.name}`);
    console.log(`postCanonicalEvents error message: ${error.message}`);
    console.log(`postCanonicalEvents response status: ${response.status} ${response.statusText}`);
    console.log(`postCanonicalEvents response body: ${text}`);
    throw error;
  }

  return payload ?? {};
}

async function postFeedEventsQueue(queuePayload) {
  if (TEST_BLOCK_FEED_EVENTS) {
    console.log('TEST MODE ACTIVE: queue posting disabled');
    return {
      skipped: true,
      testMode: true,
    };
  }

  let response;

  try {
    response = await fetch(PROVIDER_IMPORT_QUEUE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(queuePayload),
    });
  } catch (error) {
    console.log(`postFeedEventsQueue target URL: ${PROVIDER_IMPORT_QUEUE_URL}`);
    console.log(`postFeedEventsQueue error name: ${error.name || ''}`);
    console.log(`postFeedEventsQueue error message: ${error.message || error}`);
    throw error;
  }

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`Queue import failed: ${response.status} ${response.statusText} ${text}`);
    console.log(`postFeedEventsQueue target URL: ${PROVIDER_IMPORT_QUEUE_URL}`);
    console.log(`postFeedEventsQueue error name: ${error.name}`);
    console.log(`postFeedEventsQueue error message: ${error.message}`);
    console.log(`postFeedEventsQueue response status: ${response.status} ${response.statusText}`);
    console.log(`postFeedEventsQueue response body: ${text}`);
    throw error;
  }

  return payload ?? {};
}

async function postResultMonitorPayload(resultsPayload) {
  if (TEST_BLOCK_FEED_EVENTS) {
    console.log('TEST MODE ACTIVE: result posting disabled');
    return {
      skipped: true,
      testMode: true,
    };
  }

  let response;

  try {
    console.log(JSON.stringify(resultsPayload, null, 2));
    response = await fetch(PROVIDER_IMPORT_RESULTS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(resultsPayload),
    });
  } catch (error) {
    console.log(`postResultMonitorPayload target URL: ${PROVIDER_IMPORT_RESULTS_URL}`);
    console.log(`postResultMonitorPayload error name: ${error.name || ''}`);
    console.log(`postResultMonitorPayload error message: ${error.message || error}`);
    throw error;
  }

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(`Result monitor import failed: ${response.status} ${response.statusText} ${text}`);
    console.log(`postResultMonitorPayload target URL: ${PROVIDER_IMPORT_RESULTS_URL}`);
    console.log(`postResultMonitorPayload error name: ${error.name}`);
    console.log(`postResultMonitorPayload error message: ${error.message}`);
    console.log(`postResultMonitorPayload response status: ${response.status} ${response.statusText}`);
    console.log(`postResultMonitorPayload response body: ${text}`);
    throw error;
  }

  return payload ?? {};
}

function postFeedEventsQueueInBackground(cycle, boardPayloads, capturedAt) {
  if (!boardPayloads.length) {
    console.log(`cycle=${cycle} source=feed-events-queue skipped reason=no-boards`);
    return;
  }

  const queuePayload = buildFeedEventsQueuePayload(boardPayloads, capturedAt);

  postFeedEventsQueue(queuePayload)
    .then((result) => {
      console.log(
        `QUEUE-IMPORT-POSTED source=feed-events-queue boardCount=${queuePayload.boards.length} ` +
          `capturedAt=${queuePayload.capturedAt} batchId=${result.batchId ?? ''}`,
      );
    })
    .catch((error) => {
      console.log(
        `QUEUE-IMPORT-NOT-POSTED source=feed-events-queue reason=${error.message || error} ` +
          `boardCount=${queuePayload.boards.length} capturedAt=${queuePayload.capturedAt}`,
      );
    });
}

async function checkVirtualApiReachable() {
  try {
    const response = await fetch(PROVIDER_IMPORT_HEALTH_URL, { method: 'GET' });
    const body = await response.text();

    if (!response.ok) {
      console.log(`Virtual API health target URL: ${PROVIDER_IMPORT_HEALTH_URL}`);
      console.log(`Virtual API health response status: ${response.status} ${response.statusText}`);
      console.log(`Virtual API health response body: ${body}`);
      return false;
    }

    return true;
  } catch (error) {
    console.log(`Virtual API health target URL: ${PROVIDER_IMPORT_HEALTH_URL}`);
    console.log(`Virtual API health error name: ${error.name || ''}`);
    console.log(`Virtual API health error message: ${error.message || error}`);
    return false;
  }
}

function logSyncTargets() {
  console.log(`React display URL: ${REACT_DISPLAY_URL}`);
  console.log(`API import URL: ${PROVIDER_IMPORT_EVENTS_URL}`);
  console.log(`API queue import URL: ${PROVIDER_IMPORT_QUEUE_URL}`);
  console.log(`API results import URL: ${PROVIDER_IMPORT_RESULTS_URL}`);
  console.log(`Health endpoint: ${PROVIDER_IMPORT_HEALTH_URL}`);
}

async function configureBrowserContext(context) {
  await context.setExtraHTTPHeaders({
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  });
}

async function installTestFeedEventsBlocker(page) {
  if (!TEST_BLOCK_FEED_EVENTS || page.__testFeedEventsBlockerInstalled) {
    return;
  }

  console.log('TEST MODE ACTIVE: blocking /feed/events; posting disabled');
  await page.route('**/engine/shop/feed/events**', (route) => {
    console.log('TEST BLOCKED /feed/events', route.request().url());
    route.abort();
  });
  page.__testFeedEventsBlockerInstalled = true;
}

async function runConfiguredLogin(page, rl) {
  if (FORCE_MANUAL_LOGIN) {
    console.log('FORCE_MANUAL_LOGIN=true. Skipping automatic login.');
    await manualLogin(page, rl);
  } else if (VH_USERNAME && VH_PASSWORD) {
    await automaticLogin(page);
  } else {
    await manualLogin(page, rl);
  }
}

async function runBrowserSession() {
  let browser = null;
  let context = null;
  let page = null;
  let feedEventsCapture = null;
  let eventDetailCapture = null;
  let networkTraceRecorder = null;
  let transitionTraceRecorder = null;
  let transitionProofRecorder = null;
  let resultEventDetailCapture = null;
  let sessionAuthMonitor = null;
  let watchdogInterval = null;
  let resultLedgerInterval = null;
  let watchdogRunning = false;
  let resultLedgerCheckRunning = false;
  let cleanupStarted = false;
  let restartRequested = false;
  let restartReason = null;
  const browserErrorConfirmation = createBrowserErrorConfirmationState(VH_BROWSER_ERROR_CONFIRM_MS);
  let browserErrorRecoveryRunning = false;
  let lastPageStateLog = '';
  let lastPageStateLogAt = 0;
  let resolveRestart;
  const restartSignal = new Promise((resolve) => { resolveRestart = resolve; });
  const sessionStartedAt = Date.now();
  const activity = {
    lastAnyResponseAt: Date.now(), lastEventDetailResponseAt: 0, lastSuccessfulParseAt: 0,
    lastSuccessfulPostAt: 0, lastDomReadAt: Date.now(), lastSuccessfulHealthCheckAt: 0, lastHealthyAt: 0,
  };
  const failures = { page: 0, dom: 0, importantNetwork: 0, provider: 0, eventStale: 0, post: 0 };
  let offlineDetected = false;
  let cycle = 0;
  let lastFeedEvents200At = null;
  let lastEventDetailAt = 0;
  let lastFeedEventsWarningAt = 0;
  let lastFeedEventsReloadAt = 0;
  let pendingAuthenticationFailureReason = null;
  let lastVisibleFirstMatch = null;
  let pendingDomTransition = null;
  let lastMatchingFeedDomText = '';
  let lastMatchingFeedAt = 0;
  let lastFeedCycleTiming = null;
  let lastCycleRefreshRequestAt = 0;
  let lastCycleRefreshProviderEventId = '';
  let latestVisibleCountdown = null;
  let latestVisibleCountdownInitialized = false;
  let lastFeedAction = '';
  let pendingDomRefresh = false;
  let pendingDomRefreshStartedAt = 0;
  let pendingDomFirst = null;
  let pendingDomVisibleFirstMatch = null;
  let pendingDomRefreshReason = '';
  let lastRolloverPostFailed = false;
  let startupResyncStartedAt = 0;
  let startupResyncInitialFirstMatch = null;
  let startupResyncLastPostedFirstMatch = null;
  let startupResyncUsed = false;
  let startupResyncDisabled = false;
  let previousCycleResultWatch = {
    providerEventId: '',
    until: 0,
  };
  const lastPostedHashes = new Map();
  const eventDetailCache = new Map();
  const lastPostedFeedState = {
    providerEventId: '',
    oddsHash: '',
    latestSeenProviderEventId: '',
    latestSeenFeedReceivedAt: 0,
    generation: 0,
    startupWarmup: createStartupWarmupState(null),
  };
  const rl = readline.createInterface({ input, output });

  logSyncTargets();

  const authFailureState = {
    reason: null,
    count: 0,
    firstAt: 0,
    lastAt: 0,
    lastLogAt: 0,
  };
  const networkState = {
    networkOfflineSince: 0,
    lastNetworkSuccessAt: Date.now(),
    lastNetworkFailureAt: 0,
    lastSuccessfulBalanceAt: 0,
    lastOfflineLogAt: 0,
  };
  let lastReloginAt = 0;
  let authRecoveryRunning = false;

  const getUrlPath = (value) => {
    try {
      const parsed = new URL(String(value));
      return `${parsed.pathname}${parsed.search ? '?' : ''}${parsed.search ? parsed.search.slice(1, 80) : ''}`;
    } catch {
      return String(value || '').slice(0, 120);
    }
  };

  const isHorizonUrl = (url) => (
    String(url || '').includes('globalbet.virtual-horizon.com') ||
    String(url || '').includes('/engine/shop/') ||
    String(url || '').includes('/client/shop.jsp')
  );

  const isReliableHorizonSuccess = (response) => {
    const url = response.url();
    if (!isHorizonUrl(url)) return false;
    if (url.includes(BALANCE_URL_MARKER) && response.status() === 405) return true;
    return response.status() >= 200 && response.status() < 400;
  };

  const recordNetworkSuccess = (source = 'horizon-response') => {
    networkState.lastNetworkSuccessAt = Date.now();
    if (networkState.networkOfflineSince) {
      console.log(
        `network-restored source=${source} ` +
          `offlineDurationMs=${Date.now() - networkState.networkOfflineSince}`,
      );
    }
    networkState.networkOfflineSince = 0;
    networkState.lastNetworkFailureAt = 0;
    offlineDetected = false;
    browserErrorConfirmation.clear();
  };

  const recordNetworkFailure = (error, source = 'horizon-request') => {
    const now = Date.now();
    networkState.lastNetworkFailureAt = now;
    if (!networkState.networkOfflineSince) {
      networkState.networkOfflineSince = now;
    }

    const durationMs = now - networkState.networkOfflineSince;
    if (durationMs >= VH_NETWORK_OFFLINE_CONFIRM_MS && now - networkState.lastOfflineLogAt >= VH_HEALTH_CHECK_INTERVAL_MS) {
      networkState.lastOfflineLogAt = now;
      console.log(`network-offline suspected durationMs=${durationMs} source=${source} error=${safeError(error)}`);
    }
  };

  const clearAuthWarnings = (reason) => {
    if (authFailureState.reason) {
      console.log(`auth-alarm-cleared reason=${reason} previous=${authFailureState.reason}`);
    }
    authFailureState.reason = null;
    authFailureState.count = 0;
    authFailureState.firstAt = 0;
    authFailureState.lastAt = 0;
    authFailureState.lastLogAt = 0;
    pendingAuthenticationFailureReason = null;
  };

  const recordAuthWarning = (details = {}) => {
    const status = details.status ?? 'unknown';
    const pathLabel = details.path ?? getUrlPath(details.url);
    const normalizedReason = String(details.reason || `status-${status}`).slice(0, 120);
    const now = Date.now();
    if (authFailureState.reason && now - authFailureState.firstAt <= VH_AUTH_FAILURE_CONFIRM_MS) {
      authFailureState.count += 1;
    } else {
      authFailureState.count = 1;
      authFailureState.firstAt = now;
    }

    authFailureState.reason = normalizedReason;
    authFailureState.lastAt = now;
    pendingAuthenticationFailureReason = normalizedReason;
    if (now - authFailureState.lastLogAt >= 5_000 || authFailureState.count <= VH_AUTH_FAILURE_MIN_COUNT) {
      authFailureState.lastLogAt = now;
      console.log(`auth-warning count=${authFailureState.count} status=${status} path=${pathLabel}`);
      if (authFailureState.count < VH_AUTH_FAILURE_MIN_COUNT) {
        console.log('auth-warning ignored reason=below-threshold');
      }
    }
  };

  const noteAuthenticationFailure = (reason) => {
    if (reason && typeof reason === 'object') {
      recordAuthWarning(reason);
      return;
    }

    recordAuthWarning({ reason, status: 'unknown', path: reason });
  };

  const clearAuthenticationFailure = (reason) => {
    clearAuthWarnings(reason);
  };

  const requestBrowserRestart = (reason, details = {}) => {
    if (shutdownRequested || cleanupStarted || restartRequested) return false;
    restartRequested = true;
    restartReason = String(reason || 'unknown').slice(0, 120);
    lastRestartReason = restartReason;
    console.log(`[restart] reason=${restartReason}`);
    resolveRestart(new BrowserRestartError(restartReason, details));
    return true;
  };

  const closeRuntime = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (watchdogInterval) clearInterval(watchdogInterval);
    if (resultLedgerInterval) clearInterval(resultLedgerInterval);
    watchdogInterval = null;
    resultLedgerInterval = null;
    console.log('[restart] closing current browser');
    feedEventsCapture?.dispose();
    eventDetailCapture?.dispose();
    networkTraceRecorder?.dispose();
    transitionTraceRecorder?.dispose();
    transitionProofRecorder?.dispose();
    resultEventDetailCapture?.dispose();
    await networkTraceRecorder?.flush?.().catch(() => {});
    await transitionTraceRecorder?.flush?.().catch(() => {});
    await transitionProofRecorder?.flush?.().catch(() => {});
    await resultEventDetailCapture?.flush?.().catch(() => {});
    sessionAuthMonitor?.dispose();
    feedEventsCapture = null;
    eventDetailCapture = null;
    networkTraceRecorder = null;
    transitionTraceRecorder = null;
    transitionProofRecorder = null;
    resultEventDetailCapture = null;
    sessionAuthMonitor = null;
    await promiseWithTimeout(page?.close(), VH_BROWSER_CLOSE_TIMEOUT_MS, 'page close').catch(() => {});
    await promiseWithTimeout(context?.close(), VH_BROWSER_CLOSE_TIMEOUT_MS, 'context close').catch(() => {});
    await promiseWithTimeout(browser?.close(), VH_BROWSER_CLOSE_TIMEOUT_MS, 'browser close').catch(() => {});
    page = null;
    context = null;
    browser = null;
  };
  const launchRuntime = async () => {
    if (browser || context || page) throw new Error('browser runtime already exists');
    browserSessionNumber += 1;
    console.log(`[restart] launching fresh browser session=${browserSessionNumber}`);
    browser = await firefox.launch({ headless: false });
    context = await browser.newContext();
    await configureBrowserContext(context);
    page = await context.newPage();
    activeSession = { close: closeRuntime };
    const onUnexpectedFailure = (reason) => () => requestBrowserRestart(reason);
    browser.on('disconnected', onUnexpectedFailure('browser-disconnected'));
    page.on('close', onUnexpectedFailure('page-closed'));
    page.on('crash', onUnexpectedFailure('page-crashed'));
    context.on('close', onUnexpectedFailure('context-closed'));
    page.on('response', (response) => {
      activity.lastAnyResponseAt = Date.now();
      if (isReliableHorizonSuccess(response)) {
        recordNetworkSuccess(getUrlPath(response.url()));
      }
      if (response.url().includes(BALANCE_URL_MARKER) && (response.ok() || response.status() === 405)) {
        const acceptedStatus = response.status();
        (async () => {
          const loginEvidence = await inspectLoginPageEvidence(page).catch(() => ({ confident: false }));
          if (loginEvidence.confident) {
            recordAuthWarning({
              reason: 'confirmed-login-form',
              status: acceptedStatus,
              path: loginEvidence.url || response.url(),
            });
            return;
          }

          if (acceptedStatus === 405 && !isAuthenticatedShopEvidence(loginEvidence)) {
            console.log('session-check loginForm=false balanceStatus=405 decision=pending');
            return;
          }

          networkState.lastSuccessfulBalanceAt = Date.now();
          clearAuthWarnings(acceptedStatus === 405 ? 'balance-405-session-valid' : 'balance-ok-session-valid');
        })().catch((error) => {
          console.log(`session-check-failed reason=${safeError(error)}`);
        });
      }
      if (/\/engine\/shop\/feed\/event\/[^/?#]+/.test(response.url())) {
        activity.lastEventDetailResponseAt = Date.now();
        if (response.status() === 401 || response.status() === 403) {
          recordAuthWarning({
            reason: `event-detail-${response.status()}`,
            status: response.status(),
            url: response.url(),
          });
        }
      }
    });
    page.on('requestfailed', (request) => {
      if (/\/engine\/shop\/(?:feed\/event(?:s|\/)|account\/balance)|\/client\/shop\.jsp/.test(request.url())) {
        failures.importantNetwork += 1;
        recordNetworkFailure(request.failure()?.errorText || 'request failed', getUrlPath(request.url()));
      }
    });
    networkTraceRecorder = createNetworkTraceRecorder(page);
    transitionTraceRecorder = createTransitionTraceRecorder(page, {
      readVisibleFirstMatch: () => readVisibleFirstMatch(page),
      readVisibleCountdown: () => readVisibleCountdown(page),
    });
    transitionProofRecorder = createTransitionProofRecorder(page, {
      readVisibleFirstMatch: () => readVisibleFirstMatch(page),
      readVisibleCountdown: () => readVisibleCountdown(page),
    });
    resultEventDetailCapture = createResultEventDetailCapture(page, {
      getCycle: () => cycle,
    });
    lastFeedEvents200At = null;
    lastEventDetailAt = 0;
    latestVisibleCountdown = null;
    latestVisibleCountdownInitialized = false;
    pendingDomRefresh = false;
    pendingDomRefreshStartedAt = 0;
    pendingDomFirst = null;
    pendingDomVisibleFirstMatch = null;
    pendingDomRefreshReason = '';
    lastRolloverPostFailed = false;
    startupResyncStartedAt = 0;
    startupResyncInitialFirstMatch = null;
    startupResyncLastPostedFirstMatch = null;
    startupResyncUsed = false;
    startupResyncDisabled = false;
    previousCycleResultWatch = {
      providerEventId: '',
      until: 0,
    };
    feedEventsCapture = createFeedEventsCapture(page, {
      getCycle: () => cycle,
      lastPostedState: lastPostedFeedState,
      getPreviousCycleTiming: () => lastFeedCycleTiming,
      getVisibleFirstMatch: () => readVisibleFirstMatch(page),
      getLatestVisibleCountdown: () => latestVisibleCountdown,
      getLatestVisibleCountdownInitialized: () => latestVisibleCountdownInitialized,
      initializeLatestVisibleCountdown: async () => {
        latestVisibleCountdown = await readVisibleCountdown(page).catch(() => ({ found: false }));
        latestVisibleCountdownInitialized = true;
        return latestVisibleCountdown;
      },
      getPendingDomRefresh: () => ({
        pending: pendingDomRefresh,
        startedAt: pendingDomRefreshStartedAt,
        firstMatch: pendingDomFirst,
        visibleFirstMatch: pendingDomVisibleFirstMatch,
        reason: pendingDomRefreshReason,
      }),
      getFeedEventsPostingEnabled: () => /feed-events-fallback/.test(pendingDomRefreshReason),
      clearPendingDomRefresh: () => {
        pendingDomRefresh = false;
        pendingDomRefreshStartedAt = 0;
        pendingDomFirst = null;
        pendingDomVisibleFirstMatch = null;
        pendingDomRefreshReason = '';
      },
      getLastRolloverPostFailed: () => lastRolloverPostFailed,
      clearLastRolloverPostFailed: () => {
        lastRolloverPostFailed = false;
      },
      markStartupInitialPost: (firstMatch) => {
        startupResyncInitialFirstMatch = firstMatch;
        startupResyncLastPostedFirstMatch = firstMatch;
      },
      onFeedEvents200: (capture) => {
        if (capture.generation !== lastPostedFeedState.generation) {
          return;
        }

        lastFeedEvents200At = capture.capturedAt;
        lastFeedEventsWarningAt = 0;
        lastFeedEventsReloadAt = 0;
      },
      onProcessed: (result) => {
        transitionProofRecorder?.recordFeedEventsPost(result);
        if (result?.posted && !result.initialPost && !result.startupResyncPost) {
          startupResyncDisabled = true;
        }
        if (result?.posted) {
          lastRolloverPostFailed = false;
          startupResyncLastPostedFirstMatch = result.domFirst || result.feedFirst || startupResyncLastPostedFirstMatch;
        }

        lastFeedAction = result?.initialPost
          ? 'initial-post'
          : result?.startupResyncPost
            ? 'startup-resync-post'
          : result?.posted
          ? 'post'
          : result?.reason
            ? `feed-${result.reason}`
            : 'feed-processed';
        if (result?.authExpired) {
          noteAuthenticationFailure(result.reason ?? 'feed-events-auth-failed');
        }
        if (result?.matchesVisible && result.domFirst) {
          lastMatchingFeedDomText = result.domFirst;
          lastMatchingFeedAt = Date.now();
          if (pendingDomTransition?.newText === result.domFirst) {
            pendingDomTransition = null;
          }
        }
        if (result?.cycleTiming) {
          lastFeedCycleTiming = result.cycleTiming;
          lastCycleRefreshRequestAt = 0;
          lastCycleRefreshProviderEventId = '';
          console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} ${describeCycleTiming(lastFeedCycleTiming)}`);
        }
      },
      onAuthenticationFailure: (reason) => {
        if (typeof reason === 'object') recordAuthWarning(reason);
        else noteAuthenticationFailure(reason);
      },
    });
    eventDetailCapture = createEventDetailCapture(page, {
      getCycle: () => cycle,
      getVisibleFirstMatch: () => readVisibleFirstMatch(page),
      lastPostedHashes,
      eventDetailCache,
      getLastPostedFeedProviderEventId: () => lastPostedFeedState.providerEventId,
      getPreviousCycleResultWatch: () => previousCycleResultWatch,
      onCaptured: (capture) => {
        lastEventDetailAt = capture.capturedAt;
        activity.lastSuccessfulParseAt = Date.now();
      },
      onProcessed: (result) => {
        transitionTraceRecorder?.recordEventDetailResult(result);
        if (result?.posted) {
          activity.lastSuccessfulPostAt = Date.now();
          failures.post = 0;
          lastRolloverPostFailed = false;
          startupResyncDisabled = true;
          startupResyncLastPostedFirstMatch = result.domFirst || result.feedFirst || startupResyncLastPostedFirstMatch;
          lastFeedAction = 'event-detail-monitored';
        } else if (result?.reason) {
          lastFeedAction = `event-detail-${result.reason}`;
        }
        if (result?.authExpired) {
          noteAuthenticationFailure(result.reason ?? 'event-detail-auth-failed');
        }
        if (result?.matchesVisible && result.domFirst) {
          lastMatchingFeedDomText = result.domFirst;
          lastMatchingFeedAt = Date.now();
          if (pendingDomTransition?.newText === result.domFirst) {
            pendingDomTransition = null;
          }
        }
      },
      onAuthenticationFailure: (reason) => {
        noteAuthenticationFailure(reason);
      },
    });
    sessionAuthMonitor = createSessionAuthMonitor(page, {
      getCycle: () => cycle,
      onAuthenticationFailure: (reason) => {
        noteAuthenticationFailure(reason);
      },
    });
    watchdogInterval = setInterval(async () => {
      if (watchdogRunning || cleanupStarted || restartRequested) return;
      watchdogRunning = true;
      try {
        const now = Date.now();
        let pageOk = Boolean(browser?.isConnected() && page && !page.isClosed());
        let pageHealthState = null;
        if (pageOk) {
          try {
            await promiseWithTimeout(page.evaluate(() => ({ readyState: document.readyState, href: location.href })), VH_HEALTH_OPERATION_TIMEOUT_MS, 'page health');
            pageHealthState = await promiseWithTimeout(inspectPageState(page), VH_HEALTH_OPERATION_TIMEOUT_MS, 'page state health')
              .catch(() => null);
            failures.page = 0;
            activity.lastSuccessfulHealthCheckAt = now;
          } catch { failures.page += 1; pageOk = false; }
        } else failures.page += 1;

        if (pageHealthState?.browserErrorPage) {
          logPageState(pageHealthState);
          recordNetworkFailure('browser network error page', 'watchdog-page-state');
        } else try {
          const visible = await promiseWithTimeout(readVisibleFirstMatch(page), VH_HEALTH_OPERATION_TIMEOUT_MS, 'DOM read');
          if (visible) { failures.dom = 0; activity.lastDomReadAt = now; } else failures.dom += 1;
        } catch { failures.dom += 1; }

        const eventAge = activity.lastEventDetailResponseAt ? now - activity.lastEventDetailResponseAt : now - sessionStartedAt;
        const domAge = now - activity.lastDomReadAt;
        if (pageHealthState?.browserErrorPage) {
          const confirmation = browserErrorConfirmation.observe(pageHealthState.browserError, now);
          const ledgerCounts = getResultLedgerCounts();
          console.log(
            `[health] browser=error-page page=${pageHealthState.browserError?.type || 'error'} ` +
              `auth=unknown provider=offline-confirming api=unknown eventAge=${Math.round(eventAge / 1000)}s ` +
              `postAge=${activity.lastSuccessfulPostAt ? Math.round((now - activity.lastSuccessfulPostAt) / 1000) + 's' : 'n/a'} ` +
              `session=${browserSessionNumber} restarts=${browserRestartCount} ` +
              `resultsPending=${ledgerCounts.awaiting} resultsPartial=${ledgerCounts.partial} ` +
              `resultsOverdue=${ledgerCounts.overdue} resultPostFailed=${ledgerCounts.postFailed}`,
          );
          if (!confirmation.confirmed) {
            browserErrorConfirmation.lastWarningAt = now;
            console.log(
              `browser-error-page confirming type=${pageHealthState.browserError?.type || 'unknown'} ` +
                `durationMs=${confirmation.durationMs} confirmMs=${VH_BROWSER_ERROR_CONFIRM_MS} ` +
                `url=${pageHealthState.browserError?.url || 'unknown'} title=${pageHealthState.browserError?.title || 'unknown'}`,
            );
          }
          await recoverBrowserNetworkErrorPage(pageHealthState, 'watchdog-page-state');
          return;
        }
        const provider = await checkHostReachability(LOGIN_URL, VH_HEALTH_OPERATION_TIMEOUT_MS);
        const api = await checkHostReachability(PROVIDER_IMPORT_HEALTH_URL, VH_HEALTH_OPERATION_TIMEOUT_MS);
        if (provider.reachable) {
          recordNetworkSuccess('provider-health');
        } else {
          recordNetworkFailure(provider.error || 'provider unreachable', 'provider-health');
        }
        offlineDetected = Boolean(networkState.networkOfflineSince);
        failures.provider = provider.reachable ? 0 : failures.provider + 1;
        failures.eventStale = eventAge >= VH_EVENT_STALE_MS ? failures.eventStale + 1 : 0;
        const healthy = pageOk && failures.dom === 0 && provider.reachable;
        if (healthy) { activity.lastHealthyAt = now; failures.importantNetwork = 0; }
        const ledgerCounts = getResultLedgerCounts();
        const healthPage = pageHealthState?.browserErrorPage ? 'network-error' : pageOk ? 'ok' : 'fail';
        const healthAuth = pageHealthState?.browserErrorPage ? 'unknown' : pendingAuthenticationFailureReason ? 'warn' : 'ok';
        const healthProvider = pageHealthState?.browserErrorPage ? 'offline-or-unknown' : provider.reachable ? 'ok' : 'fail';
        console.log(`[health] browser=${browser?.isConnected() ? 'ok' : 'fail'} page=${healthPage} auth=${healthAuth} provider=${healthProvider} api=${api.reachable ? 'ok' : 'fail'} eventAge=${Math.round(eventAge / 1000)}s postAge=${activity.lastSuccessfulPostAt ? Math.round((now - activity.lastSuccessfulPostAt) / 1000) + 's' : 'n/a'} session=${browserSessionNumber} restarts=${browserRestartCount} resultsPending=${ledgerCounts.awaiting} resultsPartial=${ledgerCounts.partial} resultsOverdue=${ledgerCounts.overdue} resultPostFailed=${ledgerCounts.postFailed}`);
        if (failures.page >= VH_MAX_CONSECUTIVE_FAILURES) {
          requestBrowserRestart('page-unresponsive');
        } else if (failures.provider >= VH_MAX_CONSECUTIVE_FAILURES) {
          const offlineDurationMs = networkState.networkOfflineSince ? now - networkState.networkOfflineSince : 0;
          console.log(`network-offline suspected durationMs=${offlineDurationMs} source=watchdog`);
        } else if (failures.dom >= VH_MAX_CONSECUTIVE_FAILURES && domAge >= VH_PAGE_STALE_MS) {
          console.log(`passive-listener-stale eventAgeMs=${eventAge} action=none pendingResults=${getPendingEndedResultCount(now)} source=dom-stale domAgeMs=${domAge}`);
        } else if (failures.eventStale >= VH_MAX_CONSECUTIVE_FAILURES) {
          console.log(`passive-listener-stale eventAgeMs=${eventAge} action=none pendingResults=${getPendingEndedResultCount(now)}`);
        }
      } catch (error) {
        console.log(`[health] check-failed error=${safeError(error)}`);
      } finally { watchdogRunning = false; }
    }, VH_HEALTH_CHECK_INTERVAL_MS);
    resultLedgerInterval = setInterval(async () => {
      if (resultLedgerCheckRunning || cleanupStarted) return;
      resultLedgerCheckRunning = true;
      try {
        await checkResultCompletenessLedger();
      } catch (error) {
        console.log(`RESULT-LEDGER-CHECK-FAILED error=${safeError(error)}`);
      } finally {
        resultLedgerCheckRunning = false;
      }
    }, VH_RESULT_LEDGER_CHECK_MS);
  };
  const resetFeedCaptureState = async (reason, options = {}) => {
    const pendingWarmupFeed = options.preservePendingWarmupFeed
      ? lastPostedFeedState.startupWarmup?.pendingWarmupFeed
      : null;
    lastPostedFeedState.generation += 1;
    lastPostedFeedState.latestSeenProviderEventId = '';
    lastPostedFeedState.latestSeenFeedReceivedAt = 0;
    resetStartupWarmupState(lastPostedFeedState, options.holdWarmup ? null : Date.now());
    if (pendingWarmupFeed) {
      lastPostedFeedState.startupWarmup.pendingWarmupFeed = {
        ...pendingWarmupFeed,
        generation: lastPostedFeedState.generation,
      };
    }
    lastFeedEvents200At = null;
    lastEventDetailAt = 0;
    lastFeedEventsWarningAt = 0;
    lastFeedEventsReloadAt = 0;
    lastVisibleFirstMatch = null;
    pendingDomTransition = null;
    lastMatchingFeedDomText = '';
    lastMatchingFeedAt = 0;
    lastFeedCycleTiming = null;
    lastCycleRefreshRequestAt = 0;
    latestVisibleCountdown = null;
    latestVisibleCountdownInitialized = false;
    pendingDomRefresh = false;
    pendingDomRefreshStartedAt = 0;
    pendingDomFirst = null;
    pendingDomVisibleFirstMatch = null;
    pendingDomRefreshReason = '';
    lastRolloverPostFailed = false;
    startupResyncStartedAt = Date.now();
    startupResyncInitialFirstMatch = null;
    startupResyncLastPostedFirstMatch = null;
    startupResyncUsed = false;
    startupResyncDisabled = false;
    const currentVisibleFirstMatch = options.preserveLatestIfCurrentDom
      ? await readVisibleFirstMatch(page).catch(() => null)
      : null;
    const preserveLatestFeedFirst = currentVisibleFirstMatch ? getVisibleText(currentVisibleFirstMatch) : '';
    const preservedLatestFeed = feedEventsCapture?.clear({
      preserveLatest: Boolean(preserveLatestFeedFirst),
      matchFirst: preserveLatestFeedFirst,
      generation: lastPostedFeedState.generation,
    });
    eventDetailCapture?.clear();
    eventDetailCache.clear();
    console.log(
      `cycle=${cycle} source=${FEED_EVENTS_SOURCE} reset-feed-state reason=${reason} ` +
        `startupWarmup=${options.holdWarmup ? 'held' : `${STARTUP_FEED_WARMUP_MS}ms`} ` +
        `pendingWarmupFeed=${pendingWarmupFeed?.providerEventId ?? 'none'} ` +
        `preservedLatestFeed=${preservedLatestFeed ? 'true' : 'false'} ` +
        `preservedLatestFeedFirst=${preservedLatestFeed ? preserveLatestFeedFirst : 'none'}`,
    );
  };
  const isLoginRequired = async (reason) => {
    const loginEvidence = await inspectLoginPageEvidence(page).catch(() => ({ confident: false }));
    if (!loginEvidence.confident && !(await isLoginPageVisible(page).catch(() => false))) {
      return false;
    }

    const balanceStatus = await getBalanceAuthStatus(page).catch((error) => ({
      ok: false,
      status: null,
      error: error.message || String(error),
    }));

    if (loginEvidence.confident) {
      console.log(
        `session-check loginForm=true balanceStatus=${balanceStatus.status ?? 'unknown'} ` +
          'decision=relogin',
      );
      return true;
    }

    if (balanceStatus.ok) {
      console.log(`cycle=${cycle} recovery=login-page-visible ignored reason=balance-ok source=${reason}`);
      networkState.lastSuccessfulBalanceAt = Date.now();
      recordNetworkSuccess('balance-ok');
      clearAuthWarnings('balance-ok-session-valid');
      return false;
    }

    if (balanceStatus.status === 401 || balanceStatus.status === 403) {
      console.log(
        `cycle=${cycle} recovery=login-page-visible confirmed reason=${reason} balanceStatus=${balanceStatus.status} ` +
          `error=${balanceStatus.error ?? ''}`,
      );
      return true;
    }

    if (balanceStatus.status === 405) {
      if (!isAuthenticatedShopEvidence(loginEvidence)) {
        console.log(
          `session-check loginForm=false balanceStatus=405 decision=pending source=${reason}`,
        );
        return false;
      }

      console.log(`cycle=${cycle} recovery=login-page-visible ignored reason=balance-405 source=${reason}`);
      networkState.lastSuccessfulBalanceAt = Date.now();
      recordNetworkSuccess('balance-405');
      clearAuthWarnings('balance-405-session-valid');
      return false;
    }

    if (!lastFeedEvents200At) {
      console.log(
        `cycle=${cycle} recovery=login-page-visible ignored reason=no-feed-events-yet source=${reason} ` +
          `balanceStatus=${balanceStatus.status ?? 'unknown'} waiting`,
      );
      return false;
    }

    const feedAgeMs = Date.now() - lastFeedEvents200At;
    if (feedAgeMs <= FEED_EVENTS_INACTIVITY_RELOAD_MS) {
      console.log(
        `cycle=${cycle} recovery=login-page-visible ignored reason=feed-active source=${reason} ` +
          `balanceStatus=${balanceStatus.status ?? 'unknown'} feedAgeMs=${feedAgeMs}`,
      );
      return false;
    }

    console.log(
      `cycle=${cycle} recovery=login-page-visible confirmed reason=${reason} balanceStatus=${balanceStatus.status ?? 'unknown'} ` +
        `error=${balanceStatus.error ?? ''} feedAgeMs=${feedAgeMs}`,
    );
    return true;
  };
  const confirmSessionState = async (reason, options = {}) => {
    if (!browser?.isConnected?.() || !page || page.isClosed?.()) {
      console.log(`browser-restart reason=context-unusable source=${reason}`);
      return { state: 'unusable', reason: 'context-unusable' };
    }

    try {
      await promiseWithTimeout(page.evaluate(() => document.readyState), VH_HEALTH_OPERATION_TIMEOUT_MS, 'page auth confirmation');
    } catch (error) {
      console.log(`browser-restart reason=context-unusable source=${reason} error=${safeError(error)}`);
      return { state: 'unusable', reason: 'page-unresponsive' };
    }

    const balanceStatus = await getBalanceAuthStatus(page).catch((error) => ({
      ok: false,
      status: null,
      error: error.message || String(error),
    }));
    const loginEvidence = await inspectLoginPageEvidence(page).catch(() => ({ confident: false }));
    const loginVisible = loginEvidence.confident || await isLoginPageVisible(page).catch(() => false);
    const feedAgeMs = lastFeedEvents200At ? Date.now() - lastFeedEvents200At : null;
    const now = Date.now();
    const networkOfflineDurationMs = networkState.networkOfflineSince ? now - networkState.networkOfflineSince : 0;
    const networkOfflineConfirmed = networkOfflineDurationMs >= VH_NETWORK_OFFLINE_CONFIRM_MS;

    if (loginEvidence.confident || options.forceLogin) {
      recordAuthWarning({
        reason: 'confirmed-login-form',
        status: balanceStatus.status ?? 'unknown',
        path: loginEvidence.url || page.url(),
      });
      console.log(
        `session-check loginForm=true balanceStatus=${balanceStatus.status ?? 'unknown'} ` +
          'decision=relogin',
      );
      return { state: 'expired', reason: 'confirmed-login-form', bypassCooldown: true };
    }

    const balanceAcceptedAsAuthenticated = (
      balanceStatus.ok ||
      (
        balanceStatus.status === 405 &&
        !options.ignoreAcceptedBalance405 &&
        isAuthenticatedShopEvidence(loginEvidence)
      )
    );

    if (balanceAcceptedAsAuthenticated) {
      networkState.lastSuccessfulBalanceAt = now;
      recordNetworkSuccess(`balance-${balanceStatus.status}`);
      console.log(`auth-confirm balance=${balanceStatus.status} session=valid`);
      clearAuthWarnings('session-still-valid');
      return { state: 'valid', reason: 'balance-valid' };
    }

    if (balanceStatus.status === 401 || balanceStatus.status === 403) {
      recordAuthWarning({
        reason: `balance-${balanceStatus.status}`,
        status: balanceStatus.status,
        path: BALANCE_URL_MARKER,
      });
    }

    const authThresholdMet = (
      authFailureState.count >= VH_AUTH_FAILURE_MIN_COUNT &&
      authFailureState.firstAt &&
      now - authFailureState.firstAt <= VH_AUTH_FAILURE_CONFIRM_MS
    );
    const explicitlyUnauthenticated = balanceStatus.status === 401 || balanceStatus.status === 403;
    const expired = authThresholdMet && explicitlyUnauthenticated && (loginVisible || networkOfflineConfirmed);

    if (expired) {
      console.log(
        `session-expired confirmed reason=${reason} balance=${balanceStatus.status} ` +
          `loginVisible=${loginVisible} networkOfflineMs=${networkOfflineDurationMs} ` +
          `authWarnings=${authFailureState.count}`,
      );
      return { state: 'expired', reason: 'confirmed-session-expiry' };
    }

    if (networkState.networkOfflineSince && !networkOfflineConfirmed) {
      console.log(
        `network-offline pending durationMs=${networkOfflineDurationMs} ` +
          `confirmMs=${VH_NETWORK_OFFLINE_CONFIRM_MS} reason=${reason}`,
      );
    }

    console.log(
      `auth-warning ignored reason=session-not-confirmed count=${authFailureState.count}/${VH_AUTH_FAILURE_MIN_COUNT} ` +
        `balance=${balanceStatus.status ?? 'unknown'} loginVisible=${loginVisible} ` +
        `networkOfflineMs=${networkOfflineDurationMs} feedAgeMs=${feedAgeMs ?? 'n/a'}`,
    );
    return { state: 'pending', reason: 'not-confirmed' };
  };

  const canAttemptRelogin = (reason, options = {}) => {
    if (!options.ignoreRecoveryRunning && authRecoveryRunning) {
      console.log(`relogin-skipped reason=recovery-already-running source=${reason}`);
      return false;
    }

    const cooldownRemainingMs = lastReloginAt ? VH_RELOGIN_COOLDOWN_MS - (Date.now() - lastReloginAt) : 0;
    if (cooldownRemainingMs > 0 && !options.bypassCooldown) {
      console.log(`relogin-skipped reason=cooldown remainingMs=${cooldownRemainingMs} source=${reason}`);
      return false;
    }

    return true;
  };

  const recoverAuthenticatedSession = async (reason, options = {}) => {
    const recoveryReason = typeof reason === 'object'
      ? reason.reason || 'auth-recovery'
      : reason;
    const recoveryOptions = typeof reason === 'object'
      ? { ...reason, ...options }
      : options;

    if (authRecoveryRunning) {
      console.log(`relogin-skipped reason=recovery-already-running source=${recoveryReason}`);
      return;
    }

    authRecoveryRunning = true;
    try {
      const sessionState = await confirmSessionState(recoveryReason, recoveryOptions);
      if (sessionState.state === 'valid') {
        console.log('passive-listener-resumed');
        return;
      }

      if (sessionState.state === 'pending') {
        return;
      }

      if (sessionState.state === 'unusable') {
        requestBrowserRestart(sessionState.reason || 'context-unusable');
        return;
      }

      if (!canAttemptRelogin(recoveryReason, {
        ignoreRecoveryRunning: true,
        bypassCooldown: Boolean(recoveryOptions.bypassCooldown || sessionState.bypassCooldown),
      })) {
        return;
      }

      lastReloginAt = Date.now();
      console.log(`relogin-start reason=${sessionState.reason}`);
      try {
        if (recoveryOptions.reloadBeforeLogin && page && !page.isClosed?.()) {
          await page.reload({ waitUntil: 'domcontentloaded' }).catch((error) => {
            console.log(`relogin-reload-failed reason=${safeError(error)}`);
          });
        }
        await runConfiguredLogin(page, rl);
        console.log('relogin-success');
        clearAuthWarnings('relogin-success');
        recordNetworkSuccess('relogin-success');
        await resetFeedCaptureState('after-relogin', {
          preservePendingWarmupFeed: true,
          preserveLatestIfCurrentDom: true,
        });
        console.log('passive-listener-resumed');
      } catch (error) {
        console.log(`relogin-failed reason=${safeError(error)}`);
        if (!page || page.isClosed?.()) {
          requestBrowserRestart('context-unusable-after-relogin-failure');
        }
      }
    } finally {
      authRecoveryRunning = false;
    }
  };

  const logPageState = (state, force = false) => {
    const label = state.browserErrorPage
      ? `browser-error type=${state.browserError?.type || 'unknown'}`
      : state.loginPage
        ? 'login'
        : state.authenticatedApp
          ? 'authenticated'
          : 'blank-or-unknown';
    const now = Date.now();
    if (force || label !== lastPageStateLog || now - lastPageStateLogAt >= VH_NETWORK_ERROR_RELOAD_MS) {
      lastPageStateLog = label;
      lastPageStateLogAt = now;
      console.log(`page-state ${label}`);
    }
    return label;
  };

  const recoverBrowserNetworkErrorPage = async (state, reason = 'browser-network-error') => {
    if (browserErrorRecoveryRunning) {
      return false;
    }

    if (!browser?.isConnected?.() || !page || page.isClosed?.()) {
      requestBrowserRestart('context-unusable-network-error');
      return true;
    }

    const now = Date.now();
    const browserError = state?.browserError?.detected
      ? state.browserError
      : await detectCurrentBrowserErrorPage(page).catch(() => ({
          detected: true,
          type: 'unknown',
          url: page?.url?.() || '',
          title: '',
        }));
    const confirmation = browserErrorConfirmation.observe(browserError, now);
    recordNetworkFailure('browser network error page', reason);

    if (!confirmation.confirmed) {
      if (now - browserErrorConfirmation.lastWarningAt >= 5_000) {
        browserErrorConfirmation.lastWarningAt = now;
        console.log(
          `browser-error-page confirming type=${browserError.type || 'unknown'} ` +
            `durationMs=${confirmation.durationMs} confirmMs=${VH_BROWSER_ERROR_CONFIRM_MS} ` +
            `url=${browserError.url || 'unknown'} title=${browserError.title || 'unknown'}`,
        );
      }
      return true;
    }

    browserErrorRecoveryRunning = true;
    try {
      const cooldownRemainingMs = lastBrowserErrorRestartAt
        ? Math.max(0, VH_BROWSER_RESTART_COOLDOWN_MS - (now - lastBrowserErrorRestartAt))
        : 0;
      lastBrowserErrorRestartAt = now;
      console.log(
        `action=restart-browser reason=confirmed-firefox-neterror type=${browserError.type || 'unknown'} ` +
          `durationMs=${confirmation.durationMs} url=${browserError.url || 'unknown'} ` +
          `title=${browserError.title || 'unknown'}`,
      );
      requestBrowserRestart('confirmed-firefox-neterror', {
        browserError,
        delayMs: Math.max(VH_RESTART_DELAY_MS, cooldownRemainingMs),
      });
      return true;
    } finally {
      browserErrorRecoveryRunning = false;
    }
  };

  const restartBrowser = async (reason) => {
    requestBrowserRestart(reason);
  };

  try {
    await launchRuntime();
    await runConfiguredLogin(page, rl);
    await installTestFeedEventsBlocker(page);
    await resetFeedCaptureState('after-initial-login', {
      preservePendingWarmupFeed: true,
      preserveLatestIfCurrentDom: true,
    });
    if (!TEST_BLOCK_FEED_EVENTS && !(await triggerCurrentBoardFeedRefresh(cycle, page, await readVisibleFirstMatch(page).catch(() => null), 'after-initial-login'))) {
      await reloadShopPage(page);
    }

    console.log(`Realtime source: ${FEED_PATH} (${FEED_EVENTS_SOURCE})`);
    console.log(`Feed-events soft refresh: ${Math.round(FEED_EVENTS_SOFT_REFRESH_MS / 1000)} seconds`);
    console.log(`Feed-events inactivity reload: ${Math.round(FEED_EVENTS_INACTIVITY_RELOAD_MS / 1000)} seconds`);

    cycle += 1;
    if (TEST_BLOCK_FEED_EVENTS) {
      console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} ready skipped reason=test-block-feed-events`);
    } else {
      const initialReady = await waitForFeedEventsReady(feedEventsCapture, FEED_EVENTS_SOFT_REFRESH_MS, lastPostedFeedState.generation);
      console.log(
        `cycle=${cycle} source=${FEED_EVENTS_SOURCE} ready ok=${initialReady.ok} reason=${initialReady.reason} ` +
          `providerEventId=${initialReady.providerEventId ?? ''} eventCount=${initialReady.eventCount ?? ''}`,
      );
    }

    while (!shutdownRequested && !restartRequested) {
      const restartError = await Promise.race([sleep(1000).then(() => null), restartSignal]);
      if (restartError) throw restartError;
      cycle += 1;

      try {
        if (page?.isClosed?.()) {
          await restartBrowser('page-closed');
          continue;
        }

        const pageState = await inspectPageState(page).catch(() => ({
          browserErrorPage: false,
          browserError: { detected: false, type: null, url: page?.url?.() || '', title: '' },
          loginPage: false,
          authenticatedApp: false,
          blankOrUnknown: true,
          loginEvidence: { confident: false },
        }));
        logPageState(pageState);
        if (pageState.browserErrorPage) {
          await recoverBrowserNetworkErrorPage(pageState, 'main-loop');
          continue;
        }
        if (pageState.authenticatedApp) {
          browserErrorConfirmation.clear();
        }

        if (pendingAuthenticationFailureReason) {
          if (pendingAuthenticationFailureReason === 'page-crashed' || page?.isClosed?.()) {
            await restartBrowser(`auth-failure-${pendingAuthenticationFailureReason}`);
          } else {
            await recoverAuthenticatedSession(`auth-failure-${pendingAuthenticationFailureReason}`);
          }
          continue;
        }

        const loginEvidence = pageState.loginEvidence ?? { confident: false };
        if (pageState.loginPage || loginEvidence.confident) {
          recordAuthWarning({
            reason: 'confirmed-login-form',
            status: 'unknown',
            path: loginEvidence.url || page.url(),
          });
          await recoverAuthenticatedSession({
            reason: 'confirmed-login-form',
            forceLogin: true,
            ignoreAcceptedBalance405: true,
            bypassCooldown: true,
          });
          continue;
        }

        if (await isLoginRequired('main-loop')) {
          recordAuthWarning({
            reason: 'login-page-visible',
            status: 'unknown',
            path: getUrlPath(page.url()),
          });
          await recoverAuthenticatedSession('login-page-visible');
          continue;
        }

        const currentVisibleFirstMatch = pageState.visibleFirstMatch ?? await readVisibleFirstMatch(page).catch(() => null);
        const currentVisibleCountdown = pageState.visibleCountdown ?? await readVisibleCountdown(page).catch(() => ({ found: false }));
        latestVisibleCountdown = currentVisibleCountdown;
        latestVisibleCountdownInitialized = true;
        logVisibleCountdown(cycle, currentVisibleCountdown);
        const feedClockSnapshot = await readLatestFeedClockSnapshot(feedEventsCapture, lastPostedFeedState.generation);
        resultEventDetailCapture?.markCycle(
          lastPostedFeedState.latestSeenProviderEventId ||
            lastPostedFeedState.providerEventId ||
            feedClockSnapshot?.providerEventId,
        );
        const domClockSnapshot = {
          countdown: currentVisibleCountdown?.found ? currentVisibleCountdown.text : 'not found',
          firstMatch: currentVisibleFirstMatch ? getVisibleText(currentVisibleFirstMatch) : 'not found',
          week: currentVisibleFirstMatch?.visibleWeek ?? 'not found',
        };
        if (currentVisibleCountdown?.found && currentVisibleCountdown.totalSeconds <= 10) {
          transitionTraceRecorder?.start(currentVisibleFirstMatch, currentVisibleCountdown);
          transitionProofRecorder?.start(currentVisibleFirstMatch, currentVisibleCountdown);
        }
        transitionTraceRecorder?.updateDom(currentVisibleFirstMatch, currentVisibleCountdown);
        transitionProofRecorder?.updateDom(currentVisibleFirstMatch, currentVisibleCountdown);
        let cycleAction = lastFeedAction || 'none';
        lastFeedAction = '';
        let statusLogged = false;

        if (currentVisibleFirstMatch) {
          const currentVisibleText = getVisibleText(currentVisibleFirstMatch);
          const previousVisibleText = lastVisibleFirstMatch ? getVisibleText(lastVisibleFirstMatch) : '';

          if (previousVisibleText && currentVisibleText !== previousVisibleText) {
            pendingDomTransition = {
              oldText: previousVisibleText,
              newText: currentVisibleText,
              visibleFirstMatch: currentVisibleFirstMatch,
              changedAt: Date.now(),
              refreshTriggered: false,
            };
            console.log(`cycle=${cycle} dom-transition old=${previousVisibleText} new=${currentVisibleText}`);
            const matchedFeedEventsItem = feedEventsCapture?.findByFirstMatch(currentVisibleText);
            if (matchedFeedEventsItem) {
              console.log(
                `MATCHED-DOM-FROM-FEED-EVENTS domFirst=${currentVisibleText} ` +
                  `providerEventId=${matchedFeedEventsItem.providerEventId || 'not found'}`,
              );
              console.log(
                `cycle=${cycle} ACTIVE-EVENT-DETAIL-FETCH-DISABLED ` +
                  `providerEventId=${matchedFeedEventsItem.providerEventId || 'not found'}`,
              );
            } else {
              console.log(
                `DOM-NOT-IN-FEED-EVENTS domFirst=${currentVisibleText} ` +
                  `knownFirstMatches=${JSON.stringify(feedEventsCapture?.knownFirstMatches?.() ?? [])}`,
              );
            }
          }

          lastVisibleFirstMatch = currentVisibleFirstMatch;
        }

        const startupResyncActive = Boolean(
          startupResyncStartedAt &&
          startupResyncInitialFirstMatch &&
          startupResyncLastPostedFirstMatch &&
          !startupResyncUsed &&
          !startupResyncDisabled &&
          Date.now() - startupResyncStartedAt <= STARTUP_RESYNC_WINDOW_MS
        );
        const currentDomFirst = currentVisibleFirstMatch ? getVisibleText(currentVisibleFirstMatch) : '';
        if (
          startupResyncActive &&
          currentDomFirst &&
          currentDomFirst !== startupResyncLastPostedFirstMatch &&
          (!currentVisibleCountdown?.found || currentVisibleCountdown.totalSeconds <= 0)
        ) {
          pendingDomRefresh = true;
          pendingDomRefreshStartedAt = Date.now();
          pendingDomFirst = currentDomFirst;
          pendingDomVisibleFirstMatch = currentVisibleFirstMatch;
          pendingDomRefreshReason = 'startup-resync';
          const triggered = await triggerCurrentBoardFeedRefresh(cycle, page, currentVisibleFirstMatch, 'startup-resync');

          if (!triggered) {
            pendingDomRefresh = false;
            pendingDomRefreshStartedAt = 0;
            pendingDomFirst = null;
            pendingDomVisibleFirstMatch = null;
            pendingDomRefreshReason = '';
            cycleAction = 'startup-resync-refresh-timeout';
          } else {
            console.log(`cycle=${cycle} ACTION startup-resync-refresh waiting-for-feed`);
            const processedEntry = await feedEventsCapture?.waitForProcessedSince(
              pendingDomRefreshStartedAt,
              DOM_REFRESH_FEED_WAIT_MS,
            );

            if (!processedEntry) {
              pendingDomRefresh = false;
              pendingDomRefreshStartedAt = 0;
              pendingDomFirst = null;
              pendingDomVisibleFirstMatch = null;
              pendingDomRefreshReason = '';
              cycleAction = 'startup-resync-refresh-timeout';
              console.log(`cycle=${cycle} ACTION startup-resync-refresh-timeout`);
            } else if (processedEntry.result?.posted) {
              startupResyncUsed = true;
              startupResyncDisabled = true;
              startupResyncLastPostedFirstMatch =
                processedEntry.result.domFirst || processedEntry.result.feedFirst || currentDomFirst;
              cycleAction = 'startup-resync-post';
              console.log(`cycle=${cycle} ACTION startup-resync-post`);
              logStatusPosted(processedEntry.result.providerEventId || processedEntry.result.eventFeedId);
              statusLogged = true;
            } else {
              cycleAction = processedEntry.result?.reason
                ? `startup-resync-${processedEntry.result.reason}`
                : 'startup-resync-feed-processed';
            }

            if (pendingDomRefresh) {
              pendingDomRefresh = false;
              pendingDomRefreshStartedAt = 0;
              pendingDomFirst = null;
              pendingDomVisibleFirstMatch = null;
              pendingDomRefreshReason = '';
            }
          }

          if (!statusLogged) {
            logStatusWaitingCountdown(currentVisibleCountdown?.totalSeconds ?? 'not found');
            statusLogged = true;
          }
          logDomFeedActionSnapshot(cycle, domClockSnapshot, feedClockSnapshot, cycleAction);
          continue;
        }

        if (currentVisibleCountdown?.found && currentVisibleCountdown.totalSeconds > 0) {
          console.log(`cycle=${cycle} CYCLE-WAIT countdown=${currentVisibleCountdown.text ?? currentVisibleCountdown.totalSeconds}`);
          logStatusWaitingCountdown(currentVisibleCountdown.totalSeconds);
          statusLogged = true;
          if (currentVisibleCountdown.totalSeconds > DOM_CYCLE_WAIT_SECONDS) {
            const waitMs = Math.min(30_000, (currentVisibleCountdown.totalSeconds - DOM_CYCLE_WAIT_SECONDS) * 1000);
            console.log(
              `cycle=${cycle} countdown-wait secondsRemaining=${currentVisibleCountdown.totalSeconds} waitMs=${waitMs}`,
            );
            await sleep(waitMs);
          }
          logDomFeedActionSnapshot(cycle, domClockSnapshot, feedClockSnapshot, 'wait');
          continue;
        }

        if (
          pendingDomTransition &&
          pendingDomTransition.newText !== lastMatchingFeedDomText &&
          Date.now() - pendingDomTransition.changedAt >= DOM_TRANSITION_FEED_WAIT_MS &&
          !pendingDomTransition.refreshTriggered
        ) {
          pendingDomTransition.refreshTriggered = true;
          console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} no-matching-feed waiting-for-dom-scheduler`);
        }

        if (currentVisibleCountdown?.found && currentVisibleCountdown.totalSeconds <= 0) {
          const oldFirstMatch = currentVisibleFirstMatch ? getVisibleText(currentVisibleFirstMatch) : '';
          const previousProviderEventId = String(
            lastPostedFeedState.providerEventId ||
              lastPostedFeedState.latestSeenProviderEventId ||
              feedClockSnapshot?.providerEventId ||
              '',
          );
          if (previousProviderEventId) {
            previousCycleResultWatch = {
              providerEventId: previousProviderEventId,
              until: Date.now() + PREVIOUS_CYCLE_RESULT_WATCH_MS,
            };
            console.log(
              `PREVIOUS-CYCLE-RESULT-WATCH providerEventId=${previousProviderEventId} ` +
                `durationMs=${PREVIOUS_CYCLE_RESULT_WATCH_MS}`,
            );
          }
          console.log(`cycle=${cycle} CYCLE-ROLLOVER oldFirst=${oldFirstMatch || 'not found'}`);
          console.log(`cycle=${cycle} CYCLE-DELAY waitMs=${CYCLE_ROLLOVER_DELAY_MS}`);
          await sleep(CYCLE_ROLLOVER_DELAY_MS);

          const rolloverVisibleFirstMatch = await readVisibleFirstMatch(page).catch(() => null);
          const rolloverDomFirst = rolloverVisibleFirstMatch ? getVisibleText(rolloverVisibleFirstMatch) : '';
          const clearPendingRefresh = () => {
            pendingDomRefresh = false;
            pendingDomRefreshStartedAt = 0;
            pendingDomFirst = null;
            pendingDomVisibleFirstMatch = null;
            pendingDomRefreshReason = '';
          };
          const armPendingRefresh = (reason) => {
            pendingDomRefresh = true;
            pendingDomRefreshStartedAt = Date.now();
            pendingDomFirst = rolloverDomFirst;
            pendingDomVisibleFirstMatch = rolloverVisibleFirstMatch;
            pendingDomRefreshReason = reason;
            return pendingDomRefreshStartedAt;
          };
          const logFeedCheck = (entry) => {
            console.log(
              `cycle=${cycle} CYCLE-FEED-CHECK domFirst=${rolloverDomFirst || 'not found'} ` +
                `feedFirst=${entry?.result?.feedFirst || 'not found'} ` +
                `providerEventId=${entry?.result?.providerEventId || entry?.result?.eventFeedId || 'not found'} ` +
                `source=${entry?.result?.source || 'not found'}`,
            );
          };
          const handleCycleResult = (entry) => {
            logFeedCheck(entry);
            if (entry?.result?.posted) {
              cycleAction = 'cycle-post-success';
              console.log(`cycle=${cycle} ACTION cycle-post-success`);
              logStatusPosted(entry.result.providerEventId || entry.result.eventFeedId);
              statusLogged = true;
              return 'posted';
            }
            if (entry?.result?.noRepeat || entry?.result?.reason === 'repeat-providerEventId') {
              cycleAction = 'no-repeat';
              console.log(`cycle=${cycle} ACTION no-repeat providerEventId=${entry.result.providerEventId || 'not found'}`);
              return 'no-repeat';
            }
            return 'not-posted';
          };

          let waitStartedAt = armPendingRefresh('cycle-rollover-feed-events-primary');
          let processedEntry = await feedEventsCapture?.waitForProcessedSince(waitStartedAt, CYCLE_PASSIVE_FEED_WAIT_MS);
          if (!processedEntry) {
            console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} no-feed-events-response domFirst=${rolloverDomFirst || 'not found'}`);
          }

          let cycleResult = handleCycleResult(processedEntry);
          if (cycleResult === 'not-posted') {
            clearPendingRefresh();
            await sleep(CYCLE_MISMATCH_RETRY_WAIT_MS);
            waitStartedAt = armPendingRefresh('cycle-rollover-feed-events-mismatch-retry');
            processedEntry = await feedEventsCapture?.waitForProcessedSince(waitStartedAt, DOM_REFRESH_FEED_WAIT_MS);
            if (!processedEntry) {
              console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} mismatch-retry-no-feed-events-response domFirst=${rolloverDomFirst || 'not found'}`);
            }
            cycleResult = handleCycleResult(processedEntry);
          }

          if (cycleResult === 'not-posted') {
            cycleAction = 'cycle-post-skipped-mismatch';
            lastRolloverPostFailed = true;
            console.log(`cycle=${cycle} ACTION cycle-post-skipped-mismatch`);
          } else {
            lastRolloverPostFailed = false;
          }

          if (!statusLogged) {
            logStatusWaitingCountdown(currentVisibleCountdown?.totalSeconds ?? 'not found');
            statusLogged = true;
          }
          clearPendingRefresh();
          logDomFeedActionSnapshot(cycle, domClockSnapshot, feedClockSnapshot, cycleAction);
          continue;
        }

        const warmupReleaseVisibleFirstMatch = lastPostedFeedState.startupWarmup?.pendingWarmupFeed
          ? currentVisibleFirstMatch
          : null;
        const warmupReleaseResult = await releasePendingStartupWarmupFeed(
          cycle,
          lastPostedFeedState,
          warmupReleaseVisibleFirstMatch,
        );
        if (warmupReleaseResult?.authExpired) {
          noteAuthenticationFailure(warmupReleaseResult.reason ?? 'feed-events-auth-failed');
          continue;
        }
        if (warmupReleaseResult?.posted) {
          cycleAction = 'post';
          logStatusPosted(warmupReleaseResult.providerEventId || warmupReleaseResult.eventFeedId);
          statusLogged = true;
        }

        if (!lastFeedEvents200At) {
          if (Date.now() - lastFeedEventsWarningAt > FEED_EVENTS_SOFT_REFRESH_MS) {
            lastFeedEventsWarningAt = Date.now();
            console.log(`cycle=${cycle} source=${FEED_EVENTS_SOURCE} no-feed-events-yet waiting-for-dom-scheduler`);
          }
          if (!statusLogged) {
            logStatusWaitingCountdown(currentVisibleCountdown?.totalSeconds ?? 'not found');
            statusLogged = true;
          }
          logDomFeedActionSnapshot(cycle, domClockSnapshot, feedClockSnapshot, cycleAction);
          continue;
        }

        const feedAgeMs = Date.now() - lastFeedEvents200At;
        if (feedAgeMs > FEED_EVENTS_SOFT_REFRESH_MS && Date.now() - lastFeedEventsWarningAt > FEED_EVENTS_SOFT_REFRESH_MS) {
          lastFeedEventsWarningAt = Date.now();
          console.log(
            `cycle=${cycle} source=${FEED_EVENTS_SOURCE} no-feed-events-200 staleMs=${feedAgeMs} ` +
              'reason=feed-stale-waiting-for-dom-scheduler',
          );
        }

        if (feedAgeMs > FEED_EVENTS_INACTIVITY_RELOAD_MS && Date.now() - lastFeedEventsReloadAt > FEED_EVENTS_INACTIVITY_RELOAD_MS) {
          lastFeedEventsReloadAt = Date.now();
          console.log(
            `cycle=${cycle} source=${FEED_EVENTS_SOURCE} feed-quiet staleMs=${feedAgeMs} reason=waiting-for-dom-scheduler`,
          );
        }
        if (!statusLogged) {
          logStatusWaitingCountdown(currentVisibleCountdown?.totalSeconds ?? 'not found');
          statusLogged = true;
        }
        logDomFeedActionSnapshot(cycle, domClockSnapshot, feedClockSnapshot, cycleAction);
      } catch (error) {
        console.log(`cycle=${cycle} events=0 batchId= errors=${error.message || error}`);

        if (pendingAuthenticationFailureReason || isAuthenticationFailureMessage(error.message || error)) {
          if (!pendingAuthenticationFailureReason) {
            noteAuthenticationFailure('exception');
          }

          await recoverAuthenticatedSession(`auth-failure-${pendingAuthenticationFailureReason}`);
          continue;
        }
      }
    }
  } finally {
    rl.close();
    await closeRuntime();
    activeSession = null;
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  shutdownRequested = true;
  console.log(`[shutdown] reason=${signal}`);
  await activeSession?.close?.().catch(() => {});
  process.exitCode = exitCode;
}

async function main() {
  while (!shutdownRequested) {
    let delay = VH_RESTART_DELAY_MS;
    try {
      await runBrowserSession();
    } catch (error) {
      if (!(error instanceof BrowserRestartError)) console.error(`[session] failure=${safeError(error)}`);
      delay = error?.details?.delayMs ?? (error?.details?.offline ? VH_OFFLINE_RETRY_DELAY_MS : VH_RESTART_DELAY_MS);
    }
    if (!shutdownRequested) {
      browserRestartCount += 1;
      console.log(`[restart] waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}

if (require.main === module) {
  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  process.once('uncaughtException', (error) => { console.error(`[fatal] uncaughtException=${safeError(error)}`); shutdown('uncaughtException', 1); });
  process.once('unhandledRejection', (error) => { console.error(`[fatal] unhandledRejection=${safeError(error)}`); shutdown('unhandledRejection', 1); });

  main().catch((error) => { console.error(`[fatal] ${safeError(error)}`); process.exitCode = 1; });
}

module.exports = {
  classifyBrowserErrorPage,
  createBrowserErrorConfirmationState,
  detectBrowserErrorPage,
  inspectPageState,
};
