# Ghillie-bot — development checklist

Working roadmap for the Alpha Arcade user-agent (**Ghillie-bot**, formerly Nuckelavee). Check items off as they land.

**Status key:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## Done

### Amarok MCP user-agent foundation

- [x] Remote Amarok MCP client (`src/integrations/amarok/`) — Streamable HTTP, `callManagedTool`, local x402 `paymentSignature`
- [x] Research path via Amarok only (`amarok_get_scan` / opportunities / quotes / market)
- [x] Limit place via `amarok_get_execution_quote` → local sign/submit (`unsignedTxnsBase64`)
- [x] Alpha SDK retained only for venue ops Amarok does not expose (cancel / claim / merge / split / wallet orders)
- [x] `.env.example` slimmed to Alpha / Amarok only (Div3rsaFi + Polymarket env sections removed)
- [x] Smoke CLIs: `amarok:discovery`, `amarok:opportunities`, `amarok:execution-dry`
- [x] Unit tests for payment guardrails + adapters

### ZeroSignal / zs-proxy (infra)

Wire inference like [brownie-bot](https://github.com/compx-labs): **ZeroSignal via zs-proxy only**. No OpenAI / Anthropic / other HTTP fallbacks.

- [x] zs-proxy config (`config/zs-proxy.yaml`) using the **same** `ALPHA_WALLET_MNEMONIC` as x402 / execution
- [x] Env: `OPENAI_BASE_URL` → zs-proxy (`http://127.0.0.1:8080/v1`), `OPEN_AI_API_KEY` placeholder, model + reasoning effort knobs
- [x] Client / tool loop only through that base URL (`src/integrations/zerosignal/`)
- [x] Fail closed if zs-proxy is down (`assertZsProxyHealthy`); no silent provider switch
- [x] Document expected ZeroSignal + Amarok x402 spend (README)
- [x] `AI_MODE` env shape: `full` (tool loop) vs `lite` (host-prefetch + decide-only); research tools only for the model; `amarok_get_execution_quote` host-only
- [x] Docker sidecar: image bundles **zs-proxy 0.13.2**, entrypoint imports wallet / funds / starts proxy, then `alpha:cron:live` (`Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`)
- [x] Smoke: `npm run zs:smoke` / `npm run docker:smoke`
- [x] Tests assert `store: false` and absent `previous_response_id` on first and follow-up calls
- [x] Strip wallet / payment fields from MCP schemas shown to the model (`prepareAgentTools`)

### Naming → Ghillie-bot

- [x] Node project name in `package.json` / lockfile → `ghillie-bot` (app identity only — not published to the npm registry)
- [x] README title + “formerly Nuckelavee” note; DigitalOcean / Docker deploy docs
- [x] Docker image / compose service → `ghillie-bot` / `ghillie-bot:local`
- [x] Leave `ALPHA_STATE_KEY` unchanged (renaming would orphan existing DB state)

---

## Recommended next steps

### 0. Persistence — market status off Postgres, then drop Supabase

Alpha **bot state** is on DigitalOcean Spaces (or local FS fallback). Remaining Postgres usage:

- [x] Move `alpha_market_status` (and polymarket market-status if still used) off Postgres — dropped entirely (in-memory Amarok/API filters only); no Spaces market-status cache
- [x] Remove Supabase/Postgres from the project: `DATABASE_URL`, Drizzle `bot_states` / market-status schema + migrations, `src/db.ts` callers; poly paper state now uses Spaces/local `botStateStore`
- [x] Confirm DO deploy no longer needs a Supabase pooler URL (operator: drop `DATABASE_URL` from App Platform env; delete remote tables out of band)

### 1. ZeroSignal agent in the live loop

- [x] Wire a decide / review agent into the Alpha live loop using the zs-proxy client
  - Host plans quotes; model vetoes/shrinks **reward/spread entry** bids only (`src/alpha/planReview/`)
  - Canonical system prompt: [`src/alpha/planReview/prompt.ts`](../src/alpha/planReview/prompt.ts)
  - Optional operator preferences (Spaces `{prefix}/operator-preferences.md` or local `config/operator-preferences.md`) appended at runtime; OS base prompt stays generic
  - Gate: `ALPHA_ENABLE_PLAN_REVIEW` (default false). Fail closed on entries; exits still place.
  - Always tools-off single Responses call (`store: false`); no Amarok tools on the cron place path
- [x] Paper vs live clarity: paper trader is unwired (no ZeroSignal spend). Live / live-dry-run call review only when the flag is on and entry quotes remain in the placement queue.

### 2. Naming leftovers

- [ ] Rename GitHub repo (or add redirect) when ready; update remote references
- [ ] Sweep code comments, log prefixes (`[alpha-live]` → product-consistent tags), dashboard title / branding
- [ ] Optional: `ghillie:*` script aliases alongside `alpha:*` / `amarok:*`

### 3. Contribution guide (open source)

- [ ] Add root [`CONTRIBUTING.md`](./CONTRIBUTING.md) (use brownie’s guide as a template)
- [ ] Cover: Node version, `npm install`, `.env.example`, dry-run defaults, never commit secrets
- [ ] PR checklist: `npm run typecheck`, `npm test`, format/lint once those exist
- [ ] Paid-call warning: Amarok x402 spends **mainnet USDC**; prefer unit tests over live MCP in CI
- [ ] Code of conduct link or short conduct section if publishing under an org
- [ ] Issue / PR templates (bug, feature, security contact)

### 4. MIT license

- [ ] Add root `LICENSE` with MIT text and copyright holder (e.g. Neon Forge Ltd / CompX)
- [ ] Set `"license": "MIT"` in `package.json` (currently `ISC`)
- [ ] Mention license in README
- [ ] Confirm third-party deps’ licenses are compatible

### 5. Prompt review

Before shipping any LLM decide / research agent:

- [x] Inventory every system / developer / tool prompt — plan review: [`src/alpha/planReview/prompt.ts`](../src/alpha/planReview/prompt.ts); zs smoke: [`src/cli/zsSmoke.ts`](../src/cli/zsSmoke.ts)
- [x] Review for: custody boundaries (no mnemonic / `paymentSignature` / execution tools in model context) — plan review payload is host-built quotes/books only; `amarok_get_execution_quote` stays host-only
- [ ] Review for: Alpha market risk language (not financial advice; fail-closed on incomplete data)
- [x] Align tool allowlists with Amarok: research tools yes; `amarok_get_execution_quote` host-only — plan-review path uses **no** tools
- [x] Add golden / fixture tests for prompt + tool schema sanitization where practical (`planReview.test.ts`, `zerosignal.test.ts`)
- [x] Document prompt ownership (which file is canonical) — plan review base prompt lives in `src/alpha/planReview/prompt.ts`; optional operator prefs via Spaces/local markdown (brownie pattern)

### 6. Amarok / MCP hardening

- [x] CF Worker `Illegal invocation` fix deployed (`fetch.bind` on Worker + x402 client) — MCP `initialize` healthy at `https://amarok-mcp.compx.io/mcp`
- [~] Remote paid/free tool path still depends on Amarok API origin health (recent probes saw **Cloudflare 522** from API/`/discovery`, not Worker Illegal invocation)
- [ ] End-to-end paid smoke: opportunities → paymentSignature → data (small spend wallet) once API origin is stable
- [ ] End-to-end place dry-run then one gated live limit via Amarok + algod
- [ ] When Amarok adds cancel / claim / merge / split shapes, retire remaining Alpha SDK venue-ops usage
- [ ] Revisit parity lane only if Amarok (or local builders) can support required legs

### 7. Repo hygiene & DX

- [ ] Operator `.env` cleanup guide (delete unused `ALPHA_API_KEY` / Div3rsaFi / `POLY_*` leftovers if not needed)
- [ ] Add `eslint` + `prettier` (or Biome) and wire into CI
- [ ] GitHub Actions: typecheck + unit tests on PR (no live paid MCP in CI)
- [ ] `QUICKSTART.md` for operators (env, Docker, dry-run, cron, Telegram, costs)
- [ ] Decide fate of in-tree Div3rsaFi / Polymarket **code** (leave legacy, archive folder, or remove — env template already ignores them)

### 8. Product / trading follow-ups

- [ ] Optional: consume Amarok suggested quotes more directly in `quoteEngine` (less local rediscovery)
- [ ] Inventory-exit and risk governor docs for open-source operators
- [ ] Telegram report copy updated for Amarok x402 spend totals (like brownie Canix payment lines)

---

## Suggested order

1. Stabilize Amarok API origin (522s) + e2e paid/place smoke
2. ~~Wire ZeroSignal decide / review into the live loop~~ (done — enable `ALPHA_ENABLE_PLAN_REVIEW`)
3. Finish remaining prompt review notes (risk language) if shipping publicly
4. MIT `LICENSE` + `CONTRIBUTING.md` + README OSS section
5. Naming leftovers (GitHub rename, log prefixes, dashboard branding)
6. Lint / CI / `QUICKSTART.md` polish

---

## Out of scope for this checklist

- Changing Amarok server / Caddy / facilitator (separate repo)
- Porting brownie Folks / protocol-verify suites wholesale
- Re-adding Div3rsaFi or Polymarket as first-class products in `.env.example`
- Publishing this app to the npm registry
