# Polymarket Scanner Handoff (for Aggregator/Dashboard Agent)

This is a practical handoff for using and extending the Polymarket scanner in this repo.

## Purpose

The Polymarket module provides:

- Market surface scan
- Reward candidate ranking
- Spread candidate ranking
- Parity/split-merge opportunity detection (optional lane)
- Paper simulation (`conservative` and `balanced` models)

Main entrypoint: `src/polymarket/polyCommands.ts`

## How to run

Package scripts (`package.json`):

```bash
npm run poly:scan
npm run poly:rewards
npm run poly:market -- <market-slug-or-condition-id-or-token-id>
npm run poly:paper
npm run poly:paper-watch
npm run poly:paper-report
npm run poly:cron
```

### What each command does

- `poly:scan`
  - Loads live + reward markets
  - Fetches token orderbooks
  - Prints surface stats + top reward/spread/parity candidates
- `poly:rewards`
  - Prints ranked LP reward candidates only
- `poly:market`
  - Prints detailed market + token orderbook pair for one market lookup key
- `poly:paper`
  - Runs one paper tick for both `conservative` and `balanced`
- `poly:paper-watch`
  - Runs paper ticks on an interval (`POLY_PAPER_SCAN_INTERVAL_MS`)
- `poly:paper-report`
  - Prints comparative viability report between the two paper models
- `poly:cron`
  - Runs scanner on `POLY_CRON_SCHEDULE` (default every 2 minutes)
  - Executes `POLY_CRON_COMMAND` each tick (default `npm run poly:scan`)

## API endpoints used by this project

Configured in `src/polymarket/polyConfig.ts`:

- `POLY_GAMMA_BASE_URL` (default `https://gamma-api.polymarket.com`)
- `POLY_CLOB_BASE_URL` (default `https://clob.polymarket.com`)

Calls in `src/polymarket/polyClient.ts`:

- Live events/markets:
  - `GET {gammaBaseUrl}/events?active=true&closed=false&limit=100&offset=<n>`
- Reward markets:
  - `GET {clobBaseUrl}/rewards/markets/multi?page_size=100&order_by=rate_per_day&position=DESC&next_cursor=<cursor>`
- Orderbook per token:
  - `GET {clobBaseUrl}/book?token_id=<tokenId>`
  - fallback: `GET {clobBaseUrl}/book?asset_id=<tokenId>`

The scanner does not require wallet credentials. It is read-only for market data.

## Scanner data flow

### 1) Market ingest and merge

`loadPolyScan()` in `src/polymarket/polyMarketScanner.ts`:

1. Fetches reward markets and live markets in parallel.
2. Merges them by `conditionId`.
3. Preserves reward metadata where available.
4. Produces merged market list (`source: "merged"` when combined).

### 2) Orderbook loading

- Token IDs are collected from:
  - reward slice (`POLY_REWARD_ORDERBOOK_LIMIT`)
  - spread slice (`POLY_SCAN_ORDERBOOK_LIMIT`)
- Orderbooks are fetched with capped concurrency (8 workers in `PolyClient.getOrderbooks()`).
- Result maps:
  - `orderbooksByTokenId: Map<string, PolyOrderbook>`
  - `tokenBooksByConditionId: Map<string, PolyTokenBookPair>`

### 3) Candidate lanes

- Reward lane: `rankPolyRewardCandidates()` in `polyRewardScanner.ts`
- Spread lane: `rankPolySpreadCandidates()` in `polySpreadScanner.ts`
- Parity lane: `scanPolyParity()` in `polyParityScanner.ts`

## Important IDs and joins

Use these identifiers consistently:

- Primary market key: `conditionId`
- Optional market identifiers:
  - `marketId`
  - `marketSlug`
- Token-level key: `tokenId`

For dashboard joins:

1. Join market-level rows by `conditionId`
2. Join token books by `tokenId`
3. Keep `marketSlug` for user-facing URLs/lookup

## Key output types available to reuse

Defined in `src/polymarket/polyTypes.ts`:

- `PolyMarket`
- `PolyOrderbook`
- `PolyTokenBookPair`
- `PolyScanResult`
- `PolyOpportunity` (`LP_REWARD` or `SPREAD`)
- `PolyParityPlan` (`PARITY` or `SPLIT_MERGE`)

If another agent is building an aggregator API, returning these structures directly (or lightly adapted) is the fastest path.

## Environment configuration

Reference defaults are in `.env.example` (all `POLY_*` vars).

High-impact settings:

- Scope/throughput
  - `POLY_MAX_MARKETS_PER_SCAN`
  - `POLY_SCAN_ORDERBOOK_LIMIT`
  - `POLY_REWARD_ORDERBOOK_LIMIT`
- Lane toggles
  - `POLY_ENABLE_REWARD_LANE`
  - `POLY_ENABLE_SPREAD_LANE`
  - `POLY_ENABLE_PARITY_LANE`
- Reward filters
  - `POLY_MIN_DAILY_REWARD_USD`
  - `POLY_MIN_REWARD_ZONE_CENTS`
- Spread filters
  - `POLY_MIN_SPREAD_CAPTURE_CENTS`
  - `POLY_MIN_SPREAD_VOLUME_USD`
  - `POLY_MIN_SPREAD_DEPTH_USD`
  - `POLY_MIN_SPREAD_ENTRY_MIDPOINT`
  - `POLY_MAX_SPREAD_MIDPOINT`
- Parity filters
  - `POLY_PARITY_MIN_TRADE_USD`
  - `POLY_PARITY_MAX_TRADE_USD`
  - `POLY_PARITY_MIN_DEPTH_USD`
  - `POLY_PARITY_MIN_EDGE_BPS`
  - `POLY_PARITY_SLIPPAGE_CENTS`

## Persistence model (paper mode)

Paper mode state is persisted via the shared Spaces / local FS bot-state store (`src/integrations/storage/botStateStore.ts`) under key:

- `POLY_PAPER_STATE_KEY` (default `poly-paper`)

Object path: `{DO_SPACES_PREFIX}/bot-states/{POLY_PAPER_STATE_KEY}.json` (or the same layout under `BOT_STATE_DATA_DIR`).

Implementation: `src/polymarket/polyPaperStateStore.ts`

Two model states are stored:

- `conservative`
- `balanced`

Each tracks:

- cash
- open orders
- positions by token
- fills / cancellations
- lane metrics (reward/spread/parity)
- realised/unrealised/total PnL

This makes it easy to build comparative dashboards without re-running simulation logic.

## Market lifecycle (no persisted status table)

Scanner filters markets in memory (`isLive && !isResolved && !closed`). There is no `polymarket_market_status` Postgres table.

## Practical integration pattern for the other agent

1. Run `poly:scan` logic as the data ingest backbone.
2. Expose one endpoint per payload group:
   - `/markets` from merged `PolyMarket[]`
   - `/orderbooks` from token maps
   - `/candidates/rewards`, `/candidates/spread`, `/candidates/parity`
3. For paper analytics, read the Spaces/local bot-state JSON for `POLY_PAPER_STATE_KEY`.
4. Keep lane toggles and thresholds in env so tuning does not require code edits.

## Known behavior notes

- If orderbook fetch fails for a token, scanner marks source as `unavailable` rather than throwing.
- `poly:market` lookup accepts `conditionId`, `marketSlug`, `marketId`, or `tokenId`.
- Parity lane is disabled by default (`POLY_ENABLE_PARITY_LANE=false`).
- Rewards and spread lanes are enabled by default.
- Lifecycle derivation is market-level, not endpoint-level:
  - `closed=true` is treated as the strongest ended/resolved signal.
  - `resolved` is used when present, but may be missing from some payloads.
  - `endDate`/`endDateIso` is used as a time-based fallback.
  - Markets derived as non-live are filtered out of active scan outputs.
