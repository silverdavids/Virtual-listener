const LEAGUES = Object.freeze([
  { id: '21', name: 'Champions' },
  { id: '78', name: 'EPL' },
]);

const leagueEventKey = (leagueId, providerEventId) => JSON.stringify([String(leagueId), String(providerEventId)]);

function isBoardComplete(board, capturedAt, isComplete = () => false) {
  // Provider d/e can be identical rotation signals, not event lifetime bounds.
  // Only an explicitly identified finish time may expire a board by time.
  const end = Date.parse(board.reliableEndAt);
  const start = Date.parse(board.events?.[0]?.startTime || board.startTime);
  return isComplete(board) || (Number.isFinite(end) && Number.isFinite(start) && end > start && end <= capturedAt);
}

function selectCurrentBoard(boards, capturedAt, previous = null, isComplete) {
  const active = boards.filter(board => !isBoardComplete(board, capturedAt, isComplete));
  return active.find(board => previous && leagueEventKey(board.leagueId, board.providerEventId) ===
    leagueEventKey(previous.leagueId, previous.providerEventId)) ?? active[0];
}

// All passive and explicitly requested feeds share these serialized league lanes.
function createLeagueMonitor({ parseBoards, postBoard, postQueue, buildQueue, isComplete, reconciliationMs = 15000, log = console.log }) {
  const states = new Map(LEAGUES.map(({ id }) => [id, {
    boards: new Map(), current: null, capturedAt: 0, responseOrder: -1, queueHash: '',
    retired: new Set(), lastQueuePostedAt: null,
    posted: new Set(),
    posting: { generation: 0, latestSeenFeedReceivedAt: 0, providerEventId: '' },
    tail: Promise.resolve(),
  }]));
  function ingest(json, requestedLeagueId, capturedAt = Date.now(), isCurrent = () => true, responseOrder = capturedAt) {
    const groups = new Map();
    for (const board of parseBoards(json, requestedLeagueId)) {
      const id = String(board.leagueId);
      if (!states.has(id)) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(board);
    }
    return Promise.all([...groups].map(([id, boards]) => {
      const state = states.get(id);
      const work = state.tail.catch(() => {}).then(async () => {
        if (!isCurrent() || responseOrder < state.responseOrder) return;
        state.responseOrder = responseOrder;
        state.capturedAt = capturedAt;
        // First occurrence wins; weeks may repeat across distinct event identities.
        state.boards = new Map();
        for (const board of boards) {
          const key = leagueEventKey(id, board.providerEventId);
          if (board.providerEventId && !state.boards.has(key)) state.boards.set(key, board);
        }
        const candidates = [...state.boards.values()].filter(board => {
          const key = leagueEventKey(id, board.providerEventId);
          if (isBoardComplete(board, capturedAt, isComplete)) state.retired.add(key);
          return !state.retired.has(key);
        });
        const previous = state.current;
        state.current = selectCurrentBoard(candidates, capturedAt, previous, isComplete);
        if (previous && state.current && previous.providerEventId !== state.current.providerEventId) {
          state.retired.add(leagueEventKey(id, previous.providerEventId));
        }
        if (!state.current) return;
        log(`LEAGUE-FEED-CAPTURED league=${id} providerEventId=${state.current.providerEventId}`);
        const queuedBoards = [state.current, ...candidates.filter(board => board !== state.current)];
        queuedBoards.forEach((board, position) => log(`QUEUE-BOARD-CAPTURED league=${id} leagueName=${board.leagueName} week=${board.weekNumber} providerEventId=${board.providerEventId} matches=${board.events?.length ?? 0} startAt=${board.startTime} endAt=${board.endTime} position=${position} current=${position === 0}`));
        const queue = buildQueue(queuedBoards, capturedAt);
        // A heartbeat is evidence of a newly received provider response, never
        // a timer that invents freshness while the provider is disconnected.
        const providerTime = Number(json?.header?.serverTime);
        queue.lastSeenAtUtc = new Date(Number.isFinite(providerTime) && providerTime > 0 ? providerTime : capturedAt).toISOString();
        const hash = JSON.stringify(queue.boards);
        // A failed queue import must not prevent the current board import.
        if (hash !== state.queueHash || state.lastQueuePostedAt === null || capturedAt - state.lastQueuePostedAt >= reconciliationMs) {
          try {
            await postQueue(queue);
            if (!isCurrent()) return;
            state.queueHash = hash;
            state.lastQueuePostedAt = capturedAt;
            log(`QUEUE-IMPORT-POSTED league=${id} boardCount=${queuedBoards.length}`);
          } catch (error) {
            log(`QUEUE-IMPORT-NOT-POSTED league=${id} reason=${error.message}`);
          }
        }
        const key = leagueEventKey(id, state.current.providerEventId);
        if (!isCurrent()) return;
        if (state.posted.has(key)) return { posted: false, duplicate: true };
        const result = await postBoard(state.current, state.posting, capturedAt);
        if (result?.posted) state.posted.add(key);
        return result;
      });
      state.tail = work;
      return work;
    }));
  }
  return { states, ingest };
}

function createLeagueRefreshScheduler({ refreshLeague, pollResults, isReady = () => true,
  intervalMs = 5000, now = Date.now, onError = () => {} }) {
  let generation = 0;
  const states = new Map(LEAGUES.map(league => [league.id, {
    feed: { nextAt: 0, inFlight: null }, results: { nextAt: 0, inFlight: null },
  }]));
  function tick() {
    if (!isReady()) return Promise.resolve([]);
    const pending = [];
    for (const league of LEAGUES) {
      for (const [kind, action] of [['feed', refreshLeague], ['results', pollResults]]) {
        const state = states.get(league.id)[kind];
        if (state.inFlight || now() < state.nextAt) continue;
        const startedGeneration = generation;
        const isCurrent = () => startedGeneration === generation && isReady();
        state.nextAt = now() + intervalMs;
        const work = Promise.resolve().then(() => action(league, isCurrent))
          .catch(error => { if (isCurrent()) onError(error, league, kind); })
          .finally(() => { if (state.inFlight === work) state.inFlight = null; });
        state.inFlight = work;
        pending.push(work);
      }
    }
    return Promise.allSettled(pending);
  }
  function reset() {
    generation += 1;
    for (const state of states.values()) {
      for (const lane of [state.feed, state.results]) {
        lane.nextAt = 0;
        lane.inFlight = null;
      }
    }
  }
  return { states, tick, reset };
}

module.exports = { LEAGUES, leagueEventKey, createLeagueMonitor, selectCurrentBoard, createLeagueRefreshScheduler };
