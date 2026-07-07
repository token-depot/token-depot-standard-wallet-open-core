# Public / Private Matrix

## Public in the CW284 open-core package

The following files are included as public Standard Wallet / OMA L1 / KCC20-compatible trust references:

```text
reference/wallet.html
reference/kcc20-deploy.html
reference/kcc20-issue.html
reference/covenants.html
reference/static/js/wallet.js
reference/static/js/send_engine.js
reference/static/js/swaps.js
reference/static/js/swap_analyzer_shared.js
reference/static/js/offers.js
reference/static/js/offers_open.js
reference/static/js/kcc20-deploy-ui.js
reference/static/js/kcc20-issue-ui.js
reference/static/js/covenants-ui.js
reference/static/js/kaspa-toccata-bridge.mjs
reference/server/src/server.ts
reference/server/src/kaspaToccataSdk.ts
reference/server/src/routes/wallets.ts
reference/server/src/routes/wallet_send.ts
reference/server/src/routes/swap_mode_direct.ts
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
reference/server/src/storage/walletStore.ts
reference/server/src/types.ts
```

## Why these files are public

They show the Standard Wallet trust boundary: browser-side key creation/unlock/signing, server-side watch-only descriptor/build/broadcast behavior, KAS/KRC20 send boundaries, KCC20-compatible token flows, Direct/Open KCC20 Atomic swap signing boundaries, and the CW284 canonical Toccata SDK path.

## Not public in this repository

This repository does not include:

```text
Compliance Node private internals
Oracle Node private internals
Broker-Custody Wallet custody signer internals
production deployment configuration
AWS credentials or deployment scripts
customer data
runtime user ledgers
secrets or key material
tenant administration tools
Fireblocks or bridge automation internals
full hosted platform source tree
```

## Explicit claim boundary

Standard Wallet self-custody proof is public in this repo.

Broker-Custody Wallet custody proof is not part of this repo. BCW is broker custody and must not be described as self-custody.

KCC20 compatibility claims are limited to the included CW284 reference files, the KCC20 v1.1 review summary, and the proven OMA L1 / Compliance Wallet v1 implementation profile. The public package does not claim AWS deployment, mainnet launch, hosted-service availability, custody-service availability, or commercial license rights.
