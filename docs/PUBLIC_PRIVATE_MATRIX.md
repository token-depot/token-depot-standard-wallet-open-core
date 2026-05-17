# Public / Private Matrix

## Public in WTS v1

The following files are included as source-visible Standard Wallet trust references:

```text
reference/wallet.html
reference/static/js/wallet.js
reference/static/js/send_engine.js
reference/server/src/routes/wallets.ts
reference/server/src/routes/wallet_send.ts
reference/server/src/storage/walletStore.ts
reference/server/src/types.ts
```

## Why these files are public

They show the Standard Wallet trust boundary: browser-side key creation/unlock/signing and server-side watch-only descriptor/build/broadcast behavior.

## Not public in WTS v1

WTS v1 does not include:

```text
Compliance Node internals
Broker-Custody Wallet custody signer internals
production deployment configuration
customer data
secrets or key material
tenant administration tools
Fireblocks or bridge automation internals
Direct/Open swap proof files
```

## Deferred to WTS v2

The following areas require separate forensics before publication:

```text
Direct swap self-custody proof
Open swap self-custody proof
offer creation/fill proof
atomic swap signing proof
```
