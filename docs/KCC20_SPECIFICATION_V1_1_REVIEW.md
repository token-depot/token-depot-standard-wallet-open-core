# KCC20 Specification v1.1 Review Summary

This document summarizes the KCC20 Specification v1.1 review draft prepared from the uploaded `KCC20 Specification.pdf` and the CW283 release handoff.

The formatted Word review draft with Track Changes remains the review artifact for legal/specification editing. This Markdown file is a GitHub-readable summary so repository reviewers can understand the update scope.

## Status

Review draft. Not yet approved as a final released standard.

## Baseline source

- Uploaded `KCC20 Specification.pdf`
- CW283 release evidence from `Compliance_Wallet_283_Mac.zip`
- `Module_KCC20_V1_UI_Polish_Change_Ownership_Handoff_2026-07-06.md`

## v1.1 update themes

- Preserve KCC20-Core Reader/Writer model.
- Clarify that KCC20 is implementation-language-neutral.
- Document the OMA L1 / Compliance Wallet v1 implementation profile.
- Document Direct Atomic KCC20 profile.
- Document Open Atomic KCC20 profile.
- Document KCC20 Change Ownership profile.
- State v1 deferred features without over-claiming.
- Clarify that the technical specification is not a software license grant.

## Implementation-language neutrality

KCC20 is a token/covenant compatibility standard, not a proprietary language, compiler, or single implementation path.

A KCC20-compatible token may be implemented with any toolchain that can produce covenant behavior satisfying the specification and the applicable descriptor/profile rules.

SilverScript, Rust, TypeScript tooling over Rusty Kaspa SDK surfaces, or another compiler may be used as implementation paths. A toolchain is not KCC20-compatible by name alone. Compatibility is determined by observable covenant state, descriptor verification, ownership authorization, transfer behavior, and supply rules.

## KCC20-Core summary

KCC20-Core defines a minimal fungible-token interface over Kaspa covenant state.

A KCC20 token state begins with:

```text
KCC20State {
    owner_identifier
    identifier_type
    amount
    is_minter
}
```

The standard ownership modes are:

```text
IDENTIFIER_PUBKEY      = 0x00
IDENTIFIER_SCRIPT_HASH = 0x01
IDENTIFIER_COVENANT_ID = 0x02
```

A Reader observes accepted Kaspa transactions, decodes KCC20 state, verifies transitions, and maintains the live KCC20 UTXO set.

A Writer consumes Reader-provided verified state and constructs valid next-state transactions.

Unknown covenant-bearing UTXOs must not be classified as KCC20 tokens.

## OMA L1 / Compliance Wallet v1 profile

The OMA L1 / Compliance Wallet v1 profile documents the CW283-proven KCC20-compatible application profile.

CW283 v1 status:

- KCC20-compatible Deploy / Issue / Burn pages remain present.
- Issuer/controller can issue according to the implemented profile.
- Burn support exists in the OMA L1/KCC20-compatible application profile; KCC20-Core itself does not require burn support.
- Change Ownership is installed and live-proven.
- Direct Atomic KCC20 swaps are complete from the CW282/CW283 line.
- Open Atomic KCC20 swaps are complete from the CW282/CW283 line.
- Coupon Broadcaster remains KRC20-only in v1.
- Energy tools remain KRC20-only in v1.
- AWS deployment was not performed.
- Mainnet live action was not performed.
- SDK promotion/finalization was not performed in the CW283 release line.

## Direct Atomic KCC20 profile

The Direct Atomic KCC20 profile describes fixed-recipient atomic swaps for KCC20-compatible OMA L1 token holders.

Profile requirements include:

- KCC20-compatible holder state owned by a compact script-hash policy.
- Maker lock construction that locks token quantity under the atomic policy.
- Taker claim path that pays the maker in KAS and releases the KCC20-compatible holder output to the taker.
- Maker cancel/refund path under the implemented v4 policy.
- Tracking records for locked, claimed, refunded, and expired offer states.
- No reliance on stale v1/v2/v3 test artifacts as the v1 product path.

## Open Atomic KCC20 profile

The Open Atomic KCC20 profile describes dynamic-taker KCC20-compatible atomic swaps.

Profile requirements include:

- Maker lock does not bake in a fixed taker token receive address.
- Claim path accepts the dynamic taker output script at claim time and validates it through the policy.
- Maker cancel/refund path remains maker controlled.
- Minimum KAS price guard avoids non-standard low-value maker payout outputs.
- Open Swap offer state supports open, filled, expired, cancelled, and recovery flows.
- Expired recovery popup behavior is part of the user-facing CW282/CW283 line.

## Change Ownership profile

The Change Ownership profile transfers issuer/controller ownership and mint/issue authority for a KCC20-compatible OMA L1 token.

CW283 proved Change Ownership with OMAC on testnet-10:

- Build route requires the active wallet to be the current issuer/controller.
- New owner address must be a same-network OMA PubKey address found in the local wallet store.
- Transaction builds the next controller for the new owner.
- Transaction builds owner-recognition holder/anchor for the new owner.
- Submit updates tracked asset records only after accepted submit and post-submit scan.
- Asset covenant ID, token metadata, policy, and issued supply are preserved.
- The new owner successfully issued after ownership transfer.

## Deferred v1 features

The CW283 v1 release does not include:

- KCC20 Coupon Broadcaster support.
- KCC20 Energy tools support.
- AWS deployment.
- Mainnet live action.
- SDK promotion/finalization as a separate completed module.

The wallet UI warns users that Coupon Broadcaster and Energy tools are currently KRC20-only.

## Publication boundary

This technical specification is not a software license grant.

Repository licensing is handled separately through the repository `LICENSE`, `NOTICE.md`, and commercial license documents.

A KCC20 descriptor, implementation artifact, or compatibility claim does not grant Token Depot trademark rights, hosted-service rights, custody rights, compliance-service rights, or commercial platform rights.
