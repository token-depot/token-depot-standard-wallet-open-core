# Standard Wallet Self-Custody Boundary

This document summarizes the self-custody boundary represented by the CW284 reference files.

## Standard Wallet claim

For Standard Wallets, private signing material is created, encrypted, stored, unlocked, and used in the browser-side wallet runtime. Server routes store public wallet descriptors, prepare public transaction build data, validate signed artifacts, and broadcast already-signed transactions.

## Files to inspect

```text
reference/wallet.html
reference/static/js/wallet.js
reference/static/js/send_engine.js
reference/server/src/routes/wallets.ts
reference/server/src/routes/wallet_send.ts
reference/server/src/storage/walletStore.ts
reference/server/src/types.ts
```

## Proof boundary

The public reference files support these claims:

- Standard Wallet setup posts public metadata to the server.
- The encrypted keyfile is created client-side.
- The passphrase is used in browser runtime for encryption/decryption.
- KAS/KRC20 signing requires local browser unlock.
- The server does not need Standard Wallet private keys to broadcast already-signed artifacts.

## Exclusions

This repository does not prove Broker-Custody Wallet self-custody. Broker-Custody Wallets are custody/broker workflows and must not be described as Standard Wallet self-custody.

This repository does not include production secrets, private keys, passphrases, custody infrastructure, Compliance Node private internals, Oracle Node private internals, customer data, hosted deployment configuration, or AWS deployment configuration.
