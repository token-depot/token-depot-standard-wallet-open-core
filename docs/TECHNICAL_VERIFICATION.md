# Technical Verification Guide

This guide shows how to inspect WTS v2 using the reference files.

## 1. Verify the source snapshot

The reference files were copied from the verified Token Depot Compliance Wallet 200 source bundle.

```text
6924f3e0b0b0d0abe046a119675680dc455872e92f95330bfcb616b2e160fcd0  Compliance_Wallet_200.zip
```

## 2. Inspect wallet creation and local keyfile handling

Review:

```text
reference/wallet.html
reference/static/js/wallet.js
```

Proof points:

- browser-side key creation;
- local encrypted keyfile construction;
- local keyfile download;
- local keyfile read/decrypt on unlock;
- no server keyfile export fallback.

## 3. Inspect the server wallet descriptor model

Review:

```text
reference/server/src/types.ts
reference/server/src/storage/walletStore.ts
reference/server/src/routes/wallets.ts
```

Proof points:

- `WalletRecord` stores descriptor fields;
- Standard Wallet stores public key/address metadata;
- `/setup/wallet` accepts public setup metadata;
- legacy server key generation/export is rejected or absent.

## 4. Inspect Standard Wallet send signing

Review:

```text
reference/static/js/send_engine.js
reference/server/src/routes/wallet_send.ts
```

Proof points:

- browser code signs with the locally unlocked key;
- server build stages return public transaction data;
- server submit stages receive signed transaction data;
- server broadcasts signed artifacts rather than signing Standard Wallet spends.

## 5. Inspect swap signing

Review:

```text
reference/static/js/swaps.js
reference/static/js/offers.js
reference/static/js/offers_open.js
reference/server/src/routes/swap_mode_direct.ts
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
```

Proof points:

- maker-side swap creation requires local browser unlock;
- taker/finalize swap flows read the local browser keyring session;
- browser code creates input signatures locally;
- server routes coordinate preparation, validation, and broadcast;
- BCW authorization/signing paths are not Standard Wallet self-custody claims.

## 6. Suggested grep checks

From the repository root:

```bash
grep -R -n 'wallet/keyfile/export\|api/offers/bind\|list_send\|_priv0_from_mnemonic\|derivePriv0FromMnemonicOrThrow\|active\.mnemonic\|typeof w\.mnemonic\|mnemonic\?: string' reference || true
grep -R -n '"mnemonic"' reference/server || true
grep -R -n 'private_key\|auth_secret\|ciphertext' reference/server || true
grep -R -n 'priv0_hex\|createInputSignature\|signMessage' reference/static/js reference/server/src/routes || true
```

Expected interpretation:

- Browser-side references to mnemonic/keyfile handling are expected in Standard Wallet local flows.
- Browser-side `priv0_hex`, `createInputSignature`, and `signMessage` hits are expected in local signing flows.
- Server-side mnemonic/private-key storage references should not be present for Standard Wallet descriptors.
