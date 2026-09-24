const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeProviderTimestamp: iso } = require('./provider-timestamp');
const keyOf = b => JSON.stringify([String(b.leagueId), String(b.providerEventId)]);
const rank = { UPCOMING: 0, LIVE: 1, FINISHED: 2 };
const rows = b => Object.values(b?.f?.b?.c?.c || {}).map(row => row.b || row);
const fragments = m => Object.values(m?.i?.a?.g?.a || {});
const duration = m => fragments(m).reduce((sum, f) => sum + (Number(f.f) || 0), 0);
const score = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

// Persist only fields needed to recover lifecycle and the provider's timeline.
// Odds and unrelated provider/account data do not belong in this ledger.
const snapshot = b => ({a:b.a,c:b.c,d:b.d,f:{b:{a:b.f.b.a,e:b.f.b.e,c:{a:b.f.b.c.a,b:b.f.b.c.b,
  c:rows(b).map(m=>({b:{a:m.a,h:m.h,i:{a:{a:m.i?.a?.a,b:m.i?.a?.b,d:m.i?.a?.d,g:m.i?.a?.g}}}}))}}}});

// Verified against provider codec EventDto/SubEventDto and UI Ai/xi/Li/Bi.
// e/g are nextTransitionTime, NOT end times. Never expose future fragment scores.
function parseLiveBoard(board, serverNow, requestedLeagueId) {
  const matches = rows(board), first = matches[0];
  const leagueId = String(board?.f?.b?.a?.a?.d ?? board?.f?.b?.a?.d ?? requestedLeagueId ?? '');
  if (!['21','78'].includes(leagueId) || requestedLeagueId && leagueId !== String(requestedLeagueId) || !board.a || matches.length !== 10) return null;
  const scheduledStartAtUtc = iso(board.d);
  const providerStatus = board.c;
  const matchStatus = board?.f?.b?.c?.b;
  const finished = ['RESULTS','COMPLETED'].includes(providerStatus) || ['DISPLAY_RESULTS','COMPLETED'].includes(matchStatus);
  const startedAtUtc = iso(first?.h?.c);
  const hasStarted = providerStatus === 'PROGRESS' || matchStatus === 'RACING' || Boolean(startedAtUtc) ||
    scheduledStartAtUtc && Date.parse(scheduledStartAtUtc) <= serverNow;
  const state = finished ? 'FINISHED' : hasStarted ? 'LIVE' : 'UPCOMING';
  const firstDuration = duration(first), start = Date.parse(startedAtUtc);
  const elapsed = Number.isFinite(start) ? Math.max(0, serverNow - start) : 0;
  const minute = finished ? 90 : state === 'LIVE' && firstDuration > 0 && Number.isFinite(start)
    ? Math.min(90, Math.ceil(90 * elapsed / firstDuration)) : null;
  return {
    provider: 'VirtualHorizon', source: 'provider-live-state', leagueId,
    leagueName: first?.i?.a?.a?.a || '', providerEventId: String(board.a),
    leagueNumber: board?.f?.b?.e == null ? null : String(board.f.b.e),
    weekNumber: String(board?.f?.b?.c?.a ?? ''), state, providerStatus, availabilityStatus: matchStatus,
    scheduledStartAtUtc, startedAtUtc: state === 'UPCOMING' ? null : startedAtUtc || scheduledStartAtUtc,
    minute, observedAtUtc: new Date(serverNow).toISOString(),
    available: providerStatus !== 'CANCELLED',
    suspended: ['CANCELLED','CANCELLATION','BETS_CLOSED'].includes(matchStatus) ||
      state === 'UPCOMING' && matchStatus !== 'ACCEPTING_TICKETS',
    matches: matches.map(m => {
      let homeScore = null, awayScore = null;
      if (finished) {
        homeScore = score(m?.i?.a?.d?.a); awayScore = score(m?.i?.a?.d?.b);
      } else if (state === 'LIVE' && fragments(m).length && firstDuration > 0) {
        homeScore = 0; awayScore = 0;
        const scale = firstDuration / duration(m);
        let previous = 0;
        for (const f of fragments(m)) {
          const action = Math.round((previous + Number(f.g)) * scale);
          if (elapsed > action && score(f.h) !== null && score(f.i) !== null) {
            homeScore = f.h; awayScore = f.i;
          }
          previous += Number(f.f) || 0;
        }
      }
      return { providerMatchId: String(m.a), homeTeam: m?.i?.a?.b?.a?.a || '',
        awayTeam: m?.i?.a?.b?.b?.a || '', homeScore, awayScore, state, minute };
    }),
  };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'number' && Number.isFinite(value) &&
  value >= 0 && Number.isFinite(new Date(value).getTime());

function validateLedger(data) {
  if (!Array.isArray(data)) throw new Error('Invalid ledger');
  const result = new Map();
  for (const tuple of data) {
    if (!Array.isArray(tuple) || tuple.length !== 2) throw new Error('Invalid tuple');
    const [key, value] = tuple;
    if (typeof key !== 'string') throw new Error('Invalid key');
    const identity = JSON.parse(key);
    if (!Array.isArray(identity) || identity.length !== 2 || !['21','78'].includes(identity[0]) ||
        typeof identity[1] !== 'string' || !identity[1].trim() || JSON.stringify(identity) !== key || result.has(key)) {
      throw new Error('Invalid identity');
    }
    if (!object(value) || !object(value.raw) || !validTime(value.serverTime) ||
        !validTime(value.receivedAt) || !Object.hasOwn(rank, value.state) || typeof value.available !== 'boolean' ||
        ['removedAt','lastPostAt','nextPostAt'].some(field => value[field] !== undefined && !validTime(value[field]))) {
      throw new Error('Invalid entry');
    }
    const board = parseLiveBoard(value.raw, value.serverTime, identity[0]);
    if (!board || keyOf(board) !== key || !board.scheduledStartAtUtc ||
        board.matches.some(match => !match.providerMatchId || match.providerMatchId === 'undefined') ||
        new Set(board.matches.map(match => match.providerMatchId)).size !== 10) throw new Error('Invalid board');
    // Rebuild the durable shape instead of restoring arbitrary object properties.
    result.set(key, {raw:snapshot(value.raw), serverTime:value.serverTime, receivedAt:value.receivedAt,
      state:value.state, available:value.available, removedAt:value.removedAt,
      lastPostAt:value.lastPostAt, hash:'', nextPostAt:0});
  }
  return result;
}

function createLiveStateMonitor({ post, file, now = Date.now, reconciliationMs = 15000, log = console.log, io = fs }) {
  let entries = new Map();
  let persistenceBlocked = false;
  if (file) {
    try {
      entries = validateLedger(JSON.parse(io.readFileSync(file,'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.bak`;
        try {
          io.renameSync(file, backup);
          log(`LIVE-STATE-WARNING corrupt state original=${file} backup=${backup}; starting empty`);
        } catch {
          // Never overwrite a file that could not be preserved for recovery.
          persistenceBlocked = true;
          log(`LIVE-STATE-WARNING quarantine failed original=${file} backup=${backup}; starting empty, persistence disabled until restart`);
        }
      }
    }
  }
  const persist = () => {
    if (!file || persistenceBlocked) return;
    // Synchronous writes cannot overlap within this process. Unique, exclusive
    // temporary files also avoid collisions with other processes or old debris.
    const serialized = JSON.stringify([...entries]);
    validateLedger(JSON.parse(serialized));
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    let descriptor, created = false;
    try {
      descriptor = io.openSync(temporary, 'wx', 0o600);
      created = true;
      io.writeFileSync(descriptor, serialized, 'utf8');
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = undefined;
      // On Windows a sharing violation can reject replacement. Never unlink
      // the primary as a workaround: retain it and let a later write retry.
      io.renameSync(temporary, file);
      created = false;
    } finally {
      if (descriptor !== undefined) {
        try { io.closeSync(descriptor); } catch { /* Retain original failure. */ }
      }
      if (created) {
        try { io.unlinkSync(temporary); } catch (error) {
          if (error.code !== 'ENOENT') log(`LIVE-STATE-WARNING temporary cleanup failed path=${temporary}`);
        }
      }
    }
  };
  function observe(json, leagueId) {
    const serverTime = Number(json?.header?.serverTime);
    if (!Number.isFinite(serverTime)) return;
    const boards = json.events ? Object.values(json.events) : json.event ? [json.event] : [];
    const seen = new Set();
    for (const raw of boards) {
      const payload = parseLiveBoard(raw, serverTime, leagueId);
      if (!payload) continue;
      const key = keyOf(payload), old = entries.get(key);
      seen.add(key);
      if (old && serverTime <= Math.max(old.serverTime,old.removedAt || 0)) continue;
      if (old && old.raw.c !== 'ANNOUNCEMENT' && raw.c === 'ANNOUNCEMENT') continue;
      // A delayed prematch snapshot must not replace live score timelines.
      if (old && rank[payload.state] < rank[old.state]) continue;
      entries.set(key, { ...old, raw:snapshot(raw), serverTime, receivedAt: now(), state: payload.state, available: payload.available });
    }
    if (json.events && leagueId) {
      for (const [key, entry] of entries) {
        if (JSON.parse(key)[0] === String(leagueId) && !seen.has(key) && serverTime > entry.serverTime) {
          entry.available = false;
          entry.removedAt = Math.max(entry.removedAt || 0,serverTime);
        }
      }
    }
    persist();
  }
  let busy = false;
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      await Promise.all([...entries].map(async ([key, entry]) => {
        if (now() < (entry.nextPostAt || 0)) return;
        const serverNow = entry.available === false && entry.removedAt ? entry.removedAt :
          entry.serverTime + Math.max(0, now() - entry.receivedAt);
        const payload = parseLiveBoard(entry.raw, serverNow, JSON.parse(key)[0]);
        if (!payload) return;
        if (rank[entry.state] > rank[payload.state]) payload.state = entry.state;
        entry.state = payload.state;
        payload.sourceUpdatedAtUtc = new Date(Math.max(entry.serverTime,entry.available===false ? entry.removedAt || 0 : 0)).toISOString();
        payload.available = entry.available;
        const hash = JSON.stringify({ ...payload, observedAtUtc: undefined, sourceUpdatedAtUtc: undefined });
        if (hash === entry.hash && (payload.state === 'FINISHED' || payload.available === false ||
            now() - (entry.lastPostAt || 0) < reconciliationMs)) return;
        try {
          await post(payload);
          entry.hash = hash; entry.lastPostAt = now();
          log(`LIVE-STATE-POSTED league=${payload.leagueId} event=${payload.providerEventId} state=${payload.state} minute=${payload.minute}`);
        } catch (e) {
          entry.nextPostAt = now() + 5000;
          log(`LIVE-STATE-RETRY league=${payload.leagueId} event=${payload.providerEventId} reason=${e.message}`);
        }
      }));
      persist();
    } finally { busy = false; }
  }
  return { entries, observe, flush };
}
module.exports = { parseLiveBoard, createLiveStateMonitor, keyOf };
