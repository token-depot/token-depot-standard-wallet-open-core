// OMA KCC20 Deploy UI
// New KCC20/OMA L1 deploy page wiring only. Does not modify KRC-20 deploy flow.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const UI = {
    activeWallet: $("kcc20ActiveWallet"),
    network: $("kcc20Network"),
    tokenName: $("kcc20TokenName"),
    tokenSymbol: $("kcc20TokenSymbol"),
    decimals: $("kcc20Decimals"),
    maxSupplyRaw: $("kcc20MaxSupplyRaw"),
    initialIssueRaw: $("kcc20InitialIssueRaw"),
    transferRule: $("kcc20TransferRule"),
    policyHash: $("kcc20PolicyHash"),
    controllerCarrierKas: $("kcc20ControllerCarrierKas"),
    holderCarrierKas: $("kcc20HolderCarrierKas"),
    feeReserveKas: $("kcc20FeeReserveKas"),
    buildBtn: $("kcc20BuildBtn"),
    signBtn: $("kcc20SignBtn"),
    submitBtn: $("kcc20SubmitBtn"),
    networkStatus: $("kcc20NetworkStatus"),
    licenseStatus: $("kcc20LicenseStatus"),
    previewWrap: $("kcc20PreviewWrap"),
    preview: $("kcc20Preview"),
    outputWrap: $("kcc20OutputWrap"),
    output: $("kcc20Output"),
    msg: $("kcc20Msg")
  };

  const KEYRING_SESSION_KEY = "cw_keyring_session";
  const SENSITIVE_KEY_RE = /private|priv|seed|mnemonic|passphrase|signatureScript|signature_script|signed|txToSignSafeJson|submit_token|submitToken|auth|secret|password|session|cookie/i;

  let activeStatus = null;
  let lastBuild = null;
  let lastSignedSafeJson = "";
  let submitting = false;

  function setText(el, value) {
    if (el) el.textContent = String(value || "");
  }

  function setMsg(value) {
    setText(UI.msg, value || "Ready.");
  }

  function setHidden(el, hidden) {
    if (el) el.classList.toggle("hidden", !!hidden);
  }

  function setBusy(busy) {
    if (UI.buildBtn) UI.buildBtn.disabled = !!busy;
    if (UI.signBtn) UI.signBtn.disabled = !!busy || !lastBuild;
    if (UI.submitBtn) UI.submitBtn.disabled = !!busy || !lastBuild || !lastSignedSafeJson || submitting;
  }

  function sanitizeForDisplay(value, depth) {
    if (depth > 8) return "[depth_limit]";
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeForDisplay(item, depth + 1));
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return value;

    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeForDisplay(raw, depth + 1);
      }
    }
    return out;
  }

  function showJson(targetWrap, target, value) {
    if (!targetWrap || !target) return;
    target.textContent = JSON.stringify(sanitizeForDisplay(value, 0), null, 2);
    setHidden(targetWrap, false);
  }

  async function httpJson(method, url, body) {
    const headers = { "Accept": "application/json" };
    const init = { method, credentials: "include", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
    if (!response.ok) {
      const err = new Error((parsed && (parsed.reason || parsed.error)) ? String(parsed.reason || parsed.error) : `HTTP ${response.status}`);
      err.status = response.status;
      err.payload = parsed || { ok: false, raw: text };
      throw err;
    }
    return parsed !== null ? parsed : text;
  }

  function networkSharedOrThrow() {
    const shared = window.CwNetworkShared;
    if (!shared || typeof shared.getNetworkMeta !== "function") throw new Error("network_shared_missing");
    return shared;
  }

  function networkMetaOrThrow(raw) {
    const meta = networkSharedOrThrow().getNetworkMeta(raw);
    if (!meta || !meta.appKey) throw new Error("invalid_active_wallet_network");
    return meta;
  }

  function sdkAddressNetworkLabelOrThrow(raw) {
    const meta = networkMetaOrThrow(raw);
    const label = String(meta.walletNetworkLabel || "").trim();
    if (!label) throw new Error("invalid_wallet_address_network");
    return label;
  }

  async function kaspaReadyOrThrow() {
    if (window.kaspaReady && typeof window.kaspaReady.then === "function") await window.kaspaReady;
    if (!window.kaspa) throw new Error("kaspa_sdk_not_loaded");
    return window.kaspa;
  }

  function readKeyringSessionOrThrow() {
    const raw = window.sessionStorage ? window.sessionStorage.getItem(KEYRING_SESSION_KEY) : null;
    if (!raw) throw new Error("wallet_locked");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Number(parsed.v || 0) !== 1) throw new Error("wallet_locked");
    const priv0Hex = String(parsed.priv0_hex || "").trim();
    if (!/^[0-9a-f]{64}$/i.test(priv0Hex)) throw new Error("wallet_locked");
    return parsed;
  }

  async function activeKeyringOrThrow() {
    if (!activeStatus || activeStatus.ok !== true) throw new Error("active_wallet_required");
    const sess = readKeyringSessionOrThrow();
    const walletId = String(activeStatus.wallet_id || "").trim();
    const walletType = String(activeStatus.wallet_type || "").trim();
    const address0 = String(activeStatus.address0 || "").trim();
    if (!walletId || !walletType || !address0) throw new Error("active_wallet_required");
    if (String(sess.wallet_id || "").trim() !== walletId) throw new Error("wallet_locked");
    if (String(sess.wallet_type || "").trim() !== walletType) throw new Error("wallet_locked");

    const k = await kaspaReadyOrThrow();
    const priv0 = new k.PrivateKey(String(sess.priv0_hex || "").trim());
    if (walletType === "standard") {
      const label = sdkAddressNetworkLabelOrThrow(activeStatus.network || activeStatus.net || "");
      const derivedAddress = String(priv0.toAddress(label).toString());
      if (derivedAddress !== address0) throw new Error("wallet_locked");
    }
    return { priv0, owner_public_key: priv0.toPublicKey().toString(), address0 };
  }

  function unsignedIntegerString(raw, fieldName, allowZero) {
    const text = String(raw || "").trim();
    if (!/^\d+$/.test(text)) throw new Error(`${fieldName}_must_be_unsigned_integer`);
    const value = BigInt(text);
    if (!allowZero && value <= 0n) throw new Error(`${fieldName}_must_be_positive`);
    return value.toString();
  }

  function decimalsValueOrThrow() {
    const value = Number(String(UI.decimals && UI.decimals.value || "0").trim());
    if (!Number.isInteger(value) || value < 0 || value > 18) throw new Error("decimals_must_be_0_to_18");
    return value;
  }

  function kasToSompiString(raw, fieldName, allowZero) {
    const text = String(raw || "").trim();
    if (!/^\d+(\.\d{0,8})?$/.test(text)) throw new Error(`${fieldName}_kas_invalid`);
    const [wholeRaw, fracRaw = ""] = text.split(".");
    const whole = BigInt(wholeRaw || "0") * 100000000n;
    const frac = BigInt((fracRaw + "00000000").slice(0, 8));
    const value = whole + frac;
    if (!allowZero && value <= 0n) throw new Error(`${fieldName}_kas_must_be_positive`);
    return value.toString();
  }

  function gatherPayload(ownerPublicKey) {
    const tokenName = String(UI.tokenName && UI.tokenName.value || "").trim();
    const symbol = String(UI.tokenSymbol && UI.tokenSymbol.value || "").trim().toUpperCase();
    if (!tokenName || tokenName.length > 64) throw new Error("token_name_required_max_64");
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) throw new Error("token_symbol_must_be_2_to_16_AZ09");

    const maxSupplyRaw = unsignedIntegerString(UI.maxSupplyRaw && UI.maxSupplyRaw.value, "max_supply_raw", false);
    const initialIssueRaw = unsignedIntegerString(UI.initialIssueRaw && UI.initialIssueRaw.value, "initial_issue_raw", true);
    if (BigInt(initialIssueRaw) > BigInt(maxSupplyRaw)) throw new Error("initial_issue_exceeds_max_supply");

    const transferRule = String(UI.transferRule && UI.transferRule.value || "owner_signature_required").trim();
    if (transferRule !== "owner_signature_required") throw new Error("unsupported_transfer_rule");

    const holderCarrierSompi = kasToSompiString(UI.holderCarrierKas && UI.holderCarrierKas.value, "holder_carrier", BigInt(initialIssueRaw) === 0n);
    if (BigInt(initialIssueRaw) > 0n && BigInt(holderCarrierSompi) <= 0n) throw new Error("holder_carrier_required_when_initial_issue_positive");

    return {
      token_name: tokenName,
      token_symbol: symbol,
      decimals: decimalsValueOrThrow(),
      max_supply_raw: maxSupplyRaw,
      initial_issue_raw: initialIssueRaw,
      transfer_rule: transferRule,
      policy_hash: String(UI.policyHash && UI.policyHash.value || "").trim(),
      owner_public_key: ownerPublicKey,
      controller_carrier_sompi: kasToSompiString(UI.controllerCarrierKas && UI.controllerCarrierKas.value, "controller_carrier", false),
      holder_carrier_sompi: holderCarrierSompi,
      fee_reserve_sompi: kasToSompiString(UI.feeReserveKas && UI.feeReserveKas.value || "0.01", "fee_reserve", false)
    };
  }

  async function loadActiveWallet() {
    const status = await httpJson("GET", "/api/wallet/status");
    if (!status || status.ok !== true) throw new Error("active_wallet_required");
    activeStatus = status;

    const meta = networkMetaOrThrow(status.network || status.net || "");
    if (UI.activeWallet) UI.activeWallet.value = String(status.address0 || "");
    if (UI.network) UI.network.value = String(meta.sdkNetworkId || meta.appKey || status.network || "");

    if (UI.networkStatus) {
      UI.networkStatus.textContent = meta.isMainnet
        ? "mainnet active wallet detected. Direct API and page access require OMA PRO / TDPRO."
        : `${meta.sdkNetworkId || meta.displayLabel || meta.appKey} active wallet detected. Testnet deploy is available to authenticated OMA users.`;
    }
    if (UI.licenseStatus) {
      UI.licenseStatus.textContent = meta.isMainnet
        ? "Mainnet build/submit is blocked unless the existing PRO entitlement check passes."
        : "No PRO entitlement required for testnet-10 build/sign/submit tests.";
    }
    setMsg("Active wallet loaded.");
    return status;
  }

  function resetSignedState() {
    lastSignedSafeJson = "";
    if (UI.submitBtn) UI.submitBtn.disabled = true;
  }

  async function onBuild() {
    try {
      setBusy(true);
      setMsg("Building deploy packet…");
      resetSignedState();
      setHidden(UI.outputWrap, true);
      const keyring = await activeKeyringOrThrow();
      const payload = gatherPayload(keyring.owner_public_key);
      const build = await httpJson("POST", "/api/covenants/issuer-token/deploy/build", payload);
      if (!build || build.ok !== true || build.deploy_build_kind !== "oma_l1_token_deploy_build_v1") throw new Error("deploy_build_failed");
      lastBuild = build;
      showJson(UI.previewWrap, UI.preview, {
        proof_kind: "kcc20_deploy_build_preview_v1",
        ok: true,
        networkId: build.networkId,
        wallet_id: build.wallet_id,
        token_definition: build.token_definition,
        carrier_kas: build.carrier_kas,
        output_plan: build.output_plan,
        invariants: build.invariants,
        mass: build.mass,
        submit_route_enabled: build.submit_route_enabled,
        signing_enabled: false,
        broadcasting_enabled: false,
        minting_enabled: false
      });
      setMsg("Build complete. Review proof, then sign locally.");
    } catch (e) {
      lastBuild = null;
      resetSignedState();
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Build failed.");
    } finally {
      setBusy(false);
      if (UI.signBtn) UI.signBtn.disabled = !lastBuild;
    }
  }

  async function onSign() {
    try {
      if (!lastBuild) throw new Error("build_required_before_sign");
      setBusy(true);
      setMsg("Signing locally…");
      const keyring = await activeKeyringOrThrow();
      const k = await kaspaReadyOrThrow();
      const txSafeJson = String(lastBuild.txToSignSafeJson || "").trim();
      const signInputIndexes = Array.isArray(lastBuild.signInputIndexes) ? lastBuild.signInputIndexes.map((v) => Number(v)) : [];
      if (!txSafeJson || signInputIndexes.length !== 1 || signInputIndexes[0] !== 0) throw new Error("unexpected_deploy_sign_plan");
      const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
      const signature = k.createInputSignature(tx, 0, keyring.priv0, null);
      const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
      if (!inputs[0]) throw new Error("deploy_input_missing");
      inputs[0].signatureScript = signature;
      tx.inputs = inputs;
      tx.finalize();
      lastSignedSafeJson = tx.serializeToSafeJSON();
      k.Transaction.deserializeFromSafeJSON(lastSignedSafeJson);
      showJson(UI.outputWrap, UI.output, {
        proof_kind: "kcc20_deploy_sign_only_v1",
        ok: true,
        deploy_build_kind: lastBuild.deploy_build_kind,
        unsigned_safe_json_sha256: lastBuild.unsigned_safe_json_sha256,
        signatureScript_present: true,
        signed_tx_deserialize_check_ok: true,
        private_key_printed: false,
        signature_script_printed: false,
        signed_transaction_printed: false,
        submit_called: false,
        broadcasting: "none",
        minting: "none"
      });
      setMsg("Signed locally. Submit once when ready.");
    } catch (e) {
      lastSignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Sign failed.");
    } finally {
      setBusy(false);
      if (UI.signBtn) UI.signBtn.disabled = !lastBuild;
      if (UI.submitBtn) UI.submitBtn.disabled = !lastSignedSafeJson;
    }
  }

  async function onSubmit() {
    try {
      if (!lastBuild || !lastSignedSafeJson) throw new Error("signed_deploy_required_before_submit");
      setBusy(true);
      submitting = true;
      setMsg("Submitting deploy once…");
      const submit = await httpJson("POST", "/api/covenants/issuer-token/deploy/submit", {
        submit_intent: "submit_oma_l1_token_deploy_v1",
        submit_token: lastBuild.submit_token,
        signedSafeJson: lastSignedSafeJson
      });
      showJson(UI.outputWrap, UI.output, {
        proof_kind: "kcc20_deploy_submit_v1",
        ok: submit && submit.ok === true,
        submit_kind: submit && submit.submit_kind,
        application_status: submit && submit.application_status,
        submitted_txid: submit && submit.submitted_txid,
        asset_covenant_id: submit && submit.asset_covenant_id,
        post_submit_scan_status: submit && submit.post_submit_scan_status,
        tracked_asset: submit && submit.tracked_asset ? submit.tracked_asset : null,
        signed_transaction_json_echoed: false,
        signature_script_echoed: false,
        broadcasting: submit && submit.broadcasting ? submit.broadcasting : "submitted_once",
        minting: submit && submit.minting ? submit.minting : "none"
      });
      setMsg("Deploy submitted once.");
    } catch (e) {
      submitting = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Submit failed.");
    } finally {
      setBusy(false);
      if (submitting && UI.submitBtn) UI.submitBtn.disabled = true;
    }
  }

  function bind() {
    if (UI.tokenSymbol) {
      UI.tokenSymbol.addEventListener("input", function () {
        const caret = UI.tokenSymbol.selectionStart;
        UI.tokenSymbol.value = String(UI.tokenSymbol.value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
        try { UI.tokenSymbol.setSelectionRange(caret, caret); } catch (_) {}
      });
    }
    if (UI.buildBtn) UI.buildBtn.addEventListener("click", onBuild);
    if (UI.signBtn) UI.signBtn.addEventListener("click", onSign);
    if (UI.submitBtn) UI.submitBtn.addEventListener("click", onSubmit);
  }

  async function init() {
    bind();
    setBusy(true);
    try {
      await kaspaReadyOrThrow();
      await loadActiveWallet();
    } catch (e) {
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e) });
      setMsg("Open and unlock the active wallet first.");
    } finally {
      setBusy(false);
      if (UI.signBtn) UI.signBtn.disabled = true;
      if (UI.submitBtn) UI.submitBtn.disabled = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
