const assert = require('node:assert/strict');
const test = require('node:test');

const {
  __test: {
    BOARD_PHASES,
    checkBoardTransitionTimeout,
    buildFeedEventsQueuePayload,
    buildResultMonitorPayload,
    buildVirtualHorizonBoardKey,
    classifyEventDetailPacket,
    confirmBoardTransitionFromFeed,
    createActiveBoardSnapshot,
    createInitialBoardState,
    createObservedDomBoard,
    createPreviousCycleResultWatchFromSnapshot,
    canRunProviderLeagueDiscovery,
    doesActiveSnapshotMatchQueueBoard,
    enterBoardTransition,
    findTransitionTargetFromQueue,
    getRegistryMissingQueueBoards,
    parseFeedEventsBoardFromBoard,
    postResultMonitorPayloadWithLedger,
    providerLeagueNumberRegistry,
    pruneProviderLeagueNumberRegistry,
    recentResultBoardHistory,
    recordResultLedgerObservation,
    registerProviderLeagueNumber,
    registerResultLedgerEventBoard,
    runProviderLeagueDiscoveryPass,
    promoteBoardStateToActive,
    resultCompletenessLedger,
    shouldSuppressCanonicalPostDuringTransition,
    validateFeedEventsQueueBoards,
    validateResultTrackableBoard,
  },
} = require('./auto-sync');

function makeProviderRows(ids, { scored = true } = {}) {
  return ids.map((id, index) => ({
    b: {
      a: id,
      c: scored ? 'COMPLETED' : 'DISPLAY_RESULTS',
      d: scored ? { a: index % 4, b: (index + 1) % 4, c: 'FT' } : null,
      i: {
        a: {
          b: {
            a: { a: `Home ${id}` },
            b: { a: `Away ${id}` },
          },
        },
      },
    },
  }));
}

function makeFeedBoard({
  providerEventId = '2471267401',
  leagueId = '21',
  leagueNumber = '9485',
  weekNumber = '17',
  ids = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10'],
} = {}) {
  return {
    a: providerEventId,
    d: 1785150000,
    e: 1785150300,
    f: {
      b: {
        a: {
          a: {
            a: 'Champs League',
            d: leagueId,
          },
        },
          c: {
            a: weekNumber,
            e: leagueNumber,
            c: makeProviderRows(ids, { scored: false }),
          },
      },
    },
  };
}

function makeResultPayload({
  providerEventId = '2471267401',
  leagueId = '21',
  leagueNumber = '9485',
  includeLeagueNumber = true,
  weekNumber = '17',
  ids = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10'],
  scored = true,
} = {}) {
  const boardContainer = {
    a: weekNumber,
    c: makeProviderRows(ids, { scored }),
  };
  if (includeLeagueNumber) {
    boardContainer.e = leagueNumber;
  }

  return {
    event: {
      a: providerEventId,
      c: 'RESULTS',
      f: {
        b: {
          a: {
            a: {
              a: 'Champs League',
              d: leagueId,
            },
          },
          c: boardContainer,
        },
      },
    },
  };
}

function observe(packet, options = {}) {
  const monitorPayload = buildResultMonitorPayload(packet);
  return recordResultLedgerObservation(packet, monitorPayload, options);
}

function observeWithMonitor(packet, options = {}) {
  const monitorPayload = buildResultMonitorPayload(packet);
  const observation = recordResultLedgerObservation(packet, monitorPayload, options);
  return { observation, monitorPayload };
}

test.beforeEach(() => {
  resultCompletenessLedger.clear();
  recentResultBoardHistory.clear();
  providerLeagueNumberRegistry.clear();
});

test('matches event and result by providerEventId and carries week number', () => {
  const feedBoard = parseFeedEventsBoardFromBoard(makeFeedBoard());
  registerResultLedgerEventBoard(feedBoard);

  const packet = classifyEventDetailPacket(makeResultPayload(), '/engine/shop/feed/event/2471267401');
  const observation = observe(packet);

  assert.equal(feedBoard.boardKey, 'VirtualHorizon:21:2471267401');
  assert.equal(packet.resultsPayload.boardKey, feedBoard.boardKey);
  assert.equal(packet.resultsPayload.leagueId, '21');
  assert.equal(packet.resultsPayload.leagueNumber, '9485');
  assert.equal(packet.resultsPayload.weekNumber, '17');
  assert.equal(observation.isComplete, true);
  assert.equal(observation.entry.weekNumber, '17');
  assert.equal(observation.entry.leagueNumber, '9485');
});

test('matches result by ordered match IDs when providerEventId is absent', () => {
  const ids = ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'];
  const feedBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: '', ids }));
  registerResultLedgerEventBoard(feedBoard, { providerEventId: 'fallback-board' });

  const packet = classifyEventDetailPacket(makeResultPayload({ providerEventId: '', ids }), '/engine/shop/feed/event/');
  const observation = observe(packet);

  assert.equal(feedBoard.boardKey, buildVirtualHorizonBoardKey({ leagueId: '21', orderedMatchIds: ids }));
  assert.equal(observation.isComplete, true);
  assert.equal(observation.entry.providerEventId, 'fallback-board');
});

test('rejects an unrelated result board', () => {
  registerResultLedgerEventBoard(parseFeedEventsBoardFromBoard(makeFeedBoard()));

  const packet = classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'unrelated',
    ids: ['x01', 'x02', 'x03', 'x04', 'x05', 'x06', 'x07', 'x08', 'x09', 'x10'],
  }));
  const observation = observe(packet);

  assert.equal(observation.rejected, true);
  assert.equal(observation.reason, 'unmatched-board');
});

test('rejects out-of-order older result arrival for an unknown board', () => {
  registerResultLedgerEventBoard(parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'new-board' })));

  const oldPacket = classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'old-board',
    ids: ['o01', 'o02', 'o03', 'o04', 'o05', 'o06', 'o07', 'o08', 'o09', 'o10'],
  }));
  const observation = observe(oldPacket);

  assert.equal(observation.rejected, true);
  assert.equal(observation.reason, 'unmatched-board');
});

test('ignores a duplicate completed result payload', () => {
  const feedBoard = parseFeedEventsBoardFromBoard(makeFeedBoard());
  registerResultLedgerEventBoard(feedBoard);

  const packet = classifyEventDetailPacket(makeResultPayload());
  const first = observe(packet);
  assert.equal(first.isComplete, true);
  first.entry.status = 'RESULTS_COMPLETE';
  const duplicate = observe(packet);

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reason, 'duplicate-result');
});

test('rejects partial result payloads', () => {
  registerResultLedgerEventBoard(parseFeedEventsBoardFromBoard(makeFeedBoard()));

  const packet = classifyEventDetailPacket(makeResultPayload({ scored: false }));
  const observation = observe(packet);

  assert.equal(observation.rejected, true);
  assert.equal(observation.reason, 'partial-result-scores');
});

test('new completed board replaces previous completed board as a distinct identity', () => {
  const firstBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'board-1' }));
  const secondBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-2',
    ids: ['n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10'],
  }));
  registerResultLedgerEventBoard(firstBoard);
  registerResultLedgerEventBoard(secondBoard);

  const firstObservation = observe(classifyEventDetailPacket(makeResultPayload({ providerEventId: 'board-1' })));
  const secondObservation = observe(classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'board-2',
    ids: ['n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10'],
  })));

  assert.equal(firstObservation.isComplete, true);
  assert.equal(secondObservation.isComplete, true);
  assert.notEqual(firstObservation.entry.boardKey, secondObservation.entry.boardKey);
});

test('active board snapshot stays attached to board A when board B is already registered', () => {
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-A',
    ids: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'],
  }));
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  registerResultLedgerEventBoard(boardA);
  registerResultLedgerEventBoard(boardB);

  const snapshotA = createActiveBoardSnapshot(boardA, {
    text: boardA.firstMatch,
    visibleLeague: '9485',
    visibleWeek: '17',
  });
  const watchA = createPreviousCycleResultWatchFromSnapshot(snapshotA, Date.now());

  assert.equal(watchA.providerEventId, 'board-A');
  assert.equal(watchA.boardKey, 'VirtualHorizon:21:board-A');
  assert.equal(watchA.activeBoardSnapshot.firstMatch, boardA.firstMatch);
});

test('completed result B is quarantined while A is the current completed target', () => {
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-A',
    ids: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'],
  }));
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  registerResultLedgerEventBoard(boardA);
  registerResultLedgerEventBoard(boardB);

  const watchA = createPreviousCycleResultWatchFromSnapshot(createActiveBoardSnapshot(boardA, {
    text: boardA.firstMatch,
    visibleLeague: '9485',
    visibleWeek: '17',
  }), Date.now());
  const packetB = classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'board-B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));

  const observation = observe(packetB, { resultWatch: watchA });

  assert.equal(observation.rejected, true);
  assert.equal(observation.reason, 'not-current-completed-target');
});

test('completed result B is accepted when B is the current completed target', () => {
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  registerResultLedgerEventBoard(boardB);

  const watchB = createPreviousCycleResultWatchFromSnapshot(createActiveBoardSnapshot(boardB, {
    text: boardB.firstMatch,
    visibleLeague: '9485',
    visibleWeek: '17',
  }), Date.now());
  const packetB = classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'board-B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));

  const observation = observe(packetB, { resultWatch: watchB });

  assert.equal(observation.isComplete, true);
  assert.equal(observation.entry.providerEventId, 'board-B');
});

test('result monitor payload is enriched with actual leagueNumber from matched board when raw result only has leagueId', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'board-league',
    leagueId: '21',
    leagueNumber: '9485',
    weekNumber: '26',
  }));
  registerResultLedgerEventBoard(board);

  const packet = classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'board-league',
    leagueId: '21',
    includeLeagueNumber: false,
    weekNumber: '26',
  }));
  assert.equal(packet.resultsPayload.leagueId, '21');
  assert.equal(packet.resultsPayload.leagueNumber, '21');

  const { observation, monitorPayload } = observeWithMonitor(packet);

  assert.equal(observation.isComplete, true);
  assert.equal(packet.resultsPayload.leagueNumber, '9485');
  assert.equal(monitorPayload.leagueNumber, '9485');
  assert.equal(observation.entry.leagueId, '21');
  assert.equal(observation.entry.leagueNumber, '9485');
});

test('canonical 409 does not prevent result tracking', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'tracked-409' }));
  const entry = registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-passive');

  assert.equal(entry.providerEventId, 'tracked-409');
  assert.equal(entry.eventPostSucceeded, false);
  assert.equal(entry.status, 'AWAITING_RESULTS');
  assert.equal(resultCompletenessLedger.has('tracked-409'), true);
});

test('queue-imported confirmed board is tracked', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'queue-board' }));
  const validation = validateResultTrackableBoard(board);
  const entry = registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-queue');

  assert.equal(validation.valid, true);
  assert.equal(entry.providerEventId, 'queue-board');
  assert.equal(entry.expectedMatchCount, 10);
});

test('results match by providerEventId after DOM advances', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'old-visible' }));
  registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-queue');
  const nextBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'new-visible',
    ids: ['n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10'],
  }));
  const state = createInitialBoardState();
  promoteBoardStateToActive(state, board, Date.now(), 'initial');
  enterBoardTransition(state, makeObservedFromBoard(nextBoard), [nextBoard], 'dom-ahead-of-feed');

  const observation = observe(classifyEventDetailPacket(makeResultPayload({ providerEventId: 'old-visible' })));

  assert.equal(state.currentBoardState.phase, BOARD_PHASES.TRANSITION);
  assert.equal(observation.isComplete, true);
  assert.equal(observation.entry.providerEventId, 'old-visible');
});

test('leagueNumber mismatch does not block result matching', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'league-mismatch',
    leagueId: '21',
    leagueNumber: '9486',
  }));
  registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-queue');

  const observation = observe(classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'league-mismatch',
    leagueId: '21',
    leagueNumber: '21',
  })));

  assert.equal(observation.isComplete, true);
  assert.equal(observation.entry.providerEventId, 'league-mismatch');
});

test('10 valid result rows post successfully', async () => {
  const originalFetch = global.fetch;
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'post-results' }));
  const entry = registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-queue');
  const { observation, monitorPayload } = observeWithMonitor(classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'post-results',
  })));
  global.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ ok: true, batchId: 'results-batch' }),
  });

  try {
    const result = await postResultMonitorPayloadWithLedger(observation.entry, monitorPayload);
    assert.equal(result.ok, true);
    assert.equal(entry.status, 'RESULTS_COMPLETE');
    assert.equal(entry.resultPostSucceededAt !== null, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('unmatched unknown providerEventId remains quarantined', () => {
  const observation = observe(classifyEventDetailPacket(makeResultPayload({ providerEventId: 'unknown-result' })));

  assert.equal(observation.rejected, true);
  assert.equal(observation.reason, 'unmatched-board');
});

test('duplicate result packet does not post twice', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'duplicate-result' }));
  registerResultLedgerEventBoard(board, { expectedMatchCount: 10 }, 'feed-events-queue');
  const packet = classifyEventDetailPacket(makeResultPayload({ providerEventId: 'duplicate-result' }));
  const first = observe(packet);
  first.entry.status = 'RESULTS_COMPLETE';

  const duplicate = observe(packet);

  assert.equal(first.isComplete, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reason, 'duplicate-result');
});

test('active board snapshot registry enriches queue board A by providerEventId', () => {
  registerProviderLeagueNumber(createActiveBoardSnapshot(parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '9486',
  }))));
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '21',
  }));

  const queuePayload = buildFeedEventsQueuePayload([boardA], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [queueBoard] = queuePayload.boards;

  assert.equal(queueBoard.providerEventId, 'A');
  assert.equal(queueBoard.leagueId, '21');
  assert.equal(queueBoard.providerLeagueId, '21');
  assert.equal(queueBoard.leagueNumber, '9486');
  assert.equal(queueBoard.matches[0].leagueId, '21');
  assert.equal(queueBoard.matches[0].providerLeagueId, '21');
  assert.equal(queueBoard.matches[0].leagueNumber, '9486');
});

test('active board snapshot registry enriches queue board B with its own provider league number', () => {
  registerProviderLeagueNumber(createActiveBoardSnapshot(parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '9486',
  }))));
  registerProviderLeagueNumber(createActiveBoardSnapshot(parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    leagueId: '21',
    leagueNumber: '12855',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }))));
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '21',
  }));
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    leagueId: '21',
    leagueNumber: '21',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));

  const queuePayload = buildFeedEventsQueuePayload([boardA, boardB], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [, queueBoardB] = queuePayload.boards;

  assert.equal(queueBoardB.providerEventId, 'B');
  assert.equal(queueBoardB.leagueId, '21');
  assert.equal(queueBoardB.providerLeagueId, '21');
  assert.equal(queueBoardB.leagueNumber, '12855');
  assert.equal(queueBoardB.matches[0].leagueNumber, '12855');
});

test('queue board C remains 21 when no active snapshot registry entry exists', () => {
  registerProviderLeagueNumber(createActiveBoardSnapshot(parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '9486',
  }))));
  const boardC = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'C',
    leagueId: '21',
    leagueNumber: '21',
    ids: ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10'],
  }));

  const queuePayload = buildFeedEventsQueuePayload([boardC], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [queueBoard] = queuePayload.boards;

  assert.equal(queueBoard.providerEventId, 'C');
  assert.equal(queueBoard.leagueId, '21');
  assert.equal(queueBoard.providerLeagueId, '21');
  assert.equal(queueBoard.leagueNumber, '21');
  assert.equal(queueBoard.matches[0].leagueNumber, '21');
});

test('provider league registry ignores leagueId 21 and does not overwrite a provider league number', () => {
  registerProviderLeagueNumber({
    providerEventId: 'A',
    boardKey: 'VirtualHorizon:21:A',
    leagueNumber: '9486',
    firstMatch: 'Home A vs Away A',
    weekNumber: '17',
  });
  const ignored = registerProviderLeagueNumber(classifyEventDetailPacket(makeResultPayload({
    providerEventId: 'A',
    leagueId: '21',
    includeLeagueNumber: false,
  })));
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '21',
  }));

  const queuePayload = buildFeedEventsQueuePayload([boardA], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [queueBoard] = queuePayload.boards;

  assert.equal(ignored, null);
  assert.equal(queueBoard.leagueId, '21');
  assert.equal(queueBoard.providerLeagueId, '21');
  assert.equal(queueBoard.leagueNumber, '9486');
  assert.equal(queueBoard.matches[0].leagueNumber, '9486');
});

test('active board snapshot registry enriches queue board by boardKey fallback', () => {
  const ids = ['k01', 'k02', 'k03', 'k04', 'k05', 'k06', 'k07', 'k08', 'k09', 'k10'];
  const boardKey = buildVirtualHorizonBoardKey({ leagueId: '21', orderedMatchIds: ids });
  registerProviderLeagueNumber({
    providerEventId: '',
    boardKey,
    leagueNumber: '9486',
    firstMatch: 'Home k01 vs Away k01',
    weekNumber: '17',
  });
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: '',
    leagueId: '21',
    leagueNumber: '21',
    ids,
  }));

  const queuePayload = buildFeedEventsQueuePayload([board], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [queueBoard] = queuePayload.boards;

  assert.equal(queueBoard.providerEventId, '');
  assert.equal(queueBoard.boardKey, boardKey);
  assert.equal(queueBoard.leagueId, '21');
  assert.equal(queueBoard.providerLeagueId, '21');
  assert.equal(queueBoard.leagueNumber, '9486');
  assert.equal(queueBoard.matches[0].leagueNumber, '9486');
});

test('provider league registry expiration removes stale entries', () => {
  const now = Date.UTC(2026, 6, 27, 11, 0, 0);
  registerProviderLeagueNumber({
    providerEventId: 'A',
    boardKey: 'VirtualHorizon:21:A',
    leagueNumber: '9486',
    firstMatch: 'Home A vs Away A',
    weekNumber: '17',
  }, now - (31 * 60 * 1000));
  pruneProviderLeagueNumberRegistry(now);
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'A',
    leagueId: '21',
    leagueNumber: '21',
  }));

  const queuePayload = buildFeedEventsQueuePayload([boardA], Date.UTC(2026, 6, 27, 11, 0, 0), now);
  const [queueBoard] = queuePayload.boards;

  assert.equal(providerLeagueNumberRegistry.size, 0);
  assert.equal(queueBoard.providerEventId, 'A');
  assert.equal(queueBoard.leagueNumber, '21');
  assert.equal(queueBoard.matches[0].leagueNumber, '21');
});

test('discovery filters already-registered boards and keeps only missing boards', () => {
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    leagueNumber: '21',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  registerProviderLeagueNumber({
    providerEventId: 'A',
    boardKey: boardA.boardKey,
    leagueNumber: '9486',
    firstMatch: boardA.firstMatch,
    weekNumber: boardA.weekNumber,
  });

  const missing = getRegistryMissingQueueBoards([boardA, boardB]);

  assert.deepEqual(missing.map((board) => board.providerEventId), ['B']);
});

test('discovery limits maximum boards per pass', () => {
  const boards = ['A', 'B', 'C'].map((providerEventId, index) => parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId,
    leagueNumber: '21',
    ids: Array.from({ length: 10 }, (_, idIndex) => `${providerEventId.toLowerCase()}${index}${idIndex}`),
  })));

  const missing = getRegistryMissingQueueBoards(boards, { maxBoards: 2 });

  assert.deepEqual(missing.map((board) => board.providerEventId), ['A', 'B']);
});

test('discovery exact providerEventId matching wins', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  const snapshot = {
    providerEventId: 'A',
    boardKey: 'VirtualHorizon:21:other',
    leagueId: '21',
    leagueNumber: '9486',
    weekNumber: '999',
    firstMatch: 'Wrong vs Teams',
  };

  assert.equal(doesActiveSnapshotMatchQueueBoard(snapshot, board), true);
});

test('discovery firstMatch and week fallback matching works without providerEventId', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: '', leagueNumber: '21' }));
  const snapshot = {
    providerEventId: '',
    boardKey: '',
    leagueId: '21',
    leagueNumber: '9486',
    weekNumber: board.weekNumber,
    firstMatch: board.firstMatch,
  };

  assert.equal(doesActiveSnapshotMatchQueueBoard(snapshot, board), true);
});

test('discovery rejects week-only matches', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: '', leagueNumber: '21' }));
  const snapshot = {
    providerEventId: '',
    boardKey: '',
    leagueId: '21',
    leagueNumber: '9486',
    weekNumber: board.weekNumber,
    firstMatch: 'Different vs Match',
  };

  assert.equal(doesActiveSnapshotMatchQueueBoard(snapshot, board), false);
});

test('discovery registers provider league number after successful activation', async () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  const snapshot = {
    providerEventId: 'A',
    boardKey: board.boardKey,
    leagueId: '21',
    leagueNumber: '9486',
    weekNumber: board.weekNumber,
    firstMatch: board.firstMatch,
  };

  const result = await runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [board],
    intervalMs: 0,
    activateBoard: async () => ({ activated: true }),
    getActiveBoardSnapshot: () => snapshot,
  });

  assert.equal(result.registered, 1);
  assert.equal(lookupQueueLeagueNumber(board), '9486');
});

test('discovery timeout leaves registry unchanged', async () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));

  const result = await runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [board],
    intervalMs: 0,
    timeoutMs: 5,
    pollMs: 1,
    activateBoard: async () => ({ activated: true }),
    getActiveBoardSnapshot: () => null,
  });

  assert.equal(result.registered, 0);
  assert.equal(lookupQueueLeagueNumber(board), '21');
});

test('discovery lock prevents concurrent passes', async () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  let release;
  const first = runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [board],
    intervalMs: 0,
    activateBoard: () => new Promise((resolve) => {
      release = () => resolve({ activated: false, reason: 'released' });
    }),
    getActiveBoardSnapshot: () => null,
  });
  const second = await runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [board],
    intervalMs: 0,
    activateBoard: async () => ({ activated: true }),
    getActiveBoardSnapshot: () => null,
  });
  release();
  await first;

  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'in-progress');
});

test('discovery restores previous active board', async () => {
  const boardA = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  const boardB = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    leagueNumber: '21',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  let currentSnapshot = {
    providerEventId: 'A',
    boardKey: boardA.boardKey,
    leagueId: '21',
    leagueNumber: '9486',
    weekNumber: boardA.weekNumber,
    firstMatch: boardA.firstMatch,
  };
  const activated = [];

  const result = await runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [boardB],
    intervalMs: 0,
    previousActiveBoard: boardA,
    activateBoard: async (board) => {
      activated.push(board.providerEventId);
      currentSnapshot = {
        providerEventId: board.providerEventId,
        boardKey: board.boardKey,
        leagueId: '21',
        leagueNumber: board.providerEventId === 'B' ? '12855' : '9486',
        weekNumber: board.weekNumber,
        firstMatch: board.firstMatch,
      };
      return { activated: true };
    },
    getActiveBoardSnapshot: () => currentSnapshot,
  });

  assert.equal(result.registered, 1);
  assert.deepEqual(activated, ['B', 'A']);
});

test('invalid fallback leagueNumber 21 is not treated as discovered', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  registerProviderLeagueNumber({
    providerEventId: 'A',
    boardKey: board.boardKey,
    leagueNumber: '21',
    firstMatch: board.firstMatch,
    weekNumber: board.weekNumber,
  });

  const missing = getRegistryMissingQueueBoards([board]);

  assert.deepEqual(missing.map((candidate) => candidate.providerEventId), ['A']);
});

test('queue enrichment applies after discovery', async () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A', leagueNumber: '21' }));
  await runProviderLeagueDiscoveryPass({
    enabled: true,
    boardPayloads: [board],
    intervalMs: 0,
    activateBoard: async () => ({ activated: true }),
    getActiveBoardSnapshot: () => ({
      providerEventId: 'A',
      boardKey: board.boardKey,
      leagueId: '21',
      leagueNumber: '9486',
      weekNumber: board.weekNumber,
      firstMatch: board.firstMatch,
    }),
  });

  const queuePayload = buildFeedEventsQueuePayload([board], Date.UTC(2026, 6, 27, 11, 0, 0));
  const [queueBoard] = queuePayload.boards;

  assert.equal(queueBoard.leagueId, '21');
  assert.equal(queueBoard.providerLeagueId, '21');
  assert.equal(queueBoard.leagueNumber, '9486');
});

test('canonical 409 does not affect discovery eligibility', () => {
  assert.equal(canRunProviderLeagueDiscovery({
    enabled: true,
    discoveryInProgress: false,
    lastRunAt: 0,
    canonicalStatus: 409,
  }), true);
});

test('board state matching DOM and feed promotes ACTIVE', () => {
  const state = createInitialBoardState(Date.UTC(2026, 6, 27, 11, 0, 0));
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));

  promoteBoardStateToActive(state, board, Date.UTC(2026, 6, 27, 11, 0, 1), 'feed-dom-matched');

  assert.equal(state.currentBoardState.phase, BOARD_PHASES.ACTIVE);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'A');
});

test('board state enters TRANSITION when DOM changes before feed', () => {
  const state = createInitialBoardState(Date.UTC(2026, 6, 27, 11, 0, 0));
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, Date.UTC(2026, 6, 27, 11, 0, 0), 'initial');

  enterBoardTransition(state, makeObservedFromBoard(newBoard), [oldBoard, newBoard], 'dom-ahead-of-feed', Date.UTC(2026, 6, 27, 11, 0, 5));

  assert.equal(state.currentBoardState.phase, BOARD_PHASES.TRANSITION);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'A');
  assert.equal(state.transitionTarget.providerEventId, 'B');
});

test('old feed is not promoted during transition', () => {
  const state = createInitialBoardState();
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, Date.now(), 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed');

  const suppressed = shouldSuppressCanonicalPostDuringTransition(state, oldBoard);

  assert.equal(suppressed, true);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'A');
  assert.equal(state.currentBoardState.phase, BOARD_PHASES.TRANSITION);
});

test('queue match creates transitionTarget', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const target = findTransitionTargetFromQueue(makeObservedFromBoard(board), [board]);

  assert.equal(target.providerEventId, 'A');
});

test('matching feed promotes transition to ACTIVE', () => {
  const state = createInitialBoardState();
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, Date.now(), 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed');

  const confirmed = confirmBoardTransitionFromFeed(state, newBoard);

  assert.equal(confirmed, true);
  assert.equal(state.currentBoardState.phase, BOARD_PHASES.ACTIVE);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'B');
});

test('transition target rejects week-only match', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const observed = {
    ...makeObservedFromBoard(board),
    firstMatch: 'Different vs Teams',
  };

  assert.equal(findTransitionTargetFromQueue(observed, [board]), null);
});

test('transition target rejects leagueId mismatch', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const observed = {
    ...makeObservedFromBoard(board),
    leagueId: '99',
  };

  assert.equal(findTransitionTargetFromQueue(observed, [board]), null);
});

test('result packets for previous board remain accepted during transition', () => {
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  registerResultLedgerEventBoard(oldBoard);
  const state = createInitialBoardState();
  promoteBoardStateToActive(state, oldBoard, Date.now(), 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed');

  const observation = observe(classifyEventDetailPacket(makeResultPayload({ providerEventId: 'A' })));

  assert.equal(state.currentBoardState.phase, BOARD_PHASES.TRANSITION);
  assert.equal(observation.isComplete, true);
});

test('transition timeout does not clear last confirmed board', () => {
  const startedAt = Date.UTC(2026, 6, 27, 11, 0, 0);
  const state = createInitialBoardState(startedAt);
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, startedAt, 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed', startedAt);

  const timedOut = checkBoardTransitionTimeout(state, startedAt + 46_000, 45_000);

  assert.equal(timedOut, true);
  assert.equal(state.currentBoardState.phase, BOARD_PHASES.STALE);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'A');
});

test('later feed recovers from transition timeout', () => {
  const startedAt = Date.UTC(2026, 6, 27, 11, 0, 0);
  const state = createInitialBoardState(startedAt);
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, startedAt, 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed', startedAt);
  checkBoardTransitionTimeout(state, startedAt + 46_000, 45_000);

  promoteBoardStateToActive(state, newBoard, startedAt + 47_000, 'feed-dom-matched');

  assert.equal(state.currentBoardState.phase, BOARD_PHASES.ACTIVE);
  assert.equal(state.confirmedFeedBoard.providerEventId, 'B');
});

test('incomplete queue payload is skipped locally', () => {
  const invalidBoard = {
    providerEventId: '',
    leagueId: '21',
    providerLeagueId: '21',
    weekNumber: '',
    firstMatch: '',
    events: [],
  };

  const validation = validateFeedEventsQueueBoards([invalidBoard]);

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missing, ['providerEventId', 'weekNumber', 'firstMatch', 'events']);
});

test('league discovery is disabled by default', () => {
  assert.equal(canRunProviderLeagueDiscovery({ lastRunAt: 0 }), false);
});

test('canonical posting is suppressed during transition', () => {
  const state = createInitialBoardState();
  const oldBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));
  const newBoard = parseFeedEventsBoardFromBoard(makeFeedBoard({
    providerEventId: 'B',
    ids: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'],
  }));
  promoteBoardStateToActive(state, oldBoard, Date.now(), 'initial');
  enterBoardTransition(state, makeObservedFromBoard(newBoard), [newBoard], 'dom-ahead-of-feed');

  assert.equal(shouldSuppressCanonicalPostDuringTransition(state, oldBoard), true);
});

test('valid queue posting remains valid during transition', () => {
  const board = parseFeedEventsBoardFromBoard(makeFeedBoard({ providerEventId: 'A' }));

  assert.equal(validateFeedEventsQueueBoards([board]).valid, true);
});

function lookupQueueLeagueNumber(board) {
  const queuePayload = buildFeedEventsQueuePayload([board], Date.UTC(2026, 6, 27, 11, 0, 0));
  return queuePayload.boards[0].leagueNumber;
}

function makeObservedFromBoard(board) {
  return createObservedDomBoard({
    text: board.firstMatch,
    visibleWeek: board.weekNumber,
    visibleLeague: board.leagueNumber,
    countdownSeconds: 42,
  });
}
