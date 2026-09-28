# Champions channel mapping

Verified September 25, 2026 before implementing separate TV routes.

The channel discriminator is the pair **competition ID + scene policy**:

| Raw feed | Normalized metadata | Provider channel | Example provider event IDs |
|---|---|---|---|
| `f.b.a.d = 21`, `f.b.d = SCENE_4` | `leagueId = "21"`, `scenePolicy = "SCENE_4"` | `football_championsleague_4goals` | `788392771`, `788394975` |
| `f.b.a.d = 21`, `f.b.d = SCENE_6` | `leagueId = "21"`, `scenePolicy = "SCENE_6"` | `football_championsleague_6goals` | `788392131`, `788394853` |

The provider codec decodes `EventDto.f` as `data`, `EventDataDto.b` as
`tournamentSubEventData`, and `FootballTournamentSubEventDataDto.d` as
`scenePolicy`. Its `FootballScenePolicyDto` defines SCENE_4.maxGoals=4,
SCENE_6.maxGoals=6, and SCENE_7.maxGoals=7. The same DTO names `e` as
`seasonNumber` and `f` as `seasonId`. Neither season number nor week number is
a stable channel discriminator. Competition 21 alone is insufficient.

Evidence: the authenticated shop response captured at 2026-09-25T14:15:11Z
contains both scene policies in the same competition queue. The reviewed
metadata excerpt is [champions-channels.json](../test-fixtures/champions-channels.json).
During separate webviewer observations, all ten ordered fixtures matched the
API board for each of the four example IDs. SCENE_4 events were displayed in
the 4goals channel, season 13176, weeks 29/30; SCENE_6 events in the 6goals
channel, season 9725, weeks 26/27. Those season values are examples only.
The local detailed observation and identity proof remain under
`data/channel-observation/2026-09-25T14-16-10-729Z/` (ignored runtime evidence).

Every board in that captured queue maps as follows (scheduled times in UTC):

| Provider event ID | Scene | Season / week | Scheduled start |
|---|---|---|---|
| 788390842 | SCENE_4 | 13176 / 28 | 14:14:37 |
| 788389199 | SCENE_6 | 9725 / 25 | 14:15:37 |
| 788392771 | SCENE_4 | 13176 / 29 | 14:21:37 |
| 788392131 | SCENE_6 | 9725 / 26 | 14:25:07 |
| 788394975 | SCENE_4 | 13176 / 30 | 14:28:37 |
| 788394853 | SCENE_6 | 9725 / 27 | 14:34:37 |
| 788397070 | SCENE_4 | 13176 / 31 | 14:35:37 |
| 788397667 | SCENE_6 | 9725 / 28 | 14:44:07 |

## Data path

- Scraper board parsing preserves `f.b.d` as `scenePolicy` on canonical
  fixtures and every queued board. Live-state parsing and persisted raw
  snapshots preserve it through scores, completion and process recovery.
- API queue conversion, current-board imports and display responses preserve
  the metadata. Live-state payload JSON already persists arbitrary metadata;
  no SQL schema change is required. An older live-state record without scene
  metadata does not erase a scene supplied by a newly imported queue board.
- TV filtering uses the explicit scene before choosing or recovering an event.
  It never guesses from season, week, scheduled spacing, scores or market limits.
  Result updates missing scene metadata may inherit it only from an already
  identified event in that channel's own state. Unknown events remain unassigned.

## TV behavior

Routes in the sibling `virtualdisplay` repository:

- `/tv/football_championsleague_4goals/standard`
- `/tv/football_championsleague_4goals/correct-score`
- `/tv/football_championsleague_6goals/standard`
- `/tv/football_championsleague_6goals/correct-score`

EPL routes remain `/tv/78/standard` and `/tv/78/correct-score`. Old `/tv/21/...`
bookmarks show the channel selector rather than silently choosing one scene.
Both Champions routes still fetch competition 21 from the API; filtering is
strictly local to TV. Shop, API queue membership, results processing and betting
cutoffs continue to include all events, including unrecognized scene policies.

Cache, pinned event ID, result hold, completion history, retirement history and
session storage are keyed by the channel slug. Old competition-only saved TV
state is not reused for the new routes. Results requests use the channel's own
pinned providerEventId. Foreign-channel score notifications cannot cancel that
channel's pending REST result request.

Each channel finishes its result hold, waits for a fresh queue, and chooses the
first eligible same-channel board in start-time order with at least five
minutes remaining. Exactly five minutes qualifies. No qualifying event means
waiting for a new queue. The existing five-minute policy is retained as the
requested product rule; provider observation did not establish this threshold.

Fresh metadata is required: deployments serving old payloads without
scenePolicy will show waiting on the new Champions routes. Roll out the API
metadata propagation and scraper metadata first, then the display. No service
restart, production import, SQL migration or deployment is part of this change.

## Validation

- Scraper: 109 tests passed (`node --test --test-isolation=none test-*.js`),
  including scene preservation, persisted lifecycle recovery and all-event imports.
- API: complete `npm test` suite passed, including mixed-scene queue import,
  metadata preservation, display projection and existing betting/lifecycle checks.
- Display: 80 affected Jest tests passed. Both channels cover the exact five-minute
  boundary, too-close candidates, delayed selection, missing metadata, foreign
  results, separate session restoration and event-qualified polling.
- Isolated optimized display build compiled successfully. Twelve browser tests
  passed with mocked APIs, including both channel routes and views, full cycles,
  reload recovery, existing EPL behavior and the clock regression.
- Live post-rollout verification and SQL-backed metadata readback were not run.
  These results establish source-level and mocked-browser behavior, not deployment.
