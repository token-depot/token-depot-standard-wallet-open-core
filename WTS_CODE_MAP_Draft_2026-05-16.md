# Code Map — Claim to Proof

**Repository target:** `token-depot-standard-wallet-open-core`  
**Module:** Wallet Trust Stack (WTS)  
**Status:** Public documentation draft  
**Date:** 2026-05-16

## Purpose

This file maps each public self-custody claim to the current proof surface. Claims must not be expanded beyond the proof listed here without a fresh forensics pass.

## Claim map

| Claim | Proof surface | What to verify | Limitation |
|---|---|---|---|
| Standard Wallet key material is generated client-side. | `wallet.html` Standard Wallet creation section | Browser-side code creates mnemonic/key material and local keyfile. | Does not prove the hosted frontend cannot be modified in a compromised deployment. |
| Standard Wallet keyfile is encrypted locally. | `wallet.html` keyfile creation section; `static/js/wallet.js` unlock path | Keyfile ciphertext is produced browser-side and later decrypted browser-side with passphrase. | User must protect keyfile and passphrase. |
| Server receives public descriptor data for Standard Wallet creation. | `server/src/routes/wallets.ts` setup wallet route | Route requires `user_pubkey`; Standard Wallet address is derived from public key. | The full hosted server has other product routes not included in public WTS. |
| Server wallet descriptor type does not include mnemonic. | `server/src/types.ts` `WalletRecord` | `WalletRecord` includes public descriptor/custody metadata and no `mnemonic` field. | Runtime data must still be audited before publication. |
| Server wallet store writes descriptor JSON, not keyfiles. | `server/src/storage/walletStore.ts` | Store path and write logic handle `WalletStore` descriptor records. | Do not publish real `data/users/*` contents. |
| Standard Wallet send requires local unlocked keyring. | `static/js/wallet.js` send handler | Send path checks `keyring`/`priv0` before continuing. | A user can still be tricked into signing if the displayed intent is malicious. |
| Standard Wallet signing uses local keyring private material. | `static/js/send_engine.js` | Send engine signs with `keyring.priv0`. | Public package should include minimal proof code, not the full hosted send engine unless reviewed. |
| Old server keyfile export path is removed. | Active-tree grep; `server/src/routes/wallets.ts` | `/api/wallet/keyfile/export` has zero hits. | Must be re-checked before release. |
| Old Open v1 server-side bind route is removed. | Active-tree grep; `server/src/routes/swap_mode_open.ts` | `/api/offers/bind` has zero hits. | Direct/Open swap proof docs should remain limited until excerpt review is complete. |
| Old server-side mnemonic signing helper is removed. | Active-tree grep | `_priv0_from_mnemonic`, `derivePriv0FromMnemonicOrThrow`, `active.mnemonic`, and `list_send` have zero hits. | Must be re-checked after future changes. |
| BCW is excluded from self-custody claims. | WTS docs and public/private matrix | BCW language says broker custody, not self-custody. | BCW may need a separate trust/security package later, but not this repo. |

## Required proof commands

```bash
grep -R -n 'wallet/keyfile/export\|api/offers/bind\|list_send\|_priv0_from_mnemonic\|derivePriv0FromMnemonicOrThrow\|active\.mnemonic\|typeof w\.mnemonic\|mnemonic\?: string' server/src static/js wallet.html brands data --exclude-dir=node_modules --exclude='*.bak' || true
find data/users -maxdepth 2 -type f -name '*.zip' -print
grep -R -n '"mnemonic"' data/users --exclude-dir=node_modules --exclude='*.bak' || true
npm run typecheck
```

Expected:

```text
No banned-pattern output.
No data/users zip output.
No "mnemonic" output in data/users.
Typecheck PASS.
```

## Claims not allowed from this code map

```text
Token Depot can never access any customer key in every possible deployment.
BCW is self-custody.
The entire hosted app is open source.
No server compromise can ever affect users.
WTS proves Oracle Node trust.
WTS proves Entitlement SDK correctness.
```
