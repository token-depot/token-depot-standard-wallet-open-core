# Code Map

This map explains why each WTS v2 reference file is included.

## Wallet/keyfile proof files

### `reference/wallet.html`

Purpose: browser-side Standard Wallet creation, recovery, import, and local keyfile download flow.

Proves:

- Standard Wallet key material is created in the browser.
- The encrypted keyfile is built in the browser.
- The setup request posts public metadata, not a private key or mnemonic.
- Broker-Custody Wallet recovery is not treated as Standard Wallet recovery.

### `reference/static/js/wallet.js`

Purpose: browser wallet runtime, local keyfile unlock, local keyfile export/download, and UI send integration.

Proves:

- The keyfile export path downloads the currently loaded local keyfile object.
- Standard Wallet unlock decrypts the local keyfile in browser runtime.
- Standard Wallet sends require a locally unlocked key before signing.

### `reference/static/js/send_engine.js`

Purpose: browser-side Standard Wallet send execution.

Proves:

- Standard Wallet KAS and KRC-20 sends are signed in browser runtime.
- KRC-20 commit/reveal signing uses the locally unlocked key.
- Signed artifacts are serialized before submit.

## Server watch-only/send proof files

### `reference/server/src/routes/wallets.ts`

Purpose: server route for wallet listing, selection, setup, recovery metadata, and descriptor creation.

Proves:

- Server setup accepts public metadata for Standard Wallets.
- Server derives/stores Standard Wallet address metadata from public key material.
- The old server-generated wallet path is rejected.
- Broker-Custody Wallet handling is separate from Standard Wallet self-custody proof.

### `reference/server/src/routes/wallet_send.ts`

Purpose: server route for staged build/submit send handling.

Proves:

- Standard Wallet KAS build returns public transaction build data.
- Standard Wallet KAS submit accepts signed transactions for broadcast.
- Standard Wallet KRC-20 build/wait stages return public transaction data needed by browser signing.
- Standard Wallet KRC-20 submit accepts signed transaction artifacts.
- Broker-Custody Wallet paths are separate and are not self-custody claims.

### `reference/server/src/storage/walletStore.ts`

Purpose: server-side per-user wallet descriptor persistence.

Proves:

- Wallet store records are metadata descriptors.
- Store creation/read/write functions do not handle keyfiles, mnemonics, passphrases, or private keys.

### `reference/server/src/types.ts`

Purpose: wallet model type definitions.

Proves:

- Standard Wallet and Broker-Custody Wallet models are distinct.
- `WalletRecord` defines public metadata fields and does not define Standard Wallet private-key fields.

## Swap proof files

### `reference/static/js/swaps.js`

Purpose: maker-side swap UI and browser-side maker signing.

Proves:

- Swap creation requires a local browser keyring session.
- Standard Wallet maker commit/reveal signatures are produced locally.
- BCW local authorization paths are separate and do not turn BCW into a self-custody claim.

### `reference/static/js/offers.js`

Purpose: Direct offer display/accept logic.

Proves:

- Direct taker/finalize flow reads the local browser keyring session.
- Required Standard Wallet signatures are produced locally.

### `reference/static/js/offers_open.js`

Purpose: Open offer display/accept/finalize logic.

Proves:

- Open taker/finalize flow reads the local browser keyring session.
- Required Standard Wallet signatures are produced locally.

### `reference/static/js/swap_analyzer_shared.js`

Purpose: analyzer display helper.

Proves:

- Analyzer output rendering is display logic, not custody/signing logic.

### `reference/server/src/routes/swap_mode_direct.ts`

Purpose: server-side Direct swap preparation, validation, offer storage, acceptance, finalize, and broadcast coordination.

Proves:

- Server prepares/validates transaction artifacts and receives signatures/artifacts.
- Removed legacy Compliance Wallet signing paths are blocked.
- Server-side coordination is distinct from Standard Wallet private-key custody.

### `reference/server/src/routes/swap_mode_open.ts`

Purpose: server-side Open list/analyze/accept compatibility routes.

Proves:

- Server handles Open offer listing/analyzer/accept coordination.
- No legacy server mnemonic signing path remains.

### `reference/server/src/routes/swap_mode_open_v2.ts`

Purpose: server-side Open V2 maker/list/analyze/offer flow.

Proves:

- Server prepares SafeJSON artifacts and staged offer data.
- Standard Wallet maker signatures are provided by the browser, not server-side private key material.
