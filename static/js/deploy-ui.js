// Compliance Wallet Deploy UI (Deploy v1)
// Replaces Kastle/Token_Depot demo wiring.
// Uses CW active wallet (server-side) + /api/v1/krc20/deploy.

import "/static/js/kaspa-bridge.mjs";

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const UI = {
    kastleCard: $("kastle"),
    kastleStatus: $("kastleStatus"),
    btnKastleConnect: $("btnKastleConnect"),
    btnKastleDisconnect: $("btnKastleDisconnect"),

    network: $("kaspaNetwork"),

    msg: $("msg"),
    previewWrap: $("previewWrap"),
    cmdPreview: $("cmdPreview"),
    outputWrap: $("outputWrap"),
    out: $("out"),

    name: $("name"),
    nameEcho: $("nameEcho"),
    deployKind: $("deployKind"),

    deployOnlyFields: $("deployOnlyFields"),

    importFields: $("importFields"),
    importCa: $("importCa"),
    importOwnerAddress: $("importOwnerAddress"),

    importMetadataFields: $("importMetadataFields"),
    importMetaName: $("importMetaName"),
    importMetaNetwork: $("importMetaNetwork"),
    importMetaDec: $("importMetaDec"),
    importMetaMax: $("importMetaMax"),

    wrappedDeployFields: $("wrappedDeployFields"),
    wrappedAssetRef: $("wrappedAssetRef"),
    wrappedVaultChain: $("wrappedVaultChain"),
    wrappedVaultAddress: $("wrappedVaultAddress"),
    wrappedVaultAddressSepolia: $("wrappedVaultAddressSepolia"),
    wrappedAdminTokenFields: $("wrappedAdminTokenFields"),
    wrappedAdminToken: $("wrappedAdminToken"),

    dec: $("dec"),
    max: $("max"),
    deployEnergyLock: $("deployEnergyLock"),
    pre: $("pre"),
    to: $("to"),
    importEnergyLock: $("importEnergyLock"),
    priorityFee: $("priorityFee"),
    timeout: $("timeout"),
    logLevel: $("logLevel"),

    agree: $("agree"),

    btnPreview: $("btnPreview"),
    btnDeploy: $("btnDeploy"),
  };

  const cleanName = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const validName = (s) => /^[A-Z]{4,6}$/.test(s || "");
  const validDigits = (s) => /^\d{1,64}$/.test(s || "");
  const validCa = (s) => /^[0-9a-f]{64}$/i.test(s || "");
  const validKaspaAddr = (s) => /^kaspa[a-z0-9:]{1,100}$/i.test(s || "");

  function getNetworkSharedOrThrow() {
    const shared = window.CwNetworkShared;
    if (
      !shared ||
      typeof shared.getNetworkMeta !== "function" ||
      typeof shared.normalizeAppNetworkKey !== "function" ||
      typeof shared.isKaspaAddressForNetwork !== "function"
    ) {
      throw new Error("network_shared_missing");
    }
    return shared;
  }

  function getNetworkMetaOrThrow(raw) {
    const meta = getNetworkSharedOrThrow().getNetworkMeta(raw);
    if (!meta || !meta.appKey) throw new Error("invalid_network");
    return meta;
  }

  function getAppNetworkKeyOrThrow(raw) {
    return String(getNetworkMetaOrThrow(raw).appKey || "").trim();
  }

  const validKaspaAddrForNetwork = (networkId, s) =>
    getNetworkSharedOrThrow().isKaspaAddressForNetwork(s, networkId);

  function setMsg(html, cls = "") {
    if (!UI.msg) return;
    UI.msg.className = cls || "muted";
    UI.msg.innerHTML = html;
  }

  function setBusy(busy) {
    if (UI.btnPreview) UI.btnPreview.disabled = !!busy;
    if (UI.btnDeploy) UI.btnDeploy.disabled = !!busy;
  }

  function setFieldHidden(el, hidden) {
    const label = el && typeof el.closest === "function" ? el.closest("label") : null;
    if (label) label.classList.toggle("hidden", !!hidden);
  }

  function setReadOnlyInput(el, locked) {
    if (!el) return;
    el.readOnly = !!locked;
    if (locked) {
      el.setAttribute("aria-readonly", "true");
    } else {
      el.removeAttribute("aria-readonly");
    }
  }

  function clearImportMetadata(activeNetworkId) {
    if (UI.importMetadataFields) UI.importMetadataFields.classList.add("hidden");
    if (UI.importMetaName) UI.importMetaName.value = "";
    if (UI.importMetaNetwork) UI.importMetaNetwork.value = "";
    if (UI.importMetaDec) UI.importMetaDec.value = "";
    if (UI.importMetaMax) UI.importMetaMax.value = "";
    const activeNetworkKey = getAppNetworkKeyOrThrow(activeNetworkId);
    if (UI.network && activeNetworkKey) UI.network.value = activeNetworkKey;
  }

  function syncEnergyLockUI(pageMode) {
    const isImport = String(pageMode || "deploy").trim().toLowerCase() === "import";
    const deployEnergyLock = !isImport && !!(UI.deployEnergyLock && UI.deployEnergyLock.checked);

    if (UI.pre) {
      UI.pre.disabled = isImport || deployEnergyLock;
      if (deployEnergyLock) {
        UI.pre.value = "0";
      }
    }

    if (UI.to) {
      UI.to.disabled = isImport;
    }
  }

  function applyImportMetadata(importRes, activeNetworkId) {
    const meta = importRes && importRes.metadata ? importRes.metadata : null;
    const identity = meta && meta.identity ? meta.identity : null;
    const issuance = meta && meta.issuance ? meta.issuance : null;

    const resolvedNetworkMeta = getNetworkMetaOrThrow(
      (importRes && importRes.networkId) ||
      (meta && meta.networkId) ||
      activeNetworkId ||
      ""
    );

    if (UI.network && resolvedNetworkMeta.appKey) UI.network.value = resolvedNetworkMeta.appKey;
    if (UI.importMetaName) UI.importMetaName.value = String((identity && identity.name) || "").trim();
    if (UI.importMetaNetwork) {
      UI.importMetaNetwork.value = String(resolvedNetworkMeta.sdkNetworkId || resolvedNetworkMeta.appKey || "").trim();
    }
    if (UI.importMetaDec) {
      const decVal = identity && identity.decimals !== null && identity.decimals !== undefined
        ? String(identity.decimals)
        : "";
      UI.importMetaDec.value = decVal;
    }
    if (UI.importMetaMax) UI.importMetaMax.value = String((issuance && issuance.maxRaw) || "").trim();
    if (UI.importMetadataFields) UI.importMetadataFields.classList.remove("hidden");
  }

  function hideKastleCard() {
    if (UI.kastleCard) UI.kastleCard.classList.add("hidden");
    if (UI.btnKastleConnect) UI.btnKastleConnect.disabled = true;
    if (UI.btnKastleDisconnect) UI.btnKastleDisconnect.disabled = true;
  }

  function kaspaOrThrow() {
    const k = window.kaspa;
    if (!k) throw new Error("Kaspa WASM not loaded (kaspa-bridge.mjs missing?)");
    return k;
  }

  async function kaspaReadyOrThrow() {
    const p = window.kaspaReady;
    if (p && typeof p.then === "function") {
      await p;
    }
    return kaspaOrThrow();
  }

  function getWalletAddressNetworkLabelOrThrow(networkId) {
    const label = String(getNetworkMetaOrThrow(networkId).walletNetworkLabel || "").trim();
    if (!label) throw new Error("invalid_network");
    return label;
  }

  const KEYRING_SESSION_KEY = "cw_keyring_session";

  function readKeyringSessionOrNull() {
    try {
      const raw = sessionStorage.getItem(KEYRING_SESSION_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (Number(obj.v || 0) !== 1) return null;
      return obj;
    } catch (_) {
      return null;
    }
  }

  function clearKeyringSession() {
    try { sessionStorage.removeItem(KEYRING_SESSION_KEY); } catch (_) {}
  }

  async function requireUnlockedKeyringOrThrow(activeNetworkId) {
    const sess = readKeyringSessionOrNull();
    if (!sess) throw new Error("keyfile_locked");

    const me = await httpJson("GET", "/api/v1/session/me");
    const userId = me && me.ok === true && me.user_id ? String(me.user_id).trim() : "";
    if (!userId) {
      clearKeyringSession();
      throw new Error("auth_required");
    }
    if (String(sess.user_id || "").trim() !== userId) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const st = await httpJson("GET", "/api/wallet/status");
    if (!st || !st.ok) {
      clearKeyringSession();
      throw new Error("no_active_wallet");
    }

    const walletType = String(st.wallet_type || "").trim();
    const walletId = String(st.wallet_id || "").trim();
    if (!walletId) {
      clearKeyringSession();
      throw new Error("no_active_wallet");
    }
    if (String(sess.wallet_id || "").trim() !== walletId) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }
    if (String(sess.wallet_type || "").trim() !== walletType) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const priv0Hex = String(sess.priv0_hex || "").trim();
    if (!priv0Hex) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    const k = await kaspaReadyOrThrow();
    const priv0 = new k.PrivateKey(priv0Hex);

    const stAddr0 = String(st.address0 || "").trim();
    if (!stAddr0) {
      clearKeyringSession();
      throw new Error("keyfile_locked");
    }

    if (walletType === "standard") {
      const addrNet = getWalletAddressNetworkLabelOrThrow(activeNetworkId);
      const addr0 = String(priv0.toAddress(addrNet).toString());
      if (addr0 !== stAddr0) {
        clearKeyringSession();
        throw new Error("keyfile_locked");
      }
      return { walletType, priv0, addr0 };
    }

    return { walletType, priv0, addr0: stAddr0 };
  }

  async function httpJson(method, url, body, headers) {
    const h = Object.assign({ "accept": "application/json" }, headers || {});
    const init = { method, headers: h };
    if (body !== undefined) {
      h["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!r.ok) {
      const msg = parsed && (parsed.error || parsed.reason) ? String(parsed.error || parsed.reason) : raw;
      const err = new Error(msg || `HTTP ${r.status}`);
      err.status = r.status;
      err.payload = parsed;
      throw err;
    }
    return parsed !== null ? parsed : raw;
  }

  async function loadActiveWallet() {
    const st = await httpJson("GET", "/api/wallet/status");
    if (!st || !st.ok) {
      setMsg("No active wallet. Open the main CW page and create/select a wallet first.", "");
      throw new Error("no_active_wallet");
    }

    const networkMeta = getNetworkMetaOrThrow(st.network);
    const networkId = networkMeta.appKey;
    const activeWalletAddress = String(st.address0 || "").trim();

    if (UI.network) {
      UI.network.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = networkId;
      opt.textContent = String(networkMeta.sdkNetworkId || networkMeta.displayLabel || networkId).trim();
      UI.network.appendChild(opt);
      UI.network.value = networkId;
      UI.network.disabled = true;
    }

    if (UI.importOwnerAddress) {
      UI.importOwnerAddress.dataset.prefillValue = activeWalletAddress;
      if (!String(UI.importOwnerAddress.value || "").trim() && activeWalletAddress) {
        UI.importOwnerAddress.value = activeWalletAddress;
      }
    }

    if (UI.to) {
      UI.to.dataset.prefillValue = activeWalletAddress;
      if (!String(UI.to.value || "").trim() && activeWalletAddress) {
        UI.to.value = activeWalletAddress;
      }
    }

    if (UI.kastleStatus) {
      UI.kastleStatus.textContent = `Active wallet: ${st.wallet_id} (${st.wallet_type})`;
    }

    return { networkId, wallet: st };
  }

  function gather() {
    const name = cleanName(UI.name ? UI.name.value : "");
    const dec = String(Math.max(0, Math.min(18, Number(UI.dec ? UI.dec.value : 0) || 0)));
    const max = (UI.max ? UI.max.value : "").trim();

    const rawMode = (UI.deployKind && UI.deployKind.value ? UI.deployKind.value : "new").trim().toLowerCase();
    const pageMode = (rawMode === "wrapped" || rawMode === "import") ? "import" : "deploy";
    const deployKind = pageMode === "import" ? "import" : "deploy";

    const deployEnergyLockRequested = pageMode === "deploy" && !!(UI.deployEnergyLock && UI.deployEnergyLock.checked);
    const importEnergyLockRequested = pageMode === "import" && !!(UI.importEnergyLock && UI.importEnergyLock.checked);
    const energyLockRequested = deployEnergyLockRequested || importEnergyLockRequested;

    const pre = pageMode === "deploy"
      ? (deployEnergyLockRequested ? "0" : (((UI.pre ? UI.pre.value : "") || "").trim()))
      : "";
    const to = pageMode === "deploy" ? ((UI.to ? UI.to.value : "") || "").trim() : "";

    const importCa = ((UI.importCa ? UI.importCa.value : "") || "").trim().toLowerCase();
    const importOwnerAddress = ((UI.importOwnerAddress ? UI.importOwnerAddress.value : "") || "").trim();

    const priorityFee = "1.0";
    const timeout = "360000";
    const logLevel = "INFO";
    const network = (UI.network && UI.network.value ? UI.network.value : "").trim();

    if (UI.nameEcho) UI.nameEcho.textContent = name || "—";

    return {
      name, dec, max, pre, to,
      deployKind,
      pageMode,
      deployEnergyLockRequested,
      importEnergyLockRequested,
      energyLockRequested,
      importCa,
      importOwnerAddress,
      priorityFee, timeout, logLevel, network
    };
  }

  function buildPreview(p) {
    if (String(p.pageMode || "deploy") === "import") {
      return JSON.stringify({
        op: "import",
        networkId: p.network,
        ca: p.importCa,
        ownerAddress: p.importOwnerAddress || null
      }, null, 2);
    }

    const action = {
      p: "krc-20",
      op: "deploy",
      mod: "issue",
      name: p.name,
      max: p.max,
      dec: p.dec,
    };
    if (p.pre && String(p.pre) !== "0") {
      action.pre = p.pre;
    }
    if (p.to) {
      action.to = p.to;
    }
    return JSON.stringify(action, null, 2);
  }

  function validateBasic(p, activeNetworkId) {
    const pageMode = String(p.pageMode || "deploy").trim().toLowerCase();

    if (pageMode === "import") {
      if (!validCa(p.importCa)) {
        setMsg("<strong>Invalid</strong>: Contract Address must be a 64-character hex string.");
        return false;
      }

      let requestedNetworkId = "";
      let normalizedActiveNetworkId = "";

      try {
        requestedNetworkId = getAppNetworkKeyOrThrow(p.network);
        normalizedActiveNetworkId = getAppNetworkKeyOrThrow(activeNetworkId);
      } catch (_) {
        setMsg("<strong>Invalid</strong>: Unable to resolve the active wallet network.");
        return false;
      }

      if (requestedNetworkId !== normalizedActiveNetworkId) {
        setMsg("<strong>Invalid</strong>: Import network must match the active wallet network.");
        return false;
      }
      if (p.importOwnerAddress && !validKaspaAddrForNetwork(normalizedActiveNetworkId, p.importOwnerAddress)) {
        setMsg("<strong>Invalid</strong>: Owner / Issue address does not match the active network.");
        return false;
      }
      return true;
    }

    if (!validName(p.name)) { setMsg("<strong>Invalid</strong>: name must be 4–6 uppercase letters."); return false; }
    if (!validDigits(p.max)) { setMsg("<strong>Invalid</strong>: Max Supply (RAW) must be digits only."); return false; }
    if (p.pre && !validDigits(p.pre)) { setMsg("<strong>Invalid</strong>: Pre-Issue (RAW) must be digits only."); return false; }
    if (p.pre && String(p.pre) !== "0" && !validKaspaAddr(p.to)) { setMsg("<strong>Invalid</strong>: Issue-To address required when pre>0."); return false; }

    if (!UI.agree || !UI.agree.checked) { setMsg("Please acknowledge the 1000 KAS fee."); return false; }
    return true;
  }

  function applyDeployKindUI(activeNetworkId) {
    const rawMode = (UI.deployKind && UI.deployKind.value ? UI.deployKind.value : "new").trim().toLowerCase();
    const pageMode = (rawMode === "wrapped" || rawMode === "import") ? "import" : "deploy";
    const isImport = pageMode === "import";

    if (UI.deployOnlyFields) {
      UI.deployOnlyFields.classList.toggle("hidden", isImport);
    }

    if (UI.importFields) {
      UI.importFields.classList.toggle("hidden", !isImport);
    }

    if (!isImport && UI.importMetadataFields) {
      UI.importMetadataFields.classList.add("hidden");
    }

    syncEnergyLockUI(pageMode);

    setReadOnlyInput(UI.name, false);
    setReadOnlyInput(UI.dec, false);
    setReadOnlyInput(UI.max, false);

    if (UI.agree) {
      UI.agree.disabled = isImport;
      if (isImport) UI.agree.checked = false;
    }

    if (isImport) {
      if (UI.pre) UI.pre.value = "";
      if (UI.to) UI.to.value = "";
      if (UI.importOwnerAddress && !String(UI.importOwnerAddress.value || "").trim()) {
        UI.importOwnerAddress.value = String(UI.importOwnerAddress.dataset.prefillValue || "").trim();
      }
      if (!String(UI.importCa && UI.importCa.value ? UI.importCa.value : "").trim()) {
        clearImportMetadata(activeNetworkId);
      }
    } else {
      if (UI.to && !String(UI.to.value || "").trim()) {
        UI.to.value = String(UI.to.dataset.prefillValue || "").trim();
      }
    }

    if (UI.wrappedAdminTokenFields) {
      UI.wrappedAdminTokenFields.classList.add("hidden");
    }
  }

  // CB-3: Keyfile unlock occurs on the Wallet page (USB keyfile). Script pages use the unlocked keyring session.

  async function onPreview(activeNetworkId) {
    const p = gather();
    if (!validateBasic(p, activeNetworkId)) return;

    const actionJson = buildPreview(p);
    if (UI.cmdPreview) UI.cmdPreview.textContent = actionJson;
    if (UI.previewWrap) UI.previewWrap.classList.remove("hidden");

    if (String(p.pageMode || "deploy") === "import") {
      const headers = {};
      setBusy(true);
      try {
        clearImportMetadata(activeNetworkId);
        setMsg("Resolving import metadata via Compliance Wallet…", "muted");
        const importRes = await httpJson(
          "POST",
          "/api/v1/krc20/import/preview",
          {
            networkId: p.network,
            ca: p.importCa,
            ownerAddress: p.importOwnerAddress || null
          },
          headers
        );

        if (!importRes || importRes.ok !== true) {
          const msg = (importRes && (importRes.error || importRes.message || importRes.reason)) || "KRC import preview failed";
          throw new Error(msg);
        }

        const normalizedActiveNetworkId = getAppNetworkKeyOrThrow(activeNetworkId);
        const resolvedNetworkId = getAppNetworkKeyOrThrow(
          (importRes && importRes.networkId) ||
          (importRes && importRes.metadata && importRes.metadata.networkId) ||
          normalizedActiveNetworkId
        );

        if (resolvedNetworkId !== normalizedActiveNetworkId) {
          throw new Error("Imported CA metadata does not match the active wallet network.");
        }

        applyImportMetadata(importRes, normalizedActiveNetworkId);

        if (UI.out) UI.out.textContent = JSON.stringify(importRes, null, 2);
        if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
        setMsg("Import metadata preview ready.", "muted");
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        setMsg("Import preview failed: " + msg, "");
        if (UI.out) UI.out.textContent = e && e.payload ? JSON.stringify(e.payload, null, 2) : "";
        if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
      } finally {
        setBusy(false);
      }
      return;
    }

    setMsg("Preview ready.");
  }

  async function onDeploy(activeNetworkId) {
    const p = gather();
    if (!validateBasic(p, activeNetworkId)) return;

    const actionJson = buildPreview(p);
    if (UI.cmdPreview) UI.cmdPreview.textContent = actionJson;
    if (UI.previewWrap) UI.previewWrap.classList.remove("hidden");

    if (UI.out) UI.out.textContent = "";
    if (UI.outputWrap) UI.outputWrap.classList.add("hidden");

    const headers = {};

    if (String(p.pageMode || "deploy") === "import") {
      setBusy(true);
      try {
        clearImportMetadata(activeNetworkId);
        setMsg("Submitting import via Compliance Wallet…", "muted");
        const importRes = await httpJson(
          "POST",
          "/api/v1/krc20/import",
          {
            networkId: p.network,
            ca: p.importCa,
            ownerAddress: p.importOwnerAddress || null,
            energyLockRequested: p.importEnergyLockRequested
          },
          headers
        );

        if (!importRes || importRes.ok !== true) {
          const msg = (importRes && (importRes.error || importRes.message || importRes.reason)) || "KRC import failed";
          throw new Error(msg);
        }

        const normalizedActiveNetworkId = getAppNetworkKeyOrThrow(activeNetworkId);
        const resolvedNetworkId = getAppNetworkKeyOrThrow(
          (importRes && importRes.networkId) ||
          (importRes && importRes.metadata && importRes.metadata.networkId) ||
          normalizedActiveNetworkId
        );

        if (resolvedNetworkId !== normalizedActiveNetworkId) {
          throw new Error("Imported CA metadata does not match the active wallet network.");
        }

        applyImportMetadata(importRes, normalizedActiveNetworkId);

        if (UI.out) UI.out.textContent = JSON.stringify(importRes, null, 2);
        if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
        setMsg("Import completed.", "muted");
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        setMsg("Import failed: " + msg, "");
        if (UI.out) UI.out.textContent = e && e.payload ? JSON.stringify(e.payload, null, 2) : "";
        if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
      } finally {
        setBusy(false);
      }
      return;
    }

    setMsg("Preparing Issue-Mode deploy via Compliance Wallet…");
    const baseBody = {
      name: p.name,
      dec: p.dec,
      max: p.max,
      pre: p.pre,
      to: p.to,
      energyLockRequested: p.deployEnergyLockRequested,
      priorityFee: p.priorityFee,
      timeout: p.timeout,
      logLevel: p.logLevel,
    };

    setBusy(true);
    try {
      setMsg("Checking unlocked wallet…", "muted");
      const keyring = await requireUnlockedKeyringOrThrow(activeNetworkId);

      setMsg("Building commit…", "muted");
      const build = await httpJson(
        "POST",
        "/api/v1/krc20/deploy",
        Object.assign({ stage: "krc_commit_build" }, baseBody),
        headers
      );

      if (build && build.ok === true && build.stage === "bcw_krc20_deploy_intent") {
        const k = await kaspaReadyOrThrow();
        if (!keyring || !keyring.priv0) throw new Error("wallet_locked");
        if (typeof k.signMessage !== "function") throw new Error("signMessage_unavailable");

        const intent = build.intent && typeof build.intent === "object" ? build.intent : null;
        const intentMessage = String(build.intent_message || "").trim();
        if (!intent || !intentMessage) throw new Error("bcw_krc20_deploy_intent_invalid");

        const authSignature = k.signMessage({
          message: intentMessage,
          privateKey: keyring.priv0
        });

        setMsg("Submitting broker-custody deploy intent…", "muted");
        const deployRes = await httpJson(
          "POST",
          "/api/v1/krc20/deploy",
          Object.assign({
            stage: "krc_commit_submit",
            bcw_krc20_deploy_intent: intent,
            bcw_auth_signature: String(authSignature || "")
          }, baseBody),
          headers
        );

        if (!deployRes || deployRes.ok !== true) {
          const msg = (deployRes && (deployRes.error || deployRes.message || deployRes.reason)) || "BCW deploy submit failed";
          throw new Error(msg);
        }

        if (UI.out) UI.out.textContent = JSON.stringify(deployRes, null, 2);
        if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
        setMsg("Deploy completed.", "muted");
        return;
      }

      if (!build || build.ok !== true || build.stage !== "krc_commit_build") {
        const msg = (build && (build.error || build.message || build.reason)) || "KRC commit build failed";
        throw new Error(msg);
      }

      const k = await kaspaReadyOrThrow();

      const networkId = String(build.networkId || "");
      const fromAddress = String(build.fromAddress || "");
      const feeRate = Number(build.feeRate || 0);
      const commitAmountSompi = BigInt(String(build.commitAmountSompi || "0"));
      const minDeployFeeSompi = BigInt(String(build.minDeployFeeSompi || "0"));
      const payloadJson = String(build.payloadJson || "");

      if (!networkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n || minDeployFeeSompi <= 0n) {
        throw new Error("krc_commit_build_invalid");
      }

      if (keyring.walletType === "standard" && String(keyring.addr0 || "") !== fromAddress) {
        throw new Error("password_incorrect_or_wallet_mismatch");
      }

      const entriesSafe = Array.isArray(build.entries) ? build.entries : [];
      const entries = entriesSafe.map((e) => ({
        outpoint: e.outpoint,
        scriptPublicKey: e.scriptPublicKey,
        isCoinbase: !!e.isCoinbase,
        amount: BigInt(String(e.amount || "0")),
        blockDaaScore: BigInt(String(e.blockDaaScore || "0")),
      }));

      const enc = new TextEncoder();

      const pub = keyring.priv0.toPublicKey();
      const script = new k.ScriptBuilder()
        .addData(pub.toXOnlyPublicKey().toString())
        .addOp(k.Opcodes.OpCheckSig)
        .addOp(k.Opcodes.OpFalse)
        .addOp(k.Opcodes.OpIf)
        .addData(enc.encode("kasplex"))
        .addI64(0n)
        .addData(enc.encode(payloadJson))
        .addOp(k.Opcodes.OpEndIf);

      const p2shAddrObj = k.addressFromScriptPublicKey(script.createPayToScriptHashScript(), networkId);
      const p2shAddress = p2shAddrObj ? p2shAddrObj.toString() : "";
      if (!p2shAddress) throw new Error("p2sh_address_failed");

      const outputs = [{ address: p2shAddress, amount: commitAmountSompi }];

      const txOpts = {
        outputs,
        changeAddress: fromAddress,
        feeRate,
        priorityFee: { amount: 0n, source: k.FeeSource.SenderPays },
        entries,
        networkId
      };

      const commitCreated = await k.createTransactions(txOpts);

      const signedCommit = [];
      for (const ptx of commitCreated.transactions) {
        ptx.sign([keyring.priv0], true);
        signedCommit.push(ptx.serializeToSafeJSON());
      }

      setMsg("Submitting commit…", "muted");
      const commitSubmitBody = Object.assign({ stage: "krc_commit_submit", signed_txs: signedCommit }, baseBody);

      const commitRes = await httpJson(
        "POST",
        "/api/v1/krc20/deploy",
        commitSubmitBody,
        headers
      );

      if (!commitRes || commitRes.ok !== true) {
        const msg = (commitRes && (commitRes.error || commitRes.message || commitRes.reason)) || "Commit submit failed";
        throw new Error(msg);
      }

      const commitTxids = Array.isArray(commitRes.commitTxids)
        ? commitRes.commitTxids
        : (Array.isArray(commitRes.txids) ? commitRes.txids : []);

      if (!commitTxids || commitTxids.length === 0) {
        throw new Error("commit_txids_missing");
      }

      setMsg("Waiting for commit UTXO…", "muted");
      const waitRes = await httpJson(
        "POST",
        "/api/v1/krc20/deploy",
        Object.assign({ stage: "krc_reveal_wait", p2shAddress, commitTxids }, baseBody),
        headers
      );

      if (!waitRes || waitRes.ok !== true || waitRes.stage !== "krc_reveal_wait") {
        const msg = (waitRes && (waitRes.error || waitRes.message || waitRes.reason)) || "Reveal wait failed";
        throw new Error(msg);
      }

      const ce = waitRes.commitEntry || null;
      if (!ce || !ce.outpoint) throw new Error("commit_entry_missing");

      const commitEntry = {
        outpoint: ce.outpoint,
        scriptPublicKey: ce.scriptPublicKey,
        isCoinbase: !!ce.isCoinbase,
        amount: BigInt(String(ce.amount || "0")),
        blockDaaScore: BigInt(String(ce.blockDaaScore || "0")),
      };

      const wantedTxid = String(ce?.outpoint?.transactionId || "");
      const wantedIdx = Number(ce?.outpoint?.index ?? -1);

      const buildReveal = async (effectiveFeeRate) => {
        const args = {
          priorityEntries: [commitEntry],
          entries: [],
          changeAddress: fromAddress,
          outputs: [],
          feeRate: effectiveFeeRate,
          priorityFee: minDeployFeeSompi,
          networkId
        };

        const created = await k.createTransactions(args);
        if (!created.transactions || created.transactions.length !== 1) {
          throw new Error("unexpected_reveal_batch");
        }
        return created.transactions[0];
      };

      const fillRevealInput0OrThrow = async (tx) => {
        const inputIndex = tx.transaction.inputs.findIndex((input) => {
          const op = input && input.previousOutpoint ? input.previousOutpoint : null;
          const tid = op && typeof op.transactionId === "string" ? op.transactionId : "";
          const idx = op && typeof op.index === "number" ? op.index : -1;
          return tid === wantedTxid && idx === wantedIdx;
        });

        if (inputIndex === -1) throw new Error("p2sh_input_not_found");
        if (inputIndex !== 0) throw new Error("p2sh_input_not_input0");

        const signature = await tx.createInputSignature(0, keyring.priv0);
        tx.fillInput(0, script.encodePayToScriptHashSignatureScript(signature));
      };

      setMsg("Building reveal…", "muted");
      const tx0 = await buildReveal(feeRate);
      await fillRevealInput0OrThrow(tx0);

      const requiredFee0 = k.calculateTransactionFee(networkId, tx0.transaction);
      if (requiredFee0 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");

      let revealTx = tx0;

      if (revealTx.feeAmount < requiredFee0) {
        const currentFee = revealTx.feeAmount > 0n ? revealTx.feeAmount : 1n;
        const scale = 1000000n;
        const scaled = (requiredFee0 * scale + currentFee - 1n) / currentFee;
        const neededFeeRate = Math.max(1.0, feeRate * (Number(scaled) / 1000000));
        const effectiveFeeRate = Math.max(feeRate, neededFeeRate);

        const tx1 = await buildReveal(effectiveFeeRate);
        await fillRevealInput0OrThrow(tx1);

        const requiredFee1 = k.calculateTransactionFee(networkId, tx1.transaction);
        if (requiredFee1 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");
        if (tx1.feeAmount < requiredFee1) throw new Error("reveal_fee_under_minimum");

        revealTx = tx1;
      }

      const signedReveal = [revealTx.serializeToSafeJSON()];

      setMsg("Submitting reveal…", "muted");
      const revealRes = await httpJson(
        "POST",
        "/api/v1/krc20/deploy",
        Object.assign({ stage: "krc_reveal_submit", signed_txs: signedReveal }, baseBody),
        headers
      );

      if (!revealRes || revealRes.ok !== true) {
        const msg = (revealRes && (revealRes.error || revealRes.message || revealRes.reason)) || "Reveal submit failed";
        throw new Error(msg);
      }

      if (UI.out) UI.out.textContent = JSON.stringify(revealRes, null, 2);
      if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
      setMsg("Deploy completed.", "muted");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      setMsg("Deploy failed: " + msg, "");
      if (UI.out) UI.out.textContent = e && e.payload ? JSON.stringify(e.payload, null, 2) : "";
      if (UI.outputWrap) UI.outputWrap.classList.remove("hidden");
    } finally {
      setBusy(false);
    }
  }

  async function boot() {
    hideKastleCard();

    let activeNetworkId = "";
    try {
      const st = await loadActiveWallet();
      activeNetworkId = st.networkId;
      applyDeployKindUI(activeNetworkId);
    } catch (_) {}

    if (UI.name) {
      UI.name.addEventListener("input", () => {
        const v = cleanName(UI.name.value);
        if (UI.name.value !== v) UI.name.value = v;
        if (UI.nameEcho) UI.nameEcho.textContent = v || "—";
      });
      UI.name.dispatchEvent(new Event("input"));
    }

    if (UI.deployKind) {
      UI.deployKind.addEventListener("change", () => applyDeployKindUI(activeNetworkId));
    }

    if (UI.deployEnergyLock) {
      UI.deployEnergyLock.addEventListener("change", () => {
        const rawMode = (UI.deployKind && UI.deployKind.value ? UI.deployKind.value : "new").trim().toLowerCase();
        const pageMode = (rawMode === "wrapped" || rawMode === "import") ? "import" : "deploy";
        syncEnergyLockUI(pageMode);
      });
    }

    if (UI.importEnergyLock) {
      UI.importEnergyLock.addEventListener("change", () => {
        const rawMode = (UI.deployKind && UI.deployKind.value ? UI.deployKind.value : "new").trim().toLowerCase();
        const pageMode = (rawMode === "wrapped" || rawMode === "import") ? "import" : "deploy";
        syncEnergyLockUI(pageMode);
      });
    }

    if (UI.importCa) {
      UI.importCa.addEventListener("input", () => {
        const rawMode = (UI.deployKind && UI.deployKind.value ? UI.deployKind.value : "new").trim().toLowerCase();
        const pageMode = (rawMode === "wrapped" || rawMode === "import") ? "import" : "deploy";
        if (pageMode === "import") {
          clearImportMetadata(activeNetworkId);
        }
      });
    }

    if (UI.btnPreview) {
      UI.btnPreview.addEventListener("click", (ev) => {
        ev.preventDefault();
        onPreview(activeNetworkId);
      });
    }

    if (UI.btnDeploy) {
      UI.btnDeploy.addEventListener("click", (ev) => {
        ev.preventDefault();
        onDeploy(activeNetworkId);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    boot().catch(() => {});
  });
})();
