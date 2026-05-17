# Swap Self-Custody Proof

This document extends WTS from normal Standard Wallet sends into Direct/Open swap signing.

## Claim

For Standard Wallet swap flows, Token Depot's hosted server coordinates analysis, offer storage, transaction preparation, and broadcast, but Standard Wallet signing remains browser-local. The browser uses the locally unlocked key from `cw_keyring_session` and does not send the Standard Wallet private key to the server.

## Direct swap maker path

Review:

```text
reference/static/js/swaps.js
reference/server/src/routes/swap_mode_direct.ts
```

Proof anchors from the source snapshot:

```text
static/js/swaps.js:1219-1250
static/js/swaps.js:1371-1416
server/src/routes/swap_mode_direct.ts:456
server/src/routes/swap_mode_direct.ts:1130-1150
server/src/routes/swap_mode_direct.ts:1558-1585
```

The browser requires the wallet to be unlocked in the same browser tab, validates the active wallet id/address against the session keyring, constructs a local `PrivateKey`, and signs maker-side commit/reveal artifacts locally.

## Direct swap taker/finalize path

Review:

```text
reference/static/js/offers.js
reference/server/src/routes/swap_mode_direct.ts
```

Proof anchors from the source snapshot:

```text
static/js/offers.js:76-132
static/js/offers.js:828-854
server/src/routes/swap_mode_direct.ts:1877
server/src/routes/swap_mode_direct.ts:3663-3715
```

The offer page reads the local browser keyring session, creates local signatures for requested input indexes, and submits signatures/artifacts to the server for finalization/broadcast.

## Open swap maker path

Review:

```text
reference/static/js/swaps.js
reference/server/src/routes/swap_mode_open_v2.ts
```

Proof anchors from the source snapshot:

```text
static/js/swaps.js:1219-1250
static/js/swaps.js:1371-1416
server/src/routes/swap_mode_open_v2.ts:862
server/src/routes/swap_mode_open_v2.ts:1195-1215
server/src/routes/swap_mode_open_v2.ts:1748-1770
server/src/routes/swap_mode_open_v2.ts:1988-2008
```

Open V2 uses staged server preparation and browser-local maker signing. The server prepares SafeJSON transaction artifacts and the browser returns signatures/artifacts rather than private keys.

## Open swap taker/finalize path

Review:

```text
reference/static/js/offers_open.js
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
```

Proof anchors from the source snapshot:

```text
static/js/offers_open.js:76-132
static/js/offers_open.js:570-760
static/js/offers_open.js:832-858
server/src/routes/swap_mode_open.ts:115
server/src/routes/swap_mode_open.ts:510
server/src/routes/swap_mode_open.ts:628
server/src/routes/swap_mode_open_v2.ts:742
server/src/routes/swap_mode_open_v2.ts:837
server/src/routes/swap_mode_open_v2.ts:862
```

The Open offer page uses the local browser keyring session and local input signatures for Standard Wallet acceptance/finalization paths.

## Analyzer/display files

Review:

```text
reference/static/js/swap_analyzer_shared.js
```

This file renders analyzer results and does not perform custody or signing.

## Explicit exclusions

This document does not claim Broker-Custody Wallets are self-custody. BCW paths use local authorization signatures for broker-custody flows and must remain separate from Standard Wallet self-custody claims.

This document does not claim the full hosted product is open-source or independently runnable from this reference repository.
