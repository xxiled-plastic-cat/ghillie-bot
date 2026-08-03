# Alpha API + state handoff for aggregator/dashboard agents

Practical handoff for building an Alpha-focused aggregator/dashboard from this repo.

## 1) How to query Alpha API in this project

This project wraps the Alpha SDK in `src/alpha/alphaClient.ts` via `AlphaSdkClient`. Live research scans go through Amarok MCP (`loadAlphaScan()` in `src/alpha/alphaMarketScanner.ts`).

### Preferred query flow (market aggregation)

1. Load config with `readAlphaConfig()` from `src/alpha/alphaConfig.ts`.
2. Instantiate client:
   - `const client = new AlphaSdkClient(config, false)` for read-only/dashboard use.
3. Fetch markets:
   - `client.getLiveMarkets()` for all live markets.
   - `client.getRewardMarkets()` for reward-focused markets.
4. Merge/dedupe by `marketAppId` (project convention).
5. Fetch orderbooks per market with bounded concurrency (see `loadAlphaScan()` / Amarok adapters).
6. Derive lifecycle from live API fields + on-chain status (`getMarketResolution` / orderbook `source: "unavailable"`). There is **no** persisted market-status table.

### Key SDK wrapper methods

- `getLiveMarkets()`: live market metadata (flattened for multi-option markets).
- `getRewardMarkets()`: reward metadata where available.
- `getMarket(marketIdOrSlug)`: local lookup helper from live markets.
- `getOrderbook(market)`: on-chain orderbook + chain-status guard.
- `getPositions(walletAddress)`: wallet positions.
- `getWalletOpenOrders(walletAddress)`: wallet open orders.
- `getUsdcBalance(walletAddress)` / `getAlgoBalance(walletAddress)`: balances.

### Data normalization rules already implemented

The wrapper normalizes all Alpha microunits so downstream code can use decimals:

- Price: `1_000_000 => 1.00`, `500_000 => 0.50`
- Quantity: `1_000_000 => 1 share`
- Market/reward numeric fields are normalized with heuristics (e.g. `totalRewards`, `volume`, spread cents).

Use wrapper outputs (`AlphaMarket`, `AlphaOrderbook`) and avoid re-decoding raw SDK payloads in dashboard code.

### Important market identity mapping

- Canonical trade key in this project: `marketAppId` (number)
- Also available:
  - `id` (Alpha market/option id string)
  - `slug` (useful for routing and UX)

For aggregation joins, key by `marketAppId` first, then enrich with `id`/`slug`.

### Orderbook reliability behavior

`getOrderbook()` checks on-chain app state first and returns `source: "unavailable"` when market is resolved/inactive.
Do not treat unavailable books as errors; treat them as lifecycle events.

### Ready-to-copy TypeScript query skeleton

```ts
import { readAlphaConfig } from "../src/alpha/alphaConfig.js";
import { AlphaSdkClient } from "../src/alpha/alphaClient.js";

const config = readAlphaConfig();
const client = new AlphaSdkClient(config, false);

const live = await client.getLiveMarkets();
const reward = await client.getRewardMarkets().catch(() => []);

const byAppId = new Map<number, (typeof live)[number]>();
for (const m of [...live, ...reward]) byAppId.set(m.marketAppId, m);
const markets = [...byAppId.values()];

const books = new Map<number, Awaited<ReturnType<typeof client.getOrderbook>>>();
await Promise.all(
  markets.map(async (m) => {
    books.set(m.marketAppId, await client.getOrderbook(m));
  }),
);
```

## 2) Bot state (Spaces / local FS — not Postgres)

This project does **not** use Supabase/Postgres. Alpha bot state (`loadAlphaState` / `saveAlphaState`) persists via `src/integrations/storage/botStateStore.ts`:

- DigitalOcean Spaces when `DO_SPACES_*` are set
- Local filesystem under `BOT_STATE_DATA_DIR` otherwise

Object key: `{DO_SPACES_PREFIX}/bot-states/{ALPHA_STATE_KEY}.json` (default `ghillie-bot/bot-states/alpha.json`).

### Alpha JSON shape

From `AlphaBotState` (`src/alpha/alphaTypes.ts`), useful dashboard fields include:

- Top-level financials:
  - `startingBalance`, `cash`, `realisedPnl`, `unrealisedPnl`, `totalPnl`
  - `estimatedRewardsUsd`, `rewardEligibleSeconds`
- Orders/positions:
  - `openOrders[]`, `positionsByMarket{}`, `fills[]`, `cancelledOrders[]`
- Market-level stats:
  - `estimatedRewardsByMarket{}`
  - `spreadStatsByMarket{}`
  - `parityAttempts[]`
- Operational stats:
  - `strategyStats.*` (ticks, liveOrdersPlaced/cancelled, spread/parity stats)
- Timestamp:
  - `lastUpdated`

Read via `loadAlphaState()` or the dashboard API (`npm run alpha:dashboard`).

## 3) Practical dashboard build notes

- For market cards:
  - combine live markets + reward markets
  - attach current orderbook snapshot and on-chain lifecycle status
- For wallet view:
  - use live Alpha API calls (`getPositions`, `getWalletOpenOrders`, balances)
  - do not rely on bot state alone for wallet truth
- For bot-ops view:
  - use Spaces/local bot state JSON + live API/chain status
- Treat `reward` fields as optional:
  - `dailyRewardsUsd`, `maxRewardSpreadCents`, `minContracts`, etc. can be missing
  - render unknown gracefully instead of coercing to zero
