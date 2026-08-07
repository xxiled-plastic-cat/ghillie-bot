# Security policy

Ghillie-bot is a **custodial** Alpha Arcade user-agent: it holds wallet keys,
builds x402 `paymentSignature`s, and signs/submits Algorand transactions locally.
Treat key and payment bugs as security issues.

## Reporting a vulnerability

**Do not** open a public GitHub issue for wallet, mnemonic, API key, payment
signature, or other security problems.

Prefer **GitHub Private vulnerability reporting**:

https://github.com/xxiled-plastic-cat/ghillie-bot/security/advisories/new

Include steps to reproduce, impact, and a safe contact method. **Never** include
real mnemonics or production secrets in the report — use redacted examples.

## Operational reminders

- Never commit `.env` or paste secrets into issues, PRs, logs, or screenshots.
- Amarok never receives keys; keep custody boundaries intact in any patch.
- Prefer dry-run and unit tests over live mainnet while validating fixes.
