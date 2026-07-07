(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function parseDisplayLabelForKaspaAddress(addr) {
    var value = String(addr || '').trim();
    if (!value) return 'KAS';
    return 'KAS';
  }

  var sponsoredOpenOfferCatalog = [];
  var OPEN_HIDE_MY_LIVE_OFFERS_KEY = 'td_hide_my_open_swap_offers_v1';
  var openMineOpenOfferIds = Object.create(null);
  var openMineActiveWalletId = '';

  function readOpenHideMyLiveOffers() {
    try { return localStorage.getItem(OPEN_HIDE_MY_LIVE_OFFERS_KEY) === '1'; } catch (_) { return false; }
  }

  function writeOpenHideMyLiveOffers(value) {
    try { localStorage.setItem(OPEN_HIDE_MY_LIVE_OFFERS_KEY, value ? '1' : '0'); } catch (_) {}
  }

  function buildOpenOfferIdMap(items) {
    var map = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (item) {
      var offerId = normalizeOfferText(item && item.offerId);
      if (offerId) map[offerId] = true;
    });
    return map;
  }

  function isOpenMineOffer(offer) {
    if (!offer || typeof offer !== 'object') return false;
    var offerId = normalizeOfferText(offer.offerId);
    if (offerId && openMineOpenOfferIds[offerId]) return true;
    var makerWalletId = normalizeOfferText(offer.makerWalletId);
    return !!(openMineActiveWalletId && makerWalletId && makerWalletId === openMineActiveWalletId);
  }

  function ensureOpenLiveOfferFilterControl() {
    var listEl = document.getElementById('openOffersList');
    if (!listEl || !listEl.parentNode) return;

    var existing = document.getElementById('hideMyOpenSwapOffers');
    if (existing) return;

    var wrap = document.createElement('div');
    wrap.className = 'offer-sub';
    wrap.style.margin = '.35rem 0 .65rem';

    var label = document.createElement('label');
    label.className = 'td-switch-row';
    label.setAttribute('for', 'hideMyOpenSwapOffers');

    var input = document.createElement('input');
    input.id = 'hideMyOpenSwapOffers';
    input.type = 'checkbox';
    input.checked = readOpenHideMyLiveOffers();
    input.addEventListener('change', function () {
      writeOpenHideMyLiveOffers(!!input.checked);
      window.location.reload();
    });

    var track = document.createElement('span');
    track.className = 'td-switch-track';
    track.setAttribute('aria-hidden', 'true');

    var text = document.createElement('span');
    text.textContent = 'Hide My Open Swap Offers (others can still see them)';

    label.appendChild(input);
    label.appendChild(track);
    label.appendChild(text);
    wrap.appendChild(label);
    listEl.parentNode.insertBefore(wrap, listEl);
  }

  function normalizeOfferText(raw) {
    return String(raw == null ? '' : raw).trim();
  }

  function normalizeOfferLower(raw) {
    return normalizeOfferText(raw).toLowerCase();
  }

  function normalizeOfferCa(raw) {
    var value = normalizeOfferLower(raw);
    if (value.indexOf('ca:') === 0) return value.slice(3);
    return value;
  }

  function normalizeOfferNumber(raw) {
    var value = normalizeOfferText(raw).replace(/,/g, '');
    var num = Number(value);
    if (!Number.isFinite(num)) return '';
    return String(num);
  }

  function getOfferDescription(offer) {
    return normalizeOfferText(offer && (offer.offerDescription || offer.offer_description || offer.description));
  }

  function getOfferInfoUrl(offer) {
    var value = normalizeOfferText(offer && (offer.offerInfoUrl || offer.offer_info_url || offer.info_url));
    if (!value) return '';

    try {
      var parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  function normalizeSponsoredCatalogItem(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var packageType = normalizeOfferText(raw.package_type).toUpperCase();
    if (packageType !== 'PLUS' && packageType !== 'PRO' && packageType !== 'TENANT') return null;

    var ca = normalizeOfferCa(raw.trigger_ca);
    var seller = normalizeOfferLower(raw.seller_address);
    var networkId = normalizeOfferLower(raw.network || 'mainnet');
    if (!/^[0-9a-f]{64}$/.test(ca)) return null;
    if (networkId !== 'mainnet') return null;
    if (seller.indexOf('kaspa:') !== 0) return null;

    var label = normalizeOfferText(raw.trigger_label) || packageType;
    var id = normalizeOfferText(raw.id) || (packageType.toLowerCase() + ':' + ca + ':' + seller);

    return {
      id: id,
      label: label,
      purpose: packageType + ' entitlement purchase',
      networkId: networkId,
      kind: 'ca_to_kas',
      ca: ca,
      seller: seller,
      packageType: packageType,
      ownerScope: normalizeOfferText(raw.owner_scope)
    };
  }

  function setSponsoredOpenOfferCatalog(items) {
    sponsoredOpenOfferCatalog = (Array.isArray(items) ? items : [])
      .map(normalizeSponsoredCatalogItem)
      .filter(function (item) { return !!item; });
  }

  function findSponsoredOpenOfferCatalog(offer) {
    var networkId = normalizeOfferLower(offer && offer.networkId);
    var kind = normalizeOfferLower(offer && offer.kind);
    var sellCa = normalizeOfferCa(offer && offer.sellSymbol);
    var seller = normalizeOfferLower(offer && offer.makerKasReceiveAddress);
    var state = normalizeOfferLower(offer && offer.state);

    for (var i = 0; i < sponsoredOpenOfferCatalog.length; i++) {
      var item = sponsoredOpenOfferCatalog[i];
      if (networkId !== item.networkId) continue;
      if (kind !== item.kind) continue;
      if (sellCa !== item.ca) continue;
      if (seller !== item.seller) continue;
      if (state && state !== 'open') continue;
      return item;
    }

    return null;
  }

  function buildOpenOfferGroupKey(offer, catalog) {
    var sellSymbol = catalog ? catalog.ca : normalizeOfferCa(offer && offer.sellSymbol);
    return [
      normalizeOfferLower(offer && offer.networkId),
      normalizeOfferLower(offer && offer.kind),
      sellSymbol,
      normalizeOfferNumber(offer && offer.sellAmount),
      normalizeOfferNumber(offer && offer.buyAmountKas),
      normalizeOfferLower(offer && offer.makerKasReceiveAddress),
      getOfferDescription(offer),
      getOfferInfoUrl(offer),
      catalog ? catalog.id : ''
    ].join('|');
  }

  function buildOpenOfferGroups(items) {
    var sponsored = [];
    var normal = [];
    var byKey = Object.create(null);

    (items || []).forEach(function (offer) {
      var catalog = findSponsoredOpenOfferCatalog(offer);
      var key = buildOpenOfferGroupKey(offer, catalog);
      var group = byKey[key];

      if (!group) {
        group = { key: key, catalog: catalog, offers: [] };
        byKey[key] = group;
        if (catalog) sponsored.push(group);
        else normal.push(group);
      }

      group.offers.push(offer);
    });

    return { sponsored: sponsored, normal: normal };
  }

  function chooseOpenOfferFromGroup(group) {
    var offers = group && Array.isArray(group.offers) ? group.offers : [];
    if (!offers.length) return null;
    var idx = Math.floor(Math.random() * offers.length);
    return offers[idx] || offers[0];
  }

  function parseOfferBlobText(rawText) {
    var raw = String(rawText || '').trim();
    if (!raw) throw new Error('offer_blob_required');

    var parsed = JSON.parse(raw);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('offer_blob_object_required');
    }
    return parsed;
  }

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });

    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { ok: false, reason: 'invalid_json_response', raw: text };
    }

    if (!res.ok) {
      var reason = data && data.reason ? data.reason : ('http_' + res.status);
      var err = new Error(reason);
      err.response = data;
      throw err;
    }

    return data;
  }

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

  function signBcwOpenSwapFinalizeIntent(intentMessage, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var message = String(intentMessage || '').trim();
      var privHex = String(priv0Hex || '').trim();
      if (!message) throw new Error('bcw_open_swap_finalize_intent_message_missing');
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
      var txRaw = String(txSafeJson || '').trim();
      if (!txRaw) throw new Error('finalize_tx_missing');

      var indexes = Array.isArray(inputsToSign) ? inputsToSign : [];
      if (!indexes.length) throw new Error('finalize_inputs_to_sign_missing');

      var priv0 = new kaspa.PrivateKey(priv0Hex);
      var tx = kaspa.Transaction.deserializeFromSafeJSON(txRaw);
      var signMode = (signCtx && typeof signCtx.sign_mode === 'string') ? String(signCtx.sign_mode) : '';

      if (signMode === 'compliance') {
        throw new Error('legacy_compliance_open_swap_signing_removed');
      }

      var sigs = [];
      for (var i = 0; i < indexes.length; i++) {
        var idx = indexes[i];
        var sig = kaspa.createInputSignature(tx, idx, priv0, null);
        sigs.push(sig);
      }
      return sigs;
    });
  }


  function kcc20OpenHexToBytes(hex, reason) {
    var s = String(hex || '').trim().toLowerCase();
    if (!/^[0-9a-f]*$/i.test(s) || s.length % 2 !== 0) throw new Error(reason || 'invalid_hex');
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function kcc20OpenBytesFromSignature(sig, reason) {
    if (sig instanceof Uint8Array) return sig;
    if (Array.isArray(sig)) return new Uint8Array(sig);
    if (typeof sig === 'string') return kcc20OpenHexToBytes(sig, reason || 'signature_hex_invalid');
    if (sig && typeof sig.toString === 'function') {
      var text = String(sig.toString()).trim();
      if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) return kcc20OpenHexToBytes(text, reason || 'signature_to_string_hex_invalid');
    }
    throw new Error(reason || 'signature_bytes_unavailable');
  }

  function kcc20OpenNormalizeKaspaInputSignature(sig) {
    var raw = kcc20OpenBytesFromSignature(sig, 'kcc20_open_signature_bytes_unavailable');
    if (raw.length === 66 && raw[0] === 0x41) return raw.slice(1);
    return raw;
  }

  function kcc20OpenSha256HexText(text) {
    var bytes = new TextEncoder().encode(String(text || ''));
    return crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
      return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function kcc20OpenSpkBytesHexFromSummary(spk) {
    var version = Number(spk && spk.version !== undefined ? spk.version : 0);
    var script = String(spk && spk.script ? spk.script : '').trim().toLowerCase();
    if (!Number.isInteger(version) || version < 0 || version > 0xffff) throw new Error('kcc20_open_spk_version_invalid');
    if (!/^[0-9a-f]*$/i.test(script) || script.length % 2 !== 0) throw new Error('kcc20_open_spk_script_invalid');
    return version.toString(16).padStart(4, '0') + script;
  }

  function kcc20OpenSetInputSignatureScript(tx, inputIndex, signatureScript, reason) {
    if (!tx || !Array.isArray(tx.inputs) || !tx.inputs[inputIndex]) throw new Error(reason || 'kcc20_open_input_missing');
    tx.inputs[inputIndex].signatureScript = signatureScript;
    tx.inputs = tx.inputs;
  }

  function kcc20OpenRefundSelectorBytes(selectorHex) {
    var normalized = String(selectorHex || '').trim().toLowerCase();
    if (normalized === '' || normalized === '00') return new Uint8Array();
    return kcc20OpenHexToBytes(normalized, 'kcc20_open_refund_selector_hex_invalid');
  }

  function kcc20OpenAddressMustMatch(kaspa, priv0, networkId, expectedAddress) {
    var expected = String(expectedAddress || '').trim();
    var network = String(networkId || '').trim();
    if (!expected || !network) return;
    var derived = String(priv0.toAddress(network).toString());
    if (derived !== expected) throw new Error('kcc20_open_active_key_does_not_match_build_fromAddress');
  }

  function signKcc20AtomicOpenTakerClaimBuild(build, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var privHex = String(priv0Hex || '').trim();
      if (!privHex) throw new Error('wallet_locked');
      if (!build || build.ok !== true) throw new Error('kcc20_open_taker_claim_build_not_ready');

      var priv0 = new kaspa.PrivateKey(privHex);
      kcc20OpenAddressMustMatch(kaspa, priv0, build.networkId, build.fromAddress);

      var ctx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
      var signIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(function (n) { return Number(n); }) : [];
      var signSet = new Set(signIndexes);
      var holderInputIndex = Number(ctx.holder_input_index);
      var fundingInputIndex = Number(ctx.native_kas_funding_input_index);
      var redeemScriptHex = String(ctx.source_swap_locked_holder_redeem_script_hex || '').trim().toLowerCase();
      var selectorHex = String(ctx.claim_selector_hex || build.claim_selector_hex || '01').trim().toLowerCase();

      if (!Number.isInteger(holderInputIndex) || holderInputIndex < 0 || !signSet.has(holderInputIndex)) throw new Error('kcc20_open_taker_claim_holder_input_not_signable');
      if (!Number.isInteger(fundingInputIndex) || fundingInputIndex < 0 || !signSet.has(fundingInputIndex)) throw new Error('kcc20_open_taker_claim_funding_input_not_signable');
      if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) throw new Error('kcc20_open_taker_claim_redeem_script_missing');
      if (!/^[0-9a-f]+$/i.test(selectorHex) || selectorHex.length % 2 !== 0) throw new Error('kcc20_open_taker_claim_selector_invalid');

      var tx = kaspa.Transaction.deserializeFromSafeJSON(build.txToSignSafeJson);
      var output1SpkBytesHex = kcc20OpenSpkBytesHexFromSummary(build.outputs[1].scriptPublicKey);
      return kcc20OpenSha256HexText(output1SpkBytesHex).then(function (output1SpkTextHash) {
        var expectedOutput1SpkTextHash = String(ctx.claim_dynamic_taker_spk_hex_sha256 || '').trim().toLowerCase();
        if (ctx.claim_dynamic_taker_spk_required !== true) throw new Error('kcc20_open_dynamic_taker_spk_not_required');
        if (output1SpkTextHash !== expectedOutput1SpkTextHash) throw new Error('kcc20_open_dynamic_taker_spk_text_hash_mismatch');

        var selectorSignatureScript = new kaspa.ScriptBuilder()
          .addData(kcc20OpenHexToBytes(output1SpkBytesHex, 'kcc20_open_output1_spk_bytes_invalid'))
          .addData(kcc20OpenHexToBytes(selectorHex, 'kcc20_open_selector_hex_invalid'))
          .addData(kcc20OpenHexToBytes(redeemScriptHex, 'kcc20_open_redeem_script_hex_invalid'))
          .drain();

        kcc20OpenSetInputSignatureScript(tx, holderInputIndex, selectorSignatureScript, 'kcc20_open_holder_selector_signature_script_missing');
        kcc20OpenSetInputSignatureScript(tx, fundingInputIndex, kaspa.createInputSignature(tx, fundingInputIndex, priv0, null), 'kcc20_open_funding_signature_missing');
        tx.finalize();

        var signedSafeJson = tx.serializeToSafeJSON();
        kaspa.Transaction.deserializeFromSafeJSON(signedSafeJson);
        return kcc20OpenSha256HexText(signedSafeJson).then(function (sha) {
          return {
            signed_safe_json: signedSafeJson,
            signed_safe_json_sha256: sha,
            holder_input_index: holderInputIndex,
            native_kas_funding_input_index: fundingInputIndex,
            output1_spk_text_hash_matches_context: true
          };
        });
      });
    });
  }

  function signKcc20AtomicOpenMakerRefundBuild(build, priv0Hex) {
    return kaspaReadyOrThrow().then(function (kaspa) {
      var privHex = String(priv0Hex || '').trim();
      if (!privHex) throw new Error('wallet_locked');
      if (!build || build.ok !== true) throw new Error('kcc20_open_maker_refund_build_not_ready');

      var priv0 = new kaspa.PrivateKey(privHex);
      kcc20OpenAddressMustMatch(kaspa, priv0, build.networkId, build.fromAddress);

      var ctx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
      var signIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(function (n) { return Number(n); }) : [];
      var signSet = new Set(signIndexes);
      var holderInputIndex = Number(ctx.holder_input_index);
      var redeemScriptHex = String(ctx.source_swap_locked_holder_redeem_script_hex || '').trim().toLowerCase();
      var selectorHex = String(ctx.refund_selector_hex || build.refund_selector_hex || '00').trim().toLowerCase();

      if (!Number.isInteger(holderInputIndex) || holderInputIndex < 0 || !signSet.has(holderInputIndex)) throw new Error('kcc20_open_maker_refund_holder_input_not_signable');
      if (!/^[0-9a-f]+$/i.test(redeemScriptHex) || redeemScriptHex.length % 2 !== 0) throw new Error('kcc20_open_maker_refund_redeem_script_missing');

      var tx = kaspa.Transaction.deserializeFromSafeJSON(build.txToSignSafeJson);
      var selectorBytes = kcc20OpenRefundSelectorBytes(selectorHex);
      var redeemScriptBytes = kcc20OpenHexToBytes(redeemScriptHex, 'kcc20_open_maker_refund_redeem_script_hex_invalid');
      var dummySig = new Uint8Array(65);

      var dummySignatureScript = new kaspa.ScriptBuilder()
        .addData(dummySig)
        .addData(selectorBytes)
        .addData(redeemScriptBytes)
        .drain();
      kcc20OpenSetInputSignatureScript(tx, holderInputIndex, dummySignatureScript, 'kcc20_open_maker_refund_dummy_signature_script_missing');

      var rawSig = kaspa.createInputSignature(tx, holderInputIndex, priv0, null);
      var rawSigBytes = kcc20OpenBytesFromSignature(rawSig, 'kcc20_open_maker_refund_raw_signature_unavailable');
      var finalSig = kcc20OpenNormalizeKaspaInputSignature(rawSig);
      if (rawSigBytes.length !== 66 || rawSigBytes[0] !== 0x41) throw new Error('kcc20_open_maker_refund_signature_shape_unexpected');
      if (finalSig.length !== 65) throw new Error('kcc20_open_maker_refund_unwrapped_signature_length_not_65');

      var finalSignatureScript = new kaspa.ScriptBuilder()
        .addData(finalSig)
        .addData(selectorBytes)
        .addData(redeemScriptBytes)
        .drain();
      kcc20OpenSetInputSignatureScript(tx, holderInputIndex, finalSignatureScript, 'kcc20_open_maker_refund_final_signature_script_missing');

      tx.finalize();
      var signedSafeJson = tx.serializeToSafeJSON();
      kaspa.Transaction.deserializeFromSafeJSON(signedSafeJson);
      return kcc20OpenSha256HexText(signedSafeJson).then(function (sha) {
        return {
          signed_safe_json: signedSafeJson,
          signed_safe_json_sha256: sha,
          holder_input_index: holderInputIndex,
          raw_signature_byte_len: rawSigBytes.length,
          raw_signature_first_byte: rawSigBytes[0],
          unwrapped_signature_byte_len: finalSig.length
        };
      });
    });
  }

  function validateImportedOffer(offer) {
    var errors = [];
    var warnings = [];

    if (!offer || typeof offer !== 'object') {
      errors.push('offer_blob_object_required');
      return { ok: false, errors: errors, warnings: warnings };
    }

    if (offer.version !== 1) errors.push('offer_version_invalid');
    if (offer.mode !== 'open_swap_v2') errors.push('offer_mode_invalid');
    if (offer.discovery !== 'manual_import') errors.push('offer_discovery_invalid');
    if (offer.fillMode !== 'full_fill_only') errors.push('offer_fill_mode_invalid');

    var protocol = offer.protocol && typeof offer.protocol === 'object' ? offer.protocol : null;
    if (!protocol) {
      errors.push('offer_protocol_missing');
    } else {
      if (protocol.makerOp !== 'list') errors.push('offer_protocol_maker_op_invalid');
      if (protocol.takerOp !== 'send') errors.push('offer_protocol_taker_op_invalid');
    }

    if (offer.kind !== 'tick_to_kas' && offer.kind !== 'ca_to_kas') {
      errors.push('offer_kind_invalid');
    }

    var maker = offer.maker && typeof offer.maker === 'object' ? offer.maker : null;
    if (!maker) {
      errors.push('offer_maker_missing');
    } else {
      var makerWalletType = String(maker.walletType || '').trim().toLowerCase();
      var makerCustodyModel = String(maker.custodyModel || '').trim().toLowerCase();
      var makerIsStandard = makerWalletType === 'standard';
      var makerIsBcw = makerWalletType === 'compliance' && makerCustodyModel === 'broker_1of1';

      if (!makerIsStandard && !makerIsBcw) errors.push('offer_maker_wallet_type_invalid');
      if (!maker.walletId) errors.push('offer_maker_wallet_id_missing');
      if (!maker.networkId) errors.push('offer_maker_network_id_missing');
      if (!maker.kasReceiveAddress) errors.push('offer_maker_kas_receive_address_missing');

      if (makerIsStandard && !maker.userPubkey) errors.push('offer_maker_user_pubkey_missing');
      if (makerIsBcw && !maker.brokerCustodyKeyRef) errors.push('offer_maker_broker_custody_key_ref_missing');
      if (makerIsBcw && !maker.userAuthPubkey) errors.push('offer_maker_user_auth_pubkey_missing');
    }

    var sell = offer.sell && typeof offer.sell === 'object' ? offer.sell : null;
    if (!sell) {
      errors.push('offer_sell_missing');
    } else {
      if (sell.type !== 'KRC20') errors.push('offer_sell_type_invalid');
      if (!sell.amount) errors.push('offer_sell_amount_missing');
      if (offer.kind === 'tick_to_kas') {
        if (sell.kind !== 'TICK') errors.push('offer_sell_kind_invalid');
        if (!sell.ticker) errors.push('offer_sell_ticker_missing');
      }
      if (offer.kind === 'ca_to_kas') {
        if (sell.kind !== 'CA') errors.push('offer_sell_kind_invalid');
        if (!sell.ca) errors.push('offer_sell_ca_missing');
      }
    }

    var buy = offer.buy && typeof offer.buy === 'object' ? offer.buy : null;
    if (!buy) {
      errors.push('offer_buy_missing');
    } else {
      if (buy.type !== 'KAS') errors.push('offer_buy_type_invalid');
      if (!buy.amount) errors.push('offer_buy_amount_missing');
    }

    var hasOfferTtl = offer.ttl === 0 || !!offer.ttl;
    var offerTtlSeconds = Number(offer.ttl);
    var isGtcOffer = hasOfferTtl && isFinite(offerTtlSeconds) && offerTtlSeconds === 0;
    if (!hasOfferTtl) errors.push('offer_ttl_missing');
    if (!offer.createdAt) errors.push('offer_created_at_missing');
    if (!isGtcOffer && !offer.expiresAt) errors.push('offer_expires_at_missing');

    if (!offer.makerListPayload || typeof offer.makerListPayload !== 'object') errors.push('offer_maker_list_payload_missing');
    if (!offer.makerSendPayload || typeof offer.makerSendPayload !== 'object') errors.push('offer_maker_send_payload_missing');
    if (!offer.makerListPskb) errors.push('offer_maker_list_pskb_missing');
    if (!offer.makerSendPskb) errors.push('offer_maker_send_pskb_missing');
    if (!offer.listCommitTxids || !Array.isArray(offer.listCommitTxids) || !offer.listCommitTxids.length) errors.push('offer_list_commit_txids_missing');
    if (!offer.listRevealTxid) errors.push('offer_list_reveal_txid_missing');
    if (!offer.p2shSendOutpoint || typeof offer.p2shSendOutpoint !== 'object') {
      errors.push('offer_p2sh_send_outpoint_missing');
    } else {
      if (!offer.p2shSendOutpoint.txid) errors.push('offer_p2sh_send_outpoint_txid_missing');
      if (offer.p2shSendOutpoint.index !== 0 && offer.p2shSendOutpoint.index !== 1 && offer.p2shSendOutpoint.index !== 2 && offer.p2shSendOutpoint.index !== 3) {
        errors.push('offer_p2sh_send_outpoint_index_missing');
      }
    }
    if (!offer.p2shSendSompi) errors.push('offer_p2sh_send_sompi_missing');
    if (!offer.sendP2shAddress) errors.push('offer_send_p2sh_address_missing');
    if (!offer.sendRedeemScriptHex) errors.push('offer_send_redeem_script_hex_missing');
    if (!offer.termsCommitment) errors.push('offer_terms_commitment_missing');

    if (!isGtcOffer) {
      var expiresAtMs = Date.parse(String(offer.expiresAt || ''));
      if (!isFinite(expiresAtMs)) {
        errors.push('offer_expires_at_invalid');
      } else {
        var now = Date.now();
        if (expiresAtMs <= now) {
          errors.push('offer_expired');
        } else if ((expiresAtMs - now) < (10 * 60 * 1000)) {
          warnings.push('offer_expires_soon');
        }
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  function renderAcceptPreview(previewEl, data) {
    if (!previewEl) return;
    previewEl.innerHTML = '';
    previewEl.style.display = 'none';
  }

  function renderImportedOffer(reviewEl, offer, validation) {
    if (!reviewEl) return;
    reviewEl.innerHTML = '';
    reviewEl.style.display = 'none';
  }

  function init() {
    var mount = document.getElementById("openSwapV2OffersMount");
    if (!mount) return;

    var section = document.getElementById('openOffersSection');
    var status = document.getElementById('openOffersStatus');
    var list = document.getElementById('openOffersList');

    function clearReview() {}

    function getSwapAnalyzerSharedOrNull() {
      var shared = window.SwapAnalyzerShared;
      if (!shared || typeof shared.renderAnalyzer !== 'function' || typeof shared.clearAnalyzer !== 'function') {
        return null;
      }
      return shared;
    }

    function getOpenAnalyzerRefs() {
      return {
        panel: document.getElementById('openAnalyzerPanel'),
        summary: document.getElementById('openAnalyzerSummary'),
        hints: document.getElementById('openAnalyzerHints'),
        statusBadge: document.getElementById('openAnalyzerStatusBadge'),
        blockers: document.getElementById('openAnalyzerBlockers'),
        notes: document.getElementById('openAnalyzerNotes'),
        summarySellAsset: document.getElementById('openSummarySellAsset'),
        summarySellAmount: document.getElementById('openSummarySellAmount'),
        summaryBuyAsset: document.getElementById('openSummaryBuyAsset'),
        summaryBuyAmount: document.getElementById('openSummaryBuyAmount'),
        sellMeta: {
          header: document.getElementById('openAssetMetaSellHeader'),
          ticker: document.getElementById('openAssetMetaSellTicker'),
          name: document.getElementById('openAssetMetaSellName'),
          type: document.getElementById('openAssetMetaSellType'),
          decimals: document.getElementById('openAssetMetaSellDecimals'),
          contractAddress: document.getElementById('openAssetMetaSellContractAddress'),
          totalMinted: document.getElementById('openAssetMetaSellTotalMinted'),
          maxSupply: document.getElementById('openAssetMetaSellMaxSupply'),
          holders: document.getElementById('openAssetMetaSellHolders'),
          transfers: document.getElementById('openAssetMetaSellTransfers'),
          mints: document.getElementById('openAssetMetaSellMints'),
          explorerLink: document.getElementById('openAssetMetaSellExplorerLink')
        },
        buyMeta: {
          header: document.getElementById('openAssetMetaBuyHeader'),
          ticker: document.getElementById('openAssetMetaBuyTicker'),
          name: document.getElementById('openAssetMetaBuyName'),
          type: document.getElementById('openAssetMetaBuyType'),
          decimals: document.getElementById('openAssetMetaBuyDecimals'),
          contractAddress: document.getElementById('openAssetMetaBuyContractAddress'),
          totalMinted: document.getElementById('openAssetMetaBuyTotalMinted'),
          maxSupply: document.getElementById('openAssetMetaBuyMaxSupply'),
          holders: document.getElementById('openAssetMetaBuyHolders'),
          transfers: document.getElementById('openAssetMetaBuyTransfers'),
          mints: document.getElementById('openAssetMetaBuyMints'),
          explorerLink: document.getElementById('openAssetMetaBuyExplorerLink')
        }
      };
    }

    function paymentDisplayLabelForOpenOffer(imported, preview) {
      var sendContext = preview && preview.sendContext && typeof preview.sendContext === 'object'
        ? preview.sendContext
        : {};
      var sendAsset = typeof sendContext.asset === 'string' ? String(sendContext.asset).trim().toUpperCase() : '';
      if (sendAsset === 'TKAS') return 'KAS';

      var maker = imported && imported.maker && typeof imported.maker === 'object' ? imported.maker : {};
      var recvAddr = typeof maker.kasReceiveAddress === 'string' ? String(maker.kasReceiveAddress).trim() : '';
      return parseDisplayLabelForKaspaAddress(recvAddr);
    }

    function buildOpenAnalyzerPayload(imported, preview) {
      if (!imported || typeof imported !== 'object') return null;

      var sell = imported.sell && typeof imported.sell === 'object' ? imported.sell : {};
      var buy = imported.buy && typeof imported.buy === 'object' ? imported.buy : {};
      var maker = imported.maker && typeof imported.maker === 'object' ? imported.maker : {};

      var sellKind = typeof sell.kind === 'string' ? String(sell.kind).trim().toUpperCase() : '';
      var sellSymbol = '';
      if (sellKind === 'CA') {
        var ca = typeof sell.ca === 'string' ? String(sell.ca).trim().toLowerCase() : '';
        sellSymbol = ca ? ('CA:' + ca) : '';
      } else {
        sellSymbol = typeof sell.ticker === 'string' ? String(sell.ticker).trim().toUpperCase() : '';
      }

      var sellAmount = typeof sell.amount === 'string' || typeof sell.amount === 'number'
        ? String(sell.amount).trim()
        : '';
      var buyAmount = typeof buy.amount === 'string' || typeof buy.amount === 'number'
        ? String(buy.amount).trim()
        : '';
      var recvAddr = typeof maker.kasReceiveAddress === 'string' ? String(maker.kasReceiveAddress).trim() : '';

      return {
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
        ttl: typeof imported.ttl === 'number' ? imported.ttl : (Number(imported.ttl || 0) || 0),
        partial: { enabled: false },
        maker: {
          wid: typeof maker.walletId === 'string' ? String(maker.walletId).trim() : '',
          fromAddr: recvAddr
        },
        receiveEndpoint: {
          address: recvAddr
        }
      };
    }

    async function analyzeImportedOffer(imported, preview) {
      var payload = buildOpenAnalyzerPayload(imported, preview);
      if (!payload) return null;

      var analyzed = await postJSON('/api/offers/analyze', payload);
      if (!analyzed || typeof analyzed !== 'object') return null;

      var sendContext = preview && preview.sendContext && typeof preview.sendContext === 'object'
        ? preview.sendContext
        : {};
      var out = Object.assign({}, analyzed);
      var solvency = out.solvency && typeof out.solvency === 'object' ? Object.assign({}, out.solvency) : {};
      var fees = out.fees && typeof out.fees === 'object' ? Object.assign({}, out.fees) : {};
      var previewReady = !!(
        typeof sendContext.fromAddress === 'string' &&
        String(sendContext.fromAddress).trim() &&
        (typeof sendContext.amount === 'string' || typeof sendContext.amount === 'number') &&
        String(sendContext.amount).trim()
      );

      if (previewReady) {
        solvency.sell_ok = true;
        solvency.fee_ok = true;
      }

      out.solvency = solvency;
      out.fees = fees;

      var notes = Array.isArray(out.notes) ? out.notes.filter(function (note) {
        var text = String(note || '').trim();
        return text.indexOf('Analyzer: holdings lookup') !== 0;
      }) : [];

      return {
        out: out,
        payload: payload,
        blockers: Array.isArray(out.blockers) ? out.blockers.slice() : [],
        notes: notes,
        paymentDisplayLabel: paymentDisplayLabelForOpenOffer(imported, preview),
        fromAddress: typeof sendContext.fromAddress === 'string' ? String(sendContext.fromAddress).trim() : ''
      };
    }

    function updateOpenFillPanel(state) {
      var sectionEl = document.getElementById('openFillSection');
      var summaryEl = document.getElementById('openFillSummary');
      var offerEl = document.getElementById('openFillPskt');
      var sendEl = document.getElementById('openFillSendCtx');
      var statusEl = document.getElementById('openFillStatus');
      var btn = document.getElementById('openFillConfirmBtn');
      var closeBtn = document.getElementById('openFillCloseBtn');
      if (!sectionEl || !summaryEl || !offerEl || !sendEl || !statusEl) return;

      var shared = getSwapAnalyzerSharedOrNull();
      var analyzerRefs = getOpenAnalyzerRefs();

      if (!state) {
        mount.__openSwapV2AnalyzerState = null;
        sectionEl.style.display = 'none';
        summaryEl.textContent = '';
        offerEl.textContent = '';
        sendEl.textContent = '';
        statusEl.textContent = '';
        statusEl.classList.remove('open-fill-success');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Confirm & Sign Swap';
        }
        if (closeBtn) {
          closeBtn.textContent = 'Close';
        }
        if (analyzerRefs.panel) analyzerRefs.panel.style.display = 'none';
        if (shared) shared.clearAnalyzer(analyzerRefs);
        return;
      }

      sectionEl.style.display = 'block';
      summaryEl.textContent = state.summary || '';
      offerEl.textContent = state.offerText || '';
      sendEl.textContent = state.sendText || '';
      statusEl.textContent = state.status || '';
      statusEl.classList.toggle('open-fill-success', state.statusKind === 'success');

      if (btn) {
        btn.disabled = !state.canConfirm;
        btn.textContent = state.buttonLabel || 'Confirm & Sign Swap';
      }
      if (closeBtn) {
        closeBtn.textContent = state.closeLabel || 'Close';
      }

      var analyzerState = Object.prototype.hasOwnProperty.call(state, 'analyzerState')
        ? state.analyzerState
        : mount.__openSwapV2AnalyzerState;

      if (!Object.prototype.hasOwnProperty.call(state, 'analyzerState') && !state.canConfirm && !state.sendText) {
        analyzerState = null;
      }

      mount.__openSwapV2AnalyzerState = analyzerState || null;

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

    function closeOpenFillModal() {
      var shouldReloadOffers = !!mount.__openSwapV2ReloadAfterClose;
      mount.__openSwapV2ReloadAfterClose = false;
      mount.__openSwapV2ImportedOffer = null;
      mount.__openSwapV2ImportedRawText = '';
      mount.__openSwapV2OfferId = '';
      mount.__openSwapV2ImportWarnings = [];
      mount.__openSwapV2AcceptPreview = null;
      mount.__openSwapV2Finalize = null;
      mount.__openSwapV2AnalyzerState = null;
      mount.__openSwapV2Kcc20AtomicAction = null;
      updateOpenFillPanel(null);
      if (shouldReloadOffers) loadOpenOffers();
    }

    function offerBlobTextFor(offer, rawText) {
      var txt = String(rawText || '').trim();
      if (txt) return txt;
      if (offer && typeof offer.offerBlob === 'string' && offer.offerBlob.trim()) {
        return offer.offerBlob.trim();
      }
      return JSON.stringify(offer || {});
    }

    function buildOpenFillSummary(imported, preview, listOfferId) {
      var offerSummary = preview && preview.offerSummary && typeof preview.offerSummary === 'object'
        ? preview.offerSummary
        : {};
      var sendContext = preview && preview.sendContext && typeof preview.sendContext === 'object'
        ? preview.sendContext
        : {};
      var offerId = String(listOfferId || mount.__openSwapV2OfferId || '').trim();
      var sendAmt = String(sendContext.amount || offerSummary.buyAmountKas || '?');
      var sendAsset = String(sendContext.asset || 'KAS');
      var fromAddress = String(sendContext.fromAddress || '?');
      var recvAmt = String(sendContext.receiveAmount || offerSummary.sellAmount || '?');
      var recvSym = String(sendContext.receiveSymbol || offerSummary.sellSymbol || '?');

      return 'You will send ' + sendAmt + ' ' + sendAsset +
        ' from ' + fromAddress +
        (offerId ? (' to fill offer ' + offerId) : ' to fill this open swap') +
        ' and receive ' + recvAmt + ' ' + recvSym + '.';
    }

    async function handleConfirmOpenFill() {
      var imported = mount.__openSwapV2ImportedOffer || null;
      var prepared = mount.__openSwapV2AcceptPreview || null;
      var rawText = String(mount.__openSwapV2ImportedRawText || '');
      var offerText = imported ? JSON.stringify(imported, null, 2) : '';
      var sendText = prepared ? JSON.stringify(prepared.sendContext || {}, null, 2) : '';

      mount.__openSwapV2Finalize = null;

      if (!imported || !rawText) {
        updateOpenFillPanel({
          summary: 'No open swap preview is ready.',
          status: 'Select an open swap and click Buy first.',
          offerText: '',
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
        return;
      }

      if (!prepared || prepared.ok !== true) {
        updateOpenFillPanel({
          summary: 'Open swap preview is not ready.',
          status: 'Buy prepares the preview automatically. Close this modal and try again.',
          offerText: offerText,
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
        return;
      }

      updateOpenFillPanel({
        summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
        status: 'Preparing staged finalize…',
        offerText: offerText,
        sendText: sendText,
        canConfirm: false,
        buttonLabel: 'Submitting…'
      });

      try {
        var finalizePrepared = await postJSON('/api/open-swaps/finalize', {
          stage: 'prepare',
          offerBlob: rawText
        });

        var finalizeRid = finalizePrepared && typeof finalizePrepared.finalizeRid === 'string'
          ? finalizePrepared.finalizeRid
          : '';
        if (!finalizeRid) {
          throw new Error('open_swap_finalize_prepare_missing_finalizeRid');
        }
        if (String(finalizePrepared.stage || '') !== 'finalize_prepare') {
          throw new Error('open_swap_finalize_prepare_invalid');
        }

        var isBcwFinalize = String(finalizePrepared.custody_model || '') === 'broker_1of1' || !!finalizePrepared.bcw_open_swap_finalize_intent;
        if (isBcwFinalize) {
          var bcwIntent = finalizePrepared && finalizePrepared.bcw_open_swap_finalize_intent && typeof finalizePrepared.bcw_open_swap_finalize_intent === 'object'
            ? finalizePrepared.bcw_open_swap_finalize_intent
            : null;
          var bcwIntentMessage = finalizePrepared && typeof finalizePrepared.intent_message === 'string'
            ? String(finalizePrepared.intent_message).trim()
            : '';
          if (!bcwIntent || !bcwIntentMessage) {
            throw new Error('open_swap_finalize_prepare_missing_bcw_intent');
          }

          var bcwPriv0Hex = getKeyringPriv0Hex();
          if (!bcwPriv0Hex) {
            updateOpenFillPanel({
              summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
              status: 'Keyfile unlock required. Unlock your Compliance Wallet access keyfile in the Wallet tab, then click "Confirm & Sign Swap" again.',
              offerText: offerText,
              sendText: sendText,
              canConfirm: true,
              buttonLabel: 'Confirm & Sign Swap'
            });
            return;
          }

          updateOpenFillPanel({
            summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
            status: 'Signing broker-custody intent and submitting…',
            offerText: offerText,
            sendText: sendText,
            canConfirm: false,
            buttonLabel: 'Submitting…'
          });

          var bcwAuthSignature = await signBcwOpenSwapFinalizeIntent(bcwIntentMessage, bcwPriv0Hex);

          var bcwFinalized = await postJSON('/api/open-swaps/finalize', {
            stage: 'submit',
            finalizeRid: finalizeRid,
            bcw_open_swap_finalize_intent: bcwIntent,
            bcw_auth_signature: String(bcwAuthSignature || '')
          });

          mount.__openSwapV2Finalize = bcwFinalized;
          if (bcwFinalized && bcwFinalized.txid) mount.__openSwapV2ReloadAfterClose = true;

          updateOpenFillPanel({
            summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
            status: bcwFinalized && bcwFinalized.txid
              ? ('Success — swap submitted. Txid: ' + bcwFinalized.txid)
              : 'Success — swap submitted.',
            statusKind: 'success',
            offerText: offerText,
            sendText: sendText,
            canConfirm: false,
            buttonLabel: 'Swap Submitted',
            closeLabel: bcwFinalized && bcwFinalized.txid ? 'Close & Refresh Offers' : 'Close'
          });
          return;
        }

        var txToSignSafeJson = finalizePrepared && typeof finalizePrepared.txToSignSafeJson === 'string'
          ? finalizePrepared.txToSignSafeJson
          : '';
        if (!txToSignSafeJson) {
          throw new Error('open_swap_finalize_prepare_missing_txToSignSafeJson');
        }

        var signInputIndexes = Array.isArray(finalizePrepared.signInputIndexes)
          ? finalizePrepared.signInputIndexes
          : [];
        if (!signInputIndexes.length) {
          throw new Error('open_swap_finalize_prepare_missing_signInputIndexes');
        }

        var priv0Hex = getKeyringPriv0Hex();
        if (!priv0Hex) {
          updateOpenFillPanel({
            summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
            status: 'Keyfile unlock required. Unlock your keyfile in the Wallet tab, then click "Confirm & Sign Swap" again.',
            offerText: offerText,
            sendText: sendText,
            canConfirm: true,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        updateOpenFillPanel({
          summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
          status: 'Signing locally and submitting…',
          offerText: offerText,
          sendText: sendText,
          canConfirm: false,
          buttonLabel: 'Submitting…'
        });

        var signCtx = {
          sign_mode: finalizePrepared && typeof finalizePrepared.sign_mode === 'string'
            ? String(finalizePrepared.sign_mode)
            : ''
        };

        var signatureScripts = await signInputsForTxShape(txToSignSafeJson, signInputIndexes, priv0Hex, signCtx);

        var finalized = await postJSON('/api/open-swaps/finalize', {
          stage: 'submit',
          finalizeRid: finalizeRid,
          signatureScripts: signatureScripts
        });

        mount.__openSwapV2Finalize = finalized;
        if (finalized && finalized.txid) mount.__openSwapV2ReloadAfterClose = true;

        updateOpenFillPanel({
          summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
          status: finalized && finalized.txid
            ? ('Success — swap submitted. Txid: ' + finalized.txid)
            : 'Success — swap submitted.',
          statusKind: 'success',
          offerText: offerText,
          sendText: sendText,
          canConfirm: false,
          buttonLabel: 'Swap Submitted',
          closeLabel: finalized && finalized.txid ? 'Close & Refresh Offers' : 'Close'
        });
      } catch (err) {
        var response = err && err.response ? err.response : null;
        var reason = response && response.reason
          ? response.reason
          : (err && err.message ? err.message : String(err));

        updateOpenFillPanel({
          summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
          status: 'Finalize failed: ' + reason,
          offerText: offerText,
          sendText: sendText,
          canConfirm: true,
          buttonLabel: 'Confirm & Sign Swap'
        });
      }
    }


    function getKcc20AtomicOpenDraftFromOffer(offer) {
      if (!offer || typeof offer !== 'object') return null;
      var draft = offer.offerDraft && typeof offer.offerDraft === 'object' ? offer.offerDraft : null;
      if (!draft && typeof offer.offerBlob === 'string' && offer.offerBlob.trim()) {
        try { draft = parseOfferBlobText(offer.offerBlob); } catch (_) { draft = null; }
      }
      if (!draft || typeof draft !== 'object') return null;
      var atomic = draft.atomicSwap && typeof draft.atomicSwap === 'object' ? draft.atomicSwap : null;
      var protocol = draft.protocol && typeof draft.protocol === 'object' ? draft.protocol : null;
      var sell = draft.sell && typeof draft.sell === 'object' ? draft.sell : null;
      var isAtomicOpen = !!(
        atomic && atomic.kind === 'kcc20_atomic_open_maker_lock_v1' &&
        protocol && protocol.makerOp === 'kcc20_atomic_open_maker_lock' &&
        protocol.takerOp === 'kcc20_atomic_open_claim' &&
        sell && sell.type === 'OMA_L1_COVENANT_TOKEN'
      );
      return isAtomicOpen ? draft : null;
    }

    function isKcc20AtomicOpenOffer(offer) {
      return !!getKcc20AtomicOpenDraftFromOffer(offer);
    }

    function getKcc20AtomicOpenSourceOutpoint(offer) {
      var draft = getKcc20AtomicOpenDraftFromOffer(offer);
      var atomic = draft && draft.atomicSwap && typeof draft.atomicSwap === 'object' ? draft.atomicSwap : null;
      return normalizeOfferText(atomic && atomic.source_outpoint_key);
    }

    function buildKcc20AtomicOpenSummary(offer, actionKind) {
      var draft = getKcc20AtomicOpenDraftFromOffer(offer) || {};
      var sell = draft.sell && typeof draft.sell === 'object' ? draft.sell : {};
      var buy = draft.buy && typeof draft.buy === 'object' ? draft.buy : {};
      var symbol = normalizeOfferText(sell.symbol || sell.ticker || offer.sellSymbol || 'KCC20');
      var amount = normalizeOfferText(sell.amount || offer.sellAmount || '?');
      var kas = normalizeOfferText(buy.amount || offer.buyAmountKas || '?');
      var offerId = normalizeOfferText(offer && offer.offerId);
      if (actionKind === 'maker_refund') {
        return 'Cancel Open KCC20 offer ' + offerId + ' and refund ' + amount + ' ' + symbol + ' to the maker wallet.';
      }
      return 'Buy Open KCC20 offer ' + offerId + ': pay ' + kas + ' KAS and receive ' + amount + ' ' + symbol + '.';
    }

    function buildKcc20AtomicOpenDisplay(build, actionKind) {
      if (!build || typeof build !== 'object') return {};
      return {
        action: actionKind,
        build_kind: build.build_kind,
        application_status: build.application_status,
        atomic_swap_mode: build.atomic_swap_mode,
        networkId: build.networkId,
        offer_id: build.open_swap_offer_id || build.offer_id || mount.__openSwapV2OfferId,
        source_outpoint_key: build.source_outpoint_key,
        token_symbol: build.token_symbol,
        lock_amount_raw: build.lock_amount_raw,
        kas_price_sompi: build.kas_price_sompi,
        kas_price_kas: build.kas_price_kas,
        maker_kas_receive_address: build.maker_kas_receive_address,
        maker_token_refund_address: build.maker_token_refund_address,
        taker_token_receive_address: build.taker_token_receive_address,
        output_count: build.output_count,
        signInputIndexes: build.signInputIndexes,
        submit_route_enabled: build.submit_route_enabled,
        submit_intent_required: build.submit_intent_required,
        safety: build.safety || null
      };
    }

    async function prepareKcc20AtomicOpenAction(offer, actionKind) {
      var offerId = normalizeOfferText(offer && offer.offerId);
      var sourceOutpoint = getKcc20AtomicOpenSourceOutpoint(offer);
      var offerText = JSON.stringify(offer || {}, null, 2);
      var summary = buildKcc20AtomicOpenSummary(offer, actionKind);
      var buildUrl = actionKind === 'maker_refund'
        ? '/api/covenants/issuer-token/atomic-swap/open/maker-refund/build'
        : '/api/covenants/issuer-token/atomic-swap/open/taker-claim/build';

      mount.__openSwapV2Kcc20AtomicAction = null;
      mount.__openSwapV2OfferId = offerId;
      mount.__openSwapV2ReloadAfterClose = false;

      if (!offerId || !sourceOutpoint) {
        updateOpenFillPanel({
          summary: 'Open KCC20 offer is missing required data.',
          status: 'Missing offer id or source outpoint.',
          offerText: offerText,
          sendText: '',
          canConfirm: false,
          buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
        });
        return;
      }

      updateOpenFillPanel({
        summary: summary,
        status: actionKind === 'maker_refund' ? 'Building Open KCC20 cancel/refund preview…' : 'Building Open KCC20 buy preview…',
        offerText: offerText,
        sendText: '',
        canConfirm: false,
        buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
      });

      try {
        var build = await postJSON(buildUrl, {
          offer_id: offerId,
          open_swap_offer_id: offerId,
          source_outpoint_key: sourceOutpoint
        });

        mount.__openSwapV2Kcc20AtomicAction = {
          actionKind: actionKind,
          offer: offer,
          build: build
        };

        updateOpenFillPanel({
          summary: summary,
          status: actionKind === 'maker_refund'
            ? 'Ready to sign. Review details, then click "Cancel Open Swap".'
            : 'Ready to sign. Review details, then click "Confirm & Buy KCC20 Open Swap".',
          offerText: offerText,
          sendText: JSON.stringify(buildKcc20AtomicOpenDisplay(build, actionKind), null, 2),
          canConfirm: true,
          buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
        });
      } catch (err) {
        var response = err && err.response ? err.response : null;
        var reason = response && response.reason ? response.reason : (err && err.message ? err.message : String(err));
        updateOpenFillPanel({
          summary: summary,
          status: 'Open KCC20 preview failed: ' + reason,
          offerText: offerText,
          sendText: response ? JSON.stringify(response, null, 2) : '',
          canConfirm: false,
          buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
        });
      }
    }

    async function handleConfirmKcc20AtomicOpenAction() {
      var state = mount.__openSwapV2Kcc20AtomicAction || null;
      if (!state || !state.build) {
        updateOpenFillPanel({
          summary: 'No Open KCC20 action is ready.',
          status: 'Click Buy or Cancel on an Open KCC20 offer first.',
          offerText: '',
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
        return;
      }

      var actionKind = state.actionKind;
      var offer = state.offer || {};
      var build = state.build || {};
      var offerText = JSON.stringify(offer || {}, null, 2);
      var summary = buildKcc20AtomicOpenSummary(offer, actionKind);
      var priv0Hex = getKeyringPriv0Hex();

      if (!priv0Hex) {
        updateOpenFillPanel({
          summary: summary,
          status: 'Keyfile unlock required. Unlock your wallet in the Wallet tab, then retry.',
          offerText: offerText,
          sendText: JSON.stringify(buildKcc20AtomicOpenDisplay(build, actionKind), null, 2),
          canConfirm: true,
          buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
        });
        return;
      }

      updateOpenFillPanel({
        summary: summary,
        status: actionKind === 'maker_refund' ? 'Signing and submitting Open KCC20 cancel/refund…' : 'Signing and submitting Open KCC20 buy…',
        offerText: offerText,
        sendText: JSON.stringify(buildKcc20AtomicOpenDisplay(build, actionKind), null, 2),
        canConfirm: false,
        buttonLabel: 'Submitting…'
      });

      try {
        var signed = actionKind === 'maker_refund'
          ? await signKcc20AtomicOpenMakerRefundBuild(build, priv0Hex)
          : await signKcc20AtomicOpenTakerClaimBuild(build, priv0Hex);

        var submitted = await postJSON(build.submit_route, {
          submit_intent: build.submit_intent_required,
          submit_token: build.submit_token,
          signed_safe_json: signed.signed_safe_json,
          signed_safe_json_sha256: signed.signed_safe_json_sha256
        });

        mount.__openSwapV2Finalize = submitted;
        mount.__openSwapV2ReloadAfterClose = true;
        mount.__openSwapV2Kcc20AtomicAction = null;

        var txid = normalizeOfferText(submitted.submitted_txid || submitted.txid);
        var statusText = actionKind === 'maker_refund'
          ? 'Success — Open KCC20 swap cancelled/refunded.'
          : 'Success — Open KCC20 swap filled.';
        if (txid) statusText += ' Txid: ' + txid;

        updateOpenFillPanel({
          summary: summary,
          status: statusText,
          statusKind: 'success',
          offerText: offerText,
          sendText: JSON.stringify({
            submit_kind: submitted.submit_kind,
            application_status: submitted.application_status,
            post_submit_status: submitted.post_submit_status,
            tracking: submitted.tracking || null,
            open_swap_offer_listing: submitted.open_swap_offer_listing || null,
            safety: submitted.safety || null
          }, null, 2),
          canConfirm: false,
          buttonLabel: actionKind === 'maker_refund' ? 'Open Swap Cancelled' : 'Open Swap Filled',
          closeLabel: 'Close & Refresh Offers'
        });
      } catch (err) {
        var response = err && err.response ? err.response : null;
        var reason = response && response.reason ? response.reason : (err && err.message ? err.message : String(err));
        updateOpenFillPanel({
          summary: summary,
          status: 'Open KCC20 submit failed: ' + reason,
          offerText: offerText,
          sendText: response ? JSON.stringify(response, null, 2) : JSON.stringify(buildKcc20AtomicOpenDisplay(build, actionKind), null, 2),
          canConfirm: true,
          buttonLabel: actionKind === 'maker_refund' ? 'Cancel Open Swap' : 'Confirm & Buy KCC20 Open Swap'
        });
      }
    }

    async function prepareImportedOffer(rawText, listOfferId) {
      var imported = mount.__openSwapV2ImportedOffer || null;
      var offerText = imported ? JSON.stringify(imported, null, 2) : '';

      if (!imported) {
        updateOpenFillPanel({
          summary: 'No open swap is loaded.',
          status: 'Select an open swap and click Buy first.',
          offerText: '',
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
        return;
      }

      var startPrepare = async function () {
        updateOpenFillPanel({
          summary: 'Preparing open swap fill preview…',
          status: 'Contacting /api/open-swaps/accept…',
          offerText: offerText,
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });

        try {
          var data = await postJSON('/api/open-swaps/accept', {
            offerBlob: offerBlobTextFor(imported, rawText)
          });

          mount.__openSwapV2AcceptPreview = data;
          mount.__openSwapV2Finalize = null;
          mount.__openSwapV2OfferId = String(listOfferId || mount.__openSwapV2OfferId || '').trim();

          var sendContext = data && data.sendContext && typeof data.sendContext === 'object'
            ? data.sendContext
            : {};
          var warnings = Array.isArray(sendContext.validationWarnings)
            ? sendContext.validationWarnings
            : [];
          var statusText = warnings.length
            ? ('Ready to sign. Review the details, then click "Confirm & Sign Swap". Warnings: ' + warnings.join(', '))
            : 'Ready to sign. Review the details, then click "Confirm & Sign Swap".';

          var analyzerState = null;
          try {
            analyzerState = await analyzeImportedOffer(imported, data);
          } catch (_) {
            analyzerState = null;
          }

          updateOpenFillPanel({
            summary: buildOpenFillSummary(imported, data, mount.__openSwapV2OfferId),
            status: statusText,
            offerText: offerText,
            sendText: JSON.stringify(sendContext, null, 2),
            canConfirm: true,
            buttonLabel: 'Confirm & Sign Swap',
            analyzerState: analyzerState
          });
        } catch (err) {
          mount.__openSwapV2AcceptPreview = null;
          var response = err && err.response ? err.response : null;
          var reason = response && response.reason
            ? response.reason
            : (err && err.message ? err.message : String(err));

          updateOpenFillPanel({
            summary: 'Fill preview failed.',
            status: 'Error contacting /api/open-swaps/accept: ' + reason,
            offerText: offerText,
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
        }
      };

      if (!imported.complianceOnly) {
        await startPrepare();
        return;
      }

      updateOpenFillPanel({
        summary: 'Checking compliance wallet requirements for this open offer…',
        status: 'Compliance Only offers require an active, unlocked compliance wallet.',
        offerText: offerText,
        sendText: '',
        canConfirm: false,
        buttonLabel: 'Confirm & Sign Swap'
      });

      try {
        var stRes = await fetch('/api/wallet/status', {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (!stRes.ok) throw new Error('HTTP ' + stRes.status);

        var st = await stRes.json();
        if (!st || st.ok !== true) {
          updateOpenFillPanel({
            summary: 'Compliance Only offer cannot be filled right now.',
            status: 'Unable to determine the active wallet. Open the Wallet tab and retry.',
            offerText: offerText,
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
          updateOpenFillPanel({
            summary: 'Compliance Only offer cannot be filled with the active wallet.',
            status: 'Switch to an active compliance wallet, then click Buy again.',
            offerText: offerText,
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        if (!walletId || sessWalletId !== walletId || sessWalletType !== walletType || !sessPriv0Hex) {
          updateOpenFillPanel({
            summary: 'Compliance Only offer requires an unlocked compliance wallet.',
            status: 'Unlock your compliance wallet in the Wallet tab first, then click Buy again.',
            offerText: offerText,
            sendText: '',
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
          });
          return;
        }

        await startPrepare();
      } catch (err) {
        updateOpenFillPanel({
          summary: 'Compliance Only offer cannot be filled right now.',
          status: 'Unable to verify compliance wallet readiness: ' + err,
          offerText: offerText,
          sendText: '',
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
        });
      }
    }

    function showImportedOffer(offer, rawText, listOfferId) {
      var validation = validateImportedOffer(offer);

      if (!validation.ok) {
        throw new Error('Invalid offer blob: ' + validation.errors.join(', '));
      }

      mount.__openSwapV2ImportedOffer = offer;
      mount.__openSwapV2ImportedRawText = offerBlobTextFor(offer, rawText);
      mount.__openSwapV2OfferId = String(listOfferId || '').trim();
      mount.__openSwapV2ImportWarnings = validation.warnings.slice();
      mount.__openSwapV2AcceptPreview = null;
      mount.__openSwapV2Finalize = null;

      try {
        mount.dispatchEvent(new CustomEvent('openSwapV2:offerImported', {
          detail: { offer: offer, warnings: validation.warnings.slice() }
        }));
      } catch (_) {}

      return offer;
    }

    function renderGroupedOpenOfferTable(target, groups, emptyText, options) {
      if (!target) return;

      target.innerHTML = '';

      if (!groups || !groups.length) {
        target.style.display = '';
        var empty = document.createElement('div');
        empty.className = 'grouped-offer-empty';
        empty.textContent = emptyText || 'No grouped open offers.';
        target.appendChild(empty);
        return;
      }

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

      groups.forEach(function (group) {
        var offer = group.offers[0] || {};
        var catalog = group.catalog || null;
        var sellAmount = String(offer && offer.sellAmount != null ? offer.sellAmount : '?');
        var sellSymbol = String(offer && offer.sellSymbol ? offer.sellSymbol : '?');
        var sellName = offer && typeof offer.sellName === 'string' ? offer.sellName.trim() : '';
        var kcc20OpenDraft = getKcc20AtomicOpenDraftFromOffer(offer);
        var kcc20OpenSell = kcc20OpenDraft && kcc20OpenDraft.sell && typeof kcc20OpenDraft.sell === 'object' ? kcc20OpenDraft.sell : null;
        var kcc20OpenTokenLabel = kcc20OpenSell ? normalizeOfferText(kcc20OpenSell.symbol || kcc20OpenSell.ticker || kcc20OpenSell.name) : '';
        var normalizedSellCa = normalizeOfferCa(sellSymbol);
        var sellSymbolLooksCa = /^[0-9a-f]{64}$/i.test(normalizedSellCa);
        var sellLabel = catalog
          ? catalog.label
          : (kcc20OpenTokenLabel || sellName || (sellSymbolLooksCa ? 'CA token' : sellSymbol));
        var buyAmountKas = String(offer && offer.buyAmountKas != null ? offer.buyAmountKas : '?');
        var description = getOfferDescription(offer);
        var infoUrl = getOfferInfoUrl(offer);
        var purpose = catalog ? catalog.purpose : '';
        var summaryText = description || purpose || ('Receive ' + sellAmount + ' ' + sellLabel + ' per purchase.');
        var expiresAt = String(offer && offer.expiresAt ? offer.expiresAt : '');

        var row = document.createElement('div');
        row.className = 'grouped-offer-row';

        var tokenCell = document.createElement('div');
        tokenCell.innerHTML = '';
        var tokenTitle = document.createElement('div');
        tokenTitle.className = 'offer-title';
        tokenTitle.textContent = sellLabel + ' · ' + sellAmount + ' each';
        tokenCell.appendChild(tokenTitle);
        row.appendChild(tokenCell);

        var descCell = document.createElement('div');
        var details = document.createElement('details');
        details.className = 'grouped-offer-inline-details';

        var summary = document.createElement('summary');
        summary.textContent = summaryText;
        details.appendChild(summary);

        var terms = document.createElement('p');
        terms.className = 'offer-sub';
        terms.textContent = summaryText;
        details.appendChild(terms);

        if (sellSymbolLooksCa) {
          var caLine = document.createElement('p');
          caLine.className = 'offer-sub';
          caLine.textContent = 'CA: ' + normalizedSellCa;
          details.appendChild(caLine);
        }

        if (infoUrl) {
          var linkWrap = document.createElement('p');
          var link = document.createElement('a');
          link.href = infoUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'More information';
          linkWrap.appendChild(link);
          details.appendChild(linkWrap);
        }

        var finePrint = document.createElement('p');
        finePrint.className = 'offer-sub';
        finePrint.textContent = 'Each purchase uses one live open offer. ' +
          'Seller receives ' + buyAmountKas + ' KAS and buyer receives ' + sellAmount + ' ' + sellLabel +
          (expiresAt ? ('. Earliest displayed expiration: ' + expiresAt + '.') : '.');
        details.appendChild(finePrint);

        descCell.appendChild(details);
        row.appendChild(descCell);

        var priceCell = document.createElement('div');
        priceCell.textContent = buyAmountKas + ' KAS';
        row.appendChild(priceCell);

        var availableCell = document.createElement('div');
        availableCell.textContent = String(group.offers.length) + ' live';
        row.appendChild(availableCell);

        var actionCell = document.createElement('div');
        var offersForAction = group && Array.isArray(group.offers) ? group.offers : [];
        var buyCandidate = offersForAction.find(function (it) { return !isOpenMineOffer(it); }) || chooseOpenOfferFromGroup(group);
        var ownKcc20Candidate = offersForAction.find(function (it) { return isOpenMineOffer(it) && isKcc20AtomicOpenOffer(it); }) || null;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary';
        btn.textContent = 'Buy';
        if (buyCandidate && isOpenMineOffer(buyCandidate) && isKcc20AtomicOpenOffer(buyCandidate)) {
          btn.disabled = true;
          btn.title = 'This is your own Open KCC20 offer. Use My Swaps to cancel/refund it.';
        }
        btn.addEventListener('click', function () {
          var selected = buyCandidate || chooseOpenOfferFromGroup(group);
          var rawText = selected && typeof selected.offerBlob === 'string' ? selected.offerBlob : '';
          if (!selected || !rawText) {
            if (status) status.textContent = 'Stored open offer is missing its offer blob.';
            return;
          }

          if (isKcc20AtomicOpenOffer(selected)) {
            prepareKcc20AtomicOpenAction(selected, 'claim');
            return;
          }

          try {
            var imported = parseOfferBlobText(rawText);
            showImportedOffer(imported, rawText, String(selected && selected.offerId ? selected.offerId : ''));
            prepareImportedOffer(rawText, String(selected && selected.offerId ? selected.offerId : ''));
          } catch (err) {
            if (status) status.textContent = String(err && err.message ? err.message : err);
            closeOpenFillModal();
          }
        });
        actionCell.appendChild(btn);


        row.appendChild(actionCell);

        table.appendChild(row);
      });

      target.appendChild(table);
    }

    function renderOpenOffers(items) {
      if (!list || !status) return;

      ensureOpenLiveOfferFilterControl();

      var rawItems = Array.isArray(items) ? items.slice() : [];
      var hideMine = readOpenHideMyLiveOffers();
      var visibleItems = hideMine
        ? rawItems.filter(function (offer) { return !isOpenMineOffer(offer); })
        : rawItems;

      list.innerHTML = '';

      var sponsoredList = document.getElementById('sponsoredOffersList');
      var sponsoredStatus = document.getElementById('sponsoredOffersStatus');
      var groups = buildOpenOfferGroups(visibleItems || []);
      var sponsoredCount = groups.sponsored.reduce(function (sum, group) { return sum + group.offers.length; }, 0);
      var normalCount = groups.normal.reduce(function (sum, group) { return sum + group.offers.length; }, 0);

      renderGroupedOpenOfferTable(
        sponsoredList,
        groups.sponsored,
        'No sponsored upgrade inventory is available right now.'
      );
      if (sponsoredStatus) {
        sponsoredStatus.textContent = sponsoredCount
          ? (groups.sponsored.length + ' sponsored row' + (groups.sponsored.length === 1 ? '' : 's') + ' / ' + sponsoredCount + ' live offer' + (sponsoredCount === 1 ? '' : 's') + '.')
          : 'No sponsored upgrade inventory is available right now.';
      }

      if (!visibleItems.length) {
        status.textContent = hideMine && rawItems.length
          ? 'No open swap offers shown. Your live Open Swap offers are hidden by the switch.'
          : 'No open swap offers.';
        list.style.display = 'none';
        closeOpenFillModal();
        if (section) section.setAttribute('data-empty', '1');
        return;
      }

      if (!normalCount) {
        status.textContent = sponsoredCount
          ? 'All live open swap offers are grouped in Sponsored / Upgrade Offers.'
          : 'No open swap offers.';
        list.style.display = 'none';
        if (section) section.setAttribute('data-empty', '1');
        return;
      }

      list.style.display = '';
      if (section) section.removeAttribute('data-empty');
      status.textContent = groups.normal.length + ' grouped open swap row' + (groups.normal.length === 1 ? '' : 's') +
        ' / ' + normalCount + ' live offer' + (normalCount === 1 ? '' : 's') + '.';

      renderGroupedOpenOfferTable(
        list,
        groups.normal,
        'No normal open swap offers. Sponsored inventory is grouped above.'
      );
    }

    function loadSponsoredOpenOfferCatalog() {
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
          console.error('upgrade-catalog fetch error', err);
          return [];
        });
    }

    function loadOpenOffers() {
      if (status) status.textContent = 'Loading open swap offers…';

      var offersRequest = fetch('/api/open-swaps/list?state=open', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });

      var myOffersRequest = fetch('/api/open-swaps/mine?history=0', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .catch(function (err) {
          console.warn('open my-swaps filter fetch error', err);
          return { ok: true, items: [] };
        });

      Promise.all([
        offersRequest,
        loadSponsoredOpenOfferCatalog(),
        myOffersRequest
      ])
        .then(function (results) {
          var data = results[0];
          var catalog = results[1];
          var mine = results[2] || {};
          setSponsoredOpenOfferCatalog(catalog);
          openMineOpenOfferIds = buildOpenOfferIdMap(mine.items || []);
          openMineActiveWalletId = normalizeOfferText(mine.active_wallet_id);

          if (!data || data.ok === false) {
            if (status) status.textContent = 'Failed to load open swap offers.';
            closeOpenFillModal();
            return;
          }
          renderOpenOffers(data.items || []);
        })
        .catch(function (err) {
          setSponsoredOpenOfferCatalog([]);
          if (status) status.textContent = 'Error loading open swap offers.';
          closeOpenFillModal();
          console.error('openSwaps.list fetch error', err);
        });
    }

    mount.setAttribute("data-open-swap-v2", "ready");
    mount.__openSwapV2ImportedOffer = null;
    mount.__openSwapV2ImportedRawText = '';
    mount.__openSwapV2OfferId = '';
    mount.__openSwapV2ImportWarnings = [];
    mount.__openSwapV2AcceptPreview = null;
    mount.__openSwapV2Finalize = null;
    mount.__openSwapV2Kcc20AtomicAction = null;

    var confirmBtn = document.getElementById('openFillConfirmBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (mount.__openSwapV2Kcc20AtomicAction) {
          handleConfirmKcc20AtomicOpenAction();
          return;
        }
        handleConfirmOpenFill();
      });
      confirmBtn.disabled = true;
    }

    var closeBtn = document.getElementById('openFillCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        closeOpenFillModal();
      });
    }

    var overlay = document.getElementById('openFillSection');
    if (overlay) {
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) closeOpenFillModal();
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var sec = document.getElementById('openFillSection');
      if (sec && sec.style.display !== 'none') closeOpenFillModal();
    });

    window.openSwapV2Offers = {
      loadFromText: function (rawText) {
        var offer = parseOfferBlobText(rawText);
        showImportedOffer(offer, rawText, '');
        prepareImportedOffer(rawText, '');
        return mount.__openSwapV2ImportedOffer || null;
      },
      clear: function () {
        closeOpenFillModal();
      },
      reload: function () {
        loadOpenOffers();
      },
      getLastImported: function () {
        return mount.__openSwapV2ImportedOffer || null;
      },
      getLastWarnings: function () {
        return Array.isArray(mount.__openSwapV2ImportWarnings)
          ? mount.__openSwapV2ImportWarnings.slice()
          : [];
      },
      getLastPrepared: function () {
        return mount.__openSwapV2AcceptPreview || null;
      },
      getLastFinalized: function () {
        return mount.__openSwapV2Finalize || null;
      }
    };

    updateOpenFillPanel(null);
    loadOpenOffers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
