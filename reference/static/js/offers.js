// edge_gateway/src/dashboard/static/js/offers.js
(function () {
  function $(id) { return document.getElementById(id); }

  function fmtNum(x) {
    if (x === null || x === undefined) return '—';
    var n = Number(x);
    if (!isFinite(n)) return String(x);
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  function fmtAssetLabel(asset) {
    var sym = asset && (asset.symbol || asset.ticker || asset.assetId) || '?';
    var name = asset && typeof asset.name === 'string' ? asset.name.trim() : '';
    if (name && /^CA:/i.test(String(sym))) return name + ' ' + sym;
    return sym;
  }

  function fmtCompactAssetLabel(asset, fallback) {
    var sym = asset && (asset.symbol || asset.ticker || asset.assetId) || '';
    var name = asset && typeof asset.name === 'string' ? asset.name.trim() : '';
    var normalizedCa = normalizeDirectCa(sym);
    var symbolLooksCa = /^[0-9a-f]{64}$/i.test(normalizedCa);
    if (name) return name;
    if (sym && !symbolLooksCa && !/^CA:/i.test(String(sym))) return String(sym);
    return fallback || 'CA token';
  }

  function fmtAmount(amount, asset) {
    var a = (amount != null && amount !== '') ? String(amount) : '?';
    return a + ' ' + fmtAssetLabel(asset);
  }

  function fmtPrice(offer) {
    var sell = offer.sell || {};
    var buy  = offer.buy  || {};
    var sellSym = fmtAssetLabel(sell);
    var buySym  = fmtAssetLabel(buy);
    var p = offer.price != null ? String(offer.price) : '';
    if (!p) return 'Price: (n/a)';
    return 'Price: ' + p + ' ' + buySym + ' per 1 ' + sellSym;
  }

  function fmtState(state) {
    if (!state) return 'open';
    return state;
  }

  function fmtTtl(ttl) {
    if (!ttl || typeof ttl !== 'number') return '';
    var hours = Math.round(ttl / 3600);
    if (hours <= 0) return '';
    return hours + 'h TTL';
  }

  var directSponsoredCatalog = [];
  var DIRECT_HIDE_MY_LIVE_OFFERS_KEY = 'td_hide_my_direct_swap_offers_v1';
  var directMineOpenOfferIds = Object.create(null);
  var directMineActiveWalletId = '';
  var expiredOpenSwapBatchPromptShown = false;
  var expiredOpenSwapBatchRunning = false;
  var expiredKcc20AtomicBatchPromptShown = false;
  var expiredKcc20AtomicBatchRunning = false;
  var expiredKcc20AtomicOpenBatchPromptShown = false;
  var expiredKcc20AtomicOpenBatchRunning = false;

  function readDirectHideMyLiveOffers() {
    try { return localStorage.getItem(DIRECT_HIDE_MY_LIVE_OFFERS_KEY) === '1'; } catch (_) { return false; }
  }

  function writeDirectHideMyLiveOffers(value) {
    try { localStorage.setItem(DIRECT_HIDE_MY_LIVE_OFFERS_KEY, value ? '1' : '0'); } catch (_) {}
  }

  function buildOfferIdMap(items) {
    var map = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (item) {
      var offerId = normalizeDirectText(item && item.offerId);
      if (offerId) map[offerId] = true;
    });
    return map;
  }

  function isDirectMineOffer(offer) {
    if (!offer || typeof offer !== 'object') return false;
    var offerId = normalizeDirectText(offer.offerId);
    if (offerId && directMineOpenOfferIds[offerId]) return true;
    var makerWalletId = normalizeDirectText(offer.makerWalletId);
    return !!(directMineActiveWalletId && makerWalletId && makerWalletId === directMineActiveWalletId);
  }

  function ensureDirectLiveOfferFilterControl() {
    var listEl = $('offersList');
    if (!listEl || !listEl.parentNode) return;

    var existing = $('hideMyDirectSwapOffers');
    if (existing) return;

    var wrap = document.createElement('div');
    wrap.className = 'offer-sub';
    wrap.style.margin = '.35rem 0 .65rem';

    var label = document.createElement('label');
    label.className = 'td-switch-row';
    label.setAttribute('for', 'hideMyDirectSwapOffers');

    var input = document.createElement('input');
    input.id = 'hideMyDirectSwapOffers';
    input.type = 'checkbox';
    input.checked = readDirectHideMyLiveOffers();
    input.addEventListener('change', function () {
      writeDirectHideMyLiveOffers(!!input.checked);
      window.location.reload();
    });

    var track = document.createElement('span');
    track.className = 'td-switch-track';
    track.setAttribute('aria-hidden', 'true');

    var text = document.createElement('span');
    text.textContent = 'Hide My Direct Swap Offers (others can still see them)';

    label.appendChild(input);
    label.appendChild(track);
    label.appendChild(text);
    wrap.appendChild(label);
    listEl.parentNode.insertBefore(wrap, listEl);
  }

  function normalizeDirectText(raw) {
    return String(raw == null ? '' : raw).trim();
  }

  function normalizeDirectLower(raw) {
    return normalizeDirectText(raw).toLowerCase();
  }

  function normalizeDirectCa(raw) {
    var value = normalizeDirectLower(raw);
    if (value.indexOf('ca:') === 0) return value.slice(3);
    return value;
  }

  function normalizeDirectSponsoredCatalogItem(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var packageType = normalizeDirectText(raw.package_type).toUpperCase();
    if (packageType !== 'PLUS' && packageType !== 'PRO' && packageType !== 'TENANT') return null;

    var ca = normalizeDirectCa(raw.trigger_ca);
    var seller = normalizeDirectLower(raw.seller_address);
    var networkId = normalizeDirectLower(raw.network || 'mainnet');
    if (!/^[0-9a-f]{64}$/.test(ca)) return null;
    if (networkId !== 'mainnet') return null;
    if (seller.indexOf('kaspa:') !== 0) return null;

    return {
      id: normalizeDirectText(raw.id) || (packageType.toLowerCase() + ':' + ca + ':' + seller),
      label: normalizeDirectText(raw.trigger_label) || packageType,
      networkId: networkId,
      ca: ca,
      seller: seller,
      packageType: packageType
    };
  }

  function setDirectSponsoredCatalog(items) {
    directSponsoredCatalog = (Array.isArray(items) ? items : [])
      .map(normalizeDirectSponsoredCatalogItem)
      .filter(function (item) { return !!item; });
  }

  function findDirectSponsoredCatalog(offer) {
    var networkId = normalizeDirectLower(offer && offer.networkId);
    var kind = normalizeDirectLower(offer && offer.swapKind);
    var ca = normalizeDirectCa(offer && offer.ca);
    var seller = normalizeDirectLower(offer && offer.makerReceiveAddress);
    var state = normalizeDirectLower(offer && offer.state);

    for (var i = 0; i < directSponsoredCatalog.length; i++) {
      var item = directSponsoredCatalog[i];
      if (networkId !== item.networkId) continue;
      if (kind !== 'ca_to_kas') continue;
      if (ca !== item.ca) continue;
      if (seller !== item.seller) continue;
      if (state && state !== 'open') continue;
      return item;
    }

    return null;
  }

  function appendDirectBadge(parent, label, tone) {
    var badge = document.createElement('span');
    badge.textContent = label;
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.padding = '.12rem .42rem';
    badge.style.borderRadius = '999px';
    badge.style.border = tone === 'sponsored'
      ? '1px solid rgba(255,214,102,.48)'
      : '1px solid rgba(var(--td-skin-border-rgb), .32)';
    badge.style.background = tone === 'sponsored'
      ? 'rgba(255,214,102,.16)'
      : 'rgba(var(--td-skin-white-rgb), .08)';
    badge.style.color = 'rgba(var(--td-home-text-rgb), .92)';
    badge.style.fontSize = '.66rem';
    badge.style.fontWeight = '800';
    badge.style.letterSpacing = '.05em';
    badge.style.textTransform = 'uppercase';
    parent.appendChild(badge);
  }

  function kasToSompiStrict(human) {
    var raw = String(human || '').trim();
    if (!raw) return null;
    if (raw[0] === '.') raw = '0' + raw;
    if (raw[raw.length - 1] === '.') raw = raw.slice(0, -1);
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;

    var parts = raw.split('.');
    var whole = parts[0] || '0';
    var frac = (parts.length > 1 ? (parts[1] || '') : '');
    if (frac.length > 8) return null;

    while (frac.length < 8) frac += '0';
    return BigInt(whole + frac);
  }

  function sompiToKasStr(sompi) {
    var s = BigInt(sompi).toString();
    while (s.length <= 8) s = '0' + s;
    var whole = s.slice(0, -8);
    var frac = s.slice(-8).replace(/0+$/, '');
    return frac ? (whole + '.' + frac) : whole;
  }

  var takerWallet = null;
  var lastPsktRequest = null;
  var lastSendContext = null;
  var lastTakerInputSigs = null;
  var isSigningFill = false;

  function readKeyringSessionOrNull() {
    var KEYRING_SESSION_KEY = 'cw_keyring_session';
    var ksTxt = '';
    try { ksTxt = sessionStorage.getItem(KEYRING_SESSION_KEY) || ''; } catch (_) { ksTxt = ''; }
    var keyring = null;
    try { keyring = ksTxt ? JSON.parse(ksTxt) : null; } catch (_) { keyring = null; }
    return keyring && typeof keyring === 'object' ? keyring : null;
  }

  function getKeyringPriv0Hex() {
    var keyring = readKeyringSessionOrNull();
    var priv0Hex = keyring && typeof keyring.priv0_hex === 'string' ? keyring.priv0_hex : '';
    return priv0Hex;
  }

  function signBcwDirectSwapFinalizeIntent(intentMessage, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var message = String(intentMessage || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!message) throw new Error('bcw_direct_swap_finalize_intent_message_missing');
      if (!privHex) throw new Error('wallet_locked');
      if (typeof kaspa.signMessage !== 'function') throw new Error('signMessage_unavailable');

      var priv0 = new kaspa.PrivateKey(privHex);
      return kaspa.signMessage({
        message: message,
        privateKey: priv0
      });
    });
  }

  function kaspaReadyOrThrow() {
    if (!window.kaspaReady || typeof window.kaspaReady.then !== 'function') {
      return Promise.reject(new Error('kaspa_not_ready'));
    }
    return window.kaspaReady.then(function () {
      if (!window.kaspa) throw new Error('kaspa_not_loaded');
      return window.kaspa;
    });
  }

  function signInputsForTxShape(txSafeJson, inputsToSign, priv0Hex, signCtx) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var priv0 = new kaspa.PrivateKey(priv0Hex);
      var tx = kaspa.Transaction.deserializeFromSafeJSON(txSafeJson);
      var signMode = (signCtx && typeof signCtx.sign_mode === 'string') ? String(signCtx.sign_mode) : '';

      if (signMode === 'compliance') {
        throw new Error('legacy_compliance_direct_swap_signing_removed');
      }

      var sigs = [];
      for (var i = 0; i < inputsToSign.length; i++) {
        var idx = inputsToSign[i];
        var sig = kaspa.createInputSignature(tx, idx, priv0, null);
        sigs.push(sig);
      }
      return sigs;
    });
  }

  function signOpenSwapCancelInput(txSafeJson, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var txRaw = String(txSafeJson || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!txRaw) throw new Error('open_swap_cancel_tx_missing');
      if (!privHex) throw new Error('wallet_locked');

      var priv0 = new kaspa.PrivateKey(privHex);
      var tx = kaspa.Transaction.deserializeFromSafeJSON(txRaw);
      return kaspa.createInputSignature(tx, 0, priv0, kaspa.SighashType.SingleAnyOneCanPay);
    });
  }

  function signBcwOpenSwapCancelIntent(intentMessage, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var message = String(intentMessage || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!message) throw new Error('bcw_open_swap_cancel_intent_message_missing');
      if (!privHex) throw new Error('wallet_locked');
      if (typeof kaspa.signMessage !== 'function') throw new Error('signMessage_unavailable');

      var priv0 = new kaspa.PrivateKey(privHex);
      return kaspa.signMessage({
        message: message,
        privateKey: priv0
      });
    });
  }

  function sleepMs(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, Math.max(0, Number(ms || 0)));
    });
  }

  function hexToBytesForAtomicClaim(hex) {
    var raw = String(hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0) {
      throw new Error('kcc20_atomic_swap_taker_claim_hex_invalid');
    }
    var out = new Uint8Array(raw.length / 2);
    for (var i = 0; i < raw.length; i += 2) {
      out[i / 2] = parseInt(raw.slice(i, i + 2), 16);
    }
    return out;
  }

  function fillAtomicClaimInputSignature(tx, inputIndex, signatureScript, reason) {
    var inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) {
      throw new Error(reason || 'kcc20_atomic_swap_taker_claim_input_missing');
    }
    inputs[inputIndex].signatureScript = signatureScript;
    tx.inputs = inputs;
  }

  function buildKcc20AtomicClaimSelectorSignatureScript(kaspa, selectorHex, redeemScriptHex) {
    var selectorBytes = hexToBytesForAtomicClaim(selectorHex);
    var redeemScriptBytes = hexToBytesForAtomicClaim(redeemScriptHex);
    return new kaspa.ScriptBuilder()
      .addData(selectorBytes)
      .addData(redeemScriptBytes)
      .drain();
  }

  function isKcc20AtomicDirectOffer(offer) {
    if (!offer || typeof offer !== 'object') return false;
    var kind = normalizeDirectText(offer.atomic_swap_kind);
    var source = normalizeDirectText(offer.source);
    var route = normalizeDirectText(offer.buy && offer.buy.route);
    return kind === 'kcc20_atomic_direct_maker_lock_v1' || source === 'kcc20_atomic_swap' || route === 'kcc20_atomic_swap_claim';
  }

  function kcc20AtomicOfferSourceOutpoint(offer) {
    return normalizeDirectText(
      offer && (offer.atomic_swap_source_outpoint_key || offer.source_outpoint_key || offer.sourceOutpointKey)
    );
  }

  function kcc20AtomicOpenOfferDraft(offer) {
    if (!offer || typeof offer !== 'object') return null;
    var draft = offer.offerDraft && typeof offer.offerDraft === 'object' ? offer.offerDraft : null;
    if (!draft && typeof offer.offerBlob === 'string' && offer.offerBlob.trim()) {
      try { draft = JSON.parse(offer.offerBlob); } catch (_) { draft = null; }
    }
    if (!draft || typeof draft !== 'object') return null;
    var atomic = draft.atomicSwap && typeof draft.atomicSwap === 'object' ? draft.atomicSwap : null;
    var protocol = draft.protocol && typeof draft.protocol === 'object' ? draft.protocol : null;
    var sell = draft.sell && typeof draft.sell === 'object' ? draft.sell : null;
    if (!(
      atomic && atomic.kind === 'kcc20_atomic_open_maker_lock_v1' &&
      protocol && protocol.makerOp === 'kcc20_atomic_open_maker_lock' &&
      protocol.takerOp === 'kcc20_atomic_open_claim' &&
      sell && sell.type === 'OMA_L1_COVENANT_TOKEN'
    )) return null;
    return draft;
  }

  function isKcc20AtomicOpenOffer(offer) {
    return !!kcc20AtomicOpenOfferDraft(offer);
  }

  function kcc20AtomicOpenOfferSourceOutpoint(offer) {
    var draft = kcc20AtomicOpenOfferDraft(offer);
    var atomic = draft && draft.atomicSwap && typeof draft.atomicSwap === 'object' ? draft.atomicSwap : null;
    return normalizeDirectText(
      (atomic && atomic.source_outpoint_key) ||
      (offer && (offer.atomic_swap_source_outpoint_key || offer.source_outpoint_key || offer.sourceOutpointKey))
    );
  }

  function kcc20AtomicOpenOfferCovenantId(offer) {
    var draft = kcc20AtomicOpenOfferDraft(offer);
    var sell = draft && draft.sell && typeof draft.sell === 'object' ? draft.sell : null;
    var atomic = draft && draft.atomicSwap && typeof draft.atomicSwap === 'object' ? draft.atomicSwap : null;
    var candidates = [
      offer && offer.asset_covenant_id,
      offer && offer.assetCovenantId,
      offer && offer.ca,
      sell && sell.asset_covenant_id,
      sell && sell.assetCovenantId,
      sell && sell.ca,
      atomic && atomic.asset_covenant_id,
      atomic && atomic.assetCovenantId
    ];
    for (var i = 0; i < candidates.length; i++) {
      var id = normalizeDirectCa(candidates[i]);
      if (/^[0-9a-f]{64}$/i.test(id)) return id.toLowerCase();
    }
    return '';
  }

  function kcc20AtomicOpenOfferTokenLabel(offer, fallback) {
    var draft = kcc20AtomicOpenOfferDraft(offer);
    var sell = draft && draft.sell && typeof draft.sell === 'object' ? draft.sell : null;
    var symbol = normalizeDirectText((sell && (sell.symbol || sell.ticker)) || (offer && offer.sellSymbol));
    var name = normalizeDirectText((sell && sell.name) || (offer && offer.sellName));
    var symbolCa = normalizeDirectCa(symbol);
    if (symbol && !/^[0-9a-f]{64}$/i.test(symbolCa) && !/^CA:/i.test(symbol)) return symbol;
    if (name) return name;
    return fallback || 'KCC20 token';
  }

  function kcc20AtomicOpenOfferTokenName(offer) {
    var draft = kcc20AtomicOpenOfferDraft(offer);
    var sell = draft && draft.sell && typeof draft.sell === 'object' ? draft.sell : null;
    return normalizeDirectText((sell && sell.name) || (offer && offer.sellName));
  }

  function directOfferCreatedMs(offer) {
    var raw = normalizeDirectText(offer && (offer.createdAt || offer.created_at || offer.created));
    var t = raw ? Date.parse(raw) : 0;
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  function directOfferCreatedLabel(offer) {
    var raw = normalizeDirectText(offer && (offer.createdAt || offer.created_at || offer.created));
    if (!raw) return '';
    var t = Date.parse(raw);
    if (!Number.isFinite(t) || t <= 0) return raw;
    return new Date(t).toLocaleString();
  }

  function directOfferTtlSeconds(offer) {
    var raw = Number(offer && (offer.ttl != null ? offer.ttl : offer.offer_ttl_seconds));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  function directOfferExpiresMs(offer) {
    var expiresRaw = normalizeDirectText(offer && (offer.expiresAt || offer.expires_at || offer.offer_expires_at));
    if (expiresRaw) {
      var expiresMs = Date.parse(expiresRaw);
      if (Number.isFinite(expiresMs) && expiresMs > 0) return expiresMs;
    }

    var ttl = directOfferTtlSeconds(offer);
    if (ttl > 0) {
      var createdMs = directOfferCreatedMs(offer);
      if (createdMs > 0) return createdMs + ttl * 1000;
    }

    return 0;
  }

  function directOfferIsExpired(offer) {
    var expiresMs = directOfferExpiresMs(offer);
    return expiresMs > 0 && expiresMs <= Date.now();
  }

  function directOfferExpiresText(offer) {
    var expiresRaw = normalizeDirectText(offer && (offer.expiresAt || offer.expires_at || offer.offer_expires_at));
    if (expiresRaw) return expiresRaw;
    var expiresMs = directOfferExpiresMs(offer);
    return expiresMs > 0 ? new Date(expiresMs).toISOString() : '';
  }

  function directOfferShortOutpoint(offer) {
    var outpoint = kcc20AtomicOfferSourceOutpoint(offer);
    if (!outpoint) return '';
    return outpoint.length > 24 ? (outpoint.slice(0, 12) + '…' + outpoint.slice(-8)) : outpoint;
  }

  function directShortCovenantId(value) {
    var id = normalizeDirectCa(value);
    if (!/^[0-9a-f]{64}$/i.test(id)) return '';
    return id.slice(0, 12) + '…' + id.slice(-8);
  }

  function directKcc20AtomicCovenantId(offer, asset) {
    var candidates = [
      offer && offer.asset_covenant_id,
      offer && offer.assetCovenantId,
      offer && offer.ca,
      offer && offer.covenant_id,
      offer && offer.covenantId,
      asset && asset.asset_covenant_id,
      asset && asset.assetCovenantId,
      asset && asset.covenant_id,
      asset && asset.covenantId
    ];
    for (var i = 0; i < candidates.length; i++) {
      var id = normalizeDirectCa(candidates[i]);
      if (/^[0-9a-f]{64}$/i.test(id)) return id.toLowerCase();
    }
    return '';
  }

  function directKcc20AtomicTokenDisplayLabel(offer, asset, fallback) {
    var symbol = normalizeDirectText((offer && (offer.tokenSymbol || offer.token_symbol)) || (asset && (asset.symbol || asset.ticker || asset.assetId)));
    var name = normalizeDirectText((offer && (offer.tokenName || offer.token_name)) || (asset && asset.name));
    var normalizedSymbolAsCa = normalizeDirectCa(symbol);
    var symbolLooksId = /^[0-9a-f]{64}$/i.test(normalizedSymbolAsCa) || /^CA:/i.test(symbol);
    var cleanSymbol = symbol && !symbolLooksId ? symbol : '';
    if (cleanSymbol) return cleanSymbol;
    if (name) return name;
    return fallback || 'KCC20 token';
  }

  function directKcc20AtomicTokenName(offer, asset) {
    return normalizeDirectText((offer && (offer.tokenName || offer.token_name)) || (asset && asset.name));
  }

  function sortDirectOffersNewestFirst(items) {
    return (Array.isArray(items) ? items.slice() : []).sort(function (a, b) {
      var diff = directOfferCreatedMs(b) - directOfferCreatedMs(a);
      if (diff) return diff;
      return normalizeDirectText(b && b.offerId).localeCompare(normalizeDirectText(a && a.offerId));
    });
  }

  function postJsonForAtomicClaim(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return {}; })
          .then(function (json) {
            if (!res.ok || !json || json.ok === false) {
              var reason = (json && (json.reason || json.error)) || ('HTTP ' + res.status);
              var err = new Error(reason);
              err.http_status = res.status;
              err.response = json || {};
              throw err;
            }
            json.http_status = res.status;
            return json;
          });
      });
  }

  function atomicClaimPublicSummary(build, signed, submitOut) {
    return {
      claim_kind: 'kcc20_atomic_direct_taker_claim_wallet_ui_v1',
      source_outpoint_key: String((build && build.source_outpoint_key) || (submitOut && submitOut.source_outpoint_key) || ''),
      token_symbol: String((build && build.token_symbol) || (submitOut && submitOut.token_symbol) || ''),
      lock_amount_raw: String((build && build.lock_amount_raw) || (submitOut && submitOut.lock_amount_raw) || ''),
      kas_price_kas: String((build && build.kas_price_kas) || ''),
      policy_body_kind: String((build && build.policy_body_kind) || (submitOut && submitOut.policy_body_kind) || ''),
      native_change_output_allowed_by_policy: build ? build.native_change_output_allowed_by_policy === true : null,
      signed_tx_deserialize_check_ok: signed ? signed.signed_tx_deserialize_check_ok === true : null,
      submit_kind: String((submitOut && submitOut.submit_kind) || ''),
      application_status: String((submitOut && submitOut.application_status) || ''),
      submitted_txid: String((submitOut && submitOut.submitted_txid) || ''),
      tracking_record_status: String((submitOut && submitOut.tracking && submitOut.tracking.record_status) || ''),
      released_output_outpoint: String((submitOut && submitOut.tracking && submitOut.tracking.released_output_outpoint) || '')
    };
  }

  function atomicMakerRefundPublicSummary(build, signed, submitOut) {
    return {
      refund_kind: 'kcc20_atomic_direct_maker_refund_wallet_ui_v1',
      source_outpoint_key: String((build && build.source_outpoint_key) || (submitOut && submitOut.source_outpoint_key) || ''),
      token_symbol: String((build && build.token_symbol) || (submitOut && submitOut.token_symbol) || ''),
      lock_amount_raw: String((build && build.lock_amount_raw) || (submitOut && submitOut.lock_amount_raw) || ''),
      refund_lock_daa: String((build && build.refund_lock_daa) || (submitOut && submitOut.refund_lock_daa) || ''),
      signed_tx_deserialize_check_ok: signed ? signed.signed_tx_deserialize_check_ok === true : null,
      submit_kind: String((submitOut && submitOut.submit_kind) || ''),
      application_status: String((submitOut && submitOut.application_status) || ''),
      submitted_txid: String((submitOut && submitOut.submitted_txid) || ''),
      tracking_record_status: String((submitOut && submitOut.tracking && submitOut.tracking.record_status) || ''),
      released_output_outpoint: String((submitOut && submitOut.tracking && submitOut.tracking.released_output_outpoint) || '')
    };
  }

  function normalizeAtomicOpCheckSigSignature65(signatureHex, reason) {
    var bytes = hexToBytesForAtomicClaim(signatureHex);
    if (bytes.length === 66 && bytes[0] === 0x41) bytes = bytes.slice(1);
    if (bytes.length !== 65) throw new Error(reason || 'kcc20_atomic_swap_signature_must_be_65_bytes_for_op_checksig');
    return bytes;
  }

  function buildKcc20AtomicRefundSignatureScript(kaspa, signatureHex, selectorHex, redeemScriptHex) {
    var signatureBytes = normalizeAtomicOpCheckSigSignature65(
      signatureHex,
      'kcc20_atomic_swap_maker_refund_signature_must_be_65_bytes_for_op_checksig'
    );
    var selectorBytes = new Uint8Array();
    var redeemScriptBytes = hexToBytesForAtomicClaim(redeemScriptHex);
    return new kaspa.ScriptBuilder()
      .addData(signatureBytes)
      .addData(selectorBytes)
      .addData(redeemScriptBytes)
      .drain();
  }

  function buildKcc20AtomicDirectMakerRefund(rowData) {
    var sourceOutpointKey = normalizeDirectText(rowData && rowData.sourceOutpointKey);
    if (!/^[0-9a-f]{64}:\d+$/i.test(sourceOutpointKey)) {
      throw new Error('kcc20_atomic_swap_maker_refund_source_outpoint_key_required');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/direct/maker-refund/build', {
      source_outpoint_key: sourceOutpointKey
    });
  }

  function signKcc20AtomicDirectMakerRefund(build, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var txRaw = String(build && build.txToSignSafeJson || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!txRaw) throw new Error('kcc20_atomic_swap_maker_refund_build_missing_tx');
      if (!privHex) throw new Error('wallet_locked');

      var ctx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
      var holderInputIndex = Number(ctx.holder_input_index);
      if (!Number.isInteger(holderInputIndex) || holderInputIndex < 0) {
        throw new Error('kcc20_atomic_swap_maker_refund_holder_input_not_signable');
      }

      var redeemScriptHex = String(ctx.source_swap_locked_holder_redeem_script_hex || '').trim().toLowerCase();
      var selectorHex = String(ctx.refund_selector_hex || build.refund_selector_hex || '00').trim().toLowerCase();
      if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) {
        throw new Error('kcc20_atomic_swap_maker_refund_redeem_script_missing');
      }
      if (!/^[0-9a-f]+$/i.test(selectorHex) || selectorHex.length % 2 !== 0) {
        throw new Error('kcc20_atomic_swap_maker_refund_selector_invalid');
      }

      var priv0 = new kaspa.PrivateKey(privHex);
      var tx = kaspa.Transaction.deserializeFromSafeJSON(txRaw);
      var signatureHex = kaspa.createInputSignature(tx, holderInputIndex, priv0, null);
      var refundSignatureScript = buildKcc20AtomicRefundSignatureScript(kaspa, signatureHex, selectorHex, redeemScriptHex);
      fillAtomicClaimInputSignature(
        tx,
        holderInputIndex,
        refundSignatureScript,
        'kcc20_atomic_swap_maker_refund_holder_signature_script_missing'
      );

      tx.finalize();
      var signedSafeJson = tx.serializeToSafeJSON();
      kaspa.Transaction.deserializeFromSafeJSON(signedSafeJson);
      return {
        stage: 'kcc20_atomic_swap_maker_refund_wallet_ui_signed_v1',
        signedSafeJson: signedSafeJson,
        signed_tx_deserialize_check_ok: true
      };
    });
  }

  function submitKcc20AtomicDirectMakerRefund(build, signed) {
    if (!build || !signed || !signed.signedSafeJson) {
      throw new Error('kcc20_atomic_swap_maker_refund_submit_missing_signed_tx');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/direct/maker-refund/submit', {
      source_outpoint_key: build.source_outpoint_key,
      submit_token: build.submit_token,
      submit_intent: build.submit_intent_required || 'submit_oma_l1_kcc20_atomic_direct_swap_maker_refund_v1',
      signed_safe_json: signed.signedSafeJson
    });
  }

  function buildKcc20AtomicOpenMakerRefund(rowData) {
    var sourceOutpointKey = normalizeDirectText(rowData && rowData.sourceOutpointKey);
    var offerId = normalizeDirectText(rowData && rowData.offerId);
    if (!/^[0-9a-f]{64}:\d+$/i.test(sourceOutpointKey)) {
      throw new Error('kcc20_atomic_open_swap_maker_refund_source_outpoint_key_required');
    }
    if (!offerId) {
      throw new Error('kcc20_atomic_open_swap_maker_refund_offer_id_required');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/open/maker-refund/build', {
      offer_id: offerId,
      open_swap_offer_id: offerId,
      source_outpoint_key: sourceOutpointKey
    });
  }

  function signKcc20AtomicOpenMakerRefund(build, priv0Hex) {
    return signKcc20AtomicDirectMakerRefund(build, priv0Hex);
  }

  function submitKcc20AtomicOpenMakerRefund(build, signed) {
    if (!build || !signed || !signed.signedSafeJson) {
      throw new Error('kcc20_atomic_open_swap_maker_refund_submit_missing_signed_tx');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/open/maker-refund/submit', {
      offer_id: build.open_swap_offer_id || build.offer_id || '',
      open_swap_offer_id: build.open_swap_offer_id || build.offer_id || '',
      source_outpoint_key: build.source_outpoint_key,
      submit_token: build.submit_token,
      submit_intent: build.submit_intent_required || 'submit_oma_l1_kcc20_atomic_open_swap_maker_refund_v1',
      signed_safe_json: signed.signedSafeJson
    });
  }

  function buildKcc20AtomicDirectTakerClaim(offer) {
    var sourceOutpointKey = kcc20AtomicOfferSourceOutpoint(offer);
    if (!/^[0-9a-f]{64}:\d+$/i.test(sourceOutpointKey)) {
      throw new Error('kcc20_atomic_swap_taker_claim_source_outpoint_key_required');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/direct/taker-claim/build', {
      source_outpoint_key: sourceOutpointKey,
      max_implicit_fee_sompi: '10000000'
    });
  }

  function signKcc20AtomicDirectTakerClaim(build, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var txRaw = String(build && build.txToSignSafeJson || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!txRaw) throw new Error('kcc20_atomic_swap_taker_claim_build_missing_tx');
      if (!privHex) throw new Error('wallet_locked');

      var signInputIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(function (n) { return Number(n); }) : [];
      var signSet = Object.create(null);
      signInputIndexes.forEach(function (n) { if (Number.isInteger(n) && n >= 0) signSet[n] = true; });

      var ctx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
      var holderInputIndex = Number(ctx.holder_input_index);
      var fundingInputIndex = Number(ctx.native_kas_funding_input_index);
      if (!Number.isInteger(holderInputIndex) || holderInputIndex < 0 || !signSet[holderInputIndex]) {
        throw new Error('kcc20_atomic_swap_taker_claim_holder_input_not_signable');
      }
      if (!Number.isInteger(fundingInputIndex) || fundingInputIndex < 0 || !signSet[fundingInputIndex]) {
        throw new Error('kcc20_atomic_swap_taker_claim_native_funding_input_not_signable');
      }

      var redeemScriptHex = String(ctx.source_swap_locked_holder_redeem_script_hex || '').trim().toLowerCase();
      var selectorHex = String(ctx.claim_selector_hex || build.claim_selector_hex || '01').trim().toLowerCase();
      if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) {
        throw new Error('kcc20_atomic_swap_taker_claim_redeem_script_missing');
      }
      if (!/^[0-9a-f]+$/i.test(selectorHex) || selectorHex.length % 2 !== 0) {
        throw new Error('kcc20_atomic_swap_taker_claim_selector_invalid');
      }

      var priv0 = new kaspa.PrivateKey(privHex);
      var tx = kaspa.Transaction.deserializeFromSafeJSON(txRaw);
      var selectorSignatureScript = buildKcc20AtomicClaimSelectorSignatureScript(kaspa, selectorHex, redeemScriptHex);
      fillAtomicClaimInputSignature(
        tx,
        holderInputIndex,
        selectorSignatureScript,
        'kcc20_atomic_swap_taker_claim_holder_signature_script_missing'
      );
      fillAtomicClaimInputSignature(
        tx,
        fundingInputIndex,
        kaspa.createInputSignature(tx, fundingInputIndex, priv0, null),
        'kcc20_atomic_swap_taker_claim_native_funding_signature_missing'
      );

      tx.finalize();
      var signedSafeJson = tx.serializeToSafeJSON();
      kaspa.Transaction.deserializeFromSafeJSON(signedSafeJson);
      return {
        stage: 'kcc20_atomic_swap_taker_claim_wallet_ui_signed_v1',
        signedSafeJson: signedSafeJson,
        signed_tx_deserialize_check_ok: true
      };
    });
  }

  function submitKcc20AtomicDirectTakerClaim(build, signed) {
    if (!build || !signed || !signed.signedSafeJson) {
      throw new Error('kcc20_atomic_swap_taker_claim_submit_missing_signed_tx');
    }
    return postJsonForAtomicClaim('/api/covenants/issuer-token/atomic-swap/direct/taker-claim/submit', {
      submit_token: build.submit_token,
      submit_intent: build.submit_intent_required,
      signedSafeJson: signed.signedSafeJson
    });
  }

  function handleKcc20AtomicDirectClaimClick(offer, clickedButton) {
    if (isSigningFill) return;
    isSigningFill = true;
    lastPsktRequest = null;
    lastSendContext = null;

    var originalButtonText = clickedButton ? clickedButton.textContent : '';
    if (clickedButton) {
      clickedButton.disabled = true;
      clickedButton.textContent = 'Claiming…';
    }

    updateFillPanel({
      summary: 'Preparing KCC20 atomic direct claim…',
      status: 'Building taker-claim transaction from the selected live maker-lock.',
      psktText: '',
      sendText: '',
      canConfirm: false,
      buttonLabel: 'Claiming…'
    });

    var priv0Hex = getKeyringPriv0Hex();
    if (!priv0Hex) {
      isSigningFill = false;
      if (clickedButton) {
        clickedButton.disabled = false;
        clickedButton.textContent = originalButtonText || 'Buy';
      }
      updateFillPanel({
        summary: 'Keyfile unlock required to claim this atomic swap.',
        status: 'Unlock your keyfile in the Wallet tab first, then click Buy again.',
        psktText: '',
        sendText: '',
        canConfirm: false,
        buttonLabel: 'Claim Atomic Swap'
      });
      return;
    }

    var built = null;
    var signed = null;
    buildKcc20AtomicDirectTakerClaim(offer)
      .then(function (build) {
        built = build;
        updateFillPanel({
          summary: 'Signing KCC20 atomic direct claim…',
          status: 'Build succeeded. Signing claim selector and native KAS funding input.',
          psktText: JSON.stringify(atomicClaimPublicSummary(build, null, null), null, 2),
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Signing…'
        });
        return signKcc20AtomicDirectTakerClaim(build, priv0Hex);
      })
      .then(function (signedOut) {
        signed = signedOut;
        updateFillPanel({
          summary: 'Submitting KCC20 atomic direct claim…',
          status: 'Signed locally. Submitting claim to testnet-10.',
          psktText: JSON.stringify(atomicClaimPublicSummary(built, signedOut, null), null, 2),
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Submitting…'
        });
        return submitKcc20AtomicDirectTakerClaim(built, signedOut);
      })
      .then(function (submitOut) {
        isSigningFill = false;
        var section = $('fillSection');
        if (section) section.__reloadAfterClose = true;
        var summaryObj = atomicClaimPublicSummary(built, signed, submitOut);
        updateFillPanel({
          summary: 'Success — KCC20 Atomic Direct Swap claimed.',
          status: 'Claim submitted. Txid: ' + (summaryObj.submitted_txid || 'unknown'),
          statusClass: 'fill-success',
          psktText: JSON.stringify(summaryObj, null, 2),
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Claim Submitted',
          closeLabel: 'Close & Refresh Offers'
        });
        if (clickedButton) {
          clickedButton.disabled = true;
          clickedButton.textContent = 'Claimed';
        }
      })
      .catch(function (err) {
        console.error('offers.atomicClaim error', err);
        isSigningFill = false;
        var reason = err && (err.reason || err.message) ? String(err.reason || err.message) : String(err);
        var response = err && err.response ? err.response : null;
        var detail = response && response.error ? String(response.error) : '';
        var statusText = reason;
        if (reason === 'kcc20_atomic_swap_taker_claim_policy_requires_final_true_v3') {
          statusText = 'This is an older v1/v2 atomic swap offer. Use the newest Direct Swap offer, or refresh after hiding old/claimed rows.';
        } else if (detail && detail !== reason) {
          statusText = reason + '\n' + detail;
        }
        updateFillPanel({
          summary: 'KCC20 atomic direct claim failed.',
          status: statusText,
          psktText: response ? JSON.stringify(response, null, 2) : '',
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Retry Claim'
        });
        if (clickedButton) {
          clickedButton.disabled = false;
          clickedButton.textContent = originalButtonText || 'Buy';
        }
      });
  }

  function loadTakerWallet() {
    // Best-effort: we only need the active Kaspa address for fills.
    fetch('/api/wallet/holdings?strict=1', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (h) {
        if (!h || !h.address) {
          console.warn('offers: holdings missing address', h);
          takerWallet = null;
          return;
        }
        var sompiStr = (h && (h.sompi !== undefined && h.sompi !== null)) ? String(h.sompi).trim() : '';
        takerWallet = {
          wid: h.wid || '',
          address: String(h.address),
          sompi: sompiStr
        };
      })
      .catch(function (err) {
        console.warn('offers: wallet holdings error', err);
      });
  }

  function getSwapAnalyzerSharedOrNull() {
    var shared = window.SwapAnalyzerShared;
    if (!shared || typeof shared.renderAnalyzer !== 'function' || typeof shared.clearAnalyzer !== 'function') {
      return null;
    }
    return shared;
  }

  function getFillAnalyzerRefs() {
    return {
      panel: document.getElementById('fillAnalyzerPanel'),
      summary: document.getElementById('fillAnalyzerSummary'),
      hints: document.getElementById('fillAnalyzerHints'),
      statusBadge: document.getElementById('fillAnalyzerStatusBadge'),
      blockers: document.getElementById('fillAnalyzerBlockers'),
      notes: document.getElementById('fillAnalyzerNotes'),
      summarySellAsset: document.getElementById('fillSummarySellAsset'),
      summarySellAmount: document.getElementById('fillSummarySellAmount'),
      summaryBuyAsset: document.getElementById('fillSummaryBuyAsset'),
      summaryBuyAmount: document.getElementById('fillSummaryBuyAmount'),
      sellMeta: {
        header: document.getElementById('fillAssetMetaSellHeader'),
        ticker: document.getElementById('fillAssetMetaSellTicker'),
        name: document.getElementById('fillAssetMetaSellName'),
        type: document.getElementById('fillAssetMetaSellType'),
        decimals: document.getElementById('fillAssetMetaSellDecimals'),
        contractAddress: document.getElementById('fillAssetMetaSellContractAddress'),
        totalMinted: document.getElementById('fillAssetMetaSellTotalMinted'),
        maxSupply: document.getElementById('fillAssetMetaSellMaxSupply'),
        holders: document.getElementById('fillAssetMetaSellHolders'),
        transfers: document.getElementById('fillAssetMetaSellTransfers'),
        mints: document.getElementById('fillAssetMetaSellMints'),
        explorerLink: document.getElementById('fillAssetMetaSellExplorerLink')
      },
      buyMeta: {
        header: document.getElementById('fillAssetMetaBuyHeader'),
        ticker: document.getElementById('fillAssetMetaBuyTicker'),
        name: document.getElementById('fillAssetMetaBuyName'),
        type: document.getElementById('fillAssetMetaBuyType'),
        decimals: document.getElementById('fillAssetMetaBuyDecimals'),
        contractAddress: document.getElementById('fillAssetMetaBuyContractAddress'),
        totalMinted: document.getElementById('fillAssetMetaBuyTotalMinted'),
        maxSupply: document.getElementById('fillAssetMetaBuyMaxSupply'),
        holders: document.getElementById('fillAssetMetaBuyHolders'),
        transfers: document.getElementById('fillAssetMetaBuyTransfers'),
        mints: document.getElementById('fillAssetMetaBuyMints'),
        explorerLink: document.getElementById('fillAssetMetaBuyExplorerLink')
      }
    };
  }

  function updateFillPanel(state) {
    var section   = $('fillSection');
    var summaryEl = $('fillSummary');
    var psktEl    = $('fillPskt');
    var sendEl    = $('fillSendCtx');
    var statusEl  = $('fillStatus');
    var btn       = $('fillConfirmBtn');
    var closeBtn  = $('fillCloseBtn');
    if (!section || !summaryEl || !psktEl || !sendEl || !statusEl) return;

    var shared = getSwapAnalyzerSharedOrNull();
    var analyzerRefs = getFillAnalyzerRefs();

    if (!state) {
      section.__fillAnalyzerState = null;
      section.style.display = 'none';
      summaryEl.textContent = '';
      psktEl.textContent = '';
      sendEl.textContent = '';
      statusEl.textContent = '';
      statusEl.classList.remove('fill-success');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Confirm & Sign Swap';
      }
      if (closeBtn) closeBtn.textContent = 'Close';
      if (analyzerRefs.panel) analyzerRefs.panel.style.display = 'none';
      if (shared) shared.clearAnalyzer(analyzerRefs);
      return;
    }

    section.style.display = 'block';
    summaryEl.textContent = state.summary || '';
    statusEl.textContent  = state.status || '';
    statusEl.classList.toggle('fill-success', state.statusClass === 'fill-success');
    psktEl.textContent    = state.psktText || '';
    sendEl.textContent    = state.sendText || '';

    if (closeBtn) closeBtn.textContent = state.closeLabel || 'Close';

    if (btn) {
      var canConfirm = !!state.canConfirm;
      btn.disabled = !canConfirm;
      btn.textContent = state.buttonLabel || 'Confirm & Sign Swap';
    }

    var analyzerState = Object.prototype.hasOwnProperty.call(state, 'analyzerState')
      ? state.analyzerState
      : section.__fillAnalyzerState;

    if (!Object.prototype.hasOwnProperty.call(state, 'analyzerState') && !state.canConfirm && !state.sendText) {
      analyzerState = null;
    }

    section.__fillAnalyzerState = analyzerState || null;

    if (!analyzerRefs.panel) return;

    if (!shared || !analyzerState || !analyzerState.out) {
      analyzerRefs.panel.style.display = 'none';
      if (shared) shared.clearAnalyzer(analyzerRefs);
      return;
    }

    analyzerRefs.panel.style.display = 'block';
    shared.renderAnalyzer({
      refs: analyzerRefs,
      out: analyzerState.out,
      payload: analyzerState.payload,
      blockers: analyzerState.blockers,
      notes: analyzerState.notes,
      paymentDisplayLabel: analyzerState.paymentDisplayLabel,
      fromAddress: analyzerState.fromAddress
    });
  }

  function closeFillModal(reason) {
    var section = $('fillSection');
    var shouldReloadOffers = !!(section && section.__reloadAfterClose);
    if (section) section.__reloadAfterClose = false;

    isSigningFill = false;
    lastPsktRequest = null;
    lastSendContext = null;

    var pwEl = document.getElementById('fillPassword');
    if (pwEl) pwEl.value = '';

    updateFillPanel(null);
    if (shouldReloadOffers) {
      window.location.reload();
      return;
    }
  }

function handleConfirmFill() {
    var btn = $('fillConfirmBtn');

    if (!lastPsktRequest || !lastSendContext) {
      updateFillPanel({
        summary: 'No PSKT fill is ready to sign.',
        status: 'Select an offer and click Buy first.',
        psktText: '',
        sendText: '',
        canConfirm: false,
        buttonLabel: 'Confirm & Sign Swap'
      });
      return;
    }

    if (isSigningFill) return;
    isSigningFill = true;
    lastTakerInputSigs = null;

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }

    updateFillPanel({
      summary: 'Submitting PSKT fill…',
      status: 'Preparing staged accept…',
      psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
      sendText: JSON.stringify(lastSendContext || {}, null, 2),
      canConfirm: false,
      buttonLabel: 'Submitting…'
    });

    var pwEl = document.getElementById('fillPassword');
    if (pwEl) pwEl.value = '';

    var priv0Hex = getKeyringPriv0Hex();
    if (!priv0Hex) {
      isSigningFill = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Confirm & Sign Swap';
      }
      updateFillPanel({
        summary: 'Keyfile unlock required to sign.',
        status: 'Unlock your keyfile in the Wallet tab first (same browser tab), then retry.',
        psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
        sendText: JSON.stringify(lastSendContext || {}, null, 2),
        canConfirm: true,
        buttonLabel: 'Retry Confirm & Sign'
      });
      return;
    }

    function postWalletSend(extraBody) {
      var baseBody = {
        mode: 'krc20_pskt_swap',
        psktRequest: lastPsktRequest,
        sendContext: lastSendContext
      };
      if (extraBody && typeof extraBody === 'object') {
        Object.keys(extraBody).forEach(function (k) {
          baseBody[k] = extraBody[k];
        });
      }

      return fetch('/api/wallet/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(baseBody)
      })
        .then(function (res) {
          // Always try to parse JSON, even on HTTP 4xx/5xx
          return res.json()
            .catch(function () { return {}; })
            .then(function (body) {
              return { httpOk: res.ok, status: res.status, body: body || {} };
            });
        });
    }

    function finishOk(txid) {
      isSigningFill = false;
      var status = txid
        ? ('Success — swap submitted. Txid: ' + txid)
        : 'Success — swap submitted.';

      var section = $('fillSection');
      if (section) section.__reloadAfterClose = true;

      updateFillPanel({
        summary: 'Success — swap submitted.',
        status: status,
        statusClass: 'fill-success',
        psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
        sendText: JSON.stringify(lastSendContext || {}, null, 2),
        canConfirm: false,
        buttonLabel: 'Swap Submitted',
        closeLabel: 'Close & Refresh Offers'
      });

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Swap Submitted';
      }
    }

    function finishErr(meta, errText) {
      isSigningFill = false;

      updateFillPanel({
        summary: 'PSKT fill failed to submit.',
        status: 'Error from /api/wallet/send: ' + errText,
        psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
        sendText: JSON.stringify(lastSendContext || {}, null, 2),
        canConfirm: true,
        buttonLabel: 'Retry Confirm & Sign'
      });

      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry Confirm & Sign';
      }
    }

    function handleSwapMeta(meta) {
      var body = meta && meta.body ? meta.body : {};
      if (!(meta && meta.httpOk && body && body.ok)) {
        var errText2 =
          (body && (body.error || body.reason)) ||
          ('HTTP ' + (meta ? meta.status : '0'));
        finishErr(meta, errText2);
        return;
      }

      if (body.stage === 'swap_direct_bcw_finalize_intent' && body.bcw_direct_swap_finalize_intent && typeof body.intent_message === 'string') {
        updateFillPanel({
          summary: 'Authorizing broker-custody direct swap…',
          status: 'Signing broker-custody swap intent…',
          psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
          sendText: JSON.stringify(lastSendContext || {}, null, 2),
          canConfirm: false,
          buttonLabel: 'Authorizing…'
        });

        signBcwDirectSwapFinalizeIntent(body.intent_message, priv0Hex)
          .then(function (authSignature) {
            return postWalletSend({
              swapStage: 'bcw_direct_swap_finalize_submit',
              acceptRid: String(body.acceptRid || ''),
              bcw_direct_swap_finalize_intent: body.bcw_direct_swap_finalize_intent,
              bcw_auth_signature: authSignature
            });
          })
          .then(handleSwapMeta)
          .catch(function (err) {
            console.error('offers.fillConfirm BCW direct swap intent failed', err);
            finishErr(null, String(err && err.message ? err.message : err));
          });
        return;
      }

      if (body.stage === 'swap_accept_prepare' && typeof body.txToSignSafeJson === 'string' && body.txToSignSafeJson && Array.isArray(body.inputsToSign)) {
        updateFillPanel({
          summary: 'Signing swap inputs…',
          status: 'Generating taker signatures (stage 1)…',
          psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
          sendText: JSON.stringify(lastSendContext || {}, null, 2),
          canConfirm: false,
          buttonLabel: 'Signing…'
        });

        signInputsForTxShape(body.txToSignSafeJson, body.inputsToSign, priv0Hex, body)
          .then(function (takerInputSigs) {
            lastTakerInputSigs = takerInputSigs;
            return postWalletSend({
              swapStage: 'submit',
              acceptRid: String(body.acceptRid || ''),
              takerInputSigs: takerInputSigs
            });
          })
          .then(handleSwapMeta)
          .catch(function (err) {
            console.error('offers.fillConfirm sign stage failed', err);
            finishErr(null, String(err && err.message ? err.message : err));
          });
        return;
      }

      if (body.stage === 'swap_accept_resign_prepare' && typeof body.txToResignSafeJson === 'string' && body.txToResignSafeJson && Array.isArray(body.inputsToSign)) {
        updateFillPanel({
          summary: 'Re-signing swap inputs…',
          status: 'Generating taker signatures (resign stage)…',
          psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
          sendText: JSON.stringify(lastSendContext || {}, null, 2),
          canConfirm: false,
          buttonLabel: 'Signing…'
        });

        signInputsForTxShape(body.txToResignSafeJson, body.inputsToSign, priv0Hex, body)
          .then(function (takerResignInputSigs) {
            if (!Array.isArray(lastTakerInputSigs) || lastTakerInputSigs.length !== body.inputsToSign.length) {
              throw new Error('Missing prior taker signatures for resign stage. Retry from start.');
            }
            return postWalletSend({
              swapStage: 'resign_submit',
              acceptRid: String(body.acceptRid || ''),
              takerInputSigs: lastTakerInputSigs,
              takerResignInputSigs: takerResignInputSigs
            });
          })
          .then(handleSwapMeta)
          .catch(function (err) {
            console.error('offers.fillConfirm resign sign stage failed', err);
            finishErr(null, String(err && err.message ? err.message : err));
          });
        return;
      }

      finishOk(body.txid);
    }

    postWalletSend(null)
      .then(handleSwapMeta)
      .catch(function (err) {
        console.error('offers.fillConfirm error', err);
        isSigningFill = false;

        updateFillPanel({
          summary: 'PSKT fill failed to submit.',
          status: 'Error contacting /api/wallet/send: ' + err,
          psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
          sendText: JSON.stringify(lastSendContext || {}, null, 2),
          canConfirm: true,
          buttonLabel: 'Retry Confirm & Sign'
        });

        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry Confirm & Sign';
        }
      });
  }

  function handleFillClick(offer, clickedButton) {
    var offerId = offer && (offer.offerId || offer.offer_id || '');
    var fillSize = offer && (offer.sellAmount || offer.sell_amount || '');
    if (!offerId || !fillSize) {
      updateFillPanel({
        summary: 'Unable to prepare fill for this offer.',
        status: 'Offer is missing sellAmount or offerId.',
        psktText: '',
        sendText: ''
      });
      return;
    }

    lastPsktRequest = null;
    lastSendContext = null;
    isSigningFill = false;

    if (isKcc20AtomicDirectOffer(offer)) {
      handleKcc20AtomicDirectClaimClick(offer, clickedButton || null);
      return;
    }

    if (!takerWallet || !takerWallet.address) {
      updateFillPanel({
        summary: 'Unable to prepare fill for offer ' + offerId + '.',
        status: 'Active wallet address not available for fills. ' +
                'Open the KRC wallet page first.',
        psktText: '',
        sendText: ''
      });
      return;
    }

    var startFillPrepare = function () {
      updateFillPanel({
        summary: 'Preparing PSKT fill for offer ' + offerId + '…',
        status: 'Contacting /api/offers/accept…',
        psktText: '',
        sendText: ''
      });

      var body = {
        offerId: offerId,
        fillSize: String(fillSize),
        takerWallet: {
          wid: takerWallet.wid || '',
          address: takerWallet.address
        }
      };

      fetch('/api/offers/accept', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (out) {
          if (!out || out.ok === false) {
            var reason = (out && out.reason) || 'accept_failed';
            var blockers = (out && out.blockers && out.blockers.join(', ')) || '';

            lastPsktRequest = null;
            lastSendContext = null;

            updateFillPanel({
              summary: 'Fill preview failed for offer ' + offerId + '.',
              status: 'Reason: ' + reason + (blockers ? ' — ' + blockers : ''),
              psktText: '',
              sendText: '',
              canConfirm: false,
              buttonLabel: 'Confirm & Sign Swap'
            });
            return;
          }

          var sendCtx = out.sendContext || {};
          var off     = out.offer || offer || {};
          var sendAmt   = sendCtx.amount || '?';
          var sendAsset = sendCtx.assetId || sendCtx.assetKind || '?';
          var sendAddr  = sendCtx.address || takerWallet.address || '?';
          var recvAmt   = off.buyAmount || off.buy_amount || '?';
          var recvSym   = (off.buy && (off.buy.symbol || off.buy.ticker || off.buy.assetId)) || '?';

          var summary = 'You will send ' + sendAmt + ' ' + sendAsset +
                        ' from ' + sendAddr +
                        ' to fill offer ' + offerId +
                        ' and receive ' + recvAmt + ' ' + recvSym + '.';

          lastPsktRequest = out.psktRequest || null;
          lastSendContext = sendCtx;

          var psktText = JSON.stringify(lastPsktRequest || {}, null, 2);
          var sendText = JSON.stringify(lastSendContext || {}, null, 2);

          var canConfirm = !!(lastPsktRequest && lastSendContext);
          var statusMsg = 'Ready to sign. Review the PSKT details, then click "Confirm & Sign Swap".';
          var takerFeeOk = null;

          if (canConfirm) {
            var balSompi = null;
            var balStr = takerWallet && takerWallet.sompi ? String(takerWallet.sompi).trim() : '';
            if (/^\d+$/.test(balStr)) balSompi = BigInt(balStr);

            var sendSompi = kasToSompiStrict(String(sendCtx.amount || '').trim());
            var feeBuf = 50000n;

            if (balSompi === null) {
              canConfirm = false;
              statusMsg = 'Unable to check active wallet balance. Open the wallet page and retry.';
            } else if (sendSompi === null || sendSompi <= 0n) {
              canConfirm = false;
              statusMsg = 'Invalid KAS amount for this fill.';
            } else if (sendSompi + feeBuf > balSompi) {
              canConfirm = false;
              takerFeeOk = false;
              statusMsg =
                'Insufficient KAS balance for this fill. Need about ' +
                sompiToKasStr(sendSompi + feeBuf) +
                ' KAS (incl fee buffer), have ' +
                sompiToKasStr(balSompi) +
                ' KAS.';
            } else {
              takerFeeOk = true;
            }
          }

          var offered = off.buy && typeof off.buy === 'object' ? off.buy : {};
          var offeredSymbolRaw = typeof offered.symbol === 'string' ? String(offered.symbol).trim() : '';
          var sellSymbol = '';
          if (/^CA:/i.test(offeredSymbolRaw)) {
            var ca = offeredSymbolRaw.slice(3).trim().toLowerCase();
            sellSymbol = /^[0-9a-f]{64}$/.test(ca) ? ('CA:' + ca) : '';
          } else if (/^TICK:/i.test(offeredSymbolRaw)) {
            var tick = offeredSymbolRaw.slice(5).trim().toUpperCase();
            sellSymbol = /^[A-Za-z0-9]{1,16}$/.test(tick) ? tick : '';
          } else if (typeof off.ca === 'string') {
            var caFallback = String(off.ca).trim().toLowerCase();
            sellSymbol = /^[0-9a-f]{64}$/.test(caFallback) ? ('CA:' + caFallback) : '';
          } else if (typeof off.tick === 'string') {
            var tickFallback = String(off.tick).trim().toUpperCase();
            sellSymbol = /^[A-Za-z0-9]{1,16}$/.test(tickFallback) ? tickFallback : '';
          }

          var sellAmount = String(off.buyAmount || off.buy_amount || '').trim();
          var buyAmount = String(off.sellAmount || off.sell_amount || '').trim();
          var recvAddr = typeof off.makerReceiveAddress === 'string' ? String(off.makerReceiveAddress).trim() : '';
          var analyzerPayload = sellSymbol && sellAmount ? {
            sell: {
              type: 'KRC20',
              symbol: sellSymbol
            },
            buy: {
              type: 'KAS',
              symbol: 'KAS'
            },
            amount: sellAmount,
            sell_amount: sellAmount,
            buy_amount: buyAmount,
            ttl: typeof off.ttl === 'number' ? off.ttl : (Number(off.ttl || 0) || 0),
            partial: { enabled: false },
            maker: {
              wid: typeof off.makerWalletId === 'string' ? String(off.makerWalletId).trim() : '',
              fromAddr: recvAddr
            },
            receiveEndpoint: {
              address: recvAddr
            }
          } : null;

          var finishRender = function (analyzerState) {
            updateFillPanel({
              summary: summary,
              status: statusMsg,
              psktText: psktText,
              sendText: sendText,
              canConfirm: canConfirm,
              buttonLabel: 'Confirm & Sign Swap',
              analyzerState: analyzerState || null
            });
          };

          if (!analyzerPayload) {
            finishRender(null);
            return;
          }

          fetch('/api/offers/analyze', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(analyzerPayload)
          })
            .then(function (res) {
              return res.json()
                .catch(function () { return {}; })
                .then(function (body) {
                  return { httpOk: res.ok, status: res.status, body: body || {} };
                });
            })
            .then(function (analyzeRes) {
              var analyzerState = null;
              var analyzed = analyzeRes && analyzeRes.httpOk ? analyzeRes.body : null;
              if (analyzed && typeof analyzed === 'object') {
                var analyzedOut = Object.assign({}, analyzed);
                var solvency = analyzedOut.solvency && typeof analyzedOut.solvency === 'object'
                  ? Object.assign({}, analyzedOut.solvency)
                  : {};
                var fees = analyzedOut.fees && typeof analyzedOut.fees === 'object'
                  ? Object.assign({}, analyzedOut.fees)
                  : {};

                if (lastPsktRequest && lastSendContext) {
                  solvency.sell_ok = true;
                }
                if (typeof takerFeeOk === 'boolean') {
                  solvency.fee_ok = takerFeeOk;
                }

                analyzedOut.solvency = solvency;
                analyzedOut.fees = fees;

                var notes = Array.isArray(analyzedOut.notes) ? analyzedOut.notes.filter(function (note) {
                  var text = String(note || '').trim();
                  return text.indexOf('Analyzer: holdings lookup') !== 0;
                }) : [];

                analyzerState = {
                  out: analyzedOut,
                  payload: analyzerPayload,
                  blockers: Array.isArray(analyzedOut.blockers) ? analyzedOut.blockers.slice() : [],
                  notes: notes,
                  paymentDisplayLabel: 'KAS',
                  fromAddress: typeof sendCtx.fromAddress === 'string'
                    ? String(sendCtx.fromAddress).trim()
                    : String(sendCtx.address || '').trim()
                };
              }
              finishRender(analyzerState);
            })
            .catch(function () {
              finishRender(null);
            });
        })
        .catch(function (err) {
          console.error('offers.accept error', err);
          lastPsktRequest = null;
          lastSendContext = null;
          updateFillPanel({
            summary: 'Fill preview failed for offer ' + offerId + '.',
            status: 'Error contacting /api/offers/accept: ' + err,
            psktText: '',
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
        });
    };

    if (!offer.complianceOnly) {
      startFillPrepare();
      return;
    }

    updateFillPanel({
      summary: 'Checking compliance wallet requirements for offer ' + offerId + '…',
      status: 'Compliance Only offers require an active, unlocked compliance wallet.',
      psktText: '',
      sendText: '',
      canConfirm: false,
      buttonLabel: 'Confirm & Sign Swap'
    });

    fetch('/api/wallet/status', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (st) {
        if (!st || st.ok !== true) {
          updateFillPanel({
            summary: 'Compliance Only offer cannot be filled right now.',
            status: 'Unable to determine the active wallet. Open the Wallet tab and retry.',
            psktText: '',
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        var walletType = typeof st.wallet_type === 'string' ? String(st.wallet_type).trim() : '';
        var walletId = typeof st.wallet_id === 'string' ? String(st.wallet_id).trim() : '';
        var sess = readKeyringSessionOrNull();
        var sessWalletId = sess && typeof sess.wallet_id === 'string' ? String(sess.wallet_id).trim() : '';
        var sessWalletType = sess && typeof sess.wallet_type === 'string' ? String(sess.wallet_type).trim() : '';
        var sessPriv0Hex = sess && typeof sess.priv0_hex === 'string' ? String(sess.priv0_hex).trim() : '';

        if (walletType !== 'compliance') {
          updateFillPanel({
            summary: 'Compliance Only offer cannot be filled with the active wallet.',
            status: 'Switch to an active compliance wallet, then click Buy again.',
            psktText: '',
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        if (!walletId || sessWalletId !== walletId || sessWalletType !== walletType || !sessPriv0Hex) {
          updateFillPanel({
            summary: 'Compliance Only offer requires an unlocked compliance wallet.',
            status: 'Unlock your compliance wallet in the Wallet tab first, then click Buy again.',
            psktText: '',
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        startFillPrepare();
      })
      .catch(function (err) {
        console.error('offers.wallet.status error', err);
        updateFillPanel({
          summary: 'Compliance Only offer cannot be filled right now.',
          status: 'Unable to verify compliance wallet readiness: ' + err,
          psktText: '',
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
      });
  }

  function renderOffers(items) {
    var sectionEl = $('directOffersSection');
    var listEl = $('offersList');
    var statusEl = $('offersStatus');
    var fillSectionEl = $('fillSection');
    if (!listEl || !statusEl) return;

    ensureDirectLiveOfferFilterControl();

    var rawItems = sortDirectOffersNewestFirst(items);
    var hideMine = readDirectHideMyLiveOffers();
    var visibleItems = hideMine
      ? rawItems.filter(function (offer) { return !isDirectMineOffer(offer); })
      : rawItems;

    listEl.innerHTML = '';

    if (!visibleItems.length) {
      statusEl.textContent = hideMine && rawItems.length
        ? 'No direct swap offers shown. Your live Direct Swap offers are hidden by the switch.'
        : 'No direct swap offers.';
      listEl.style.display = 'none';
      if (fillSectionEl) fillSectionEl.style.display = 'none';
      if (sectionEl) sectionEl.setAttribute('data-empty', '1');
      return;
    }

    listEl.style.display = '';
    if (sectionEl) sectionEl.removeAttribute('data-empty');
    statusEl.textContent = visibleItems.length + ' direct swap row' + (visibleItems.length === 1 ? '' : 's') +
      ' / ' + visibleItems.length + ' live offer' + (visibleItems.length === 1 ? '' : 's') +
      (hideMine ? ' shown, newest first.' : ', newest first.');

    var table = document.createElement('div');
    table.className = 'grouped-offers-table';

    var header = document.createElement('div');
    header.className = 'grouped-offers-header';
    ['Token', 'Description / Terms', 'Price', 'Available', 'Action'].forEach(function (label) {
      var cell = document.createElement('div');
      cell.textContent = label;
      header.appendChild(cell);
    });
    table.appendChild(header);

    visibleItems.forEach(function (offer) {
      var settlementAsset = offer.sell || {};
      var tokenAsset = offer.buy || {};
      var tokenAmount = String(offer && offer.buyAmount != null ? offer.buyAmount : '?');
      var settlementAmount = String(offer && offer.sellAmount != null ? offer.sellAmount : '?');
      var catalog = findDirectSponsoredCatalog(offer);
      var isKcc20Atomic = isKcc20AtomicDirectOffer(offer);
      var atomicCovenantId = isKcc20Atomic ? directKcc20AtomicCovenantId(offer, tokenAsset) : '';
      var displayLabel = catalog ? catalog.label : (isKcc20Atomic
        ? directKcc20AtomicTokenDisplayLabel(offer, tokenAsset, 'KCC20 token')
        : fmtCompactAssetLabel(tokenAsset, 'CA token'));
      var settlementLabel = fmtCompactAssetLabel(settlementAsset, 'KAS');
      var isComplianceOnly = !!offer.complianceOnly;
      var isDirected = !!(offer && offer.takerTokenReceiveAddress);
      var expiresAt = directOfferExpiresText(offer);
      var ca = normalizeDirectCa(offer && offer.ca);

      var row = document.createElement('div');
      row.className = 'grouped-offer-row';

      var tokenCell = document.createElement('div');
      var tokenTitle = document.createElement('div');
      tokenTitle.className = 'offer-title';
      tokenTitle.textContent = displayLabel + ' · ' + tokenAmount + ' each';
      tokenCell.appendChild(tokenTitle);

      var badgeWrap = document.createElement('div');
      badgeWrap.style.display = 'flex';
      badgeWrap.style.flexWrap = 'wrap';
      badgeWrap.style.gap = '.25rem';
      badgeWrap.style.marginTop = '.2rem';
      if (catalog) appendDirectBadge(badgeWrap, 'SPONSORED', 'sponsored');
      if (isKcc20Atomic) appendDirectBadge(badgeWrap, 'ATOMIC KCC20', 'atomic');
      if (isComplianceOnly) appendDirectBadge(badgeWrap, 'COMPLIANCE', 'compliance');
      if (badgeWrap.childNodes.length) tokenCell.appendChild(badgeWrap);
      row.appendChild(tokenCell);

      var descCell = document.createElement('div');
      var details = document.createElement('details');
      details.className = 'grouped-offer-inline-details';

      var summary = document.createElement('summary');
      summary.textContent = 'Receive ' + tokenAmount + ' ' + displayLabel + ' per purchase.';
      details.appendChild(summary);

      var terms = document.createElement('p');
      terms.className = 'offer-sub';
      terms.textContent = 'Direct swap. One live offer. Seller receives ' + settlementAmount + ' ' + settlementLabel + '. ' +
        (isDirected ? 'Directed recipient only.' : 'Available to eligible buyers.');
      details.appendChild(terms);

      if (isKcc20Atomic) {
        var atomicTokenName = directKcc20AtomicTokenName(offer, tokenAsset);
        if (atomicTokenName && atomicTokenName !== displayLabel) {
          var atomicNameLine = document.createElement('p');
          atomicNameLine.className = 'offer-sub';
          atomicNameLine.textContent = 'Token name: ' + atomicTokenName;
          details.appendChild(atomicNameLine);
        }
        if (atomicCovenantId) {
          var atomicCovenantLine = document.createElement('p');
          atomicCovenantLine.className = 'offer-sub';
          atomicCovenantLine.textContent = 'Covenant ID: ' + atomicCovenantId;
          details.appendChild(atomicCovenantLine);
        }
      } else if (ca && /^[0-9a-f]{64}$/.test(ca)) {
        var caLine = document.createElement('p');
        caLine.className = 'offer-sub';
        caLine.textContent = 'CA: ' + ca;
        details.appendChild(caLine);
      }

      var settlementLine = document.createElement('p');
      settlementLine.className = 'offer-sub';
      settlementLine.textContent = 'Settlement asset: ' + settlementLabel +
        (expiresAt ? ('. Expires: ' + expiresAt + '.') : '.');
      details.appendChild(settlementLine);

      var createdLabel = directOfferCreatedLabel(offer);
      if (createdLabel) {
        var createdLine = document.createElement('p');
        createdLine.className = 'offer-sub';
        createdLine.textContent = 'Created: ' + createdLabel + ' (newest offers are shown first).';
        details.appendChild(createdLine);
      }

      var shortOutpoint = directOfferShortOutpoint(offer);
      if (shortOutpoint) {
        var outpointLine = document.createElement('p');
        outpointLine.className = 'offer-sub';
        outpointLine.textContent = 'Swap outpoint: ' + shortOutpoint;
        details.appendChild(outpointLine);
      }

      descCell.appendChild(details);
      row.appendChild(descCell);

      var priceCell = document.createElement('div');
      priceCell.textContent = settlementAmount + ' KAS';
      row.appendChild(priceCell);

      var availableCell = document.createElement('div');
      availableCell.textContent = '1 live';
      row.appendChild(availableCell);

      var actionCell = document.createElement('div');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = isKcc20AtomicDirectOffer(offer) ? 'Claim' : 'Buy';
      btn.dataset.offerId = offer.offerId || '';
      btn.addEventListener('click', function () {
        handleFillClick(offer, btn);
      });
      actionCell.appendChild(btn);
      row.appendChild(actionCell);

      table.appendChild(row);
    });

    listEl.appendChild(table);
  }

  function mySwapText(value) {
    return String(value == null ? '' : value).trim();
  }

  function mySwapDetailLine(label, value) {
    var text = mySwapText(value);
    return text ? (label + ': ' + text) : '';
  }

  function mySwapKasAmountNumber(value) {
    var text = mySwapText(value).replace(/\s*KAS\s*$/i, '').trim();
    if (!text) return NaN;
    var n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  }

  function isKcc20AtomicOpenLegacyUnrecoverableReason(reason) {
    var text = mySwapText(reason).toLowerCase();
    return text.indexOf('kcc20_atomic_open_swap_maker_refund_policy_body_hash_mismatch') >= 0 ||
      text.indexOf('policy_body_hash_mismatch') >= 0;
  }

  function isKcc20AtomicOpenUnderMinimumKasPrice(value) {
    var n = mySwapKasAmountNumber(value);
    return Number.isFinite(n) && n < 1;
  }

  function mySwapListingHistoryDetails(item, offerId) {
    var details = [];
    var idText = mySwapText(offerId || (item && item.offerId));
    if (idText) details.push('Offer ID: ' + idText);
    var createdAt = mySwapDetailLine('Created', item && item.createdAt);
    var updatedAt = mySwapDetailLine('Updated', item && item.updatedAt);
    var expiresAt = mySwapDetailLine('Expires', item && item.expiresAt);
    var cancelledAt = mySwapDetailLine('Cancelled', item && item.cancelledAt);
    var cancelFailedAt = mySwapDetailLine('Cancel failed', item && item.cancelFailedAt);
    [createdAt, updatedAt, expiresAt, cancelledAt, cancelFailedAt].forEach(function (line) {
      if (line) details.push(line);
    });
    return details;
  }

  function mySwapAssetLabelFromDirect(asset, fallback) {
    return fmtCompactAssetLabel(asset || {}, fallback || 'Asset');
  }

  function mySwapAssetLabelFromOpen(item) {
    var name = mySwapText(item && item.sellName);
    if (name) return name;
    var symbol = mySwapText(item && item.sellSymbol);
    if (!symbol) return 'Asset';
    var ca = normalizeDirectCa(symbol);
    if (/^[0-9a-f]{64}$/i.test(ca)) return 'CA token';
    if (/^CA:/i.test(symbol)) return 'CA token';
    return symbol;
  }

  function normalizeMySwapRows(kind, items) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      if (!item || typeof item !== 'object') return null;

      if (kind === 'open') {
        var isAtomicOpen = isKcc20AtomicOpenOffer(item);
        var openLabel = isAtomicOpen ? kcc20AtomicOpenOfferTokenLabel(item, 'KCC20 token') : mySwapAssetLabelFromOpen(item);
        var openTokenName = isAtomicOpen ? kcc20AtomicOpenOfferTokenName(item) : '';
        var openSellAmount = mySwapText(item.sellAmount || '?');
        var openBuyAmount = mySwapText(item.buyAmountKas || '?');
        var openCancelFailureReason = mySwapText(item.cancelFailureReason);
        var openLegacyUnrecoverable = !!(isAtomicOpen && (
          isKcc20AtomicOpenLegacyUnrecoverableReason(openCancelFailureReason) ||
          isKcc20AtomicOpenUnderMinimumKasPrice(openBuyAmount)
        ));
        var openSourceOutpointKey = isAtomicOpen ? kcc20AtomicOpenOfferSourceOutpoint(item) : '';
        var openCovenantId = isAtomicOpen ? kcc20AtomicOpenOfferCovenantId(item) : '';
        var openDetails = [
          openTokenName && openTokenName !== openLabel ? ('Token name: ' + openTokenName) : '',
          item.sellSymbol ? ('Offered asset: ' + item.sellSymbol) : '',
          openSourceOutpointKey ? ('Swap outpoint: ' + openSourceOutpointKey) : '',
          openCovenantId ? ('Covenant ID: ' + openCovenantId) : '',
          isAtomicOpen ? 'KCC20 Atomic Open maker-lock: cancel/refund uses the on-chain maker-refund route.' : '',
          openLegacyUnrecoverable ? 'Legacy test artifact: not included in automatic recovery by the current KCC20 Open policy route.' : '',
          openCancelFailureReason ? ('Cancel failure reason: ' + openCancelFailureReason) : ''
        ].filter(Boolean);
        return {
          source: 'open',
          offerId: mySwapText(item.offerId),
          state: mySwapText(item.state) || 'open',
          expiresAt: mySwapText(item.expiresAt),
          title: openLabel + ' · ' + openSellAmount + ' each',
          summary: (isAtomicOpen ? 'Open KCC20 atomic swap. Sell ' : 'Open swap. Sell ') + openSellAmount + ' ' + openLabel + ' for ' + openBuyAmount + ' KAS.',
          price: openBuyAmount + ' KAS',
          details: openDetails,
          historyDetails: mySwapListingHistoryDetails(item, item.offerId),
          cancelTxid: mySwapText(item.cancelTxid),
          cancelledAt: mySwapText(item.cancelledAt),
          cancelFailedAt: mySwapText(item.cancelFailedAt),
          cancelFailureReason: openCancelFailureReason,
          cancelFailureCount: Number(item.cancelFailureCount || 0),
          isAtomicOpen: isAtomicOpen,
          atomicOpenLegacyUnrecoverable: openLegacyUnrecoverable,
          sourceOutpointKey: openSourceOutpointKey
        };
      }

      var tokenAsset = item.buy || {};
      var settlementAsset = item.sell || {};
      var isAtomicDirect = isKcc20AtomicDirectOffer(item);
      var tokenLabel = isAtomicDirect
        ? directKcc20AtomicTokenDisplayLabel(item, tokenAsset, 'KCC20 token')
        : mySwapAssetLabelFromDirect(tokenAsset, 'CA token');
      var atomicTokenName = isAtomicDirect ? directKcc20AtomicTokenName(item, tokenAsset) : '';
      var settlementLabel = mySwapAssetLabelFromDirect(settlementAsset, 'KAS');
      var directBuyAmount = mySwapText(item.buyAmount || '?');
      var directSellAmount = mySwapText(item.sellAmount || '?');
      var atomicCovenantId = isAtomicDirect ? directKcc20AtomicCovenantId(item, tokenAsset) : '';
      var sourceOutpointKey = kcc20AtomicOfferSourceOutpoint(item);
      var atomicOfferExpiresAt = isAtomicDirect ? directOfferExpiresText(item) : mySwapText(item && item.expiresAt);
      var atomicOfferExpired = !!(isAtomicDirect && directOfferIsExpired(item));
      var atomicDetails = isAtomicDirect ? [
        atomicTokenName && atomicTokenName !== tokenLabel ? ('Token name: ' + atomicTokenName) : '',
        sourceOutpointKey ? ('Swap outpoint: ' + sourceOutpointKey) : '',
        atomicCovenantId ? ('Covenant ID: ' + atomicCovenantId) : '',
        atomicOfferExpiresAt ? ('Expires: ' + atomicOfferExpiresAt) : '',
        atomicOfferExpired ? 'Expired: recovery available to maker wallet' : '',
        item.refund_lock_daa ? ('Maker refund lock DAA: ' + item.refund_lock_daa) : '',
        item.takerTokenReceiveAddress ? ('Fixed taker token receive address: ' + item.takerTokenReceiveAddress) : ''
      ].filter(Boolean) : [];
      return {
        source: 'direct',
        offerId: mySwapText(item.offerId),
        state: mySwapText(item.state) || 'open',
        expiresAt: atomicOfferExpiresAt,
        ttl: directOfferTtlSeconds(item),
        offerExpired: atomicOfferExpired,
        title: tokenLabel + ' · ' + directBuyAmount + ' each',
        summary: (isAtomicDirect ? 'Atomic KCC20 direct swap. Sell ' : 'Direct swap. Sell ') + directBuyAmount + ' ' + tokenLabel + ' for ' + directSellAmount + ' ' + settlementLabel + '.',
        price: directSellAmount + ' KAS',
        details: [
          item.ca ? ('CA: ' + normalizeDirectCa(item.ca)) : ''
        ].filter(Boolean).concat(atomicDetails),
        historyDetails: mySwapListingHistoryDetails(item, item.offerId),
        isAtomicDirect: isAtomicDirect,
        sourceOutpointKey: sourceOutpointKey
      };
    }).filter(function (row) { return !!(row && row.offerId); });
  }

  function groupMySwapRows(rows) {
    var groups = [];
    var byKey = Object.create(null);

    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !row.offerId) return;
      var key = [row.source, row.state, row.title, row.summary, row.price].join('|');
      var group = byKey[key];

      if (!group) {
        group = {
          source: row.source,
          offerId: row.offerId,
          offerIds: [],
          state: row.state,
          title: row.title,
          summary: row.summary,
          price: row.price,
          details: row.details ? row.details.slice() : [],
          historyDetails: [],
          count: 0,
          isAtomicDirect: !!row.isAtomicDirect,
          isAtomicOpen: !!row.isAtomicOpen,
          atomicOpenLegacyUnrecoverable: !!row.atomicOpenLegacyUnrecoverable,
          offerExpired: !!row.offerExpired,
          sourceOutpointKey: row.sourceOutpointKey || '',
          sourceOutpointKeys: []
        };
        byKey[key] = group;
        groups.push(group);
      }

      group.count += 1;
      if (row.isAtomicOpen) group.isAtomicOpen = true;
      if (row.atomicOpenLegacyUnrecoverable) group.atomicOpenLegacyUnrecoverable = true;
      if (row.state === 'open') group.offerIds.push(row.offerId);
      if (row.sourceOutpointKey) group.sourceOutpointKeys.push(row.sourceOutpointKey);
      if (!group.sourceOutpointKey && row.sourceOutpointKey) group.sourceOutpointKey = row.sourceOutpointKey;
      if (row.offerExpired) group.offerExpired = true;
      if (Array.isArray(row.historyDetails) && row.historyDetails.length) {
        if (group.count > 1) group.historyDetails.push('—');
        group.historyDetails = group.historyDetails.concat(row.historyDetails);
      }
    });

    groups.forEach(function (group) {
      var count = Number(group.count || 0);
      if (group.historyDetails && group.historyDetails.length) {
        group.details = group.details.concat(group.historyDetails);
      }
      if (count > 1) {
        group.details = group.details.concat([count + ' matching listing' + (count === 1 ? '' : 's') + ' in this row. Cancel/Expire removes one listing at a time.']);
      }
      group.statusText = count > 1 ? (count + ' ' + group.state) : group.state;
      if (group.isAtomicDirect && group.offerExpired && group.state === 'atomic_locked') group.statusText = 'expired — recovery needed';
      if (group.isAtomicOpen && group.state === 'expired') group.statusText = 'expired — refund available';
      if (group.isAtomicOpen && group.atomicOpenLegacyUnrecoverable) group.statusText = 'legacy — recovery unavailable';
      if (group.state === 'open' && group.offerIds.length) group.offerId = group.offerIds[0];
      if ((group.state === 'atomic_locked' || group.isAtomicOpen) && group.sourceOutpointKeys.length) group.sourceOutpointKey = group.sourceOutpointKeys[0];
    });

    return groups;
  }

  function setMySwapsStatus(text) {
    var statusEl = $('mySwapsStatus');
    if (statusEl) statusEl.textContent = text;
  }

  function ensureExpiredOpenSwapBatchModal() {
    var existing = $('expiredOpenSwapBatchModal');
    if (existing) return existing;

    var overlay = document.createElement('div');
    overlay.id = 'expiredOpenSwapBatchModal';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(0,0,0,.68)';
    overlay.style.padding = '1rem';

    var card = document.createElement('div');
    card.style.width = 'min(520px, 94vw)';
    card.style.borderRadius = '18px';
    card.style.border = '1px solid rgba(151, 101, 12, .75)';
    card.style.background = '#fff7df';
    card.style.color = '#1a160d';
    card.style.boxShadow = '0 24px 80px rgba(0,0,0,.42)';
    card.style.padding = '1.15rem';

    var title = document.createElement('div');
    title.id = 'expiredOpenSwapBatchModalTitle';
    title.style.fontWeight = '800';
    title.style.fontSize = '1.05rem';
    title.style.marginBottom = '.65rem';
    card.appendChild(title);

    var body = document.createElement('div');
    body.id = 'expiredOpenSwapBatchModalBody';
    body.style.lineHeight = '1.45';
    body.style.color = '#2a2418';
    card.appendChild(body);

    var detail = document.createElement('div');
    detail.id = 'expiredOpenSwapBatchModalDetail';
    detail.style.marginTop = '.8rem';
    detail.style.fontWeight = '700';
    detail.style.color = '#111';
    card.appendChild(detail);

    var actions = document.createElement('div');
    actions.id = 'expiredOpenSwapBatchModalActions';
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '.6rem';
    actions.style.marginTop = '1rem';
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return overlay;
  }

  function setExpiredOpenSwapBatchModalText(titleText, bodyText, detailText) {
    var overlay = ensureExpiredOpenSwapBatchModal();
    var title = $('expiredOpenSwapBatchModalTitle');
    var body = $('expiredOpenSwapBatchModalBody');
    var detail = $('expiredOpenSwapBatchModalDetail');
    if (title) title.textContent = titleText || '';
    if (body) body.textContent = bodyText || '';
    if (detail) detail.textContent = detailText || '';
    overlay.style.display = 'flex';
  }

  function setExpiredOpenSwapBatchModalActions(buttons) {
    var actions = $('expiredOpenSwapBatchModalActions');
    if (!actions) return;
    actions.innerHTML = '';
    (Array.isArray(buttons) ? buttons : []).forEach(function (cfg) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = cfg && cfg.primary ? 'primary' : 'secondary';
      btn.textContent = cfg && cfg.label ? cfg.label : 'OK';
      btn.disabled = !!(cfg && cfg.disabled);
      btn.addEventListener('click', function () {
        if (cfg && typeof cfg.onClick === 'function') cfg.onClick();
      });
      actions.appendChild(btn);
    });
  }

  function hideExpiredOpenSwapBatchModal() {
    var overlay = $('expiredOpenSwapBatchModal');
    if (overlay) overlay.style.display = 'none';
  }

  function chooseExpiredOpenSwapBatch(count) {
    return new Promise(function (resolve) {
      setExpiredOpenSwapBatchModalText(
        'Expired Open Swap Recovery',
        'You have ' + count + ' expired Open Swap offer' + (count === 1 ? '' : 's') + ' that still need on-chain cancellation. Cancel them now to return listed tokens to your wallet?',
        ''
      );
      setExpiredOpenSwapBatchModalActions([
        {
          label: 'Later',
          primary: false,
          onClick: function () { hideExpiredOpenSwapBatchModal(); resolve(false); }
        },
        {
          label: 'Cancel Expired Offers',
          primary: true,
          onClick: function () { resolve(true); }
        }
      ]);
    });
  }

  function showExpiredOpenSwapBatchDone(okCount, failCount) {
    setExpiredOpenSwapBatchModalText(
      'Expired Open Swap Recovery Complete',
      okCount + ' recovered, ' + failCount + ' failed.',
      'Click Close to refresh offers and balances.'
    );
    setExpiredOpenSwapBatchModalActions([
      {
        label: 'Close',
        primary: true,
        onClick: function () { window.location.reload(); }
      }
    ]);
  }

  function updateExpiredOpenSwapBatchProgress(message) {
    var overlay = $('expiredOpenSwapBatchModal');
    if (!overlay || overlay.style.display === 'none') return;
    setExpiredOpenSwapBatchModalText('Expired Open Swap Recovery', 'Please keep this page open while expired offers are cancelled on chain.', message || 'Working…');
    setExpiredOpenSwapBatchModalActions([]);
  }

  function renderMySwaps(rows, includeHistory) {
    var listEl = $('mySwapsList');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'grouped-offer-empty';
      empty.textContent = includeHistory
        ? 'No Direct or Open Swap offers were found for your active wallet.'
        : 'No live Direct or Open Swap offers were found for your active wallet.';
      listEl.appendChild(empty);
      return;
    }

    var table = document.createElement('div');
    table.className = 'grouped-offers-table';

    var header = document.createElement('div');
    header.className = 'grouped-offers-header';
    ['Token', 'Description / Terms', 'Price', 'Status', 'Action'].forEach(function (label) {
      var cell = document.createElement('div');
      cell.textContent = label;
      header.appendChild(cell);
    });
    table.appendChild(header);

    rows.forEach(function (rowData) {
      var row = document.createElement('div');
      row.className = 'grouped-offer-row';

      var tokenCell = document.createElement('div');
      var tokenTitle = document.createElement('div');
      tokenTitle.className = 'offer-title';
      tokenTitle.textContent = rowData.title;
      tokenCell.appendChild(tokenTitle);
      var mode = document.createElement('div');
      mode.className = 'offer-sub';
      mode.textContent = rowData.source === 'open' ? 'Open Swap' : 'Direct Swap';
      tokenCell.appendChild(mode);
      row.appendChild(tokenCell);

      var descCell = document.createElement('div');
      var details = document.createElement('details');
      details.className = 'grouped-offer-inline-details';
      var summary = document.createElement('summary');
      summary.textContent = rowData.summary;
      details.appendChild(summary);
      rowData.details.forEach(function (line) {
        var p = document.createElement('p');
        p.className = 'offer-sub';
        p.textContent = line;
        details.appendChild(p);
      });
      descCell.appendChild(details);
      row.appendChild(descCell);

      var priceCell = document.createElement('div');
      priceCell.textContent = rowData.price;
      row.appendChild(priceCell);

      var stateCell = document.createElement('div');
      stateCell.textContent = rowData.statusText || rowData.state;
      row.appendChild(stateCell);

      var actionCell = document.createElement('div');
      if ((rowData.state === 'open' && rowData.offerId && !rowData.isAtomicOpen) || (rowData.isAtomicOpen && !rowData.atomicOpenLegacyUnrecoverable && !rowData.cancelFailedAt && !rowData.cancelFailureReason && (rowData.state === 'open' || rowData.state === 'expired') && rowData.sourceOutpointKey) || (rowData.isAtomicDirect && rowData.state === 'atomic_locked' && rowData.sourceOutpointKey)) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary';
        btn.textContent = rowData.isAtomicDirect && rowData.state === 'atomic_locked'
          ? (rowData.offerExpired ? 'Recover' : 'Cancel/Refund')
          : (rowData.isAtomicOpen ? 'Cancel/Refund' : 'Cancel/Expire');
        btn.addEventListener('click', function () {
          handleMySwapExpire(rowData);
        });
        actionCell.appendChild(btn);
      } else {
        var muted = document.createElement('span');
        muted.className = 'muted';
        muted.textContent = '—';
        actionCell.appendChild(muted);
      }
      row.appendChild(actionCell);

      table.appendChild(row);
    });

    listEl.appendChild(table);
  }

  function fetchMySwapGroup(url) {
    return fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  function loadMySwaps() {
    var listEl = $('mySwapsList');
    if (!listEl) return;

    var showHistoryEl = $('mySwapsShowHistory');
    var includeHistory = !!(showHistoryEl && showHistoryEl.checked);
    var historyFlag = includeHistory ? '1' : '0';

    setMySwapsStatus('Loading your swaps…');

    Promise.all([
      fetchMySwapGroup('/api/offers/mine?history=' + historyFlag),
      fetchMySwapGroup('/api/open-swaps/mine?history=' + historyFlag)
    ])
      .then(function (results) {
        var direct = results[0] || {};
        var open = results[1] || {};

        if (direct.ok === false) throw new Error(direct.reason || 'direct_mine_failed');
        if (open.ok === false) throw new Error(open.reason || 'open_mine_failed');

        var rows = []
          .concat(normalizeMySwapRows('direct', direct.items || []))
          .concat(normalizeMySwapRows('open', open.items || []));
        var groupedRows = groupMySwapRows(rows);

        setMySwapsStatus(groupedRows.length + ' swap row' + (groupedRows.length === 1 ? '' : 's') +
          ' / ' + rows.length + ' listing' + (rows.length === 1 ? '' : 's') +
          (includeHistory ? ' found in history.' : ' live for your active wallet.'));
        renderMySwaps(groupedRows, includeHistory);
        if (!includeHistory) {
          window.setTimeout(promptAndBatchCancelExpiredOpenSwaps, 500);
          window.setTimeout(promptAndBatchRecoverExpiredKcc20AtomicSwaps, 900);
          window.setTimeout(promptAndBatchRecoverExpiredKcc20AtomicOpenSwaps, 1300);
        }
      })
      .catch(function (err) {
        setMySwapsStatus('Error loading your swaps.');
        listEl.innerHTML = '';
        var empty = document.createElement('div');
        empty.className = 'grouped-offer-empty';
        empty.textContent = String(err && err.message ? err.message : err);
        listEl.appendChild(empty);
        console.error('my swaps load error', err);
      });
  }

  function refundKcc20AtomicDirectMaker(rowData, priv0Hex, statusPrefix) {
    var prefix = statusPrefix ? String(statusPrefix) + ': ' : '';
    setMySwapsStatus(prefix + 'Preparing KCC20 Atomic Direct Swap refund…');
    updateExpiredOpenSwapBatchProgress(prefix + 'Preparing KCC20 Atomic Direct Swap refund…');
    return buildKcc20AtomicDirectMakerRefund(rowData)
      .then(function (build) {
        setMySwapsStatus(prefix + 'Signing KCC20 Atomic Direct Swap refund…');
        updateExpiredOpenSwapBatchProgress(prefix + 'Signing KCC20 Atomic Direct Swap refund…');
        return signKcc20AtomicDirectMakerRefund(build, priv0Hex)
          .then(function (signed) { return { build: build, signed: signed }; });
      })
      .then(function (ctx) {
        setMySwapsStatus(prefix + 'Submitting KCC20 Atomic Direct Swap refund…');
        updateExpiredOpenSwapBatchProgress(prefix + 'Submitting KCC20 Atomic Direct Swap refund…');
        return submitKcc20AtomicDirectMakerRefund(ctx.build, ctx.signed)
          .then(function (submitOut) { return { build: ctx.build, signed: ctx.signed, submitOut: submitOut }; });
      });
  }

  function refundKcc20AtomicOpenMaker(rowData, priv0Hex, statusPrefix) {
    var prefix = statusPrefix ? String(statusPrefix) + ': ' : '';
    setMySwapsStatus(prefix + 'Preparing KCC20 Atomic Open Swap cancel/refund…');
    updateExpiredOpenSwapBatchProgress(prefix + 'Preparing KCC20 Atomic Open Swap cancel/refund…');
    return buildKcc20AtomicOpenMakerRefund(rowData)
      .then(function (build) {
        setMySwapsStatus(prefix + 'Signing KCC20 Atomic Open Swap cancel/refund…');
        updateExpiredOpenSwapBatchProgress(prefix + 'Signing KCC20 Atomic Open Swap cancel/refund…');
        return signKcc20AtomicOpenMakerRefund(build, priv0Hex)
          .then(function (signed) { return { build: build, signed: signed }; });
      })
      .then(function (ctx) {
        setMySwapsStatus(prefix + 'Submitting KCC20 Atomic Open Swap cancel/refund…');
        updateExpiredOpenSwapBatchProgress(prefix + 'Submitting KCC20 Atomic Open Swap cancel/refund…');
        return submitKcc20AtomicOpenMakerRefund(ctx.build, ctx.signed)
          .then(function (submitOut) { return { build: ctx.build, signed: ctx.signed, submitOut: submitOut }; });
      });
  }

  function handleKcc20AtomicDirectMakerRefund(rowData) {
    var sourceOutpointKey = normalizeDirectText(rowData && rowData.sourceOutpointKey);
    if (!/^[0-9a-f]{64}:\d+$/i.test(sourceOutpointKey)) {
      setMySwapsStatus('Unable to refund atomic swap: missing swap outpoint.');
      return;
    }

    var ok = window.confirm('Cancel/refund this KCC20 Atomic Direct Swap? This signs and submits an on-chain refund.');
    if (!ok) return;

    var priv0Hex = getKeyringPriv0Hex();
    if (!priv0Hex) {
      setMySwapsStatus('Wallet is locked. Unlock the maker wallet before refunding this atomic swap.');
      return;
    }

    refundKcc20AtomicDirectMaker(rowData, priv0Hex, '')
      .then(function (result) {
        var summary = atomicMakerRefundPublicSummary(result.build, result.signed, result.submitOut);
        setMySwapsStatus('KCC20 Atomic Direct Swap refunded. Txid: ' + (summary.submitted_txid || 'unknown') + '. Refreshing offers…');
        window.setTimeout(function () { window.location.reload(); }, 800);
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        var response = err && err.response ? err.response : null;
        if (response && response.error) msg += ' ' + String(response.error);
        setMySwapsStatus('Unable to refund KCC20 Atomic Direct Swap: ' + msg);
        console.error('my swaps atomic maker refund error', err);
      });
  }

  function handleKcc20AtomicOpenMakerRefund(rowData) {
    var sourceOutpointKey = normalizeDirectText(rowData && rowData.sourceOutpointKey);
    if (!/^[0-9a-f]{64}:\d+$/i.test(sourceOutpointKey)) {
      setMySwapsStatus('Unable to cancel/refund Open KCC20 swap: missing swap outpoint.');
      return;
    }

    var ok = window.confirm('Cancel/refund this KCC20 Atomic Open Swap? This signs and submits the proven on-chain maker-refund path.');
    if (!ok) return;

    var priv0Hex = getKeyringPriv0Hex();
    if (!priv0Hex) {
      setMySwapsStatus('Wallet is locked. Unlock the maker wallet before refunding this Open KCC20 swap.');
      return;
    }

    refundKcc20AtomicOpenMaker(rowData, priv0Hex, '')
      .then(function (result) {
        var summary = atomicMakerRefundPublicSummary(result.build, result.signed, result.submitOut);
        setMySwapsStatus('KCC20 Atomic Open Swap cancelled/refunded. Txid: ' + (summary.submitted_txid || 'unknown') + '. Refreshing offers…');
        window.setTimeout(function () { window.location.reload(); }, 800);
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        var response = err && err.response ? err.response : null;
        if (response && response.error) msg += ' ' + String(response.error);
        setMySwapsStatus('Unable to cancel/refund KCC20 Atomic Open Swap: ' + msg);
        console.error('my swaps atomic open maker refund error', err);
      });
  }

  function cancelOpenSwapOnChain(rowData, priv0Hex, statusPrefix) {
    var offerId = rowData && rowData.offerId ? String(rowData.offerId).trim() : '';
    var prefix = statusPrefix ? String(statusPrefix) + ': ' : '';
    if (!offerId) return Promise.reject(new Error('missing_offer_id'));

    setMySwapsStatus(prefix + 'Preparing Open Swap cancellation…');
    updateExpiredOpenSwapBatchProgress(prefix + 'Preparing Open Swap cancellation…');
    return fetch('/api/open-swaps/offer/expire', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ stage: 'prepare', offerId: offerId })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (prepared) {
        if (!prepared || prepared.ok === false) throw new Error((prepared && prepared.reason) || 'open_cancel_prepare_failed');
        if (!prepared.cancelRid) throw new Error('open_cancel_prepare_invalid');

        var prepareStage = typeof prepared.stage === 'string' ? String(prepared.stage).trim() : '';
        var signaturePromise = null;
        setMySwapsStatus(prefix + 'Signing Open Swap cancellation…');
        updateExpiredOpenSwapBatchProgress(prefix + 'Signing Open Swap cancellation…');

        if (prepareStage === 'bcw_open_swap_cancel_intent') {
          if (!prepared.intent_message) throw new Error('bcw_open_swap_cancel_intent_message_missing');
          signaturePromise = signBcwOpenSwapCancelIntent(prepared.intent_message, priv0Hex);
        } else {
          if (!prepared.txToSignSafeJson) throw new Error('open_cancel_prepare_invalid');
          signaturePromise = signOpenSwapCancelInput(prepared.txToSignSafeJson, priv0Hex);
        }

        return signaturePromise
          .then(function (signature0) {
            setMySwapsStatus(prefix + 'Submitting Open Swap cancellation…');
            updateExpiredOpenSwapBatchProgress(prefix + 'Submitting Open Swap cancellation…');
            return fetch('/api/open-swaps/offer/expire', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({
                stage: 'submit',
                offerId: offerId,
                cancelRid: String(prepared.cancelRid || ''),
                signature0: signature0
              })
            });
          });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.reason) || 'open_cancel_submit_failed');
        return data;
      });
  }

  function handleMySwapExpire(rowData) {
    if (!rowData || !rowData.offerId) return;

    var isOpenSwap = rowData.source === 'open';
    var isKcc20Atomic = !!(rowData.isAtomicDirect && rowData.source === 'direct' && rowData.state === 'atomic_locked');
    var isKcc20AtomicOpen = !!(rowData.isAtomicOpen && !rowData.atomicOpenLegacyUnrecoverable && !rowData.cancelFailedAt && !rowData.cancelFailureReason && rowData.source === 'open' && (rowData.state === 'open' || rowData.state === 'expired') && rowData.sourceOutpointKey);
    var isDirectOpen = rowData.source === 'direct' && rowData.state === 'open';
    var isOpenCancelable = isOpenSwap && !rowData.isAtomicOpen && (rowData.state === 'open' || rowData.state === 'expired');
    if (isKcc20Atomic) {
      handleKcc20AtomicDirectMakerRefund(rowData);
      return;
    }
    if (isKcc20AtomicOpen) {
      handleKcc20AtomicOpenMakerRefund(rowData);
      return;
    }
    if (!isDirectOpen && !isOpenCancelable) return;

    var confirmText = isOpenSwap
      ? 'Cancel this Open Swap listing on-chain? This will sign and submit a Kasplex cancellation transaction for the listed order.'
      : 'Cancel/Expire this Direct Swap listing? This only expires the listing. It does not refund or unwind any on-chain commitment.';
    var ok = window.confirm(confirmText);
    if (!ok) return;

    if (isOpenSwap) {
      var priv0Hex = getKeyringPriv0Hex();
      if (!priv0Hex) {
        setMySwapsStatus('Wallet is locked. Unlock the maker wallet before cancelling an Open Swap.');
        return;
      }

      cancelOpenSwapOnChain(rowData, priv0Hex, '')
        .then(function () {
          setMySwapsStatus('Open Swap cancelled on-chain. Refreshing offers…');
          window.location.reload();
        })
        .catch(function (err) {
          setMySwapsStatus('Unable to cancel Open Swap: ' + String(err && err.message ? err.message : err));
          console.error('my swaps open cancel error', err);
        });
      return;
    }

    setMySwapsStatus('Expiring listing…');

    fetch('/api/swaps/offer/expire', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ offerId: rowData.offerId })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.reason) || 'expire_failed');
        setMySwapsStatus('Listing expired. Refreshing offers…');
        window.location.reload();
      })
      .catch(function (err) {
        setMySwapsStatus('Unable to expire listing: ' + String(err && err.message ? err.message : err));
        console.error('my swaps expire error', err);
      });
  }

  function findExpiredOpenSwapsForBatch() {
    return fetchMySwapGroup('/api/open-swaps/mine?history=1')
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.reason) || 'open_mine_failed');
        return normalizeMySwapRows('open', data.items || []).filter(function (row) {
          return row && row.source === 'open' && !row.isAtomicOpen && row.state === 'expired' && row.offerId && !row.cancelTxid && !row.cancelFailedAt;
        });
      });
  }

  function runExpiredOpenSwapCancelBatch(rows, priv0Hex) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var results = [];

    function next(index) {
      if (index >= list.length) return Promise.resolve(results);

      var row = list[index];
      var label = 'Cancelling expired Open Swap ' + (index + 1) + ' of ' + list.length;
      updateExpiredOpenSwapBatchProgress(label + '…');
      return cancelOpenSwapOnChain(row, priv0Hex, label)
        .then(function (data) {
          results.push({ ok: true, offerId: row.offerId, cancelTxid: data && data.cancelTxid ? data.cancelTxid : '' });
          setMySwapsStatus(label + ': cancelled on-chain. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': cancelled on-chain. Waiting 2 seconds before next offer…');
          return sleepMs(2000).then(function () { return next(index + 1); });
        })
        .catch(function (err) {
          results.push({ ok: false, offerId: row.offerId, error: String(err && err.message ? err.message : err) });
          setMySwapsStatus(label + ': failed. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': failed. Waiting 3 seconds before next offer…');
          console.error('expired Open Swap batch cancel error', row && row.offerId, err);
          return sleepMs(3000).then(function () { return next(index + 1); });
        });
    }

    return next(0);
  }

  function chooseExpiredKcc20AtomicBatch(count) {
    return new Promise(function (resolve) {
      setExpiredOpenSwapBatchModalText(
        'Expired KCC20 Atomic Direct Recovery',
        'You have ' + count + ' expired KCC20 Atomic Direct offer' + (count === 1 ? '' : 's') + ' with tokens still locked on chain. Recover them now to return the tokens to your maker wallet?',
        'This requires the maker wallet to be unlocked and will sign one on-chain refund transaction per expired offer.'
      );
      setExpiredOpenSwapBatchModalActions([
        { label: 'Later', primary: false, onClick: function () { hideExpiredOpenSwapBatchModal(); resolve(false); } },
        { label: 'Recover tokens', primary: true, onClick: function () { resolve(true); } }
      ]);
      ensureExpiredOpenSwapBatchModal().style.display = 'flex';
    });
  }

  function findExpiredKcc20AtomicSwapsForBatch() {
    return fetchMySwapGroup('/api/offers/mine?history=1')
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.reason) || 'direct_mine_failed');
        var seen = Object.create(null);
        return normalizeMySwapRows('direct', data.items || []).filter(function (row) {
          if (!row || !row.isAtomicDirect || row.state !== 'atomic_locked' || !row.sourceOutpointKey || !row.offerExpired) return false;
          if (seen[row.sourceOutpointKey]) return false;
          seen[row.sourceOutpointKey] = true;
          return true;
        });
      });
  }

  function runExpiredKcc20AtomicRefundBatch(rows, priv0Hex) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var results = [];

    function next(index) {
      if (index >= list.length) return Promise.resolve(results);

      var row = list[index];
      var label = 'Recovering expired KCC20 Atomic Direct offer ' + (index + 1) + ' of ' + list.length;
      updateExpiredOpenSwapBatchProgress(label + '…');
      return refundKcc20AtomicDirectMaker(row, priv0Hex, label)
        .then(function (result) {
          var summary = atomicMakerRefundPublicSummary(result.build, result.signed, result.submitOut);
          results.push({ ok: true, sourceOutpointKey: row.sourceOutpointKey, refundTxid: summary.submitted_txid || '' });
          setMySwapsStatus(label + ': recovered on chain. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': recovered on chain. Waiting 2 seconds before next offer…');
          return sleepMs(2000).then(function () { return next(index + 1); });
        })
        .catch(function (err) {
          results.push({ ok: false, sourceOutpointKey: row && row.sourceOutpointKey, error: String(err && err.message ? err.message : err) });
          setMySwapsStatus(label + ': failed. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': failed. Waiting 3 seconds before next offer…');
          console.error('expired KCC20 Atomic Direct recovery error', row && row.sourceOutpointKey, err);
          return sleepMs(3000).then(function () { return next(index + 1); });
        });
    }

    return next(0);
  }

  function promptAndBatchRecoverExpiredKcc20AtomicSwaps() {
    if (expiredKcc20AtomicBatchPromptShown || expiredKcc20AtomicBatchRunning) return;
    expiredKcc20AtomicBatchPromptShown = true;

    findExpiredKcc20AtomicSwapsForBatch()
      .then(function (rows) {
        if (!rows.length) return;

        var count = rows.length;
        return chooseExpiredKcc20AtomicBatch(count).then(function (ok) {
          if (!ok) {
            setMySwapsStatus('Expired KCC20 Atomic Direct recovery left for later.');
            return;
          }

          var priv0Hex = getKeyringPriv0Hex();
          if (!priv0Hex) {
            setMySwapsStatus('Wallet is locked. Unlock the maker wallet before recovering expired KCC20 Atomic Direct offers.');
            setExpiredOpenSwapBatchModalText('Wallet Locked', 'Unlock the maker wallet before recovering expired KCC20 Atomic Direct offers.', 'No offers were changed.');
            setExpiredOpenSwapBatchModalActions([
              { label: 'Close', primary: true, onClick: function () { hideExpiredOpenSwapBatchModal(); } }
            ]);
            return;
          }

          expiredKcc20AtomicBatchRunning = true;
          setMySwapsStatus('Starting expired KCC20 Atomic Direct recovery batch…');
          updateExpiredOpenSwapBatchProgress('Starting expired KCC20 Atomic Direct recovery batch…');
          return runExpiredKcc20AtomicRefundBatch(rows, priv0Hex)
            .then(function (results) {
              var okCount = results.filter(function (r) { return r && r.ok === true; }).length;
              var failCount = results.length - okCount;
              setMySwapsStatus('Expired KCC20 Atomic Direct recovery batch complete: ' + okCount + ' recovered, ' + failCount + ' failed.');
              showExpiredOpenSwapBatchDone(okCount, failCount);
            })
            .finally(function () {
              expiredKcc20AtomicBatchRunning = false;
            });
        });
      })
      .catch(function (err) {
        setMySwapsStatus('Unable to check expired KCC20 Atomic Direct offers: ' + String(err && err.message ? err.message : err));
        console.error('expired KCC20 Atomic Direct recovery check error', err);
      });
  }

  function chooseExpiredKcc20AtomicOpenBatch(count) {
    return new Promise(function (resolve) {
      setExpiredOpenSwapBatchModalText(
        'Expired KCC20 Open Swap Recovery',
        'You have ' + count + ' expired KCC20 Open Swap offer' + (count === 1 ? '' : 's') + ' with tokens still locked on chain. Recover them now to return the tokens to your maker wallet?',
        'This uses the proven KCC20 Open maker-refund route and requires the maker wallet to be unlocked. It signs one on-chain refund transaction per expired offer.'
      );
      setExpiredOpenSwapBatchModalActions([
        { label: 'Later', primary: false, onClick: function () { hideExpiredOpenSwapBatchModal(); resolve(false); } },
        { label: 'Recover tokens', primary: true, onClick: function () { resolve(true); } }
      ]);
      ensureExpiredOpenSwapBatchModal().style.display = 'flex';
    });
  }

  function findExpiredKcc20AtomicOpenSwapsForBatch() {
    return fetchMySwapGroup('/api/open-swaps/mine?history=1')
      .then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.reason) || 'open_mine_failed');
        var seen = Object.create(null);
        return normalizeMySwapRows('open', data.items || []).filter(function (row) {
          if (!row || !row.isAtomicOpen || row.state !== 'expired' || !row.sourceOutpointKey || !row.offerId) return false;
          if (row.atomicOpenLegacyUnrecoverable || row.cancelFailedAt || row.cancelFailureReason || Number(row.cancelFailureCount || 0) > 0) return false;
          if (row.cancelTxid || row.refundTxid || row.refund_txid) return false;
          if (seen[row.sourceOutpointKey]) return false;
          seen[row.sourceOutpointKey] = true;
          return true;
        });
      });
  }

  function runExpiredKcc20AtomicOpenRefundBatch(rows, priv0Hex) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var results = [];

    function next(index) {
      if (index >= list.length) return Promise.resolve(results);

      var row = list[index];
      var label = 'Recovering expired KCC20 Open Swap offer ' + (index + 1) + ' of ' + list.length;
      updateExpiredOpenSwapBatchProgress(label + '…');
      return refundKcc20AtomicOpenMaker(row, priv0Hex, label)
        .then(function (result) {
          var summary = atomicMakerRefundPublicSummary(result.build, result.signed, result.submitOut);
          results.push({ ok: true, sourceOutpointKey: row.sourceOutpointKey, refundTxid: summary.submitted_txid || '' });
          setMySwapsStatus(label + ': recovered on chain. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': recovered on chain. Waiting 2 seconds before next offer…');
          return sleepMs(2000).then(function () { return next(index + 1); });
        })
        .catch(function (err) {
          results.push({ ok: false, sourceOutpointKey: row && row.sourceOutpointKey, error: String(err && err.message ? err.message : err) });
          setMySwapsStatus(label + ': failed. Waiting before next offer…');
          updateExpiredOpenSwapBatchProgress(label + ': failed. Waiting 3 seconds before next offer…');
          console.error('expired KCC20 Open Swap recovery error', row && row.sourceOutpointKey, err);
          return sleepMs(3000).then(function () { return next(index + 1); });
        });
    }

    return next(0);
  }

  function promptAndBatchRecoverExpiredKcc20AtomicOpenSwaps() {
    if (expiredKcc20AtomicOpenBatchPromptShown || expiredKcc20AtomicOpenBatchRunning) return;
    expiredKcc20AtomicOpenBatchPromptShown = true;

    findExpiredKcc20AtomicOpenSwapsForBatch()
      .then(function (rows) {
        if (!rows.length) return;

        var count = rows.length;
        return chooseExpiredKcc20AtomicOpenBatch(count).then(function (ok) {
          if (!ok) {
            setMySwapsStatus('Expired KCC20 Open Swap recovery left for later.');
            return;
          }

          var priv0Hex = getKeyringPriv0Hex();
          if (!priv0Hex) {
            setMySwapsStatus('Wallet is locked. Unlock the maker wallet before recovering expired KCC20 Open Swap offers.');
            setExpiredOpenSwapBatchModalText('Wallet Locked', 'Unlock the maker wallet before recovering expired KCC20 Open Swap offers.', 'No offers were changed.');
            setExpiredOpenSwapBatchModalActions([
              { label: 'Close', primary: true, onClick: function () { hideExpiredOpenSwapBatchModal(); } }
            ]);
            return;
          }

          expiredKcc20AtomicOpenBatchRunning = true;
          setMySwapsStatus('Starting expired KCC20 Open Swap recovery batch…');
          updateExpiredOpenSwapBatchProgress('Starting expired KCC20 Open Swap recovery batch…');
          return runExpiredKcc20AtomicOpenRefundBatch(rows, priv0Hex)
            .then(function (results) {
              var okCount = results.filter(function (r) { return r && r.ok === true; }).length;
              var failCount = results.length - okCount;
              setMySwapsStatus('Expired KCC20 Open Swap recovery batch complete: ' + okCount + ' recovered, ' + failCount + ' failed.');
              showExpiredOpenSwapBatchDone(okCount, failCount);
            })
            .finally(function () {
              expiredKcc20AtomicOpenBatchRunning = false;
            });
        });
      })
      .catch(function (err) {
        setMySwapsStatus('Unable to check expired KCC20 Open Swap offers: ' + String(err && err.message ? err.message : err));
        console.error('expired KCC20 Open Swap recovery check error', err);
      });
  }

  function promptAndBatchCancelExpiredOpenSwaps() {
    if (expiredOpenSwapBatchPromptShown || expiredOpenSwapBatchRunning) return;
    expiredOpenSwapBatchPromptShown = true;

    findExpiredOpenSwapsForBatch()
      .then(function (rows) {
        if (!rows.length) return;

        var count = rows.length;
        return chooseExpiredOpenSwapBatch(count).then(function (ok) {
          if (!ok) {
            setMySwapsStatus('Expired Open Swap cancellation left for later.');
            return;
          }

          var priv0Hex = getKeyringPriv0Hex();
          if (!priv0Hex) {
            setMySwapsStatus('Wallet is locked. Unlock the maker wallet before batch-cancelling expired Open Swaps.');
            setExpiredOpenSwapBatchModalText('Wallet Locked', 'Unlock the maker wallet before batch-cancelling expired Open Swaps.', 'No offers were changed.');
            setExpiredOpenSwapBatchModalActions([
              { label: 'Close', primary: true, onClick: function () { hideExpiredOpenSwapBatchModal(); } }
            ]);
            return;
          }

          expiredOpenSwapBatchRunning = true;
          setMySwapsStatus('Starting expired Open Swap cancellation batch…');
          updateExpiredOpenSwapBatchProgress('Starting expired Open Swap cancellation batch…');
          return runExpiredOpenSwapCancelBatch(rows, priv0Hex)
            .then(function (results) {
              var okCount = results.filter(function (r) { return r && r.ok === true; }).length;
              var failCount = results.length - okCount;
              setMySwapsStatus('Expired Open Swap cancellation batch complete: ' + okCount + ' cancelled, ' + failCount + ' failed.');
              showExpiredOpenSwapBatchDone(okCount, failCount);
            })
            .finally(function () {
              expiredOpenSwapBatchRunning = false;
            });
        });
      })
      .catch(function (err) {
        setMySwapsStatus('Unable to check expired Open Swaps: ' + String(err && err.message ? err.message : err));
        console.error('expired Open Swap batch check error', err);
      });
  }

  function loadDirectSponsoredCatalog() {
    return fetch('/api/v1/entitlement-token-settings/upgrade-catalog', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok === false || !Array.isArray(data.catalog)) return [];
        return data.catalog;
      })
      .catch(function (err) {
        console.error('direct upgrade-catalog fetch error', err);
        return [];
      });
  }

  function loadOffers() {
    var statusEl = $('offersStatus');
    if (statusEl) statusEl.textContent = 'Loading direct swap offers…';

    var offersRequest = fetch('/api/offers/list?state=open', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });

    var myOffersRequest = fetchMySwapGroup('/api/offers/mine?history=0')
      .catch(function (err) {
        console.warn('direct my-swaps filter fetch error', err);
        return { ok: true, items: [] };
      });

    Promise.all([offersRequest, loadDirectSponsoredCatalog(), myOffersRequest])
      .then(function (results) {
        var data = results[0];
        var catalog = results[1];
        var mine = results[2] || {};
        setDirectSponsoredCatalog(catalog);
        directMineOpenOfferIds = buildOfferIdMap(mine.items || []);
        directMineActiveWalletId = normalizeDirectText(mine.active_wallet_id);
        if (!data || data.ok === false) {
          if (statusEl) statusEl.textContent = 'Failed to load offers.';
          console.warn('offers.list error', data);
          return;
        }
        renderOffers(data.items || []);
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = 'Error loading offers.';
        console.error('offers.list fetch error', err);
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('fillConfirmBtn');
    if (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        handleConfirmFill();
      });
      btn.disabled = true;
    }

    var closeBtn = $('fillCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        closeFillModal('close_btn');
      });
    }

    var overlay = $('fillSection');
    if (overlay) {
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closeFillModal('overlay');
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var sec = $('fillSection');
      if (sec && sec.style.display !== 'none') closeFillModal('escape');
    });

    var refreshBtn = document.querySelector('.dd-toggle[data-dd="offers"]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.location.reload();
      });
    }

    (function initTn10FaucetCard() {
      function fetchJson(url, opts) {
        return fetch(url, opts || {})
          .then(function (res) {
            return res.json()
              .catch(function () { return {}; })
              .then(function (body) {
                return { httpOk: res.ok, status: res.status, body: body || {} };
              });
          });
      }

      function getNetworkMeta(raw) {
        try {
          var shared = window.CwNetworkShared;
          if (!shared || typeof shared.getNetworkMeta !== 'function') return null;
          var meta = shared.getNetworkMeta(raw);
          return meta && typeof meta === 'object' ? meta : null;
        } catch (_) {
          return null;
        }
      }

      function isTn10WalletStatus(w) {
        if (!w || w.ok !== true) return false;
        var address = String(w.address0 || '').trim();
        if (!address || address.indexOf('kaspatest:') !== 0) return false;
        var meta = getNetworkMeta(String(w.network || '').trim());
        if (!meta) return false;
        return String(meta.appKey || '') === 'tn10' || String(meta.kasplexNetworkId || '') === 'testnet-10';
      }

      function sompiToTkas(raw) {
        var s = String(raw == null ? '' : raw).trim();
        if (!/^\d+$/.test(s)) return '';
        try {
          var n = BigInt(s);
          var whole = n / 100000000n;
          var frac = String(n % 100000000n).padStart(8, '0').replace(/0+$/, '');
          return frac ? String(whole) + '.' + frac : String(whole);
        } catch (_) {
          return '';
        }
      }

      function insertFaucetSection(walletStatus) {
        if (document.getElementById('tn10FaucetSection')) return;

        var section = document.createElement('section');
        section.id = 'tn10FaucetSection';
        section.setAttribute('aria-label', 'TN10 Faucet');
        section.innerHTML = '' +
          '<header class="offers-header" style="margin-top:1rem;">' +
            '<div>' +
              '<h2 style="margin-bottom:.1rem;">TN10 Faucet</h2>' +
              '<p class="muted" id="tn10FaucetStatus">Active TN10 wallet detected.</p>' +
            '</div>' +
          '</header>' +
          '<article class="offer-card">' +
            '<div class="offer-title">Need TN10 test KAS for offers or KRC-20 testing?</div>' +
            '<div class="offer-sub">Receive 2,000 TKAS to your active TN10 wallet. Daily account limit: 10,000 TKAS per logged-in account, reset by UTC day.</div>' +
            '<div class="offer-sub" id="tn10FaucetAddress"></div>' +
            '<div style="display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; margin-top:.25rem;">' +
              '<button id="tn10FaucetClaimBtn" type="button">Receive 2,000 TKAS</button>' +
            '</div>' +
            '<div class="muted" id="tn10FaucetResult" aria-live="polite"></div>' +
          '</article>';

        var advisory = document.querySelector('.offers-advisory');
        if (advisory && advisory.parentNode) {
          advisory.parentNode.insertBefore(section, advisory.nextSibling);
        } else {
          var main = document.querySelector('main.container') || document.querySelector('main') || document.body;
          main.insertBefore(section, main.firstChild);
        }

        var addressEl = document.getElementById('tn10FaucetAddress');
        if (addressEl) addressEl.textContent = 'Destination: ' + String(walletStatus.address0 || '').trim();

        var btn = document.getElementById('tn10FaucetClaimBtn');
        var result = document.getElementById('tn10FaucetResult');
        if (!btn || !result) return;

        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          btn.disabled = true;
          result.textContent = 'Requesting 2,000 TKAS faucet claim…';

          fetchJson('/api/tn10-faucet/claim', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            },
            body: '{}'
          })
            .then(function (out) {
              var body = out && out.body ? out.body : {};
              if (!out || !out.httpOk || body.ok !== true) {
                var reason = String(body.error || body.reason || ('HTTP ' + (out && out.status ? out.status : 'error')));
                result.textContent = 'TN10 faucet claim failed: ' + reason;
                return;
              }

              var txid = String(body.txid || '').trim();
              var remaining = sompiToTkas(body.remainingSompi);
              result.textContent = 'Sent 2,000 TKAS. Txid: ' + (txid || 'submitted') + (remaining ? '. Remaining UTC quota: ' + remaining + ' TKAS.' : '.');
            })
            .catch(function (err) {
              result.textContent = 'TN10 faucet claim failed: ' + String(err && err.message ? err.message : err);
            })
            .finally(function () {
              btn.disabled = false;
            });
        });
      }

      fetchJson('/api/wallet/status', { method: 'GET', headers: { 'Accept': 'application/json' } })
        .then(function (out) {
          var w = out && out.body ? out.body : {};
          if (!isTn10WalletStatus(w)) return;
          insertFaucetSection(w);
        })
        .catch(function () {});
    })();

    (function initBrokerWrappedOffersCard() {
      var st = $('brokerWrappedStatus');
      var mount = $('brokerWrappedMount');
      if (!st || !mount) return;

      function isHex64(s) {
        return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s.trim());
      }

      function isEvmAddress(s) {
        return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
      }

      function fetchJson(url, opts) {
        return fetch(url, opts || {})
          .then(function (res) {
            return res.json()
              .catch(function () { return {}; })
              .then(function (body) {
                return { httpOk: res.ok, status: res.status, body: body || {} };
              });
          });
      }

      function getNetworkSharedOrNull() {
        try {
          var shared = window.CwNetworkShared;
          if (shared && typeof shared === 'object') return shared;
        } catch (_) {}
        return null;
      }

      function getNetworkMeta(raw) {
        var shared = getNetworkSharedOrNull();
        if (!shared || typeof shared.getNetworkMeta !== 'function') return null;
        var meta = shared.getNetworkMeta(raw);
        if (!meta || typeof meta !== 'object') return null;
        return meta;
      }

      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function parseDecimalToRawUnits(input, decimals) {
        var raw = String(input || '').trim();
        if (!raw) return null;
        if (!Number.isInteger(decimals) || decimals < 0) return null;
        if (raw[0] === '.') raw = '0' + raw;
        if (raw[raw.length - 1] === '.') raw = raw.slice(0, -1);
        if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;

        var parts = raw.split('.');
        var whole = parts[0] || '0';
        var frac = parts.length > 1 ? (parts[1] || '') : '';
        if (frac.length > decimals) return null;
        while (frac.length < decimals) frac += '0';
        return BigInt(whole + frac);
      }

      function rawUnitsToDisplay(rawUnits, decimals) {
        if (!/^\d+$/.test(String(rawUnits || ''))) return String(rawUnits || '');
        var s = String(rawUnits || '0');
        var d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
        while (s.length <= d) s = '0' + s;
        var whole = d > 0 ? s.slice(0, -d) : s;
        var frac = d > 0 ? s.slice(-d).replace(/0+$/, '') : '';
        return frac ? (whole + '.' + frac) : whole;
      }

      function inventoryRawUnitsFromValue(value) {
        if (typeof value === 'string') {
          var s = String(value).trim();
          return /^\d+$/.test(s) ? s : '';
        }
        if (typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value) {
          return String(Math.floor(value));
        }
        return '';
      }

      function ceilDiv(a, b) {
        if (b <= 0n) throw new Error('ceil_div_invalid_divisor');
        if (a <= 0n) return 0n;
        return (a + b - 1n) / b;
      }

      var BW_PURCHASE_TRACK_KEY = 'bw_purchase_track_v1';
      var BW_POLL_INTERVAL_MS = 5000;

      function parseIsoMs(raw) {
        var s = typeof raw === 'string' ? String(raw).trim() : '';
        if (!s) return null;
        var ms = Date.parse(s);
        return isFinite(ms) ? ms : null;
      }

      function formatCountdownMs(ms) {
        var safeMs = Number(ms);
        if (!isFinite(safeMs) || safeMs <= 0) return '00:00';
        var totalSeconds = Math.max(0, Math.floor(safeMs / 1000));
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds % 60;
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
      }

      function normalizeTrackedPurchaseMeta(meta) {
        var list = Array.isArray(meta) ? meta : (meta && typeof meta === 'object' ? [meta] : []);
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var entry = list[i] || {};
          var id = entry && entry.id ? String(entry.id) : '';
          if (!id) continue;
          out.push({
            id: id,
            ca: entry && entry.ca != null ? String(entry.ca) : '',
            netKey: entry && entry.netKey != null ? String(entry.netKey) : '',
            networkId: entry && entry.networkId != null ? String(entry.networkId) : ''
          });
        }
        return out;
      }

      function readTrackedPurchaseMeta() {
        try {
          var raw = sessionStorage.getItem(BW_PURCHASE_TRACK_KEY) || '';
          if (!raw) return [];
          return normalizeTrackedPurchaseMeta(JSON.parse(raw));
        } catch (_) {
          return [];
        }
      }

      function writeTrackedPurchaseMeta(meta) {
        try {
          var normalized = normalizeTrackedPurchaseMeta(meta);
          if (!normalized.length) sessionStorage.removeItem(BW_PURCHASE_TRACK_KEY);
          else sessionStorage.setItem(BW_PURCHASE_TRACK_KEY, JSON.stringify(normalized));
        } catch (_) {}
      }

      function upsertTrackedPurchaseMeta(meta) {
        var normalized = normalizeTrackedPurchaseMeta(meta);
        if (!normalized.length) return readTrackedPurchaseMeta();
        var next = readTrackedPurchaseMeta().filter(function (entry) {
          return entry && entry.id !== normalized[0].id;
        });
        next.unshift(normalized[0]);
        writeTrackedPurchaseMeta(next);
        return next;
      }

      function removeTrackedPurchaseMetaById(id) {
        var targetId = id ? String(id) : '';
        if (!targetId) return readTrackedPurchaseMeta();
        var next = readTrackedPurchaseMeta().filter(function (entry) {
          return entry && entry.id !== targetId;
        });
        writeTrackedPurchaseMeta(next);
        return next;
      }

      function purchaseStatusHeadline(status) {
        var s = String(status || '').trim().toLowerCase();
        if (s === 'payment_detected') return 'Payment received';
        if (s === 'payment_mismatch_amount') return 'Payment received — review required';
        if (s === 'waiting_inventory') return 'Waiting for inventory';
        if (s === 'ready_for_fulfillment') return 'Ready for fulfillment';
        if (s === 'fulfillment_prepared') return 'Fulfillment prepared';
        if (s === 'fulfillment_executing') return 'Fulfillment in progress';
        if (s === 'fulfillment_submitted') return 'Fulfillment submitted';
        if (s === 'expired_unpaid') return 'Payment window expired';
        return 'Waiting for payment';
      }

      function purchaseStatusDetail(status) {
        var s = String(status || '').trim().toLowerCase();
        if (s === 'payment_detected') return 'Your order is confirmed and queued for fulfillment. Fulfillment is broker-approved and may take up to 1–2 business days.';
        if (s === 'payment_mismatch_amount') return 'Your payment was detected, but the received amount needs broker review before fulfillment can proceed.';
        if (s === 'waiting_inventory') return 'Your payment was received. The broker is waiting for sufficient inventory before fulfillment can begin.';
        if (s === 'ready_for_fulfillment') return 'Your payment was received and this order is ready for broker fulfillment.';
        if (s === 'fulfillment_prepared') return 'Your payment was received and this order has been reserved for fulfillment.';
        if (s === 'fulfillment_executing') return 'Your payment was received and broker fulfillment is currently in progress.';
        if (s === 'fulfillment_submitted') return 'Your payment was received and fulfillment has already been submitted.';
        if (s === 'expired_unpaid') return 'This order is no longer waiting for payment. Create a new purchase request if you still want to buy this asset.';
        return 'You may close this window. Your order has been saved.';
      }

      function isPurchaseStatusTerminal(status) {
        var s = String(status || '').trim().toLowerCase();
        return s === 'fulfillment_submitted' || s === 'expired_unpaid';
      }

      function buildPaymentQrValue(purchaseId, paymentAssetRef, paymentAmountDisplay, paymentAddress) {
        var lines = [];
        if (paymentAssetRef) lines.push('Payment method: ' + paymentAssetRef);
        if (paymentAmountDisplay) lines.push('Payment amount: ' + paymentAmountDisplay);
        if (paymentAddress) lines.push('Payment address: ' + paymentAddress);
        if (purchaseId) lines.push('Purchase ID: ' + purchaseId);
        return lines.join('\n');
      }

      function ensureConfirmOverlay() {
        var overlay = $('bwConfirmOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'bwConfirmOverlay';
        overlay.style.display = 'none';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0, 0, 0, 0.72)';
        overlay.style.zIndex = '1190';
        overlay.style.padding = '24px';
        overlay.style.overflow = 'auto';
        overlay.innerHTML =
          '<div style="max-width:640px; margin:0 auto; background:#0f131a; border:1px solid rgba(64,224,208,.25); border-radius:18px; box-shadow:0 0 28px rgba(64,224,208,.12); padding:1rem;">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; margin-bottom:.75rem;">' +
              '<div>' +
                '<h3 style="margin:0 0 .25rem 0;">Confirm Purchase</h3>' +
                '<div class="muted" style="font-size:.95rem;">Review the quote details before creating the purchase request.</div>' +
              '</div>' +
              '<button id="bwConfirmClose" type="button" class="secondary">Close</button>' +
            '</div>' +
            '<div id="bwConfirmBody"></div>' +
            '<div style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem;">' +
              '<button id="bwConfirmCancel" type="button" class="secondary">Cancel</button>' +
              '<button id="bwConfirmSubmit" type="button" class="secondary">Confirm</button>' +
            '</div>' +
          '</div>';

        overlay.addEventListener('click', function (ev) {
          if (ev.target === overlay) overlay.style.display = 'none';
        });

        document.body.appendChild(overlay);

        function closeOverlay(ev) {
          if (ev) ev.preventDefault();
          overlay.style.display = 'none';
        }

        var closeBtn = $('bwConfirmClose');
        if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
        var cancelBtn = $('bwConfirmCancel');
        if (cancelBtn) cancelBtn.addEventListener('click', closeOverlay);

        var confirmBtn = $('bwConfirmSubmit');
        if (confirmBtn) {
          confirmBtn.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (typeof overlay._onConfirm === 'function') overlay._onConfirm();
          });
        }

        return overlay;
      }

      function setConfirmOverlaySubmitDisabled(disabled) {
        var confirmBtn = $('bwConfirmSubmit');
        if (!confirmBtn) return;
        confirmBtn.disabled = !!disabled;
      }

      function openConfirmOverlay(bodyHtml, onConfirm, options) {
        var overlay = ensureConfirmOverlay();
        var body = $('bwConfirmBody');
        if (!overlay || !body) return;
        body.innerHTML = bodyHtml;
        overlay._onConfirm = typeof onConfirm === 'function' ? onConfirm : null;
        setConfirmOverlaySubmitDisabled(!!(options && options.confirmDisabled));
        overlay.style.display = 'block';
      }

      function closeConfirmOverlay() {
        var overlay = $('bwConfirmOverlay');
        if (!overlay) return;
        overlay.style.display = 'none';
        setConfirmOverlaySubmitDisabled(false);
      }

      function ensurePaymentOverlay() {
        var overlay = $('bwPaymentOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'bwPaymentOverlay';
        overlay.style.display = 'none';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0, 0, 0, 0.72)';
        overlay.style.zIndex = '1200';
        overlay.style.padding = '24px';
        overlay.style.overflow = 'auto';
        overlay.innerHTML =
          '<div style="max-width:680px; margin:0 auto; background:#0f131a; border:1px solid rgba(64,224,208,.25); border-radius:18px; box-shadow:0 0 28px rgba(64,224,208,.12); padding:1rem;">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; margin-bottom:.75rem;">' +
              '<div>' +
                '<h3 style="margin:0 0 .25rem 0;">Payment Instructions</h3>' +
                '<div class="muted" style="font-size:.95rem;">Use the exact payment details below to complete this purchase request.</div>' +
              '</div>' +
              '<button id="bwPaymentClose" type="button" class="secondary">Close</button>' +
            '</div>' +
            '<div id="bwPaymentBody"></div>' +
          '</div>';

        overlay.addEventListener('click', function (ev) {
          if (ev.target === overlay) overlay.style.display = 'none';
        });

        document.body.appendChild(overlay);

        var closeBtn = $('bwPaymentClose');
        if (closeBtn) {
          closeBtn.addEventListener('click', function (ev) {
            ev.preventDefault();
            overlay.style.display = 'none';
          });
        }

        return overlay;
      }

      function openPaymentOverlay(purchase, assetInfo, netKey, serverNowIso) {
        var overlay = ensurePaymentOverlay();
        var body = $('bwPaymentBody');
        if (!overlay || !body) return;

        var purchaseId = purchase && purchase.id ? String(purchase.id) : '(no id)';
        var paymentAssetRef = purchase && purchase.paymentAssetRef ? String(purchase.paymentAssetRef) : (assetInfo && assetInfo.assetRef ? String(assetInfo.assetRef) : '');
        var paymentAmountRaw = purchase && purchase.paymentAmountRaw ? String(purchase.paymentAmountRaw) : '';
        var paymentAddress = purchase && purchase.fireblocksReceiveAddressSnapshot ? String(purchase.fireblocksReceiveAddressSnapshot) : '';
        var paymentAmountDisplay = paymentAmountRaw && assetInfo && Number.isInteger(assetInfo.decimals)
          ? rawUnitsToDisplay(paymentAmountRaw, assetInfo.decimals)
          : paymentAmountRaw;
        var wrappedAmount = purchase && purchase.amountRaw ? String(purchase.amountRaw) : '';
        var wrappedDisplay = wrappedAmount && assetInfo && Number.isInteger(assetInfo.decimals)
          ? rawUnitsToDisplay(wrappedAmount, assetInfo.decimals)
          : wrappedAmount;
        var qrValue = buildPaymentQrValue(purchaseId, paymentAssetRef, paymentAmountDisplay, paymentAddress);
        var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qrValue);
        var status = purchase && purchase.status ? String(purchase.status) : '';
        var statusHeadline = purchaseStatusHeadline(status);
        var statusDetail = purchaseStatusDetail(status);
        var serverNowMs = parseIsoMs(serverNowIso);
        var expiresAtMs = parseIsoMs(purchase && purchase.expiresAt);
        var countdownHtml = '';

        if (String(status || '').trim().toLowerCase() === 'awaiting_payment' && expiresAtMs !== null) {
          countdownHtml = '<div><strong>Time remaining to pay:</strong> ' + escapeHtml(formatCountdownMs(expiresAtMs - (serverNowMs !== null ? serverNowMs : Date.now()))) + '</div>';
        }

        body.innerHTML =
          '<div style="display:grid; gap:1rem;">' +
            '<div style="padding:.75rem; border:1px solid rgba(64,224,208,.18); border-radius:14px; background:rgba(64,224,208,.06); display:grid; gap:.35rem;">' +
              '<div><strong>Status:</strong> ' + escapeHtml(statusHeadline) + '</div>' +
              countdownHtml +
              '<div class="muted" style="font-size:.95rem;">' + escapeHtml(statusDetail) + '</div>' +
            '</div>' +
            '<div style="display:grid; grid-template-columns: minmax(0, 1fr) 220px; gap:1rem; align-items:start;">' +
              '<div style="display:grid; gap:.75rem;">' +
                '<div><strong>Purchase ID:</strong> ' + escapeHtml(purchaseId) + '</div>' +
                '<div><strong>Asset:</strong> ' + escapeHtml(assetInfo && assetInfo.name ? assetInfo.name : (assetInfo && assetInfo.ca ? assetInfo.ca : 'Unknown')) + '</div>' +
                '<div><strong>Network:</strong> ' + escapeHtml(netKey) + '</div>' +
                '<div><strong>Requested wrapped amount:</strong> ' + escapeHtml(wrappedDisplay || wrappedAmount || '—') + '</div>' +
                '<div><strong>Payment method:</strong> ' + escapeHtml(paymentAssetRef || '—') + '</div>' +
                '<div><strong>Payment amount:</strong> ' + escapeHtml(paymentAmountDisplay || paymentAmountRaw || '—') + '</div>' +
                '<div><strong>Payment address:</strong><br><div style="margin-top:.25rem; padding:.65rem .75rem; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.03); word-break:break-all;">' + escapeHtml(paymentAddress || '—') + '</div></div>' +
                '<div class="muted" style="font-size:.95rem;">Send the exact payment amount to the payment address above. Keep your Purchase ID for reference.</div>' +
              '</div>' +
              '<div style="display:grid; justify-items:center; gap:.5rem;">' +
                '<img alt="Payment QR" src="' + qrUrl + '" width="220" height="220" style="display:block; width:220px; height:220px; border-radius:16px; background:#fff; padding:8px;">' +
                '<div class="muted" style="font-size:.9rem; text-align:center;">Scan to copy the payment instructions.</div>' +
              '</div>' +
            '</div>' +
          '</div>';

        overlay.setAttribute('data-purchase-id', purchaseId);
        overlay.style.display = 'block';
      }

      function refreshPaymentOverlayIfOpen(purchase, assetInfo, netKey, serverNowIso) {
        var overlay = $('bwPaymentOverlay');
        if (!overlay) return;
        if (overlay.style.display !== 'block') return;
        var currentId = overlay.getAttribute('data-purchase-id') || '';
        var purchaseId = purchase && purchase.id ? String(purchase.id) : '';
        if (!purchaseId || currentId !== purchaseId) return;
        openPaymentOverlay(purchase, assetInfo, netKey, serverNowIso);
      }

      function setNotConfigured() {
        st.textContent = 'Broker wrapped offers not configured.';
        mount.innerHTML = '<div class="muted">Purchasable wrapped assets must be configured in CN with Fireblocks mapping, purchase policy, payment asset reference, price, and minimum amount.</div>';
      }

      function renderForm(params) {
        var netKey = params.netKey;
        var networkId = params.networkId;
        var assets = params.assets || [];
        var defaultReceive = params.defaultReceive || '';
        var assetsByCa = {};
        var trackedPollTimer = 0;
        var trackedPurchaseRowsById = {};

        for (var i = 0; i < assets.length; i++) {
          var item = assets[i] || {};
          if (item && item.ca) assetsByCa[String(item.ca).trim().toLowerCase()] = item;
        }

        function optionsHtml(list) {
          return (list || []).map(function (a) {
            var name = a.name || a.ca || 'Unknown';
            var ca = a.ca || '';
            var suffix = ca ? (' — ' + ca) : '';
            return '<option value="' + ca + '">' + escapeHtml(name + suffix) + '</option>';
          }).join('');
        }

        mount.innerHTML =
          '<article class="offer-card card bw-card">' +
            '<div class="bw-topline">' +
              '<div style="font-size:1rem; font-weight:600;">Buy wrapped asset</div>' +
              '<div class="muted" style="font-size:.9rem;">Network: ' + escapeHtml(netKey) + '</div>' +
            '</div>' +

            '<form id="bwForm" class="bw-strip">' +
              '<div id="bwQuote" class="muted bw-quote">Select an asset and amount to see the broker quote.</div>' +
              '<label class="muted">Asset (CA)<select id="bwCa" required style="width:100%;">' + optionsHtml(assets) + '</select></label>' +
              '<label class="muted">Amount<input id="bwAmount" type="text" placeholder="e.g. 4.00" required style="width:100%;"></label>' +
              '<label class="muted">Receive address<input id="bwReceive" type="text" placeholder="kaspa... / kaspatest..." required style="width:100%;"></label>' +
              '<label class="muted">Payer address<input id="bwPayer" type="text" placeholder="0x..." required style="width:100%;"></label>' +
              '<div class="bw-action">' +
                '<button id="bwSubmit" class="secondary" type="submit">Buy</button>' +
              '</div>' +
              '<div id="bwMsg" class="muted bw-msg"></div>' +
            '</form>' +
            '<div id="bwTrackedStatus" class="muted bw-msg" style="display:none; margin-top:.75rem;"></div>' +
          '</article>';

        ensureConfirmOverlay();
        ensurePaymentOverlay();

        var recvEl = document.getElementById('bwReceive');
        if (recvEl && !recvEl.value) recvEl.value = defaultReceive || '';

        var form = document.getElementById('bwForm');
        if (!form) return;

        var caEl = document.getElementById('bwCa');
        var amtEl = document.getElementById('bwAmount');
        var payerEl = document.getElementById('bwPayer');
        var quoteEl = document.getElementById('bwQuote');
        var btnEl = document.getElementById('bwSubmit');
        var msgEl = document.getElementById('bwMsg');
        var trackedEl = document.getElementById('bwTrackedStatus');
        var payerLockPrecheckTimer = 0;
        var payerLockPrecheckState = null;

        function buildPayerLockPrecheckDraft() {
          var ca = caEl ? String(caEl.value || '').trim().toLowerCase() : '';
          var declaredPaymentSenderAddress = payerEl ? String(payerEl.value || '').trim() : '';
          var selected = assetsByCa[ca] || null;

          if (!isHex64(ca) || !selected) return null;
          if (!declaredPaymentSenderAddress || !isEvmAddress(declaredPaymentSenderAddress)) return null;

          return {
            ca: ca,
            declaredPaymentSenderAddress: declaredPaymentSenderAddress
          };
        }

        function payerLockPrecheckKeyFromDraft(draft) {
          if (!draft || !draft.ca || !draft.declaredPaymentSenderAddress) return '';
          return networkId + '|' + String(draft.ca).trim().toLowerCase() + '|' + String(draft.declaredPaymentSenderAddress).trim().toLowerCase();
        }

        function buildPayerLockBlockedHtml(state) {
          if (!state || state.blocked !== true) return '';
          var purchaseId = state.existingPurchaseId ? String(state.existingPurchaseId) : '(unknown)';
          var existingStatus = state.existingStatus ? String(state.existingStatus) : 'awaiting_payment';
          var existingExpiresAt = state.existingExpiresAt ? String(state.existingExpiresAt) : '';
          var expiresHtml = existingExpiresAt
            ? '<div><strong>Existing order expires at:</strong> ' + escapeHtml(existingExpiresAt) + '</div>'
            : '';
          return '' +
            '<div style="padding:.75rem; border:1px solid rgba(255,184,77,.30); border-radius:14px; background:rgba(255,184,77,.08); display:grid; gap:.35rem;">' +
              '<div><strong>Pending order already exists for this payer.</strong></div>' +
              '<div>Purchase <strong>' + escapeHtml(purchaseId) + '</strong> must be paid or expired before a new order can be placed on this Network / Asset / Payer Address.</div>' +
              '<div><strong>Status:</strong> ' + escapeHtml(existingStatus) + '</div>' +
              expiresHtml +
            '</div>';
        }

        function buildPurchaseConfirmHtml(draft, payerLockState) {
          var quotedPaymentRaw = (draft.amountUnits + ceilDiv(draft.amountUnits * BigInt(draft.selected.priceBps), 10000n)).toString();
          var quotedPaymentDisplay = rawUnitsToDisplay(quotedPaymentRaw, draft.selected.decimals);
          var amountDisplay = rawUnitsToDisplay(draft.amountUnits.toString(), draft.selected.decimals);
          var blockedHtml = buildPayerLockBlockedHtml(payerLockState);

          return '' +
            '<div style="display:grid; gap:.65rem;">' +
              '<div><strong>Asset:</strong> ' + escapeHtml(draft.selected.name || draft.selected.ca || 'Unknown') + '</div>' +
              '<div><strong>Amount:</strong> ' + escapeHtml(amountDisplay) + '</div>' +
              '<div><strong>Payment method:</strong> ' + escapeHtml(draft.selected.assetRef || '—') + '</div>' +
              '<div><strong>Quoted payment amount:</strong> ' + escapeHtml(quotedPaymentDisplay) + '</div>' +
              '<div><strong>Receive address:</strong><br><div style="margin-top:.25rem; padding:.65rem .75rem; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.03); word-break:break-all;">' + escapeHtml(draft.userKrcReceiveAddress) + '</div></div>' +
              '<div><strong>Payer address:</strong><br><div style="margin-top:.25rem; padding:.65rem .75rem; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.03); word-break:break-all;">' + escapeHtml(draft.declaredPaymentSenderAddress) + '</div></div>' +
              blockedHtml +
            '</div>';
        }

        function runPayerLockPrecheck(draft, force) {
          var key = payerLockPrecheckKeyFromDraft(draft);
          if (!key) {
            payerLockPrecheckState = null;
            return Promise.resolve({ blocked: false });
          }
          if (!force && payerLockPrecheckState && payerLockPrecheckState.key === key) {
            return Promise.resolve(payerLockPrecheckState);
          }

          return fetchJson(
            '/api/v1/bridge/purchase/precheck?networkId=' + encodeURIComponent(networkId) +
            '&ca=' + encodeURIComponent(String(draft.ca || '')) +
            '&declaredPaymentSenderAddress=' + encodeURIComponent(String(draft.declaredPaymentSenderAddress || '')),
            {
              method: 'GET',
              headers: { 'Accept': 'application/json' }
            }
          ).then(function (r) {
            if (!r || !r.httpOk || !r.body || r.body.ok !== true) {
              var reason = (r && r.body && (r.body.reason || r.body.error)) ? String(r.body.reason || r.body.error) : ('HTTP ' + (r ? r.status : '?'));
              throw new Error(reason);
            }
            payerLockPrecheckState = {
              key: key,
              blocked: r.body.blocked === true,
              existingPurchaseId: r.body.existingPurchaseId || '',
              existingStatus: r.body.existingStatus || '',
              existingExpiresAt: r.body.existingExpiresAt || '',
              serverNow: r.body.serverNow || ''
            };
            return payerLockPrecheckState;
          });
        }

        function queuePayerLockPrecheck() {
          if (payerLockPrecheckTimer) {
            clearTimeout(payerLockPrecheckTimer);
            payerLockPrecheckTimer = 0;
          }
          payerLockPrecheckTimer = window.setTimeout(function () {
            payerLockPrecheckTimer = 0;
            var draft = buildPayerLockPrecheckDraft();
            if (!draft) {
              payerLockPrecheckState = null;
              return;
            }
            runPayerLockPrecheck(draft, true).catch(function () {});
          }, 250);
        }

        function openPurchaseConfirmOverlay(draft, payerLockState) {
          var blocked = payerLockState && payerLockState.blocked === true;
          openConfirmOverlay(
            buildPurchaseConfirmHtml(draft, payerLockState),
            blocked ? null : function () {
              submitPurchaseDraft(draft);
            },
            { confirmDisabled: blocked }
          );
        }

        function stopTrackedPurchasePolling() {
          if (trackedPollTimer) {
            clearInterval(trackedPollTimer);
            trackedPollTimer = 0;
          }
        }

        function renderTrackedPurchaseRow(purchase, assetInfo, serverNowIso) {
          var purchaseId = purchase && purchase.id ? String(purchase.id) : '(no id)';
          var status = purchase && purchase.status ? String(purchase.status) : '';
          var headline = purchaseStatusHeadline(status);
          var detail = purchaseStatusDetail(status);
          var assetLabel = assetInfo && assetInfo.name
            ? String(assetInfo.name)
            : (purchase && purchase.ca ? String(purchase.ca) : 'Unknown');
          var serverNowMs = parseIsoMs(serverNowIso);
          var expiresAtMs = parseIsoMs(purchase && purchase.expiresAt);
          var countdownHtml = '';
          var canReopen = !!(purchase && purchase.id && (purchase.paymentAmountRaw || purchase.fireblocksReceiveAddressSnapshot));
          var reopenHtml = canReopen
            ? '<button type="button" data-open-payment="' + escapeHtml(purchaseId) + '" title="Open payment instructions" aria-label="Open payment instructions" style="padding:0; border:0; background:none; color:#40e0d0; cursor:pointer; font-size:1rem; line-height:1;">↗</button>'
            : '';

          if (String(status || '').trim().toLowerCase() === 'awaiting_payment' && expiresAtMs !== null) {
            countdownHtml = '<div><strong>Time remaining to pay:</strong> ' + escapeHtml(formatCountdownMs(expiresAtMs - (serverNowMs !== null ? serverNowMs : Date.now()))) + '</div>';
          }

          return '' +
            '<div style="padding:.75rem; border:1px solid rgba(64,224,208,.18); border-radius:14px; background:rgba(64,224,208,.06); display:grid; gap:.35rem;">' +
              '<div style="display:flex; align-items:center; justify-content:space-between; gap:.5rem;">' +
                '<div><strong>Tracked purchase:</strong> ' + escapeHtml(purchaseId) + '</div>' +
                reopenHtml +
              '</div>' +
              '<div><strong>Asset:</strong> ' + escapeHtml(assetLabel) + '</div>' +
              '<div><strong>Status:</strong> ' + escapeHtml(headline) + '</div>' +
              countdownHtml +
              '<div class="muted" style="font-size:.95rem;">' + escapeHtml(detail) + '</div>' +
            '</div>';
        }

        function renderTrackedStatus(rows, serverNowIso) {
          if (!trackedEl) return;
          var list = Array.isArray(rows) ? rows : [];
          var html = [];

          trackedPurchaseRowsById = {};

          for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            if (!row.purchase || !row.purchase.id) continue;
            trackedPurchaseRowsById[String(row.purchase.id)] = {
              purchase: row.purchase,
              assetInfo: row.assetInfo || null,
              serverNowIso: serverNowIso || ''
            };
            html.push(renderTrackedPurchaseRow(row.purchase, row.assetInfo || null, serverNowIso));
          }

          if (!html.length) {
            trackedEl.style.display = 'none';
            trackedEl.innerHTML = '';
            return;
          }

          trackedEl.style.display = 'block';
          trackedEl.innerHTML =
            '<div style="display:grid; gap:.5rem;">' +
              '<div><strong>Tracked purchases:</strong></div>' +
              html.join('') +
            '</div>';
        }

        function syncTrackedPurchase(rows, serverNowIso) {
          var list = Array.isArray(rows) ? rows : [];
          renderTrackedStatus(list, serverNowIso);
          for (var i = 0; i < list.length; i++) {
            var row = list[i] || {};
            if (!row.purchase || !row.purchase.id) continue;
            refreshPaymentOverlayIfOpen(row.purchase, row.assetInfo || null, netKey, serverNowIso);
          }
        }

        function pollTrackedPurchaseOnce() {
          var tracked = readTrackedPurchaseMeta();
          var activeTracked = tracked.filter(function (entry) {
            return entry && entry.netKey === netKey && entry.networkId === networkId && entry.id;
          });

          if (!activeTracked.length) {
            stopTrackedPurchasePolling();
            renderTrackedStatus([], '');
            return Promise.resolve();
          }

          return Promise.all(activeTracked.map(function (entry) {
            return fetchJson('/api/v1/bridge/purchase/status?id=' + encodeURIComponent(String(entry.id)), {
              method: 'GET',
              headers: { 'Accept': 'application/json' }
            })
              .then(function (r) {
                if (!r || !r.httpOk || !r.body || r.body.ok !== true) {
                  var reason = (r && r.body && (r.body.reason || r.body.error)) ? String(r.body.reason || r.body.error) : ('HTTP ' + (r ? r.status : '?'));
                  throw new Error(reason);
                }

                var purchase = r.body.purchase || null;
                var assetInfo = purchase && purchase.ca ? (assetsByCa[String(purchase.ca).trim().toLowerCase()] || null) : null;

                if (purchase && isPurchaseStatusTerminal(purchase.status)) {
                  removeTrackedPurchaseMetaById(entry.id);
                  return null;
                }

                return {
                  purchase: purchase,
                  assetInfo: assetInfo,
                  serverNowIso: r.body.serverNow || ''
                };
              })
              .catch(function (err) {
                var message = String(err && err.message ? err.message : err);
                if (message === 'purchase_not_found') {
                  removeTrackedPurchaseMetaById(entry.id);
                }
                return null;
              });
          }))
            .then(function (results) {
              var rows = [];
              var serverNowIso = '';
              for (var i = 0; i < results.length; i++) {
                var item = results[i];
                if (!item || !item.purchase || !item.purchase.id) continue;
                rows.push({
                  purchase: item.purchase,
                  assetInfo: item.assetInfo || null
                });
                if (!serverNowIso && item.serverNowIso) serverNowIso = item.serverNowIso;
              }

              if (!rows.length) {
                var remaining = readTrackedPurchaseMeta().filter(function (entry) {
                  return entry && entry.netKey === netKey && entry.networkId === networkId && entry.id;
                });
                if (!remaining.length) {
                  stopTrackedPurchasePolling();
                  renderTrackedStatus([], '');
                }
                return;
              }

              syncTrackedPurchase(rows, serverNowIso);
            });
        }

        function startTrackedPurchasePolling() {
          stopTrackedPurchasePolling();
          pollTrackedPurchaseOnce();
          trackedPollTimer = window.setInterval(function () {
            pollTrackedPurchaseOnce();
          }, BW_POLL_INTERVAL_MS);
        }

        function rememberTrackedPurchase(purchase, assetInfo, serverNowIso) {
          if (!purchase || !purchase.id) return;
          upsertTrackedPurchaseMeta({
            id: String(purchase.id),
            ca: assetInfo && assetInfo.ca ? String(assetInfo.ca) : '',
            netKey: netKey,
            networkId: networkId
          });
          if (trackedEl) {
            trackedEl.style.display = 'block';
            trackedEl.innerHTML = '<div class="muted">Checking order statuses…</div>';
          }
          refreshPaymentOverlayIfOpen(purchase, assetInfo, netKey, serverNowIso);
          startTrackedPurchasePolling();
        }

        function updateQuote() {
          if (!quoteEl) return;

          var ca = caEl ? String(caEl.value || '').trim().toLowerCase() : '';
          var selected = assetsByCa[ca] || null;
          if (!selected) {
            quoteEl.textContent = 'Select an asset to see the broker quote.';
            if (btnEl) btnEl.disabled = false;
            return;
          }

          var minDisplay = selected.minAmountConfigured ? rawUnitsToDisplay(selected.minAmountRaw, selected.decimals) : '—';
          var paymentMethod = selected.assetRef || '—';
          var markupDisplay = (Number(selected.priceBps || 0) / 100).toFixed(2) + '%';
          var amountRaw = amtEl ? String(amtEl.value || '').trim() : '';
          var paymentPreview = 'Enter a human amount such as 4.00 to see the quoted payment.';

          if (amountRaw) {
            var amountUnits = parseDecimalToRawUnits(amountRaw, selected.decimals);
            if (amountUnits === null || amountUnits <= 0n) {
              paymentPreview = 'Enter a valid human amount using up to ' + String(selected.decimals) + ' decimals.';
            } else {
              var markupRaw = ceilDiv(amountUnits * BigInt(selected.priceBps), 10000n).toString();
              var quoteRaw = (amountUnits + BigInt(markupRaw)).toString();
              paymentPreview = rawUnitsToDisplay(quoteRaw, selected.decimals) + ' ' + paymentMethod;
            }
          }

          if (btnEl) btnEl.disabled = false;

          quoteEl.innerHTML =
            '<div><strong>Minimum buy:</strong> ' + escapeHtml(minDisplay) + '</div>' +
            '<div><strong>Payment method:</strong> ' + escapeHtml(paymentMethod) + '</div>' +
            '<div><strong>Broker markup:</strong> ' + escapeHtml(markupDisplay) + '</div>' +
            '<div><strong>Quoted payment amount:</strong> ' + escapeHtml(paymentPreview) + '</div>';
        }

        function validatePurchaseDraft() {
          if (msgEl) msgEl.textContent = '';

          var ca = caEl ? String(caEl.value || '').trim().toLowerCase() : '';
          var amountRaw = amtEl ? String(amtEl.value || '').trim() : '';
          var userKrcReceiveAddress = recvEl ? String(recvEl.value || '').trim() : '';
          var declaredPaymentSenderAddress = payerEl ? String(payerEl.value || '').trim() : '';
          var selected = assetsByCa[ca] || null;
          var priv0Hex = getKeyringPriv0Hex();

          if (!isHex64(ca)) {
            if (msgEl) msgEl.textContent = 'Invalid CA.';
            return null;
          }
          if (!selected) {
            if (msgEl) msgEl.textContent = 'Select a purchasable asset.';
            return null;
          }
          if (!priv0Hex) {
            if (msgEl) msgEl.textContent = 'Unlock your keyfile in the Wallet tab first to authorize the destination address.';
            return null;
          }
          if (!amountRaw) {
            if (msgEl) msgEl.textContent = 'Amount required.';
            return null;
          }

          var amountUnits = parseDecimalToRawUnits(amountRaw, selected.decimals);
          if (amountUnits === null || amountUnits <= 0n) {
            if (msgEl) msgEl.textContent = 'Enter a valid human amount using up to ' + String(selected.decimals) + ' decimals.';
            return null;
          }
          if (!userKrcReceiveAddress) {
            if (msgEl) msgEl.textContent = 'Receive address required.';
            return null;
          }
          if (!declaredPaymentSenderAddress) {
            if (msgEl) msgEl.textContent = 'Payer address required.';
            return null;
          }
          if (!isEvmAddress(declaredPaymentSenderAddress)) {
            if (msgEl) msgEl.textContent = 'Payer address must be a valid 0x address.';
            return null;
          }

          return {
            ca: ca,
            amountRaw: amountRaw,
            amountUnits: amountUnits,
            userKrcReceiveAddress: userKrcReceiveAddress,
            declaredPaymentSenderAddress: declaredPaymentSenderAddress,
            selected: selected,
            body: {
              networkId: networkId,
              ca: ca,
              amountRaw: amountRaw,
              userKrcReceiveAddress: userKrcReceiveAddress,
              declaredPaymentSenderAddress: declaredPaymentSenderAddress
            }
          };
        }

        function submitPurchaseDraft(draft) {
          if (!draft) return;
          if (btnEl) btnEl.disabled = true;

          fetchJson('/api/v1/bridge/purchase/request', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(draft.body)
          })
            .then(function (r) {
              if (!r || !r.httpOk || !r.body || r.body.ok !== true) {
                var reason = (r && r.body && (r.body.reason || r.body.error)) ? String(r.body.reason || r.body.error) : ('HTTP ' + (r ? r.status : '?'));
                var error = new Error(reason);
                error.responseBody = r && r.body ? r.body : null;
                throw error;
              }
              closeConfirmOverlay();
              var p = r.body.purchase || {};
              var pid = p.id ? String(p.id) : '(no id)';
              if (msgEl) msgEl.textContent = 'Purchase request created. ID: ' + pid + '.';
              rememberTrackedPurchase(p, draft.selected, r.body.serverNow || '');
              openPaymentOverlay(p, draft.selected, netKey, r.body.serverNow || '');
            })
            .catch(function (err) {
              var body = err && err.responseBody ? err.responseBody : null;
              if (body && body.reason === 'bridge_purchase_unpaid_payer_lock') {
                openPurchaseConfirmOverlay(draft, {
                  blocked: true,
                  existingPurchaseId: body.existingPurchaseId || '',
                  existingStatus: body.existingStatus || '',
                  existingExpiresAt: body.existingExpiresAt || ''
                });
                if (msgEl) msgEl.textContent = '';
                return;
              }
              closeConfirmOverlay();
              if (msgEl) msgEl.textContent = 'Submit failed: ' + String(err && err.message ? err.message : err);
            })
            .finally(function () {
              if (btnEl) btnEl.disabled = false;
            });
        }

        if (caEl) {
          caEl.addEventListener('change', function () {
            updateQuote();
            queuePayerLockPrecheck();
          });
        }
        if (amtEl) amtEl.addEventListener('input', updateQuote);
        if (payerEl) {
          payerEl.addEventListener('input', queuePayerLockPrecheck);
          payerEl.addEventListener('change', queuePayerLockPrecheck);
        }
        if (trackedEl) {
          trackedEl.addEventListener('click', function (ev) {
            var node = ev.target;
            while (node && node !== trackedEl) {
              if (node.getAttribute) {
                var purchaseId = node.getAttribute('data-open-payment');
                if (purchaseId) {
                  ev.preventDefault();
                  var trackedRow = trackedPurchaseRowsById[String(purchaseId)] || null;
                  if (trackedRow && trackedRow.purchase) {
                    openPaymentOverlay(
                      trackedRow.purchase,
                      trackedRow.assetInfo || null,
                      netKey,
                      trackedRow.serverNowIso || ''
                    );
                  }
                  return;
                }
              }
              node = node.parentNode;
            }
          });
        }
        updateQuote();

        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var draft = validatePurchaseDraft();
          if (!draft) return;

          runPayerLockPrecheck(draft, true)
            .then(function (payerLockState) {
              openPurchaseConfirmOverlay(draft, payerLockState);
            })
            .catch(function (err) {
              if (msgEl) msgEl.textContent = 'Unable to check unpaid order lock: ' + String(err && err.message ? err.message : err);
            });
        });

        var tracked = readTrackedPurchaseMeta();
        var hasTrackedForView = tracked.some(function (entry) {
          return entry && entry.netKey === netKey && entry.networkId === networkId && entry.id;
        });
        if (hasTrackedForView) {
          if (trackedEl) {
            trackedEl.style.display = 'block';
            trackedEl.innerHTML = '<div class="muted">Checking order statuses…</div>';
          }
          startTrackedPurchasePolling();
        } else if (!tracked.length) {
          writeTrackedPurchaseMeta([]);
        }
      }

      st.textContent = 'Loading broker wrapped offers…';
      mount.innerHTML = '<div class="muted">Loading…</div>';

      Promise.all([
        fetchJson('/api/wallet/status', { method: 'GET', headers: { 'Accept': 'application/json' } }),
        fetchJson('/api/wallet/holdings?strict=1', { method: 'GET', headers: { 'Accept': 'application/json' } }),
        fetchJson('/api/v1/wrapped-config', { method: 'GET', headers: { 'Accept': 'application/json' } })
      ])
        .then(function (parts) {
          var w = parts[0] && parts[0].body ? parts[0].body : {};
          var h = parts[1] && parts[1].body ? parts[1].body : {};
          var cfg = parts[2] && parts[2].body ? parts[2].body : {};

          if (!w || w.ok !== true) {
            if (w && w.reason === 'auth_required') {
              st.textContent = 'Login required.';
              mount.innerHTML = '<div class="muted">Please log in to submit purchase requests.</div>';
              return;
            }
            st.textContent = 'Unable to load wallet status.';
            mount.innerHTML = '<div class="muted">Cannot determine network. Try refreshing.</div>';
            return;
          }

          var walletNetwork = String(w.network || '').trim();
          var networkMeta = getNetworkMeta(walletNetwork);
          if (!networkMeta || !networkMeta.appKey || !networkMeta.kasplexNetworkId) {
            st.textContent = 'Unsupported wallet network.';
            mount.innerHTML = '<div class="muted">Cannot determine network. Try refreshing.</div>';
            return;
          }
          var networkId = String(networkMeta.kasplexNetworkId).trim();
          var netKey = String(networkMeta.appKey).trim();

          return fetchJson('/api/v1/bridge/inventory?net=' + encodeURIComponent(netKey), { method: 'GET', headers: { 'Accept': 'application/json' } })
            .then(function (invRes) {
              var inv = invRes && invRes.body ? invRes.body : {};
              var inventoryBalancesByCa = (inv && inv.ok === true && inv.balancesByCa && typeof inv.balancesByCa === 'object') ? inv.balancesByCa : {};
              var availableToBuyRawByCa = (inv && inv.ok === true && inv.availableToBuyRawByCa && typeof inv.availableToBuyRawByCa === 'object') ? inv.availableToBuyRawByCa : {};
              var assetsObj = (cfg && cfg.controlledAssetsByNetwork && cfg.controlledAssetsByNetwork[netKey]) ? cfg.controlledAssetsByNetwork[netKey] : null;
              if (!assetsObj || typeof assetsObj !== 'object') {
                st.textContent = 'No wrapped assets configured.';
                mount.innerHTML = '<div class="muted">No controlled assets found for this network.</div>';
                return;
              }

              var assets = Object.keys(assetsObj).map(function (k) {
                var v = assetsObj[k] || {};
                var fireblocks = (v && typeof v === 'object' && v.fireblocks && typeof v.fireblocks === 'object') ? v.fireblocks : null;
                var bridgePolicy = (v && typeof v === 'object' && v.bridgePolicy && typeof v.bridgePolicy === 'object') ? v.bridgePolicy : null;
                var purchase = (bridgePolicy && bridgePolicy.purchase && typeof bridgePolicy.purchase === 'object') ? bridgePolicy.purchase : null;

                var inventoryCompositeKey = (fireblocks && typeof fireblocks.inventoryCompositeKey === 'string') ? String(fireblocks.inventoryCompositeKey).trim() : '';
                var vaultAccountId = (fireblocks && typeof fireblocks.vaultAccountId === 'string') ? String(fireblocks.vaultAccountId).trim() : '';
                var assetId = (fireblocks && typeof fireblocks.assetId === 'string') ? String(fireblocks.assetId).trim() : '';
                var ca = String(v.ca || k || '').trim().toLowerCase();
                var assetRef = String(v.assetRef || '').trim();
                var decimals = (typeof v.decimals === 'number' && isFinite(Number(v.decimals)) && Number(v.decimals) >= 0) ? Number(v.decimals) : null;
                var priceBps = (purchase && typeof purchase.priceBps === 'number' && isFinite(Number(purchase.priceBps)) && Number(purchase.priceBps) >= 0) ? Number(purchase.priceBps) : NaN;
                var minAmountRaw = (purchase && typeof purchase.minAmountRaw === 'string' && /^\d+$/.test(String(purchase.minAmountRaw).trim())) ? String(purchase.minAmountRaw).trim() : '';
                var inventoryRaw = inventoryRawUnitsFromValue(inventoryBalancesByCa[ca]);
                var availableToBuyRaw = inventoryRawUnitsFromValue(availableToBuyRawByCa[ca]);

                return {
                  ca: ca,
                  name: String(v.name || v.assetRef || k || '').trim(),
                  decimals: decimals,
                  assetRef: assetRef,
                  minAmountRaw: minAmountRaw,
                  priceBps: priceBps,
                  inventoryRaw: inventoryRaw,
                  availableToBuyRaw: availableToBuyRaw,
                  inventoryKnown: availableToBuyRaw !== '',
                  offerEnabled: (v && typeof v === 'object') ? (v.offerEnabled !== false) : true,
                  fireblocksEnabled: !!(fireblocks && fireblocks.enabled === true),
                  fireblocksReady: !!(inventoryCompositeKey && vaultAccountId && assetId),
                  purchaseEnabled: !!(purchase && purchase.enabled === true),
                  purchasePriceConfigured: isFinite(priceBps),
                  minAmountConfigured: !!minAmountRaw,
                  assetRefConfigured: !!assetRef
                };
              }).filter(function (a) { return isHex64(a.ca); });

              assets.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

              var avail = assets.filter(function (a) {
                if (a && a.offerEnabled === false) return false;
                if (!a || a.fireblocksEnabled !== true) return false;
                if (a.fireblocksReady !== true) return false;
                if (a.purchaseEnabled !== true) return false;
                if (a.purchasePriceConfigured !== true) return false;
                if (a.minAmountConfigured !== true) return false;
                if (a.assetRefConfigured !== true) return false;
                if (!Number.isInteger(a.decimals)) return false;
                return true;
              });

              if (!avail.length) {
                setNotConfigured();
                return;
              }

              var defaultReceive = h && typeof h.address === 'string' ? String(h.address).trim() : '';

              st.textContent = 'Ready.';
              renderForm({
                netKey: netKey,
                networkId: networkId,
                assets: avail,
                defaultReceive: defaultReceive
              });
            });
        })
        .catch(function (err) {
          st.textContent = 'Error loading broker wrapped offers.';
          mount.innerHTML = '<div class="muted">Error: ' + String(err && err.message ? err.message : err) + '</div>';
        });
    })();

    var mySwapsHistory = $('mySwapsShowHistory');
    if (mySwapsHistory) {
      mySwapsHistory.addEventListener('change', function () {
        loadMySwaps();
      });
    }

    loadTakerWallet();
    loadOffers();
    loadMySwaps();
  });
})();

