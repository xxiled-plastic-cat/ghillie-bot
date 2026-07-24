# Ghillie / Nuckelavee — development checklist

Post–Amarok-MCP cutover checklist and recommended next steps for the Alpha Arcade user-agent (current package name: `nuckelavee`). Treat this as the working roadmap; check items off as they land.

**Status key:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## Done (Amarok MCP user-agent foundation)

- [x] Remote Amarok MCP client (`src/integrations/amarok/`) — Streamable HTTP, `callManagedTool`, local x402 `paymentSignature`
- [x] Research path via Amarok only (`amarok_get_scan` / opportunities / quotes / market)
- [x] Limit place via `amarok_get_execution_quote` → local sign/submit (`unsignedTxnsBase64`)
- [x] Alpha SDK retained only for venue ops Amarok does not expose (cancel / claim / merge / split / wallet orders)
- [x] `.env.example` slimmed to Alpha / Amarok only (Div3rsaFi + Polymarket env sections removed)
- [x] Smoke CLIs: `amarok:discovery`, `amarok:opportunities`, `amarok:execution-dry`
- [x] Unit tests for payment guardrails + adapters

---

## Recommended next steps

### 1. ZeroSignal for LLM calls (no fallback)

Wire inference the same way [brownie-bot](https://github.com/compx-labs) does: **ZeroSignal via zs-proxy only**. Do not add OpenAI / Anthropic / other HTTP fallbacks.

- [x] Add zs-proxy config (`config/zs-proxy.yaml`) using the **same** `ALPHA_WALLET_MNEMONIC` as x402 / execution
- [x] Env: `OPENAI_BASE_URL` → zs-proxy (`http://127.0.0.1:8080/v1` locally), `OPEN_AI_API_KEY` placeholder, model + reasoning effort knobs
- [x] Client / tool loop calls the OpenAI-compatible client **only** through that base URL (`src/integrations/zerosignal/`)
- [x] Fail closed if zs-proxy is down (`assertZsProxyHealthy`); no silent provider switch
- [x] Document expected ZeroSignal + Amarok x402 spend (README)
- [x] `AI_MODE` env shape: `full` (tool loop) vs `lite` (host-prefetch + decide-only); research tools only for the model; `amarok_get_execution_quote` host-only
- [ ] Wire a decide / review agent into the Alpha live loop using the zs-proxy client
- [ ] Optional Docker sidecar entrypoint (bundle zs-proxy like brownie) when cloud deploy needs it
- [x] Smoke: `npm run zs:smoke` (ZeroSignal + one paid Amarok research tool)
- [x] Tests assert `store: false` and absent `previous_response_id` on first and follow-up calls

### 2. Naming update → **Ghillie-bot**

Public / package identity should move from legacy `nuckelavee` to **Ghillie-bot** (or `ghillie-bot`).

- [ ] Rename npm package (`package.json` `name`)
- [ ] Update README title, badges, clone URLs, DigitalOcean / deploy docs
- [ ] Rename GitHub repo (or add redirect) when ready; update remote references
- [ ] Sweep code comments, log prefixes (`[alpha-live]` → product-consistent tags), dashboard title
- [ ] CLI / binary naming if any (`ghillie:*` aliases alongside or instead of `alpha:*` / `amarok:*` as appropriate)
- [ ] State keys / Docker image names / cron command strings in deploy configs
- [ ] Keep a short “formerly Nuckelavee” note in README for one release cycle

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
- [ ] Confirm third-party deps’ licenses are compatible before publish

### 5. Prompt review

Before shipping any LLM decide / research agent:

- [ ] Inventory every system / developer / tool prompt (once ZeroSignal agent lands)
- [ ] Review for: custody boundaries (no mnemonic / `paymentSignature` / execution tools in model context)
- [ ] Review for: Alpha market risk language (not financial advice; fail-closed on incomplete data)
- [ ] Align tool allowlists with Amarok: research tools yes; `amarok_get_execution_quote` host-only
- [x] Strip wallet / payment fields from MCP schemas shown to the model (`prepareAgentTools`)
- [ ] Add golden / fixture tests for prompt + tool schema sanitization where practical (beyond unit coverage in `zerosignal.test.ts`)
- [ ] Document prompt ownership (which file is canonical) in CONTRIBUTING or `docs/prompts.md`

### 6. Amarok / MCP hardening

- [~] Confirm remote MCP worker health (`amarok_health` / discovery) after CF Worker illegal-invocation fix
  - Root cause: unbound `fetch` in Workers (`Illegal invocation`)
  - Fix landed locally in `amarok` (`mcp/src/lib/x402-client.ts` + `mcp-worker/src/index.ts`) — **needs `npm run mcp:worker:deploy`**
- [ ] End-to-end paid smoke: opportunities → paymentSignature → data (small spend wallet)
- [ ] End-to-end place dry-run then one gated live limit via Amarok + algod
- [ ] When Amarok adds cancel / claim / merge / split shapes, retire remaining Alpha SDK venue-ops usage
- [ ] Revisit parity lane only if Amarok (or local builders) can support required legs

### 7. Repo hygiene & DX

- [ ] Operator `.env` cleanup guide (delete `ALPHA_API_KEY`, Div3rsaFi / `POLY_*` leftovers)
- [ ] Add `eslint` + `prettier` (or Biome) and wire into CI
- [ ] GitHub Actions: typecheck + unit tests on PR (no live paid MCP in CI)
- [ ] `QUICKSTART.md` for operators (env, dry-run, cron, Telegram, costs)
- [ ] Decide fate of in-tree Div3rsaFi / Polymarket **code** (leave legacy, archive folder, or remove in a follow-up — env template already ignores them)
- [ ] Dashboard branding pass for Ghillie

### 8. Product / trading follow-ups

- [ ] Optional: consume Amarok suggested quotes more directly in `quoteEngine` (less local rediscovery)
- [ ] Inventory-exit and risk governor docs for open-source operators
- [ ] Telegram report copy updated for Amarok x402 spend totals (like brownie Canix payment lines)
- [ ] Paper mode vs live mode clarity once an LLM agent exists (paper must not spend x402 unintentionally — or document that research still pays)

---

## Suggested order

1. MIT `LICENSE` + `package.json` license field (cheap, unblocks OSS posture)
2. `CONTRIBUTING.md` + README open-source section
3. Amarok MCP worker + e2e smoke (unblocks confidence in the current cutover)
4. Naming → Ghillie-bot (do early enough that ZeroSignal docs don’t say “nuckelavee”)
5. ZeroSignal / zs-proxy agent path (no provider fallback)
6. Prompt review + schema sanitization tests
7. Lint/CI/QUICKSTART polish

---

## Out of scope for this checklist

- Changing Amarok server / Caddy / facilitator (separate repo)
- Porting brownie Folks / protocol-verify suites wholesale
- Re-adding Div3rsaFi or Polymarket as first-class products in `.env.example`
