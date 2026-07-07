# KCC20 Specification v1.1 Proposal

**Status:** Public review proposal  
**Prepared by:** Token Depot Corp  
**Release evidence:** CW284 / KCC20 v1 release-candidate line  
**Repository scope:** Token Depot Standard Wallet Open-Core  

This document is a public proposal for KCC20 v1.1. It is intended for review by developers, wallet builders, indexers, explorers, token issuers, exchanges, auditors, and the Kaspa ecosystem.

This proposal is not a final approved standard and is not a software license grant. Repository licensing is handled separately through `LICENSE`, `NOTICE.md`, and the commercial licensing documents.

## 1. Goals

KCC20 defines a minimal fungible-token compatibility interface for Kaspa covenant-based tokens.

The goal is to let independent Readers and Writers agree on:

- how token state is represented;
- how ownership is identified;
- how ownership is authorized;
- how token quantity is tracked;
- how ordinary branches differ from minter branches;
- how transfer state transitions preserve supply;
- how optional profiles such as minting, burn, regulated controls, and atomic swaps are described without making them mandatory for KCC20-Core.

A KCC20-compatible implementation must be verified by observable covenant behavior and descriptor rules, not by the name of its compiler or implementation language.

## 2. Normative terms

The words **must**, **must not**, **should**, **should not**, and **may** are used in their ordinary technical specification sense.

A KCC20-compatible implementation must satisfy the mandatory rules in KCC20-Core and any optional profile it claims to support.

## 3. Implementation-language neutrality

KCC20 is a token and covenant compatibility standard. It is not a proprietary language, compiler, artifact format, or single implementation path.

A KCC20-compatible token may be implemented with any toolchain that can produce covenant behavior satisfying this proposal and the applicable descriptor/profile rules.

SilverScript, Rust, TypeScript tooling over Rusty Kaspa SDK surfaces, or another compiler may be used as implementation paths. A toolchain is not KCC20-compatible by name alone. Compatibility is determined by observable covenant state, descriptor verification, ownership authorization, transfer behavior, and supply rules.

A descriptor may identify the compiler and artifact format used for a specific token. That descriptor field is evidence for verification, not a requirement that all KCC20 tokens use the same compiler.

## 4. KCC20 interface

A KCC20 token is a covenant instance that implements a minimal fungible-token interface on Kaspa.

To be KCC20-compatible, a covenant must:

1. maintain standard token state;
2. identify who owns a token quantity;
3. identify how that ownership is authorized;
4. track the amount of quantity owned;
5. distinguish ordinary token branches from minter branches;
6. provide a transfer entrypoint that follows the KCC20 transfer convention;
7. preserve KCC20 supply rules unless a valid minter branch or approved extension profile authorizes otherwise.

KCC20 interaction can be reduced to two responsibilities:

- determine current KCC20 state;
- create valid next-state transactions.

This naturally separates into Reader and Writer roles.

## 5. Reader role

A Reader observes accepted Kaspa transactions and projects KCC20 state.

Given accepted transactions and token descriptors, a Reader identifies KCC20 activity, decodes token state, verifies state transitions, and maintains the live KCC20 UTXO set.

A Reader must not trust declared state transitions blindly. It must verify that every decoded state corresponds to the actual transaction output script committed on-chain.

Unknown covenant-bearing UTXOs must not be classified as KCC20 tokens.

A Reader should classify unknown covenant-bearing UTXOs conservatively as unknown covenanted KAS until a valid descriptor and state-verification path are available.

## 6. Writer role

A Writer consumes Reader-provided state and user intent.

Given live KCC20 UTXOs, decoded token state, and token descriptors, a Writer constructs valid KCC20 transactions.

A Writer must verify that Reader-provided state still matches the live input script before constructing a transaction.

A generic Writer must fail if it encounters unsupported ownership modes, unsupported extension state, unsupported optional profiles, unsupported descriptor formats, or fan-in/fan-out rules it cannot verify.

A Writer must not guess how to combine custom extension state.

## 7. KCC20 core state

A KCC20 token state must begin with the standard KCC20 state header:

```text
KCC20State {
    owner_identifier
    identifier_type
    amount
    is_minter
}
```

### owner_identifier

`owner_identifier` identifies the party or policy that controls the token state.

Its meaning depends on `identifier_type`.

### identifier_type

`identifier_type` defines how `owner_identifier` is interpreted.

The standard KCC20 ownership modes are:

```text
IDENTIFIER_PUBKEY      = 0x00
IDENTIFIER_SCRIPT_HASH = 0x01
IDENTIFIER_COVENANT_ID = 0x02
```

### amount

`amount` is the token quantity represented by this KCC20 state.

The descriptor must define the exact integer encoding for `amount`.

### is_minter

`is_minter` identifies whether the state is a minter branch.

This field is part of the standard KCC20 header, not extension state, because it changes the supply rules of the token branch.

Ordinary KCC20 branches must not create additional supply.

Minter branches may create supply only according to the token minter or issuer policy.

## 8. Ownership modes

### 8.1 Pubkey ownership

If `identifier_type = IDENTIFIER_PUBKEY`, `owner_identifier` is interpreted as a public key or public-key identifier.

A valid transfer must include authorization proving control of that public key.

### 8.2 Script-hash ownership

If `identifier_type = IDENTIFIER_SCRIPT_HASH`, `owner_identifier` is interpreted as a script hash.

A valid transfer must prove that the transaction includes the required script-hash-controlled witness input.

This allows compact holder policies, atomic swap policies, and other script-owned holder states.

### 8.3 Covenant-ID ownership

If `identifier_type = IDENTIFIER_COVENANT_ID`, `owner_identifier` is interpreted as a covenant ID.

A valid transfer must prove that the transaction includes the required covenant-controlled witness input.

This allows a KCC20 state to be controlled by another covenant.

## 9. Transfer convention

The standard transfer ABI should be described logically as:

```text
transfer(prev_states, next_states, sigs, witnesses)
```

Where:

- `prev_states` are the consumed KCC20 states;
- `next_states` are the successor KCC20 states;
- `sigs` authorize pubkey-owned previous states;
- `witnesses` identify transaction inputs used to authorize script-hash-owned or covenant-ID-owned previous states.

Compiled selectors, leader/delegator wrappers, or artifact-specific entrypoints may exist as implementation details.

The standard should define the logical transfer ABI first. Artifact-level selectors are not the primary standard interface.

## 10. Supply rules

For ordinary non-minter KCC20 transfers:

```text
sum(prev_states.amount) == sum(next_states.amount)
```

A non-minter transfer must not create new token quantity.

A non-minter transfer must not create a successor state with `is_minter = true`.

For minter branches, supply changes are allowed only according to the minter or issuer policy defined by the token descriptor and optional minter profile.

A Reader must reject any state transition that violates the supply rules for the applicable branch type.

A Writer must not construct transactions that violate these supply rules.

## 11. Split and merge

KCC20 transfers may support splitting one token UTXO into multiple token UTXOs.

KCC20 transfers may support merging multiple token UTXOs into one or more token UTXOs.

The descriptor must define supported fan-in and fan-out limits:

```text
max_covenant_inputs
max_covenant_outputs
```

Readers and Writers must reject transitions that exceed these limits.

## 12. Token descriptor

Each known KCC20 token covenant is described by a descriptor artifact.

The descriptor is defined per token covenant ID and provides the information required to identify token UTXOs, decode state, verify transitions, reconstruct covenant outputs, and build valid transfer transactions.

```text
TokenDescriptor {
    standard
    version
    network
    covenant_id
    template_hash
    artifact_hash
    compiler
    source_hash
    state_layout
    state_header
    template_prefix
    template_suffix
    template_prefix_len
    template_suffix_len
    transfer_abi
    entrypoints
    max_covenant_inputs
    max_covenant_outputs
    ownership_modes
    amount_encoding
    covenant_output_order
    optional_profiles
}
```

A descriptor must not be treated as sufficient proof by itself. Readers must still verify on-chain state against descriptor rules.

### Required descriptor meaning

- `standard`: standard name, such as `KCC20`.
- `version`: descriptor format version.
- `network`: Kaspa network for which the descriptor applies.
- `covenant_id`: covenant ID of the KCC20 token covenant.
- `template_hash`: hash of the compiled covenant template.
- `artifact_hash`: hash of the compiled artifact, when applicable.
- `compiler`: compiler/toolchain name and version, when known.
- `source_hash`: hash of the source artifact or source bundle, if revealed.
- `state_layout`: byte-level layout for the standard header and any extension fields.
- `template_prefix` and `template_suffix`: script bytes before and after encoded token state.
- `transfer_abi`: logical ABI for transfer arguments.
- `entrypoints`: implementation-specific selectors or wrapper identifiers.
- `ownership_modes`: supported ownership modes.
- `amount_encoding`: integer encoding used for token amounts.
- `covenant_output_order`: ordering rule for KCC20 successor outputs.
- `optional_profiles`: optional profiles implemented by the token.

## 13. Reader operation

A Reader owns a descriptor artifact for each known KCC20 token covenant.

For each accepted transaction with inputs or outputs matching registered token descriptors, the Reader should:

1. identify candidate KCC20 covenant inputs;
2. decode previous states using the descriptor `state_layout`;
3. identify the transfer declaration or entrypoint;
4. extract declared next-state data;
5. decode next states;
6. reconstruct expected output scripts;
7. compare reconstructed scripts against actual transaction outputs;
8. verify supply rules;
9. verify ownership authorization rules;
10. update the live KCC20 UTXO set only after all checks pass.

The Reader must not trust declared `next_states`.

For each decoded next state, the Reader reconstructs the expected output script and compares it with the actual transaction output scriptPublicKey.

```text
decoded_next_states = decode(next_states_raw, state_layout)
for index, next_state in enumerate(decoded_next_states):
    encoded_state = encode(next_state, state_layout)
    expected_output_p2sh = P2SH(template_prefix || encoded_state || template_suffix)
    output_index = covenant_output_order(index)
    output_p2sh = outputs[output_index].spk
    assert output_p2sh == expected_output_p2sh
```

## 14. Reader verification requirements

For each candidate KCC20 output, a Reader should verify:

- covenant ID;
- template hash;
- state layout;
- standard state header;
- reconstructed output script;
- covenant output order;
- supply invariants;
- ownership authorization;
- optional profile rules.

A Reader must classify unmatched covenant-bearing UTXOs as unknown covenanted KAS, not as KCC20 tokens.

## 15. Writer operation

A Writer queries a Reader for up-to-date token state and descriptor data, then creates a valid transaction according to user intent.

The Writer should:

1. fetch relevant owner token UTXOs from the Reader;
2. verify the Reader indexed decoded state;
3. confirm each input script matches the descriptor;
4. calculate the intended state transition;
5. produce `prev_states`;
6. produce `next_states`;
7. produce required signatures or witness references;
8. create the transfer transaction;
9. set output scripts according to `next_states`;
10. let the user sign the transaction;
11. broadcast the signed transaction to a Kaspa node.

Before building a transaction, the Writer must verify each selected input:

```text
expected_input_p2sh = P2SH(template_prefix || encode(prev_state, state_layout) || template_suffix)
assert input.spk == expected_input_p2sh
```

The Writer then builds the logical transfer arguments:

```text
transfer_arguments = {
    prev_states,
    next_states,
    sigs,
    witnesses
}
```

The Writer sets output scripts according to `next_states`:

```text
for index, next_state in enumerate(next_states):
    encoded_state = encode(next_state, state_layout)
    outputs[covenant_output_order(index)].spk = P2SH(template_prefix || encoded_state || template_suffix)
```

A generic Writer must fail if:

- the descriptor is missing;
- the template hash does not match;
- the state layout is unsupported;
- the ownership mode is unsupported;
- the optional profile is unsupported;
- extension state is present but unsupported;
- fan-in or fan-out exceeds descriptor limits;
- supply rules cannot be verified.

## 16. Extension state

A KCC20 token state may extend the standard KCC20 state header with token-specific state:

```text
encoded_state = encoded_kcc20_state_header || extension_state_bytes
```

Generic Readers are required to understand the standard KCC20 header.

Generic Writers are required to understand the KCC20 transfer convention.

If inputs have different extension state and the Writer does not understand how to merge or transform that extension state, the Writer must fail.

A Writer must not guess how to combine custom extension state.

## 17. Optional profiles

Optional profiles are not required for KCC20-Core compatibility. A token, Reader, or Writer may claim support for a profile only if it understands the profile-specific rules.

### 17.1 KCC20-Minter profile

Minting should be defined as an optional companion profile, not overloaded into the minimal KCC20 transfer interface.

A KCC20-Minter profile defines controlled issuance through a companion covenant.

A minter descriptor should include:

```text
MinterDescriptor {
    standard
    version
    network
    minter_covenant_id
    controlled_kcc20_covenant_id
    remaining_allowance
    initialized
    expected_kcc20_template_hash
    kcc20_template_prefix
    kcc20_template_suffix
    kcc20_template_prefix_len
    kcc20_template_suffix_len
    minter_state_layout
    mint_abi
    entrypoints
}
```

A KCC20Minter state should include at minimum:

```text
KCC20MinterState {
    kcc20_covenant_id
    amount
    initialized
}
```

A minter must be initialized before minting.

A valid mint transition should verify:

- initialized status;
- controlled KCC20 covenant ID;
- expected template hash;
- template prefix and suffix;
- mint amount does not exceed remaining allowance;
- continuing minter branch remains a minter branch;
- recipient branch is not a minter branch;
- next KCC20Minter state has reduced allowance.

A successful mint should produce:

- a continuing KCC20 minter branch;
- a recipient KCC20 token output;
- a next KCC20Minter output with reduced remaining allowance.

The continuing KCC20 minter branch may carry zero amount if minter authority is represented by branch identity rather than spendable token quantity.

### 17.2 Burn profile

Burning may be defined as an optional profile.

A burn profile should specify:

- who may burn;
- whether burn reduces total supply;
- whether burn affects minter allowance;
- whether burn emits a proof output;
- whether burn requires issuer authorization.

KCC20-Core does not require burn support.

### 17.3 Regulated-asset profile

Stablecoin-oriented or regulated-asset controls should be defined as optional profiles.

These may include:

- freeze;
- pause;
- seize;
- blacklist;
- issuer burn;
- forced redemption;
- compliance routing;
- controller approval;
- jurisdictional controls.

These controls should not be required for KCC20-Core compatibility.

A generic Reader may display regulated-profile metadata if it has the descriptor.

A generic Writer must not attempt regulated-profile actions unless it understands the profile-specific rules.

### 17.4 Pausable profile

A pausable profile defines:

- pause authority;
- pause state location;
- affected actions;
- unpause rules.

### 17.5 Freeze profile

A freeze profile defines:

- freeze authority;
- frozen state representation;
- transfer behavior for frozen states;
- unfreeze rules.

## 18. Artifact reveal and explorer support

Explorers, indexers, and wallets should support artifact reveal for KCC20 covenants.

A revealed artifact should include:

- source hash;
- compiler version;
- compiled artifact hash;
- constructor arguments;
- state layout;
- template prefix;
- template suffix;
- template hash;
- covenant ID;
- genesis transaction;
- optional minter descriptor;
- optional profile descriptors.

Unrevealed or unmatched covenant outputs must remain classified as unknown covenanted KAS, not KCC20.

## 19. Descriptor registry

A descriptor registry may be maintained by explorers, wallets, issuers, or independent indexers.

A registry entry should include:

- token name;
- symbol;
- decimals;
- network;
- covenant ID;
- descriptor hash;
- artifact hash;
- template hash;
- issuer information, if disclosed;
- genesis transaction;
- profile list;
- verification status.

A registry entry is not sufficient proof by itself. Readers must still verify on-chain state against descriptor rules.

## 20. Unknown covenants

A covenant-bearing UTXO whose descriptor is missing or unverifiable must be treated as unknown covenanted KAS.

It must not be shown as a KCC20 token, spendable token balance, verified token holding, mint authority, or regulated asset unless descriptor and state verification succeed.

## 21. OMA L1 / Compliance Wallet v1 implementation profile

This section documents the CW284-proven OMA L1 / Compliance Wallet v1 implementation profile. It does not change KCC20-Core requirements.

CW284 v1 status:

- KCC20-compatible Deploy / Issue / Burn pages remain present.
- Issuer/controller can issue according to the implemented profile.
- Burn support exists in the OMA L1/KCC20-compatible application profile; KCC20-Core itself does not require burn support.
- Change Ownership is installed and live-proven from the CW283 line, then retained in CW284.
- Direct Atomic KCC20 swaps are complete from the CW282/CW283 line and retained in CW284.
- Open Atomic KCC20 swaps are complete from the CW282/CW283 line and retained in CW284.
- Coupon Broadcaster remains KRC20-only in v1.
- Energy tools remain KRC20-only in v1.
- SDK promotion/finalization is complete in CW284.
- AWS deployment is not included in this publication package.
- Mainnet live action is not included in this publication package.

## 22. CW284 SDK promotion/finalization

CW284 finalized the active Toccata SDK path:

- Active Toccata imports point at `wasm/sdk/kaspa-wasm32-sdk/web/kaspa/`.
- The canonical SDK package reports `kaspa-wasm` version `2.0.1`.
- The duplicate `kaspa-wasm32-sdk-toccata-v2` path was removed from the active architecture.
- Runtime route guards and local typecheck were proven clean after SDK promotion.

This SDK status does not imply AWS deployment, mainnet action, hosted-service availability, custody-service availability, or commercial license rights.

## 23. Direct Atomic KCC20 profile

The Direct Atomic KCC20 profile describes fixed-recipient atomic swaps for KCC20-compatible OMA L1 token holders.

Profile requirements include:

- KCC20-compatible holder state owned by a compact script-hash policy;
- maker lock construction that locks token quantity under the atomic policy;
- taker claim path that pays the maker in KAS and releases the KCC20-compatible holder output to the taker;
- maker cancel/refund path under the implemented v4 policy;
- tracking records for locked, claimed, refunded, and expired offer states;
- no reliance on stale v1/v2/v3 test artifacts as the v1 product path.

## 24. Open Atomic KCC20 profile

The Open Atomic KCC20 profile describes dynamic-taker KCC20-compatible atomic swaps.

Profile requirements include:

- maker lock does not bake in a fixed taker token receive address;
- claim path accepts the dynamic taker output script at claim time and validates it through the policy;
- maker cancel/refund path remains maker controlled;
- minimum KAS price guard avoids non-standard low-value maker payout outputs;
- Open Swap offer state supports open, filled, expired, cancelled, and recovery flows;
- expired recovery popup behavior is part of the user-facing CW282/CW283/CW284 line.

## 25. Change Ownership profile

The Change Ownership profile transfers issuer/controller ownership and mint/issue authority for a KCC20-compatible OMA L1 token.

CW283 proved Change Ownership with OMAC on testnet-10, and CW284 retains that application path:

- build route requires the active wallet to be the current issuer/controller;
- new owner address must be a same-network OMA PubKey address found in the local wallet store;
- transaction builds the next controller for the new owner;
- transaction builds owner-recognition holder/anchor for the new owner;
- submit updates tracked asset records only after accepted submit and post-submit scan;
- asset covenant ID, token metadata, policy, and issued supply are preserved;
- the new owner successfully issued after ownership transfer in the CW283 proof line.

## 26. Deferred v1 features

The CW284 v1 release-candidate publication does not include:

- KCC20 Coupon Broadcaster support;
- KCC20 Energy tools support;
- AWS deployment;
- mainnet live action.

The wallet UI warns users that Coupon Broadcaster and Energy tools are currently KRC20-only.

## 27. Publication boundary

This technical proposal is not a software license grant.

Repository licensing is handled separately through the repository `LICENSE`, `NOTICE.md`, and commercial license documents.

A KCC20 descriptor, implementation artifact, or compatibility claim does not grant Token Depot trademark rights, hosted-service rights, custody rights, compliance-service rights, commercial platform rights, AWS deployment rights, broker/custody rights, or hosted infrastructure rights.

## 28. Public review questions

Reviewers are invited to comment on:

1. whether the Reader/Writer split is sufficiently implementation-neutral;
2. whether the ownership modes are complete for near-term Kaspa covenant-token use;
3. whether Descriptor requirements are strict enough for explorer/indexer safety;
4. whether generic Writers should support any optional profile by default;
5. whether Direct/Open Atomic KCC20 should remain optional profiles rather than KCC20-Core behavior;
6. whether additional descriptor fields are needed for regulated-asset profiles;
7. whether unknown-covenant display rules are sufficiently conservative.
