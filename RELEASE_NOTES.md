# Compliance_Wallet 298 — Public RC1 Release Notes

## Release scope

This candidate packages the proven Compliance_Wallet 298 source line for public review. It includes the KCC20-Regulated Testnet-10 workspace, standard KCC20 regression corrections, mass-aware KCC20 funding selection, Direct/Open KCC20 swap non-degradation corrections, standard KCC20 two-click UI, user-scoped Audit UI, and Programmable KAS DAA guidance.

## Proven release boundaries

- `kaspa-wasm` SDK remains pinned at version `2.0.1`.
- KCC20-Regulated remains Testnet-10 demonstration functionality.
- The Audit report is labeled demonstration evidence, partial historical projection, and not regulator certification.
- Standard KCC20, KRC20, KAS, existing Direct/Open swaps, and Programmable KAS paths remain separate and preserved.
- Mainnet regulated activation and AWS deployment are not enabled by this package.

## Privacy boundary

Runtime data, wallets, user profiles, offer ledgers, private Audit evidence, logs, temporary transaction artifacts, backup files, local dependencies, and architecture-specific helper binaries are intentionally excluded. See `PUBLIC_PACKAGE_MANIFEST.md`.

## Installation

Install JavaScript dependencies from the lockfile before running:

```bash
npm ci
npm run typecheck
npm run dev
```

Runtime environment values and secrets must be supplied outside source control.
