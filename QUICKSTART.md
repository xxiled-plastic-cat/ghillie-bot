# Operator quickstart

Take a fresh clone to a **dry-run tick**. You only need this file and [`.env.example`](./.env.example).

Dry-run is the default. It does **not** place, cancel, claim, merge, or submit Algorand transactions. It **does** spend **mainnet USDC** (Amarok x402 research) and **ALGO / zs-proxy inference** once the wallet is funded and the proxy is up.

Never commit `.env`, mnemonics, API keys, or payment signatures. `.gitignore` already ignores `.env`.

Developers: [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports: [SECURITY.md](./SECURITY.md). GitHub Actions already runs `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test` on PRs (no live MCP / zs-proxy in CI).

## 1. Clone and install

Node **22** (see `.nvmrc`).

```bash
# Clone this GitHub repository, then inside the checkout:
npm install
cp .env.example .env
```

## 2. Fill `.env` (minimum)

Edit `.env`. Do not paste the mnemonic into chat, issues, or logs.

| Variable | First dry-run tick |
| --- | --- |
| `ALPHA_WALLET_MNEMONIC` | 25-word Algorand mnemonic for a **dedicated hot wallet**. Address is derived if `ALPHA_WALLET_ADDRESS` is empty. Import this **same** mnemonic into zs-proxy. |
| `AMAROK_MCP_URL` | Already `https://amarok-mcp.compx.io/mcp` |
| `MAX_DAILY_X402_BASE_UNITS` | Already `5000000` (5 USDC / day) |
| `ALPHA_ENABLE_LIVE_TRADING` / `ALPHA_CONFIRM_RISK` | Leave **`false`**. `alpha:live` and Docker live cron refuse to start unless both are `true`. |
| `ALPHA_CRON_COMMAND` | Already the dry-run tick (`alpha:live-dry-run`). |
| `ALPHA_API_KEY` | Optional for discovery. Needed for Alpha SDK **wallet open-order sync** on a full dry-run / live tick. |
| DigitalOcean Spaces | Optional. Omit all `DO_SPACES_*` to write state under `BOT_STATE_DATA_DIR` (default `data/bot-states`). Dry-run does not persist **trading** bot-state; Amarok x402 spend counters are still written so `/status` can show daily used. |
| Docker file-keyring passphrase | Required **only** for Docker. Name is in `.env.example`. Local host zs-proxy can use the OS keychain. |

Fund that hot wallet on **Algorand mainnet** before paid steps:

- **USDC** (asset `31566704`) for Amarok x402 micropayments (and later trading collateral).
- **ALGO** for x402 payment fees plus zs-proxy prepaid ticket / MBR pool (`zs-proxy fund` is about 1.15 ALGO for 10 slots).

## 3. Costs (even in dry-run)

| Channel | When it spends | Cap |
| --- | --- | --- |
| **Amarok x402** | Paid MCP tools: scan / opportunities / quotes (and lane lists). **Not** `amarok:discovery`. | `MAX_DAILY_X402_BASE_UNITS` |
| **zs-proxy inference** | Plan-review on reward/spread **entry** quotes during live-dry-run / live. `zs:smoke` also pays. | `config/zs-proxy.yaml` `daily_cap_usdc` / `per_request_cap_usdc` (override `PROXY_SPEND_*`) |
| **ALGO** | x402 payment transactions + zs-proxy `fund` | wallet balance |

`amarok:opportunities`, `amarok:rewards`, `amarok:spreads`, `amarok:parity`, `amarok:execution-dry`, and `zs:smoke` spend mainnet funds. Skip them until you intend to pay. Paper (`alpha:paper`) does not call the proxy and is **not** the dry-run path below.

## 4. Start zs-proxy

LLM calls go **only** through zs-proxy (OpenAI-compatible). No OpenAI/Anthropic fallback. Point `OPENAI_BASE_URL` at local zs-proxy `/v1` (loopback port 8080; see `.env.example`). `OPEN_AI_API_KEY` is a placeholder — admission is the wallet seal. Keep `ALPHA_HEALTH_PORT` (8788) distinct from the proxy (8080). Relay privacy is **off** (`PROXY_ZS_PRIVACY=false`) so inference talks to the model operator directly.

### Local (use this for the first dry-run)

```bash
# macOS:
#   brew install txnlab/tap/zs-proxy
# Linux: same binary the Docker image uses (zs-proxy 0.16.1), e.g.
#   https://github.com/TxnLab/zs-proxy/releases

printf '%s\n' "$ALPHA_WALLET_MNEMONIC" | zs-proxy wallet import --stdin --yes --force
zs-proxy fund --wait
# Must pass config so zs.privacy: false is applied
zs-proxy proxy start --config config/zs-proxy.yaml
```

Confirm zs-proxy `/healthz` on loopback port 8080 before the dry-run tick.

### Docker (cloud / live sidecar)

The image starts zs-proxy on loopback, then **`alpha:cron:live`** (real placement). Do **not** `docker compose up` until live gates are on and you intend to trade. Connectivity smoke (LLM + one paid Amarok research call, no place):

```bash
# .env must include ALPHA_WALLET_MNEMONIC and the Docker file-keyring passphrase
npm run docker:smoke
```

Compose / run details: [README.md](./README.md) (zs-proxy / Docker).

## 5. Free Amarok discovery (no USDC)

Needs network only (`AMAROK_MCP_URL`). No mnemonic, no zs-proxy.

```bash
npm run amarok:discovery
```

Expect JSON for health, discovery, and execution shapes. If this fails, stop — the MCP endpoint is down and later paid calls will fail too.

## 6. One dry-run cron tick

With `.env` filled, the wallet funded, and zs-proxy healthy:

```bash
npm run alpha:cron:live-dry-run -- --once
```

Equivalent single tick without the cron wrapper: `npm run 'alpha:live-dry-run'`.

You should see `GHILLIE ALPHA LIVE DRY RUN` and actions such as `Would place …` / `Would cancel …` (no submit). Research still paid Amarok x402; entry quotes still hit zs-proxy plan-review (fail-closed if the proxy is down). Trading bot-state is **not** written in dry-run. Amarok x402 spend counters **are** updated on bot-state so Telegram `/status` can show today's used + remaining.

## 7. Dry-run cron loop

Default schedule is every 2 minutes (`ALPHA_CRON_SCHEDULE`). Each tick can spend x402 + inference.

```bash
npm run alpha:cron:live-dry-run
```

Health (if `ALPHA_HEALTH_PORT` or `PORT` is set): loopback port 8788, paths `/health` and `/healthz`.

Do **not** run `npm run alpha:cron:live`, `alpha:cron:live:once`, or `docker compose up` until you flip the live gates. Bare `npm run alpha:cron` uses `ALPHA_CRON_COMMAND` from `.env` (dry-run in the example file).

## 8. Telegram (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (leave `TELEGRAM_DISABLE_NOTIFICATIONS=false`). Commands run only on the **long-lived** cron process (not `--once`):

| Command | Effect |
| --- | --- |
| `/help` | List commands |
| `/status` | Cron health, lane status, Amarok x402 daily used + remaining (UTC) |
| `/lanes` | Compact lane on/off |
| `/lane <reward\|spread\|parity> <on\|off\|default>` | Override a lane; applies on the **next** tick (stored in bot-state) |

Outbound tick digests are live-mode only. Dry-run still starts the command loop so you can probe `/status`.

## 9. Going live (not the first run)

1. Set `ALPHA_ENABLE_LIVE_TRADING=true` and `ALPHA_CONFIRM_RISK=true`.
2. Set `ALPHA_CRON_COMMAND` to the live tick (or use `npm run alpha:cron:live`).
3. Docker / App Platform: build the root `Dockerfile`, leave the run command empty (entrypoint is live cron), set the Docker file-keyring passphrase and Spaces credentials. Probe `/health` / `/healthz` on `PORT`.

Public showcase: https://amarok.compx.io/user-agents

## Leftover env cleanup

`.env.example` is Alpha / Amarok / zs-proxy only. If you copied an older Nuckelavee env:

- **Delete** `POLY_*`, Div3rsaFi / `@div3rsafi` knobs, and `DATABASE_URL` (Postgres/Supabase are gone; state is Spaces or local files).
- **Keep** `ALPHA_API_KEY` until Amarok covers remaining Alpha SDK venue ops (wallet open-order sync). It is unused for Amarok research and limit place.
- In-tree `src/polymarket/` and Div3rsaFi client code are legacy; do not configure them for this operator path.

## Command cheat sheet

```bash
npm run amarok:discovery                 # free MCP health / discovery / shapes
npm run 'alpha:live-dry-run'             # one dry-run tick (no cron wrapper)
npm run alpha:cron:live-dry-run -- --once
npm run alpha:cron:live-dry-run          # scheduled dry-run
npm run zs:smoke                         # paid LLM + one Amarok research call
npm run docker:smoke                     # same, inside the image
npm run typecheck && npm test            # CI; does not spend
```
