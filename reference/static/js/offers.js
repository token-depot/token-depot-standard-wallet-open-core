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
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Confirm & Sign Swap';
      }
      if (analyzerRefs.panel) analyzerRefs.panel.style.display = 'none';
      if (shared) shared.clearAnalyzer(analyzerRefs);
      return;
    }

    section.style.display = 'block';
    summaryEl.textContent = state.summary || '';
    statusEl.textContent  = state.status || '';
    psktEl.textContent    = state.psktText || '';
    sendEl.textContent    = state.sendText || '';

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
    isSigningFill = false;
    lastPsktRequest = null;
    lastSendContext = null;

    var pwEl = document.getElementById('fillPassword');
    if (pwEl) pwEl.value = '';

    updateFillPanel(null);
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
        ? ('Swap submitted. Txid: ' + txid)
        : 'Swap submitted. (No txid returned.)';

      updateFillPanel({
        summary: 'PSKT fill submitted to wallet.',
        status: status,
        psktText: JSON.stringify(lastPsktRequest || {}, null, 2),
        sendText: JSON.stringify(lastSendContext || {}, null, 2),
        canConfirm: false,
        buttonLabel: 'Confirm & Sign Swap'
      });

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Confirm & Sign Swap';
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

  function handleFillClick(offer) {
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

    listEl.innerHTML = '';

    if (!items || !items.length) {
      statusEl.textContent = 'No direct swap offers.';
      listEl.style.display = 'none';
      if (fillSectionEl) fillSectionEl.style.display = 'none';
      if (sectionEl) sectionEl.setAttribute('data-empty', '1');
      return;
    }

    listEl.style.display = '';
    if (sectionEl) sectionEl.removeAttribute('data-empty');
    statusEl.textContent = items.length + ' direct swap offer' + (items.length === 1 ? '' : 's') + '.';

    items.forEach(function (offer) {
      var sell = offer.sell || {};
      var buy  = offer.buy  || {};
      var sellLabel = fmtAmount(offer.sellAmount, sell);
      var buyLabel  = fmtAmount(offer.buyAmount, buy);

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
      title.textContent = sellLabel + ' → ' + buyLabel;

      left.appendChild(title);

      var right = document.createElement('div');
      right.className = 'offer-sub';
      right.style.display = 'flex';
      right.style.flexDirection = 'column';
      right.style.alignItems = 'flex-end';
      right.style.gap = '.35rem';

      var stateText = document.createElement('div');
      stateText.textContent = fmtState(offer.state || 'open');
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
      var expiresAt = String(offer && offer.expiresAt ? offer.expiresAt : '');
      var expiresSpan = document.createElement('span');
      expiresSpan.textContent = expiresAt ? ('Expires: ' + expiresAt) : 'Expires: (n/a)';
      meta.appendChild(expiresSpan);

      var modeSpan = document.createElement('span');
      if (offer && offer.takerTokenReceiveAddress) {
        modeSpan.textContent = 'Directed';
      } else {
        modeSpan.textContent = 'Open';
      }
      meta.appendChild(modeSpan);

      var actions = document.createElement('div');
      actions.className = 'offer-actions';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Buy';
      btn.dataset.offerId = offer.offerId || '';
      btn.addEventListener('click', function () {
        handleFillClick(offer);
      });

      actions.appendChild(btn);

      card.appendChild(main);
      card.appendChild(meta);
      card.appendChild(actions);

      listEl.appendChild(card);
    });
  }

  function loadOffers() {
    var statusEl = $('offersStatus');
    if (statusEl) statusEl.textContent = 'Loading direct swap offers…';

    fetch('/api/offers/list?state=open', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
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

    loadTakerWallet();
    loadOffers();
  });
})();

