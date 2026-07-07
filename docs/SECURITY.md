# Security and Scope Notes

## What this package is

This repository is an open-core/public review package for Standard Wallet, OMA L1/KCC20-compatible token flows, and Direct/Open Atomic KCC20 swap flows as represented by the CW284 reference files.

It is intended for source inspection, audit review, compatibility review, and self-custody boundary review.

## What this package is not

This repository is not a production deployment bundle and is not a secret-bearing runtime archive.

It does not include:

```text
production secrets
private keys
passphrases
mnemonic backups
hosted infrastructure credentials
AWS deployment configuration
customer data
runtime user ledgers
Compliance Node private internals
Oracle Node private internals
Broker-Custody signer internals
Fireblocks or bridge automation internals
commercial administration systems
```

## Security review focus

Reviewers should focus on:

- browser-side Standard Wallet key generation, encryption, unlock, and signing;
- server watch-only descriptor boundaries;
- signed-artifact submit and broadcast boundaries;
- covenant-bearing UTXO exclusion from normal-send paths;
- KCC20-compatible state/ownership/supply behavior;
- Direct/Open Atomic KCC20 swap policy and tracking behavior;
- CW284 canonical Toccata SDK import paths.

## Reporting issues

Security-sensitive reports should not include private keys, passphrases, mnemonics, seed material, auth secrets, custody material, signed transaction material, submit tokens, production URLs with credentials, or customer data.

Provide file paths, line references, public transaction IDs, public testnet identifiers, and minimal reproduction details where possible.
