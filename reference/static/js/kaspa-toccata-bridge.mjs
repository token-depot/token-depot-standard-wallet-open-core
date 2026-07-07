import * as kaspaToccata from "/wasm/sdk/kaspa-wasm32-sdk/web/kaspa/kaspa.js";

window.kaspaToccataReady = (async () => {
  if (typeof kaspaToccata.default === "function") {
    await kaspaToccata.default();
  }
  window.kaspaToccata = kaspaToccata;
  return kaspaToccata;
})().catch((e) => {
  window.kaspaToccataInitError = String(e && e.message ? e.message : e);
  throw e;
});
