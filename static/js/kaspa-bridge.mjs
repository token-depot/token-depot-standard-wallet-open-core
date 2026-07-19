import * as kaspa from "/wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

window.kaspaReady = (async () => {
  if (typeof kaspa.default === "function") {
    await kaspa.default();
  }
  window.kaspa = kaspa;
  return kaspa;
})().catch((e) => {
  window.kaspaInitError = String(e && e.message ? e.message : e);
  throw e;
});
