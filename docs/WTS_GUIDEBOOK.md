# Wallet Trust Stack Guidebook

## Purpose

The Wallet Trust Stack helps developers, customers, auditors, and investors inspect the Token Depot Standard Wallet self-custody boundary.

## WTS v2 scope

WTS v2 proves:

```text
Standard Wallet browser-side key creation
local encrypted keyfile generation
local browser unlock
server watch-only wallet descriptor storage
browser-side Standard Wallet KAS signing
browser-side Standard Wallet KRC-20 commit/reveal signing
browser-side Standard Wallet Direct swap signing
browser-side Standard Wallet Open swap signing
server coordination/broadcast of already-signed artifacts
```

WTS v2 does not prove:

```text
Broker-Custody Wallet self-custody
Compliance Node custody behavior
full hosted platform source availability
production deployment security
```

## Reading order

1. `docs/SELF_CUSTODY.md`
2. `docs/SWAP_SELF_CUSTODY.md`
3. `docs/TECHNICAL_VERIFICATION.md`
4. `docs/CODE_MAP.md`
5. `docs/SECURITY.md`
6. `docs/PUBLIC_PRIVATE_MATRIX.md`

## Review method

Reviewers should compare the claims in the docs against the real files under `reference/`. The docs are a guidebook; the reference source is the evidence.
