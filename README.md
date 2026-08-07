# Ghillie-bot

Formerly **Nuckelavee**. Alpha Arcade **user-agent**: walleted trading bot that consumes [Amarok](https://amarok.compx.io) over **remote MCP** for research and unsigned limit-order quotes, then signs and submits locally.

Hard boundary: Amarok never holds keys, never signs payments, and never submits orders (`executionSubmitted: false`). This bot owns x402 USDC micropayments, custody, cancel/claim/merge/split venue ops, fills, inventory, and the live loop.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, PR checks, and conduct. Report security issues privately per [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE). Production dependencies are MIT-compatible (MIT, Apache-2.0, ISC, BSD, Unlicense); no GPL/AGPL in the production tree.

## Install

```bash
npm install
cp .env.example .env
```

Required for Amarok-backed Alpha:

```env
AMAROK_MCP_URL=https://amarok-mcp.compx.io/mcp
MAX_DAILY_X402_BASE_UNITS=5000000
ALPHA_WALLET_MNEMONIC="word1 ... word25"
ALPHA_ENABLE_LIVE_TRADING=true
ALPHA_CONFIRM_RISK=true
# Bot state: DigitalOcean Spaces (preferred) or local FS fallback
DO_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
DO_SPACES_BUCKET=
DO_SPACES_KEY=
DO_SPACES_SECRET=
```

### Bot state (Spaces)

Alpha PnL / positions / orders live in a JSON object on DigitalOcean Spaces (same pattern as brownie-bot), key `{DO_SPACES_PREFIX}/bot-states/{ALPHA_STATE_KEY}.json` (default `ghillie-bot/bot-states/alpha.json`). If Spaces env is omitted, state is written under `BOT_STATE_DATA_DIR` (default `data/bot-states`) with the same key layout. Polymarket paper state uses the same store under `POLY_PAPER_STATE_KEY` (default `poly-paper`).

Optional plan-review **operator preferences** load from `{DO_SPACES_PREFIX}/operator-preferences.md`, or `config/operator-preferences.md` when Spaces is unset — see [`config/operator-preferences.example.md`](./config/operator-preferences.example.md). Non-empty prefs also switch the live host research path from mixed `amarok_list_opportunities` onto lane MCP tools (`rewards` / `spreads` / `parity`). Missing prefs keep the OSS default (scan + opportunities + quotes) and leave the base plan-review prompt unchanged.

No Postgres / Supabase is required.

### Public PnL showcase

After live ticks (and when the dashboard snapshot builder runs), Ghillie publishes a **redacted** public accounting JSON to `{DO_SPACES_PREFIX}/public/pnl.json` with object ACL `public-read` (locally: `{BOT_STATE_DATA_DIR}/{prefix}/public/pnl.json`). Private bot-state remains unlisted.

Point Amarok’s website at the CDN URL:

```env
PUBLIC_GHILLIE_ACCOUNTING_URL=https://{bucket}.{region}.cdn.digitaloceanspaces.com/{DO_SPACES_PREFIX}/public/pnl.json
```

Public portfolio (positions / orders / balances) is served by Amarok free route `GET /public/agents/ghillie/portfolio`. The operator-facing page is https://amarok.compx.io/user-agents.

`ALPHA_API_KEY` is still used for Alpha SDK **venue ops** Amarok does not expose yet (wallet open-order sync). Research and limit placement go through Amarok MCP with per-call x402 payments from the agent wallet.

## ZeroSignal (zs-proxy)

LLM calls go **only** through [zs-proxy](https://txnlab.gitbook.io/zerosignal/using-the-proxy/quick-start.md) (OpenAI-compatible). No OpenAI/Anthropic fallback. Cloud/Docker bundles **zs-proxy 0.13.2** as an in-container sidecar; local Node needs a host install.

### Docker (recommended for cloud)

The image starts zs-proxy on loopback, then runs `npm run alpha:cron:live`. Set the usual bot env vars plus a keystore passphrase (file backend — no OS keychain in containers):

```bash
cp .env.example .env
# set ALPHA_WALLET_MNEMONIC, DO_SPACES_*, ZEROSIGNAL_KEYSTORE_PASSPHRASE, …
docker compose up -d --build
# or:
npm run docker:build
docker run --rm --env-file .env \
  -e ZEROSIGNAL_KEYSTORE_PASSPHRASE='long-random-secret' \
  -p 8788:8788 \
  ghillie-bot
```

`docker/entrypoint.sh` imports `ALPHA_WALLET_MNEMONIC` into zs-proxy, runs `zs-proxy fund`, waits for `/healthz`, then starts the cron worker. Spend caps default from [`config/zs-proxy.yaml`](./config/zs-proxy.yaml) (override with `PROXY_SPEND_*`). Relay privacy defaults **off** (`zs.privacy: false` + `PROXY_ZS_PRIVACY=false`; override with `PROXY_ZS_PRIVACY=true`) so inference talks straight to the model operator and skips flaky `*.belt.algo.xyz` hops.

```bash
# Safe connectivity smoke (LLM + one Amarok research call)
npm run docker:smoke
# or: docker run --rm --env-file .env ghillie-bot smoke

# One live cron tick
npm run docker:once
```

### Local host zs-proxy

```bash
# macOS: brew install txnlab/tap/zs-proxy
printf '%s\n' "$ALPHA_WALLET_MNEMONIC" | zs-proxy wallet import --stdin --yes --force
zs-proxy fund --wait
# Must pass config so zs.privacy: false (no relay) is applied
zs-proxy proxy start --config config/zs-proxy.yaml
```

Transport privacy defaults to **off** (`zs.privacy: false`) so calls go direct to the model operator. To re-enable relays: `PROXY_ZS_PRIVACY=true` or set `zs.privacy: true` in the config.

```env
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPEN_AI_API_KEY=zerosignal
OPENAI_MODEL=glm-5.2
OPENAI_REASONING_EFFORT=medium
PROXY_ZS_PRIVACY=false
AI_MODE=lite
```

`OPEN_AI_API_KEY` is a placeholder; admission is the on-chain wallet seal. Multi-turn agents always set `store: false`, use **`stream: true`** (drained to `response.completed` so zs-proxy read timeouts do not kill slow inference), and replay conversation client-side (never `previous_response_id`).

Smoke (spends ZeroSignal + one Amarok x402 research call; host zs-proxy must already be running):

```bash
npm run zs:smoke
```

### Expected spend

| Channel | What you pay |
| --- | --- |
| **Amarok x402** | Mainnet USDC per paid MCP tool (`MAX_DAILY_X402_BASE_UNITS`) |
| **ZeroSignal** | Pay-per-message via zs-proxy (`daily_cap_usdc` / `per_request_cap_usdc`) |
| **ALGO fees** | Network fees for x402 payment txns + zs-proxy prepaid ticket / MBR pool |

## Amarok MCP smoke

```bash
npm run amarok:discovery          # free health / discovery / shapes
npm run amarok:opportunities      # paid mixed list (spends USDC)
npm run amarok:rewards            # paid ranked LP rewards (spends USDC)
npm run amarok:spreads            # paid ranked maker/spreads (spends USDC)
npm run amarok:parity             # paid ranked YES+NO parity (spends USDC)
npm run amarok:execution-dry -- --market <marketAppId>
npm run amarok:execution-dry -- --market <marketAppId> --submit
```

## Alpha commands

```bash
npm run alpha:scan
npm run alpha:rewards
npm run alpha:market -- <slug-or-app-id>
npm run alpha:paper
npm run alpha:paper-report
npm run alpha:live-dry-run
npm run alpha:live
npm run typecheck
npm test
```

`ghillie:*` aliases (`ghillie:live`, `ghillie:cron:live`, `ghillie:dashboard`, …) wrap the same `alpha:*` scripts; `alpha:*` remains canonical.

### Dashboard (deprecated)

The local Vite ops dashboard is **deprecated**. Use the public Ghillie showcase on Amarok instead: https://amarok.compx.io/user-agents

`npm run alpha:dashboard` remains available for operators short-term (API `http://127.0.0.1:8787`, UI `http://127.0.0.1:5174`) but should not receive new features.

### Cron

```bash
npm run alpha:cron
npm run alpha:cron:live
npm run alpha:cron:live:once
```

For DigitalOcean App Platform: build from the root `Dockerfile`, leave the run command empty (entrypoint defaults to `alpha:cron:live`), and set:

```env
DO_SPACES_ENDPOINT=https://nyc3.digitaloceanspaces.com
DO_SPACES_BUCKET=
DO_SPACES_KEY=
DO_SPACES_SECRET=
DO_SPACES_PREFIX=ghillie-bot
AMAROK_MCP_URL=https://amarok-mcp.compx.io/mcp
MAX_DAILY_X402_BASE_UNITS=5000000
ALPHA_WALLET_MNEMONIC=
ZEROSIGNAL_KEYSTORE_PASSPHRASE=
ALPHA_ENABLE_LIVE_TRADING=true
ALPHA_CONFIRM_RISK=true
ALPHA_CRON_SCHEDULE=*/2 * * * *
ALPHA_CRON_COMMAND=npm run alpha:live
```

App Platform sets `PORT` for readiness probes (cron health on `/health` / `/healthz`).

## Architecture

```
live / scan tick
  → Amarok MCP (amarok_get_scan / opportunities / quotes) with x402 paymentSignature
  → local quoteEngine + risk / inventory
  → place: amarok_get_execution_quote → sign unsignedTxnsBase64 → algod sendRawTransaction
  → cancel / claim / merge / split / wallet orders: @alpha-arcade/sdk (venue ops Amarok does not expose yet)
```

Integration code lives under `src/integrations/amarok/` (MCP client + x402 payment builder), `src/integrations/zerosignal/` (zs-proxy OpenAI client + tool loop), and `src/integrations/algorand/submitUnsigned.ts`.

## Operator notes

- Delete obsolete Div3rsaFi / `POLY_*` knobs if unused. Keep `ALPHA_API_KEY` for Alpha SDK wallet-order sync until Amarok covers venue ops.
- Use a dedicated hot wallet with USDC for x402 + trading collateral and ALGO for fees (and zs-proxy prepaid ticket / MBR).
- The mnemonic is never sent to Amarok, Telegram, logs, or the model; import the same mnemonic into zs-proxy for inference.

## Roadmap

See [docs/development-checklist.md](docs/development-checklist.md) for recommended next steps (prompt review, Amarok hardening, lint/CI, and more).
