# Public / Private Matrix

## Public in WTS v2

The following files are included as source-visible Standard Wallet trust references:

```text
reference/wallet.html
reference/static/js/wallet.js
reference/static/js/send_engine.js
reference/static/js/swaps.js
reference/static/js/swap_analyzer_shared.js
reference/static/js/offers.js
reference/static/js/offers_open.js
reference/server/src/routes/wallets.ts
reference/server/src/routes/wallet_send.ts
reference/server/src/routes/swap_mode_direct.ts
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
reference/server/src/storage/walletStore.ts
reference/server/src/types.ts
```

## Why these files are public

They show the Standard Wallet trust boundary: browser-side key creation/unlock/signing, server-side watch-only descriptor/build/broadcast behavior, and Direct/Open swap signing boundaries for Standard Wallets.

## Not public in WTS v2

WTS v2 does not include:

```text
Compliance Node internals
Broker-Custody Wallet custody signer internals
production deployment configuration
customer data
secrets or key material
tenant administration tools
Fireblocks or bridge automation internals
full hosted platform source tree
```

## Explicit claim boundary

Standard Wallet self-custody proof is public in this repo.

Broker-Custody Wallet custody proof is not part of this repo. BCW is broker custody and must not be described as self-custody.
