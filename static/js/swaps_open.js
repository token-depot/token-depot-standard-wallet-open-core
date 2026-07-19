(function () {
  var mount = null;

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });

    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_err) {
      data = { ok: false, reason: "invalid_json_response", raw: text };
    }

    if (!res.ok && data && typeof data === "object" && data.ok === undefined) {
      data.ok = false;
    }
    return data;
  }

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  function setState(state) {
    if (!mount) return;
    mount.setAttribute("data-open-swap-v2", state);
  }

  function getKaspaOrThrow() {
    var kaspa = window.kaspa;
    if (!kaspa || typeof kaspa !== "object") {
      throw new Error("kaspa_sdk_unavailable");
    }
    return kaspa;
  }

  function getUnlockedPriv0OrThrow() {
    var KEYRING_SESSION_KEY = "cw_keyring_session";
    var ksTxt = "";
    try { ksTxt = sessionStorage.getItem(KEYRING_SESSION_KEY) || ""; } catch (_) { ksTxt = ""; }

    var keyring = null;
    try { keyring = ksTxt ? JSON.parse(ksTxt) : null; } catch (_) { keyring = null; }

    var priv0Hex = keyring && typeof keyring.priv0_hex === "string" ? String(keyring.priv0_hex).trim() : "";
    if (!priv0Hex) {
      throw new Error("missing_keyring_session");
    }

    var kaspa = getKaspaOrThrow();
    return new kaspa.PrivateKey(priv0Hex);
  }

  function buildOpenSwapRequest(body) {
    return body && typeof body === "object" ? body : {};
  }

  async function analyze(body) {
    var req = buildOpenSwapRequest(body);
    setState("analyze_pending");
    var out = await postJSON("/api/open-swaps/analyze", req);
    if (mount) mount.__openSwapV2LastAnalyze = out;
    setState(out && out.ok ? "analyze_ok" : "analyze_error");
    emit("open-swap-v2:analyze-result", out);
    return out;
  }

  async function signOpenSwapCommit(prep, priv0) {
    var kaspa = getKaspaOrThrow();
    var unsignedCommit = Array.isArray(prep && prep.unsignedCommit) ? prep.unsignedCommit : null;
    if (!unsignedCommit || !unsignedCommit.length) {
      throw new Error("open_swap_prepare_invalid");
    }

    var commitInputSigs = [];
    for (var ti = 0; ti < unsignedCommit.length; ti++) {
      var item = unsignedCommit[ti] || null;
      var txStr = item && typeof item.tx === "string" ? item.tx : "";
      var inputCount = item && typeof item.inputCount === "number" ? item.inputCount : 0;
      if (!txStr || inputCount < 1) {
        throw new Error("open_swap_prepare_invalid_tx");
      }

      var tx = kaspa.Transaction.deserializeFromSafeJSON(txStr);
      var sigs = [];
      for (var i = 0; i < inputCount; i++) {
        var sigScriptHex = kaspa.createInputSignature(tx, i, priv0, null);
        sigs.push(sigScriptHex);
      }
      commitInputSigs.push(sigs);
    }

    return commitInputSigs;
  }

  async function signOpenSwapReveal(committed, priv0) {
    var kaspa = getKaspaOrThrow();
    var txToSignSafeJson = committed && typeof committed.txToSignSafeJson === "string" ? committed.txToSignSafeJson : "";
    if (!txToSignSafeJson) {
      throw new Error("open_swap_commit_invalid");
    }

    var txToSign = kaspa.Transaction.deserializeFromSafeJSON(txToSignSafeJson);
    return kaspa.createInputSignature(txToSign, 0, priv0, kaspa.SighashType.SingleAnyOneCanPay);
  }

  async function signOpenSwapSend(sendPrepared, priv0) {
    var kaspa = getKaspaOrThrow();
    var sendTxToSignSafeJson = sendPrepared && typeof sendPrepared.sendTxToSignSafeJson === "string" ? sendPrepared.sendTxToSignSafeJson : "";
    if (!sendTxToSignSafeJson) {
      throw new Error("open_swap_send_prepare_invalid");
    }

    var sendTxToSign = kaspa.Transaction.deserializeFromSafeJSON(sendTxToSignSafeJson);
    return kaspa.createInputSignature(sendTxToSign, 0, priv0, kaspa.SighashType.SingleAnyOneCanPay);
  }

  async function signBcwOpenSwapMakerIntent(prep, priv0) {
    var kaspa = getKaspaOrThrow();
    var intent = prep && prep.bcw_open_swap_maker_intent && typeof prep.bcw_open_swap_maker_intent === "object"
      ? prep.bcw_open_swap_maker_intent
      : null;
    var intentMessage = prep && typeof prep.intent_message === "string" ? prep.intent_message.trim() : "";
    if (!intent) {
      throw new Error("bcw_open_swap_maker_intent_missing");
    }
    if (!intentMessage) {
      throw new Error("bcw_open_swap_maker_intent_message_missing");
    }
    if (typeof kaspa.signMessage !== "function") {
      throw new Error("signMessage_unavailable");
    }

    return kaspa.signMessage({
      message: intentMessage,
      privateKey: priv0
    });
  }

  async function prepare(body) {
    var req = buildOpenSwapRequest(body);
    var out = null;

    try {
      var priv0 = getUnlockedPriv0OrThrow();

      setState("prepare_pending");
      var prepReq = Object.assign({}, req, { stage: "prepare" });
      var prep = await postJSON("/api/open-swaps/offer", prepReq);
      if (!prep || prep.ok === false) {
        out = prep;
        if (mount) mount.__openSwapV2LastPrepare = out;
        setState("prepare_error");
        emit("open-swap-v2:prepare-result", out);
        return out;
      }

      if (String(prep.stage || "") === "bcw_open_swap_maker_intent") {
        setState("bcw_maker_sign_pending");
        var bcwAuthSignature = await signBcwOpenSwapMakerIntent(prep, priv0);

        setState("bcw_maker_submit_pending");
        var bcwMakerReq = Object.assign({}, req, {
          stage: "bcw_maker_submit",
          bcw_open_swap_maker_intent: prep.bcw_open_swap_maker_intent,
          bcw_auth_signature: String(bcwAuthSignature || ""),
          intent_message: String(prep.intent_message || "")
        });
        out = await postJSON("/api/open-swaps/offer", bcwMakerReq);
        if (mount) mount.__openSwapV2LastPrepare = out;
        setState(out && out.ok ? "prepare_ok" : "prepare_error");
        emit("open-swap-v2:prepare-result", out);
        return out;
      }

      var offerRid = prep && typeof prep.offerRid === "string" ? prep.offerRid : "";
      if (!offerRid) {
        throw new Error("open_swap_prepare_missing_offerRid");
      }

      setState("commit_sign_pending");
      var commitInputSigs = await signOpenSwapCommit(prep, priv0);

      setState("commit_submit_pending");
      var commitReq = Object.assign({}, req, {
        stage: "commit_submit",
        offerRid: offerRid,
        commitInputSigs: commitInputSigs
      });
      var committed = await postJSON("/api/open-swaps/offer", commitReq);
      if (!committed || committed.ok === false) {
        out = committed;
        if (mount) mount.__openSwapV2LastPrepare = out;
        setState("prepare_error");
        emit("open-swap-v2:prepare-result", out);
        return out;
      }

      setState("reveal_sign_pending");
      var signature0 = await signOpenSwapReveal(committed, priv0);

      setState("reveal_submit_pending");
      var revealReq = Object.assign({}, req, {
        stage: "reveal_submit",
        offerRid: offerRid,
        signature0: signature0
      });
      var sendPrepared = await postJSON("/api/open-swaps/offer", revealReq);
      if (!sendPrepared || sendPrepared.ok === false) {
        out = sendPrepared;
        if (mount) mount.__openSwapV2LastPrepare = out;
        setState("prepare_error");
        emit("open-swap-v2:prepare-result", out);
        return out;
      }

      var sendOfferRid = sendPrepared && typeof sendPrepared.offerRid === "string" ? sendPrepared.offerRid : "";
      if (!sendOfferRid) {
        throw new Error("open_swap_send_prepare_missing_offerRid");
      }
      if (String(sendPrepared.stage || "") !== "send_prepare") {
        throw new Error("open_swap_send_prepare_invalid");
      }

      setState("send_sign_pending");
      var sendSignature0 = await signOpenSwapSend(sendPrepared, priv0);

      setState("send_submit_pending");
      var sendReq = Object.assign({}, req, {
        stage: "send_submit",
        offerRid: sendOfferRid,
        sendSignature0: sendSignature0
      });
      out = await postJSON("/api/open-swaps/offer", sendReq);
      if (mount) mount.__openSwapV2LastPrepare = out;
      setState(out && out.ok ? "prepare_ok" : "prepare_error");
      emit("open-swap-v2:prepare-result", out);
      return out;
    } catch (err) {
      out = {
        ok: false,
        reason: err && err.message ? String(err.message) : "open_swap_prepare_failed"
      };
      if (mount) mount.__openSwapV2LastPrepare = out;
      setState("prepare_error");
      emit("open-swap-v2:prepare-result", out);
      return out;
    }
  }

  function getLastAnalyze() {
    return mount ? mount.__openSwapV2LastAnalyze || null : null;
  }

  function getLastPrepare() {
    return mount ? mount.__openSwapV2LastPrepare || null : null;
  }

  function bindEvents() {
    document.addEventListener("open-swap-v2:analyze", function (ev) {
      var detail = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
      void analyze(detail);
    });

    document.addEventListener("open-swap-v2:prepare", function (ev) {
      var detail = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
      void prepare(detail);
    });
  }

  function init() {
    mount = document.getElementById("openSwapV2WalletMount");
    if (!mount) return;

    setState("ready");
    bindEvents();

    window.openSwapV2 = {
      analyze: analyze,
      prepare: prepare,
      getLastAnalyze: getLastAnalyze,
      getLastPrepare: getLastPrepare
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
