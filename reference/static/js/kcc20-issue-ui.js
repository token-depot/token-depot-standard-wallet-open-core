// OMA KCC20 Issue/Burn UI
// New KCC20/OMA L1 issue and burn page wiring only. Does not modify KRC-20 issue/burn flow.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const UI = {
    activeWallet: $("kcc20IssueActiveWallet"),
    network: $("kcc20IssueNetwork"),
    networkStatus: $("kcc20IssueNetworkStatus"),
    licenseStatus: $("kcc20IssueLicenseStatus"),
    previewWrap: $("kcc20IssuePreviewWrap"),
    preview: $("kcc20IssuePreview"),
    outputWrap: $("kcc20IssueOutputWrap"),
    output: $("kcc20IssueOutput"),
    msg: $("kcc20IssueMsg"),

    issueAsset: $("kcc20IssueAssetSelect"),
    issueAmountRaw: $("kcc20IssueAmountRaw"),
    issueRecipientAddress: $("kcc20IssueRecipientAddress"),
    issueHolderCarrierKas: $("kcc20IssueHolderCarrierKas"),
    issueFeeReserveKas: $("kcc20IssueFeeReserveKas"),
    issueBuildBtn: $("kcc20IssueBuildBtn"),
    issueSignBtn: $("kcc20IssueSignBtn"),
    issueSubmitBtn: $("kcc20IssueSubmitBtn"),

    burnAsset: $("kcc20BurnAssetSelect"),
    burnAmountRaw: $("kcc20BurnAmountRaw"),
    burnFeeReserveKas: $("kcc20BurnFeeReserveKas"),
    burnBuildBtn: $("kcc20BurnBuildBtn"),
    burnSignBtn: $("kcc20BurnSignBtn"),
    burnSubmitBtn: $("kcc20BurnSubmitBtn"),

    supplyAsset: $("kcc20ControllerSupplyAssetSelect"),
    supplyBuildBtn: $("kcc20ControllerSupplyBuildBtn"),
    supplySignBtn: $("kcc20ControllerSupplySignBtn"),
    supplySubmitBtn: $("kcc20ControllerSupplySubmitBtn"),

    changeOwnerAsset: $("kcc20ChangeOwnerAssetSelect"),
    changeOwnerNewOwnerAddress: $("kcc20ChangeOwnerNewOwnerAddress"),
    changeOwnerHolderCarrierKas: $("kcc20ChangeOwnerHolderCarrierKas"),
    changeOwnerFeeReserveKas: $("kcc20ChangeOwnerFeeReserveKas"),
    changeOwnerBuildBtn: $("kcc20ChangeOwnerBuildBtn"),
    changeOwnerSignBtn: $("kcc20ChangeOwnerSignBtn"),
    changeOwnerSubmitBtn: $("kcc20ChangeOwnerSubmitBtn"),

    issueTokenEmpty: $("kcc20IssueTokenEmpty"),
    issueTokenTable: $("kcc20IssueTokenTable"),
    issueTokenRows: $("kcc20IssueTokenRows")
  };

  const KEYRING_SESSION_KEY = "cw_keyring_session";
  const SENSITIVE_KEY_RE = /private|priv|seed|mnemonic|passphrase|signatureScript|signature_script|signed|txToSignSafeJson|submit_token|submitToken|auth|secret|password|session|cookie|redeem_script/i;

  let activeStatus = null;
  let holdings = null;
  let lastIssueBuild = null;
  let lastIssueSignedSafeJson = "";
  let lastBurnBuild = null;
  let lastBurnSignedSafeJson = "";
  let lastSupplyBuild = null;
  let lastSupplySignedSafeJson = "";
  let lastChangeOwnerBuild = null;
  let lastChangeOwnerSignedSafeJson = "";
  let issueSubmitted = false;
  let burnSubmitted = false;
  let supplySubmitted = false;
  let changeOwnerSubmitted = false;

  function setText(el, value) {
    if (el) el.textContent = String(value || "");
  }

  function setMsg(value) {
    setText(UI.msg, value || "Ready.");
  }

  function setHidden(el, hidden) {
    if (el) el.classList.toggle("hidden", !!hidden);
  }

  function sanitizeForDisplay(value, depth) {
    if (depth > 8) return "[depth_limit]";
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((item) => sanitizeForDisplay(item, depth + 1));
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return value;

    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) out[key] = "[redacted]";
      else out[key] = sanitizeForDisplay(raw, depth + 1);
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

  function formatRawTokenAmountHuman(amountRaw, decimals) {
    const raw = String(amountRaw || "0").trim();
    if (!/^\d+$/.test(raw)) return "0";
    const parsedDecimals = Number(decimals);
    const places = Number.isFinite(parsedDecimals) && parsedDecimals > 0
      ? Math.min(Math.floor(parsedDecimals), 18)
      : 0;
    const normalizedRaw = raw.replace(/^0+(?=\d)/, "") || "0";
    if (places <= 0) return normalizedRaw;
    const padded = normalizedRaw.padStart(places + 1, "0");
    const whole = padded.slice(0, -places).replace(/^0+(?=\d)/, "") || "0";
    const fractional = padded.slice(-places).replace(/0+$/, "");
    return fractional ? `${whole}.${fractional}` : whole;
  }

  function shortCovenant(value) {
    const text = String(value || "").trim();
    return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
  }

  function omaL1TokensFromHoldings(h) {
    const tokens = h && h.oma_l1 && Array.isArray(h.oma_l1.tokens) ? h.oma_l1.tokens : [];
    return tokens.filter((tok) => tok && tok.asset_kind === "oma_l1_covenant_token" && /^[0-9a-f]{64}$/.test(String(tok.asset_covenant_id || "").trim().toLowerCase()));
  }

  function aggregateTokens(h) {
    const byAsset = new Map();
    for (const tok of omaL1TokensFromHoldings(h)) {
      const covenantId = String(tok.asset_covenant_id || "").trim().toLowerCase();
      const amountRaw = String(tok.amount_raw || "0").trim();
      if (!/^\d+$/.test(amountRaw)) continue;
      if (!byAsset.has(covenantId)) {
        byAsset.set(covenantId, {
          asset_covenant_id: covenantId,
          token_symbol: String(tok.token_symbol || "OMA L1").trim() || "OMA L1",
          token_name: String(tok.token_name || "").trim(),
          decimals: typeof tok.decimals === "number" ? tok.decimals : 0,
          amount_raw_total: 0n,
          holder_lot_count: 0,
          issuer_identifier: String(tok.issuer_identifier || "").trim(),
          max_supply_raw: String(tok.max_supply_raw || "").trim(),
          issued_supply_raw: String(tok.issued_supply_raw || "").trim()
        });
      }
      const row = byAsset.get(covenantId);
      row.amount_raw_total += BigInt(amountRaw);
      row.holder_lot_count += 1;
    }
    return Array.from(byAsset.values()).map((row) => ({
      ...row,
      amount_raw: row.amount_raw_total.toString()
    })).sort((a, b) => String(a.token_symbol || "").localeCompare(String(b.token_symbol || "")) || String(a.asset_covenant_id || "").localeCompare(String(b.asset_covenant_id || "")));
  }

  function selectedAsset(selectEl) {
    const value = String(selectEl && selectEl.value || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("asset_covenant_id_required");
    return value;
  }

  function optionLabel(tok) {
    const symbol = String(tok.token_symbol || "OMA L1").trim() || "OMA L1";
    const amount = String(tok.amount_raw || "0");
    const lots = Number(tok.holder_lot_count || 0);
    return `${symbol} · ${amount} raw · ${shortCovenant(tok.asset_covenant_id)}${lots > 1 ? ` · ${lots} lots` : ""}`;
  }

  function fillSelect(selectEl, tokens, filterFn, emptyText) {
    if (!selectEl) return;
    const prev = String(selectEl.value || "").trim().toLowerCase();
    selectEl.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyText;
    selectEl.appendChild(empty);

    const filtered = tokens.filter(filterFn);
    for (const tok of filtered) {
      const opt = document.createElement("option");
      opt.value = String(tok.asset_covenant_id || "").trim().toLowerCase();
      opt.textContent = optionLabel(tok);
      opt.dataset.tokenSymbol = String(tok.token_symbol || "OMA L1");
      opt.dataset.amountRaw = String(tok.amount_raw || "0");
      opt.dataset.holderLotCount = String(tok.holder_lot_count || 0);
      opt.dataset.issuerIdentifier = String(tok.issuer_identifier || "");
      selectEl.appendChild(opt);
    }
    if (prev && Array.from(selectEl.options).some((opt) => opt.value === prev)) selectEl.value = prev;
  }

  function selectAssetIfAvailable(selectEl, assetId) {
    if (!selectEl || !assetId) return false;
    const value = String(assetId || "").trim().toLowerCase();
    if (!Array.from(selectEl.options).some((opt) => opt.value === value)) return false;
    selectEl.value = value;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function renderIssueTokenList(tokens, activeAddress) {
    if (!UI.issueTokenRows || !UI.issueTokenEmpty || !UI.issueTokenTable) return;
    UI.issueTokenRows.innerHTML = "";

    const issuable = tokens.filter((tok) => String(tok.issuer_identifier || "").trim() === activeAddress);
    if (!issuable.length) {
      UI.issueTokenEmpty.textContent = "No issuer-controlled KCC20 / OMA L1 token records found for this wallet.";
      setHidden(UI.issueTokenEmpty, false);
      setHidden(UI.issueTokenTable, true);
      return;
    }

    setHidden(UI.issueTokenEmpty, true);
    setHidden(UI.issueTokenTable, false);

    function selectToken(tok) {
      const assetId = String(tok.asset_covenant_id || "").trim().toLowerCase();
      const symbol = String(tok.token_symbol || "OMA L1").trim() || "OMA L1";
      const amountRaw = String(tok.amount_raw || "0").trim();
      const issueSet = selectAssetIfAvailable(UI.issueAsset, assetId);
      const changeOwnerSet = selectAssetIfAvailable(UI.changeOwnerAsset, assetId);
      const burnSet = /^\d+$/.test(amountRaw) && BigInt(amountRaw) > 0n && selectAssetIfAvailable(UI.burnAsset, assetId);
      setMsg(`Selected ${symbol} for${issueSet ? " Issue" : ""}${burnSet ? " Burn" : ""}${changeOwnerSet ? " Ownership Transfer" : ""}.`);
    }

    for (const tok of issuable) {
      const assetId = String(tok.asset_covenant_id || "").trim().toLowerCase();
      const symbol = String(tok.token_symbol || tok.token_name || "OMA L1").trim() || "OMA L1";
      const decimals = typeof tok.decimals === "number" ? String(tok.decimals) : "0";
      const amountRaw = String(tok.amount_raw || "0").trim();
      const inQueueRaw = String(tok.in_queue_raw || tok.inQueueRaw || "0").trim() || "0";
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      const nameButton = document.createElement("button");
      nameButton.type = "button";
      nameButton.className = "kcc20-token-table-click";
      nameButton.dataset.assetCovenantId = assetId;
      nameButton.textContent = symbol;
      nameButton.addEventListener("click", () => selectToken(tok));
      nameTd.appendChild(nameButton);
      tr.appendChild(nameTd);

      const covTd = document.createElement("td");
      const covButton = document.createElement("button");
      covButton.type = "button";
      covButton.className = "kcc20-token-table-click mono";
      covButton.dataset.assetCovenantId = assetId;
      covButton.textContent = assetId;
      covButton.addEventListener("click", () => selectToken(tok));
      covTd.appendChild(covButton);
      tr.appendChild(covTd);

      const decTd = document.createElement("td");
      decTd.textContent = decimals;
      tr.appendChild(decTd);

      const holdingsTd = document.createElement("td");
      holdingsTd.textContent = formatRawTokenAmountHuman(amountRaw, tok.decimals);
      holdingsTd.title = `${amountRaw} raw`;
      tr.appendChild(holdingsTd);

      const queueTd = document.createElement("td");
      queueTd.textContent = inQueueRaw;
      tr.appendChild(queueTd);

      UI.issueTokenRows.appendChild(tr);
    }
  }

  async function loadActiveWalletAndAssets() {
    const status = await httpJson("GET", "/api/wallet/status");
    if (!status || status.ok !== true) throw new Error("active_wallet_required");
    activeStatus = status;
    const meta = networkMetaOrThrow(status.network || status.net || "");
    if (UI.activeWallet) UI.activeWallet.value = String(status.address0 || "");
    if (UI.network) UI.network.value = String(meta.sdkNetworkId || meta.appKey || status.network || "");
    if (UI.networkStatus) UI.networkStatus.textContent = meta.isMainnet ? "mainnet active wallet detected. Direct API and page access require OMA PRO / TDPRO." : `${meta.sdkNetworkId || meta.displayLabel || meta.appKey} active wallet detected. Testnet issue/burn is available to authenticated OMA users.`;
    if (UI.licenseStatus) UI.licenseStatus.textContent = meta.isMainnet ? "Mainnet actions are blocked unless the active account has the PRO entitlement." : "Testnet actions do not require the PRO entitlement.";

    holdings = await httpJson("GET", "/api/wallet/holdings?strict=1");
    const tokens = aggregateTokens(holdings);
    const activeAddress = String(status.address0 || "").trim();
    fillSelect(UI.issueAsset, tokens, (tok) => String(tok.issuer_identifier || "") === activeAddress, "Select issuer-controlled token");
    fillSelect(UI.burnAsset, tokens, (tok) => BigInt(String(tok.amount_raw || "0")) > 0n, "Select holder token to burn");
    fillSelect(UI.supplyAsset, tokens, (tok) => String(tok.issuer_identifier || "") === activeAddress, "Select token with burn receipt");
    fillSelect(UI.changeOwnerAsset, tokens, (tok) => String(tok.issuer_identifier || "") === activeAddress, "Select issuer-controlled token");
    renderIssueTokenList(tokens, activeAddress);
  }

  function actionState(kind) {
    if (kind === "issue") return { lastBuild: lastIssueBuild, lastSigned: lastIssueSignedSafeJson, submitted: issueSubmitted, buildBtn: UI.issueBuildBtn, signBtn: UI.issueSignBtn, submitBtn: UI.issueSubmitBtn };
    if (kind === "burn") return { lastBuild: lastBurnBuild, lastSigned: lastBurnSignedSafeJson, submitted: burnSubmitted, buildBtn: UI.burnBuildBtn, signBtn: UI.burnSignBtn, submitBtn: UI.burnSubmitBtn };
    if (kind === "supply") return { lastBuild: lastSupplyBuild, lastSigned: lastSupplySignedSafeJson, submitted: supplySubmitted, buildBtn: UI.supplyBuildBtn, signBtn: UI.supplySignBtn, submitBtn: UI.supplySubmitBtn };
    if (kind === "changeOwner") return { lastBuild: lastChangeOwnerBuild, lastSigned: lastChangeOwnerSignedSafeJson, submitted: changeOwnerSubmitted, buildBtn: UI.changeOwnerBuildBtn, signBtn: UI.changeOwnerSignBtn, submitBtn: UI.changeOwnerSubmitBtn };
    return { lastBuild: null, lastSigned: "", submitted: false, buildBtn: null, signBtn: null, submitBtn: null };
  }

  function setButtons(kind, busy) {
    const state = actionState(kind);
    if (state.buildBtn) state.buildBtn.disabled = !!busy;
    if (state.signBtn) state.signBtn.disabled = !!busy || !state.lastBuild;
    if (state.submitBtn) state.submitBtn.disabled = !!busy || !state.lastBuild || !state.lastSigned || state.submitted;
  }

  function resetSigned(kind) {
    if (kind === "issue") { lastIssueSignedSafeJson = ""; issueSubmitted = false; }
    if (kind === "burn") { lastBurnSignedSafeJson = ""; burnSubmitted = false; }
    if (kind === "supply") { lastSupplySignedSafeJson = ""; supplySubmitted = false; }
    if (kind === "changeOwner") { lastChangeOwnerSignedSafeJson = ""; changeOwnerSubmitted = false; }
  }

  function fillSignatureScript(tx, inputIndex, signatureScript, reason) {
    const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) throw new Error(reason || "kcc20_input_missing");
    inputs[inputIndex].signatureScript = signatureScript;
    tx.inputs = inputs;
  }

  async function signControllerAndFundingBuild(build, keyring, proofKind) {
    const k = await kaspaReadyOrThrow();
    const txSafeJson = String(build && build.txToSignSafeJson || "").trim();
    const signCtx = build && build.signing_context_public && typeof build.signing_context_public === "object" ? build.signing_context_public : null;
    if (!txSafeJson || !signCtx) throw new Error("kcc20_unsigned_build_missing");
    const controllerInputIndex = Number(signCtx.controller_input_index);
    const fundingInputIndex = Object.prototype.hasOwnProperty.call(signCtx, "native_kas_funding_input_index") ? Number(signCtx.native_kas_funding_input_index) : null;
    const signIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map((v) => Number(v)) : [];
    if (!Number.isInteger(controllerInputIndex) || !signIndexes.includes(controllerInputIndex)) throw new Error("kcc20_controller_input_not_signable");
    if (fundingInputIndex !== null && (!Number.isInteger(fundingInputIndex) || !signIndexes.includes(fundingInputIndex))) throw new Error("kcc20_funding_input_not_signable");
    const redeemScriptHex = String(signCtx.source_controller_redeem_script_hex || "").trim();
    if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) throw new Error("kcc20_controller_redeem_script_missing");

    const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
    const script = k.ScriptBuilder.fromScript(redeemScriptHex);
    const dummySig = new Uint8Array(65);
    fillSignatureScript(tx, controllerInputIndex, script.encodePayToScriptHashSignatureScript(dummySig), "kcc20_controller_input_missing");
    const controllerSignature = k.createInputSignature(tx, controllerInputIndex, keyring.priv0, null);
    fillSignatureScript(tx, controllerInputIndex, script.encodePayToScriptHashSignatureScript(controllerSignature), "kcc20_controller_input_missing");

    if (fundingInputIndex !== null) {
      const fundingSignature = k.createInputSignature(tx, fundingInputIndex, keyring.priv0, null);
      fillSignatureScript(tx, fundingInputIndex, fundingSignature, "kcc20_native_funding_input_missing");
    }

    tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    k.Transaction.deserializeFromSafeJSON(signedSafeJson);
    return { signedSafeJson, proofKind, controllerInputIndex, fundingInputIndex };
  }

  async function signHolderBuild(build, keyring, proofKind) {
    const k = await kaspaReadyOrThrow();
    const txSafeJson = String(build && build.txToSignSafeJson || "").trim();
    const signCtx = build && build.signing_context_public && typeof build.signing_context_public === "object" ? build.signing_context_public : null;
    if (!txSafeJson || !signCtx) throw new Error("kcc20_holder_build_missing");
    const signInputIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map((v) => Number(v)) : [];
    const holderInputs = Array.isArray(signCtx.holder_inputs) ? signCtx.holder_inputs.map((input) => ({
      inputIndex: Number(input && input.input_index),
      outpoint: String(input && input.source_holder_outpoint || "").trim(),
      redeemScriptHex: String(input && input.source_holder_redeem_script_hex || "").trim()
    })).filter((input) => Number.isInteger(input.inputIndex) && input.inputIndex >= 0) : [];
    if (!holderInputs.length) throw new Error("kcc20_holder_inputs_missing");
    for (const input of holderInputs) {
      if (!signInputIndexes.includes(input.inputIndex)) throw new Error("kcc20_holder_input_not_signable");
      if (!/^[0-9a-f]+$/i.test(input.redeemScriptHex) || input.redeemScriptHex.length % 2 !== 0) throw new Error("kcc20_holder_redeem_script_missing");
    }
    const fundingInputIndex = Object.prototype.hasOwnProperty.call(signCtx, "native_kas_funding_input_index") ? Number(signCtx.native_kas_funding_input_index) : null;
    if (fundingInputIndex !== null && (!Number.isInteger(fundingInputIndex) || !signInputIndexes.includes(fundingInputIndex))) throw new Error("kcc20_holder_funding_input_not_signable");

    const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
    const dummySig = new Uint8Array(65);
    const holderScripts = holderInputs.map((input) => ({ input, script: k.ScriptBuilder.fromScript(input.redeemScriptHex) }));
    for (const item of holderScripts) fillSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(dummySig), "kcc20_holder_input_missing");
    for (const item of holderScripts) {
      const signature = k.createInputSignature(tx, item.input.inputIndex, keyring.priv0, null);
      fillSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(signature), "kcc20_holder_input_missing");
    }
    if (fundingInputIndex !== null) {
      const fundingSignature = k.createInputSignature(tx, fundingInputIndex, keyring.priv0, null);
      fillSignatureScript(tx, fundingInputIndex, fundingSignature, "kcc20_holder_native_funding_input_missing");
    }
    tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    k.Transaction.deserializeFromSafeJSON(signedSafeJson);
    return { signedSafeJson, proofKind, holderInputCount: holderInputs.length, fundingInputIndex };
  }

  async function onIssueBuild() {
    try {
      setButtons("issue", true);
      resetSigned("issue");
      setMsg("Building issue packet…");
      const keyring = await activeKeyringOrThrow();
      const recipient = String(UI.issueRecipientAddress && UI.issueRecipientAddress.value || "").trim() || keyring.address0;
      const build = await httpJson("POST", "/api/covenants/issuer-token/issue/build", {
        asset_covenant_id: selectedAsset(UI.issueAsset),
        issue_amount_raw: unsignedIntegerString(UI.issueAmountRaw && UI.issueAmountRaw.value, "issue_amount_raw", false),
        recipient_address: recipient,
        owner_public_key: keyring.owner_public_key,
        holder_carrier_sompi: kasToSompiString(UI.issueHolderCarrierKas && UI.issueHolderCarrierKas.value || "1", "issue_holder_carrier", false),
        fee_reserve_sompi: kasToSompiString(UI.issueFeeReserveKas && UI.issueFeeReserveKas.value || "0.01", "issue_fee_reserve", false)
      });
      lastIssueBuild = build;
      showJson(UI.previewWrap, UI.preview, { proof_kind: "kcc20_issue_build_preview_v1", ...build });
      setMsg("Issue build ready.");
    } catch (e) {
      lastIssueBuild = null;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Issue build failed.");
    } finally {
      setButtons("issue", false);
    }
  }

  async function onIssueSign() {
    try {
      if (!lastIssueBuild) throw new Error("issue_build_required_before_sign");
      setButtons("issue", true);
      const keyring = await activeKeyringOrThrow();
      const signed = await signControllerAndFundingBuild(lastIssueBuild, keyring, "kcc20_issue_sign_only_v1");
      lastIssueSignedSafeJson = signed.signedSafeJson;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_issue_sign_only_v1", ok: true, issue_build_kind: lastIssueBuild.issue_build_kind, unsigned_safe_json_sha256: lastIssueBuild.unsigned_safe_json_sha256, controller_signatureScript_present: true, native_funding_signature_present: signed.fundingInputIndex !== null, signed_tx_deserialize_check_ok: true, private_key_printed: false, source_controller_redeem_script_printed: false, signature_script_printed: false, signed_transaction_printed: false, submit_called: false, broadcasting: "none", minting: "none" });
      setMsg("Issue signed locally.");
    } catch (e) {
      lastIssueSignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Issue sign failed.");
    } finally {
      setButtons("issue", false);
    }
  }

  async function onIssueSubmit() {
    try {
      if (!lastIssueBuild || !lastIssueSignedSafeJson) throw new Error("signed_issue_required_before_submit");
      setButtons("issue", true);
      const submit = await httpJson("POST", "/api/covenants/issuer-token/issue/submit", { submit_intent: "submit_oma_l1_issue_holder_v1", submit_token: lastIssueBuild.submit_token, signedSafeJson: lastIssueSignedSafeJson });
      issueSubmitted = submit && submit.ok === true;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_issue_submit_v1", ok: submit && submit.ok === true, submit_kind: submit && submit.submit_kind, application_status: submit && submit.application_status, submitted_txid: submit && submit.submitted_txid, asset_covenant_id: submit && submit.asset_covenant_id, tracked_asset_status: submit && submit.tracked_asset_status, signed_transaction_json_echoed: false, signature_script_echoed: false, broadcasting: submit && submit.broadcasting ? submit.broadcasting : "submitted_once", minting: submit && submit.minting ? submit.minting : "none" });
      await loadActiveWalletAndAssets();
      setMsg("Issue submitted once.");
    } catch (e) {
      issueSubmitted = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Issue submit failed.");
    } finally {
      setButtons("issue", false);
    }
  }

  async function onBurnBuild() {
    try {
      setButtons("burn", true);
      resetSigned("burn");
      setMsg("Building burn packet…");
      const keyring = await activeKeyringOrThrow();
      const build = await httpJson("POST", "/api/covenants/issuer-token/burn/build", {
        asset_covenant_id: selectedAsset(UI.burnAsset),
        burn_amount_raw: unsignedIntegerString(UI.burnAmountRaw && UI.burnAmountRaw.value, "burn_amount_raw", false),
        owner_public_key: keyring.owner_public_key,
        fee_reserve_sompi: kasToSompiString(UI.burnFeeReserveKas && UI.burnFeeReserveKas.value || "0.01", "burn_fee_reserve", false)
      });
      lastBurnBuild = build;
      showJson(UI.previewWrap, UI.preview, { proof_kind: "kcc20_burn_build_preview_v1", ...build });
      setMsg("Burn build ready.");
    } catch (e) {
      lastBurnBuild = null;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Burn build failed.");
    } finally {
      setButtons("burn", false);
    }
  }

  async function onBurnSign() {
    try {
      if (!lastBurnBuild) throw new Error("burn_build_required_before_sign");
      setButtons("burn", true);
      const keyring = await activeKeyringOrThrow();
      const signed = await signHolderBuild(lastBurnBuild, keyring, "kcc20_burn_sign_only_v1");
      lastBurnSignedSafeJson = signed.signedSafeJson;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_burn_sign_only_v1", ok: true, burn_build_kind: lastBurnBuild.burn_build_kind, unsigned_safe_json_sha256: lastBurnBuild.unsigned_safe_json_sha256, holder_inputs_count: signed.holderInputCount, native_funding_signature_present: signed.fundingInputIndex !== null, signed_tx_deserialize_check_ok: true, private_key_printed: false, source_holder_redeem_script_printed: false, signature_script_printed: false, signed_transaction_printed: false, submit_called: false, broadcasting: "none", minting: "none" });
      setMsg("Burn signed locally.");
    } catch (e) {
      lastBurnSignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Burn sign failed.");
    } finally {
      setButtons("burn", false);
    }
  }

  async function autoSubmitControllerSupplyUpdate(assetCovenantId) {
    const assetId = String(assetCovenantId || "").trim().toLowerCase();
    const proof = {
      proof_kind: "kcc20_burn_auto_controller_supply_update_v1",
      asset_covenant_id: assetId,
      mode: "automatic_after_holder_burn_submit",
      build_ok: false,
      sign_ok: false,
      submit_ok: false,
      controller_supply_update_status: null,
      signed_transaction_json_echoed: false,
      signature_script_echoed: false,
      minting: "none"
    };
    try {
      if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error("asset_covenant_id_required_for_auto_supply_update");
      const keyring = await activeKeyringOrThrow();
      const build = await httpJson("POST", "/api/covenants/issuer-token/burn/controller-supply/build", {
        asset_covenant_id: assetId,
        owner_public_key: keyring.owner_public_key
      });
      proof.build_ok = build && build.ok === true;
      proof.supply_update_build_kind = build && build.supply_update_build_kind;
      proof.issued_supply_before_raw = build && build.issued_supply_before_raw;
      proof.issued_supply_after_raw = build && build.issued_supply_after_raw;
      const signed = await signControllerAndFundingBuild(build, keyring, "kcc20_controller_supply_sign_only_v1");
      proof.sign_ok = true;
      const submit = await httpJson("POST", "/api/covenants/issuer-token/burn/controller-supply/submit", {
        submit_intent: "submit_oma_l1_burn_controller_supply_v1",
        submit_token: build.submit_token,
        signedSafeJson: signed.signedSafeJson
      });
      supplySubmitted = submit && submit.ok === true;
      proof.submit_ok = submit && submit.ok === true;
      proof.submit_kind = submit && submit.submit_kind;
      proof.application_status = submit && submit.application_status;
      proof.submitted_txid = submit && submit.submitted_txid;
      proof.controller_supply_update_status = submit && submit.burn_receipts ? submit.burn_receipts.controller_supply_update_status : null;
      proof.broadcasting = submit && submit.broadcasting ? submit.broadcasting : "submitted_once";
      return proof;
    } catch (e) {
      proof.ok = false;
      proof.status = "pending_issuer_controller_update";
      proof.reason = String(e && e.message ? e.message : e);
      proof.data = e && e.payload ? e.payload : null;
      proof.broadcasting = "none";
      return proof;
    }
  }

  async function onBurnSubmit() {
    try {
      if (!lastBurnBuild || !lastBurnSignedSafeJson) throw new Error("signed_burn_required_before_submit");
      setButtons("burn", true);
      const submit = await httpJson("POST", "/api/covenants/issuer-token/burn/submit", { submit_intent: "submit_oma_l1_holder_burn_v1", submit_token: lastBurnBuild.submit_token, signedSafeJson: lastBurnSignedSafeJson });
      burnSubmitted = submit && submit.ok === true;
      let autoSupplyUpdate = null;
      if (burnSubmitted) {
        setMsg("Burn submitted once. Updating controller supply automatically…");
        autoSupplyUpdate = await autoSubmitControllerSupplyUpdate(submit && submit.asset_covenant_id);
      }
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_burn_submit_v1", ok: submit && submit.ok === true, submit_kind: submit && submit.submit_kind, application_status: submit && submit.application_status, submitted_txid: submit && submit.submitted_txid, asset_covenant_id: submit && submit.asset_covenant_id, burn_receipt: submit && submit.burn_receipt ? submit.burn_receipt : null, controller_supply_update: autoSupplyUpdate, signed_transaction_json_echoed: false, signature_script_echoed: false, broadcasting: submit && submit.broadcasting ? submit.broadcasting : "submitted_once", minting: submit && submit.minting ? submit.minting : "none" });
      await loadActiveWalletAndAssets();
      setMsg(autoSupplyUpdate && autoSupplyUpdate.submit_ok ? "Burn submitted and controller supply updated automatically." : "Burn submitted. Controller supply update is pending for the issuer/controller wallet.");
    } catch (e) {
      burnSubmitted = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Burn submit failed.");
    } finally {
      setButtons("burn", false);
    }
  }

  async function onSupplyBuild() {
    try {
      setButtons("supply", true);
      resetSigned("supply");
      setMsg("Building controller supply update…");
      const keyring = await activeKeyringOrThrow();
      const build = await httpJson("POST", "/api/covenants/issuer-token/burn/controller-supply/build", { asset_covenant_id: selectedAsset(UI.supplyAsset), owner_public_key: keyring.owner_public_key });
      lastSupplyBuild = build;
      showJson(UI.previewWrap, UI.preview, { proof_kind: "kcc20_controller_supply_build_preview_v1", ...build });
      setMsg("Supply update build ready.");
    } catch (e) {
      lastSupplyBuild = null;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Supply update build failed.");
    } finally {
      setButtons("supply", false);
    }
  }

  async function onSupplySign() {
    try {
      if (!lastSupplyBuild) throw new Error("supply_build_required_before_sign");
      setButtons("supply", true);
      const keyring = await activeKeyringOrThrow();
      const signed = await signControllerAndFundingBuild(lastSupplyBuild, keyring, "kcc20_controller_supply_sign_only_v1");
      lastSupplySignedSafeJson = signed.signedSafeJson;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_controller_supply_sign_only_v1", ok: true, supply_update_build_kind: lastSupplyBuild.supply_update_build_kind, unsigned_safe_json_sha256: lastSupplyBuild.unsigned_safe_json_sha256, controller_signatureScript_present: true, native_funding_signature_present: signed.fundingInputIndex !== null, signed_tx_deserialize_check_ok: true, private_key_printed: false, source_controller_redeem_script_printed: false, signature_script_printed: false, signed_transaction_printed: false, submit_called: false, broadcasting: "none", minting: "none" });
      setMsg("Supply update signed locally.");
    } catch (e) {
      lastSupplySignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Supply update sign failed.");
    } finally {
      setButtons("supply", false);
    }
  }

  async function onSupplySubmit() {
    try {
      if (!lastSupplyBuild || !lastSupplySignedSafeJson) throw new Error("signed_supply_update_required_before_submit");
      setButtons("supply", true);
      const submit = await httpJson("POST", "/api/covenants/issuer-token/burn/controller-supply/submit", { submit_intent: "submit_oma_l1_burn_controller_supply_v1", submit_token: lastSupplyBuild.submit_token, signedSafeJson: lastSupplySignedSafeJson });
      supplySubmitted = submit && submit.ok === true;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_controller_supply_submit_v1", ok: submit && submit.ok === true, submit_kind: submit && submit.submit_kind, application_status: submit && submit.application_status, submitted_txid: submit && submit.submitted_txid, asset_covenant_id: submit && submit.asset_covenant_id, controller_supply_update_status: submit && submit.burn_receipts ? submit.burn_receipts.controller_supply_update_status : null, signed_transaction_json_echoed: false, signature_script_echoed: false, broadcasting: submit && submit.broadcasting ? submit.broadcasting : "submitted_once", minting: submit && submit.minting ? submit.minting : "none" });
      await loadActiveWalletAndAssets();
      setMsg("Supply update submitted once.");
    } catch (e) {
      supplySubmitted = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Supply update submit failed.");
    } finally {
      setButtons("supply", false);
    }
  }

  async function onChangeOwnerBuild() {
    try {
      setButtons("changeOwner", true);
      resetSigned("changeOwner");
      setMsg("Building Change Ownership packet…");
      const keyring = await activeKeyringOrThrow();
      const newOwnerAddress = String(UI.changeOwnerNewOwnerAddress && UI.changeOwnerNewOwnerAddress.value || "").trim();
      if (!newOwnerAddress) throw new Error("new_owner_address_required");
      const build = await httpJson("POST", "/api/covenants/issuer-token/change-owner/build", {
        asset_covenant_id: selectedAsset(UI.changeOwnerAsset),
        new_owner_address: newOwnerAddress,
        owner_public_key: keyring.owner_public_key,
        holder_carrier_sompi: kasToSompiString(UI.changeOwnerHolderCarrierKas && UI.changeOwnerHolderCarrierKas.value || "1", "change_owner_holder_carrier", false),
        fee_reserve_sompi: kasToSompiString(UI.changeOwnerFeeReserveKas && UI.changeOwnerFeeReserveKas.value || "0.01", "change_owner_fee_reserve", false)
      });
      lastChangeOwnerBuild = build;
      showJson(UI.previewWrap, UI.preview, { proof_kind: "kcc20_change_ownership_build_preview_v1", ...build });
      setMsg("Change Ownership build ready.");
    } catch (e) {
      lastChangeOwnerBuild = null;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Change Ownership build failed.");
    } finally {
      setButtons("changeOwner", false);
    }
  }

  async function onChangeOwnerSign() {
    try {
      if (!lastChangeOwnerBuild) throw new Error("change_ownership_build_required_before_sign");
      setButtons("changeOwner", true);
      const keyring = await activeKeyringOrThrow();
      const signed = await signControllerAndFundingBuild(lastChangeOwnerBuild, keyring, "kcc20_change_ownership_sign_only_v1");
      lastChangeOwnerSignedSafeJson = signed.signedSafeJson;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_change_ownership_sign_only_v1", ok: true, change_owner_build_kind: lastChangeOwnerBuild.change_owner_build_kind, unsigned_safe_json_sha256: lastChangeOwnerBuild.unsigned_safe_json_sha256, controller_signatureScript_present: true, native_funding_signature_present: signed.fundingInputIndex !== null, signed_tx_deserialize_check_ok: true, private_key_printed: false, source_controller_redeem_script_printed: false, signature_script_printed: false, signed_transaction_printed: false, submit_called: false, broadcasting: "none", minting: "none" });
      setMsg("Change Ownership signed locally.");
    } catch (e) {
      lastChangeOwnerSignedSafeJson = "";
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Change Ownership sign failed.");
    } finally {
      setButtons("changeOwner", false);
    }
  }

  async function onChangeOwnerSubmit() {
    try {
      if (!lastChangeOwnerBuild || !lastChangeOwnerSignedSafeJson) throw new Error("signed_change_ownership_required_before_submit");
      setButtons("changeOwner", true);
      const submit = await httpJson("POST", "/api/covenants/issuer-token/change-owner/submit", { submit_intent: "submit_oma_l1_change_ownership_v1", submit_token: lastChangeOwnerBuild.submit_token, signedSafeJson: lastChangeOwnerSignedSafeJson });
      changeOwnerSubmitted = submit && submit.ok === true;
      showJson(UI.outputWrap, UI.output, { proof_kind: "kcc20_change_ownership_submit_v1", ok: submit && submit.ok === true, submit_kind: submit && submit.submit_kind, application_status: submit && submit.application_status, submitted_txid: submit && submit.submitted_txid, asset_covenant_id: submit && submit.asset_covenant_id, old_owner_address: submit && submit.old_owner_address, new_owner_address: submit && submit.new_owner_address, tracking_status: submit && submit.tracking_update ? submit.tracking_update.tracking_status : null, signed_transaction_json_echoed: false, signature_script_echoed: false, redeem_script_echoed: false, broadcasting: submit && submit.broadcasting_enabled ? "submitted_once" : "submitted_once", minting: "none" });
      await loadActiveWalletAndAssets();
      setMsg("Change Ownership submitted once.");
    } catch (e) {
      changeOwnerSubmitted = false;
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e), data: e && e.payload ? e.payload : null });
      setMsg("Change Ownership submit failed.");
    } finally {
      setButtons("changeOwner", false);
    }
  }

  function bind() {
    if (UI.issueBuildBtn) UI.issueBuildBtn.addEventListener("click", onIssueBuild);
    if (UI.issueSignBtn) UI.issueSignBtn.addEventListener("click", onIssueSign);
    if (UI.issueSubmitBtn) UI.issueSubmitBtn.addEventListener("click", onIssueSubmit);
    if (UI.burnBuildBtn) UI.burnBuildBtn.addEventListener("click", onBurnBuild);
    if (UI.burnSignBtn) UI.burnSignBtn.addEventListener("click", onBurnSign);
    if (UI.burnSubmitBtn) UI.burnSubmitBtn.addEventListener("click", onBurnSubmit);
    if (UI.supplyBuildBtn) UI.supplyBuildBtn.addEventListener("click", onSupplyBuild);
    if (UI.supplySignBtn) UI.supplySignBtn.addEventListener("click", onSupplySign);
    if (UI.supplySubmitBtn) UI.supplySubmitBtn.addEventListener("click", onSupplySubmit);
    if (UI.changeOwnerBuildBtn) UI.changeOwnerBuildBtn.addEventListener("click", onChangeOwnerBuild);
    if (UI.changeOwnerSignBtn) UI.changeOwnerSignBtn.addEventListener("click", onChangeOwnerSign);
    if (UI.changeOwnerSubmitBtn) UI.changeOwnerSubmitBtn.addEventListener("click", onChangeOwnerSubmit);
  }

  async function init() {
    bind();
    try {
      await kaspaReadyOrThrow();
      await loadActiveWalletAndAssets();
      setMsg("Ready.");
    } catch (e) {
      showJson(UI.outputWrap, UI.output, { ok: false, reason: String(e && e.message ? e.message : e) });
      setMsg("Open and unlock the active wallet first.");
    } finally {
      setButtons("issue", false);
      setButtons("burn", false);
      setButtons("supply", false);
      setButtons("changeOwner", false);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
