// Compliance Wallet — Energy UI (CW Energy v2)
// - Uses server-side Energy authority routes under /api/v1/energy/*
// - Keeps ledger/site/token authority on the server
// - Uses the staged issue flow through Energy prepare/finalize orchestration

import "/static/js/kaspa-bridge.mjs";

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  let _cfg = null;
  let _status = null;
  let _sites = [];
  let _tokens = [];
  let _selectedSiteId = "";
  let _selectedTokenKey = "";
  let _lastLedger = null;
  let _lastIssuePreview = null;

  function nowIso() { return new Date().toISOString(); }

  function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

  async function httpJson(method, url, body) {
    const headers = { accept: "application/json" };
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const raw = await r.text();
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!r.ok) {
      const msg = (parsed && (parsed.error || parsed.reason || parsed.message))
        ? String(parsed.error || parsed.reason || parsed.message)
        : raw;
      const e = new Error(msg || `HTTP ${r.status}`);
      e.status = r.status;
      e.payload = parsed;
      throw e;
    }
    return parsed !== null ? parsed : raw;
  }

  function getNetworkSharedOrThrow() {
    const shared = window.CwNetworkShared;
    if (
      !shared ||
      typeof shared.getNetworkMeta !== "function" ||
      typeof shared.normalizeAppNetworkKey !== "function"
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

  function activeNetId() {
    try {
      return String(getNetworkMetaOrThrow(_status?.network).appKey || "").trim();
    } catch (_) {
      return "";
    }
  }

  function parseYmd(ymd) {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(ymd || "").trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    return { y, mo, d };
  }

  function requireNonEmpty(label, raw) {
    const s = String(raw || "").trim();
    if (!s) throw new Error(`${label} is required`);
    return s;
  }

  function selectedSite() {
    return _sites.find((row) => String(row?.site_id || "") === String(_selectedSiteId || "")) || null;
  }

  function selectedToken() {
    return _tokens.find((row) => String(row?.token_key || "") === String(_selectedTokenKey || "")) || null;
  }

  function setStatus(kind, message) {
    const pill = $("energyStatusPill");
    const dot = $("energyStatusDot");
    const text = $("energyStatusText");
    if (text) text.textContent = String(message || "");

    if (!pill || !dot) return;

    pill.dataset.status = String(kind || "idle");
    if (kind === "ok") {
      dot.style.background = "#2ecc71";
    } else if (kind === "warn") {
      dot.style.background = "#f1c40f";
    } else if (kind === "error") {
      dot.style.background = "#e74c3c";
    } else {
      dot.style.background = "rgba(255,255,255,0.55)";
    }
  }

  function setBusy(isBusy) {
    const busy = !!isBusy;
    ["btnDownloadEnergy", "btnPreviewIssue", "btnIssueViaCW"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.disabled = busy;
      el.setAttribute("aria-busy", busy ? "true" : "false");
      el.style.opacity = busy ? "0.65" : "";
      el.style.pointerEvents = busy ? "none" : "";
    });
  }

  function formatWhAsKwh(raw) {
    const s = String(raw ?? "").trim();
    if (!/^\d+$/.test(s)) return "—";

    const whole = s.length > 3 ? s.slice(0, -3) : "0";
    const frac = s.slice(-3).padStart(3, "0").replace(/0+$/, "");

    return frac ? `${whole}.${frac}` : whole;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderIssuePreview(preview) {
    const emptyEl = $("issuePreviewEmpty");
    const bodyEl = $("issuePreviewBody");
    if (!emptyEl || !bodyEl) return;

    if (!preview || preview.ok !== true) {
      bodyEl.hidden = true;
      bodyEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent = "Preview Issue to review the selected site, token, amount, and resulting owed/issued changes before issuing through the active wallet.";
      return;
    }

    const siteName = String(preview?.site?.site_name || "—");
    const tokenName = String(preview?.token?.name || preview?.token?.tick || preview?.token?.ca || "—");
    const tokenCa = String(preview?.token?.ca || "—");
    const networkId = String(preview?.token?.network_id || preview?.issue_request?.network_id || "—");
    const issueWh = formatWhAsKwh(preview?.preview?.issue_wh);
    const owedBefore = formatWhAsKwh(preview?.preview?.owed_wh_before);
    const owedAfter = formatWhAsKwh(preview?.preview?.owed_wh_after);
    const issuedAfter =
      networkId === "mainnet"
        ? formatWhAsKwh(preview?.preview?.issued_mainnet_wh_after)
        : formatWhAsKwh(preview?.preview?.issued_testnet_wh_after);

    bodyEl.innerHTML = [
      '<div class="energy-summary-item"><strong>Site</strong><div class="mono muted">' + escapeHtml(siteName) + '</div></div>',
      '<div class="energy-summary-item"><strong>Token</strong><div class="mono muted">' + escapeHtml(tokenName) + '</div></div>',
      '<div class="energy-summary-item"><strong>Token CA</strong><div class="mono muted">' + escapeHtml(tokenCa) + '</div></div>',
      '<div class="energy-summary-item"><strong>Network</strong><div class="mono muted">' + escapeHtml(networkId) + '</div></div>',
      '<div class="energy-summary-item"><strong>Issue KWH</strong><div class="mono muted">' + escapeHtml(issueWh) + '</div></div>',
      '<div class="energy-summary-item"><strong>Owed Before</strong><div class="mono muted">' + escapeHtml(owedBefore) + '</div></div>',
      '<div class="energy-summary-item"><strong>Owed After</strong><div class="mono muted">' + escapeHtml(owedAfter) + '</div></div>',
      '<div class="energy-summary-item"><strong>Issued After</strong><div class="mono muted">' + escapeHtml(issuedAfter) + '</div></div>'
    ].join("");

    emptyEl.hidden = true;
    bodyEl.hidden = false;
  }

  function setLedgerCards(ledger) {
    _lastLedger = ledger || null;

    const claimedValue = $("claimedKwhValue");
    const claimedCard = claimedValue && typeof claimedValue.closest === "function"
      ? claimedValue.closest(".energy-ledger-card")
      : null;
    if (claimedCard) claimedCard.style.display = "none";

    const issuedRaw =
      ledger?.issued_wh ??
      (() => {
        const mainnet = String(ledger?.issued_mainnet_wh ?? "").trim();
        const testnet = String(ledger?.issued_testnet_wh ?? "").trim();
        if (!/^\d+$/.test(mainnet) || !/^\d+$/.test(testnet)) return "";
        return (BigInt(mainnet) + BigInt(testnet)).toString();
      })();

    $("owedKwhValue").textContent = formatWhAsKwh(ledger?.owed_wh);
    $("issuedKwhValue").textContent = formatWhAsKwh(issuedRaw);
  }

  function setSiteSummary(site, ledger) {
    $("siteNameValue").textContent = String(site?.site_name || "—");
    $("siteTimezoneValue").textContent = String(site?.site_timezone || "—");
    $("siteActivationStartValue").textContent = String(site?.activation_start_date || "—");
    $("siteLastDownloadedValue").textContent = String(ledger?.last_downloaded_through_ymd || "—");
  }

  function resetPageState(message) {
    _lastLedger = null;
    clearIssuePreview();
    setLedgerCards(null);
    setSiteSummary(null, null);
    setStatus("idle", message || "Select a site to begin.");
  }

  function passwordDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.right = "0";
      overlay.style.bottom = "0";
      overlay.style.background = "rgba(0,0,0,0.4)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "9999";

      const card = document.createElement("div");
      card.style.background = "white";
      card.style.borderRadius = "12px";
      card.style.padding = "16px";
      card.style.width = "min(420px, calc(100vw - 40px))";
      card.style.boxShadow = "0 12px 36px rgba(0,0,0,0.25)";

      const title = document.createElement("div");
      title.textContent = "Wallet Password";
      title.style.fontWeight = "700";
      title.style.marginBottom = "8px";

      const hint = document.createElement("div");
      hint.textContent = "Enter the password used when this wallet was created. Leave blank only if the wallet was created with an empty password.";
      hint.style.fontSize = "12px";
      hint.style.color = "#555";
      hint.style.marginBottom = "10px";

      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "current-password";
      input.placeholder = "Password";
      input.style.width = "100%";
      input.style.padding = "10px 12px";
      input.style.border = "1px solid #ddd";
      input.style.borderRadius = "10px";
      input.style.marginBottom = "12px";

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "flex-end";
      row.style.gap = "8px";

      const btnCancel = document.createElement("button");
      btnCancel.textContent = "Cancel";
      btnCancel.className = "secondary";
      btnCancel.type = "button";

      const btnOk = document.createElement("button");
      btnOk.textContent = "Continue";
      btnOk.type = "button";

      const close = (value) => {
        try { document.body.removeChild(overlay); } catch (_) {}
        resolve(value);
      };

      btnCancel.addEventListener("click", () => close(null));
      btnOk.addEventListener("click", () => close(String(input.value || "")));

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") btnOk.click();
        if (e.key === "Escape") btnCancel.click();
      });

      row.appendChild(btnCancel);
      row.appendChild(btnOk);

      card.appendChild(title);
      card.appendChild(hint);
      card.appendChild(input);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      setTimeout(() => input.focus(), 0);
    });
  }

  async function kaspaReadyOrThrow() {
    const p = window.kaspaReady;
    if (p && typeof p.then === "function") await p;
    const k = window.kaspa;
    if (!k) throw new Error("Kaspa WASM not loaded");
    return k;
  }

  function toAddrNetworkFromNetworkId(networkId) {
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

  async function runStagedEnergyIssueViaCw(preview) {
    const issueReq = preview && preview.issue_request && typeof preview.issue_request === "object"
      ? preview.issue_request
      : null;
    if (!issueReq) throw new Error("energy_issue_preview_missing");

    const networkSeed = String(issueReq.network_id || activeNetId()).trim();
    if (!networkSeed) throw new Error("active_wallet_network_missing");

    const networkId = String(getNetworkMetaOrThrow(networkSeed).appKey || "").trim();
    const activeNetworkId = networkId;
    const siteId = String(issueReq.energy_site_id || "").trim();
    const ca = String(issueReq.ca || "").trim().toLowerCase();
    const amt = String(issueReq.amt || "").trim();
    const to = String(issueReq.to || "").trim();

    if (!siteId) throw new Error("invalid_site_id");
    if (!ca) throw new Error("invalid_ca");
    if (!/^\d+$/.test(amt)) throw new Error("invalid_amount_raw");
    if (!to) throw new Error("to_invalid");

    const keyring = await requireUnlockedKeyringOrThrow(activeNetworkId);

    setStatus("warn", "Building issue commit…");
    const build = await httpJson("POST", "/api/v1/krc20/issue/build-commit", {
      ca,
      amt,
      to,
      energy_site_id: siteId
    });

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

      setStatus("warn", "Submitting broker-custody Energy issue intent…");
      const submitRes = await httpJson("POST", "/api/v1/krc20/issue/submit-commit", {
        mode: "issue",
        ca,
        amt,
        to,
        energy_site_id: siteId,
        bcw_krc20_issue_burn_intent: intent,
        bcw_auth_signature: String(authSignature || "")
      });

      if (!submitRes || submitRes.ok !== true) {
        const msg = (submitRes && (submitRes.error || submitRes.message || submitRes.reason)) || "BCW Energy issue submit failed";
        throw new Error(msg);
      }

      const commitTxids = Array.isArray(submitRes.commitTxids)
        ? submitRes.commitTxids.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      const revealTxids = Array.isArray(submitRes.revealTxids)
        ? submitRes.revealTxids.map((s) => String(s || "").trim()).filter(Boolean)
        : [];
      const revealTxid = revealTxids.length ? revealTxids[0] : String(submitRes.txid || "").trim();
      if (!revealTxid) throw new Error("reveal_txid_missing");

      setStatus("warn", "Refreshing Energy ledger…");
      return await httpJson("POST", "/api/v1/energy/issue/finalize-refresh", {
        site_id: siteId,
        ca,
        amount_raw: amt,
        commit_txid: commitTxids[0] || "",
        reveal_txid: revealTxid
      });
    }

    if (!build || build.ok !== true || build.stage !== "krc_commit_build") {
      const msg = (build && (build.error || build.message || build.reason)) || "Commit build failed";
      throw new Error(msg);
    }

    const k = await kaspaReadyOrThrow();

    const buildNetworkId = String(build.networkId || "");
    const fromAddress = String(build.fromAddress || "");
    const feeRate = Number(build.feeRate || 0);
    const commitAmountSompi = BigInt(String(build.commitAmountSompi || "0"));
    const payloadJson = String(build.payloadJson || "");
    const revealPriorityFeeSompi = BigInt(String(build.revealPriorityFeeSompi || "0"));

    if (!buildNetworkId || !fromAddress || !payloadJson || commitAmountSompi <= 0n || revealPriorityFeeSompi <= 0n) {
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
      blockDaaScore: BigInt(String(e.blockDaaScore || "0"))
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

    const p2shAddrObj = k.addressFromScriptPublicKey(script.createPayToScriptHashScript(), buildNetworkId);
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
      networkId: buildNetworkId
    };

    const commitCreated = await k.createTransactions(txOpts);

    const signedCommit = [];
    for (const ptx of commitCreated.transactions) {
      ptx.sign([keyring.priv0], true);
      signedCommit.push(ptx.serializeToSafeJSON());
    }

    setStatus("warn", "Submitting issue commit…");
    const commitBody = {
      ca,
      amt,
      to,
      energy_site_id: siteId,
      signed_txs: signedCommit
    };

    const commitRes = await httpJson("POST", "/api/v1/krc20/issue/submit-commit", commitBody);

    if (!commitRes || commitRes.ok !== true) {
      const msg = (commitRes && (commitRes.error || commitRes.message || commitRes.reason)) || "Commit submit failed";
      throw new Error(msg);
    }

    const commitTxids = Array.isArray(commitRes.commitTxids)
      ? commitRes.commitTxids.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    if (commitTxids.length === 0) throw new Error("commit_txids_missing");

    setStatus("warn", "Waiting for issue reveal…");
    const waitRes = await httpJson("POST", "/api/v1/krc20/issue/wait-reveal", {
      ca,
      amt,
      to,
      energy_site_id: siteId,
      p2shAddress,
      commitTxids
    });

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
      blockDaaScore: BigInt(String(ce.blockDaaScore || "0"))
    };

    const revealEntriesSafe = Array.isArray(waitRes.entries) ? waitRes.entries : [];
    const revealEntries = revealEntriesSafe.map((e) => ({
      outpoint: e.outpoint,
      scriptPublicKey: e.scriptPublicKey,
      isCoinbase: !!e.isCoinbase,
      amount: BigInt(String(e.amount || "0")),
      blockDaaScore: BigInt(String(e.blockDaaScore || "0"))
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
        networkId: buildNetworkId
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

    setStatus("warn", "Building issue reveal…");
    const tx0 = await buildReveal(feeRate);
    await fillRevealInput0OrThrow(tx0);

    const requiredFee0 = k.calculateTransactionFee(buildNetworkId, tx0.transaction);
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

      const requiredFee1 = k.calculateTransactionFee(buildNetworkId, tx1.transaction);
      if (requiredFee1 === undefined) throw new Error("reveal_tx_mass_exceeds_standard");
      if (tx1.feeAmount < requiredFee1) throw new Error("reveal_fee_under_minimum");

      revealTx = tx1;
    }

    const signedReveal = [revealTx.serializeToSafeJSON()];

    setStatus("warn", "Submitting issue reveal…");
    const revealRes = await httpJson("POST", "/api/v1/krc20/issue/submit-reveal", {
      ca,
      amt,
      to,
      energy_site_id: siteId,
      signed_txs: signedReveal
    });

    if (!revealRes || revealRes.ok !== true || revealRes.stage !== "krc_reveal_submit") {
      const msg = (revealRes && (revealRes.error || revealRes.message || revealRes.reason)) || "Reveal submit failed";
      throw new Error(msg);
    }

    const revealTxids = Array.isArray(revealRes.revealTxids)
      ? revealRes.revealTxids.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    const revealTxid = revealTxids.length ? revealTxids[0] : "";
    if (!revealTxid) throw new Error("reveal_txid_missing");

    setStatus("warn", "Refreshing Energy ledger…");
    return await httpJson("POST", "/api/v1/energy/issue/finalize-refresh", {
      site_id: siteId,
      ca,
      amount_raw: amt,
      commit_txid: commitTxids[0] || "",
      reveal_txid: revealTxid
    });
  }

  function tokenKeyFor(row) {
    const networkSeed = String(row?.network_id || activeNetId()).trim();
    const networkId = networkSeed
      ? String(getNetworkMetaOrThrow(networkSeed).appKey || "").trim()
      : "";
    const ca = String(row?.ca || "").trim().toLowerCase();
    return `${networkId}:${ca}`;
  }

  function normalizeSites(items) {
    return (Array.isArray(items) ? items : [])
      .filter((row) => row && row.is_active !== false)
      .map((row) => ({
        ...row,
        site_id: String(row.site_id || "").trim()
      }));
  }

  function normalizeTokens(items) {
    return (Array.isArray(items) ? items : [])
      .map((row) => {
        const ca = String(row?.ca || "").trim().toLowerCase();
        const networkSeed = String(row?.network_id || activeNetId()).trim();
        const network_id = networkSeed
          ? String(getNetworkMetaOrThrow(networkSeed).appKey || "").trim()
          : "";
        const token_key = `${network_id}:${ca}`;
        return {
          ...row,
          ca,
          network_id,
          token_key
        };
      })
      .filter((row) => row.ca);
  }

  function formatTokenLabel(row) {
    const left = String(row?.name || row?.tick || row?.ca || "").trim();
    const right = String(row?.tick || row?.ca || "").trim();
    return left && right && left !== right ? `${left} — ${right}` : (left || right || "Unknown token");
  }

  function amountRawFromLedger() {
    const raw = String(_lastLedger?.owed_wh || "").trim();
    if (!/^\d+$/.test(raw)) throw new Error("Ledger owed amount is not available yet.");
    if (raw === "0") throw new Error("No owed KWH is currently available for issuance.");
    return raw;
  }

  function applySiteLedgerPayload(payload) {
    const site = payload && payload.site ? payload.site : selectedSite();
    const ledger = payload && payload.ledger ? payload.ledger : _lastLedger;
    setLedgerCards(ledger || null);
    setSiteSummary(site || null, ledger || null);
  }

  function clearIssuePreview() {
    _lastIssuePreview = null;
    renderIssuePreview(null);
  }

  function rememberIssuePreviewContext(siteId, tokenKey, preview) {
    _lastIssuePreview = preview && typeof preview === "object"
      ? {
          ...preview,
          _energySiteId: String(siteId || ""),
          _energyTokenKey: String(tokenKey || "")
        }
      : null;

    renderIssuePreview(_lastIssuePreview);
  }

  function issuePreviewMatchesSelection() {
    return Boolean(
      _lastIssuePreview &&
      _lastIssuePreview.ok === true &&
      String(_lastIssuePreview._energySiteId || "") === String(_selectedSiteId || "") &&
      String(_lastIssuePreview._energyTokenKey || "") === String(_selectedTokenKey || "")
    );
  }

  function reasonMessage(reason, fallback) {
    const map = {
      auth_required: "Please sign in again.",
      no_active_wallet: "Create or select an active wallet first.",
      invalid_site_id: "Select a valid site first.",
      invalid_sid: "Site ID is required.",
      invalid_site_name: "Site Name is required.",
      invalid_activation_start_date: "Activation Start Date must be a valid YYYY-MM-DD date.",
      hoymiles_site_timezone_missing: "Hoymiles did not return a site timezone for that Site ID.",
      energy_site_not_found: "The selected site was not found.",
      energy_site_sid_already_exists: "That Site ID already exists on the server.",
      invalid_ca: "Select a valid Energy token first.",
      energy_token_not_locked: "That CA is not currently locked as an Energy token.",
      energy_token_not_issuable_by_active_wallet: "The active wallet is not allowed to issue that Energy token.",
      energy_issue_amount_exceeds_owed: "The requested Energy issue amount is greater than the currently owed KWH.",
      energy_issue_preview_missing: "Preview Issue must be run again before Issue via CW can continue.",
      energy_issue_preview_network_mismatch: "The saved Energy preview no longer matches the active wallet network.",
      energy_issue_preview_ca_mismatch: "The saved Energy preview no longer matches the selected Energy token.",
      energy_issue_preview_amount_mismatch: "The saved Energy preview no longer matches the current owed amount.",
      energy_issue_reveal_txid_required: "The Energy issue finalize step requires a reveal transaction id.",
      keyfile_locked: "Unlock your wallet on the Wallet page, then return here.",
      active_wallet_mismatch: "The unlocked wallet does not match the currently active wallet.",
      reveal_txid_missing: "Issue reveal did not return a reveal transaction id."
    };
    return map[String(reason || "").trim()] || String(fallback || reason || "Energy request failed.");
  }

  function openAddSiteDialog() {
    const dlg = $("addSiteDialog");
    if (!dlg) return;

    $("siteSidInput").value = "";
    $("siteNameInput").value = "";
    $("siteActivationStartInput").value = "";

    if (typeof dlg.showModal === "function") {
      dlg.showModal();
    } else {
      dlg.setAttribute("open", "open");
    }
  }

  function closeAddSiteDialog() {
    const dlg = $("addSiteDialog");
    if (!dlg) return;
    if (typeof dlg.close === "function") {
      dlg.close();
    } else {
      dlg.removeAttribute("open");
    }
  }

  function siteDraftFromDialog() {
    const sid = requireNonEmpty("Site ID (sid)", $("siteSidInput").value);
    const site_name = requireNonEmpty("Site Name", $("siteNameInput").value);
    const activation_start_date = requireNonEmpty("Activation Start Date", $("siteActivationStartInput").value);

    if (!parseYmd(activation_start_date)) {
      throw new Error("Activation Start Date must be YYYY-MM-DD.");
    }

    return { sid, site_name, activation_start_date };
  }

  function syncSiteSelection() {
    if (_selectedSiteId && _sites.some((row) => row.site_id === _selectedSiteId)) {
      $("siteSelect").value = _selectedSiteId;
      return;
    }
    _selectedSiteId = _sites.length ? String(_sites[0].site_id || "") : "";
    $("siteSelect").value = _selectedSiteId;
  }

  function syncTokenSelection() {
    if (_selectedTokenKey && _tokens.some((row) => row.token_key === _selectedTokenKey)) {
      $("energyTokenSelect").value = _selectedTokenKey;
      return;
    }
    _selectedTokenKey = _tokens.length ? String(_tokens[0].token_key || "") : "";
    $("energyTokenSelect").value = _selectedTokenKey;
  }

  function renderSiteOptions() {
    const sel = $("siteSelect");
    if (!sel) return;

    const opts = ['<option value="">Select a site…</option>'];
    for (const row of _sites) {
      const siteId = String(row.site_id || "");
      const siteName = String(row.site_name || row.sid || siteId);
      const sid = String(row.sid || "");
      const label = sid ? `${siteName} (${sid})` : siteName;
      opts.push(`<option value="${siteId}">${label}</option>`);
    }
    sel.innerHTML = opts.join("");
    syncSiteSelection();
  }

  function renderTokenOptions() {
    const sel = $("energyTokenSelect");
    if (!sel) return;

    const opts = ['<option value="">Select an energy token…</option>'];
    for (const row of _tokens) {
      opts.push(`<option value="${row.token_key}">${formatTokenLabel(row)}</option>`);
    }
    sel.innerHTML = opts.join("");
    syncTokenSelection();
  }

  async function refreshSites() {
    const res = await httpJson("GET", "/api/v1/energy/sites");
    _sites = normalizeSites(res?.sites);
    renderSiteOptions();
    return res;
  }

  async function refreshTokens() {
    const res = await httpJson("GET", "/api/v1/energy/tokens");
    _tokens = normalizeTokens(res?.tokens);
    clearIssuePreview();
    renderTokenOptions();
    return res;
  }

  async function refreshSelectedLedger() {
    const site = selectedSite();
    if (!site) {
      clearIssuePreview();
      resetPageState("Select a site to begin.");
      return;
    }

    clearIssuePreview();
    const res = await httpJson("GET", `/api/v1/energy/ledger?site_id=${encodeURIComponent(site.site_id)}`);
    applySiteLedgerPayload(res);
    setStatus("ok", "Site ledger loaded.");
  }

  async function handleSaveSite() {
    const draft = siteDraftFromDialog();
    const res = await httpJson("POST", "/api/v1/energy/sites/add", draft);
    closeAddSiteDialog();
    await refreshSites();
    _selectedSiteId = String(res?.site?.site_id || _selectedSiteId || "");
    clearIssuePreview();
    renderSiteOptions();
    applySiteLedgerPayload(res);
    setStatus("ok", "Site saved.");
  }

  async function handleRemoveSite() {
    const site = selectedSite();
    if (!site) throw new Error("Select a site first.");

    await httpJson("POST", "/api/v1/energy/sites/remove", { site_id: site.site_id });
    await refreshSites();
    if (_selectedSiteId === String(site.site_id || "")) {
      _selectedSiteId = _sites.length ? String(_sites[0].site_id || "") : "";
    }
    clearIssuePreview();
    renderSiteOptions();

    if (_selectedSiteId) {
      await refreshSelectedLedger();
      setStatus("ok", "Site removed.");
      return;
    }

    resetPageState("No active Energy sites yet. Add a site to begin.");
    setStatus("warn", "Site removed.");
  }

  async function handleDownloadEnergy() {
    const site = selectedSite();
    if (!site) throw new Error("Select a site first.");

    const res = await httpJson("POST", "/api/v1/energy/download", { site_id: site.site_id });
    applySiteLedgerPayload(res);
    setStatus("ok", "Energy download complete.");
  }

  async function handlePreviewIssue() {
    const site = selectedSite();
    const token = selectedToken();
    if (!site) throw new Error("Select a site first.");
    if (!token) throw new Error("Select a locked Energy token first.");

    const amount_raw = amountRawFromLedger();
    const res = await httpJson("POST", "/api/v1/energy/issue/prepare", {
      site_id: site.site_id,
      ca: token.ca,
      amount_raw
    });

    rememberIssuePreviewContext(site.site_id, token.token_key, res);
    applySiteLedgerPayload(res);
    setStatus("ok", "Energy issue preview is ready.");
  }

  async function handleIssueViaCW() {
    const site = selectedSite();
    if (!site) throw new Error("Select a site first.");
    if (!issuePreviewMatchesSelection()) {
      throw new Error("Preview Issue must be rerun for the currently selected site and token before Issue via CW can continue.");
    }

    setBusy(true);
    try {
      const res = await runStagedEnergyIssueViaCw(_lastIssuePreview);
      clearIssuePreview();
      applySiteLedgerPayload(res);
      setStatus("ok", "Energy issue completed and ledger refreshed.");
    } finally {
      setBusy(false);
    }
  }

  function handleEnergyError(err, fallbackMessage) {
    const payload = err && err.payload && typeof err.payload === "object" ? err.payload : null;
    if (payload) applySiteLedgerPayload(payload);

    const reason = payload && payload.reason ? String(payload.reason) : "";
    const message = reasonMessage(reason, err?.message || fallbackMessage);
    setStatus(err?.status === 501 ? "warn" : "error", message);
  }

  async function init() {
    $("btnAddSite").addEventListener("click", openAddSiteDialog);
    $("btnCancelAddSite").addEventListener("click", closeAddSiteDialog);
    $("btnSaveSite").addEventListener("click", () => handleSaveSite().catch((e) => handleEnergyError(e, "Failed to save site.")));

    $("siteSelect").addEventListener("change", () => {
      _selectedSiteId = String($("siteSelect").value || "").trim();
      refreshSelectedLedger().catch((e) => handleEnergyError(e, "Failed to load site ledger."));
    });

    $("energyTokenSelect").addEventListener("change", () => {
      _selectedTokenKey = String($("energyTokenSelect").value || "").trim();
      clearIssuePreview();
      const token = selectedToken();
      setStatus("idle", token ? `Selected Energy token: ${formatTokenLabel(token)}.` : "Select a locked Energy token.");
    });

    $("btnRemoveSite").addEventListener("click", () => handleRemoveSite().catch((e) => handleEnergyError(e, "Failed to remove site.")));
    $("btnDownloadEnergy").addEventListener("click", () => handleDownloadEnergy().catch((e) => handleEnergyError(e, "Failed to download Energy history.")));
    $("btnPreviewIssue").addEventListener("click", () => handlePreviewIssue().catch((e) => handleEnergyError(e, "Failed to preview Energy issue.")));
    $("btnIssueViaCW").addEventListener("click", () => handleIssueViaCW().catch((e) => handleEnergyError(e, "Failed to finalize Energy issue.")));

    _status = await httpJson("GET", "/api/wallet/status");
    if (!_status || _status.ok !== true) {
      setStatus("error", "Create or select an active wallet first.");
      return;
    }

    await refreshSites();
    await refreshTokens();

    if (_selectedSiteId) {
      await refreshSelectedLedger();
      return;
    }

    resetPageState("No active Energy sites yet. Add a site to begin.");
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => handleEnergyError(e, "Energy page failed to initialize."));
  });
})();
