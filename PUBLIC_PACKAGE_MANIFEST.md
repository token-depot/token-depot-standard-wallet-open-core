# Compliance_Wallet 298 — Public Release Candidate 1 Manifest

**Package:** `Compliance_Wallet_298_Public_RC1.zip`  
**Purpose:** Sanitized public GitHub source-release candidate. This is **not** the private working SoT and is **not** an AWS deployment bundle.  
**Created:** 2026-07-18  
**Private working SoT:** `Compliance_Wallet_298_Mac.zip`  
**Private working SoT SHA-256:** `55e3c25e150b71bef9da697aec2b49d8d1755b966ce660463005c65768fbadc5`

## Controlling specification

Private controlling source specification:

```text
KCC20_Regulated_Compliance_Workspace_Specification_v0.9.md
SHA-256: e8aa37a4bc2f7d9a5601a4fc3becae58a5f04646afcb7a5b49d7be79b3735047
```

The public package includes a publication copy with the concrete user-scoped path identifier replaced by `<userId>` and no other textual change:

```text
docs/spec/KCC20_Regulated_Compliance_Workspace_Specification_v0.9_PUBLIC.md
SHA-256: 9acb1f5ed5a494db0aaab9d35791c075a2bafc22f97edba58da7fd6b2ea91175
```

## Public allowlist

Top-level application files:

```text
.gitignore
README.md
agency-reseller-kit.html
config.yaml
covenants.html
deploy.html
energy.html
favicon.ico
index.html
issue.html
kcc20-deploy.html
kcc20-issue.html
kcc20-regulated-deploy.html
login.html
manage.html
offers.html
package-lock.json
package.json
redeem.html
tsconfig.json
wallet.html
```

Source and public-asset directories:

```text
brands/**
etc/**
rust/**
scripts/**
server/**
static/**
vendor/**
wasm/**
```

Release-generated documentation:

```text
PUBLIC_PACKAGE_MANIFEST.md
RELEASE_NOTES.md
SECURITY_SCAN.txt
CHECKSUMS.sha256
docs/spec/KCC20_Regulated_Compliance_Workspace_Specification_v0.9_PUBLIC.md
```

## Required exclusions

The public package intentionally excludes:

```text
data/**                         user-scoped ledgers, wallet stores, offers, caches, runtime state
logs/**                         runtime logs
node_modules/**                  local dependency installation
tmp/**                          signed/unsigned SafeJSON and temporary transaction artifacts
bin/**                          architecture-specific compiled helper binaries
reset_bcw_open_swap_retry.py    contains a pinned historical wallet ID and address
.DS_Store                       macOS metadata
*.bak* / *STOPLINE*             historical backups and stop-line recovery files
*.log                           runtime logs
.env*                           environment/secrets files
```

The private Testnet Audit export is also excluded:

```text
kcc20-regulated-testnet-audit-report.v1(2).json
SHA-256: d94a154dd48a8ae19a1b1f39e78aebf7065f447f593b34b21ec169b6ce7c223d
Reason: contains user IDs, wallet IDs, wallet addresses, outpoints, and transaction history.
```

## Package statistics

```text
Final archive file count: 570
Archive corruption check: required to pass
Post-archive privacy scan: required to pass
Internal checksum verification: required to pass
```

## Privacy and secret scan

```text
Forbidden path matches: 0
Exact private identifier/address matches: 0
Generic USR_* matches: 0
Generic WALLET_* matches: 0
Private-key/secret marker matches: 0
```

All counts above must be `0` except the informational files-scanned/binary-skipped counts.

## Verification boundary

The private CW298 SoT passed JavaScript syntax checks and TypeScript `tsc --noEmit` before packaging. The staged public candidate was independently syntax-checked and typechecked using a temporary dependency symlink that was removed before archive creation. The archive was then reopened, checked for corruption, extracted, rescanned, and checksum-verified.

## Publication boundary

This archive contains public source and public application assets only. It does not contain a wallet, private key, seed, passphrase, session secret, Admin Token, API key, signed transaction JSON, signature script, redeem script, submit token, user-scoped Audit ledger, private Audit export, or production deployment secret.
