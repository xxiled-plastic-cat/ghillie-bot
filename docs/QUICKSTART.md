# Ghillie-bot quick start

Operator-focused path for a local dry-run against Amarok. For full architecture and Docker, see [README.md](./README.md).

## 1. Setup

```bash
npm install
cp .env.example .env
```

Set at least:

```env
AMAROK_MCP_URL=https://amarok-mcp.compx.io/mcp
ALPHA_WALLET_MNEMONIC="…25 words…"
MAX_DAILY_X402_BASE_UNITS=5000000
```

Use a dedicated small-spend hot wallet with mainnet USDC (x402) and ALGO (fees). Never commit `.env`.

## 2. Free connectivity

```bash
npm run amarok:discovery
```

Fail-closed: if MCP initialize or origin `/health` / `/discovery` is down, stop — do not run paid smoke.

## 3. Gated paid / place e2e smoke

```bash
# Dry-run (default): discovery → opportunities → unsigned quote → decode sign path
npm run amarok:e2e-smoke
```

Expected USDC cost (x402, from Amarok discovery):

| Call | ≤ micro-USDC | ≤ USDC |
| --- | ---: | ---: |
| opportunities | 5_000 | 0.005 |
| execution quote | 10_000 | 0.01 |
| **dry-run total** | **15_000** | **≈ 0.015** |

Plus ALGO fees for the two payment transactions. Dry-run does **not** submit a limit order.

### Live place (gated, not CI)

```bash
GHILLIE_E2E_LIVE=1 npm run amarok:e2e-smoke -- --submit
# or pin a market:
GHILLIE_E2E_LIVE=1 npm run amarok:e2e-smoke -- --market <marketAppId> --submit
```

`GHILLIE_E2E_LIVE` defaults **off**. The script refuses to spend when `GITHUB_ACTIONS=true`.

## 4. Related smokes

| Command | Spends | Places |
| --- | --- | --- |
| `npm run amarok:discovery` | no | no |
| `npm run amarok:e2e-smoke` | ~0.015 USDC x402 | no (unless gated live) |
| `npm run amarok:execution-dry -- --market …` | execution-quote x402 | only with `--submit` |
| `npm run zs:smoke` | ZeroSignal + one research x402 | no |

## 5. Checks before a PR

```bash
npm run typecheck
npm test
```

Unit tests mock paid paths and should not spend. Do not run `amarok:e2e-smoke` from CI.
