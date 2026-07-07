# Wallet Trust Stack / CW284 Open-Core Guidebook

## Purpose

The Wallet Trust Stack helps developers, customers, auditors, and investors inspect the Token Depot Standard Wallet self-custody boundary.

The CW284 open-core package extends the prior WTS v2 reference scope with KCC20-compatible OMA L1 token flows, Direct/Open Atomic KCC20 swap flows, and the finalized Toccata SDK path used by the application.

## CW284 open-core scope

CW284 proves:

```text
Standard Wallet browser-side key creation
local encrypted keyfile generation
local browser unlock
server watch-only wallet descriptor storage
browser-side Standard Wallet KAS signing
browser-side Standard Wallet KRC20 commit/reveal signing
browser-side KCC20-compatible deploy/issue/burn/change-owner signing
browser-side Standard Wallet Direct swap signing
browser-side Standard Wallet Open swap signing
Direct Atomic KCC20 v4 create/claim/cancel boundaries
Open Atomic KCC20 dynamic-taker create/fill/cancel/recovery boundaries
server coordination/broadcast of already-signed artifacts
canonical Toccata SDK import path: wasm/sdk/kaspa-wasm32-sdk/web/kaspa/
```

CW284 does not prove:

```text
Broker-Custody Wallet self-custody
Compliance Node custody behavior
Oracle Node private internals
full hosted platform source availability
production deployment security
AWS deployment
mainnet live action
commercial license grant
trademark or hosted-service rights
```

## Reading order

1. `docs/PUBLIC_PRIVATE_MATRIX.md`
2. `docs/SELF_CUSTODY.md`
3. `docs/SWAP_SELF_CUSTODY.md`
4. `docs/KCC20_SPECIFICATION_V1_1_REVIEW.md`
5. `docs/TECHNICAL_VERIFICATION.md`
6. `docs/CODE_MAP.md`
7. `docs/SECURITY.md`

## Review method

Reviewers should compare the claims in the docs against the real files under `reference/`. The docs are a guidebook; the reference source is the evidence.
