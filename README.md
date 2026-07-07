# Token Depot Standard Wallet Open-Core

This repository publishes the Token Depot Standard Wallet / OMA L1 KCC20-compatible open-source transparency package.

It is intended to make the Standard Wallet self-custody boundary, the KCC20-compatible wallet implementation, and the Direct/Open Atomic KCC20 swap implementation inspectable by users, developers, auditors, token issuers, exchanges, reviewers, and the Kaspa ecosystem.

## License model: open source, not freeware

This repository is dual licensed:

- **Open-source path:** GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
- **Commercial path:** separate paid commercial license available from Token Depot Corp.

The open-source path gives users the rights granted by the AGPL, including use, study, modification, redistribution, and network operation subject to the AGPL terms. The commercial path is for operators, vendors, exchanges, brokers, hosted-service providers, white-label deployments, marketplace operators, or enterprise users that want separate commercial terms or do not want to rely on the AGPL path.

"Open source" does not mean Token Depot services, trademarks, hosted infrastructure, support, compliance operations, broker/custody systems, enterprise integrations, managed deployments, AWS environments, or commercial licensing are free of charge. Token Depot may charge for hosted services, support, managed deployments, enterprise integrations, commercial licensing, or trademark/branding permissions.

See [`LICENSE`](LICENSE), [`NOTICE.md`](NOTICE.md), and [`docs/OPEN_SOURCE_COMMERCIAL_MODEL.md`](docs/OPEN_SOURCE_COMMERCIAL_MODEL.md).

## Current release anchor

This branch updates the repository from the older WTS v2.1 snapshot toward the CW284 / KCC20 v1 release-candidate line.

Pinned working bundles used for this update:

```text
4086911456ce4110a2e9c939385ba6f911c3d1a1efdcfdb146375d920f7a5bbd  Compliance_Wallet_284_Mac.zip
7e94f609897facc9d7b2ec12b9e16685bf391b6f711ddfd0d2ce60093d784803  token-depot-standard-wallet-open-core-WTS-v2.1.zip
4277504a3d71679e82f7b2143827454005a70f24b7d5cc31b4d9d0e22fd8f7ba  What_the_SDK_Requires_v2-20.zip
c6c13a43710c287a94ef475faef37ede007d67f8d5425c2306c4bb94279bb81e  Compliance_Node_100.zip
```

## CW284 status

The CW284 release-candidate line proves:

- Rusty Kaspa / Toccata SDK promotion/finalization is complete for the active application path.
- Active SDK imports point at the canonical `wasm/sdk/kaspa-wasm32-sdk/web/kaspa/` package.
- The canonical SDK package reports `kaspa-wasm` version `2.0.1`.
- The duplicate `kaspa-wasm32-sdk-toccata-v2` bridge folder/path is removed from the active architecture.
- Standard Wallet KAS / KRC20 route guards remain clean after SDK promotion.
- KCC20-compatible Deploy / Issue / Burn / Change Ownership remain part of the v1 application profile.
- Direct Atomic KCC20 v4 remains complete from the CW282/CW283 line.
- Open Atomic KCC20 remains complete from the CW282/CW283 line.
- Coupon Broadcaster and Energy tools currently warn that their token support is KRC20-only; KCC20 support is deferred to a later update.
- AWS deployment and mainnet live action are not included in this publication package.

## What this repository covers

This repository is the open-core/public review package for:

- Standard Wallet browser-local key creation, unlock, recovery, import, and signing boundaries.
- Watch-only server wallet descriptors for Standard Wallets.
- Standard Wallet KAS and KRC20 signing/build/submit boundaries.
- KCC20-compatible OMA L1 token deploy, issue, burn, and ownership-transfer behavior.
- Direct Atomic KCC20 swaps.
- Open Atomic KCC20 swaps.
- Covenant Controls / Toccata SDK bridge evidence relevant to KCC20 v1.
- Public documentation for the KCC20 Reader/Writer model and implementation-language-neutral compatibility profile.

## What this repository does not include

This repository does not include production secrets, private keys, passphrases, hosted infrastructure credentials, tenant infrastructure, Compliance Node private internals, Oracle Node private internals, broker-custody private systems, AWS deployment configuration, commercial administration tools, customer data, runtime user ledgers, or private deployment configuration.

## Start here

1. Read `docs/OPEN_SOURCE_COMMERCIAL_MODEL.md` for the open-source/commercial boundary.
2. Read `docs/KCC20_SPECIFICATION_V1_1_REVIEW.md` for the KCC20 v1.1 review summary.
3. Read `docs/PUBLIC_PRIVATE_MATRIX.md` for what is public and what remains private.
4. Read `docs/TECHNICAL_VERIFICATION.md` for the file-level verification path.
5. Read `docs/CODE_MAP.md` for what each reference file proves.
6. Read `docs/SELF_CUSTODY.md` and `docs/SWAP_SELF_CUSTODY.md` for Standard Wallet custody boundaries.
7. Read `docs/SECURITY.md` for what this proof does and does not claim.
