# Token Depot Standard Wallet Open-Core

This repository publishes the Token Depot Standard Wallet / OMA L1 KCC20-compatible open-source transparency package.

It is intended to make the Standard Wallet self-custody boundary and the KCC20-compatible wallet implementation inspectable by users, developers, auditors, token issuers, exchanges, reviewers, and the Kaspa ecosystem.

## License model: open source, not freeware

This repository is dual licensed:

- **Open-source path:** GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
- **Commercial path:** separate paid commercial license available from Token Depot Corp.

The open-source path gives users the rights granted by the AGPL, including use, study, modification, redistribution, and network operation subject to the AGPL terms. The commercial path is for operators, vendors, exchanges, brokers, hosted-service providers, white-label deployments, or enterprise users that want separate commercial terms or do not want to rely on the AGPL path.

"Open source" does not mean Token Depot services, trademarks, hosted infrastructure, support, compliance operations, broker/custody systems, or enterprise integrations are free of charge. Token Depot may charge for hosted services, support, managed deployments, enterprise integrations, commercial licensing, or trademark/branding permissions.

See [`LICENSE`](LICENSE), [`NOTICE.md`](NOTICE.md), and [`docs/OPEN_SOURCE_COMMERCIAL_MODEL.md`](docs/OPEN_SOURCE_COMMERCIAL_MODEL.md).

## Current release anchor

This branch updates the repository from the older WTS v2.1 snapshot toward the CW283 / KCC20 v1 release line.

Pinned working bundle used for this update:

```text
c85f865fd16b1773a4de395861919cc11108f923de4c451ef3754a23badccef8  Compliance_Wallet_283_Mac.zip
0abe45174d02d70a0e525f844066101622f10b7471472ac2046e0d294ec49b4e  KCC20-Lab_6.zip
4277504a3d71679e82f7b2143827454005a70f24b7d5cc31b4d9d0e22fd8f7ba  What_the_SDK_Requires_v2-20.zip
c6c13a43710c287a94ef475faef37ede007d67f8d5425c2306c4bb94279bb81e  Compliance_Node_100.zip
```

## What this repository covers

This repository is the open-core/public review package for:

- Standard Wallet browser-local key creation, unlock, and signing boundaries.
- Watch-only server wallet descriptors for Standard Wallets.
- Standard Wallet KAS and KRC20 signing paths.
- KCC20-compatible OMA L1 token deploy, issue, burn, and ownership-transfer behavior.
- Direct Atomic KCC20 swaps.
- Open Atomic KCC20 swaps.
- Public documentation for the KCC20 Reader/Writer model and implementation-language-neutral compatibility profile.

## KCC20 v1 status

The CW283 release line proves:

- Direct Atomic KCC20 v4 remained complete from the CW282 line.
- Open Atomic KCC20 remained complete from the CW282 line.
- KCC20 Change Ownership was installed, UI-wired, visually integrated, and live-proven on testnet-10 with OMAC.
- Coupon Broadcaster and Energy tools currently warn that their token support is KRC20-only; KCC20 support is deferred to a later update.
- AWS deployment, mainnet live action, and SDK promotion/finalization were not performed in the CW283 release line.

See [`docs/KCC20_SPECIFICATION_V1_1_REVIEW.md`](docs/KCC20_SPECIFICATION_V1_1_REVIEW.md) for the review draft summary. The Word review document with Track Changes is maintained separately for legal/specification review.

## What this repository does not include

This repository does not include production secrets, private keys, passphrases, hosted infrastructure credentials, tenant infrastructure, Compliance Node private internals, Oracle Node private internals, broker-custody private systems, AWS deployment configuration, or Token Depot trademark/branding rights.

## Start here

1. Read `docs/OPEN_SOURCE_COMMERCIAL_MODEL.md` for the open-source/commercial boundary.
2. Read `docs/KCC20_SPECIFICATION_V1_1_REVIEW.md` for the KCC20 v1.1 review summary.
3. Read `docs/SELF_CUSTODY.md` for the Standard Wallet self-custody proof.
4. Read `docs/SWAP_SELF_CUSTODY.md` for Direct/Open swap self-custody scope.
5. Read `docs/TECHNICAL_VERIFICATION.md` for the file-level verification path.
6. Read `docs/CODE_MAP.md` for what each reference file proves.
7. Read `docs/SECURITY.md` for what this proof does and does not claim.
