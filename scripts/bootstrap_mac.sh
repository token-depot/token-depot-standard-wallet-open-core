#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$HOME/Projects/Compliance_Wallet}"
VENDOR="$ROOT/vendor"
RUSTY="$VENDOR/rusty-kaspa"

mkdir -p "$ROOT"/{scripts,vendor,bin,wasm/sdk,rust,data,docs/spec,_incoming}

echo "[1/9] Checking Homebrew..."
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew not found. Install it from https://brew.sh and re-run."
  exit 1
fi

echo "[2/9] Installing brew deps (protobuf, llvm, jq)..."
brew update
brew install protobuf llvm jq

echo "[3/9] Writing local env file (no dotfile edits)..."
LLVM_PREFIX="$(brew --prefix llvm)"
cat > "$ROOT/scripts/env_mac.sh" <<EOF
# Compliance_Wallet local env (source in each terminal)
export PATH="$LLVM_PREFIX/bin:\$PATH"
export LDFLAGS="-L$LLVM_PREFIX/lib"
export CPPFLAGS="-I$LLVM_PREFIX/include"
export AR="$LLVM_PREFIX/bin/llvm-ar"
EOF

# Apply env for this run
# shellcheck disable=SC1090
source "$ROOT/scripts/env_mac.sh"

echo "[4/9] Ensuring Rust toolchain (rustup)..."
if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup (official installer)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1090
source "$HOME/.cargo/env"
rustup update

echo "[5/9] Installing wasm toolchain (wasm-pack + wasm32 target)..."
if ! command -v wasm-pack >/dev/null 2>&1; then
  cargo install wasm-pack
fi
rustup target add wasm32-unknown-unknown

echo "[6/9] Cloning/updating kaspanet/rusty-kaspa (stable branch)..."
if [ ! -d "$RUSTY/.git" ]; then
  git clone --branch stable https://github.com/kaspanet/rusty-kaspa "$RUSTY"
else
  (cd "$RUSTY" && git fetch && git checkout stable && git pull)
fi

echo "[7/9] Building Rusty Kaspa CLI (wallet-capable CLI lives under /cli per upstream docs)..."
(cd "$RUSTY/cli" && cargo build --release)

echo "[8/9] Copying built binaries into $ROOT/bin (best-effort)..."
mkdir -p "$ROOT/bin"
shopt -s nullglob
for f in "$RUSTY/target/release/"kaspa* "$RUSTY/target/release/"kasp*; do
  if [ -f "$f" ] && [ -x "$f" ]; then
    cp -f "$f" "$ROOT/bin/"
  fi
done
shopt -u nullglob

echo "[9/9] Creating our Rust workspace scaffolds (Modules 1–3)..."
if [ ! -f "$ROOT/rust/Cargo.toml" ]; then
  cat > "$ROOT/rust/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = [
  "cw-multisig",
  "pskt-engine"
]
EOF
fi

if [ ! -d "$ROOT/rust/cw-multisig" ]; then (cd "$ROOT/rust" && cargo new cw-multisig); fi
if [ ! -d "$ROOT/rust/pskt-engine" ]; then (cd "$ROOT/rust" && cargo new pskt-engine); fi

echo
echo "DONE."
echo "- Source env each terminal:  source \"$ROOT/scripts/env_mac.sh\""
echo "- Binaries (if built):       ls -al \"$ROOT/bin\""
echo "- Upstream code:             \"$ROOT/vendor/rusty-kaspa\""
echo
echo "Optional WASM SDK install from a local zip:"
echo "  1) Drop kaspa-wasm32-sdk*.zip into: $ROOT/_incoming/"
echo "  2) Run: unzip -o \"$ROOT/_incoming/kaspa-wasm32-sdk\"*.zip -d \"$ROOT/wasm/sdk\""
echo
echo "Chrome note: when we start local web servers later, just open the localhost URL in Chrome."
