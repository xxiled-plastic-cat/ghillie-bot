# Operator preferences (example)

Copy to DigitalOcean Spaces as `{DO_SPACES_PREFIX}/operator-preferences.md`
(default `ghillie-bot/operator-preferences.md`), or to
`config/operator-preferences.md` when Spaces is not configured.

This file is **optional prose strategy** for the plan-review agent (and any
future tools-on research agent). The open-source base prompt stays in
`src/alpha/planReview/prompt.ts`. Structured knobs (`ALPHA_ENABLE_REWARD_LANE`,
size caps, etc.) stay in env.

There is no dedicated prefs env var — loading is by convention (same Spaces
credentials as bot state).

**Host research switch:** a non-empty prefs file also switches the live host
scan (`loadAlphaScan`) off mixed `amarok_list_opportunities` onto lane MCP
tools (`amarok_list_rewards` / `_spreads` / `_parity`, gated by lane env
flags). Missing or empty prefs keep the OSS default: scan + opportunities +
quotes.

---

## Research tools (MCP)

- Do **not** call `amarok_list_opportunities` / `GET /v1/alpha/opportunities`
  (mixed ranking). Prefer dedicated lane endpoints instead.
- Primary research path, in order:
  1. `amarok_list_rewards` → `/v1/alpha/rewards`
  2. `amarok_list_spreads` → `/v1/alpha/spreads`
  3. `amarok_list_parity` → `/v1/alpha/parity` only when parity is enabled
- Use `amarok_get_market` / `amarok_get_quotes` for depth on lane hits.
- Prefer `amarok_get_scan` only when a full book snapshot is required; do not
  treat mixed opportunities as a substitute for lane rankings.

## Strategy bias (edit for your ops)

- Prefer reward-lane entries when the book is two-sided and size fits depth.
- Treat spread-capture as secondary: approve when edge is clear; shrink or
  reject when depth is thin or inventory would strand.
- Be stricter on one-sided books even if the host labeled the quote as reward.

## Risk taste

- Shrink rather than reject when the thesis is sound but notional is large
  versus visible depth.
- Fail closed (reject) when book, expiry, or inventory fields look incomplete.
  Do not invent a size.
- Inventory-exit asks and `ALPHA_MAX_INVENTORY_NOTIONAL_USD` are **host/env**
  gates (see QUICKSTART.md §10). Prefs cannot size exits, skip plan review, or
  override the governor. Plan review never sees inventory exits.
