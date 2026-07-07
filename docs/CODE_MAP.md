# Code Map

This map explains why each CW284 reference file is included.

The reference files are copied from the verified `Compliance_Wallet_284_Mac.zip` source snapshot unless noted otherwise. They are included so reviewers can inspect the self-custody, KRC20, KCC20, swap, and SDK-promotion boundaries directly.

## Wallet/keyfile proof files

### `reference/wallet.html`

Purpose: browser-side Standard Wallet creation, recovery, import, local keyfile download flow, wallet UI, KRC20/KCC20 navigation, and visible KRC20-only Coupon Broadcaster warning.

Proves:

- Standard Wallet key material is created in the browser.
- The encrypted keyfile is built in the browser.
- The setup request posts public metadata, not a private key or mnemonic.
- Broker-Custody Wallet recovery is not treated as Standard Wallet recovery.
- Coupon Broadcaster is explicitly warned as KRC20-only in v1.

### `reference/static/js/wallet.js`

Purpose: browser wallet runtime, local keyfile unlock, local keyfile export/download, token display, and UI send/swap integration.

Proves:

- The keyfile export path downloads the currently loaded local keyfile object.
- Standard Wallet unlock decrypts the local keyfile in browser runtime.
- Standard Wallet sends require a locally unlocked key before signing.

### `reference/static/js/send_engine.js`

Purpose: browser-side Standard Wallet send execution.

Proves:

- Standard Wallet KAS and KRC20 sends are signed in browser runtime.
- KRC20 commit/reveal signing uses the locally unlocked key.
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

Purpose: server route for staged build/submit send handling after CW284 SDK promotion.

Proves:

- Standard Wallet KAS build returns public transaction build data.
- Standard Wallet KAS submit accepts signed transactions for broadcast.
- Standard Wallet KRC20 build/wait stages return public transaction data needed by browser signing.
- Standard Wallet KRC20 submit accepts signed transaction artifacts.
- Covenant-bearing UTXO exclusion remains part of normal-send safety.
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

## KCC20-compatible token proof files

### `reference/kcc20-deploy.html`
### `reference/static/js/kcc20-deploy-ui.js`

Purpose: KCC20-compatible OMA L1 deploy UI and browser signing surface.

Proves:

- KCC20-compatible deploy is a distinct UI surface.
- Browser-side signing is used for deploy-stage artifacts.
- Deploy behavior remains tied to the CW284 SDK-finalized application path.

### `reference/kcc20-issue.html`
### `reference/static/js/kcc20-issue-ui.js`

Purpose: KCC20-compatible Issue / Burn / Change Ownership UI and browser signing surface.

Proves:

- Issue, burn, supply, and ownership-transfer actions are user-facing KCC20-compatible flows.
- Change Ownership is exposed in the KCC20 Issue/Burn page.
- Signing remains browser-local through the unlocked wallet session.
- The UI warns where relevant features remain deferred or KRC20-only.

## Covenant Controls / SDK-promotion proof files

### `reference/covenants.html`
### `reference/static/js/covenants-ui.js`

Purpose: Covenant Controls and Programmable KAS UI surfaces used while proving Toccata/CW284 behavior.

Proves:

- Covenant-bearing UTXOs are inspected and classified through explicit UI surfaces.
- Unknown covenants are not treated as KCC20 tokens without descriptor/profile support.
- Normal-send exclusion and proof surfaces are visible to users.

### `reference/static/js/kaspa-toccata-bridge.mjs`
### `reference/server/src/kaspaToccataSdk.ts`

Purpose: canonical CW284 Toccata SDK bridge/import path.

Proves:

- Active Toccata code imports from the canonical `wasm/sdk/kaspa-wasm32-sdk/web/kaspa/` package.
- The duplicate `kaspa-wasm32-sdk-toccata-v2` path is no longer the active architecture.

### `reference/server/src/server.ts`

Purpose: consolidated server route implementation for OMA L1/KCC20-compatible token flows, KCC20 Atomic Direct/Open swap flows, Covenant Controls, and SDK route guards.

Proves:

- KCC20-compatible deploy, issue, burn, change-owner, Direct Atomic, and Open Atomic server routes are implemented in the CW284 source snapshot.
- Submit routes validate signed artifacts rather than owning Standard Wallet private keys.
- Route guards are part of the post-SDK finalization release-readiness proof.

## Swap proof files

### `reference/static/js/swaps.js`

Purpose: maker-side Direct Atomic KCC20 and KRC20 swap UI, browser-side maker signing, and offer creation.

Proves:

- Swap creation requires a local browser keyring session.
- Standard Wallet maker signatures are produced locally.
- KCC20 Direct Atomic maker-lock creation is driven through Wallet UI.

### `reference/static/js/offers.js`

Purpose: Direct offer display, BUY/claim logic, taker signing, and maker cancel/refund UI.

Proves:

- Direct taker/finalize flow reads the local browser keyring session.
- Required Standard Wallet signatures are produced locally.
- KCC20 Direct Atomic v4 claim and maker cancel/refund UI paths are present.

### `reference/static/js/offers_open.js`

Purpose: Open offer display, BUY/fill, maker cancel/refund, and expired recovery popup behavior.

Proves:

- Open taker/finalize flow reads the local browser keyring session.
- KCC20 Open Atomic dynamic-taker claim/fill and maker cancel/recovery UI paths are present.

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
### `reference/server/src/routes/swap_mode_open_v2.ts`

Purpose: server-side Direct/Open offer listing, Open Swap maker/list/analyze/offer flow, and KCC20 atomic offer projection.

Proves:

- Server handles Open offer listing/analyzer/accept coordination.
- KCC20 Atomic Direct/Open offer records are exposed as public offer rows where appropriate.
- Standard Wallet maker/taker signatures are provided by the browser, not by server-side private key material.
