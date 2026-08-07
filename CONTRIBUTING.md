# Contributing

Thanks for helping improve Ghillie-bot. This guide is for people changing the
code. To **run** the bot as an operator, start with [README.md](./README.md).

## Ground rules

- **Never commit secrets.** Keep `.env` local. Use [`.env.example`](./.env.example)
  as the template only.
- **Do not paste mnemonics, API keys, or payment signatures** into issues, PRs,
  logs, or screenshots.
- **Prefer dry-run while developing.** Use `npm run alpha:live-dry-run` and set
  `ALPHA_ENABLE_LIVE_TRADING=false` / `ALPHA_CONFIRM_RISK=false` in your local
  `.env` even if the example file shows live gates enabled for operators.
- **Paid Amarok x402 calls spend real mainnet USDC.** Prefer the mocked unit
  suite while developing. Do not run live MCP smoke from CI.

## Development setup

```bash
# Node 20+
npm install
cp .env.example .env
# fill ALPHA_WALLET_MNEMONIC (and related) for local Amarok dry-runs
# local: host zs-proxy with the same mnemonic; Docker: see README § Docker
```

Optional: Telegram and DigitalOcean Spaces. Without Spaces, bot state lands under
`BOT_STATE_DATA_DIR` (default `data/bot-states`) with the same key layout.

## Checks before you open a PR

```bash
npm run typecheck
npm test
```

Format / lint tooling is not wired yet (see the development checklist). Match
existing TypeScript style until those land.

- `npm test` mocks paid Amarok / ZeroSignal behavior and should **not** spend
  funds.
- CLI scripts such as `amarok:opportunities`, `amarok:rewards`,
  `amarok:spreads`, `amarok:parity`, and `amarok:execution-dry` **do** spend
  USDC (or submit when you pass `--submit`). Use them intentionally on a wallet
  you control.
- `npm run zs:smoke` hits zs-proxy / ZeroSignal and incurs inference cost when
  the proxy is funded.

## Project map (short)

| Area | Location |
| --- | --- |
| Live loop / place | `src/alpha/` |
| Plan review (ZeroSignal) | `src/alpha/planReview/` |
| Amarok MCP + x402 | `src/integrations/amarok/` |
| zs-proxy client | `src/integrations/zerosignal/` |
| Bot state (Spaces/FS) | `src/integrations/storage/` |
| Dashboard | `apps/alpha-dashboard/` |
| Config / env template | `.env.example`, `config/` |

## Pull requests

1. Keep changes focused; match existing TypeScript style.
2. Add or update tests when behavior changes (payments, plan review, state,
   risk).
3. Update docs (`README.md`, `.env.example`) when you change operator-facing
   setup, costs, or env vars.
4. Describe **why** in the PR body, and note if you ran any live/mainnet
   commands.

## Code of conduct

Be respectful and constructive. Harassment, personal attacks, or bad-faith
spam are not welcome; maintainers may close abusive issues or PRs.

We follow the spirit of the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## Security

Do not file public issues for wallet, key, or payment vulnerabilities. See
[SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License ([LICENSE](./LICENSE)).
