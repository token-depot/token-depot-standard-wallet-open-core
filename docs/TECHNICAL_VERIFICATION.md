# Technical Verification Guide

This guide shows how to inspect WTS v1 using the reference files.

## 1. Verify the source snapshot

The reference files were copied from the verified Token Depot Compliance Wallet 200 source bundle.

Use the reference files in this repository and compare them against the published WTS v1 local package or the original verified Compliance Wallet source snapshot.

## 2. Inspect wallet creation and local keyfile handling

Review:

```text
reference/wallet.html
reference/static/js/wallet.js
```

Look for the Standard Wallet create/recovery/import flows. The important proof points are:

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

The important proof points are:

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

The important proof points are:

- browser code signs with the locally unlocked key;
- server build stages return public transaction data;
- server submit stages receive signed transaction data;
- server broadcasts signed artifacts rather than signing Standard Wallet spends.

## 5. Suggested grep checks

From the repository root:

```bash
grep -R -n 'wallet/keyfile/export\|api/offers/bind\|list_send\|_priv0_from_mnemonic\|derivePriv0FromMnemonicOrThrow\|active\.mnemonic\|typeof w\.mnemonic\|mnemonic\?: string' reference || true
grep -R -n '"mnemonic"' reference/server || true
grep -R -n 'private_key\|auth_secret\|ciphertext' reference/server || true
```

Expected interpretation:

- Browser-side references to mnemonic/keyfile handling are expected in Standard Wallet local flows.
- Server-side mnemonic/private-key storage references should not be present for Standard Wallet descriptors.
