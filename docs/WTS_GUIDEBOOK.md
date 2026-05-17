# Wallet Trust Stack Guidebook

## Purpose

The Wallet Trust Stack exists to help developers, customers, auditors, and investors inspect the Token Depot Standard Wallet self-custody boundary.

## WTS v1 scope

WTS v1 is intentionally narrow. It proves the Standard Wallet key and signing boundary using seven reviewed reference files.

WTS v1 proves:

```text
Standard Wallet browser-side key creation
local encrypted keyfile generation
local browser unlock
server watch-only wallet descriptor storage
browser-side Standard Wallet KAS signing
browser-side Standard Wallet KRC-20 commit/reveal signing
server broadcast of already-signed artifacts
```

WTS v1 does not prove:

```text
Broker-Custody Wallet self-custody
Direct swap self-custody
Open swap self-custody
Compliance Node custody behavior
```

## Reading order

1. `docs/SELF_CUSTODY.md`
2. `docs/TECHNICAL_VERIFICATION.md`
3. `docs/CODE_MAP.md`
4. `docs/SECURITY.md`
5. `docs/PUBLIC_PRIVATE_MATRIX.md`

## Review method

Reviewers should compare the claims in the docs against the real files under `reference/`. The docs are a guidebook; the reference source is the evidence.
