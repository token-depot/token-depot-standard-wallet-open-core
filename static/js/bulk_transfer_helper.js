(() => {
  const KEYRING_SESSION_KEY = 'cw_keyring_session';

  function $(id) {
    return document.getElementById(id);
  }

  function getNetworkSharedOrNull() {
    try {
      const shared = window.CwNetworkShared;
      if (shared && typeof shared === 'object') return shared;
    } catch (_) {}
    return null;
  }

  function getAppNetworkKeyOrNull(raw) {
    const shared = getNetworkSharedOrNull();
    if (!shared || typeof shared.normalizeAppNetworkKey !== 'function') return '';
    const key = shared.normalizeAppNetworkKey(raw);
    return typeof key === 'string' ? key.trim() : '';
  }

  const BROADCAST_WALLET_MODE_UNKNOWN = 'unknown';
  const BROADCAST_WALLET_MODE_BRIDGE_FULFILLMENT = 'bridge_fulfillment';
  const BROADCAST_WALLET_MODE_COUPON_BROADCAST = 'coupon_broadcast';

  let broadcastWalletModeState = {
    mode: BROADCAST_WALLET_MODE_UNKNOWN,
    activeAddress: '',
    networkId: '',
    bridgeInventoryAddress: '',
    loaded: false,
    error: ''
  };

  function normalizeBroadcastAddressForMatch(raw) {
    return String(raw || '').trim().toLowerCase();
  }

  async function fetchWrappedConfigForBroadcastModeOrThrow() {
    const res = await fetch('/api/v1/wrapped-config', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || typeof data !== 'object') throw new Error('wrapped_config_load_failed');
    return data;
  }

  function bridgeInventoryAddressForNetwork(cfg, networkId) {
    const bridge = cfg && cfg.bridge && typeof cfg.bridge === 'object' ? cfg.bridge : null;
    const map = bridge && bridge.inventoryKaspaAddressByNetwork && typeof bridge.inventoryKaspaAddressByNetwork === 'object'
      ? bridge.inventoryKaspaAddressByNetwork
      : null;
    const value = map && networkId ? map[networkId] : '';
    return String(value || '').trim();
  }

  async function refreshBroadcastWalletModeState() {
    const activeAddress = getActiveAddress();
    const networkId = getActiveNetworkId();

    broadcastWalletModeState = {
      mode: BROADCAST_WALLET_MODE_UNKNOWN,
      activeAddress,
      networkId,
      bridgeInventoryAddress: '',
      loaded: false,
      error: ''
    };

    if (!activeAddress || !networkId) return { ...broadcastWalletModeState };

    try {
      const cfg = await fetchWrappedConfigForBroadcastModeOrThrow();
      const bridgeInventoryAddress = bridgeInventoryAddressForNetwork(cfg, networkId);
      const mode = bridgeInventoryAddress &&
        normalizeBroadcastAddressForMatch(activeAddress) === normalizeBroadcastAddressForMatch(bridgeInventoryAddress)
          ? BROADCAST_WALLET_MODE_BRIDGE_FULFILLMENT
          : BROADCAST_WALLET_MODE_COUPON_BROADCAST;

      broadcastWalletModeState = {
        mode,
        activeAddress,
        networkId,
        bridgeInventoryAddress,
        loaded: true,
        error: ''
      };
    } catch (err) {
      broadcastWalletModeState = {
        mode: BROADCAST_WALLET_MODE_UNKNOWN,
        activeAddress,
        networkId,
        bridgeInventoryAddress: '',
        loaded: false,
        error: String(err && err.message ? err.message : err)
      };
    }

    return { ...broadcastWalletModeState };
  }

  function getBroadcastWalletModeState() {
    return { ...broadcastWalletModeState };
  }

  function setVisibleById(id, visible) {
    const el = $(id);
    if (el) el.style.display = visible ? '' : 'none';
  }

  function setTextById(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value || '');
  }

  function applyBroadcastWalletModeUi(state) {
    const mode = state && state.mode ? String(state.mode) : BROADCAST_WALLET_MODE_UNKNOWN;
    const isBridgeMode = mode === BROADCAST_WALLET_MODE_BRIDGE_FULFILLMENT;
    const isCouponMode = !isBridgeMode;

    setVisibleById('bulkHelperBridgeTitle', isBridgeMode);
    setVisibleById('bulkHelperCouponTitle', isCouponMode);
    setVisibleById('bulkHelperBridgePanel', isBridgeMode);
    setVisibleById('bulkHelperCouponPanel', isCouponMode);
    setVisibleById('bulkHelperCouponSampleLink', isCouponMode);

    const fileEl = $('bulkHelperFile');
    const fileLabel = document.querySelector('label[for="bulkHelperFile"]');
    const loadBtn = $('btnBulkHelperLoad');
    const execBtn = $('btnBulkHelperExecute');

    if (isBridgeMode) {
      if (fileLabel) fileLabel.textContent = 'Broadcast file (.json)';
      if (fileEl) fileEl.setAttribute('accept', 'application/json');
      if (loadBtn) loadBtn.textContent = 'Load Broadcast';
      if (execBtn) execBtn.textContent = 'Broadcast Batch';
      return;
    }

    if (fileLabel) fileLabel.textContent = 'Subscriber CSV (.csv)';
    if (fileEl) fileEl.setAttribute('accept', '.csv,text/csv');
    if (loadBtn) loadBtn.textContent = 'Load CSV';
    if (execBtn) {
      execBtn.textContent = 'Broadcast Coupons';
      execBtn.disabled = true;
    }
  }

  function isBridgeFulfillmentModeActive() {
    return broadcastWalletModeState.mode === BROADCAST_WALLET_MODE_BRIDGE_FULFILLMENT;
  }

  let broadcastWalletModeRefreshTimer = null;

  function scheduleBroadcastWalletModeRefresh(delayMs) {
    const delay = Math.max(0, Number(delayMs || 0));
    if (broadcastWalletModeRefreshTimer) clearTimeout(broadcastWalletModeRefreshTimer);
    broadcastWalletModeRefreshTimer = setTimeout(async () => {
      broadcastWalletModeRefreshTimer = null;
      const state = await refreshBroadcastWalletModeState();
      applyBroadcastWalletModeUi(state);
      if (state.mode === BROADCAST_WALLET_MODE_UNKNOWN && state.error) {
        setMsg('Broadcast mode unavailable: ' + state.error);
      }
    }, delay);
  }

  function bindBroadcastWalletModeRefreshers() {
    const walletSel = $('walletSelect');
    const networkSel = $('networkSelect');
    const addressEl = $('wAddress');

    if (walletSel) walletSel.addEventListener('change', () => scheduleBroadcastWalletModeRefresh(150));
    if (networkSel) networkSel.addEventListener('change', () => scheduleBroadcastWalletModeRefresh(150));

    if (addressEl && typeof MutationObserver === 'function') {
      const observer = new MutationObserver(() => scheduleBroadcastWalletModeRefresh(150));
      observer.observe(addressEl, { childList: true, characterData: true, subtree: true });
    }

    applyBroadcastWalletModeUi(getBroadcastWalletModeState());
    scheduleBroadcastWalletModeRefresh(0);
    setTimeout(() => scheduleBroadcastWalletModeRefresh(0), 500);
    setTimeout(() => scheduleBroadcastWalletModeRefresh(0), 1500);
  }

  function setMsg(msg) {
    const el = $('bulkHelperMsg');
    if (el) el.innerHTML = '<small>' + String(msg || '—') + '</small>';
  }

  function clearRows() {
    const body = $('bulkHelperRows');
    if (body) body.innerHTML = '';
  }

  function hidePreview() {
    const summary = $('bulkHelperSummary');
    const wrap = $('bulkHelperTableWrap');
    if (summary) {
      summary.style.display = 'none';
      summary.innerHTML = '';
    }
    if (wrap) wrap.style.display = 'none';
    clearRows();
  }

  function getActiveAddress() {
    const el = $('wAddress');
    return el ? String(el.textContent || '').trim() : '';
  }

  function getActiveNetworkId() {
    const sel = $('networkSelect');
    const raw = sel ? String(sel.value || '').trim() : '';
    return getAppNetworkKeyOrNull(raw);
  }

  function getActiveWalletId() {
    const sel = $('walletSelect');
    return sel ? String(sel.value || '').trim() : '';
  }

  function getUnlockSession() {
    try {
      const raw = sessionStorage.getItem(KEYRING_SESSION_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;

      const walletId = typeof obj.wallet_id === 'string' ? obj.wallet_id.trim() : '';
      const userId = typeof obj.user_id === 'string' ? obj.user_id.trim() : '';
      const priv0Hex = typeof obj.priv0_hex === 'string' ? obj.priv0_hex.trim() : '';
      const address0 = typeof obj.address0 === 'string' ? obj.address0.trim() : '';

      if (!walletId || !userId || !priv0Hex || !address0) return null;

      return {
        walletId,
        userId,
        priv0Hex,
        address0
      };
    } catch (_) {
      return null;
    }
  }

  function getLiveUnlockState() {
    try {
      const obj = window.__cwWalletLiveUnlock;
      if (!obj || typeof obj !== 'object') return null;

      const walletId = typeof obj.walletId === 'string' ? obj.walletId.trim() : '';
      const address0 = typeof obj.address0 === 'string' ? obj.address0.trim() : '';

      if (!walletId || !address0) return null;

      return {
        walletId,
        address0
      };
    } catch (_) {
      return null;
    }
  }

  function getEffectiveUnlockContext() {
    const session = getUnlockSession();
    const live = getLiveUnlockState();
    if (!session || !live) return null;
    if (session.walletId !== live.walletId) return null;
    if (session.address0 !== live.address0) return null;

    return {
      walletId: live.walletId,
      address0: live.address0,
      userId: session.userId,
      priv0Hex: session.priv0Hex
    };
  }

  function getSelectedBroadcastToken() {
    const sel = $('tokenSelect');
    return sel ? String(sel.value || '').trim() : '';
  }

  function getSelectedBroadcastTokenMeta() {
    const sel = $('tokenSelect');
    const opt = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0] : null;
    const token = sel ? String(sel.value || '').trim() : '';
    const decimalsRaw = opt && opt.dataset && typeof opt.dataset.dec === 'string' ? opt.dataset.dec : '';
    const decimals = /^\d+$/.test(decimalsRaw) ? Number(decimalsRaw) : null;
    const ca = opt && opt.dataset && typeof opt.dataset.ca === 'string' ? opt.dataset.ca.trim().toLowerCase() : '';
    const label = opt ? String(opt.textContent || '').trim() : token;

    return {
      token,
      label,
      decimals,
      ca,
      isKas: token.toUpperCase() === 'KAS',
      isCa: token.toUpperCase().indexOf('CA:') === 0
    };
  }

  function getCouponAmountDisplay() {
    const el = $('wAmt');
    return el ? String(el.value || '').trim() : '';
  }

  function shortText(s, left, right) {
    const v = String(s || '').trim();
    if (!v) return '';
    if (v.length <= left + right + 3) return v;
    return v.slice(0, left) + '...' + v.slice(-right);
  }

  function formatRawUnits(rawStr, decimals) {
    const raw = String(rawStr || '').trim();
    const d = Number(decimals);
    if (!/^\d+$/.test(raw)) return '';
    if (!Number.isInteger(d) || d < 0) return raw;
    if (d === 0) return raw.replace(/^0+(?=\d)/, '') || '0';

    const padded = raw.padStart(d + 1, '0');
    const whole = padded.slice(0, -d).replace(/^0+(?=\d)/, '') || '0';
    const frac = padded.slice(-d).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

  function downloadTextFile(filename, text, mimeType) {
    const blob = new Blob([String(text == null ? '' : text)], { type: String(mimeType || 'text/plain') });
    const urlApi = window.URL || URL;
    const url = urlApi.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'download.txt');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      try {
        urlApi.revokeObjectURL(url);
      } catch (_) {}
    }, 0);
  }

  function downloadJsonFile(filename, obj) {
    const txt = JSON.stringify(obj, null, 2) + '\n';
    downloadTextFile(filename || 'download.json', txt, 'application/json');
  }

  function csvCellToText(value) {
    return String(value == null ? '' : value).trim();
  }

  function parseCsvRows(text) {
    const src = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cell += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch !== '\r') {
        cell += ch;
      }
    }

    if (inQuotes) throw new Error('coupon_csv_unclosed_quote');
    row.push(cell);
    if (row.some((v) => String(v || '').trim())) rows.push(row);

    return rows;
  }

  function normalizeCsvHeaderName(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function addressPrefixForNetwork(networkId) {
    const shared = getNetworkSharedOrNull();
    if (shared && typeof shared.addressPrefixForNetwork === 'function') {
      const prefix = shared.addressPrefixForNetwork(networkId);
      return String(prefix || '').trim().toLowerCase();
    }
    return networkId === 'mainnet' ? 'kaspa:' : 'kaspatest:';
  }

  function couponAddressValidForNetwork(address, networkId) {
    const addr = String(address || '').trim().toLowerCase();
    const prefix = addressPrefixForNetwork(networkId);
    return !!addr && !!prefix && addr.indexOf(prefix) === 0;
  }

  let loadedList = null;
  let executionRows = [];
  let executing = false;

  function getSendEngineOrThrow() {
    const eng = window.CWSendEngine;
    if (!eng || typeof eng !== 'object') throw new Error('send_engine_missing');
    if (typeof eng.sendSingleTransfer !== 'function') throw new Error('send_engine_missing_sendSingleTransfer');
    return eng;
  }

  function getSendEngineDepsOrThrow() {
    const fn = window.CWBuildSendEngineDeps;
    if (typeof fn !== 'function') throw new Error('send_engine_deps_missing');
    const deps = fn();
    if (!deps || typeof deps !== 'object') throw new Error('send_engine_deps_invalid');
    return deps;
  }

  async function kaspaReadyOrThrow() {
    const p = window.kaspaReady;
    if (p && typeof p.then === 'function') await p;
    const k = window.kaspa;
    if (!k) throw new Error('Kaspa WASM not loaded');
    return k;
  }

  async function buildKeyringFromSessionOrThrow() {
    const unlockCtx = getEffectiveUnlockContext();
    if (!unlockCtx) throw new Error('Unlock the matching keyfile on this page first.');

    const k = await kaspaReadyOrThrow();
    return {
      priv0: new k.PrivateKey(unlockCtx.priv0Hex),
      address0: unlockCtx.address0
    };
  }

  function deriveSendToken(list) {
    const ca = String(list && list.ca ? list.ca : '').trim().toLowerCase();
    if (ca) return 'CA:' + ca;

    const assetName = String(list && list.assetName ? list.assetName : '').trim();
    if (assetName) return assetName;

    throw new Error('transfer_list_token_missing');
  }

  function extractTxidFromResult(res) {
    if (res && typeof res.txid === 'string' && res.txid.trim()) {
      return res.txid.trim();
    }

    const keys = ['txids', 'revealTxids', 'commitTxids'];
    for (const key of keys) {
      const arr = res && Array.isArray(res[key]) ? res[key] : [];
      for (const v of arr) {
        const s = String(v || '').trim();
        if (s) return s;
      }
    }

    return '';
  }

  function buildExecutionResultArtifact(list) {
    const rows = Array.isArray(list && list.rows) ? list.rows : [];
    return {
      version: 1,
      kind: 'bridge_fulfillment_result',
      networkId: String(list && list.networkId ? list.networkId : '').trim(),
      sourceWalletAddress: String(list && list.sourceWalletAddress ? list.sourceWalletAddress : '').trim(),
      assetName: String(list && list.assetName ? list.assetName : '').trim(),
      ca: String(list && list.ca ? list.ca : '').trim().toLowerCase(),
      fulfillmentBatchId: String(list && list.fulfillmentBatchId ? list.fulfillmentBatchId : '').trim().toLowerCase(),
      executedAt: new Date().toISOString(),
      executionRule: 'stop_on_first_failure',
      rows: rows.map((row, idx) => {
        const exec = executionRows[idx] || {};
        return {
          purchaseId: String(row && row.purchaseId ? row.purchaseId : '').trim(),
          to: String(row && row.to ? row.to : '').trim(),
          amountRaw: String(row && row.amountRaw ? row.amountRaw : '').trim(),
          fulfillmentExecutionNonce: String(
            row && row.fulfillmentExecutionNonce ? row.fulfillmentExecutionNonce : ''
          ).trim().toLowerCase(),
          result: String(exec && exec.result ? exec.result : 'Ready'),
          txid: String(exec && exec.txid ? exec.txid : '').trim(),
          error: String(exec && exec.error ? exec.error : '').trim()
        };
      })
    };
  }

  function csvResultCell(value) {
    const text = String(value == null ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function buildCouponExecutionResultCsv(list) {
    const rows = Array.isArray(list && list.rows) ? list.rows : [];
    const executedAt = new Date().toISOString();
    const header = [
      'row_number',
      'address',
      'label',
      'email',
      'subscriber_id',
      'notes',
      'amount_raw',
      'result',
      'txid',
      'error',
      'executed_at',
      'network',
      'token',
      'ca'
    ];
    const networkId = String(list && list.networkId ? list.networkId : '').trim();
    const token = String(list && list.token ? list.token : '').trim();
    const ca = String(list && list.ca ? list.ca : '').trim().toLowerCase();
    const lines = [header.map(csvResultCell).join(',')];

    rows.forEach((row, idx) => {
      const exec = executionRows[idx] || {};
      lines.push([
        String(idx + 1),
        String(row && row.to ? row.to : row && row.address ? row.address : '').trim(),
        String(row && row.label ? row.label : '').trim(),
        String(row && row.email ? row.email : '').trim(),
        String(row && row.subscriber_id ? row.subscriber_id : '').trim(),
        String(row && row.notes ? row.notes : '').trim(),
        String(row && row.amountRaw ? row.amountRaw : '').trim(),
        String(exec && exec.result ? exec.result : 'Ready'),
        String(exec && exec.txid ? exec.txid : '').trim(),
        String(exec && exec.error ? exec.error : '').trim(),
        executedAt,
        networkId,
        token,
        ca
      ].map(csvResultCell).join(','));
    });

    return lines.join('\n') + '\n';
  }

  function downloadExecutionResultArtifact(list) {
    try {
      const isCouponList = String(list && list.kind ? list.kind : '') === 'coupon_broadcast';
      const networkId = String(list && list.networkId ? list.networkId : '').trim() || 'unknown';
      const assetName =
        String(list && list.token ? list.token : '').trim() ||
        String(list && list.assetName ? list.assetName : '').trim() ||
        String(list && list.ca ? list.ca : '').trim() ||
        'asset';
      const safeAsset = assetName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'asset';

      if (isCouponList) {
        const filename = 'coupon_broadcast_result_' + networkId + '_' + safeAsset + '_' + Date.now() + '.csv';
        downloadTextFile(filename, buildCouponExecutionResultCsv(list), 'text/csv');
        return filename;
      }

      const filename = 'bridge_fulfillment_result_' + networkId + '_' + safeAsset + '_' + Date.now() + '.json';
      downloadJsonFile(filename, buildExecutionResultArtifact(list));
      return filename;
    } catch (_) {
      return '';
    }
  }

  function evaluateListAgainstActiveWallet(list) {
    const activeAddress = getActiveAddress();
    const activeNetworkId = getActiveNetworkId();
    const activeWalletId = getActiveWalletId();
    const selectedToken = getSelectedBroadcastToken();
    const unlockCtx = getEffectiveUnlockContext();

    let expectedToken = '';
    try {
      expectedToken = deriveSendToken(list);
    } catch (_) {
      expectedToken = '';
    }

    const selectedTokenNorm = selectedToken.toLowerCase();
    const expectedTokenNorm = expectedToken.toLowerCase();

    const errors = [];
    if (!activeWalletId) errors.push('No active wallet selected.');
    if (!activeAddress) errors.push('No active wallet address is loaded.');
    if (!selectedToken) errors.push('No asset is selected in the wallet asset dropdown.');
    if (!expectedToken) errors.push('Broadcast file asset is missing.');
    if (activeNetworkId !== list.networkId) errors.push('Network mismatch with active wallet.');
    if (activeAddress && activeAddress !== list.sourceWalletAddress) errors.push('Source wallet does not match active wallet address.');
    if (!unlockCtx) errors.push('Unlock the matching keyfile on this page first.');
    if (unlockCtx && activeWalletId && unlockCtx.walletId !== activeWalletId) {
      errors.push('Unlocked keyfile does not match the active wallet.');
    }
    if (unlockCtx && activeAddress && unlockCtx.address0 !== activeAddress) {
      errors.push('Unlocked keyfile address does not match the active wallet address.');
    }
    if (selectedToken && expectedToken && selectedTokenNorm !== expectedTokenNorm) {
      errors.push('Selected wallet asset does not match the broadcast file asset.');
    }

    return {
      activeAddress,
      activeNetworkId,
      activeWalletId,
      selectedToken,
      expectedToken,
      unlocked: !!unlockCtx,
      unlockedWalletId: unlockCtx ? unlockCtx.walletId : '',
      errors
    };
  }

  function normalizeWalletStatusNetwork(raw) {
    return getAppNetworkKeyOrNull(raw);
  }

  async function getActiveWalletStatusOrThrow() {
    const res = await fetch('/api/wallet/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) throw new Error('Unable to determine active wallet.');

    const walletId = String(data.wallet_id || '').trim();
    const address0 = String(data.address0 || '').trim();
    const rawNetwork = String(data.network || '').trim();
    const networkId = normalizeWalletStatusNetwork(rawNetwork);
    if (!walletId || !address0 || !networkId) throw new Error('Unable to determine active wallet.');

    return { walletId, address0, networkId };
  }

  function buildBroadcastConfirmText(list, ctx, st) {
    const isCouponList = String(list.kind || '') === 'coupon_broadcast';
    const totalRaw = list.rows.reduce((acc, row) => acc + BigInt(row.amountRaw), 0n);
    const totalDisplay = formatRawUnits(totalRaw.toString(), list.decimals) || totalRaw.toString();
    const couponAmountDisplay = isCouponList ? (formatRawUnits(list.amountRaw, list.decimals) || String(list.amountRaw || '')) : '';
    const lines = [
      isCouponList ? 'Coupon Broadcast' : 'Broadcast Batch',
      '',
      'Active WID: ' + (st.walletId || ctx.activeWalletId || '(none)'),
      'Active address: ' + (st.address0 || ctx.activeAddress || '(none)'),
      'Selected asset: ' + (ctx.selectedToken || '(none)'),
      'File asset: ' + (ctx.expectedToken || '(unknown)'),
      'Network: ' + (st.networkId || ctx.activeNetworkId || '(unknown)'),
      'Rows: ' + String(list.rows.length),
      isCouponList ? 'Coupon amount per row: ' + couponAmountDisplay : 'Batch id: ' + String(list.fulfillmentBatchId || ''),
      'Total amount: ' + totalDisplay,
      'Rule: stop_on_first_failure',
      '',
      'Proceed with broadcast?'
    ];

    return lines.join('\n');
  }

  function resetExecutionRows(list) {
    const rowCount = list && Array.isArray(list.rows) ? list.rows.length : 0;
    executionRows = [];
    for (let i = 0; i < rowCount; i++) {
      executionRows.push({ result: 'Ready', txid: '', error: '' });
    }
  }

  function parseTransferList(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('transfer_list_not_object');

    const version = Number(obj.version);
    if (version !== 1) throw new Error('transfer_list_version_invalid');

    const networkIdRaw = String(obj.networkId || '').trim();
    const networkId = getAppNetworkKeyOrNull(networkIdRaw);
    if (!networkId) throw new Error('transfer_list_network_invalid');

    const sourceWalletAddress = String(obj.sourceWalletAddress || '').trim();
    if (!sourceWalletAddress) throw new Error('transfer_list_source_wallet_missing');

    const assetName = String(obj.assetName || '').trim();
    const ca = String(obj.ca || '').trim().toLowerCase();
    const kind = String(obj.kind || '').trim();
    const decimals = Number.isInteger(obj.decimals) ? Number(obj.decimals) : null;
    const fulfillmentBatchId = String(obj.fulfillmentBatchId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fulfillmentBatchId)) throw new Error('transfer_list_batch_id_invalid');

    const rows = Array.isArray(obj.rows) ? obj.rows : [];
    if (rows.length === 0) throw new Error('transfer_list_rows_empty');

    const normalizedRows = rows.map((row, idx) => {
      const purchaseId = String(row && row.purchaseId ? row.purchaseId : '').trim();
      const to = String(row && row.to ? row.to : '').trim();
      const amountRaw = String(row && row.amountRaw ? row.amountRaw : '').trim();
      const fulfillmentExecutionNonce = String(
        row && row.fulfillmentExecutionNonce ? row.fulfillmentExecutionNonce : ''
      ).trim().toLowerCase();

      if (!purchaseId) throw new Error('transfer_list_row_purchase_id_missing:' + idx);
      if (!to) throw new Error('transfer_list_row_destination_missing:' + idx);
      if (!/^\d+$/.test(amountRaw) || amountRaw === '0') throw new Error('transfer_list_row_amount_invalid:' + idx);
      if (!/^[0-9a-f]{64}$/.test(fulfillmentExecutionNonce)) {
        throw new Error('transfer_list_row_execution_nonce_invalid:' + idx);
      }

      return {
        purchaseId,
        to,
        amountRaw,
        fulfillmentExecutionNonce
      };
    });

    return {
      version,
      networkId,
      sourceWalletAddress,
      assetName,
      ca,
      kind,
      decimals,
      fulfillmentBatchId,
      rows: normalizedRows
    };
  }

  function buildCouponBroadcastListFromCsv(text) {
    const tokenMeta = getSelectedBroadcastTokenMeta();
    if (!tokenMeta.token) throw new Error('coupon_token_missing');
    if (tokenMeta.isKas) throw new Error('coupon_kas_not_supported');
    if (!Number.isInteger(tokenMeta.decimals) || tokenMeta.decimals < 0) throw new Error('coupon_token_decimals_missing');

    const amountDisplay = getCouponAmountDisplay();
    const amountRaw = getSendEngineOrThrow().humanToRawAmount(amountDisplay, tokenMeta.decimals);
    if (!amountRaw) throw new Error('coupon_amount_invalid');

    const networkId = getActiveNetworkId();
    if (!networkId) throw new Error('coupon_network_missing');

    const sourceWalletAddress = getActiveAddress();
    if (!sourceWalletAddress) throw new Error('coupon_source_wallet_missing');

    const parsed = parseCsvRows(text);
    if (parsed.length < 2) throw new Error('coupon_csv_rows_empty');

    const headers = parsed[0].map(normalizeCsvHeaderName);
    const addressIndex = headers.indexOf('address');
    if (addressIndex < 0) throw new Error('coupon_csv_address_header_missing');

    const labelIndex = headers.indexOf('label');
    const emailIndex = headers.indexOf('email');
    const subscriberIdIndex = headers.indexOf('subscriber_id');
    const notesIndex = headers.indexOf('notes');
    const seenAddresses = new Set();
    const rows = [];

    for (let i = 1; i < parsed.length; i++) {
      const row = parsed[i];
      if (!row || !row.some((v) => csvCellToText(v))) continue;

      const address = csvCellToText(row[addressIndex]);
      if (!address) throw new Error('coupon_csv_row_address_missing:' + String(i + 1));
      if (!couponAddressValidForNetwork(address, networkId)) throw new Error('coupon_csv_row_address_invalid:' + String(i + 1));

      const addressKey = normalizeBroadcastAddressForMatch(address);
      if (seenAddresses.has(addressKey)) throw new Error('coupon_csv_duplicate_address:' + String(i + 1));
      seenAddresses.add(addressKey);

      rows.push({
        address,
        to: address,
        label: labelIndex >= 0 ? csvCellToText(row[labelIndex]) : '',
        email: emailIndex >= 0 ? csvCellToText(row[emailIndex]) : '',
        subscriber_id: subscriberIdIndex >= 0 ? csvCellToText(row[subscriberIdIndex]) : '',
        notes: notesIndex >= 0 ? csvCellToText(row[notesIndex]) : '',
        amountRaw
      });
    }

    if (rows.length === 0) throw new Error('coupon_csv_rows_empty');

    return {
      version: 1,
      kind: 'coupon_broadcast',
      networkId,
      sourceWalletAddress,
      assetName: tokenMeta.isCa ? '' : tokenMeta.token,
      ca: tokenMeta.isCa ? tokenMeta.token.slice(3).toLowerCase() : tokenMeta.ca,
      token: tokenMeta.token,
      tokenLabel: tokenMeta.label,
      decimals: tokenMeta.decimals,
      couponAmountDisplay: amountDisplay,
      amountRaw,
      rows
    };
  }

  async function readFileJson(file) {
    const txt = await file.text();
    if (!txt.trim()) throw new Error('transfer_list_file_empty');
    return JSON.parse(txt);
  }

  async function readFileText(file) {
    const txt = await file.text();
    if (!txt.trim()) throw new Error('coupon_csv_file_empty');
    return txt;
  }

  function renderPreview(list) {
    const summary = $('bulkHelperSummary');
    const wrap = $('bulkHelperTableWrap');
    const rowsBody = $('bulkHelperRows');
    const executeBtn = $('btnBulkHelperExecute');
    if (!summary || !wrap || !rowsBody) return;

    const isCouponList = String(list.kind || '') === 'coupon_broadcast';
    const totalRaw = list.rows.reduce((acc, row) => acc + BigInt(row.amountRaw), 0n);
    const totalDisplay = formatRawUnits(totalRaw.toString(), list.decimals);
    const ctx = evaluateListAgainstActiveWallet(list);
    const errors = ctx.errors;

    const headerCells = document.querySelectorAll('#bulkHelperTable thead th');
    if (headerCells && headerCells.length >= 6) {
      headerCells[0].textContent = isCouponList ? 'subscriber' : 'purchase id';
      headerCells[1].textContent = 'destination';
      headerCells[2].textContent = 'amount';
      headerCells[3].textContent = 'amount raw';
      headerCells[4].textContent = 'result';
      headerCells[5].textContent = isCouponList ? 'email / notes' : 'txid';
    }

    if (!Array.isArray(executionRows) || executionRows.length !== list.rows.length) {
      resetExecutionRows(list);
    }

    const completedCount = executionRows.filter((row) => row && row.result === 'Submitted').length;
    const failedCount = executionRows.filter((row) => row && row.result === 'Failed').length;
    const statusText = errors.length === 0
      ? (executing ? 'Broadcast in progress…' : (isCouponList ? 'Coupon CSV ready to broadcast.' : 'Ready to broadcast batch.'))
      : 'Blocked until the issues below are resolved.';

    summary.innerHTML =
      '<div><strong>Kind:</strong> <code>' + String(list.kind || 'transfer_list') + '</code></div>' +
      '<div><strong>File label:</strong> <code>' + String(list.tokenLabel || list.assetName || list.ca || 'Unknown') + '</code></div>' +
      '<div><strong>Selected asset:</strong> <code>' + (ctx.selectedToken || '(none)') + '</code></div>' +
      '<div><strong>File asset:</strong> <code>' + (ctx.expectedToken || '(unknown)') + '</code></div>' +
      '<div><strong>CA:</strong> <code title="' + String(list.ca || '') + '">' + (list.ca ? shortText(list.ca, 12, 10) : '—') + '</code></div>' +
      '<div><strong>Network:</strong> <code>' + list.networkId + '</code></div>' +
      '<div><strong>Source wallet:</strong> <code title="' + list.sourceWalletAddress + '">' + shortText(list.sourceWalletAddress, 14, 12) + '</code></div>' +
      '<div><strong>Rows:</strong> <code>' + String(list.rows.length) + '</code></div>' +
      '<div><strong>' + (isCouponList ? 'Coupon amount' : 'Total amount') + ':</strong> <code>' + (isCouponList ? (formatRawUnits(list.amountRaw, list.decimals) || list.amountRaw) : (totalDisplay || totalRaw.toString())) + '</code></div>' +
      (isCouponList ? '<div><strong>Total coupon amount:</strong> <code>' + (totalDisplay || totalRaw.toString()) + '</code></div>' : '') +
      '<div><strong>Active WID:</strong> <code>' + (ctx.activeWalletId || '(none)') + '</code></div>' +
      '<div><strong>Unlocked WID:</strong> <code>' + (ctx.unlockedWalletId || '(missing)') + '</code></div>' +
      '<div><strong>Keyfile unlock:</strong> <code>' + (ctx.unlocked ? 'present' : 'missing') + '</code></div>' +
      '<div><strong>Execution rule:</strong> <code>stop_on_first_failure</code></div>' +
      '<div><strong>Submitted rows:</strong> <code>' + String(completedCount) + '</code></div>' +
      '<div><strong>Failed rows:</strong> <code>' + String(failedCount) + '</code></div>' +
      '<div style="margin-top:.5rem;"><strong>Status:</strong> ' + statusText + '</div>' +
      (errors.length
        ? '<ul style="margin:.5rem 0 0 1.25rem;">' + errors.map((e) => '<li>' + e + '</li>').join('') + '</ul>'
        : '');

    rowsBody.innerHTML = '';
    list.rows.forEach((row, idx) => {
      const exec = executionRows[idx] || { result: 'Ready', txid: '', error: '' };
      const tr = document.createElement('tr');

      const tdPurchaseId = document.createElement('td');
      if (isCouponList) {
        const subscriberLabel = String(row.subscriber_id || row.label || '').trim();
        tdPurchaseId.innerHTML = '<code title="' + subscriberLabel + '">' + (subscriberLabel ? shortText(subscriberLabel, 12, 10) : '—') + '</code>';
      } else {
        tdPurchaseId.innerHTML = '<code title="' + row.purchaseId + '">' + (row.purchaseId ? shortText(row.purchaseId, 10, 8) : '—') + '</code>';
      }

      const tdTo = document.createElement('td');
      tdTo.innerHTML = '<code title="' + row.to + '">' + shortText(row.to, 16, 14) + '</code>';

      const tdAmount = document.createElement('td');
      tdAmount.innerHTML = '<code>' + (formatRawUnits(row.amountRaw, list.decimals) || row.amountRaw) + '</code>';

      const tdAmountRaw = document.createElement('td');
      tdAmountRaw.innerHTML = '<code>' + row.amountRaw + '</code>';

      const tdResult = document.createElement('td');
      tdResult.innerHTML = '<code title="' + String(exec.error || exec.result || '') + '">' + String(exec.result || 'Ready') + '</code>';

      const tdTxid = document.createElement('td');
      if (isCouponList) {
        const couponMeta = [row.email, row.notes].filter((v) => String(v || '').trim()).join(' / ');
        tdTxid.innerHTML = couponMeta ? '<span title="' + couponMeta + '">' + shortText(couponMeta, 24, 18) + '</span>' : '—';
      } else {
        tdTxid.innerHTML = '<code title="' + String(exec.txid || '') + '">' + (exec.txid ? shortText(exec.txid, 12, 10) : '—') + '</code>';
      }

      tr.appendChild(tdPurchaseId);
      tr.appendChild(tdTo);
      tr.appendChild(tdAmount);
      tr.appendChild(tdAmountRaw);
      tr.appendChild(tdResult);
      tr.appendChild(tdTxid);
      rowsBody.appendChild(tr);
    });

    if (executeBtn) {
      executeBtn.disabled = executing || !loadedList || errors.length > 0;
    }

    summary.style.display = '';
    wrap.style.display = '';
  }

  async function onLoadPreview() {
    try {
      if (executing) {
        setMsg('Broadcast already in progress.');
        return;
      }

      hidePreview();
      const fileEl = $('bulkHelperFile');
      const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;

      const state = await refreshBroadcastWalletModeState();
      applyBroadcastWalletModeUi(state);

      if (!file) {
        setMsg(isBridgeFulfillmentModeActive() ? 'Choose a broadcast JSON file first.' : 'Choose a subscriber CSV file first.');
        return;
      }

      if (!isBridgeFulfillmentModeActive()) {
        setMsg('Loading coupon CSV…');
        const text = await readFileText(file);
        const list = buildCouponBroadcastListFromCsv(text);
        loadedList = list;
        resetExecutionRows(list);
        renderPreview(list);
        setMsg('Coupon CSV preview loaded. Execution is not enabled yet.');
        return;
      }

      setMsg('Loading broadcast…');
      const obj = await readFileJson(file);
      const list = parseTransferList(obj);
      loadedList = list;
      resetExecutionRows(list);
      renderPreview(list);
      setMsg('Broadcast preview loaded.');
    } catch (err) {
      loadedList = null;
      executionRows = [];
      hidePreview();
      setMsg('ERROR: ' + String(err && err.message ? err.message : err));
    }
  }

  async function onExecute() {
    try {
      if (executing) {
        setMsg('Broadcast already in progress.');
        return;
      }

      if (!loadedList) {
        setMsg(isBridgeFulfillmentModeActive() ? 'Load and preview a broadcast file first.' : 'Load and preview a coupon CSV file first.');
        return;
      }

      const isCouponList = String(loadedList.kind || '') === 'coupon_broadcast';
      if (isCouponList && isBridgeFulfillmentModeActive()) {
        setMsg('Coupon CSV cannot execute from the broker bridge inventory wallet. Reload the correct preview.');
        return;
      }
      if (!isCouponList && !isBridgeFulfillmentModeActive()) {
        setMsg('Bridge fulfillment JSON cannot execute from Coupon mode. Reload the correct preview.');
        return;
      }

      const ctx = evaluateListAgainstActiveWallet(loadedList);
      if (ctx.errors.length > 0) {
        renderPreview(loadedList);
        setMsg('Resolve the broadcast preview errors before sending.');
        return;
      }

      const st = await getActiveWalletStatusOrThrow();
      if (st.walletId !== ctx.activeWalletId) throw new Error('Active wallet changed. Reload the broadcast preview.');
      if (st.address0 !== ctx.activeAddress) throw new Error('Active wallet address changed. Reload the broadcast preview.');
      if (st.networkId !== loadedList.networkId) throw new Error('Active wallet network changed. Reload the broadcast preview.');

      const confirmed = window.confirm(buildBroadcastConfirmText(loadedList, ctx, st));
      if (!confirmed) {
        setMsg('Broadcast cancelled.');
        return;
      }

      const keyring = await buildKeyringFromSessionOrThrow();
      const eng = getSendEngineOrThrow();
      const deps = getSendEngineDepsOrThrow();
      const token = deriveSendToken(loadedList);

      executing = true;
      resetExecutionRows(loadedList);
      renderPreview(loadedList);

      for (let i = 0; i < loadedList.rows.length; i++) {
        const row = loadedList.rows[i];
        executionRows[i] = { result: 'Sending…', txid: '', error: '' };
        renderPreview(loadedList);
        setMsg('Broadcasting row ' + String(i + 1) + ' of ' + String(loadedList.rows.length) + '…');

        try {
          const sendReq = {
            token,
            to: row.to,
            amountRaw: row.amountRaw,
            keyring,
            useMax: false
          };

          if (!isCouponList) {
            sendReq.purchaseId = row.purchaseId;
            sendReq.fulfillmentBatchId = loadedList.fulfillmentBatchId;
            sendReq.fulfillmentExecutionNonce = row.fulfillmentExecutionNonce;
          }

          const res = await eng.sendSingleTransfer(sendReq, deps);

          if (!res || res.ok !== true) {
            const msg = (res && (res.error || res.message || res.reason)) || 'Send failed';
            throw new Error(msg);
          }

          executionRows[i] = {
            result: 'Submitted',
            txid: extractTxidFromResult(res),
            error: ''
          };
          renderPreview(loadedList);
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          executionRows[i] = { result: 'Failed', txid: '', error: msg };
          executing = false;
          renderPreview(loadedList);
          const savedFile = downloadExecutionResultArtifact(loadedList);
          setMsg(
            'Broadcast stopped on row ' + String(i + 1) + ': ' + msg +
            (savedFile ? ' Result file downloaded.' : ' Result file download failed.')
          );
          return;
        }
      }

      executing = false;
      renderPreview(loadedList);
      const savedFile = downloadExecutionResultArtifact(loadedList);
      setMsg(savedFile ? 'Broadcast complete. Result file downloaded.' : 'Broadcast complete. Result file download failed.');
    } catch (err) {
      executing = false;
      if (loadedList) renderPreview(loadedList);
      setMsg('ERROR: ' + String(err && err.message ? err.message : err));
    }
  }

  function onClear() {
    if (executing) {
      setMsg('Broadcast already in progress.');
      return;
    }

    const fileEl = $('bulkHelperFile');
    try {
      if (fileEl) fileEl.value = '';
    } catch (_) {}

    loadedList = null;
    executionRows = [];
    hidePreview();
    setMsg('—');

    const executeBtn = $('btnBulkHelperExecute');
    if (executeBtn) executeBtn.disabled = true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const loadBtn = $('btnBulkHelperLoad');
    const clearBtn = $('btnBulkHelperClear');
    const execBtn = $('btnBulkHelperExecute');

    bindBroadcastWalletModeRefreshers();

    if (loadBtn) loadBtn.addEventListener('click', onLoadPreview);
    if (clearBtn) clearBtn.addEventListener('click', onClear);
    if (execBtn) execBtn.addEventListener('click', onExecute);
    if (execBtn) execBtn.disabled = true;
  });
})();
