// Compliance Wallet Issue UI (Issue v1)
// Uses CW active wallet + staged /api/v1/krc20/issue/* endpoints.
// Blocks issuance to Wrapped CAs (must use Wrap flow instead).

import "/static/js/kaspa-bridge.mjs";

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const UI = {
    issueMsg: $("issueMsg"),
    issueModeIssue: $("issueModeIssue"),
    issueModeBurn: $("issueModeBurn"),
    issueCa: $("issueCa"),
    issueAmt: $("issueAmt"),
    issueTo: $("issueTo"),
    issueToLabel: $("issueToLabel"),
    issueToHelp: $("issueToHelp"),

    issuePreviewWrap: $("issuePreviewWrap"),
    issueJsonPreview: $("issueJsonPreview"),

    outputWrap: $("outputWrap"),
    out: $("out"),

    issuableWrap: $("issuableWrap"),
    issuableEmpty: $("issuableEmpty"),
    issuableRows: $("issuableRows"),

    btnIssuePreview: $("btnIssuePreview"),
    btnIssue: $("btnIssue"),
  };

  function setIssueMsg(html, cls = "") {
    if (!UI.issueMsg) return;
    UI.issueMsg.className = cls || "muted";
    UI.issueMsg.innerHTML = html;
  }

  function setBusy(busy) {
    if (UI.btnIssuePreview) UI.btnIssuePreview.disabled = !!busy;
    if (UI.btnIssue) UI.btnIssue.disabled = !!busy;
  }

  async function httpJson(method, url, body, headers) {
    const h = Object.assign({ accept: "application/json" }, headers || {});
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

  function getNetworkMetaOrThrow(raw, fallbackRaw) {
    const shared = getNetworkSharedOrThrow();
    const primary = shared.normalizeAppNetworkKey(raw);
    const fallback = shared.normalizeAppNetworkKey(fallbackRaw);
    const appKey = primary || fallback;
    const meta = shared.getNetworkMeta(appKey);
    if (!meta || !meta.appKey) throw new Error("invalid_network");
    return meta;
  }

  function canonicalNetId(raw, fallbackRaw) {
    return String(getNetworkMetaOrThrow(raw, fallbackRaw).appKey || "").trim();
  }

  function activeWalletNetworkIdOrNull(st) {
    const activeNet = st && st.ok ? String(st.network || "").trim() : "";
    try {
      return canonicalNetId(activeNet, activeNet);
    } catch (_) {
      return "";
    }
  }

  function validDigits(s) {
    return /^\d{1,64}$/.test(String(s || "").trim());
  }

  function validKaspaAddrForNetwork(networkId, s) {
    return getNetworkSharedOrThrow().isKaspaAddressForNetwork(s, networkId);
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

  function toAddrNetworkFromNetworkId(networkId) {
    const label = String(getNetworkMetaOrThrow(networkId, "").walletNetworkLabel || "").trim();
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

    let me = null;
    try {
      me = await httpJson("GET", "/api/v1/session/me");
    } catch (_) {
      clearKeyringSession();
      throw new Error("auth_required");
    }

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
    const addr0Expected = String(st.address0 || "").trim();

    if (!walletId || !addr0Expected) {
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

    if (walletType === "standard") {
      const addrNet = toAddrNetworkFromNetworkId(activeNetworkId);
      const addr0 = String(priv0.toAddress(addrNet).toString());
      if (addr0 !== addr0Expected) {
        clearKeyringSession();
        throw new Error("keyfile_locked");
      }
      return { walletType, priv0, addr0 };
    }

    return { walletType, priv0, addr0: addr0Expected };
  }

  function getSelectedIssueMode() {
    return UI.issueModeBurn && UI.issueModeBurn.checked ? "burn" : "issue";
  }

  function syncIssueModeUi() {
    const mode = getSelectedIssueMode();
    const isBurn = mode === "burn";

    if (UI.issueTo) {
      UI.issueTo.disabled = isBurn;
      if (isBurn) {
        UI.issueTo.setAttribute("aria-disabled", "true");
      } else {
        UI.issueTo.removeAttribute("aria-disabled");
      }
    }

    if (UI.issueToLabel) {
      UI.issueToLabel.style.opacity = isBurn ? "0.65" : "";
    }

    if (UI.issueToHelp) {
      UI.issueToHelp.textContent = isBurn ? "Disabled in BURN mode." : "Required in ISSUE mode only.";
    }
  }

  function gatherIssue() {
    const mode = getSelectedIssueMode();
    const ca = String(UI.issueCa ? UI.issueCa.value : "").trim();
    const amt = String(UI.issueAmt ? UI.issueAmt.value : "").trim();
    const to = mode === "burn" ? "" : String(UI.issueTo ? UI.issueTo.value : "").trim();
    return { mode, ca, amt, to };
  }

  function buildIssueAction(p) {
    const mode = String(p && p.mode ? p.mode : "issue").trim().toLowerCase();
    const action = mode === "burn"
      ? { p: "krc-20", op: "burn", ca: p.ca, amt: p.amt }
      : { p: "krc-20", op: "issue", ca: p.ca, amt: p.amt, to: p.to };
    return JSON.stringify(action, null, 2);
  }

  async function loadWrappedConfig() {
    try {
      const cfg = await httpJson("GET", "/api/v1/wrapped-config");
      return cfg && typeof cfg === "object" ? cfg : null;
    } catch {
      return null;
    }
  }

  async function loadEnergyTokens() {
    try {
      const out = await httpJson("GET", "/api/v1/energy/tokens");
      return out && out.ok === true && Array.isArray(out.tokens) ? out.tokens : [];
    } catch {
      return [];
    }
  }

  function isWrappedCa(cfg, netId, ca) {
    const c = String(ca || "").trim().toLowerCase();
    if (!c) return false;

    const m0 = cfg && cfg.controlledAssetsByNetwork && typeof cfg.controlledAssetsByNetwork === "object"
      ? cfg.controlledAssetsByNetwork
      : null;

    if (!m0) return false;

    const bucket = m0[String(netId || "")];
    if (!bucket || typeof bucket !== "object") return false;

    if (bucket[c]) return true;

    for (const v of Object.values(bucket)) {
      if (!v || typeof v !== "object") continue;
      const vca = String(v.ca || "").trim().toLowerCase();
      if (vca && vca === c) return true;
    }

    return false;
  }

  function expectedDeployerForCa(cfg, netId, ca) {
    const c = String(ca || "").trim();
    const lc = c.toLowerCase();
    if (!c) return "";

    const bucket =
      cfg && cfg.issuance && typeof cfg.issuance === "object" &&
      cfg.issuance.deployerByNetwork && typeof cfg.issuance.deployerByNetwork === "object"
        ? cfg.issuance.deployerByNetwork[netId]
        : null;

    if (!bucket || typeof bucket !== "object") return "";

    if (bucket[c]) return String(bucket[c] || "").trim();
    if (bucket[lc]) return String(bucket[lc] || "").trim();

    return "";
  }

  function assetMetaForCa(cfg, netId, ca) {
    const c = String(ca || "").trim();
    const lc = c.toLowerCase();
    if (!c) return { name: "", decimals: null };

    const controlledBucket =
      cfg && cfg.controlledAssetsByNetwork && typeof cfg.controlledAssetsByNetwork === "object"
        ? cfg.controlledAssetsByNetwork[netId]
        : null;

    if (controlledBucket && typeof controlledBucket === "object") {
      const controlled = controlledBucket[c] || controlledBucket[lc] || null;
      if (controlled && typeof controlled === "object") {
        const controlledName = String(controlled.name || "").trim();
        const controlledDecimals =
          typeof controlled.decimals === "number" &&
          Number.isInteger(controlled.decimals) &&
          Number(controlled.decimals) >= 0
            ? Number(controlled.decimals)
            : null;

        if (controlledName || Number.isInteger(controlledDecimals)) {
          return { name: controlledName, decimals: controlledDecimals };
        }
      }
    }

    const metaBucket =
      cfg && cfg.issuance && typeof cfg.issuance === "object" &&
      cfg.issuance.metaByNetwork && typeof cfg.issuance.metaByNetwork === "object"
        ? cfg.issuance.metaByNetwork[netId]
        : null;

    if (metaBucket && typeof metaBucket === "object") {
      const rec = metaBucket[c] || metaBucket[lc] || null;
      if (rec && typeof rec === "object") {
        const metaName = String(rec.name || "").trim();
        const metaDecimals =
          typeof rec.decimals === "number" &&
          Number.isInteger(rec.decimals) &&
          Number(rec.decimals) >= 0
            ? Number(rec.decimals)
            : null;
        return { name: metaName, decimals: metaDecimals };
      }
    }

    return { name: "", decimals: null };
  }

  function computeIssuableCAs(cfg, netId, activeAddr0, energyLockedSet) {
    const active = String(activeAddr0 || "").trim().toLowerCase();
    if (!active) return [];

    const locked = energyLockedSet instanceof Set ? energyLockedSet : new Set();

    const bucket =
      cfg && cfg.issuance && typeof cfg.issuance === "object" &&
      cfg.issuance.deployerByNetwork && typeof cfg.issuance.deployerByNetwork === "object"
        ? cfg.issuance.deployerByNetwork[netId]
        : null;

    if (!bucket || typeof bucket !== "object") return [];

    const out = [];
    for (const [ca0, dep0] of Object.entries(bucket)) {
      const ca = String(ca0 || "").trim();
      if (!ca) continue;
      if (locked.has(ca.toLowerCase())) continue;

      const dep = String(dep0 || "").trim().toLowerCase();
      if (!dep || dep !== active) continue;

      const meta = assetMetaForCa(cfg, netId, ca);

      out.push({
        ca,
        name: String(meta && meta.name ? meta.name : "").trim() || "Issue-Mode",
        decimals: Number.isInteger(meta && meta.decimals) ? Number(meta.decimals) : null
      });
    }

    out.sort((a, b) => String(a.ca).localeCompare(String(b.ca)));
    return out;
  }

  function formatRawUnits(rawStr, decimals) {
    const raw = String(rawStr || "").trim();
    const d = Number(decimals);
    if (!/^\d+$/.test(raw) || !Number.isFinite(d) || d < 0) return "";
    if (d === 0) return raw.replace(/^0+(?=\d)/, "") || "0";
    const padded = raw.padStart(d + 1, "0");
    const i = padded.slice(0, -d).replace(/^0+(?=\d)/, "") || "0";
    const f = padded.slice(-d).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }

  async function loadBridgeInventory(netId) {
    const net = canonicalNetId(netId, "");
    if (!net) return null;

    const out = await httpJson("GET", `/api/v1/bridge/inventory?net=${encodeURIComponent(net)}`);
    return out && out.ok === true ? out : null;
  }

  async function loadWalletHoldingsStrict() {
    const out = await httpJson("GET", "/api/wallet/holdings?strict=1");
    return out && typeof out === "object" ? out : null;
  }

  function formatHumanIssueAmount(v) {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    const s = String(v == null ? "" : v).trim();
    if (!s) return "0";
    return s;
  }

  function issueHoldingsByCaFromWalletHoldings(walletHoldings) {
    const out = Object.create(null);
    const rows =
      walletHoldings && Array.isArray(walletHoldings.issue)
        ? walletHoldings.issue
        : [];

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const ca = String(row.ca || "").trim().toLowerCase();
      if (!ca) continue;
      out[ca] = formatHumanIssueAmount(row.amount);
    }

    return out;
  }

  function renderIssuableTable(cas, inventory, walletHoldings, netId, activeAddr0, hiddenEnergyCount) {
    if (!UI.issuableRows || !UI.issuableEmpty) return;

    const list = Array.isArray(cas) ? cas : [];
    const inv = inventory && typeof inventory === "object" ? inventory : null;
    const walletHoldingsAvailable =
      walletHoldings &&
      typeof walletHoldings === "object" &&
      Array.isArray(walletHoldings.issue);
    const activeWalletIssueHoldingsByCa = issueHoldingsByCaFromWalletHoldings(walletHoldings);
    const queuedByCa =
      inv && inv.committedPaidUnfulfilledRawByCa && typeof inv.committedPaidUnfulfilledRawByCa === "object"
        ? inv.committedPaidUnfulfilledRawByCa
        : null;

    UI.issuableRows.innerHTML = "";

    const wrap = UI.issuableWrap || null;
    const tableWrap = UI.issuableRows.closest ? UI.issuableRows.closest(".table-wrap") : null;

    if (list.length === 0) {
      UI.issuableEmpty.innerHTML =
        hiddenEnergyCount > 0
          ? `No normal-issuable CA(s) are available on <span class="mono">${netId}</span> for this wallet. <strong>${hiddenEnergyCount}</strong> energy-locked CA(s) are reserved to the Energy page.`
          : `None found for <span class="mono">${netId}</span> with active wallet <span class="mono">${String(activeAddr0 || "").trim() || "?"}</span>.`;
      if (tableWrap) tableWrap.classList.add("hidden");
      if (wrap) wrap.classList.remove("hidden");
      return;
    }

    UI.issuableEmpty.innerHTML = walletHoldingsAvailable
      ? `Found <strong>${list.length}</strong> normal-issuable CA(s) on <span class="mono">${netId}</span> for this wallet.${hiddenEnergyCount > 0 ? ` <strong>${hiddenEnergyCount}</strong> energy-locked CA(s) are reserved to the Energy page.` : ""} Holdings are read from the active wallet. Click a CA to paste it into the CA field.`
      : `Found <strong>${list.length}</strong> normal-issuable CA(s) on <span class="mono">${netId}</span> for this wallet.${hiddenEnergyCount > 0 ? ` <strong>${hiddenEnergyCount}</strong> energy-locked CA(s) are reserved to the Energy page.` : ""} Active-wallet holdings are unavailable right now. Click a CA to paste it into the CA field.`;
    if (tableWrap) tableWrap.classList.remove("hidden");
    if (wrap) wrap.classList.remove("hidden");

    for (const row of list) {
      const ca = String(row && row.ca ? row.ca : "").trim();
      const nm = String(row && row.name ? row.name : "").trim() || "Issue-Mode";
      const decimals = Number.isInteger(row && row.decimals) ? Number(row.decimals) : null;
      if (!ca) continue;

      const caLc = ca.toLowerCase();
      const holdingsDisplay = walletHoldingsAvailable
        ? (activeWalletIssueHoldingsByCa[caLc] || "0")
        : "Unavailable";
      const inQueueRaw =
        queuedByCa && typeof queuedByCa[caLc] === "string"
          ? String(queuedByCa[caLc] || "0")
          : "0";

      const inQueueDisplay = inv
        ? (Number.isInteger(decimals) ? (formatRawUnits(inQueueRaw, decimals) || "0") : inQueueRaw)
        : "Unavailable";

      const tr = document.createElement("tr");

      const tdName = document.createElement("td");
      tdName.textContent = nm;

      const tdCa = document.createElement("td");
      const span = document.createElement("span");
      span.className = "mono";
      span.style.cursor = "pointer";
      span.title = "Click to paste into CA field";
      span.textContent = ca;
      span.style.display = "block";
      span.style.maxWidth = "26ch";
      span.style.maxHeight = "2.4em";
      span.style.overflow = "hidden";
      span.style.overflowWrap = "anywhere";
      span.style.wordBreak = "break-all";
      span.style.lineHeight = "1.2";

      span.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (UI.issueCa) {
          UI.issueCa.value = ca;
          UI.issueCa.focus();
          try { UI.issueCa.setSelectionRange(0, ca.length); } catch (_) {}
        }
      });

      tdCa.appendChild(span);

      const tdDecimals = document.createElement("td");
      tdDecimals.textContent = Number.isInteger(decimals) ? String(decimals) : "";

      const tdHoldings = document.createElement("td");
      tdHoldings.textContent = holdingsDisplay;

      const tdInQueue = document.createElement("td");
      tdInQueue.textContent = inQueueDisplay;

      tr.appendChild(tdName);
      tr.appendChild(tdCa);
      tr.appendChild(tdDecimals);
      tr.appendChild(tdHoldings);
      tr.appendChild(tdInQueue);
      UI.issuableRows.appendChild(tr);
    }
  }

  // CB-3: unlock on Wallet page; Issue uses unlocked keyring session.

  async function validateIssue(p, st, cfg, energyLockedSet) {
    const mode = String(p && p.mode ? p.mode : "issue").trim().toLowerCase();
    const actionLabel = mode === "burn" ? "Burn" : "Issue";

    if (!p.ca) {
      setIssueMsg(`<strong>${actionLabel}</strong>: Contract Address (CA) is required.`);
      return false;
    }
    if (!validDigits(p.amt)) {
      setIssueMsg(`<strong>${actionLabel}</strong>: Amount (RAW) must be digits only.`);
      return false;
    }

    const netId = activeWalletNetworkIdOrNull(st);
    if (!netId) {
      setIssueMsg(`<strong>${actionLabel}</strong>: Active wallet network is unavailable.`);
      return false;
    }

    if (mode !== "burn" && (!p.to || !validKaspaAddrForNetwork(netId, p.to))) {
      setIssueMsg("<strong>Issue</strong>: Issue-To address is required and must match the active wallet network.");
      return false;
    }

    const caLc = String(p.ca || "").trim().toLowerCase();
    const locked = energyLockedSet instanceof Set ? energyLockedSet : new Set();
    if (caLc && locked.has(caLc)) {
      setIssueMsg(`<strong>ENERGY LOCKED.</strong> This CA is reserved to the Energy page for issuance and cannot be issued from the normal Issue page.`);
      return false;
    }

    if (!cfg || typeof cfg !== "object") {
      setIssueMsg("<strong>ISSUER GATE:</strong> Unable to load wrapped-config (required to verify deployer).");
      return false;
    }

    const expected = expectedDeployerForCa(cfg, netId, p.ca);
    const activeAddr = st && st.ok ? String(st.address0 || "").trim() : "";
    if (!expected) {
      setIssueMsg(`<strong>ISSUER GATE:</strong> Unknown deployer for CA on <span class="mono">${netId}</span>. Add CA→deployer mapping to <span class="mono">issuance.deployerByNetwork.${netId}</span> in wrapped-config.v7.json.`);
      return false;
    }
    if (!activeAddr) {
      setIssueMsg("<strong>ISSUER GATE:</strong> Active wallet address is missing.");
      return false;
    }
    if (String(expected).toLowerCase() !== String(activeAddr).toLowerCase()) {
      setIssueMsg(
        `<strong>ISSUER MISMATCH.</strong> This CA was deployed by <span class="mono">${expected}</span>, but the active wallet address is <span class="mono">${activeAddr}</span>. Switch wallets or choose a CA deployed by this wallet.`
      );
      return false;
    }

    return true;
  }

  async function onIssuePreview(st, cfg, energyLockedSet) {
    const p = gatherIssue();

    const activeNetworkId = activeWalletNetworkIdOrNull(st);
    if (!activeNetworkId) {
      setIssueMsg("Preview failed: Active wallet network is unavailable.");
      return;
    }

    try {
      await requireUnlockedKeyringOrThrow(activeNetworkId);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      const hint = msg === "keyfile_locked"
        ? "Unlock your wallet on the Wallet page, then return here."
        : msg;
      setIssueMsg("Preview failed: " + hint);
      return;
    }

    if (!(await validateIssue(p, st, cfg, energyLockedSet))) return;

    const actionLabel = p.mode === "burn" ? "Burn" : "Issue";
    UI.issueJsonPreview.textContent = buildIssueAction(p);
    UI.issuePreviewWrap.classList.remove("hidden");
    setIssueMsg(`${actionLabel} JSON preview ready.`, "muted");
  }

  async function onIssueSubmit(st, cfg, energyLockedSet) {
    const p = gatherIssue();
    if (!(await validateIssue(p, st, cfg, energyLockedSet))) return;

    const actionLabel = p.mode === "burn" ? "burn" : "issue";
    UI.issueJsonPreview.textContent = buildIssueAction(p);
    UI.issuePreviewWrap.classList.remove("hidden");

    setIssueMsg(`Preparing ${actionLabel} commit + reveal…`, "muted");
    UI.out.textContent = "";
    UI.outputWrap.classList.add("hidden");

    const activeNetworkId = activeWalletNetworkIdOrNull(st);
    if (!activeNetworkId) {
      setIssueMsg(`Preparing ${actionLabel} commit + reveal failed: Active wallet network is unavailable.`);
      return;
    }

    setBusy(true);
    try {
      const keyring = await requireUnlockedKeyringOrThrow(activeNetworkId);

      setIssueMsg("Building commit…", "muted");
      const build = await httpJson("POST", "/api/v1/krc20/issue/build-commit", { mode: p.mode, ca: p.ca, amt: p.amt, to: p.to });

      if (build && build.ok === true && build.stage === "bcw_krc20_issue_burn_intent") {
        const k = await kaspaReadyOrThrow();
        if (!keyring || !keyring.priv0) throw new Error("wallet_locked");
        if (typeof k.signMessage !== "function") throw new Error("signMessage_unavailable");

        const intent = build.intent && typeof build.intent === "object" ? build.intent : null;
        const intentMessage = String(build.intent_message || "").trim();
        if (!intent || !intentMessage) throw new Error("bcw_krc20_issue_burn_intent_invalid");

        const authSignature = k.signMessage({
          message: intentMessage,
          privateKey: keyring.priv0
        });

        setIssueMsg("Submitting broker-custody issue/burn intent…", "muted");
        const submitRes = await httpJson(
          "POST",
          "/api/v1/krc20/issue/submit-commit",
          {
            mode: p.mode,
            ca: p.ca,
            amt: p.amt,
            to: p.to,
            bcw_krc20_issue_burn_intent: intent,
            bcw_auth_signature: String(authSignature || "")
          }
        );

        if (!submitRes || submitRes.ok !== true) {
          const msg = (submitRes && (submitRes.error || submitRes.message || submitRes.reason)) || "BCW issue/burn submit failed";
          throw new Error(msg);
        }

        UI.out.textContent = JSON.stringify(submitRes, null, 2);
        UI.outputWrap.classList.remove("hidden");
        setIssueMsg((p.mode === "burn" ? "Burn" : "Issue") + " completed.", "muted");
        return;
      }

      if (!build || build.ok !== true || build.stage !== "krc_commit_build") {
        const msg = (build && (build.error || build.message || build.reason)) || "Commit build failed";
        throw new Error(msg);
      }

      const k = await kaspaReadyOrThrow();

      const networkId = String(build.networkId || "");
      const fromAddress = String(build.fromAddress || "");
      const feeRate = Number(build.feeRate || 0);
      const commitAmountSompi = BigInt(String(build.commitAmountSompi || "0"));
      const payloadJson = String(build.payloadJson || "");
      const revealPriorityFeeSompi = BigInt(String(build.revealPriorityFeeSompi || "0"));

      if (!networkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n || revealPriorityFeeSompi <= 0n) {
        throw new Error("krc_commit_build_invalid");
      }

      if (String(keyring.addr0 || "") !== fromAddress) {
        throw new Error("active_wallet_mismatch");
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

      const krc20CommitRedeemScriptHex = script.toString();

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

      setIssueMsg("Submitting commit…", "muted");
      const commitBody = { mode: p.mode, ca: p.ca, amt: p.amt, to: p.to, signed_txs: signedCommit };

      const commitRes = await httpJson("POST", "/api/v1/krc20/issue/submit-commit", commitBody);

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

      setIssueMsg("Waiting for commit UTXO…", "muted");
      const waitRes = await httpJson(
        "POST",
        "/api/v1/krc20/issue/wait-reveal",
        { mode: p.mode, ca: p.ca, amt: p.amt, to: p.to, p2shAddress, commitTxids }
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

      const revealEntriesSafe = Array.isArray(waitRes.entries) ? waitRes.entries : [];
      const revealEntries = revealEntriesSafe.map((e) => ({
        outpoint: e.outpoint,
        scriptPublicKey: e.scriptPublicKey,
        isCoinbase: !!e.isCoinbase,
        amount: BigInt(String(e.amount || "0")),
        blockDaaScore: BigInt(String(e.blockDaaScore || "0")),
      }));

      const wantedTxid = String(ce?.outpoint?.transactionId || "");
      const wantedIdx = Number(ce?.outpoint?.index ?? -1);

      const buildReveal = async (effectiveFeeRate) => {
        const args = {
          priorityEntries: [commitEntry],
          entries: revealEntries,
          changeAddress: fromAddress,
          outputs: [],
          feeRate: effectiveFeeRate,
          priorityFee: revealPriorityFeeSompi,
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

        const ins = tx.transaction && Array.isArray(tx.transaction.inputs) ? tx.transaction.inputs : [];
        for (let i = 1; i < ins.length; i++) {
          const sig = await tx.createInputSignature(i, keyring.priv0);
          tx.fillInput(i, sig);
        }
      };

      setIssueMsg("Building reveal…", "muted");
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

      setIssueMsg("Submitting reveal…", "muted");
      const revealRes = await httpJson(
        "POST",
        "/api/v1/krc20/issue/submit-reveal",
        { mode: p.mode, ca: p.ca, amt: p.amt, to: p.to, signed_txs: signedReveal }
      );

      UI.out.textContent = JSON.stringify(revealRes, null, 2);
      UI.outputWrap.classList.remove("hidden");
      setIssueMsg("Issue commit + reveal completed.", "muted");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      const hint = msg === "keyfile_locked"
        ? "Unlock your wallet on the Wallet page, then return here."
        : msg;
      setIssueMsg("Issue failed: " + hint);
      UI.out.textContent = e && e.payload ? JSON.stringify(e.payload, null, 2) : "";
      UI.outputWrap.classList.remove("hidden");
    } finally {
      setBusy(false);
    }
  }

  async function boot() {
    if (!UI.btnIssuePreview || !UI.btnIssue) {
      setIssueMsg("Issue UI is missing required elements.");
      return;
    }

    let st = null;
    try {
      st = await httpJson("GET", "/api/wallet/status");
    } catch {
      st = null;
    }

    if (!st || !st.ok) {
      setIssueMsg("No active wallet. Open the main CW page and create/select a wallet first.");
      return;
    }

    const net = String(st.network || "").trim();
    setIssueMsg(`Active wallet: <span class="mono">${st.wallet_id}</span> (${st.wallet_type}, ${net})`, "muted");

    const cfg = await loadWrappedConfig();

    try {
      const netId = activeWalletNetworkIdOrNull(st);
      if (!netId) throw new Error("active_wallet_network_missing");
      const activeAddr0 = String(st.address0 || "").trim();
      const energyTokens = await loadEnergyTokens();
      const energyLockedSet = new Set((Array.isArray(energyTokens) ? energyTokens : []).map((row) => String(row && row.ca ? row.ca : "").trim().toLowerCase()).filter(Boolean));
      const hiddenEnergyCount = energyLockedSet.size;
      const cas = computeIssuableCAs(cfg, netId, activeAddr0, energyLockedSet);

      let inventory = null;
      try {
        inventory = await loadBridgeInventory(netId);
      } catch (_) {
        inventory = null;
      }

      let walletHoldings = null;
      try {
        walletHoldings = await loadWalletHoldingsStrict();
      } catch (_) {
        walletHoldings = null;
      }

      renderIssuableTable(cas, inventory, walletHoldings, netId, activeAddr0, hiddenEnergyCount);

      syncIssueModeUi();

      const onModeChange = () => {
        syncIssueModeUi();
        if (UI.issuePreviewWrap) UI.issuePreviewWrap.classList.add("hidden");
        if (UI.outputWrap) UI.outputWrap.classList.add("hidden");
        if (UI.issueJsonPreview) UI.issueJsonPreview.textContent = "";
        if (UI.out) UI.out.textContent = "";
      };

      if (UI.issueModeIssue) {
        UI.issueModeIssue.addEventListener("change", onModeChange);
      }
      if (UI.issueModeBurn) {
        UI.issueModeBurn.addEventListener("change", onModeChange);
      }

      UI.btnIssue.disabled = false;
      UI.btnIssue.removeAttribute("aria-disabled");

      UI.btnIssuePreview.addEventListener("click", (ev) => {
        ev.preventDefault();
        onIssuePreview(st, cfg, energyLockedSet);
      });

      UI.btnIssue.addEventListener("click", (ev) => {
        ev.preventDefault();
        onIssueSubmit(st, cfg, energyLockedSet);
      });
    } catch (_) {
      syncIssueModeUi();

      const onModeChange = () => {
        syncIssueModeUi();
        if (UI.issuePreviewWrap) UI.issuePreviewWrap.classList.add("hidden");
        if (UI.outputWrap) UI.outputWrap.classList.add("hidden");
        if (UI.issueJsonPreview) UI.issueJsonPreview.textContent = "";
        if (UI.out) UI.out.textContent = "";
      };

      if (UI.issueModeIssue) {
        UI.issueModeIssue.addEventListener("change", onModeChange);
      }
      if (UI.issueModeBurn) {
        UI.issueModeBurn.addEventListener("change", onModeChange);
      }

      UI.btnIssue.disabled = false;
      UI.btnIssue.removeAttribute("aria-disabled");

      UI.btnIssuePreview.addEventListener("click", (ev) => {
        ev.preventDefault();
        onIssuePreview(st, cfg, new Set());
      });

      UI.btnIssue.addEventListener("click", (ev) => {
        ev.preventDefault();
        onIssueSubmit(st, cfg, new Set());
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    boot().catch(() => {});
  });
})();
