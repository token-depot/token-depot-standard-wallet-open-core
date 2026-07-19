# Compliance_Wallet (CW)

Lean monorepo scaffold for building a **broker-custody Compliance Wallet**, Standard Wallet flows, KRC-20 tooling, PSKT-based swaps, and CN-mediated policy/signing flows.

## Layout
- `rust/` : CW helper modules retained for wallet/PSKT tooling
- `vendor/rusty-kaspa/` : upstream source (no build artifacts)
- `wasm/sdk/` : minimal browser WASM SDK payload for Chrome testing
- `bin/` : local helper binaries (e.g., `kaspa-cli`)

## Quick start (macOS)
```bash
cd ~/Projects/Compliance_Wallet
source scripts/env_mac.sh
./scripts/bootstrap_mac.sh
```

Specs:
- `docs/spec/Compliance_Wallet_Multisig_Spec_Addendum_2025-12-13.md`


## Canonical behavior (Module 3)

### Wallet modes
- **Regular wallet**: normal KAS + KRC-20 wallet behavior (no CN gates).
- **Compliance wallet**: broker-custody wallet flow where CW validates the user/session/unlock state, the local authorization key signs request intents only, and CN applies policy before custody signing and broadcast.

### Enforcement rules
- **Blacklist always applies** (all assets).
- **CN policy applies to Compliance Wallet request intents before custody signing and broadcast.**
- **Whitelist applies only to regulated CA assets**:
  - CN policy `regulated_cas[]` defines which CAs are regulated.
  - If a regulated CA is detected, recipient must be allowlisted.
- **Fail-closed on missing asset identity**: if a KRC-20 transfer is detected but CA/tick identity cannot be extracted, CN rejects.

### Binding
- **Broker ID binds CW to a CN**: Compliance Wallet creation verifies CN reachability and records broker-custody metadata, including the CN custody key reference and the user authorization public key.


