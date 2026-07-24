# nuckelavee

Alpha Arcade **user-agent**: walleted trading bot that consumes [Amarok](https://amarok.compx.io) over **remote MCP** for research and unsigned limit-order quotes, then signs and submits locally.

Hard boundary: Amarok never holds keys, never signs payments, and never submits orders (`executionSubmitted: false`). This bot owns x402 USDC micropayments, custody, cancel/claim/merge/split venue ops, fills, inventory, and the live loop.

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
DATABASE_URL=
```

`ALPHA_API_KEY` is still used for Alpha SDK **venue ops** Amarok does not expose yet (wallet open-order sync). Research and limit placement go through Amarok MCP with per-call x402 payments from the agent wallet.

## ZeroSignal (zs-proxy)

LLM calls go **only** through host-local [zs-proxy](https://txnlab.gitbook.io/zerosignal/using-the-proxy/quick-start.md) (OpenAI-compatible). No OpenAI/Anthropic fallback.

```bash
# macOS: brew install txnlab/tap/zs-proxy
printf '%s\n' "$ALPHA_WALLET_MNEMONIC" | zs-proxy wallet import --stdin --yes --force
zs-proxy fund --wait
zs-proxy proxy start --config config/zs-proxy.yaml
```

```env
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPEN_AI_API_KEY=zerosignal
OPENAI_MODEL=glm-5.2
OPENAI_REASONING_EFFORT=medium
AI_MODE=full
```

`OPEN_AI_API_KEY` is a placeholder; admission is the on-chain wallet seal. Proxy defaults (`zs.privacy: false`, spend caps) live in [`config/zs-proxy.yaml`](./config/zs-proxy.yaml). Multi-turn agents always set `store: false` and replay conversation client-side (never `previous_response_id`).

Smoke (spends ZeroSignal + one Amarok x402 research call):

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
npm run amarok:opportunities      # paid list (spends USDC)
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

### Dashboard (read-only)

```bash
npm --prefix apps/alpha-dashboard install
npm run alpha:dashboard
```

- API: `http://127.0.0.1:8787`
- Web UI: `http://127.0.0.1:5174`

### Cron

```bash
npm run alpha:cron
npm run alpha:cron:live
npm run alpha:cron:live:once
```

For DigitalOcean App Platform:

```bash
npm run alpha:cron:live
```

Typical App Platform env:

```env
DATABASE_URL=
AMAROK_MCP_URL=https://amarok-mcp.compx.io/mcp
MAX_DAILY_X402_BASE_UNITS=5000000
ALPHA_WALLET_MNEMONIC=
ALPHA_ENABLE_LIVE_TRADING=true
ALPHA_CONFIRM_RISK=true
ALPHA_CRON_SCHEDULE=*/2 * * * *
ALPHA_CRON_COMMAND=npm run alpha:live
```

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

See [docs/development-checklist.md](docs/development-checklist.md) for recommended next steps (Ghillie-bot rename, MIT license, CONTRIBUTING, ZeroSignal LLM with no provider fallback, prompt review, and more).
