# Token Depot Standard Wallet Open Core

**Repository target:** `token-depot-standard-wallet-open-core`  
**Module:** Wallet Trust Stack (WTS)  
**Status:** Public documentation draft  
**Date:** 2026-05-16

## Purpose

This repository is intended to help developers, customers, auditors, and investors review the self-custody-critical behavior of the Token Depot **Standard Wallet**.

The narrow claim this package is designed to prove is:

```text
A Token Depot Standard Wallet is controlled by the user's local key material.
The hosted server stores public/watch-only wallet descriptor data, not the Standard Wallet spend key.
A Standard Wallet send requires an unlocked local keyfile on the client side.
```

This package is not a copy of the full hosted Token Depot application. It is an open-core trust package focused on the wallet ownership and signing boundary.

## What this package covers

```text
Standard Wallet creation
Local encrypted keyfile concept
Local keyfile unlock concept
Server-side wallet descriptor shape
Standard Wallet send/signing boundary
Legacy server-side mnemonic export/signing cleanup proof
```

## What this package does not cover

```text
Broker-Custody Wallet custody security
Compliance Node custody internals
Bridge, issuance, redemption, tenant, or hosted-platform workflows
Oracle Node trust proofs
Entitlement SDK behavior
Production runtime data
```

Those are separate tracks. In particular, **Broker-Custody Wallet (BCW) is broker custody, not Standard Wallet self-custody**, and must not be described as self-custody.

## Source-of-truth basis

This documentation is based on the verified WTS cleanup state from the Compliance_Wallet working tree. The relevant audit result was:

```text
Banned server/runtime patterns: no output
data/users/*.zip: no output
"mnemonic" in data/users: no output
npm run typecheck: PASS
```

The cleaned active runtime removed the old server-side Standard Wallet mnemonic export/signing residue, including:

```text
/api/wallet/keyfile/export
/api/offers/bind
list_send
_priv0_from_mnemonic
derivePriv0FromMnemonicOrThrow
WalletRecord.mnemonic
```

## Where to start

```text
SELF_CUSTODY.md             Plain-English proof narrative
SECURITY.md                 Security boundary and user responsibilities
TECHNICAL_VERIFICATION.md   Verification checklist for reviewers
CODE_MAP.md                 Claim-to-code map
PUBLIC_PRIVATE_MATRIX.md    What can and cannot be included publicly
```

## Public release rule

Do not add runtime data, user data, wallet keyfiles, encrypted wallet ciphertext, recovery files, mnemonics, private keys, auth secrets, `.env` files, Compliance Node custody data, or Broker-Custody Wallet signer material to this repository.
