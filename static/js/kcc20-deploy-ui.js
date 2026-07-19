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
    regulatedPreviewMode: $("kcc20RegulatedPreviewMode"),
    regulatedProfileVersion: $("kcc20RegulatedProfileVersion"),
    policyRegistryCovenantId: $("kcc20PolicyRegistryCovenantId"),
    policyEpoch: $("kcc20PolicyEpoch"),
    controlFlags: $("kcc20ControlFlags"),
    buildBtn: $("kcc20BuildBtn"),
    signBtn: $("kcc20SignBtn"),
    submitBtn: $("kcc20SubmitBtn"),
    networkStatus: $("kcc20NetworkStatus"),
    licenseStatus: $("kcc20LicenseStatus"),
    previewWrap: $("kcc20PreviewWrap"),
    preview: $("kcc20Preview"),
    outputWrap: $("kcc20OutputWrap"),
    output: $("kcc20Output"),
    msg: $("kcc20Msg"),
    successBanner: $("crDeploySuccessBanner"),
    successTitle: $("crDeploySuccessTitle"),
    successMessage: $("crDeploySuccessMessage"),
    successAssetCovenantId: $("crDeploySuccessAssetCovenantId"),
    successTxid: $("crDeploySuccessTxid"),
    resultToken: $("kcc20DeployResultToken"),
    resultTracking: $("kcc20DeployResultTracking"),
    resultNextStep: $("kcc20DeployResultNextStep")
  };

  const KEYRING_SESSION_KEY = "cw_keyring_session";
  const SENSITIVE_KEY_RE = /private|priv|seed|mnemonic|passphrase|signatureScript|signature_script|signed|txToSignSafeJson|submit_token|submitToken|auth|secret|password|session|cookie/i;

  let activeStatus = null;
  let lastBuild = null;
  let lastSignedSafeJson = "";
  let submitting = false;
  let regulatedNetworkBlocked = false;
  let deploymentCompleted = false;
  let regulatedDeployOrchestrating = false;
  let standardDeployOrchestrating = false;

  function isRegulatedPreviewMode() {
    return !!UI.regulatedPreviewMode;
  }

  function setText(el, value) {
    if (el) el.textContent = String(value || "");
  }

  function setMsg(value) {
    setText(UI.msg, value || "Ready.");
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle("hidden", !!hidden);
    el.hidden = !!hidden;
  }

  function setBusy(busy) {
    if (isRegulatedPreviewMode()) {
      const working = !!busy || regulatedDeployOrchestrating || submitting;
      if (UI.buildBtn) {
        UI.buildBtn.textContent = deploymentCompleted
          ? "Regulated Token Live"
          : (working ? "Deploying Regulated Token…" : "Deploy Regulated Token");
        UI.buildBtn.disabled = deploymentCompleted || working || regulatedNetworkBlocked;
        UI.buildBtn.title = UI.buildBtn.disabled
          ? (deploymentCompleted
              ? "The regulated token is live and verified."
              : (regulatedNetworkBlocked
                  ? "A READY Testnet-10 wallet is required."
                  : "The regulated token deployment is in progress."))
          : "Build, sign locally, submit, and live-verify the zero-supply regulated token on Testnet-10.";
      }
      if (UI.signBtn) {
        UI.signBtn.hidden = true;
        UI.signBtn.disabled = true;
        UI.signBtn.setAttribute("aria-hidden", "true");
      }
      if (UI.submitBtn) {
        UI.submitBtn.hidden = true;
        UI.submitBtn.disabled = true;
        UI.submitBtn.setAttribute("aria-hidden", "true");
      }
      return;
    }

    if (deploymentCompleted) {
      if (UI.buildBtn) {
        UI.buildBtn.textContent = "Token Deployed";
        UI.buildBtn.disabled = true;
        UI.buildBtn.title = "The KCC20 token is live and tracked. Refresh only when intentionally deploying another token.";
      }
      if (UI.signBtn) UI.signBtn.disabled = true;
      if (UI.submitBtn) UI.submitBtn.disabled = true;
      return;
    }
    const working = !!busy || standardDeployOrchestrating || submitting;
    if (UI.buildBtn) {
      UI.buildBtn.textContent = working ? "Deploying Token…" : "Deploy Token";
      UI.buildBtn.disabled = working || regulatedNetworkBlocked;
    }
    if (UI.signBtn) {
      UI.signBtn.hidden = true;
      UI.signBtn.disabled = true;
      UI.signBtn.setAttribute("aria-hidden", "true");
    }
    if (UI.submitBtn) {
      UI.submitBtn.hidden = true;
      UI.submitBtn.disabled = true;
      UI.submitBtn.setAttribute("aria-hidden", "true");
    }
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

  function hideStandardDeployResult() {
    if (isRegulatedPreviewMode() || !UI.successBanner) return;
    setHidden(UI.successBanner, true);
  }

  function standardDeployReason(errorValue) {
    return String(errorValue && errorValue.message ? errorValue.message : errorValue || "unknown_deploy_failure");
  }

  function showStandardDeployResult(state, title, message, details) {
    if (isRegulatedPreviewMode() || !UI.successBanner) return;
    const info = details && typeof details === "object" ? details : {};
    UI.successBanner.setAttribute("data-state", state === "failed" ? "failed" : "success");
    setText(UI.successTitle, title);
    setText(UI.successMessage, message);
    setText(UI.resultToken, info.token || "—");
    setText(UI.successAssetCovenantId, info.assetCovenantId || "—");
    setText(UI.successTxid, info.txid || "—");
    setText(UI.resultTracking, info.tracking || "—");
    setText(UI.resultNextStep, info.nextStep || "No transaction was repeated automatically. Correct the displayed reason before trying again.");
    setHidden(UI.successBanner, false);
    if (UI.successBanner && typeof UI.successBanner.scrollIntoView === "function") {
      UI.successBanner.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function showStandardDeployFailure(stage, errorValue) {
    const reason = standardDeployReason(errorValue);
    const tokenName = String(UI.tokenName && UI.tokenName.value || "").trim();
    const tokenSymbol = String(UI.tokenSymbol && UI.tokenSymbol.value || "").trim().toUpperCase();
    showStandardDeployResult(
      "failed",
      "KCC20 token deployment failed",
      `${stage} failed: ${reason}`,
      {
        token: tokenName || tokenSymbol ? `${tokenName || "KCC20 token"}${tokenSymbol ? ` (${tokenSymbol})` : ""}` : "KCC20 token",
        tracking: `Failed stage: ${stage}`,
        nextStep: "No transaction was repeated automatically. Correct the displayed reason before trying again."
      }
    );
  }

  function showStandardDeployCompletion(submit) {
    if (isRegulatedPreviewMode()) return;
    const txid = String(submit && submit.submitted_txid || "").trim().toLowerCase();
    const assetCovenantId = String(submit && submit.asset_covenant_id || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("standard_deploy_submit_txid_invalid");
    if (!/^[0-9a-f]{64}$/.test(assetCovenantId)) throw new Error("standard_deploy_asset_covenant_id_invalid");
    const tokenDefinition = lastBuild && lastBuild.token_definition ? lastBuild.token_definition : {};
    const tokenName = String(tokenDefinition.token_name || UI.tokenName && UI.tokenName.value || "KCC20 token").trim() || "KCC20 token";
    const tokenSymbol = String(tokenDefinition.token_symbol || UI.tokenSymbol && UI.tokenSymbol.value || "").trim().toUpperCase();
    const tracked = submit && submit.tracked_asset ? submit.tracked_asset : null;
    const tracking = String(
      tracked && (tracked.tracking_status || tracked.verification_status)
      || submit && submit.post_submit_scan_status
      || "live-chain verified"
    );

    deploymentCompleted = true;
    submitting = false;
    showStandardDeployResult(
      "success",
      "KCC20 token deployed successfully",
      "The token is live and tracked. Deployment controls are locked to prevent accidental duplicate submission.",
      {
        token: `${tokenName}${tokenSymbol ? ` (${tokenSymbol})` : ""}`,
        assetCovenantId,
        txid,
        tracking,
        nextStep: "Open the KCC20 Issue page to create additional supply, or refresh only when intentionally deploying another token."
      }
    );
    setBusy(false);
  }

  function showRegulatedDeployCompletion(submit) {
    if (!isRegulatedPreviewMode()) return;
    const txid = String(submit && submit.submitted_txid || "").trim().toLowerCase();
    const assetCovenantId = String(submit && submit.asset_covenant_id || "").trim().toLowerCase();
    const tracked = submit && submit.tracked_asset ? submit.tracked_asset : null;
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("regulated_deploy_submit_txid_invalid");
    if (!/^[0-9a-f]{64}$/.test(assetCovenantId)) throw new Error("regulated_deploy_asset_covenant_id_invalid");
    if (
      !tracked
      || tracked.stored_record_written !== true
      || tracked.tracking_status !== "stored_after_live_chain_verification"
      || tracked.verification_status !== "live_chain_recomputed_controller_only_zero_supply_match"
      || String(tracked.controller_outpoint || "") !== `${txid}:0`
    ) {
      throw new Error("regulated_deploy_live_tracking_proof_invalid");
    }

    deploymentCompleted = true;
    lastBuild = null;
    lastSignedSafeJson = "";
    submitting = false;
    setText(UI.successTitle, "KCC20-Regulated token deployed successfully on Testnet-10");
    setText(UI.successMessage, "The zero-supply issuer controller is live and tracked. The deployment controls are now locked to prevent accidental duplicate submission.");
    setText(UI.successAssetCovenantId, assetCovenantId);
    setText(UI.successTxid, txid);
    setHidden(UI.successBanner, false);
    setBusy(false);
    window.dispatchEvent(new CustomEvent("cw:kcc20-regulated-deploy-complete", {
      detail: Object.freeze({
        asset_covenant_id: assetCovenantId,
        submitted_txid: txid
      })
    }));
    if (UI.successBanner && typeof UI.successBanner.scrollIntoView === "function") {
      UI.successBanner.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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

  function regulatedPreviewPayloadOrEmpty() {
    if (!isRegulatedPreviewMode()) return {};

    const rvText = unsignedIntegerString(UI.regulatedProfileVersion && UI.regulatedProfileVersion.value || "1", "regulated_profile_version", false);
    if (rvText !== "1") throw new Error("regulated_profile_version_must_be_1");

    const pr = String(UI.policyRegistryCovenantId && UI.policyRegistryCovenantId.value || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pr)) throw new Error("policy_registry_covenant_id_64_hex_required");

    const peText = unsignedIntegerString(UI.policyEpoch && UI.policyEpoch.value, "policy_epoch", false);
    const pe = Number(peText);
    if (!Number.isSafeInteger(pe) || pe < 1 || pe > 4294967295) throw new Error("policy_epoch_out_of_range");

    const fcText = unsignedIntegerString(UI.controlFlags && UI.controlFlags.value, "control_flags", false);
    const fc = Number(fcText);
    if (!Number.isSafeInteger(fc) || fc < 1 || fc > 63) throw new Error("control_flags_out_of_range");

    return {
      kcc20_regulated: true,
      rg: 1,
      rv: 1,
      pr,
      pe,
      fc
    };
  }

  function gatherPayload(ownerPublicKey) {
    const tokenName = String(UI.tokenName && UI.tokenName.value || "").trim();
    const symbol = String(UI.tokenSymbol && UI.tokenSymbol.value || "").trim().toUpperCase();
    if (!tokenName || tokenName.length > 64) throw new Error("token_name_required_max_64");
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) throw new Error("token_symbol_must_be_2_to_16_AZ09");

    const maxSupplyRaw = unsignedIntegerString(UI.maxSupplyRaw && UI.maxSupplyRaw.value, "max_supply_raw", false);
    const initialIssueRaw = unsignedIntegerString(UI.initialIssueRaw && UI.initialIssueRaw.value, "initial_issue_raw", true);
    if (isRegulatedPreviewMode() && initialIssueRaw !== "0") throw new Error("kcc20_regulated_initial_issue_raw_must_be_zero");
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
      fee_reserve_sompi: kasToSompiString(UI.feeReserveKas && UI.feeReserveKas.value || "0.01", "fee_reserve", false),
      ...regulatedPreviewPayloadOrEmpty()
    };
  }

  async function loadActiveWallet() {
    const status = await httpJson("GET", "/api/wallet/status");
    if (!status || status.ok !== true) throw new Error("active_wallet_required");
    activeStatus = status;

    const meta = networkMetaOrThrow(status.network || status.net || "");
    if (UI.activeWallet) UI.activeWallet.value = String(status.address0 || "");
    if (UI.network) UI.network.value = String(meta.sdkNetworkId || meta.appKey || status.network || "");

    regulatedNetworkBlocked = isRegulatedPreviewMode() && meta.sdkNetworkId !== "testnet-10";
    if (UI.networkStatus) {
      UI.networkStatus.textContent = isRegulatedPreviewMode()
        ? (regulatedNetworkBlocked
            ? `${meta.sdkNetworkId || meta.displayLabel || meta.appKey} active wallet detected. KCC20-Regulated live actions are limited to testnet-10.`
            : "testnet-10 active wallet detected. KCC20-Regulated Deploy build, local signing, and submit are enabled.")
        : (meta.isMainnet
            ? "mainnet active wallet detected. Direct API and page access require OMA PRO / TDPRO."
            : `${meta.sdkNetworkId || meta.displayLabel || meta.appKey} active wallet detected. Testnet deploy is available to authenticated OMA users.`);
    }
    if (UI.licenseStatus) {
      UI.licenseStatus.textContent = isRegulatedPreviewMode()
        ? (regulatedNetworkBlocked
            ? "Build, Sign, and Submit are blocked outside testnet-10."
            : "TN10 activation enabled: zero-supply regulated Deploy may be built, signed locally, submitted, and tracked.")
        : (meta.isMainnet
            ? "Mainnet build/submit is blocked unless the existing PRO entitlement check passes."
            : "No PRO entitlement required for testnet-10 build/sign/submit tests.");
    }
    setMsg("Active wallet loaded.");
    return status;
  }

  function resetSignedState() {
    lastSignedSafeJson = "";
    if (UI.submitBtn) UI.submitBtn.disabled = true;
  }

  function deploySigningPlan(build) {
    const txSafeJson = String(build && build.txToSignSafeJson || "").trim();
    const signInputIndexes = Array.isArray(build && build.signInputIndexes)
      ? build.signInputIndexes.map((value) => Number(value))
      : [];
    const contextIndexes = Array.isArray(build && build.signing_context_public?.native_kas_funding_input_indexes)
      ? build.signing_context_public.native_kas_funding_input_indexes.map((value) => Number(value))
      : [];
    const nativeFundingInputs = Array.isArray(build && build.native_kas_funding_inputs)
      ? build.native_kas_funding_inputs
      : [];

    if (!txSafeJson || !signInputIndexes.length) throw new Error("unexpected_deploy_sign_plan");
    if (signInputIndexes.some((value, index) => !Number.isInteger(value) || value !== index)) {
      throw new Error("unexpected_deploy_sign_plan");
    }
    if (contextIndexes.length !== signInputIndexes.length
      || contextIndexes.some((value, index) => value !== signInputIndexes[index])) {
      throw new Error("unexpected_deploy_signing_context");
    }
    if (nativeFundingInputs.length !== signInputIndexes.length
      || nativeFundingInputs.some((input, index) => Number(input && input.input_index) !== signInputIndexes[index])) {
      throw new Error("unexpected_deploy_native_funding_inputs");
    }

    return { txSafeJson, signInputIndexes, nativeFundingInputs };
  }

  async function onBuild() {
    try {
      if (deploymentCompleted) throw new Error("regulated_deploy_already_completed_refresh_to_deploy_another_token");
      setBusy(true);
      hideStandardDeployResult();
      setMsg("Building deploy packet…");
      resetSignedState();
      setHidden(UI.outputWrap, true);
      if (regulatedNetworkBlocked) throw new Error("kcc20_regulated_preview_testnet_10_only");
      const keyring = await activeKeyringOrThrow();
      const payload = gatherPayload(keyring.owner_public_key);
      const build = await httpJson("POST", "/api/covenants/issuer-token/deploy/build", payload);
      if (!build || build.ok !== true || build.deploy_build_kind !== "oma_l1_token_deploy_build_v1") throw new Error("deploy_build_failed");
      const signingPlan = deploySigningPlan(build);
      const regulatedPreview = isRegulatedPreviewMode();
      const regulatedProfilePreview = build.token_definition && build.token_definition.regulated_profile_preview
        ? build.token_definition.regulated_profile_preview
        : null;
      if (regulatedPreview) {
        if (!regulatedProfilePreview || regulatedProfilePreview.preview_only !== false) {
          throw new Error("kcc20_regulated_live_profile_missing");
        }
        if (
          build.application_status !== "regulated_deploy_build_ready_for_local_sign_submit_tn10"
          || build.submit_route_enabled !== true
          || build.submit_route !== "/api/covenants/issuer-token/deploy/submit"
          || typeof build.submit_token !== "string"
          || !build.submit_token
          || signingPlan.signInputIndexes[0] !== 0
          || build.safety?.kcc20_regulated_submit_cache_written !== true
        ) {
          throw new Error("kcc20_regulated_live_deploy_plan_invalid");
        }
      }
      lastBuild = build;
      showJson(UI.previewWrap, UI.preview, regulatedPreview ? {
        proof_kind: "kcc20_regulated_tn10_deploy_build_ready_v1",
        ok: true,
        networkId: build.networkId,
        wallet_id: build.wallet_id,
        token_definition: build.token_definition,
        regulated_profile_preview: regulatedProfilePreview,
        controller_state_envelope_preview: regulatedProfilePreview && regulatedProfilePreview.controller_state_envelope_preview,
        holder_token_state_envelope_preview: regulatedProfilePreview && regulatedProfilePreview.holder_token_state_envelope_preview,
        actual_deploy_outputs_include_regulated_fields: regulatedProfilePreview && regulatedProfilePreview.actual_deploy_outputs_include_regulated_fields,
        submit_route_persists_regulated_profile: regulatedProfilePreview && regulatedProfilePreview.submit_route_persists_regulated_profile,
        regulated_live_issuance_enabled: build.token_definition && build.token_definition.regulated_live_issuance_enabled,
        carrier_kas: build.carrier_kas,
        output_plan: build.output_plan,
        invariants: build.invariants,
        mass: build.mass,
        submit_route_enabled: build.submit_route_enabled === true,
        submit_token_present: typeof build.submit_token === "string" && build.submit_token.length > 0,
        sign_input_indexes: signingPlan.signInputIndexes,
        native_kas_funding_input_count: signingPlan.nativeFundingInputs.length,
        signing_enabled: true,
        broadcasting_enabled: false,
        minting_enabled: false
      } : {
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
      setMsg(regulatedPreview
        ? "Regulated token transaction prepared. Signing locally…"
        : "Build complete. Review proof, then sign locally.");
      return true;
    } catch (e) {
      lastBuild = null;
      resetSignedState();
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Build failed.");
      showStandardDeployFailure("Build", e);
      return false;
    } finally {
      setBusy(false);
      if (!isRegulatedPreviewMode() && UI.signBtn) UI.signBtn.disabled = !lastBuild;
    }
  }

  async function onSign() {
    try {
      if (!lastBuild) throw new Error("build_required_before_sign");
      setBusy(true);
      setMsg("Signing locally…");
      const keyring = await activeKeyringOrThrow();
      const k = await kaspaReadyOrThrow();
      const signingPlan = deploySigningPlan(lastBuild);
      const tx = k.Transaction.deserializeFromSafeJSON(signingPlan.txSafeJson);
      const inputs = Array.isArray(tx.inputs) ? tx.inputs : [];
      if (inputs.length !== signingPlan.signInputIndexes.length) throw new Error("deploy_input_count_mismatch");
      for (const inputIndex of signingPlan.signInputIndexes) {
        if (!inputs[inputIndex]) throw new Error("deploy_input_missing");
        inputs[inputIndex].signatureScript = k.createInputSignature(tx, inputIndex, keyring.priv0, null);
      }
      tx.inputs = inputs;
      tx.finalize();
      lastSignedSafeJson = tx.serializeToSafeJSON();
      k.Transaction.deserializeFromSafeJSON(lastSignedSafeJson);
      showJson(UI.outputWrap, UI.output, {
        proof_kind: isRegulatedPreviewMode() ? "kcc20_regulated_tn10_deploy_sign_only_v1" : "kcc20_deploy_sign_only_v1",
        ok: true,
        deploy_build_kind: lastBuild.deploy_build_kind,
        unsigned_safe_json_sha256: lastBuild.unsigned_safe_json_sha256,
        signatureScript_present: true,
        native_kas_funding_signature_count: signingPlan.signInputIndexes.length,
        sign_input_indexes: signingPlan.signInputIndexes,
        signed_tx_deserialize_check_ok: true,
        private_key_printed: false,
        signature_script_printed: false,
        signed_transaction_printed: false,
        submit_called: false,
        broadcasting: "none",
        minting: "none"
      });
      setMsg(isRegulatedPreviewMode()
        ? "Signed locally. Submitting to Testnet-10…"
        : "Signed locally. Submit once when ready.");
      return true;
    } catch (e) {
      lastSignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Sign failed.");
      showStandardDeployFailure("Local signing", e);
      return false;
    } finally {
      setBusy(false);
      if (!isRegulatedPreviewMode()) {
        if (UI.signBtn) UI.signBtn.disabled = !lastBuild;
        if (UI.submitBtn) UI.submitBtn.disabled = !lastSignedSafeJson;
      }
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
      if (
        !submit
        || submit.ok !== true
        || submit.submit_kind !== "oma_l1_token_deploy_submit_v1"
        || submit.application_status !== "submitted_oma_l1_token_deploy_v1"
      ) {
        throw new Error("deploy_submit_success_response_invalid");
      }
      showJson(UI.outputWrap, UI.output, {
        proof_kind: isRegulatedPreviewMode() ? "kcc20_regulated_tn10_deploy_submit_v1" : "kcc20_deploy_submit_v1",
        ok: true,
        submit_kind: submit.submit_kind,
        application_status: submit.application_status,
        submitted_txid: submit.submitted_txid,
        asset_covenant_id: submit.asset_covenant_id,
        post_submit_scan_status: submit.post_submit_scan_status,
        tracked_asset: submit.tracked_asset ? submit.tracked_asset : null,
        signed_transaction_json_echoed: false,
        signature_script_echoed: false,
        broadcasting: submit.broadcasting ? submit.broadcasting : "submitted_once",
        minting: submit.minting ? submit.minting : "none"
      });
      if (isRegulatedPreviewMode()) {
        showRegulatedDeployCompletion(submit);
        setMsg("Deployment complete. Continue to the Issue tab.");
      } else {
        showStandardDeployCompletion(submit);
        setMsg("Deployment complete.");
      }
      return true;
    } catch (e) {
      submitting = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Submit failed.");
      showStandardDeployFailure("Submit", e);
      return false;
    } finally {
      setBusy(false);
      if (!isRegulatedPreviewMode() && submitting && UI.submitBtn) UI.submitBtn.disabled = true;
    }
  }

  async function deployRegulatedTokenOneClick() {
    if (!isRegulatedPreviewMode() || regulatedDeployOrchestrating || submitting || deploymentCompleted) return;
    regulatedDeployOrchestrating = true;
    setBusy(true);
    try {
      const built = await onBuild();
      if (!built || !lastBuild) return;

      const signed = await onSign();
      if (!signed || !lastSignedSafeJson) return;

      await onSubmit();
    } finally {
      regulatedDeployOrchestrating = false;
      setBusy(false);
    }
  }

  async function deployStandardTokenTwoClick() {
    if (isRegulatedPreviewMode() || standardDeployOrchestrating || submitting) return;

    const tokenName = String(UI.tokenName && UI.tokenName.value || "").trim() || "this token";
    const tokenSymbol = String(UI.tokenSymbol && UI.tokenSymbol.value || "").trim().toUpperCase() || "unspecified symbol";
    const maxSupplyRaw = String(UI.maxSupplyRaw && UI.maxSupplyRaw.value || "").trim() || "unspecified";
    const initialIssueRaw = String(UI.initialIssueRaw && UI.initialIssueRaw.value || "0").trim() || "0";
    const networkLabel = activeStatus
      ? String(networkMetaOrThrow(activeStatus.network || activeStatus.net || "").sdkNetworkId || activeStatus.network || "")
      : "the active network";
    const confirmed = window.confirm(
      `Deploy ${tokenName} (${tokenSymbol}) on ${networkLabel}?

Max supply (RAW): ${maxSupplyRaw}
Initial issue (RAW): ${initialIssueRaw}

This will build the transaction, sign locally, and submit it once.`
    );
    if (!confirmed) {
      setMsg("Deploy cancelled.");
      return;
    }

    standardDeployOrchestrating = true;
    setBusy(true);
    try {
      const built = await onBuild();
      if (!built || !lastBuild) return;

      const signed = await onSign();
      if (!signed || !lastSignedSafeJson) return;

      await onSubmit();
    } finally {
      standardDeployOrchestrating = false;
      setBusy(false);
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
    if (isRegulatedPreviewMode()) {
      if (UI.buildBtn) UI.buildBtn.addEventListener("click", deployRegulatedTokenOneClick);
      if (UI.signBtn) {
        UI.signBtn.hidden = true;
        UI.signBtn.disabled = true;
        UI.signBtn.setAttribute("aria-hidden", "true");
      }
      if (UI.submitBtn) {
        UI.submitBtn.hidden = true;
        UI.submitBtn.disabled = true;
        UI.submitBtn.setAttribute("aria-hidden", "true");
      }
    } else {
      if (UI.buildBtn) UI.buildBtn.addEventListener("click", deployStandardTokenTwoClick);
      if (UI.signBtn) {
        UI.signBtn.hidden = true;
        UI.signBtn.disabled = true;
        UI.signBtn.setAttribute("aria-hidden", "true");
      }
      if (UI.submitBtn) {
        UI.submitBtn.hidden = true;
        UI.submitBtn.disabled = true;
        UI.submitBtn.setAttribute("aria-hidden", "true");
      }
    }
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
