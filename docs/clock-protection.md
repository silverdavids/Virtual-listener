# Lifecycle clock protection

`provider-live-state` takes provider ANNOUNCEMENT/PROGRESS/RESULTS, RACING,
COMPLETED and provider-supplied actual start as lifecycle evidence. Scheduled
kickoff alone never produces LIVE. `state` and `providerLifecycle` carry the
provider phase; `bettingOpen` becomes false at trustworthy scheduled kickoff.
There is no timer-generated FINISHED. Genuine LIVE/FINISHED do not regress.

`provider-clock` compares wall-clock elapsed time with `performance.now()`.
`VH_CLOCK_DISCONTINUITY_MS` defaults to 5000 ms, bounded to 1000–60000 ms;
invalid values use the default. Both directions emit a sanitized
`CLOCK-DISCONTINUITY` warning. Smaller adjustments are reported by the clock's
`adjustmentMs` and included in its safe wall-clock estimate; negative adjustments
never reverse observation order. They are not classified as large jumps.

Each league/event has its own provider-server-time and monotonic receipt anchor.
Source time remains the provider response timestamp. Observation time is UTC
estimated from that receipt anchor plus monotonic elapsed time when the scraper
observes/project scores; a host-clock jump is never added. This deliberately
does not use the potentially incorrect host UTC as an ordering authority.
Feed source timestamps must advance strictly (backward tolerance is zero).
Event identity and scheduled start must match; invalid times are rejected before
posting. `VH_TIMESTAMP_FUTURE_SKEW_MS` defaults to 30000 ms, bounded to
1000–60000 ms, relative to the event's provider reference. The API independently
validates both timestamps against its own server time.

The existing refresh scheduler consumes a discontinuity notification on its next
tick and makes feed/results refreshes due immediately, retaining its existing
in-flight limits. No login, restart or import is triggered by the clock module.
Provider polling may anchor a new event without affecting another event's anchor.
Monotonic anchors are not serialized: restored ledger entries wait for fresh
provider evidence rather than extrapolating an old wall-clock pair.

Legacy unscored LIVE with an ANNOUNCEMENT raw snapshot may recover only with a
fresh explicit UPCOMING snapshot, matching competition/event/start, future
provider kickoff, and no startedAt, score or progress evidence. It logs
`poisoned_unscored_live`. A raw PROGRESS, scored event, or FINISHED is ineligible.

API deployment also requires the separately reviewed lifecycle upsert procedure
update. No state remediation or restart is included in this implementation.
The preserved auto-sync/error-handler work is unchanged. The old running process
continues using its already loaded code until a separately approved restart.
