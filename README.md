# Token Depot Standard Wallet Open-Core

This repository is a source-visible reference package for the Token Depot Standard Wallet self-custody proof.

It is not the full hosted Token Depot platform. It is a curated snapshot of the Standard Wallet files that prove the wallet's key ownership boundary:

- Standard Wallet key material is created in the browser.
- The Standard Wallet encrypted keyfile is generated and unlocked locally.
- The hosted server stores watch-only wallet descriptor data for Standard Wallets.
- Standard Wallet KAS and KRC-20 transactions are signed in the browser before broadcast.
- Direct/Open swap Standard Wallet signatures are produced in the browser from the locally unlocked key.
- Broker-Custody Wallet code paths are not self-custody claims and are documented separately as out of scope for WTS self-custody claims.

## What WTS v2 covers

WTS v2 covers Standard Wallet creation, local keyfile handling, browser unlock, server watch-only records, Standard Wallet send signing, and Standard Wallet Direct/Open swap signing boundaries.

## Source snapshot

The reference files were copied from the verified Token Depot Compliance Wallet working bundle:

```text
6924f3e0b0b0d0abe046a119675680dc455872e92f95330bfcb616b2e160fcd0  Compliance_Wallet_200.zip
```

The copied reference file hashes are recorded in `REFERENCE_MANIFEST.sha256`.

## Start here

1. Read `docs/SELF_CUSTODY.md` for the plain-English proof.
2. Read `docs/SWAP_SELF_CUSTODY.md` for Direct/Open swap self-custody scope.
3. Read `docs/TECHNICAL_VERIFICATION.md` for the file-level verification path.
4. Read `docs/CODE_MAP.md` for what each reference file proves.
5. Read `docs/SECURITY.md` for what this proof does and does not claim.

## License boundary

This repository is source-visible/open-core. Some files contain hosted-product integration code and are not presented as standalone MIT-licensed application code.

See `NOTICE.md` and `LICENSES/` for licensing terms and boundaries.
