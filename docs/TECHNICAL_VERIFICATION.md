# Technical Verification Guide

This guide shows how to inspect the CW284 open-core package using the reference files.

## 1. Verify the source snapshot

The reference files were copied from the verified Token Depot Compliance Wallet CW284 source bundle.

```text
4086911456ce4110a2e9c939385ba6f911c3d1a1efdcfdb146375d920f7a5bbd  Compliance_Wallet_284_Mac.zip
```

The supporting SDK/reference bundle was:

```text
4277504a3d71679e82f7b2143827454005a70f24b7d5cc31b4d9d0e22fd8f7ba  What_the_SDK_Requires_v2-20.zip
```

## 2. Verify the reference manifest

Run from the repository root:

```bash
shasum -a 256 $(awk '{print $2}' REFERENCE_MANIFEST.sha256)
```

Compare the output to `REFERENCE_MANIFEST.sha256`.

## 3. Inspect wallet creation and local keyfile handling

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

## 4. Inspect the server wallet descriptor model

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

## 5. Inspect Standard Wallet send signing

Review:

```text
reference/static/js/send_engine.js
reference/server/src/routes/wallet_send.ts
```

Proof points:

- browser code signs with the locally unlocked key;
- server build stages return public transaction data;
- server submit stages receive signed transaction data;
- server broadcasts signed artifacts rather than signing Standard Wallet spends;
- covenant-bearing UTXOs are excluded from ordinary KAS normal-send selection.

## 6. Inspect KCC20-compatible token flows

Review:

```text
reference/kcc20-deploy.html
reference/kcc20-issue.html
reference/static/js/kcc20-deploy-ui.js
reference/static/js/kcc20-issue-ui.js
reference/server/src/server.ts
```

Proof points:

- KCC20-compatible deploy/issue/burn/change-owner flows are separated from KRC20 pages;
- issue/burn/change-owner signing uses local browser wallet state;
- submit routes validate signed artifacts before accepting/broadcasting;
- Change Ownership transfers controller/issuer authority according to the implemented profile.

## 7. Inspect Direct/Open Atomic KCC20 swap signing

Review:

```text
reference/static/js/swaps.js
reference/static/js/offers.js
reference/static/js/offers_open.js
reference/server/src/server.ts
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
```

Proof points:

- maker-side swap creation requires local browser unlock;
- taker/finalize swap flows read the local browser keyring session;
- browser code creates input signatures locally;
- server routes coordinate, validate, and broadcast already-signed artifacts;
- Direct Atomic KCC20 v4 and Open Atomic KCC20 dynamic-taker paths are represented in the CW284 source.

## 8. Inspect CW284 SDK promotion/finalization

Review:

```text
reference/static/js/kaspa-toccata-bridge.mjs
reference/server/src/kaspaToccataSdk.ts
reference/server/src/routes/wallet_send.ts
reference/server/src/server.ts
```

Proof points:

- active Toccata imports use `wasm/sdk/kaspa-wasm32-sdk/web/kaspa/`;
- duplicate `kaspa-wasm32-sdk-toccata-v2` import path is not the active architecture;
- SDK route guards were proven clean in the CW284 release-candidate line.
