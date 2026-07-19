import fs from "node:fs";
import path from "node:path";
import initKaspa, { version as kaspaWasmVersion } from "../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

let kaspaReady: Promise<void> | null = null;

export async function ensureKaspaReady(repoRoot: string): Promise<void> {
  if (!kaspaReady) {
    kaspaReady = (async () => {
      const wasmPath = path.join(
        repoRoot,
        "wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa_bg.wasm"
      );
      const wasmBytes = fs.readFileSync(wasmPath);
      await initKaspa({ module_or_path: wasmBytes });
    })();
  }
  await kaspaReady;
}

export function sdkVersion(): string {
  return kaspaWasmVersion();
}
