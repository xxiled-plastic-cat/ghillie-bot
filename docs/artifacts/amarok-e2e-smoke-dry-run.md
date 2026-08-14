# Amarok e2e smoke — dry-run evidence (NEO-23)

Redacted operator log. **No mnemonics / payment signatures.**

## Verified without wallet (this environment)

```text
$ npm run amarok:discovery
MCP: https://amarok-mcp.compx.io/mcp
Amarok health:
{ "ok": true, "service": "amarok-api" }
(discovery truncated — 200 via MCP Streamable HTTP POST)

$ GITHUB_ACTIONS=true npm run amarok:e2e-smoke
status: failed
error: amarok:e2e-smoke refuses to spend in GitHub Actions (paid x402 / place are operator-only)

$ npm run amarok:e2e-smoke   # no ALPHA_WALLET_MNEMONIC
origin healthy: https://amarok-api.compx.io/health and /discovery → 200
MCP health ok
MCP discovery ok
status: failed
error: ALPHA_WALLET_MNEMONIC is required for Amarok CLI commands
```

HTTP probes (2026-08-14): `GET https://amarok-api.compx.io/health` → 200; `GET …/discovery` → 200.

## Full paid dry-run (operator)

Requires `ALPHA_WALLET_MNEMONIC` on a small-spend wallet. Expected x402 ≈ **0.015 USDC** + ALGO fees.

```bash
npm run amarok:e2e-smoke
# Live place (gated, not CI):
# GHILLIE_E2E_LIVE=1 npm run amarok:e2e-smoke -- --submit
```

Paste a successful JSON summary below (omit signatures / unsigned txn blobs — the script already redacts them).

```json
{
  "status": "ok",
  "mode": "dry-run",
  "note": "awaiting operator wallet run in this cloud agent"
}
```
