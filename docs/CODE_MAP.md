# Code Map

This map explains why each WTS v1 reference file is included.

## `reference/wallet.html`

Purpose: browser-side Standard Wallet creation, recovery, import, and local keyfile download flow.

What it proves:

- Standard Wallet key material is created in the browser.
- The encrypted keyfile is built in the browser.
- The setup request posts public metadata, not a private key or mnemonic.
- Broker-Custody Wallet recovery is not treated as Standard Wallet recovery.

## `reference/static/js/wallet.js`

Purpose: browser wallet runtime, local keyfile unlock, local keyfile export/download, and UI send integration.

What it proves:

- The keyfile export path downloads the currently loaded local keyfile object.
- Standard Wallet unlock decrypts the local keyfile in browser runtime.
- Standard Wallet sends require a locally unlocked key before signing.

## `reference/static/js/send_engine.js`

Purpose: browser-side Standard Wallet send execution.

What it proves:

- Standard Wallet KAS and KRC-20 sends are signed in browser runtime.
- KRC-20 commit/reveal signing uses the locally unlocked key.
- Signed artifacts are serialized before submit.

## `reference/server/src/routes/wallets.ts`

Purpose: server route for wallet listing, selection, setup, recovery metadata, and descriptor creation.

What it proves:

- Server setup accepts public metadata for Standard Wallets.
- Server derives/stores Standard Wallet address metadata from public key material.
- The old server-generated wallet path is rejected.
- Broker-Custody Wallet handling is separate from Standard Wallet self-custody proof.

## `reference/server/src/routes/wallet_send.ts`

Purpose: server route for staged build/submit send handling.

What it proves:

- Standard Wallet KAS build returns public transaction build data.
- Standard Wallet KAS submit accepts signed transactions for broadcast.
- Standard Wallet KRC-20 build/wait stages return public transaction data needed by browser signing.
- Standard Wallet KRC-20 submit accepts signed transaction artifacts.
- Broker-Custody Wallet paths are separate and are not self-custody claims.

## `reference/server/src/storage/walletStore.ts`

Purpose: server-side per-user wallet descriptor persistence.

What it proves:

- Wallet store records are metadata descriptors.
- Store creation/read/write functions do not handle keyfiles, mnemonics, passphrases, or private keys.

## `reference/server/src/types.ts`

Purpose: wallet model type definitions.

What it proves:

- Standard Wallet and Broker-Custody Wallet models are distinct.
- `WalletRecord` defines public metadata fields and does not define Standard Wallet private-key fields.
