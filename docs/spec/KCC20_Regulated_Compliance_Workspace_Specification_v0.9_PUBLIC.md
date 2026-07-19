# KCC20-Regulated Compliance Workspace Specification v0.9

**Status:** Controlling Implementation Specification — Testnet-10 compact regulated fungibility, user-scoped Demo Policy governance, stable Registry lineage, zero-supply Deploy, Issue, full/partial transfer, aggregation, freeze/unfreeze, holder-signature-free seizure, third-party and issuer/controller self-custody Forced Burn, automatic controller-supply accounting, Token Metadata, user-scoped Audit, and final regulated read-only closure are implemented and proven; standard KCC20, chooser, and existing Direct/Open swap non-degradation regressions remain required before release-candidate packaging  
**Date:** 2026-07-17  
**Supersedes:** v0.8  
**Implementation rule:** This document is the controlling design source for subsequent KCC20-Regulated Testnet-10 release work. No new holder format, route family, wallet, signer, SDK bridge, transaction builder, Registry store, policy store, funding selector, Audit service, or mainnet architecture may be introduced unless current-source forensics prove the existing canonical path cannot satisfy an approved requirement.

## Current implementation baseline

```text
Compliance_Wallet_297_Mac.zip
SHA-256: 950c8537d1c1730456ad2b51a8d0a675b2bed167036e8f09de85c839882925db

Compliance_Node_102.zip
SHA-256: 7d7e3984e8fd2e1791c33e53041074dad6a82bc9650f02cd686c9f6a62a94a83

token-depot-standard-wallet-open-core-CW284.zip
SHA-256: 43c8a56a2e6e80e7c6025eecd2687d1d841d478c33e7c02915b450686c77db96

What_the_SDK_Requires_v2-20.zip
SHA-256: 4277504a3d71679e82f7b2143827454005a70f24b7d5cc31b4d9d0e22fd8f7ba
```

## Current key source pins

```text
server/src/server.ts
4ae44a22c561710023894c8d8032e23a706aeea12402d5822e49fe50857e3f2c

server/src/routes/wallet_send.ts
7b8d1d93bc427826ff3ec060fa028c4f31d987e74a46237d211f022ba2bbd93a

server/src/routes/krc20_deploy.ts
418272789576fb40ee0d1085fe31db40af90d0269010b9f3e10a3924d0e1b10e

server/src/routes/krc20_issue.ts
23123dd45db2a6ae85485d0a84d46b2efb028be9991881ddb484758e504659e4

server/src/routes/krc20_chown.ts
10cc5f37275921e655475e6cd14fd2773408e6eb6c51a58921d6084f3bed3089

server/src/routes/swap_mode_direct.ts
21f0be335c1edd0c8c62293d72cc7a102d112df5ad52127426c96df5021e7d51

server/src/routes/swap_mode_open_v2.ts
59bdbe381d62b21451105d87d3bcebc93f77cb2603463eb5a98aaeda47d9fade

server/src/routes/open_swap_send.ts
960b2a49294cf64c6fe4306f3a98b75eb6635a13d48ce9015cefb04681f751d3

server/src/routes/tn10_faucet.ts
5684ec18f686f3dbb83e7dc7b19cc47627953149fc5125ab740695245e8cb83c

kcc20-regulated-deploy.html
f8973cd521eb5ee1958bff1b421325baf35919e3345917e64b130f29717821df

static/js/kcc20-deploy-ui.js
da4432341c6f0e1d1114629f1cb84809be64f91ceea9ffdaf07bb406ac391664

static/js/kcc20-issue-ui.js
e133fab30b9410f0b1e1e8ca36c3e4f8b0cc505ee623fa7361f08f8fa49050fb

static/js/kcc20-regulated-deploy-ui.js
48b68f20ee02ca46e74f39c7fddec1f73bd3081ace87d56f5f4a30901557b352

static/js/wallet.js
08a24bcbf64e548273c7763afa9562ebc02e36edc5535785bca6a31be2f2b19a

static/js/swaps.js
e713b11b03255d9ad5a6705d33c8094a7160449e2e9b8fc6bd05c38cb1b67e01

static/js/covenants-ui.js
8001941cf5c8955fcdcb21700864608c1449e2a9989db859163ce7c2b9ac4c59
```

## Current user-scoped data pins

```text
data/users/<userId>/kcc20-regulated-demo-policy.v1.json
31f65ff567c28efdce449e6eb115b3e8e08d8f23b90637d7fe31eb4fffcdb7d2

data/users/<userId>/oma-l1-policy-registries.v1.json
904f7676d29282654535cc71e9ab25ce11d3a42ba10ac9a732d572417b4e447c

data/users/<userId>/oma-l1-assets.v1.json
0ca7c4ff5b42b37081ad37b015115450aedab5c6675ab4b9d7137800560db4f9

data/users/<userId>/oma-l1-issuance-authorizations.v1.json
23504c96144d3f5a3278b2d8a8671ddaa0b0191eb748d11656a33f6ca37cfd18

data/users/<userId>/oma-l1-burns.v1.json
b3e50507ac1fe4058fdf5ca5342d4698e8fcbc510c9ca5843a12cfd531c93972

data/users/<userId>/kcc20-regulated-audit.v1.json
3c9967395b69082ed489a6b94df979794458060362d4641cfc601def8d997b99
```

## Canonical SDK pin

```text
name=kaspa-wasm
version=2.0.1

wasm/sdk/kaspa-wasm32-sdk/web/kaspa/package.json
bf8803c374153e655b9d81023f7ea2027874960214cb1f09da46aa4edd3fe7bc

wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.d.ts
6ca3c27d6f16921d9ade8147cc454cc54c59b7e08b9570578b9b96af0c8a57ab
```

The current local `kaspa.d.ts` and successful TypeScript proof remain the only authority for allowed SDK methods, constructors, fields, opcodes, and witness shapes.

## Current live Testnet-10 governance, token, control, and Audit artifacts

```text
Active user Registry covenant ID:
ebb695a09ae38ba3be74e9c8ec61e79405332923b17fc4ee79b7d433bdf22362

Current saved Demo Policy epoch:
23

Current saved Demo Policy rulebook root:
7d6f1330184472a24ffe9e98981fafcade9eb6352710f6c009653c09de662653

Current saved Demo Policy source snapshot:
6787d5f6a46323ad269a78599593f1fb31248d6c1c23ed127ef915bfd67471eb

Current Registry outpoint:
cec360ed288a337e58044bd66b32e04e4c9ae434d33722490ce451130835e774:1

Compact fungibility proof token REGT1:
067b41b7210205a7310dd3b9c98a93cf93af06af00234069ee34733078afcb2b
issued supply: 10000 raw

Control proof token REGT2:
d6439abbde890156102a382cae57629bbeba4c1b4f2c4f4886d86b2ddde0e5a2
issued supply: 9000 raw
pending burn receipts: 0
pending supply actions: 0

Fresh release-regression token REGT3:
55425fc01cdaf4ec039d898161c3c904ed7dc45c069cfa41bf7df25888231df8
issued supply: 9000 raw
current controller outpoint:
b1f6c644a0ba14bdf7503a8f822669682d297fb8534c9e11f6d6272238399801:0
pending burn receipts: 0
pending supply actions: 0

REGT3 third-party Forced Burn DO9:
a906248dd7c55f2be8a0b4813fe1bad01193a96c671736348445327f25cdd876
controller-supply update:
cf88fadc2543484b82236d16bbb5d16de4d11a439b21fbb46cb82260ade36e9b

REGT3 issuer/controller self-custody Forced Burn DO10:
cec360ed288a337e58044bd66b32e04e4c9ae434d33722490ce451130835e774
controller-supply update:
b1f6c644a0ba14bdf7503a8f822669682d297fb8534c9e11f6d6272238399801
```

Current Audit projection:

```text
raw journal records:          94 immutable events
journal hash chain:           verified
total projected events:       132
live verified:                32
rejected:                     2
unresolved pending actions:   0
current policy epoch:         23
source manifest:              5/5 canonical sources available; 6 files present
historical coverage:          partial historical projection
```

## Post-bundle final regulated closure proof

```text
proof_kind:
KCC20_REGULATED_FINAL_CLOSURE_PROOF_READONLY_V3

expected_result: true
assertions_passed: 51

script SHA-256:
871e0cf5c07f668092f0e02d757f77275c48f62ca3ae16a0e87e741c7692411a

ZIP SHA-256:
7198909b91905ee55793a846a5fa8cd19739073389e4f9227fac16560a408b89
```

The closure proof verified REGT3 supply `9000`, zero pending burn receipts, zero pending supply actions, the Audit hash chain and zero unresolved pending actions, DO10 self-custody authorization, and Controls-tab selector refresh. The proof sent no Registry-recovery POST to the server; its one recovery response was provided in memory from already verified read-only data. No transaction, signing, submit, broadcast, mint, or policy mutation occurred.

---

## 1. Purpose and immediate priority

KCC20-Regulated extends the mature KCC20-compatible OMA L1 token stack with user-controlled Testnet-10 rulebooks, stable Registry commitments, compact regulated state, real Testnet control actions, live supply reconciliation, and user-scoped Audit evidence.

The compact regulated product architecture is implemented and the final regulated read-only closure has passed. The immediate priority is release regression and packaging, not new architecture or feature expansion.

The proven Testnet architecture is:

```text
user-scoped Demo Policy
-> deterministic epoch/root
-> stable user-owned Registry lineage
-> zero-supply compact regulated Deploy
-> regulated Issue
-> full/partial transfer and holder aggregation
-> freeze/unfreeze policy publication
-> Registry-authorized seizure or Forced Burn
-> automatic controller-supply accounting
-> live verification, tracking, Holdings, Token Metadata, and Audit
```

The product remains non-custodial. Users and Registry authorities retain their wallet keys. Compliance Node does not become a broker custody wallet.

The current Testnet enforcement model must be described accurately:

```text
Compliance Node
-> production-oriented policy authoring, normalization, publication, and history

Compliance Wallet server
-> Testnet Demo Policy execution
-> transaction planning
-> exact-plan caching and submit revalidation
-> live verification, tracking, and Audit projection

Browser wallet
-> local custody and signatures

Holder covenant
-> ordinary owner-signature branch
-> Registry-authorized control branch for control-enabled holders

Registry covenant
-> Registry-authority signature and stable lineage continuity

Kaspa L1
-> script enforcement, covenant identity, UTXO consumption, and settlement
```

This is server-evaluated Testnet policy with browser-local signing and covenant-backed authorization and lineage constraints. It is not a claim that the covenant independently executes the complete rulebook or that the current product is mainnet rogue-wallet-resistant.

The next approved work is limited to:

```text
standard KCC20 end-to-end regression
-> KAS/KRC20/Programmable-KAS chooser regression
-> existing Direct/Open KCC20 swap non-degradation regression
-> final source/data/hash and banned-pattern sweep
-> final Testnet Audit export
-> release-candidate packaging
-> AWS deployment under a separate approved module
```

## 2. Normative language and implementation authority

The words **must**, **must not**, **should**, **should not**, and **may** are normative.

Implementation authority is ordered as follows:

1. this approved v0.9 specification and approved successor handoffs;
2. current SHA-256-pinned working bundles and post-bundle file hashes;
3. current repository source and user-scoped ledgers;
4. current local `kaspa.d.ts` and successful TypeScript proof;
5. approved Testnet-10 runtime proof.

External proposals, compiler experiments, open-ICC discussions, SDK documentation, or architectural concepts may inform design. They do not override the current Source of Truth.

If a method, constructor, field, opcode, route shape, response shape, witness shape, state schema, funding-selection rule, tracking shape, or Audit projection rule is not proven in the current source and local typings, it is not permitted in implementation planning or code.

Work must stop when:

- a Source-of-Truth hash is mismatched;
- ZIP integrity fails;
- an approved anchor is missing;
- a target file is outside the approved Change Budget;
- a proposal duplicates a working canonical path;
- a proof artifact is mistaken for an application defect;
- a proof-only simplification would reduce existing KCC20 behavior;
- syntax, TypeScript, mass, standardness, or runtime proof fails;
- a transaction would reuse an already-consumed control source or repeat an already-successful burn or control action;
- an immutable Audit journal record would be rewritten merely to change its projected lifecycle status;
- a secret, signer, private key, seed, passphrase, Admin Token, API key, signed transaction, signature script, redeem script, submit token, or custody material would be exposed.

## 3. Critical v0.9 corrections

### 3.1 Reuse the mature KCC20 lifecycle

The Testnet regulated product must continue reusing the existing KCC20-compatible lifecycle:

```text
existing Deploy route family
existing Issue route family
existing holder-transfer route family
existing holder-burn and controller-supply-burn route families
existing Change Ownership route family
existing browser-local signer
existing submit caches and exact-plan validation
existing fee and mass convergence
existing tracked-asset and burn-receipt ledgers
existing Inspector, Holdings, Token Metadata, and Audit reconstruction
```

The regulated implementation adds policy state, policy decisions, Registry-authorized control branches, and Audit evidence. It does not create a second token system.

### 3.2 Compact state remains the active Testnet target

The active controller and holder state schemas remain:

```text
controller: oma_l1_token_controller_state_v2
holder:     oma_l1_token_holder_state_v2
```

The complete regulated profile remains:

```text
rg / rv / pr / pe / fc
```

The control-enabled `regulated_registry_control_v1` profile is a holder **script profile** using the existing compact state schema. It is not a replacement token-state schema.

### 3.3 Exact responsibility boundary

| Layer | Current responsibility | Not claimed |
|---|---|---|
| Compliance Node 102 | Admin-controlled policy editing, normalization, epoch/root calculation, persistence, publication, and administrative history for its policy source | It does not build, sign, broadcast, seize, burn, or authorize the current user-scoped Testnet transactions |
| Compliance Wallet server | Resolves Demo Policy and Registry, evaluates allow/deny/freeze state, constructs exact transactions, caches plans, revalidates at submit, verifies live results, updates tracking, and projects Audit evidence | Its ordinary policy checks are not independently executed by every covenant branch |
| Browser wallet | Keeps keys local and signs only approved indexes | It does not decide legal validity or independently execute the rulebook |
| Ordinary holder branch | Requires the current holder signature and commits compact state | It does not read the Demo Policy, blacklist, freeze list, or Registry root |
| Control-enabled holder branch | Permits a holder-signature-free spend only with the referenced Registry lineage and Registry-authority authorization | It does not independently validate a lawful order, frozen state, burn amount, or destination |
| Registry covenant | Requires Registry-authority authorization and preserves Registry covenant-ID continuity | It does not independently prove every server-side epoch/root or legal-policy assertion |
| Kaspa L1 | Enforces signatures, scripts, UTXO consumption, covenant identity, and settlement | It does not determine licensing, identity status, or legal validity |

### 3.4 Compact fungibility is complete for the Testnet target

The proven compact regulated path supports:

- full transfer;
- partial transfer;
- recipient output plus sender change;
- multiple compatible holder-input aggregation;
- sending between allowlisted OMA wallets;
- return transfer;
- build-time and submit-time policy revalidation;
- Inspector and Holdings recognition.

No new holder format or fixed input ceiling is authorized.

### 3.5 Testnet Controls and canonical refresh are implemented

The current Testnet product has proven:

- freeze and unfreeze through Demo Policy epoch changes and Registry publication;
- frozen-recipient, frozen-sender, and frozen-source rejection through the canonical transfer path;
- holder-signature-free seizure for a control-enabled token;
- holder-signature-free third-party Forced Burn for a frozen control-enabled holder;
- holder-signature-free issuer/controller self-custody Forced Burn under a Demo Lawful Order without requiring the issuer wallet to freeze itself;
- same Registry covenant-ID continuity through seizure and Forced Burn;
- exclusion of KAS, KRC20, standard KCC20, non-control-enabled regulated holders, and wrong-authority wallets from lawful-control routes;
- canonical Controls-tab asset and Registry refresh without a reload fallback;
- automatic selector refresh after successful Freeze or Unfreeze.

These are Testnet demonstration controls. The UI and proof output must continue labeling them demo-only, production-ineligible, and not evidence of legal validity.

### 3.6 Forced Burn is a two-stage accounting lifecycle

The approved Forced Burn model is:

```text
Stage 1 — holder control spend
approved control-enabled holder
+ Registry input
+ Registry-authority signature
-> burned holder amount removed
-> optional holder remainder
-> same Registry lineage recreated
-> accepted burn receipt

Stage 2 — controller-supply accounting
accepted burn receipt
+ current controller
+ approved native funding
-> successor controller with reduced issued supply
-> receipt marked controller-supply-updated
```

A successful Stage 1 burn must never be repeated merely because Stage 2 remains pending.

Both the historical REGT2 pending receipt and the fresh REGT3 DO9/DO10 receipts are closed. Token Metadata and Audit must report zero unresolved supply actions when all exact terminal evidence exists.

### 3.7 Regulated ordinary Burn is prohibited

The ordinary KCC20 holder-Burn build and submit routes must reject a regulated token and direct the workflow to the regulated lawful-order Forced Burn path.

The required rejection is:

```text
kcc20_regulated_holder_burn_requires_lawful_order_path
```

UI filtering alone is not a sufficient boundary. The server must fail closed for direct API requests and remove any cached regulated ordinary-Burn plan encountered at submit.

### 3.8 Issuer/controller self-custody Forced Burn

The Forced Burn authorization basis is one of:

```text
frozen_holder
issuer_controller_self_custody
```

For a third-party target, the target holder must be frozen under the current published Demo Policy.

For the active issuer/controller wallet burning regulated tokens it already holds under a Demo Lawful Order, the freeze requirement may be waived. This waiver does not remove any other requirement: governed asset, current policy and Registry, control capability, order reference, issuer/controller authority, Registry authority, Registry-authority signature, no holder signature, exact-plan validation, Audit evidence, and controller-supply accounting remain mandatory.

The cached authorization basis and `freeze_requirement_waived` value must be revalidated at submit.

### 3.9 User-scoped Audit is canonical and append-only

The Audit implementation reuses the canonical user-scoped ledgers plus one append-only hash-chained journal. It does not create a replacement transaction ledger, SQL database, external database, or second Audit service.

Immutable journal records retain their original lifecycle stage and outcome. A read-only projection may classify an intermediate event as informational only when exact later terminal evidence resolves it. The journal itself must not be rewritten to make pending counts appear clean.

### 3.10 Token Metadata is a required read-only product surface

The regulated workspace must expose a Token Metadata card that reports live-verified:

- token identity and covenant ID;
- maximum and issued supply;
- controller identity and outpoint;
- Registry ID, policy epoch, root status, and control flags;
- pending burn-receipt/controller-supply actions;
- consistency status between issued supply and pending actions.

Metadata retrieval must remain read-only and must not build, sign, submit, write, or expose secrets.

### 3.11 Native KAS funding is mass-aware

Simplistic smallest-singleton or largest-singleton funding heuristics are not the canonical architecture.

The required funding process is:

```text
eligible ordinary uncovenanted KAS UTXOs
-> deterministic bounded candidate sets
-> exact transaction construction
-> signer-equivalent placeholder signature scripts
-> fee convergence
-> standard-mass and standardness check
-> reject failed candidates
-> select the first deterministic successful candidate
```

The resulting plan may contain zero, one, or multiple native funding inputs. Server cache, submit validation, and browser signer must agree on the exact ordered indexes and outpoints.

### 3.12 Exact-source single-input routes remain valid

A route that consumes one exact live covenant source—such as a locked refund, release, or recovery—may correctly use input index `0` or `signInputIndexes: [0]` when that index represents the exact covenant source rather than a native-funding chooser.

Such routes must not be rewritten merely because a broad grep finds a single-input signing plan.

### 3.13 Fresh REGT3 lifecycle is the regulated release baseline

The fresh REGT3 regression proved:

```text
zero-supply Deploy
-> automatic asset enrollment
-> exactly one new policy epoch
-> same-Registry publication
-> Issue-tab automatic reload
-> Issue
-> allowed transfer
-> freeze/unfreeze transfer enforcement
-> holder-signature-free seizure
-> third-party holder-signature-free Forced Burn
-> automatic controller-supply update
-> issuer/controller self-custody Forced Burn
-> automatic controller-supply update
-> Holdings / Token Metadata / Audit reconciliation
```

REGT3 issued supply is `9000 raw`; pending burn receipts and pending supply actions are both zero. No additional REGT3 transaction is required or permitted for closure.

### 3.14 Final regulated read-only closure passed

The final read-only closure passed with `51` assertions. It verified wallet/network/SDK readiness, policy epoch `23`, REGT3 governance and supply, zero pending burn and supply actions, DO10 self-custody authorization, Audit chain integrity and zero unresolved pending actions, Controls-tab selector population, and both lawful-order unlock states.

No Registry-recovery POST reached the server during the proof, and no transaction, signing, submit, broadcast, mint, or policy mutation occurred.

### 3.15 Mainnet architecture remains deferred

The current Testnet product must not be advertised as complete mainnet bypass-resistant compliance. Distributed production enforcement, node topology, quorum, cryptographic authorization, recovery, service levels, and regulator-grade Audit remain customer-driven future work.

## 4. Product boundary

### 4.1 Testnet-10 demonstration

Testnet-10 is the current implementation and proof environment.

A Testnet user may:

- create, load, edit, reset, save, and export one user-scoped Demo Policy;
- deploy and update one user-owned Registry lineage;
- deploy one or more regulated Testnet tokens referencing that Registry;
- add those asset covenant IDs to the same Demo Policy;
- update the same Registry to publish the new epoch and root;
- issue regulated supply;
- send full or partial amounts through the existing holder-transfer path;
- aggregate multiple holder UTXOs when required;
- test allowed and blocked recipients;
- test freeze and unfreeze policy publication;
- perform real holder-signature-free seizure and forced burn with a control-enabled Testnet token;
- inspect Token Metadata and pending supply actions;
- review user-scoped Audit evidence after the Audit module is implemented.

Testnet access does not authorize production issuance, constitute regulatory approval, or prove mainnet bypass resistance.

### 4.2 Mainnet production

Mainnet KCC20-Regulated deployment, issuance, transfer authorization, Controls, Audit, and recovery are deferred.

They require a future specification based on an identified customer or operator and must include:

- dedicated production Compliance Wallet and Compliance Node infrastructure;
- approved policy authority and operating procedures;
- distributed policy availability and decision integrity;
- covenant-verifiable authorization or another proven bypass-resistant mechanism;
- production Audit, recovery, incident, and governance procedures;
- a separate Token Depot software lease or approved commercial agreement.

A local Testnet Demo Policy or Testnet authorization must never satisfy a mainnet gate.

### 4.3 Custody boundary

KCC20-Regulated remains non-custodial:

- users retain wallet keys;
- Compliance Wallet builds and signs transactions locally;
- Demo Policy and Registry records are policy data, not custody material;
- Compliance Node does not hold user token funds;
- Broker Custody Wallet paths remain separate KRC20 architecture and must not be reused as the KCC20-Regulated target.

---

## 5. User classes

### 5.1 Testnet-10 Demo Policy owner

An authenticated Testnet user may:

- maintain one isolated Demo Policy;
- deploy and update one Registry lineage owned by the active wallet;
- deploy and issue tokens governed by that Registry;
- edit the policy governing those tokens;
- test transfer decisions and later Controls;
- review and export user-scoped Audit records.

### 5.2 Standard OMA holder

A holder may:

- hold regulated tokens governed by another user's Registry;
- view the governing Registry ID, policy epoch, control flags, and verification status;
- receive tokens when the issuer's governing rulebook allows;
- send full or partial amounts when that governing rulebook allows;
- receive explicit rejection reasons.

Receiving a token does not transfer authority over the issuer's rulebook.

### 5.3 Future production operator

A future production operator is outside the current implementation scope. Its authority, distributed infrastructure, licensing, governance, and service obligations will be defined in a customer-specific production specification.

---

## 6. Existing-stack and compatibility requirements

KCC20-Regulated must extend the mature canonical stack.

The implementation must reuse the existing:

- active-wallet reader;
- `kaspa-wasm 2.0.1` SDK bridge;
- browser-local signing lifecycle;
- KCC20 Deploy build and submit routes;
- KCC20 Issue build and submit routes;
- holder-transfer build and submit routes;
- holder burn and controller-supply burn routes;
- Change Ownership build and submit routes;
- transaction builders, mass calculation, fee convergence, and funding selection;
- submit caches and exact signed-plan validation;
- `oma_l1_assets.v1.json` tracking architecture;
- `oma-l1-policy-registries.v1.json` Registry tracking architecture;
- `oma-l1-issuance-authorizations.v1.json` authorization-consumption architecture;
- user-scoped `data/users/<userId>/...` storage model;
- Inspector and Holdings reconstruction;
- existing Swaps and Offers compliance presentation when regulated swaps are later addressed.

The implementation must not create a parallel regulated wallet, signer, SDK bridge, route family, asset ledger, Registry ledger, policy service, or transaction-builder family without explicit replacement approval.

### 6.1 Standard KCC20 backward compatibility

```text
regulated profile absent
-> use existing standard KCC20 behavior unchanged

complete valid regulated profile present
-> use the regulated Testnet path and preserve the profile

partial or malformed regulated profile
-> reject explicitly
-> never fall back to standard KCC20
```

Existing standard tokens must retain their current Deploy, Issue, transfer, aggregation, sender-change, burn, Change Ownership, tracking, reconstruction, swaps, and verification behavior.

### 6.2 No retroactive conversion

A standard token must not be silently reclassified as regulated.

The current H2 artifacts must not be silently converted to compact regulated holders.

A clean Testnet proof requires a newly deployed zero-supply token and newly issued compact regulated holder.

---

## 7. Workspace and guided Testnet flow

The workspace remains:

1. Overview
2. Rulebook Lab
3. Deploy
4. Issue
5. Controls
6. Audit

The required Testnet sequence is:

```text
Load Demo Policy
-> edit policy
-> Calculate Changes
-> Save New Epoch
-> deploy or update the same Policy Registry
-> deploy zero-supply regulated token
-> add its asset covenant ID to the policy
-> Save New Epoch
-> update the same Registry
-> issue a compact regulated holder
-> send a partial amount to an allowed recipient
-> recognize recipient and sender-change holdings
-> aggregate multiple holders in a later send when needed
-> send an amount back
-> prove blocked and frozen transfer rejection
-> publish freeze/unfreeze epochs
-> perform controlled seizure or Forced Burn with a control-enabled token
-> complete controller-supply accounting
-> review and export unified Audit evidence
```

### 7.1 One primary action per stage

The visible primary actions remain:

```text
Save New Epoch
Deploy Policy Registry
Deploy Regulated Token
Issue Regulated Tokens
Send
Apply Control
Export Audit
```

Internally, build, local signing, submit, and live verification remain distinct security stages. A primary action may orchestrate existing functions in sequence but must stop immediately on any failed stage.

### 7.2 Overview

Overview must show:

- Testnet-10 network state;
- active wallet;
- Testnet Local Demo Policy mode;
- saved policy epoch, source snapshot, and root;
- active Registry identity and live publication status;
- current next required step;
- clear production and mainnet limitations.

### 7.3 Rulebook Lab

Rulebook Lab manages the user's one Demo Policy and must include:

- regulated asset covenant IDs;
- recipient allowlist;
- recipient blacklist;
- frozen holders;
- frozen outpoints;
- lawful-order actions only after a deterministic schema is approved;
- Calculate Changes;
- Save New Epoch;
- Reload Saved Values;
- Export Calculated Draft;
- publication status against the user's Registry.

A field edit does not create an epoch. Calculation does not create an epoch. A materially changed Save creates exactly one next epoch.

Rulebook Lab must not present a simulated transfer as if it were a real transaction. Policy preflight may explain allow or deny results, but successful transfer demonstrations use the real holder-transfer lifecycle.

### 7.4 Deploy

Deploy must reuse the existing regulated Deploy workflow and keep initial regulated supply fixed at zero.

The user provides token identity and approved carrier or fee values. Policy root, source snapshot, Registry ID, epoch, and control flags should be loaded from the saved and published Demo Policy state.

### 7.5 Issue

Issue remains inside the regulated workspace and reuses the existing Issue lifecycle.

The Testnet interface contains:

- selected regulated token;
- current policy and Registry verification;
- Issue Amount (RAW);
- Recipient OMA Address;
- Holder Carrier (KAS);
- `Issue Regulated Tokens`.

The Testnet path does not require an EVM deposit, Fireblocks account, provider endpoint, API key, vault address, or external transaction ID.

### 7.6 Controls

Testnet Freeze, Unfreeze, Seizure, and Forced Burn are implemented for the approved compact/control-enabled path.

The Controls UI must:

- require the correct Registry-authority wallet;
- require a saved and published Demo Policy;
- recover the current Registry and refresh canonical issuer-controlled regulated assets when the tab opens;
- repopulate Seizure and Forced Burn selectors after successful Freeze or Unfreeze;
- show the target asset, holder, amount, policy epoch, Registry, order reference, and authorization basis;
- distinguish ordinary holder-signed actions from Registry-authorized control actions;
- distinguish `frozen_holder` from `issuer_controller_self_custody` Forced Burn authorization;
- stop on any policy, authority, source, mass, signing, submit, or live-verification failure;
- show success separately from a pending controller-supply update;
- instruct the user not to repeat an already-successful Forced Burn.

The canonical refresh must not use a reload fallback, redirect, polling loop, `eval`, or parallel control-asset route.

### 7.7 Audit

The user-scoped Audit workspace is implemented and must provide:

- journal-chain integrity status;
- summary counts and current unresolved pending actions;
- source-manifest completeness;
- policy, Registry, Deploy, Issue, transfer, Control, burn, and supply-accounting evidence;
- filters and expandable evidence that remains contained within the workspace;
- a read-only export labeled as Testnet demonstration evidence;
- clear partial-historical-coverage labeling for activity predating journal instrumentation.

Audit must not mutate source ledgers or expose secrets.

## 8. Demo Policy source and isolation

### 8.1 Immutable template

The open-source initialization template remains:

```text
static/covenants/kcc20-regulated-demo-policy.template.v1.json
```

It is Testnet-10-only and contains no private data, production authority, Token Depot Registry ID, or preselected regulated token.

### 8.2 User-scoped saved policy

Each authenticated user may have one saved Demo Policy at:

```text
data/users/<userId>/kcc20-regulated-demo-policy.v1.json
```

The server derives the path from the authenticated user ID. The browser must not submit a filesystem path or another user's user ID.

The saved policy contains:

```text
schema_kind
schema_version
network
policy_epoch
regulated_asset_covenant_ids
recipient_allowlist
recipient_blacklist
frozen_holders
frozen_outpoints
lawful_order_actions
created_at
updated_at
```

### 8.3 Normalization

The following fields must be trimmed, validated, deduplicated, and deterministically sorted:

- regulated asset covenant IDs;
- recipient allowlist;
- recipient blacklist;
- frozen holders;
- frozen outpoints;
- lawful-order actions after their schema is approved.

### 8.4 Source snapshot

```text
source_policy_snapshot_id
=
SHA-256(canonical normalized policy content excluding epoch and metadata)
```

### 8.5 Policy epoch

```text
new saved policy
-> epoch 1

browser edit without Save
-> no epoch change

Calculate Changes without Save
-> no epoch change

no-op, reorder-only, or duplicate-only Save
-> same epoch

material normalized Save
-> exactly one next epoch

repeat of the same normalized content
-> same epoch

overflow
-> explicit rejection
```

The browser cannot control the authoritative epoch.

### 8.6 Rulebook root

```text
rulebook_root
=
SHA-256(recursive-key-sorted compact canonical rulebook JSON)
```

The rulebook root commits the policy epoch and normalized policy content.

### 8.7 Publication state

A saved Demo Policy is pending until its exact epoch, root, and source snapshot are committed to the live user-owned Registry.

Deploy, Issue, transfer, and Controls must fail closed when the required saved policy and live Registry publication do not match.

### 8.8 No silent policy-source fallback

The Testnet Demo Policy must never silently fall back to Token Depot's Compliance Node policy, another user's Demo Policy, an older policy epoch, or another Registry.

Malformed or missing policy must fail explicitly.

---

## 9. Policy ownership and rulebook resolution

A regulated token is governed by the Registry covenant ID stored in its `pr` field.

The governing rulebook is the rulebook published by that Registry. It is not automatically replaced by the current holder's personal Demo Policy.

For same-server Testnet operation:

```text
token pr
-> resolve the matching live Registry record
-> identify the Demo Policy owner and published epoch/root
-> load the exact governing Demo Policy
-> verify policy, Registry, and token profile agreement
```

A policy owner may edit and publish only that owner's policy and Registry.

A recipient who receives the token may hold and transfer it according to the issuer's governing rulebook but may not edit that rulebook merely because the recipient owns token units.

If the governing policy cannot be resolved or verified, the action must fail closed.

---

## 10. Registry architecture

### 10.1 Stable identity

`pr` identifies one stable Registry covenant lineage.

A policy update spends and recreates the Registry while preserving the same covenant ID.

A second Registry must not be created merely because the policy epoch changes.

### 10.2 Registry spending

The Registry is spent only for:

- policy epoch and root updates;
- source-snapshot updates;
- authority changes;
- approved recovery or governance transitions;
- future production commitments defined by a later specification.

Ordinary Deploy after the Registry exists, Issue, transfer, aggregation, sender change, Holdings, and Inspector operations must not spend the Registry.

### 10.3 Current Testnet Registry state

The current clean-stack Registry version proves:

- authority signature;
- increasing epoch;
- previous-root linkage;
- next root and source snapshot;
- covenant-ID continuity;
- uncovenanted KAS change;
- live-chain verification and local record update.

### 10.4 Clean-stack requirement

Every Registry script version must leave exactly the required final truth value and no unexpected stack items.

A Registry update must reject:

- invalid authority;
- stale or duplicate epoch;
- previous-root mismatch;
- successor-script mismatch;
- covenant-ID mismatch;
- malformed signed plan.

---

## 11. KCC20-Regulated profile semantics

A complete v1 regulated profile contains:

```text
rg = 1
rv = 1
pr = stable Registry covenant ID
pe = policy epoch applied to the current state
fc = immutable supported-control capability bitset
```

### 11.1 `pr`

`pr` remains fixed for the token lineage in v1.

A replacement Registry with a different covenant ID creates a different policy lineage unless a separately approved migration profile is implemented.

### 11.2 `pe`

`pe` records the policy epoch under which the controller or holder state was created or last validly transitioned.

A source state may have `pe` below the current Registry epoch.

A valid Issue, holder transfer, burn, Change Ownership, or Control action must:

- reject a source epoch ahead of the Registry;
- evaluate the action using the current published Registry epoch and rulebook;
- set regulated successor state to the current published epoch.

### 11.3 `fc`

`fc` describes capabilities designed into the token profile. It is not an individual transfer decision.

```text
1  = rulebook transfer required
2  = freeze supported
4  = seize or forced transfer supported
8  = lawful forced burn supported
16 = recipient allowlist enabled
32 = recipient blacklist enabled
```

`fc` remains unchanged during ordinary v1 transitions.

---

## 12. Testnet compact regulated controller and holder

### 12.1 Controller target

The Testnet regulated controller uses the existing compact controller state:

```text
schema = oma_l1_token_controller_state_v2
```

with the existing controller fields and complete `rg/rv/pr/pe/fc` profile appended.

The controller remains the authoritative issued-supply state. Holder burn and forced burn do not by themselves complete supply accounting; the canonical controller-supply update lifecycle must consume the corresponding accepted burn receipt.

### 12.2 Ordinary compact holder target

The ordinary Testnet regulated holder uses:

```text
m      = OMA1
schema = oma_l1_token_holder_state_v2
role   = holder
a      = output.covenant.covenantId
t      = token symbol
d      = decimals
ot     = owner identifier type
oi     = owner identifier
q      = holder amount_raw
rg     = 1
rv     = 1
pr     = Registry covenant ID
pe     = current policy epoch
fc     = control capability bitset
```

The ordinary branch requires the current holder signature and retains the existing browser signing lifecycle.

### 12.3 Control-enabled holder script profile

A newly deployed regulated token may use the approved Testnet control-enabled holder script profile:

```text
script profile = regulated_registry_control_v1
state schema   = oma_l1_token_holder_state_v2
```

The script profile contains two authorization branches:

```text
ordinary branch
-> current holder signature required

control branch
-> referenced Registry covenant lineage participates
-> Registry-authority signature required
-> holder signature not required
```

The control branch is available only when the token was born with the corresponding capability and script profile. Existing owner-signature-only holders cannot be retroactively upgraded.

### 12.4 Server-enforced control decision

The canonical server must independently validate, cache, and revalidate:

- target token and control-enabled profile;
- Registry ID and current live Registry source;
- correct Registry authority;
- current saved/published Demo Policy epoch and root;
- governed asset membership;
- frozen target holder or outpoint when required;
- action kind and order reference;
- source holders and raw amount;
- seizure destination or burn result;
- holder remainder;
- Registry successor continuity;
- native funding plan;
- exact unsigned and signed output plan.

The covenant control branch proves Registry-authorized participation. The server proves the Testnet policy decision and exact transaction plan. Neither layer may be described as independently proving legal validity.

### 12.5 Testnet enforcement boundary

For ordinary transfers and control actions, the complete Testnet path is:

- live source reconstruction;
- policy and Registry resolution;
- compatible token-source selection;
- mass-aware native-funding selection;
- exact successor construction;
- exact unsigned-plan cache;
- browser-local signing of approved indexes;
- exact signed-plan validation;
- submit-time policy/Registry/source revalidation;
- post-submit live-chain verification;
- tracked-state, burn-receipt, Holdings, Inspector, and Metadata updates.

This is Testnet demonstration enforcement. It must not be represented as complete mainnet rogue-wallet resistance.

## 13. Deploy requirements

Regulated Deploy reuses the existing KCC20 Deploy route family and signing lifecycle.

Requirements:

- Testnet-10 only for the current product;
- complete saved and published Demo Policy;
- live user-owned Registry;
- exact `pr`, `pe`, and `fc` binding;
- `initial_issue_raw = 0`;
- existing compact regulated controller output;
- no holder output when initial supply is zero;
- ordinary uncovenanted KAS change;
- exact signed-plan validation;
- tracking only after live-chain verification.

After Deploy:

1. add the new asset covenant ID to the same Demo Policy;
2. save the next material epoch;
3. update the same Registry;
4. enable Issue only when the asset is present in the published governing rulebook.

Standard KCC20 Deploy remains unchanged.

---

## 14. Issue requirements

Regulated Issue reuses the existing Issue build, local-sign, submit, controller-successor, holder-output, fee, and tracking lifecycle.

The target Testnet Issue must:

- select a live regulated controller;
- resolve the policy by the controller's `pr`;
- verify the saved policy matches the live Registry epoch/root;
- require the asset covenant ID to be governed;
- validate recipient allowlist, blacklist, and freeze state according to `fc`;
- validate issuer/controller authority;
- enforce maximum supply;
- create a one-time user-scoped Testnet issuance authorization;
- create the recipient holder with `oma_l1_token_holder_state_v2` plus `rg/rv/pr/pe/fc`;
- set holder and successor-controller `pe` to the current Registry epoch;
- preserve `pr` and `fc`;
- consume authorization only after accepted submit and successful tracked-state update;
- reject authorization replay;
- keep ordinary native KAS refund uncovenanted;
- refresh Token Metadata after accepted Issue and tracking.

The H2 holder schema must not be used for new v0.9 Testnet Issue proofs.

Standard KCC20 Issue remains unchanged.

---

## 15. Holder-transfer requirements

### 15.1 Canonical routes

Regulated transfers reuse:

```text
POST /api/covenants/issuer-token/holder-transfer/build
POST /api/covenants/issuer-token/holder-transfer/submit
```

No regulated-specific transfer route is permitted.

### 15.2 Token-source selection

The existing selector must continue to:

1. verify candidate holders against live chain state;
2. group only compatible asset, schema, token, owner, and regulated-profile definitions;
3. prefer the smallest single compatible holder that covers the requested raw amount;
4. otherwise aggregate compatible holders in deterministic largest-first order until the amount is covered;
5. exclude spent, malformed, wrong-owner, wrong-schema, wrong-profile, unsupported, or policy-ineligible holders;
6. stop and reject if funds are insufficient or no standard transaction can be constructed.

No fixed product holder-input count is introduced.

### 15.3 Output model

The active product output model is:

```text
regulated token output 0:
one recipient

regulated token output 1:
optional sender change

final ordinary output:
uncovenanted native KAS refund when applicable
```

Arbitrary multi-recipient batch sending is not required.

### 15.4 Amount conservation

For every ordinary transfer:

```text
sum(selected regulated holder amount_raw)
=
recipient amount_raw + optional sender-change amount_raw
```

The build cache and submit route must independently validate exact amounts, owners, scripts, covenant IDs, output ordering, and policy epoch.

Carrier KAS is not token quantity and must not be used for token conservation.

### 15.5 Policy checks before signing

Before returning a signable plan, the server must:

- resolve the governing policy from `pr`;
- verify the live Registry and current published epoch/root;
- require the asset to be governed;
- reject blacklisted recipients;
- enforce the allowlist when enabled;
- reject frozen holders and frozen source outpoints;
- reject unsupported or malformed profiles;
- reject source states whose epoch is ahead of the Registry;
- build recipient and sender-change successors with current `pe` and preserved `pr` and `fc`;
- return explicit rejection reasons without reading a private key or signing.

### 15.6 Submit revalidation

Immediately before broadcast, the submit route must repeat the policy and Registry decision against:

- the same source outpoints;
- the same sender and recipient;
- the same raw amounts;
- the same successor scripts;
- the same current epoch/root;
- the exact native-funding plan;
- the exact signed transaction.

A policy, Registry, source-state, funding, signature-index, or output mismatch must fail closed.

### 15.7 Native KAS funding selection

Native funding candidates must be ordinary uncovenanted KAS UTXOs. Covenant-bearing KAS, token holders, Registry outputs, programmable KAS outputs, and other protected sources must be excluded.

The canonical route must evaluate deterministic bounded candidate sets through exact transaction construction, signer-equivalent witness placeholders, fee convergence, and standard-mass checks.

The successful plan may use zero, one, or multiple native inputs. The server response must return the exact ordered native input indexes and outpoints, and every browser consumer must sign all required native indexes.

### 15.8 Practical capacity

Transaction capacity is determined by exact measured standardness and mass, not by a hardcoded proof constant.

If no deterministic candidate set produces a standard transaction, the build must fail explicitly. It must not silently switch to a fallback selector, alternate route, larger fee reserve, or parallel transaction shape.

## 16. Signing, submit, tracking, Inspector, Holdings, and Token Metadata

### 16.1 Browser-local signing

The existing signer must sign every server-approved holder, Registry, controller, and native-funding index required by the specific route.

It must validate the returned signing context and must not infer indexes from input position alone when the server provides an explicit ordered plan.

Private keys, signatures, redeem scripts, signed transaction JSON, and submit tokens must not be printed in proof output.

### 16.2 Exact-source operations

Release, refund, recovery, and other exact-source covenant routes may intentionally sign only input `0` when that input is the exact verified covenant source and no native chooser is involved.

A broad `signInputIndexes: [0]` match is not evidence of a selector defect. Each occurrence must be classified by transaction semantics before any edit.

### 16.3 Tracking

After accepted submit and live verification:

- each successor holder is recorded through the existing tracked-asset architecture;
- the recipient record uses the recipient owner identity and amount;
- the sender-change record uses the sender owner identity and amount;
- every regulated record preserves `pr` and `fc` and records current `pe`;
- spent source records are no longer presented as live;
- burn receipts record controller-supply accounting status;
- standard records remain unchanged.

### 16.4 Same-server cross-user recognition

When both sender and recipient are known to the same server, the server must associate verified successor records with the correct user and wallet without requiring manual import.

Policy ownership remains with the Registry owner, not the recipient.

### 16.5 Inspector and Holdings

Inspector and Holdings must recognize every valid compact regulated successor and display:

- token identity and amount;
- KCC20-Regulated classification;
- Registry ID;
- policy epoch;
- control flags and control-enabled script profile when known;
- live verification status;
- current owner.

Legacy H2 outputs and historical unsupported schemas must remain distinguishable from current compact regulated holders.

### 16.6 Token Metadata Explorer

The Issue workspace must provide a read-only Token Metadata surface for the selected regulated token.

It must include, when available:

- token name, symbol, decimals, network, and asset covenant ID;
- maximum supply and issued supply in raw and human-readable units;
- live controller state and outpoint;
- Registry ID, current policy epoch, and control flags;
- pending burn receipt count;
- pending controller-supply amount;
- whether the pending actions are consistent with the currently reported issued supply;
- clear status such as `Live`, `Supply update pending`, or explicit failure.

The metadata route must not mutate tracked data or initiate any transaction.

## 17. Change Ownership

Regulated Change Ownership reuses the existing Change Ownership route family.

It must:

- verify current controller authority;
- resolve the governing policy and Registry;
- reject stale or mismatched policy state;
- preserve `pr` and `fc`;
- set successor `pe` to the current Registry epoch;
- preserve existing controller supply and maximum-supply invariants;
- use the existing signing, submit, live-verification, and tracking lifecycle;
- produce an Audit record.

Change Ownership must not create a new Registry or move the token to another policy lineage.

A separate policy-authority or Registry-authority transfer is a different operation and requires its own approved module.

---

## 18. Testnet Controls

### 18.1 General control boundary

Testnet Controls apply only to:

- KCC20-Regulated tokens;
- complete `rg/rv/pr/pe/fc` profiles;
- the governing user-scoped Demo Policy and stable Registry lineage;
- a control capability enabled in `fc`;
- a control-enabled holder script when holder-signature-free action is required;
- the correct issuer/controller and Registry-authority wallet.

KAS, KRC20, standard KCC20, malformed regulated profiles, wrong Registry lineages, wrong authorities, and legacy non-control-enabled holders must fail closed.

Opening the Controls tab must initialize current workspace state, recover the current Registry, refresh canonical issuer-controlled regulated assets, populate the lawful-order selectors, and render current prerequisites without reloading the page.

### 18.2 Freeze and unfreeze

Freeze and unfreeze are policy and Registry actions:

```text
edit saved Demo Policy
-> Calculate Changes
-> Save New Epoch
-> update the same Registry
-> verify the live Registry epoch/root
```

The canonical transfer path must reject a frozen recipient, frozen sender, frozen holder, or frozen source outpoint before signing and again at submit, according to the applicable rule.

Freeze does not mutate the holder UTXO merely to mark it frozen. The governing published policy determines the Testnet freeze decision.

After a successful Freeze or Unfreeze, the Controls UI must refresh regulated assets and repopulate the lawful-order selectors automatically.

### 18.3 Seizure

The seizure routes are:

```text
POST /api/covenants/issuer-token/kcc20-regulated/control/seize/build
POST /api/covenants/issuer-token/kcc20-regulated/control/seize/submit
```

A seizure must:

- require a control-enabled regulated holder;
- require the target holder or source outpoint to be frozen under the current published Demo Policy;
- require the Registry-authority signature;
- not require the holder signature;
- enforce a permitted destination;
- conserve raw token amount between seized output and optional holder remainder;
- recreate the same Registry covenant lineage;
- validate the exact plan at submit;
- verify spent sources and live successors before tracking;
- return a sanitized demo-only proof;
- write Audit evidence.

### 18.4 Forced Burn

The Forced Burn routes are:

```text
POST /api/covenants/issuer-token/kcc20-regulated/control/forced-burn/build
POST /api/covenants/issuer-token/kcc20-regulated/control/forced-burn/submit
```

A Forced Burn must:

- require a control-enabled regulated holder;
- require the active wallet to be the token issuer/controller and Registry authority;
- require the Registry-authority signature;
- not require the holder signature;
- remove the approved raw amount from holder state;
- create only an optional holder remainder, not a recipient token output;
- recreate the same Registry covenant lineage;
- write an accepted burn receipt only after live verification;
- never repeat Stage 1 because Stage 2 supply accounting is pending;
- write Audit evidence.

The target authorization basis must be cached and revalidated as one of:

```text
frozen_holder
issuer_controller_self_custody
```

For `frozen_holder`, a third-party target holder must be frozen under the current published Demo Policy.

For `issuer_controller_self_custody`, the target wallet must equal the active issuer/controller wallet. The freeze requirement may be waived, but the Demo Lawful Order, governed asset, current policy/Registry, control capability, issuer/controller authority, Registry authority, Registry-authority signature, exact-plan validation, Audit, and controller-supply requirements remain mandatory.

### 18.5 Regulated ordinary-Burn boundary

The ordinary holder-Burn routes must reject regulated tokens:

```text
POST /api/covenants/issuer-token/burn/build
POST /api/covenants/issuer-token/burn/submit
```

Required reason:

```text
kcc20_regulated_holder_burn_requires_lawful_order_path
```

The build rejection must occur before transaction construction, signing, broadcasting, or minting. Submit must reject and remove a cached regulated ordinary-Burn plan if one is encountered.

Regulated burn behavior is available only through the lawful-order Forced Burn path.

### 18.6 Controller-supply accounting

Every accepted holder burn or Forced Burn must be reconciled through the existing controller-supply burn lifecycle.

The controller-supply builder must:

- locate the exact accepted, unconsumed burn receipt;
- verify the current live controller;
- reduce issued supply by the receipt amount;
- preserve controller token identity, `pr`, `fc`, and current policy semantics;
- use mass-aware native funding;
- preserve each holder's own regulated profile while updating the controller regulated profile;
- update the receipt only after accepted submit and live controller verification;
- write terminal Audit evidence.

All currently accepted REGT2 and REGT3 Forced Burn receipts have completed controller-supply accounting. Current pending burn receipts and pending supply actions are zero.

### 18.7 Result presentation

The UI must distinguish:

```text
SUCCESS — action and required accounting completed

ACTION SUCCEEDED — controller-supply update remains pending
Do not repeat the seizure or Forced Burn

FAILED — action was not accepted
```

A pending accounting step must never be presented as though the holder control action failed.

Forced Burn instructions must state:

- a Demo Lawful Order is always required;
- a third-party target must be frozen;
- the active issuer/controller wallet may burn regulated tokens it holds without freezing itself;
- only the issuer/controller self-custody case waives the freeze requirement;
- a partial remainder returns to the same target holder wallet.

### 18.8 Legal and production claims

Every Testnet control proof must retain:

```text
demo_only=true
production_eligible=false
legal_validity_claimed=false
```

The system may demonstrate a Registry-authorized control transaction. It must not claim to validate a real lawful order or prove legal authority on-chain.

## 19. Testnet Audit

The unified user-scoped Audit module is implemented.

### 19.1 Canonical architecture

Audit reuses the existing canonical user-scoped ledgers plus one append-only journal:

```text
data/users/<userId>/kcc20-regulated-audit.v1.json
```

Read-only projection sources are:

```text
Demo Policy
Policy Registries
Tracked Assets
Issuance Authorizations
Burn Receipts
Token Metadata and live reconstruction
Append-only Audit Journal
```

No SQL database, external database, second Audit service, parallel asset ledger, or replacement tracking architecture is permitted.

### 19.2 Canonical routes

```text
GET /api/covenants/issuer-token/kcc20-regulated/audit
GET /api/covenants/issuer-token/kcc20-regulated/audit/export
```

Both routes are read-only.

### 19.3 Journal integrity

The journal must be:

- user-scoped;
- append-only;
- sequentially numbered;
- hash-chained;
- verifiable without rewriting prior events;
- free of secrets and signed transaction material.

The current journal contains `94` immutable records and the hash chain is verified.

### 19.4 Read-only projection

Audit must preserve raw journal stages and outcomes. It may add projection-only lifecycle fields when exact terminal evidence resolves an intermediate event:

```text
pending_action=false
lifecycle_resolution=superseded_by_success
resolved_by_event_id=<terminal event>
resolved_by_stage=<terminal stage>
```

The projection must not edit the journal or canonical source ledgers.

A projected intermediate event may become informational only when exact corresponding terminal evidence exists. Required proven cases include:

- Registry update submitted followed by successful Registry tracking;
- Freeze/Unfreeze planned followed by successful publication;
- Forced Burn supply-update-pending followed by successful controller-supply update;
- Forced Burn accepted/pending followed by both successful terminal Forced Burn evidence and successful controller-supply update;
- `candidate_requires_live_reverification` tracked records classified as informational tracking evidence rather than pending transactions.

Any unmatched intermediate event remains pending.

### 19.5 Required evidence

Audit must consolidate:

- Demo Policy creation, reset, calculated changes, saved epochs, snapshots, roots, and diffs;
- Registry genesis, recovery, updates, authority, outpoints, and transaction IDs;
- regulated Deploy and automatic asset enrollment;
- Issue authorization creation, consumption, transaction, controller successor, and holder outputs;
- ordinary transfer policy decisions, source holders, recipient, sender change, transaction, and rejection reasons;
- freeze and unfreeze policy/Registry transitions;
- seizure target, destination, amount, order reference, Registry continuity, transaction, and proof status;
- Forced Burn target, authorization basis, freeze-waiver status, amount, order reference, Registry continuity, transaction, burn receipt, and controller-supply status;
- controller-supply update transaction and resulting issued supply;
- Token Metadata references sufficient to explain pending or completed supply actions;
- standard KCC20 regression evidence where required by a regulated change.

Audit must distinguish:

```text
planned
built
signed locally
submitted
accepted
live verified
tracking updated
supply update pending
rejected
informational lifecycle evidence
```

### 19.6 UI and export

The Audit workspace must provide:

- chain-integrity status;
- total, live-verified, rejected, and pending counts;
- current policy epoch;
- source-manifest status;
- filters;
- chronological evidence;
- expandable evidence contained within the card width;
- export.

The export must be labeled:

```text
Testnet-10 demonstration evidence
partial historical projection for pre-Audit activity
not regulator certification
not proof of legal validity
not mainnet bypass resistance
```

### 19.7 Current verified state

```text
raw journal records:          94
journal hash chain:           verified
total projected events:       132
live verified:                32
rejected:                     2
unresolved pending actions:   0
current policy epoch:         23
source manifest:              complete
historical coverage:          partial historical projection
```

The two rejected events are intentional negative policy tests. Raw journal records may retain original pending intermediate outcomes even when the current projected unresolved-pending count is zero.

Audit output must never expose:

- private keys or seeds;
- passphrases;
- signed transaction JSON;
- signature scripts or redeem scripts;
- submit tokens;
- Admin Tokens or API keys;
- signer or custody material.

## 20. Future mainnet boundary

Mainnet is intentionally deferred and is not part of the current implementation plan.

The existing Testnet compact owner-signature holder plus wallet/server enforcement must not be advertised as complete mainnet compliance enforcement.

A future customer-driven mainnet specification must determine and prove:

- distributed policy-source ownership and replication;
- node-set declaration and replacement;
- deterministic policy execution;
- decision availability and failure behavior;
- exact transaction-plan authorization;
- covenant-verifiable authorization or proof;
- stale-policy and replay prevention;
- recovery and incident governance;
- Audit retention and regulator reporting;
- performance and service-level requirements.

No fixed node count, quorum, packet schema, cryptographic primitive, or vProg claim is selected in v0.9.

Ordinary mainnet transfers must not consume one shared Registry UTXO.

---

## 21. Security and privacy requirements

The implementation must:

- fail closed on malformed regulated state or unsupported script profile;
- fail closed when policy or Registry cannot be resolved;
- fail closed on stale or mismatched epoch/root;
- never silently fall back to standard KCC20 or another policy source;
- validate every signed transaction against its cached unsigned plan;
- revalidate policy immediately before broadcast;
- prevent duplicate submit, authorization replay, burn-receipt replay, and repeated forced burn;
- preserve normal-send exclusion for covenant-bearing token and programmable outputs;
- exclude covenant-bearing UTXOs from every native KAS funding candidate pool;
- use exact signer-equivalent witness shapes in mass probes;
- keep private keys and signing in the browser-local wallet lifecycle;
- keep secrets out of source, browser logs, proof output, tracked token state, Metadata, and Audit exports;
- distinguish owner wallet addresses from covenant/P2SH addresses;
- avoid secondary source rescans after a covenant source has already been live verified;
- allow UTXO context settlement before reading newly tracked outputs;
- maintain standard KCC20, KRC20, KAS, swap, and faucet regression boundaries after chooser changes;
- stop on the first exact runtime failure and correct proof artifacts rather than working application code when the proof is wrong.

## 22. Implementation order and current status

### Stage 1 — Workspace and Demo Policy — complete

```text
[x] six-section regulated workspace
[x] immutable Testnet policy template
[x] one user-scoped saved Demo Policy
[x] deterministic normalization, snapshot, epoch, and root
[x] Create, Load, Save, Reset, and Export
[x] guided Rulebook Lab flow
```

### Stage 2 — Clean-stack Registry — complete

```text
[x] user-owned Registry genesis
[x] clean-stack Registry script
[x] same-covenant Registry epoch update
[x] previous-root linkage
[x] live verification and tracking
[x] ordinary Deploy, Issue, transfer, and metadata reads do not spend Registry
```

### Stage 3 — Compact regulated Deploy, Issue, and fungibility — complete

```text
[x] zero-supply regulated Deploy
[x] automatic asset enrollment and Registry update
[x] no-deposit Testnet Issue flow
[x] one-time authorization consumption
[x] compact oma_l1_token_holder_state_v2 plus rg/rv/pr/pe/fc
[x] full transfer
[x] partial transfer plus sender change
[x] multiple-holder aggregation
[x] allowed recipient success
[x] blocked/frozen recipient rejection
[x] frozen sender rejection
[x] submit-time policy revalidation
[x] return transfer
[x] Inspector and Holdings recognition
[x] standard KCC20 preserved
```

### Stage 4 — H2 retirement and compact-path cleanup — complete

```text
[x] active H2/open-ICC server path removed
[x] legacy H2 records retained as unsupported history
[x] compact controller and holder remain active Testnet target
[x] no fixed holder-input ceiling
[x] orphan historical descriptor has no active consumer
```

### Stage 5 — Freeze, Unfreeze, Seizure, and Controls refresh — complete

```text
[x] frozen holder/outpoint policy fields
[x] policy epoch and Registry publication
[x] ordinary transfer rejection while frozen
[x] control-enabled regulated holder profile
[x] holder-signature-free seizure
[x] Registry-authority signature
[x] same Registry covenant-ID continuity
[x] unauthorized/wrong-asset exclusions
[x] Controls-tab canonical asset/Registry refresh
[x] post-Freeze/Unfreeze selector refresh
```

### Stage 6 — Forced Burn and supply accounting — complete

```text
[x] holder-signature-free Forced Burn build/submit
[x] Registry-authority signature
[x] third-party frozen-target enforcement
[x] issuer/controller self-custody freeze waiver
[x] ordinary regulated Burn API rejection
[x] burn receipt and live verification
[x] automatic or recoverable controller-supply accounting
[x] holder/controller profile preservation during supply update
[x] mass-aware Forced Burn and controller-supply funding
[x] result clarity and do-not-repeat warning
[x] all current REGT2 and REGT3 receipts closed
[x] pending burn receipts=0
[x] pending supply actions=0
```

### Stage 7 — Token Metadata — complete

```text
[x] read-only metadata route
[x] full-width Issue workspace card
[x] live identity, controller, supply, Registry, epoch, and flags
[x] pending burn/supply action display
[x] auto-refresh after relevant actions
```

### Stage 8 — Mass-aware KCC20 funding selection — structurally complete

```text
[x] Registry deploy/update
[x] standard and regulated token Deploy
[x] standard and regulated Issue
[x] Change Ownership
[x] holder transfer
[x] ordinary holder Burn
[x] Seizure and Forced Burn
[x] controller-supply burn
[x] direct/open KCC20 maker-lock and claim paths
[x] browser signers aligned with variable native input plans
```

### Stage 9 — Cross-stack KAS chooser safety — structurally complete

```text
[x] Covenant Controls and Programmable KAS funding
[x] KRC20 transfer/deploy/issue/change-owner covenant-bearing exclusions
[x] direct/open/legacy swap covenant-bearing exclusions
[x] TN10 faucet covenant-bearing exclusion
[x] banned obsolete-selector sweep clean
[x] remaining signInputIndexes: [0] routes classified as exact-source operations
```

### Stage 10 — User-scoped Audit — complete

```text
[x] append-only hash-chained journal
[x] policy and Registry journal coverage
[x] Deploy, Issue, transfer, Control, burn, and supply journal coverage
[x] canonical read-only projection
[x] lifecycle reconciliation without journal mutation
[x] Audit UI, filters, evidence expansion, and export
[x] evidence overflow containment
[x] chain verified
[x] unresolved pending actions=0
```

### Stage 11 — Fresh regulated release regression — complete

```text
[x] REGT3 zero-supply Deploy
[x] automatic policy enrollment and one next epoch
[x] same-Registry publication
[x] Issue-tab automatic reload
[x] Issue
[x] allowed transfer
[x] freeze/unfreeze negative and positive transfer behavior
[x] holder-signature-free Seizure
[x] third-party Forced Burn and supply update
[x] issuer/controller self-custody Forced Burn and supply update
[x] Holdings / Token Metadata / Audit reconciliation
[x] final read-only closure: 51 assertions passed
[x] no additional REGT3 transaction required
```

### Stage 12 — Release regression — pending

```text
[ ] standard KCC20 end-to-end regression
[ ] ordinary KAS / KRC20 / KCC20 / Programmable-KAS chooser regression
[ ] variable native-input signer/server-plan confirmation
[ ] exact-source release/refund non-degradation
[ ] existing Direct KCC20 swap non-degradation
[ ] existing Open KCC20 swap non-degradation
[ ] final source/data hash and banned-pattern sweep
[ ] final Testnet Audit export
```

### Stage 13 — Release candidate and deployment

```text
[ ] release-candidate bundle
[ ] public GitHub package under approved exclusions
[ ] AWS deployment planning
[ ] AWS deployment and smoke test
```

AWS requires a separate approved deployment module. Mainnet requires a separate customer-driven production specification and Change Budget.

### Stage 14 — Downstream applications

After release closure:

```text
[ ] regulated Direct Swap rulebook enforcement
[ ] regulated Open Swap rulebook enforcement
[ ] preserve existing compliance lights, colors, and badges
[ ] energy-token integration last
```

## 23. Testnet closure gates

### 23.1 Compact product gate — passed

The active Testnet product gate is satisfied by:

- compact zero-supply Deploy;
- compact regulated Issue;
- full and partial transfer;
- sender change;
- multiple-holder aggregation;
- policy allow/deny and freeze checks;
- live tracking, Inspector, and Holdings;
- standard KCC20 preservation.

### 23.2 Control-enabled token gate — passed

A token may be treated as control-enabled only when:

- it was deployed with the approved control-enabled holder script profile;
- `fc` includes the applicable capability;
- the governing `pr` resolves to the stable live Registry;
- the correct issuer/controller and Registry authority are available;
- ordinary and control branches are proven separately;
- KAS, KRC20, standard KCC20, malformed regulated profiles, and legacy owner-only holders are rejected.

REGT3 passed Seizure, third-party Forced Burn, issuer/controller self-custody Forced Burn, and controller-supply accounting.

### 23.3 Forced-Burn accounting gate — passed

Forced Burn is fully closed only when:

- Stage 1 holder burn is accepted and live verified;
- the accepted burn receipt is uniquely identified;
- Stage 2 controller-supply update is accepted;
- the successor controller issued supply is verified;
- the burn receipt is marked controller-supply-updated;
- Token Metadata shows no inconsistent pending amount;
- Audit resolves the lifecycle only from exact terminal evidence;
- Stage 1 was not repeated.

All current REGT2 and REGT3 receipts satisfy this gate. Pending burn receipts and pending supply actions are zero.

### 23.4 Audit gate — passed

The Audit gate requires:

- append-only user-scoped journal;
- verified hash chain;
- canonical source manifest;
- read-only projection;
- policy, Registry, token, transfer, Control, burn, and supply evidence;
- lifecycle reconciliation without source mutation;
- zero unresolved pending actions after exact terminal evidence;
- secret-free export.

The current Audit gate passed with `94` journal records, `132` projected events, verified chain integrity, and zero unresolved pending actions.

### 23.5 Final regulated closure gate — passed

The final read-only closure must verify:

- Testnet-10 wallet and SDK readiness;
- policy epoch/root and REGT3 governance;
- REGT3 issued supply `9000`;
- zero pending burn receipts and supply actions;
- DO10 self-custody authorization and freeze waiver;
- holder signature not required and Registry-authority signature required;
- Audit chain verified and pending count zero;
- Controls-tab REGT3 selector population and lawful-order unlock readiness;
- no transaction or policy mutation.

`KCC20_REGULATED_FINAL_CLOSURE_PROOF_READONLY_V3` passed all `51` assertions.

### 23.6 Standard KCC20 regression gate — pending

Release requires a bounded standard KCC20 end-to-end regression proving that regulated changes did not alter standard Deploy, Issue, transfer, Burn, Change Ownership, tracking, Inspector, or Holdings behavior.

### 23.7 Chooser regression gate — pending

The chooser realignment is release-ready only after bounded regression confirms:

- ordinary native KAS send excludes covenant-bearing UTXOs;
- standard and regulated KCC20 remain functional;
- variable native-input signing matches server plans;
- KRC20 commit builds exclude covenant-bearing UTXOs;
- Programmable KAS funding remains functional;
- exact-source single-input release/refund paths remain unchanged.

### 23.8 Existing swap non-degradation gate — pending

Release requires bounded proof that the existing Direct and Open KCC20 swap paths still build, sign, submit, track, claim, and refund according to their current product behavior. This gate does not authorize regulated-swap implementation.

### 23.9 Release-candidate gate — pending

Release-candidate packaging requires:

- Sections 23.6 through 23.8 passed;
- final source/data hashes and banned-pattern counts clean;
- final Testnet Audit export produced;
- public-package exclusion review complete;
- no unresolved release blocker.

### 23.10 Mainnet gate

There is no mainnet activation gate in the current implementation sequence.

Mainnet work is deferred until a separate customer-driven production specification is approved.

## 24. Explicit non-goals for v0.9

v0.9 does not authorize:

- a new regulated token-state schema;
- replacing the compact controller or holder state;
- reopening the H2/open-ICC proof path;
- a fixed holder-input or native-input product maximum;
- arbitrary multi-recipient batch sending;
- rewriting the standard KCC20 transfer lifecycle;
- a separate regulated transfer, Burn, Registry, signer, tracking, or Audit family;
- spending the Registry during ordinary transfer, Issue, Metadata, or Audit reads;
- allowing regulated tokens through the ordinary holder-Burn path;
- waiving the Demo Lawful Order or Registry-authority requirements for issuer self-custody Forced Burn;
- silently migrating legacy H2, REGT1, REGT2, REGT3, or historical Registry records;
- rewriting immutable Audit journal records to change projected status;
- representing Testnet server policy as complete covenant rulebook execution;
- claiming a Demo Lawful Order is legally valid;
- repeating an accepted Seizure or Forced Burn because a later accounting or visibility step was pending;
- performing another REGT3 transaction merely to prove closure;
- deleting historical ledgers merely to make current state appear clean;
- changing exact-source release/refund routes solely because they sign input `0`;
- regulated-swap implementation before release regression and packaging;
- energy integration before the regulated release is complete;
- AWS deployment as part of this specification-file update;
- production mainnet deployment;
- a chosen distributed node count, quorum, threshold signature, proof system, or vProg implementation.

## 25. Legacy and current Testnet artifacts

The following may remain for forensic and Audit history:

```text
Token Depot Registry version 1
legacy user Registry records
Token Depot token 01
TWO / 02 H2-era proof holders
historical H2/open-ICC descriptor artifact with no active consumer
REGT1 compact fungibility proof token
REGT2 original control-enabled proof token
REGT3 fresh release-regression token
historical Seizure and Forced Burn transactions
immutable Audit journal and partial historical projection
```

Legacy artifacts must:

- be clearly classified as development or historical artifacts;
- not appear as eligible current Issue, transfer, or Control targets when incompatible;
- not be silently rewritten or migrated;
- not block clean new deployments;
- remain available for Audit and troubleshooting.

Current live artifacts must not be reused after their source outpoints are spent.

REGT2 currently has issued supply `9000 raw` and no pending supply action.

REGT3 currently has issued supply `9000 raw`, controller outpoint `b1f6c644a0ba14bdf7503a8f822669682d297fb8534c9e11f6d6272238399801:0`, zero pending burn receipts, and zero pending supply actions.

The DO9 and DO10 Forced Burn source holders and transactions are consumed and must not be repeated.

Raw Audit journal events retain original intermediate lifecycle outcomes. Their read-only projected status must be derived from exact terminal evidence, not by editing historical records.

## 26. v0.9 revision summary

v0.9 updates the v0.8 implementation status to the CW297 and final read-only closure state without changing the established Testnet architecture.

It preserves:

```text
existing compact KCC20 controller/holder state
+ rg / rv / pr / pe / fc
+ user-scoped Demo Policy
+ stable user Registry
+ existing Deploy / Issue / transfer / Burn / Change Ownership lifecycle
+ browser-local signing
+ mass-aware native funding
```

It records the completed post-v0.8 behavior:

- user-scoped append-only Audit journal and verified hash chain;
- canonical read-only Audit projection over existing ledgers;
- policy, Registry, Deploy, Issue, transfer, Control, burn, and supply-accounting evidence;
- lifecycle reconciliation that preserves immutable source events;
- historical partial-coverage labeling and secret-free Testnet export;
- closure of the historical REGT2 controller-supply receipt;
- preservation of holder regulated profiles during controller-supply tracking replacement;
- fresh REGT3 zero-supply Deploy, automatic enrollment, Issue, transfer, freeze/unfreeze, Seizure, and Forced Burn lifecycle;
- third-party Forced Burn with frozen-target enforcement;
- issuer/controller self-custody Forced Burn with a narrowly bounded freeze waiver;
- server rejection of regulated tokens through the ordinary holder-Burn path;
- automatic controller-supply accounting for DO9 and DO10;
- Controls-tab canonical state refresh and selector repopulation;
- Audit projected pending count of zero;
- final read-only regulated closure with 51 passed assertions;
- no additional REGT3 transaction required.

The current regulated Testnet product is closed for feature implementation. The remaining release sequence is:

```text
standard KCC20 end-to-end regression
-> KAS/KRC20/KCC20/Programmable-KAS chooser regression
-> existing Direct/Open KCC20 swap non-degradation regression
-> final source/data/hash and banned-pattern sweep
-> final Testnet Audit export
-> release-candidate bundle and public-package review
-> AWS deployment under a separate approved module
```

v0.9 does not authorize regulated swaps, energy integration, new architecture, AWS changes, or mainnet deployment.

