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

    if (!offer.ttl) errors.push('offer_ttl_missing');
    if (!offer.createdAt) errors.push('offer_created_at_missing');
    if (!offer.expiresAt) errors.push('offer_expires_at_missing');

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
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Confirm & Sign Swap';
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

      if (btn) {
        btn.disabled = !state.canConfirm;
        btn.textContent = state.buttonLabel || 'Confirm & Sign Swap';
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
      mount.__openSwapV2ImportedOffer = null;
      mount.__openSwapV2ImportedRawText = '';
      mount.__openSwapV2OfferId = '';
      mount.__openSwapV2ImportWarnings = [];
      mount.__openSwapV2AcceptPreview = null;
      mount.__openSwapV2Finalize = null;
      mount.__openSwapV2AnalyzerState = null;
      updateOpenFillPanel(null);
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

          updateOpenFillPanel({
            summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
            status: bcwFinalized && bcwFinalized.txid
              ? ('Swap submitted. Txid: ' + bcwFinalized.txid)
              : 'Swap submitted.',
            offerText: offerText,
            sendText: sendText,
            canConfirm: false,
            buttonLabel: 'Confirm & Sign Swap'
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

        updateOpenFillPanel({
          summary: buildOpenFillSummary(imported, prepared, mount.__openSwapV2OfferId),
          status: finalized && finalized.txid
            ? ('Swap submitted. Txid: ' + finalized.txid)
            : 'Swap submitted.',
          offerText: offerText,
          sendText: sendText,
          canConfirm: false,
          buttonLabel: 'Confirm & Sign Swap'
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

    function renderOpenOffers(items) {
      if (!list || !status) return;

      list.innerHTML = '';

      if (!items || !items.length) {
        status.textContent = 'No open swap offers.';
        list.style.display = 'none';
        closeOpenFillModal();
        if (section) section.setAttribute('data-empty', '1');
        return;
      }

      list.style.display = '';
      if (section) section.removeAttribute('data-empty');
      status.textContent = items.length + ' open swap offer' + (items.length === 1 ? '' : 's') + '.';

      items.forEach(function (offer) {
        var sellAmount = String(offer && offer.sellAmount != null ? offer.sellAmount : '?');
        var sellSymbol = String(offer && offer.sellSymbol ? offer.sellSymbol : '?');
        var sellName = offer && typeof offer.sellName === 'string' ? offer.sellName.trim() : '';
        var sellLabel = sellName && /^CA:/i.test(sellSymbol) ? sellName + ' ' + sellSymbol : sellSymbol;
        var buyAmountKas = String(offer && offer.buyAmountKas != null ? offer.buyAmountKas : '?');
        var expiresAt = String(offer && offer.expiresAt ? offer.expiresAt : '');
        var rawText = typeof offer.offerBlob === 'string' ? offer.offerBlob : '';
        var isComplianceOnly = !!offer.complianceOnly;

        var card = document.createElement('article');
        card.className = 'offer-card card';
        if (isComplianceOnly) {
          card.style.borderColor = 'rgba(255,214,102,.45)';
          card.style.boxShadow = '0 0 0 1px rgba(255,214,102,.14), 0 0 18px rgba(255,214,102,.12)';
          card.style.background = 'linear-gradient(180deg, rgba(255,214,102,.08), rgba(255,214,102,.03))';
        }

        var main = document.createElement('div');
        main.className = 'offer-main';

        var left = document.createElement('div');

        var title = document.createElement('div');
        title.className = 'offer-title';
        title.textContent = buyAmountKas + ' KAS → ' + sellAmount + ' ' + sellLabel;

        left.appendChild(title);

        var right = document.createElement('div');
        right.className = 'offer-sub';
        right.style.display = 'flex';
        right.style.flexDirection = 'column';
        right.style.alignItems = 'flex-end';
        right.style.gap = '.35rem';

        var stateText = document.createElement('div');
        stateText.textContent = String(offer && offer.state ? offer.state : 'open');
        right.appendChild(stateText);

        if (isComplianceOnly) {
          var badge = document.createElement('div');
          badge.textContent = 'Compliance Only';
          badge.style.padding = '.18rem .5rem';
          badge.style.borderRadius = '999px';
          badge.style.border = '1px solid rgba(255,214,102,.45)';
          badge.style.background = 'rgba(255,214,102,.14)';
          badge.style.color = 'rgba(255,244,214,1)';
          badge.style.fontSize = '.78rem';
          badge.style.fontWeight = '700';
          badge.style.letterSpacing = '.02em';
          right.appendChild(badge);
        }

        main.appendChild(left);
        main.appendChild(right);

        var meta = document.createElement('div');
        meta.className = 'offer-meta';

        var expiresSpan = document.createElement('span');
        expiresSpan.textContent = expiresAt ? ('Expires: ' + expiresAt) : 'Expires: (n/a)';
        meta.appendChild(expiresSpan);

        var modeSpan = document.createElement('span');
        modeSpan.textContent = 'Open';
        meta.appendChild(modeSpan);

        var actions = document.createElement('div');
        actions.className = 'offer-actions';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'secondary';
        btn.textContent = 'Buy';
        btn.addEventListener('click', function () {
          if (!rawText) {
            if (status) status.textContent = 'Stored open offer is missing its offer blob.';
            return;
          }

          try {
            var imported = parseOfferBlobText(rawText);
            showImportedOffer(imported, rawText, String(offer && offer.offerId ? offer.offerId : ''));
            prepareImportedOffer(rawText, String(offer && offer.offerId ? offer.offerId : ''));
          } catch (err) {
            if (status) status.textContent = String(err && err.message ? err.message : err);
            closeOpenFillModal();
          }
        });

        actions.appendChild(btn);

        card.appendChild(main);
        card.appendChild(meta);
        card.appendChild(actions);

        list.appendChild(card);
      });
    }

    function loadOpenOffers() {
      if (status) status.textContent = 'Loading open swap offers…';

      fetch('/api/open-swaps/list?state=open', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || data.ok === false) {
            if (status) status.textContent = 'Failed to load open swap offers.';
            closeOpenFillModal();
            return;
          }
          renderOpenOffers(data.items || []);
        })
        .catch(function (err) {
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

    var confirmBtn = document.getElementById('openFillConfirmBtn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
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
