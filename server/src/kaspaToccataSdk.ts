import fs from "node:fs";
import path from "node:path";
import initKaspaToccata, {
  version as kaspaToccataWasmVersion,
  Transaction,
  TransactionInput,
  TransactionOutput,
  CovenantBinding,
  PaymentOutput,
  covenantId
} from "../../wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

let kaspaToccataReady: Promise<void> | null = null;

export async function ensureKaspaToccataReady(repoRoot: string): Promise<void> {
  if (!kaspaToccataReady) {
    kaspaToccataReady = (async () => {
      const wasmPath = path.join(
        repoRoot,
        "wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa_bg.wasm"
      );
      const wasmBytes = fs.readFileSync(wasmPath);
      await initKaspaToccata({ module_or_path: wasmBytes });
    })();
  }
  await kaspaToccataReady;
}

export function toccataSdkVersion(): string {
  return kaspaToccataWasmVersion();
}

export function toccataSdkSurfaceReport(): Record<string, string> {
  return {
    version: kaspaToccataWasmVersion(),
    Transaction: typeof Transaction,
    TransactionInput: typeof TransactionInput,
    TransactionOutput: typeof TransactionOutput,
    CovenantBinding: typeof CovenantBinding,
    PaymentOutput: typeof PaymentOutput,
    covenantId: typeof covenantId
  };
}
