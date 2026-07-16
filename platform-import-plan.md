# Platform Import Plan

This plan describes how `data/canonical-events.json` should be imported into the betting platform as reusable provider data. The import should not be tied to SmartBet or any single customer. SmartBet is only one client configuration that can consume the shared canonical event model.

## 1. Provider Model

Provider-specific identifiers and names must be preserved so future imports can update the same entities without losing the original provider reference.

Suggested provider fields:

- `ProviderId`
- `ProviderName`
- `ProviderEventId`
- `ProviderMarketName`
- `ProviderSelectionName`

For Virtual Horizon, `ProviderName` should be `VirtualHorizon`, and `ProviderEventId` should come from `providerEventId` in `canonical-events.json`.

## 2. Canonical Models

The platform should import provider feeds into canonical betting models, then expose client-specific configuration on top of those models.

Core tables/models:

- `Events`
  - Canonical event row.
  - Stores sport, league, teams, start time, active status, and lifecycle fields.

- `Markets`
  - Canonical market row for an event.
  - Uses platform market codes such as `1X2`, `DC`, `OU`, `BTS`, `CS`, and `TG`.

- `Selections` / `Odds`
  - Stores selections under a market.
  - Example selections: `Home`, `Draw`, `Away`, `OVER_2.5`, `0-0`.
  - Stores current odd and status.

- `ProviderEventMap`
  - Maps provider events to canonical platform events.
  - Key fields: `ProviderId`, `ProviderEventId`, `EventId`.

- `ProviderMarketMap`
  - Maps provider market names to canonical market codes.
  - Example: `WINNER -> 1X2`, `DOUBLE_CHANCE -> DC`.

- `ClientMarketConfig`
  - Controls which sports, leagues, markets, and selections each client can offer.
  - Stores client-level enablement and later client-level margin settings.

## 3. Multi-Client Flow

Provider feed data should be imported once into the platform.

Flow:

1. Virtual Horizon feed is captured and normalized.
2. `canonical-events.json` is generated from the provider feed.
3. The platform imports canonical events, markets, selections, and odds.
4. Each client chooses which sports, leagues, and markets to enable.
5. Client-specific margins can be applied later at market or selection level.
6. SmartBet is only one row/set of rows in client configuration, not a separate provider import model.

This keeps provider integration reusable for future clients.

## 4. API Design

Endpoint:

```http
POST /api/provider-imports/virtual-horizon/events
```

Request body:

```json
[
  {
    "provider": "VirtualHorizon",
    "providerEventId": "2471267401",
    "sport": "FOOTBALL",
    "leagueId": 21,
    "leagueName": "Champs League",
    "homeTeam": "BAR",
    "awayTeam": "MAR",
    "startTime": "2026-06-18T10:51:37.000Z",
    "markets": [
      {
        "code": "1X2",
        "name": "WINNER",
        "selections": [
          { "name": "Home", "odd": 1.28 },
          { "name": "Away", "odd": 10.7 },
          { "name": "Draw", "odd": 5.16 }
        ]
      }
    ]
  }
]
```

The body should match `data/canonical-events.json`.

## 5. Import Rules

- Upsert event by provider + `providerEventId`.
- Upsert markets by `providerEventId` + canonical market code.
- Upsert selections by market + selection name.
- Update odds on existing selections.
- Mark missing events inactive when they no longer appear in the latest provider import.
- Mark missing markets inactive when they no longer appear under an active event.
- Preserve provider names in mapping tables for diagnostics and future remapping.
- Keep client enablement separate from provider import state.

