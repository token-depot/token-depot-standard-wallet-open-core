# Swap Self-Custody Boundary

This document summarizes the swap signing boundary represented by the CW284 reference files.

## Direct/Open swap claim

For Standard Wallet users, swap actions that require wallet authorization use the browser-side unlocked wallet session to produce signatures. Server routes coordinate, validate, store offer metadata, and broadcast signed artifacts; they are not a substitute for Standard Wallet private-key custody.

## Files to inspect

```text
reference/static/js/swaps.js
reference/static/js/offers.js
reference/static/js/offers_open.js
reference/static/js/swap_analyzer_shared.js
reference/server/src/server.ts
reference/server/src/routes/swap_mode_direct.ts
reference/server/src/routes/swap_mode_open.ts
reference/server/src/routes/swap_mode_open_v2.ts
```

## KRC20 / legacy swap boundary

The legacy KRC20 Direct/Open swap reference files show browser-side signing for Standard Wallet swap steps and server-side coordination/broadcast of already-signed artifacts.

## KCC20 Atomic swap boundary

The CW284 reference files also include the KCC20-compatible Atomic swap implementation surfaces:

- Direct Atomic KCC20 v4 maker lock, taker claim, and maker cancel/refund.
- Open Atomic KCC20 dynamic-taker maker lock, taker fill, maker cancel/refund, and expired recovery handling.

## Exclusions

This repository does not include private market-maker systems, hosted swap service credentials, broker/custody private systems, production deployment secrets, or AWS deployment configuration.
