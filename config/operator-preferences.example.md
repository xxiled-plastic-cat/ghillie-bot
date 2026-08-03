# Operator preferences (example)

Copy to DigitalOcean Spaces as `{DO_SPACES_PREFIX}/operator-preferences.md`
(default `ghillie-bot/operator-preferences.md`), or to
`config/operator-preferences.md` when Spaces is not configured.

This file is **optional prose strategy** for the plan-review agent. The
open-source base prompt stays in `src/alpha/planReview/prompt.ts`. Structured
knobs (`ALPHA_ENABLE_REWARD_LANE`, size caps, etc.) stay in env.

There is no dedicated prefs env var — loading is by convention (same Spaces
credentials as bot state).

---

## Strategy bias (edit for your ops)

- Prefer reward-lane entries when the book is two-sided and size fits depth.
- Treat spread-capture as secondary: approve when edge is clear; shrink or
  reject when depth is thin or inventory would strand.
- Be stricter on one-sided books even if the host labeled the quote as reward.

## Risk taste

- Shrink rather than reject when the thesis is sound but notional is large
  versus visible depth.
- Fail closed (reject) when book or inventory fields look incomplete.
