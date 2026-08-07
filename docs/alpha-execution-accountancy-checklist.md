# Alpha execution & accountancy checklist

Work top-to-bottom. Do not start a later phase until the prior phase’s **Done when** criteria hold in live-dry-run (and live, once gated).

Scope: **Alpha only** (`src/alpha/`). Quote policy stays as-is unless a checklist item explicitly requires a small wiring change.

Primary files:

- `src/alpha/liveTrader.ts` — wallet sync, fill ledger wiring, inventory sync, reconcile, live tick
- `src/alpha/liveFillLedger.ts` — live fill events, cursor, VWAP apply
- `src/alpha/inventoryView.ts` — canonical `marketAppId` keys, free+escrow snapshot/sync
- `src/alpha/positionAccounting.ts` — shared bid/ask VWAP helpers
- `src/alpha/alphaRiskManager.ts` — net exposure (bids + inventory − ask coverage), inventory governor shared helpers
- `src/alpha/fillTracker.ts` / `src/alpha/pnlTracker.ts` — paper fills & marks
- `src/alpha/capitalLedger.ts` — USDC / reward receipts
- `src/alpha/inventoryMerger.ts` / `src/alpha/resolvedClaimLane.ts` / `src/alpha/parityTrader.ts` — settlement
- `src/alpha/alphaTypes.ts` / `src/alpha/alphaStateStore.ts` — state shape

---

## Phase 1 — Fill ledger

Goal: every share movement is an append-only, idempotent fill event; inventory/VWAP update from fills, not from “order vanished.”

- [x] Define a `LiveFillEvent` (or equivalent) with: escrowAppId, marketAppId, outcome, side, shares, price, source, tx/time, idempotency key
- [x] On wallet order sync, detect `quantityFilled` deltas on **still-open** orders and emit fill events immediately
- [x] On order close (escrow gone), emit remaining fill (if any) or cancel — never treat cancel as fill when share delta ≈ 0
- [x] Prefer trade/receipt price when available; fall back to limit price only as last resort *(place-time `matchedPrice`; resting fills use limit until a trade feed exists)*
- [x] Apply each fill once to shares + VWAP (bid: increase inventory; ask: decrease + realise PnL)
- [x] Stop relying on `inferClosedLiveOrders` as the sole path for inventory updates (keep as fallback only if needed, then remove)
- [x] Persist fill history in bot state (or append log) so digests/dashboard can count real entry/exit fills
- [x] Fix digest string mismatch so live entry fills are counted (`Live entry fill` / `Live exit fill` in `alphaCommands.ts`)

**Done when:** partial fills update cost basis before the order fully closes; cancels do not create phantom fills; restarting the bot does not double-apply the same fill.

_Completed: Phase 1 fill ledger landed (`liveFillLedger.ts`, wired in `liveTrader.ts`)._
---

## Phase 2 — Canonical inventory

Goal: one position key and one inventory view everywhere (risk, exits, merge, claim, quotes).

- [x] Canonical position key = `marketAppId` (stop UUID vs `String(appId)` dual-keying)
- [x] Migrate/dedupe existing `positionsByMarket` entries onto `marketAppId` keys (replace MAX-merge heuristics with a one-time migration + invariant)
- [x] Inventory shares = **free wallet ASA + sell-escrow shares** (reuse `escrowedSellSharesFor` logic as source of truth, not only reconcile diagnostics)
- [x] Never overwrite avg cost to `0` on wallet sync unless that side’s shares are truly gone
- [x] Wire quote exits / inventory audits / merge / claim to the same inventory view
- [x] Assert invariant each tick: bot state shares ≈ free + escrow (within epsilon); log hard mismatches

**Done when:** no duplicate positions for one market; open sell orders do not look like “missing” inventory; exits size against free+escrow correctly.

_Completed: Phase 2 canonical inventory landed (`inventoryView.ts`, rekeyed writers/readers, live free+escrow sync)._

---

## Phase 3 — Risk = real exposure

Goal: live risk gating uses the same exposure definition as paper (and as the inventory governor).

- [x] Live/live-dry-run `getMarketExposure` / `getTotalExposure` include inventory at avg cost (not open bids only)
- [x] Net exposure = open bid notional + inventory cost − coverage already posted as open asks (document the formula)
- [x] Align `ALPHA_MAX_INVENTORY_NOTIONAL_USD` governor with `checkQuoteRisk` (same definition of inventory notional)
- [x] Ask risk continues to block selling more than held free+escrow inventory
- [x] Add a small unit test suite for exposure math (paper vs live parity of definition)

**Done when:** holding inventory without open bids counts toward caps; risk manager and inventory governor cannot disagree on “are we oversized?”

_Completed: Phase 3 net exposure formula + shared inventory notional (`alphaRiskManager.ts`)._

---

## Phase 4 — Safer settlement

Goal: merge / claim / parity cannot invent PnL or leave orphan legs from races.

- [x] Merge only free matched YES/NO sets (never treat escrowed sell legs as mergeable)
- [x] Claim / stale prune: realise PnL only with confirmed resolution; after the prune window, snap ghost inventory to free+escrow without mark write-off when still live (filled outside fill ledger). Closed asks classify fill vs cancel from inventory delta — do not invent PnL on transient API gaps alone
- [x] Keep unaccounted-tick warnings, but raise the bar before mutating realised PnL / deleting positions
- [x] Parity (`parityTrader.ts`): all-or-nothing group **or** explicit residual unwind path; do not `return` mid-queue leaving orphans
- [x] Single close-out path for resolved assets (align `resolvedClaimLane` vs `alphaResolvedAssetCleanup` so they cannot double-count)

**Done when:** dry-run settlement actions match live mutations; no realised PnL spike from transient wallet read failures; parity failures leave a clear unwind, not silent inventory.

---

## Phase 5 — Split ledgers (accountancy)

Goal: digests and dashboard show three independent truths, not one blended number.

- [x] **Trading PnL** — realised from fill ledger + unrealised from marks (`pnlTracker`)
- [x] **Rewards** — on-chain LP receipts only (`capitalLedger` / reward sender scan)
- [x] **Cash / USDC** — wallet free + bid escrow (drop hardcoded initial capital assumptions from trading truth)
- [x] Digest / dashboard: three lines (trading / rewards / cash), plus optional “total economic” as sum with explicit label
- [x] Ensure reward refresh never mutates trading positions or fill history

**Done when:** a fill-only session moves trading PnL without changing rewards; a reward receipt moves rewards without changing trading realised; cash reconciles to wallet within epsilon.

_Completed: Phase 5 split ledgers (`accountancyLedgers.ts`), digests/dashboard/capital report wired to trading/rewards/cash + total economic._

---

## Phase 6 — Paper fidelity

Goal: paper is a rehearsal of live accountancy, not an optimistic parallel universe.

- [ ] Paper cancel / requote / dwell / refresh thresholds share live semantics where possible
- [ ] Paper fills respect book depth (partials), not full remaining size on touch
- [ ] Paper includes free vs escrow distinction if live does (or clearly documents remaining gaps)
- [ ] Avoid order stacking every tick when an equivalent quote already rests
- [ ] Regression: same scenario produces comparable inventory/VWAP trajectory in paper vs live-dry-run (allowing for no chain latency)

**Done when:** you would trust paper results enough to tune thresholds without immediately invalidating them on first live-dry-run.

---

## Working notes

- Prefer small PRs per phase; land Phase 1–2 before touching quote thresholds or AI/decision changes.
- Keep `ALPHA_ENABLE_LIVE_TRADING` / `ALPHA_CONFIRM_RISK` gates unchanged until Phase 3 **Done when** is met.
- When a checkbox is done, mark it and add a one-line note (PR / date) under the phase if useful.
