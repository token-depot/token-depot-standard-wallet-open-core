# Standard Wallet Self-Custody Proof

This document explains the Token Depot Standard Wallet self-custody boundary in plain language.

## Claim

For Standard Wallets, Token Depot's hosted server stores public wallet metadata and broadcasts signed transactions, but the signing key is created, encrypted, unlocked, and used in the browser.

## What the browser does

The browser Standard Wallet flow creates wallet key material locally, encrypts the keyfile locally with the user's passphrase, and downloads that encrypted keyfile to the user.

When the user unlocks the wallet, the browser reads the local keyfile and decrypts it locally. The active signing key is then held in browser runtime memory for that session.

The relevant source-visible files are:

```text
reference/wallet.html
reference/static/js/wallet.js
```

## What the server stores

For Standard Wallets, the server stores a wallet descriptor: wallet id, wallet type, network, public key, address, readiness state, and similar public metadata.

The server-side wallet storage model does not define mnemonic, private key, keyfile ciphertext, or passphrase fields for the Standard Wallet descriptor.

The relevant source-visible files are:

```text
reference/server/src/storage/walletStore.ts
reference/server/src/types.ts
reference/server/src/routes/wallets.ts
```

## How sends are signed

For Standard Wallet sends, the server can prepare public transaction build data and can broadcast a signed transaction. The browser performs the signing step with the locally unlocked key.

The relevant source-visible files are:

```text
reference/static/js/send_engine.js
reference/server/src/routes/wallet_send.ts
```

## What this does not claim

This WTS v1 proof does not claim that Broker-Custody Wallets are self-custody. Broker-Custody Wallets are a separate broker-custody product path.

This WTS v1 proof does not yet prove Direct swap or Open swap internals. Those will be covered only after a separate WTS v2 source review.
