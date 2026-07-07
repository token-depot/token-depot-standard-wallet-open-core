// [wallet.js] v2025-09-23 SAFE PATCH — minimal: send-lock + self-send + watchdog
// Decoupled from mint pipeline. Singular paths only.
//
// Uses:
//   GET  /api/wallet/holdings   -> { kas:number, address:string, tokens:{[ticker]:number}, ... }
//   GET  /api/wallet/status     -> lightweight status (optional)
//   POST /api/wallet/send       -> { token, to, amount } -> { ok:boolean, txid?:string, error?:string }
//
// DOM (existing):
//   #wAddress #tokenSelect #btnSend #btnReceive #btnRefresh #btnOpenKaspa #lastUpdated
//   #assetsBody
//   #recvPane #addrFull #qrBox #lnkCopy #btnCloseRecv
//   #wTo #wAmt #btnMax #wSendResult
//
(() => {
  // ---------- Utilities ----------
  const $ = (id) => document.getElementById(id);

  // Shorten a 64-hex CA for labels: 8 + ellipsis + last 6
  function shortCA(ca) {
    ca = String(ca || '');
    return (ca.length >= 14) ? (ca.slice(0, 8) + '…' + ca.slice(-6)) : ca;
  }

  async function jget(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  }

  async function jpost(url, body) {
    const target =
      (typeof window !== 'undefined' && window.location && window.location.origin)
        ? new URL(String(url || ''), window.location.origin).toString()
        : String(url || '');

    let r = null;
    try {
      r = await fetch(target, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      throw new Error(`fetch failed (POST ${target}): ${msg}`);
    }

    let data = null;
    try { data = await r.json(); } catch (_) { /* non-JSON */ }
    if (!r.ok) {
      const msg = (data && (data.error || data.message || data.reason)) || `${r.status} ${r.statusText}`;
      const err = new Error(`HTTP ${r.status} (POST ${target}): ${msg}`);
      try { err.status = r.status; err.data = data || null; err.url = target; } catch (_) {}
      throw err;
    }
    return data || {};
  }

  function kaspaOrThrow() {
    const k = window.kaspa;
    if (!k) throw new Error('Kaspa WASM not loaded (kaspa-bridge.mjs missing?)');
    return k;
  }

  async function kaspaReadyOrThrow() {
    const p = window.kaspaReady;
    if (p && typeof p.then === 'function') {
      await p;
    }
    return kaspaOrThrow();
  }

  function getSendEngineOrThrow() {
    const eng = window.CWSendEngine;
    if (!eng || typeof eng !== 'object') throw new Error('Send engine not loaded');
    if (typeof eng.humanToRawAmount !== 'function') throw new Error('Send engine missing humanToRawAmount');
    if (typeof eng.sendKrc20CommitRevealTransferSW !== 'function') throw new Error('Send engine missing sendKrc20CommitRevealTransferSW');
    if (typeof eng.sendSingleTransfer !== 'function') throw new Error('Send engine missing sendSingleTransfer');
    return eng;
  }

  function getNetworkSharedOrNull() {
    try {
      const shared = window.CwNetworkShared;
      if (shared && typeof shared === 'object') return shared;
    } catch (_) {}
    return null;
  }

  function getNetworkMeta(raw) {
    const shared = getNetworkSharedOrNull();
    if (!shared || typeof shared.getNetworkMeta !== 'function') return null;
    const meta = shared.getNetworkMeta(raw);
    if (!meta || typeof meta !== 'object') return null;
    return meta;
  }

  function setKeyfileStatus(msg) {
    try {
      if (!keyfileStatusEl) return;
      keyfileStatusEl.textContent = String(msg || '—');
    } catch (_) {}
  }

  function setChangePassStatus(msg) {
    try {
      if (!changePassStatusEl) return;
      changePassStatusEl.textContent = String(msg || '—');
    } catch (_) {}
  }

  function downloadJson(filename, obj) {
    const text = JSON.stringify(obj, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (_) {}
      try { a.remove(); } catch (_) {}
    }, 250);
  }

  async function readFileText(file) {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('file_read_failed'));
      fr.onload = () => resolve(String(fr.result || ''));
      fr.readAsText(file);
    });
  }

  async function exportKeyfile() {
    if (!keyfileOuter) {
      throw new Error('Load or create a local keyfile before exporting');
    }

    const wid = typeof keyfileOuter.wallet_id === 'string' ? String(keyfileOuter.wallet_id).trim() : '';
    const fname = `td-wallet-v1-${wid || 'keyfile'}.json`;
    downloadJson(fname, keyfileOuter);
    setKeyfileStatus(`Exported: ${fname}`);
  }

  async function unlockKeyfile() {
    const pass = keyfilePassEl && typeof keyfilePassEl.value === 'string' ? keyfilePassEl.value : '';
    if (!pass.trim()) throw new Error('Missing passphrase');

    if (!keyfileOuter || typeof keyfileOuter !== 'object') {
      const f = keyfileFileEl && keyfileFileEl.files && keyfileFileEl.files[0] ? keyfileFileEl.files[0] : null;
      if (!f) throw new Error('No keyfile loaded');
      const txt = await readFileText(f);
      const obj = JSON.parse(txt);
      keyfileOuter = obj;
      keyring = null;
      setKeyfileStatus('Loaded (locked)');
    }
    const ciphertext = keyfileOuter.ciphertext;
    if (typeof ciphertext !== 'string' || !ciphertext.trim()) throw new Error('Bad keyfile');

    const k = await kaspaReadyOrThrow();
    const plain = k.decryptXChaCha20Poly1305(ciphertext, pass);
    const inner = JSON.parse(String(plain || '{}'));

    const kfType = String((keyfileOuter && keyfileOuter.wallet_type) || (inner && inner.wallet_type) || '').trim().toLowerCase();
    const kfWalletId = String((keyfileOuter && keyfileOuter.wallet_id) || (inner && inner.wallet_id) || '').trim();
    const custodyModel = String((keyfileOuter && keyfileOuter.custody_model) || (inner && inner.custody_model) || '').trim().toLowerCase();

    if (kfType === 'compliance' && custodyModel === 'broker_1of1') {
      const st = await jget('/api/wallet/status');
      if (!st || st.ok !== true) throw new Error('Unable to determine active wallet');

      const walletId = String(st.wallet_id || '').trim();
      const walletType = String(st.wallet_type || '').trim().toLowerCase();
      const statusCustodyModel = String(st.custody_model || '').trim().toLowerCase();
      const statusAuthPubkey = String(st.user_auth_pubkey || '').trim();
      const statusAddress0 = String(st.address0 || '').trim();
      const statusNetwork = String(st.network || '').trim();

      if (!walletId || !walletType) throw new Error('Unable to determine active wallet');
      if (walletType !== 'compliance') throw new Error('Active wallet is not a Compliance Wallet');
      if (statusCustodyModel !== 'broker_1of1') throw new Error('Active Compliance Wallet is not broker custody');
      if (!statusAddress0) throw new Error('Active Compliance Wallet address is missing');
      if (!statusAuthPubkey) throw new Error('Active Compliance Wallet authorization pubkey is missing');
      if (kfWalletId && walletId !== kfWalletId) {
        throw new Error('Keyfile does not match active wallet');
      }

      const keyfileNetwork = String(inner && inner.network ? inner.network : '').trim();
      if (keyfileNetwork && statusNetwork && keyfileNetwork !== statusNetwork) {
        throw new Error('Keyfile network does not match active wallet');
      }

      const authSecret = String(inner && inner.auth_secret ? inner.auth_secret : '').trim();
      const authPubkey = String(inner && inner.auth_pubkey ? inner.auth_pubkey : '').trim();

      if (!authSecret) throw new Error('Keyfile missing authorization secret');
      if (!/^(02|03)[0-9a-fA-F]{64}$/.test(authPubkey)) throw new Error('Keyfile authorization pubkey invalid');
      if (authPubkey.toLowerCase() !== statusAuthPubkey.toLowerCase()) {
        throw new Error('Keyfile authorization pubkey does not match active wallet');
      }

      const authPriv = new k.PrivateKey(authSecret);
      const derivedAuthPubkey = String(authPriv.toPublicKey().toString()).trim();
      if (derivedAuthPubkey.toLowerCase() !== authPubkey.toLowerCase()) {
        throw new Error('Keyfile authorization secret does not match authorization pubkey');
      }

      keyring = {
        wallet_id: walletId,
        priv0: authPriv,
        address0: statusAddress0
      };

      const me = await jget('/api/v1/session/me');
      const userId = me && me.ok === true && me.user_id ? String(me.user_id).trim() : '';
      if (!userId) throw new Error('Unable to determine active user');

      const unlockedAtMs = Date.now();

      writeKeyringSessionOrThrow({
        v: 1,
        user_id: userId,
        wallet_id: walletId,
        wallet_type: 'compliance',
        priv0_hex: String(authPriv.toString()),
        address0: statusAddress0,
        unlocked_at_ms: unlockedAtMs
      });

      setLiveUnlockState({
        walletId,
        address0: statusAddress0,
        unlockedAtMs
      });

      setKeyfileStatus('Unlocked (matches active wallet)');
      return;
    }

    const mnemonicPhrase = inner && typeof inner.mnemonic === 'string' ? inner.mnemonic : '';
    if (!mnemonicPhrase.trim()) throw new Error('Keyfile missing mnemonic');

    const derivation = inner && typeof inner.derivation === 'object' && inner.derivation ? inner.derivation : {};
    const derivationAccountRaw = typeof derivation.account === 'number' ? derivation.account : Number(derivation.account);
    const derivationIndexRaw = typeof derivation.index === 'number' ? derivation.index : Number(derivation.index);

    const derivationAccount = Number.isFinite(derivationAccountRaw) && derivationAccountRaw >= 0 ? derivationAccountRaw : 0;
    const derivationIndex = Number.isFinite(derivationIndexRaw) && derivationIndexRaw >= 0 ? derivationIndexRaw : 0;

    const seedPassphrase =
      inner && typeof inner.seed_passphrase === 'string'
        ? inner.seed_passphrase
        : pass;

    const mnemonic = new k.Mnemonic(mnemonicPhrase);
    const xprv = new k.XPrv(mnemonic.toSeed(seedPassphrase));
    const keygen = new k.PrivateKeyGenerator(xprv, false, BigInt(derivationAccount));
    const priv0 = keygen.receiveKey(derivationIndex);

    const keyfileNetworkMeta = getNetworkMeta(String(inner.network || ''));
    if (!keyfileNetworkMeta || !keyfileNetworkMeta.sdkNetworkId) {
      throw new Error('Unsupported keyfile network');
    }
    const addr0 = String(priv0.toAddress(keyfileNetworkMeta.sdkNetworkId).toString());
    const uiAddr = addrEl ? String(addrEl.textContent || '').trim() : '';

    if (kfType === 'compliance') {
      const st = await jget('/api/wallet/status');
      const wid = st && st.ok === true && st.wallet_id ? String(st.wallet_id).trim() : '';
      if (!wid) throw new Error('Unable to determine active wallet');
      if (kfWalletId && wid !== kfWalletId) {
        throw new Error('Keyfile does not match active wallet');
      }
    } else {
      if (uiAddr && uiAddr !== '—' && addr0 && uiAddr !== addr0) {
        throw new Error('Keyfile does not match active wallet address');
      }
    }

    keyring = {
      wallet_id: String(inner.wallet_id || ''),
      priv0,
      address0: addr0
    };

    const st = await jget('/api/wallet/status');
    if (!st || st.ok !== true) throw new Error('Unable to determine active wallet');

    const walletId = String(st.wallet_id || '').trim();
    const walletType = String(st.wallet_type || '').trim();
    if (!walletId || !walletType) throw new Error('Unable to determine active wallet');

    const me = await jget('/api/v1/session/me');
    const userId = me && me.ok === true && me.user_id ? String(me.user_id).trim() : '';
    if (!userId) throw new Error('Unable to determine active user');

    const unlockedAtMs = Date.now();

    writeKeyringSessionOrThrow({
      v: 1,
      user_id: userId,
      wallet_id: walletId,
      wallet_type: walletType,
      priv0_hex: String(priv0.toString()),
      address0: addr0,
      unlocked_at_ms: unlockedAtMs
    });

    setLiveUnlockState({
      walletId,
      address0: addr0,
      unlockedAtMs
    });

    setKeyfileStatus('Unlocked (matches active wallet)');
  }

  function clearKeyfile() {
    keyfileOuter = null;
    keyring = null;
    clearKeyringSession();
    setLiveUnlockState(null);
    try { if (keyfileFileEl) keyfileFileEl.value = ''; } catch (_) {}
    try { if (keyfilePassEl) keyfilePassEl.value = ''; } catch (_) {}
    setKeyfileStatus('Locked');
  }

  async function changeKeyfilePassphrase() {
    const currentPass = changePassCurrentEl && typeof changePassCurrentEl.value === 'string' ? changePassCurrentEl.value : '';
    const newPass = changePassNewEl && typeof changePassNewEl.value === 'string' ? changePassNewEl.value : '';
    const confirmPass = changePassConfirmEl && typeof changePassConfirmEl.value === 'string' ? changePassConfirmEl.value : '';

    if (!currentPass.trim()) throw new Error('Missing current passphrase');
    if (!newPass.trim()) throw new Error('Missing new passphrase');
    if (newPass !== confirmPass) throw new Error('New passphrase confirmation does not match');

    if (!keyfileOuter || typeof keyfileOuter !== 'object') {
      const f = keyfileFileEl && keyfileFileEl.files && keyfileFileEl.files[0] ? keyfileFileEl.files[0] : null;
      if (!f) throw new Error('No keyfile loaded');
      const txt = await readFileText(f);
      const obj = JSON.parse(txt);
      keyfileOuter = obj;
      setKeyfileStatus('Loaded (locked)');
    }

    const ciphertext = keyfileOuter.ciphertext;
    if (typeof ciphertext !== 'string' || !ciphertext.trim()) throw new Error('Bad keyfile');

    const k = await kaspaReadyOrThrow();
    const plain = k.decryptXChaCha20Poly1305(ciphertext, currentPass);
    const inner = JSON.parse(String(plain || '{}'));

    const nextOuter = {
      kind: typeof keyfileOuter.kind === 'string' ? keyfileOuter.kind : 'td-wallet-keyfile',
      v: typeof keyfileOuter.v === 'number' ? keyfileOuter.v : 1,
      created_at: new Date().toISOString(),
      wallet_id: typeof keyfileOuter.wallet_id === 'string' ? keyfileOuter.wallet_id : String(inner.wallet_id || ''),
      wallet_type: typeof keyfileOuter.wallet_type === 'string' ? keyfileOuter.wallet_type : String(inner.wallet_type || ''),
      network: typeof keyfileOuter.network === 'string' ? keyfileOuter.network : String(inner.network || ''),
      cipher: 'xchacha20poly1305-pw',
      ciphertext: k.encryptXChaCha20Poly1305(JSON.stringify(inner), newPass)
    };

    keyfileOuter = nextOuter;

    try { if (keyfilePassEl) keyfilePassEl.value = newPass; } catch (_) {}
    try { if (changePassCurrentEl) changePassCurrentEl.value = ''; } catch (_) {}
    try { if (changePassNewEl) changePassNewEl.value = ''; } catch (_) {}
    try { if (changePassConfirmEl) changePassConfirmEl.value = ''; } catch (_) {}

    const wid = typeof nextOuter.wallet_id === 'string' ? String(nextOuter.wallet_id).trim() : '';
    const fname = `td-wallet-v1-${wid || 'keyfile'}.json`;
    downloadJson(fname, nextOuter);

    setKeyfileStatus(`Re-encrypted: ${fname}`);
    setChangePassStatus('Downloaded replacement keyfile');

    try {
      const dlg = document.getElementById('changePassphraseDialog');
      dlg && dlg.close && dlg.close();
    } catch (_) {}
  }

  async function onKeyfileFileChange() {
    try {
      const f = keyfileFileEl && keyfileFileEl.files && keyfileFileEl.files[0] ? keyfileFileEl.files[0] : null;
      if (!f) return;
      const txt = await readFileText(f);
      const obj = JSON.parse(txt);
      keyfileOuter = obj;
      keyring = null;
      clearKeyringSession();
      setLiveUnlockState(null);
      setKeyfileStatus('Loaded (locked)');
    } catch (e) {
      keyfileOuter = null;
      keyring = null;
      clearKeyringSession();
      setLiveUnlockState(null);
      setKeyfileStatus(`Keyfile load failed: ${String(e && e.message ? e.message : e)}`);
    }
  }

  // ---------- Elements ----------
  const addrEl     = $('wAddress');
  const tokenSel   = $('tokenSelect');
  const sendBtn    = $('btnSend');
  const recvBtn    = $('btnReceive');
  const btnRefresh = $('btnRefresh');
  const openKaspa  = $('btnOpenKaspa');
  const lastUpdEl  = $('lastUpdated');

  const keyfileFileEl   = $('keyfileFile');
  const keyfilePassEl   = $('keyfilePass');
  const keyfileStatusEl = $('keyfileStatus');
  const btnKeyfileUnlock= $('btnKeyfileUnlock');
  const btnKeyfileExport= $('btnKeyfileExport');
  const btnKeyfileClear = $('btnKeyfileClear');

  const changePassCurrentEl = $('changePassCurrent');
  const changePassNewEl = $('changePassNew');
  const changePassConfirmEl = $('changePassConfirm');
  const changePassStatusEl = $('changePassStatus');
  const btnChangePassphrase = $('btnChangePassphrase');

  const toEl       = $('wTo');
  const amtEl      = $('wAmt');
  const btnMax     = $('btnMax');
  const resultEl   = $('wSendResult');
  const copyStatusEl = $('copyStatus');

  function flashCopyStatus(msg) {
    try {
      if (!copyStatusEl) return;
      copyStatusEl.textContent = String(msg || '');
      setTimeout(function () { try { copyStatusEl.textContent = ''; } catch (_) {} }, 2000);
    } catch (_) {}
  }

  async function tryCopyText(txt) {
    try {
      const t = String(txt || '').trim();
      if (!t) return false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function currentWalletAddress() {
    try {
      const el = $('wAddress');
      const addr = el ? String(el.textContent || '').trim() : '';
      if (!addr || addr === '—') return '';
      return addr;
    } catch (_) {}
    return '';
  }

  function isWalletQrAddress(addr) {
    const s = String(addr || '').trim().toLowerCase();
    const mainMeta = getNetworkMeta('mainnet');
    const testMeta = getNetworkMeta('tn10');
    const mainPrefix = mainMeta && mainMeta.addressPrefix ? String(mainMeta.addressPrefix).toLowerCase() : '';
    const testPrefix = testMeta && testMeta.addressPrefix ? String(testMeta.addressPrefix).toLowerCase() : '';
    if (!s) return false;
    return (!!mainPrefix && s.indexOf(mainPrefix) === 0) || (!!testPrefix && s.indexOf(testPrefix) === 0);
  }

  function setWalletSendToAddress(addr) {
    try {
      const to = String(addr || '').trim();
      if (!toEl || !isWalletQrAddress(to)) return false;
      toEl.value = to;
      try { toEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { toEl.focus(); } catch (_) {}
      return true;
    } catch (_) {}
    return false;
  }

  async function copyCurrentWalletAddress() {
    const addr = currentWalletAddress();
    if (!addr) {
      flashCopyStatus('Copy failed');
      return false;
    }

    const ok = await tryCopyText(addr);
    flashCopyStatus(ok ? 'Copied' : 'Copy failed');
    return ok;
  }

  window.setWalletSendToAddress = setWalletSendToAddress;
  window.copyCurrentWalletAddress = copyCurrentWalletAddress;

  // Button gating is handled in index.html (MB-08A: MAX/Estimate deferred).

  const assetsBody = $('assetsBody');

  if (assetsBody) {
    assetsBody.addEventListener('click', async (ev) => {
      try {
        const raw = ev && ev.target ? ev.target : null;
        const node = (raw && raw.nodeType === 3) ? raw.parentElement : raw;
        const t = node && node.closest ? node.closest('[data-ca-full]') : null;
        if (!t) return;

        const full = String(t.dataset.caFull || '').trim();
        const short = String(t.dataset.caShort || '').trim();
        if (!full) return;

        // Show full CA immediately; keep it visible if copy fails.
        t.textContent = full;
        t.style.wordBreak = 'break-all';
        t.style.whiteSpace = 'normal';

        const ok = await tryCopyText(full);
        if (ok) {
          flashCopyStatus('Copied');
          setTimeout(function () {
            try { t.textContent = short || full; } catch (_) {}
          }, 2000);
        } else {
          flashCopyStatus('Copy failed');
        }
      } catch (_) {}
    });
  }

  // ---------- State ----------
  let lastHoldings = null;
  let activeWalletId = '';
  let activeWalletNetwork = '';
  let sending = false;
  const SEND_WATCHDOG_MS = 10000; // auto-release if backend hangs

  let keyfileOuter = null;  // parsed outer JSON
  let keyring = null;       // unlocked { wallet_id, mnemonic, priv0_hex, address0 }

  const KEYRING_SESSION_KEY = 'cw_keyring_session';
  const LIVE_UNLOCK_WINDOW_KEY = '__cwWalletLiveUnlock';

  function writeKeyringSessionOrThrow(obj) {
    const txt = JSON.stringify(obj);
    sessionStorage.setItem(KEYRING_SESSION_KEY, txt);
    const probe = sessionStorage.getItem(KEYRING_SESSION_KEY);
    if (probe !== txt) throw new Error('Unable to persist keyring session');
  }

  function clearKeyringSession() {
    try { sessionStorage.removeItem(KEYRING_SESSION_KEY); } catch (_) {}
  }

  function setLiveUnlockState(state) {
    try {
      if (!state || typeof state !== 'object') {
        window[LIVE_UNLOCK_WINDOW_KEY] = null;
        return;
      }

      const walletId = typeof state.walletId === 'string' ? state.walletId.trim() : '';
      const address0 = typeof state.address0 === 'string' ? state.address0.trim() : '';
      const unlockedAtMs = Number(state.unlockedAtMs);

      if (!walletId || !address0 || !Number.isFinite(unlockedAtMs) || unlockedAtMs <= 0) {
        window[LIVE_UNLOCK_WINDOW_KEY] = null;
        return;
      }

      window[LIVE_UNLOCK_WINDOW_KEY] = {
        walletId,
        address0,
        unlockedAtMs
      };
    } catch (_) {
      try { window[LIVE_UNLOCK_WINDOW_KEY] = null; } catch (_) {}
    }
  }

  setLiveUnlockState(null);

  // ---------- Form Lock Helpers ----------
  // Lock/unlock send form fields (used by normal send flow).
  window.lockFields = function(){
    try { if (tokenSel) tokenSel.disabled = true; } catch(_) {}
    try { if (toEl)     toEl.disabled     = true; } catch(_) {}
    try { if (amtEl)    amtEl.disabled    = true; } catch(_) {}
  };

  window.unlockFields = function(){
    try { if (tokenSel) tokenSel.disabled = false; } catch(_) {}
    try { if (toEl)     toEl.disabled     = false; } catch(_) {}
    try { if (amtEl)    amtEl.disabled    = false; } catch(_) {}
  };

  // ---------- Renderers ----------
  function renderAddress(h) {
    const el = document.getElementById('wAddress');
    if (el) {
      el.textContent = (h && h.address) ? h.address : '—';
      if (window.refreshQR) { try { window.refreshQR(); } catch (e) {} }  // [ADD]
    }
  }

  // === KRC-20 QR helpers (moved from index.html; single-path, no fallbacks) ===
(function(){
  function currentQrBox() {
    return document.getElementById('qrPreviewBox') || document.getElementById('walletQrPreviewBox');
  }

  function krcUpdateQR(addr){
    const qrBox = currentQrBox();
    if (!qrBox) return;
    if (!isWalletQrAddress(addr)) return;
    const img = new Image();
    img.width = 144; img.height = 144; img.alt = 'Wallet QR';
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=144x144&margin=2&data=' + encodeURIComponent(addr);
    qrBox.setAttribute('aria-hidden', 'false');
    while (qrBox.firstChild) qrBox.removeChild(qrBox.firstChild);
    qrBox.appendChild(img);
  }

  function krcRefreshQR(){
    const addr = currentWalletAddress();
    if (isWalletQrAddress(addr)) krcUpdateQR(addr);
  }

  function openWalletQrModal() {
    const dialog = document.getElementById('walletQrDialog');
    const addr = currentWalletAddress();
    if (!dialog || !isWalletQrAddress(addr)) return false;
    krcUpdateQR(addr);
    try {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', 'open');
      }
      return true;
    } catch (_) {}
    return false;
  }

  function closeWalletQrModal() {
    const dialog = document.getElementById('walletQrDialog');
    if (!dialog) return false;
    try {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
      return true;
    } catch (_) {}
    return false;
  }

  // Expose for renderAddress(h) which already calls window.refreshQR()
  window.refreshQR = krcRefreshQR;
  window.openWalletQrModal = openWalletQrModal;
  window.closeWalletQrModal = closeWalletQrModal;
})();

  function renderUpdated() {
    if (!lastUpdEl) return;
    const d = new Date();
    const base = d.toLocaleTimeString();
    const k = lastHoldings && lastHoldings.krc20 ? lastHoldings.krc20 : null;

    if (k && k.ok === false) {
      lastUpdEl.textContent = `${base} • KRC-20: ERROR`;
      return;
    }

    if (k && k.ok === true) {
      lastUpdEl.textContent = `${base} • KRC-20: OK`;
      return;
    }

    lastUpdEl.textContent = base;
  }

  const OMA_L1_SELECT_PREFIX = 'OMA_L1:';

  function omaL1TrackedTokensFromHoldings(h) {
    const tokens = h && h.oma_l1 && Array.isArray(h.oma_l1.tokens) ? h.oma_l1.tokens : [];
    return tokens.filter((tok) => {
      if (!tok || tok.asset_kind !== 'oma_l1_covenant_token') return false;
      const covenantId = String(tok.asset_covenant_id || '').trim().toLowerCase();
      const holderOutpoint = String(tok.holder_outpoint || '').trim();
      const amountRaw = String(tok.amount_raw || '').trim();
      return /^[0-9a-f]{64}$/.test(covenantId) && !!holderOutpoint && /^\d+$/.test(amountRaw) && BigInt(amountRaw) > 0n;
    });
  }

  function omaL1FormatRawAmountHuman(rawText, decimals) {
    const raw = String(rawText || '0').trim();
    const dec = Number(decimals || 0);
    if (!/^\d+$/.test(raw) || !Number.isInteger(dec) || dec <= 0) return raw || '0';
    const padded = raw.padStart(dec + 1, '0');
    const whole = padded.slice(0, -dec) || '0';
    const frac = padded.slice(-dec).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }

  function omaL1AggregateTrackedTokensForSelect(h) {
    const byAsset = new Map();
    for (const tok of omaL1TrackedTokensFromHoldings(h)) {
      const covenantId = String(tok.asset_covenant_id || '').trim().toLowerCase();
      const amountRaw = String(tok.amount_raw || '0').trim();
      const decimals = (tok && typeof tok.decimals === 'number') ? tok.decimals : 0;
      const symbol = String(tok.token_symbol || 'OMA L1').trim() || 'OMA L1';
      if (!byAsset.has(covenantId)) {
        byAsset.set(covenantId, {
          asset_covenant_id: covenantId,
          token_symbol: symbol,
          decimals,
          amount_raw_total: 0n,
          holder_lot_count: 0
        });
      }
      const row = byAsset.get(covenantId);
      row.amount_raw_total += BigInt(amountRaw);
      row.holder_lot_count += 1;
    }
    return Array.from(byAsset.values()).map((row) => ({
      ...row,
      amount_raw: row.amount_raw_total.toString(),
      amount_human: omaL1FormatRawAmountHuman(row.amount_raw_total.toString(), row.decimals)
    })).sort((a, b) => String(a.token_symbol || '').localeCompare(String(b.token_symbol || '')) || String(a.asset_covenant_id || '').localeCompare(String(b.asset_covenant_id || '')));
  }

  function omaL1SelectValue(tok) {
    const covenantId = String(tok && tok.asset_covenant_id || '').trim().toLowerCase();
    return OMA_L1_SELECT_PREFIX + covenantId;
  }

  function isOmaL1SelectedAsset(token, opt) {
    if (opt && opt.dataset && opt.dataset.assetKind === 'oma_l1_covenant_token') return true;
    return String(token || '').startsWith(OMA_L1_SELECT_PREFIX);
  }

  function omaL1SelectedMetaOrThrow(opt) {
    if (!opt || !opt.dataset || opt.dataset.assetKind !== 'oma_l1_covenant_token') throw new Error('oma_l1_selection_metadata_missing');
    const assetCovenantId = String(opt.dataset.assetCovenantId || '').trim().toLowerCase();
    const tokenSymbol = String(opt.dataset.tokenSymbol || 'OMA L1').trim() || 'OMA L1';
    if (!/^[0-9a-f]{64}$/.test(assetCovenantId)) throw new Error('oma_l1_asset_covenant_id_missing');
    return { assetCovenantId, tokenSymbol };
  }

  function renderTokenSelect(h) {
    if (!tokenSel) return;
    const prev = tokenSel.value || 'KAS';
    tokenSel.innerHTML = '';
    const list = ['KAS', ...Object.keys(h?.tokens || {}).sort()];
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = t;

      const dec =
        t === 'KAS'
          ? 8
          : (h && h.token_dec && typeof h.token_dec[t] === 'number' ? h.token_dec[t] : 0);
      opt.dataset.dec = String(dec);

      tokenSel.appendChild(opt);
    }
        // Issue-Mode (CA) entries — value is "CA:<txid>", label "NAME · shortCA"
    const issues = Array.isArray(h?.issue) ? h.issue : [];
    for (const it of issues) {
      if (!it || typeof it !== 'object') continue;
      const ca   = String(it.ca || '');
      if (!ca) continue;
      const name = (it.name && String(it.name)) || 'CA';
      const opt  = document.createElement('option');
      opt.value = 'CA:' + ca;
      opt.textContent = `${name} · ${shortCA(ca)}`;
      // Optional metadata for later guards
      opt.dataset.idType = 'ca';
      opt.dataset.ca = ca;
      opt.dataset.name = name;
      opt.dataset.dec = String((it && typeof it.dec === 'number') ? it.dec : 0);
      tokenSel.appendChild(opt);
    }

    const omaL1Tokens = omaL1AggregateTrackedTokensForSelect(h);
    const omaL1Values = [];
    for (const tok of omaL1Tokens) {
      const symbol = String(tok.token_symbol || 'OMA L1').trim() || 'OMA L1';
      const covenantId = String(tok.asset_covenant_id || '').trim().toLowerCase();
      const lotCount = Number(tok.holder_lot_count || 0);
      const opt = document.createElement('option');
      opt.value = omaL1SelectValue(tok);
      opt.textContent = `${symbol} · OMA L1 · ${shortCA(covenantId)}`;
      opt.dataset.assetKind = 'oma_l1_covenant_token';
      opt.dataset.assetCovenantId = covenantId;
      opt.dataset.tokenSymbol = symbol;
      opt.dataset.dec = String((tok && typeof tok.decimals === 'number') ? tok.decimals : 0);
      opt.dataset.amountRaw = String(tok.amount_raw || '0');
      opt.dataset.amountHuman = String(tok.amount_human || tok.amount_raw || '0');
      opt.dataset.holderLotCount = String(lotCount);
      opt.dataset.sourceSelection = 'automatic_backend';
      opt.dataset.normalSendEligible = 'false';
      opt.dataset.route = 'oma_l1_holder_transfer';
      omaL1Values.push(opt.value);
      tokenSel.appendChild(opt);
    }

    // Restore previous selection if it was a CA or OMA L1 value
    if (!list.includes(prev)) {
      const caValues = issues.map(it => 'CA:' + String(it?.ca || ''));
      if (caValues.includes(prev) || omaL1Values.includes(prev)) tokenSel.value = prev;
    }
    if (list.includes(prev)) tokenSel.value = prev;
  }

  function isPositiveAssetAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'bigint') return value > 0n;
    const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) && parsed > 0;
  }

  function renderAssets(h) {
    if (!assetsBody) return;
    assetsBody.innerHTML = '';
    const icons = (h && h.icons) || {};
    const entries = [
      ['KAS', h?.kas ?? 0],
      ...Object.entries(h?.tokens || {}).filter(([, val]) => isPositiveAssetAmount(val))
    ];

    for (const [sym, val] of entries) {
      const tr  = document.createElement('tr');

      // icon + symbol
      const td1 = document.createElement('td');
      const img = document.createElement('img');
      img.src   = icons[sym] || '';
      img.alt   = sym;
      img.width = 40; img.height = 40;
      img.style.verticalAlign = 'middle';
      img.style.marginRight   = '8px';
      img.onerror = function(){ this.style.display = 'none'; };
      td1.appendChild(img);
      td1.appendChild(document.createTextNode(sym));

      // amount
      const td2 = document.createElement('td');
      td2.textContent = (typeof val === 'number' ? val : (val || 0));

      tr.appendChild(td1); tr.appendChild(td2);
      assetsBody.appendChild(tr);
    }

    // Issue-Mode (CA) rows (no icons)
    const issues = Array.isArray(h?.issue) ? h.issue : [];
    for (const it of issues) {
      if (!it || typeof it !== 'object') continue;
      const ca  = String(it.ca || '');
      if (!ca) continue;
      const nm  = (it.name && String(it.name)) || 'CA';
      const amt = (typeof it.amount === 'number') ? it.amount : (Number(it.amount) || 0);
      if (!isPositiveAssetAmount(amt)) continue;
      const tr  = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.appendChild(document.createTextNode(`${nm} · `));

      const caShort = shortCA(ca);
      const caSpan = document.createElement('span');
      caSpan.className = 'mono';
      caSpan.style.cursor = 'pointer';
      caSpan.title = 'Click to copy full CA';
      caSpan.dataset.caFull = ca;
      caSpan.dataset.caShort = caShort;
      caSpan.textContent = caShort;

      td1.appendChild(caSpan);
      const td2 = document.createElement('td'); td2.textContent = amt;
      tr.appendChild(td1); tr.appendChild(td2);
      assetsBody.appendChild(tr);
    }

    const omaTokens = omaL1AggregateTrackedTokensForSelect(h);
    for (const tok of omaTokens) {
      if (!tok || !/^[0-9a-f]{64}$/.test(String(tok.asset_covenant_id || '').trim().toLowerCase())) continue;
      const symbol = String(tok.token_symbol || 'OMA L1').trim() || 'OMA L1';
      const covenantId = String(tok.asset_covenant_id || '').trim().toLowerCase();
      const lotCount = Number(tok.holder_lot_count || 0);
      const tr = document.createElement('tr');
      tr.dataset.assetKind = 'oma_l1_covenant_token';
      tr.dataset.tokenSymbol = symbol;
      tr.dataset.assetCovenantId = covenantId;
      tr.dataset.holderLotCount = String(lotCount);
      tr.dataset.sourceSelection = 'automatic_backend';
      tr.dataset.normalSendEligible = 'false';
      tr.dataset.tokenTransferEnabled = 'true';

      const td1 = document.createElement('td');
      td1.appendChild(document.createTextNode(`${symbol} · covenant `));

      const covSpan = document.createElement('span');
      covSpan.className = 'mono';
      covSpan.style.cursor = 'pointer';
      covSpan.title = lotCount > 1 ? `Click to copy full covenant ID (${lotCount} holder lots summed)` : 'Click to copy full covenant ID';
      covSpan.dataset.caFull = covenantId;
      covSpan.dataset.caShort = shortCA(covenantId);
      covSpan.textContent = shortCA(covenantId);
      td1.appendChild(covSpan);

      const td2 = document.createElement('td');
      td2.textContent = String(tok.amount_human || tok.amount_raw || '0');

      tr.appendChild(td1);
      tr.appendChild(td2);
      assetsBody.appendChild(tr);
    }
  }

  // ---------- Data ----------
  async function refreshAll() {
    try {
      // Single source of truth: server Active wallet only (no client overrides).
      try { if (typeof window !== 'undefined' && window.KRC_FORCED_ADDR) { delete window.KRC_FORCED_ADDR; } } catch(_) {}
      try { localStorage.removeItem('krc.addr'); } catch(_) {}
      try { if (btnKeyfileClear) btnKeyfileClear.textContent = 'LOCK'; } catch (_) {}

      const url = '/api/wallet/holdings?strict=1';
      const h = await jget(url);
      lastHoldings = h;
      renderAddress(h);
      renderTokenSelect(h);
      renderAssets(h);
      renderUpdated();

      let st = null;
      let currentUserId = '';

      try {
        st = await jget('/api/wallet/status');
        activeWalletId = st && st.ok === true && st.wallet_id ? String(st.wallet_id).trim() : '';
        activeWalletNetwork = st && st.ok === true ? String(st.network || st.net || '').trim() : '';
        applySwapsEntryGate(st && st.ok === true ? st.wallet_type : '');
      } catch (_) {
        st = null;
        activeWalletId = '';
        activeWalletNetwork = '';
      }

      try {
        const me = await jget('/api/v1/session/me');
        currentUserId = me && me.ok === true && me.user_id ? String(me.user_id).trim() : '';
      } catch (_) {
        currentUserId = '';
      }

      try {
        var raw = '';
        try { raw = sessionStorage.getItem(KEYRING_SESSION_KEY) || ''; } catch (_) { raw = ''; }
        var sess = null;
        try { sess = raw ? JSON.parse(raw) : null; } catch (_) { sess = null; }

        var walletId = st && st.ok === true && st.wallet_id ? String(st.wallet_id).trim() : '';
        var walletType = st && st.ok === true && st.wallet_type ? String(st.wallet_type).trim() : '';
        var addr0Expected =
          st && st.ok === true && st.address0
            ? String(st.address0).trim()
            : (h && h.address ? String(h.address).trim() : '');

        var sessUserId = sess && typeof sess.user_id === 'string' ? String(sess.user_id).trim() : '';
        var sessWalletId = sess && typeof sess.wallet_id === 'string' ? String(sess.wallet_id).trim() : '';
        var sessWalletType = sess && typeof sess.wallet_type === 'string' ? String(sess.wallet_type).trim() : '';
        var sessPriv0Hex = sess && typeof sess.priv0_hex === 'string' ? String(sess.priv0_hex).trim() : '';

        var staleSession = !!sess && (
          (currentUserId && sessUserId && sessUserId !== currentUserId) ||
          (walletId && sessWalletId && sessWalletId !== walletId) ||
          (walletType && sessWalletType && sessWalletType !== walletType)
        );

        if (!sess || !walletId || !walletType || !addr0Expected || !sessPriv0Hex || staleSession) {
          keyring = null;
          if (staleSession || (sess && !sessPriv0Hex)) clearKeyringSession();
          setLiveUnlockState(null);
          setKeyfileStatus('Locked');
          return;
        }

        const k = await kaspaReadyOrThrow();
        const priv0 = new k.PrivateKey(sessPriv0Hex);
        let addr0 = addr0Expected;

        if (walletType === 'standard') {
          const networkMeta = getNetworkMeta(st && st.ok === true ? (st.network || st.net) : '');
          if (!networkMeta || !networkMeta.sdkNetworkId) {
            keyring = null;
            clearKeyringSession();
            setLiveUnlockState(null);
            setKeyfileStatus('Locked');
            return;
          }
          addr0 = String(priv0.toAddress(networkMeta.sdkNetworkId).toString());
          if (addr0 !== addr0Expected) {
            keyring = null;
            clearKeyringSession();
            setLiveUnlockState(null);
            setKeyfileStatus('Locked');
            return;
          }
        }

        keyring = {
          wallet_id: walletId,
          priv0: priv0,
          address0: addr0
        };

        const unlockedAtMs = sess && Number(sess.unlocked_at_ms);
        setLiveUnlockState({
          walletId: walletId,
          address0: addr0,
          unlockedAtMs: Number.isFinite(unlockedAtMs) && unlockedAtMs > 0 ? unlockedAtMs : Date.now()
        });

        setKeyfileStatus('Unlocked — Click LOCK to lock');

      } catch (_) {
        keyring = null;
        setLiveUnlockState(null);
        setKeyfileStatus('Locked');
      }
    } catch (e) {
      console.warn('holdings error:', e);
      if (addrEl) addrEl.textContent = '—';
      if (assetsBody) assetsBody.innerHTML = '';
    }
  }

  // ---------- Receive Panel ----------
  const recvPane = $('recvPane');
  const addrFull = $('addrFull');
  const qrBox    = $('qrBox');
  const btnCloseRecv = $('btnCloseRecv');
  function showReceive() {
    if (!recvPane) return;
    const addr = lastHoldings?.address || '';
    if (addrFull) addrFull.textContent = addr || '—';
    recvPane.style.display = 'block';
  }
  function hideReceive() {
    if (recvPane) recvPane.style.display = 'none';
  }
  if (recvBtn) recvBtn.addEventListener('click', showReceive);
  if (btnCloseRecv) btnCloseRecv.addEventListener('click', hideReceive);

    // ---------- MAX (CB-MAX-1) ----------
  // Behavior:
  // - MAX fills Amount with the exact holdings value for the selected asset.
  // - Only for KAS, MAX signals ReceiverPays on send (use_max).
  window.__USE_MAX = false;
  window.__USE_MAX_ASSET = '';

  async function applyMax() {
    try {
      if (!amtEl) return;

      const token = (tokenSel && typeof tokenSel.value === 'string' && tokenSel.value.trim())
        ? tokenSel.value.trim()
        : 'KAS';
      const selectedOption = tokenSel && tokenSel.options && tokenSel.selectedIndex >= 0 ? tokenSel.options[tokenSel.selectedIndex] : null;

      if (isOmaL1SelectedAsset(token, selectedOption)) {
        amtEl.value = String((selectedOption && selectedOption.dataset && (selectedOption.dataset.amountHuman || selectedOption.dataset.amountRaw)) || '');
        amtEl.dispatchEvent(new Event('input',  { bubbles: true }));
        amtEl.dispatchEvent(new Event('change', { bubbles: true }));
        window.__USE_MAX = false;
        window.__USE_MAX_ASSET = '';
        return;
      }

      const r = await jget('/api/wallet/max-sendable?token=' + encodeURIComponent(token));
      if (!r || !r.ok) {
        if (resultEl) resultEl.textContent = (r && (r.error || r.reason)) ? String(r.error || r.reason) : 'MAX failed';
        return;
      }

      amtEl.value = String(r.amount || '');
      amtEl.dispatchEvent(new Event('input',  { bubbles: true }));
      amtEl.dispatchEvent(new Event('change', { bubbles: true }));

      window.__USE_MAX = (token.toUpperCase() === 'KAS') && !!r.use_receiver_pays;
      window.__USE_MAX_ASSET = window.__USE_MAX ? 'KAS' : '';
    } catch (e) {
      if (resultEl) resultEl.textContent = 'MAX failed: ' + String(e && e.message ? e.message : e);
    }
  }

  function clearMaxFlag() {
    try { window.__USE_MAX = false; window.__USE_MAX_ASSET = ''; } catch(_) {}
  }

  if (btnMax) btnMax.addEventListener('click', applyMax);
  if (amtEl) amtEl.addEventListener('input', clearMaxFlag, { passive: true });
  if (tokenSel) tokenSel.addEventListener('change', clearMaxFlag, { passive: true });

  // ---------- Confirm Modal ----------
  function ensureModal() {
    let wrap = document.getElementById('sendConfirmWrap');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'sendConfirmWrap';
    wrap.style.cssText = [
      'position:fixed','inset:0','background:rgba(0,0,0,.35)','display:none',
      'align-items:center','justify-content:center','z-index:20000'
    ].join(';');
    wrap.innerHTML = `
      <div id="sendConfirmCard" style="
        background:#fff; color:#111; width:min(520px, 92vw);
        border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.25);
        padding:16px; font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;">
        <div id="cfmTitle" style="font-weight:600; font-size:16px; margin-bottom:8px;">Confirm Send</div>
        <div id="cfmGrid" style="display:grid; grid-template-columns: 110px 1fr; gap:6px 10px; align-items:center;">
          <div style="color:#666">To</div><div id="cfmTo" style="word-break:break-all">—</div>
          <div style="color:#666">Amount</div><div id="cfmAmt">—</div>
          <div style="color:#666">Ticker</div><div id="cfmTok" style="word-break:break-all;overflow-wrap:anywhere">—</div>
          <div id="netRow" style="color:#666; display:none">Network</div><div id="cfmNet" style="display:none">—</div>
        </div>
        <div id="cfmStatus" role="status" aria-live="polite" class="muted" style="margin-top:12px; display:none; color:#111"></div>
        <div id="cfmActions" style="margin-top:14px; display:flex; gap:8px; justify-content:flex-end">
          <button id="cfmCancel" class="btn btn-secondary">Cancel</button>
          <button id="cfmConfirm" class="btn btn-primary">Confirm</button>
        </div>
      </div>`;

    document.body.appendChild(wrap);
    return wrap;
  }

  function showConfirm({to, amount, ticker, network, confirmLabel, cancelLabel, sendingText}) {
    const wrap = ensureModal();
    wrap.querySelector('#cfmTo').textContent  = to || '—';
    wrap.querySelector('#cfmAmt').textContent = amount || '—';
    wrap.querySelector('#cfmTok').textContent = ticker || '—';

    const netRow = wrap.querySelector('#netRow');
    const netEl  = wrap.querySelector('#cfmNet');
    if (network) {
      netRow.style.display = '';
      netEl.style.display = '';
      netEl.textContent = network;
    } else {
      netRow.style.display = 'none';
      netEl.style.display = 'none';
    }

    // Reset to Review state
    const status = wrap.querySelector('#cfmStatus');

    // Replace buttons with clones to drop any stale listeners from a prior use
    let btnCxl0 = wrap.querySelector('#cfmCancel');
    let btnOk0  = wrap.querySelector('#cfmConfirm');
    // IMPORTANT: replaceChild returns the removed node; re-select the inserted ones
    btnCxl0.parentNode.replaceChild(btnCxl0.cloneNode(true), btnCxl0);
    btnOk0.parentNode.replaceChild(btnOk0.cloneNode(true),  btnOk0);
    const btnCxl = wrap.querySelector('#cfmCancel');
    const btnOk  = wrap.querySelector('#cfmConfirm');

    status.style.display = 'none';
    status.textContent = '';
    btnOk.disabled = false;
    btnOk.textContent = confirmLabel || 'Confirm';
    btnCxl.textContent = cancelLabel || 'Cancel';
    btnCxl.style.display = '';
    wrap.style.display = 'flex';

    return new Promise((resolve) => {
      let resolved = false;

      function cleanup() {
        btnCxl.removeEventListener('click', onCancel);
        btnOk.removeEventListener('click', onConfirm);
      }
      function close() {
        wrap.style.display = 'none';
        cleanup();
      }
      function setSending() {
        status.textContent = sendingText || 'Sending…';
        status.style.display = '';
        btnOk.disabled = true;
        btnCxl.style.display = 'none';
      }
      function setError(msg) {
        status.textContent = 'Error: ' + (msg || 'Send failed');
        status.style.display = '';
        btnOk.disabled = false;
        btnOk.textContent = 'Try again';
        btnCxl.style.display = '';
        btnCxl.textContent = 'Close';
      }
      function setSuccess(msg) {
        status.textContent = msg || 'Sent';
        status.style.display = '';
        btnOk.disabled = true;
        btnCxl.style.display = 'none';
      }
      function backToReview() {
        status.textContent = '';
        status.style.display = 'none';
        btnOk.disabled = false;
        btnOk.textContent = 'Confirm';
        btnCxl.style.display = '';
        btnCxl.textContent = 'Cancel';
      }

      function onCancel() {
        // If we already resolved (user hit Confirm), this button is acting as "Close".
        if (resolved) {
          close();
          return;
        }
        resolved = true;
        close(); // actually close on Cancel
        resolve({ ok:false, close, setSending, setError, setSuccess, backToReview });
      }

      function onConfirm() {
        // After resolve (post-Confirm), this button is "Try again".
        // We cannot re-run the send from here; close so the user can initiate a new send cleanly.
        if (resolved) {
          close();
          return;
        }
        resolved = true;
        setSending();      // keep open while sending

        resolve({ ok:true, close, setSending, setError, setSuccess, backToReview });
      }

      btnCxl.addEventListener('click', onCancel);
      btnOk.addEventListener('click', onConfirm);
    });
  }

  window.CW_showConfirm = showConfirm;

  // ---------- Txid Dialog (non-blocking) ----------
  function showTxidDialog(txid, network){
    if (!txid) return;
    let wrap = document.getElementById('txidDialogWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'txidDialogWrap';
      wrap.style.cssText = [
        'position:fixed','inset:0','display:none','align-items:center','justify-content:center',
        'background:rgba(0,0,0,.35)','z-index:10000'
      ].join(';');
      wrap.innerHTML = `
        <div style="
          background:#fff;color:#111;width:min(560px,92vw);
          border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);
          padding:16px;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
          <div style="font-weight:600;font-size:16px;margin-bottom:8px;">Success</div>
          <div id="txidText" style="word-break:break-all"></div>
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
            <button id="txidCopy"     class="btn">Copy</button>
            <button id="txidExplorer" class="btn btn-secondary">View</button>
            <button id="txidClose"    class="btn btn-primary">Close</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const onClose = () => { wrap.style.display = 'none'; };
      // Click-away close disabled: only explicit buttons/keyboard should dismiss.
      wrap.querySelector('#txidClose').addEventListener('click', onClose);
      wrap.querySelector('#txidCopy').addEventListener('click', () => {
        try {
          const t = wrap.querySelector('#txidText')?.dataset?.txid || '';
          navigator.clipboard?.writeText(t);
        } catch(_) {}
      });
      wrap.querySelector('#txidExplorer').addEventListener('click', () => {
        const el = wrap.querySelector('#txidText');
        const t = el?.dataset?.txid || '';
        const net = String(el?.dataset?.net || '').toLowerCase();
        const shared = getNetworkSharedOrNull();
        const url = shared && typeof shared.getExplorerTxUrl === 'function'
          ? String(shared.getExplorerTxUrl(net, t) || '').trim()
          : '';
        if (url) window.open(url, '_blank', 'noopener');
      });
    }
    const box = wrap.querySelector('#txidText');
    if (box) {
      box.dataset.txid = txid;
      box.dataset.net = String(network || '');
      box.innerHTML = `txid: <code>${txid}</code>`;
    }
    wrap.style.display = 'flex';
  }

  function humanToRawAmount(amountStr, dec) {
    return getSendEngineOrThrow().humanToRawAmount(amountStr, dec);
  }

  // ---------- Send Handler ----------
  function buildSendEngineDeps() {
    return {
      jpost,
      kaspaReadyOrThrow
    };
  }

  window.CWBuildSendEngineDeps = buildSendEngineDeps;

  async function sendKrc20CommitRevealTransferSW(token, to, amountRaw, keyring) {
    return await getSendEngineOrThrow().sendKrc20CommitRevealTransferSW(
      { token, to, amountRaw, keyring },
      buildSendEngineDeps()
    );
  }

  async function sendSingleTransferSW(token, to, amountRaw, keyring, useMax) {
    return await getSendEngineOrThrow().sendSingleTransfer(
      { token, to, amountRaw, keyring, useMax: useMax === true },
      buildSendEngineDeps()
    );
  }

  function fillOmaL1SignatureScript(tx, inputIndex, signatureScript, reason) {
    const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) {
      throw new Error(reason || 'oma_l1_holder_transfer_input_missing');
    }
    inputs[inputIndex].signatureScript = signatureScript;
    tx.inputs = inputs;
  }

  function omaL1SignIndexesOrThrow(build, signCtx) {
    const signInputIndexes = Array.isArray(build && build.signInputIndexes) ? build.signInputIndexes.map((value) => Number(value)) : [];
    const signSet = new Set(signInputIndexes);
    const rawHolderInputs = signCtx && Array.isArray(signCtx.holder_inputs) ? signCtx.holder_inputs : [];
    const holderInputs = rawHolderInputs.map((input) => ({
      inputIndex: Number(input && input.input_index),
      sourceHolderOutpoint: String(input && input.source_holder_outpoint || '').trim(),
      redeemScriptHex: String(input && input.source_holder_redeem_script_hex || '').trim(),
      redeemScriptHexSha256: String(input && input.source_holder_redeem_script_hex_sha256 || '').trim()
    })).filter((input) => Number.isInteger(input.inputIndex) && input.inputIndex >= 0);

    if (holderInputs.length === 0) throw new Error('oma_l1_holder_transfer_holder_inputs_missing');
    for (const input of holderInputs) {
      if (!signSet.has(input.inputIndex)) throw new Error('oma_l1_holder_transfer_holder_input_index_not_signable');
      if (!input.sourceHolderOutpoint) throw new Error('oma_l1_holder_transfer_holder_input_outpoint_missing');
      if (!/^[0-9a-f]+$/i.test(input.redeemScriptHex) || input.redeemScriptHex.length % 2 !== 0) {
        throw new Error('oma_l1_holder_transfer_redeem_script_missing');
      }
    }

    const duplicateIndexes = new Set();
    for (const input of holderInputs) {
      if (duplicateIndexes.has(input.inputIndex)) throw new Error('oma_l1_holder_transfer_duplicate_holder_input_index');
      duplicateIndexes.add(input.inputIndex);
    }

    const rawFundingInputIndex = signCtx && Object.prototype.hasOwnProperty.call(signCtx, 'native_kas_funding_input_index')
      ? Number(signCtx.native_kas_funding_input_index)
      : null;
    const fundingInputIndex = Number.isInteger(rawFundingInputIndex) ? rawFundingInputIndex : null;
    if (fundingInputIndex !== null) {
      if (!signSet.has(fundingInputIndex)) throw new Error('oma_l1_holder_transfer_native_funding_input_index_not_signable');
      if (holderInputs.some((input) => input.inputIndex === fundingInputIndex)) throw new Error('oma_l1_holder_transfer_native_funding_overlaps_holder_input');
    }

    const expectedCount = holderInputs.length + (fundingInputIndex !== null ? 1 : 0);
    if (signInputIndexes.length !== expectedCount) throw new Error('oma_l1_holder_transfer_unexpected_sign_indexes');

    return {
      holderInputs: holderInputs.sort((a, b) => a.inputIndex - b.inputIndex),
      fundingInputIndex,
      signInputIndexes
    };
  }

  async function signOmaL1HolderTransferBuild(build, keyring) {
    const k = await kaspaReadyOrThrow();
    const txSafeJson = String(build && build.txToSignSafeJson || '').trim();
    const signCtx = build && build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : null;
    const signPlan = omaL1SignIndexesOrThrow(build, signCtx);

    if (!txSafeJson) throw new Error('oma_l1_holder_transfer_unsigned_tx_missing');
    if (!keyring || !keyring.priv0) throw new Error('wallet_locked');

    const tx = k.Transaction.deserializeFromSafeJSON(txSafeJson);
    const dummySig = new Uint8Array(65);
    const holderScripts = signPlan.holderInputs.map((input) => ({
      input,
      script: k.ScriptBuilder.fromScript(input.redeemScriptHex)
    }));

    for (const item of holderScripts) {
      fillOmaL1SignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(dummySig), 'oma_l1_holder_transfer_source_holder_input_missing');
    }

    for (const item of holderScripts) {
      const holderSignature = k.createInputSignature(tx, item.input.inputIndex, keyring.priv0, null);
      fillOmaL1SignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(holderSignature), 'oma_l1_holder_transfer_source_holder_input_missing');
    }

    if (signPlan.fundingInputIndex !== null) {
      const fundingSignature = k.createInputSignature(tx, signPlan.fundingInputIndex, keyring.priv0, null);
      fillOmaL1SignatureScript(tx, signPlan.fundingInputIndex, fundingSignature, 'oma_l1_holder_transfer_native_funding_input_missing');
    }

    tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    k.Transaction.deserializeFromSafeJSON(signedSafeJson);
    return signedSafeJson;
  }

  async function sendOmaL1HolderTransferSW(option, to, amountRaw, keyring) {
    const meta = omaL1SelectedMetaOrThrow(option);
    const build = await jpost('/api/covenants/issuer-token/holder-transfer/build', {
      asset_covenant_id: meta.assetCovenantId,
      source_selection: 'automatic_backend',
      recipient_address: to,
      transfer_amount_raw: amountRaw
    });

    if (!build || build.ok !== true || build.transfer_build_kind !== 'oma_l1_holder_transfer_build_v1') return build || { ok: false, reason: 'oma_l1_holder_transfer_build_failed' };

    const signedSafeJson = await signOmaL1HolderTransferBuild(build, keyring);
    const submit = await jpost('/api/covenants/issuer-token/holder-transfer/submit', {
      submit_intent: 'submit_oma_l1_holder_transfer_v1',
      submit_token: build.submit_token,
      signedSafeJson
    });

    if (submit && submit.ok === true) {
      return {
        ...submit,
        ok: true,
        txid: submit.submitted_txid || submit.signed_txid || '',
        token_symbol: meta.tokenSymbol,
        asset_covenant_id: meta.assetCovenantId
      };
    }

    return submit || { ok: false, reason: 'oma_l1_holder_transfer_submit_failed' };
  }

  function humanSendErrorMessage(value) {
    const data = value && typeof value === 'object' && value.data && typeof value.data === 'object'
      ? value.data
      : (value && typeof value === 'object' ? value : null);
    const reason = data && typeof data.reason === 'string' ? data.reason : '';
    const serverMsg = data && (data.error || data.message) ? String(data.error || data.message) : '';
    const rawMsg = value && typeof value === 'object' && value.message
      ? String(value.message)
      : String(value || '');
    const combined = [reason, serverMsg, rawMsg].join(' ');

    if (
      reason === 'normal_send_no_buildable_utxo' ||
      combined.includes('normal_send_no_buildable_utxo') ||
      combined.includes('No non-covenant UTXO candidate set can build')
    ) {
      return [
        'This wallet has funds, but none of the available non-covenant UTXOs can safely build this KAS send at this amount.',
        'Try a larger amount or consolidate/fund the wallet with a suitable UTXO.',
        'Covenant-bearing UTXOs remain blocked from normal sends.'
      ].join(' ');
    }

    if (
      reason === 'normal_send_only_covenant_utxos' ||
      combined.includes('Only covenant-bearing UTXOs are available')
    ) {
      return 'Only covenant-bearing UTXOs are available. Normal KAS send is blocked for those outputs. Use a covenant-aware spend path or choose a wallet with native KAS.';
    }

    return rawMsg || serverMsg || reason || 'Send failed';
  }

  async function handleSendClick(){
    const token = (tokenSel && tokenSel.value) || 'KAS';
    const to    = (toEl && toEl.value || '').trim();
    const amt   = (amtEl && amtEl.value || '').trim();

    // SoT enforcement: prevent sending if the asset changed after Estimate
    const lockedAsset = (typeof window !== 'undefined' ? (window.__ASSET_LOCK || '') : '');
    if (lockedAsset && token !== lockedAsset) {
      if (resultEl) resultEl.textContent = 'Selected asset changed since estimate. Click Cancel or re-Estimate.';
      return;
    }

    // Send-lock: ignore if already in flight
    if (sending) { if (resultEl) resultEl.textContent = 'Already sending…'; return; }

    // Basic input checks
    if (!to || !isWalletQrAddress(to)) {
      if (resultEl) resultEl.textContent = 'Enter a valid wallet address';
      return;
    }
    const selOpt =
      (tokenSel && tokenSel.selectedOptions && tokenSel.selectedOptions[0])
        ? tokenSel.selectedOptions[0]
        : null;

    const hasDec = !!(selOpt && selOpt.dataset && typeof selOpt.dataset.dec === 'string');
    const tokenDec = hasDec ? Number(selOpt.dataset.dec) : 0;
    const isOmaL1Send = isOmaL1SelectedAsset(token, selOpt);

    let amtForSend = amt;

    if (token === 'KAS') {
      if (!amt || Number(amt) <= 0) {
        if (resultEl) resultEl.textContent = 'Enter a positive amount';
        return;
      }
    } else {
      if (!hasDec) {
        if (resultEl) resultEl.textContent = 'Missing token decimals metadata (refresh holdings)';
        return;
      }
      const raw = humanToRawAmount(amt, tokenDec);
      if (!raw) {
        if (resultEl) resultEl.textContent = 'Enter a positive amount (token decimals respected)';
        return;
      }
      amtForSend = raw;
    }

    // Read-only: try to get network; hide if not available
    let network = '';
    let cnTimeoutMs = 0;
    try {
      const st = await jget('/api/wallet/status');
      const networkMeta = getNetworkMeta(st?.network || st?.net || '');
      network = networkMeta && networkMeta.displayLabel ? networkMeta.displayLabel : '';
      cnTimeoutMs = Number(st?.cn_timeout_ms || 0);
    } catch (_) { /* non-fatal */ }

    // 1) Show Confirm modal (returns controller); keep it open
    const modalTicker = isOmaL1Send && selOpt ? String(selOpt.textContent || 'OMA L1') : token;
    const modal = await showConfirm({ to, amount: amt, ticker: modalTicker, network, confirmLabel: 'SIGN & SEND', sendingText: 'Signing…' });
    if (!modal || !modal.ok) return; // user cancelled

    // 2) Confirm → send (modal already switched to "Sending…")
    // Require local keyring before we disable Send / enter send-lock.
    if (!keyring || !keyring.priv0) {
      try { modal.setError('Unlock your keyfile first.'); } catch(_) {}
      return;
    }

    sendBtn.disabled = true;
    sending = true;

    const useMax = (typeof window !== 'undefined' && window.__USE_MAX === true && window.__USE_MAX_ASSET === 'KAS');

    const sendPromise = isOmaL1Send
      ? sendOmaL1HolderTransferSW(selOpt, to, amtForSend, keyring)
      : sendSingleTransferSW(token, to, amtForSend, keyring, useMax);

    sendPromise.then((res) => {
      if (res && res.ok) {
        try { modal.setSuccess('Sent'); } catch(_) {}
        try { if (typeof window !== 'undefined' && typeof window.unlockFields === 'function') window.unlockFields(); } catch(_) {}
        setTimeout(() => { try { modal.close(); } catch(_) {} }, 900);

        if (res.txid) {
          try { showTxidDialog(res.txid, network); } catch(_) {}
        }

        try { refreshAll(); } catch(_) {}
      } else {
        const msg = humanSendErrorMessage(res);
        try { modal.setError(msg); } catch(_) {}
        try { if (resultEl) resultEl.textContent = msg; } catch(_) {}
      }
    }).catch((e) => {
      const msg = humanSendErrorMessage(e);
      try { modal.setError(msg); } catch(_) {}
      try { if (resultEl) resultEl.textContent = msg; } catch(_) {}
    }).finally(() => {
      if (sendBtn) sendBtn.disabled = false;
      sending = false;
    });
  }

  // ---------- Accept Offer ----------
  // Reserved for Module 4-KRC (Offer → Accept → Finalize via PSKT/PSKB).
  // Not active in the current build.
  async function startAcceptOffer(){
    try {
      if (resultEl) resultEl.textContent = 'Offer acceptance is not available in this build.';
    } catch(_) {}
  }

  // Expose entrypoint for future wiring (kept inert for now).
  if (typeof window !== 'undefined') {
    window.OMA_AcceptOffer = startAcceptOffer;
  }

  function buildSendContextKrc() {
    if (!lastHoldings || !lastHoldings.address) {
      console.warn('Swaps: no holdings/address available for send context');
      return null;
    }
    if (!tokenSel || !amtEl) {
      console.warn('Swaps: send form controls missing for send context');
      return null;
    }

    const addr   = String(lastHoldings.address || '').trim();
    const rawId  = String(tokenSel.value || '').trim();
    const rawAmt = String(amtEl.value || '').trim();
    const rawTo  = String((toEl && toEl.value) || '').trim();
    const selectedOption = tokenSel.options && tokenSel.selectedIndex >= 0 ? tokenSel.options[tokenSel.selectedIndex] : null;
    const assetName = selectedOption && selectedOption.dataset && typeof selectedOption.dataset.name === 'string'
      ? selectedOption.dataset.name.trim()
      : '';

    const isKas = !rawId || rawId === 'KAS';
    const isOmaL1SwapAsset = !isKas && isOmaL1SelectedAsset(rawId, selectedOption);
    const omaL1SwapMeta = isOmaL1SwapAsset ? omaL1SelectedMetaOrThrow(selectedOption) : null;

    const assetKind = isKas
      ? 'KAS'
      : (isOmaL1SwapAsset ? 'oma_l1_covenant_token' : 'KRC20');
    const assetId = isKas
      ? 'KAS'
      : (isOmaL1SwapAsset ? omaL1SwapMeta.assetCovenantId : rawId);
    const assetDisplayName = isOmaL1SwapAsset
      ? omaL1SwapMeta.tokenSymbol
      : assetName;

    const originKind = isKas
      ? 'KAS'
      : (isOmaL1SwapAsset ? 'OMA_L1' : 'KRC');

    const ctx = {
      originKind,
      address: addr,
      wid: activeWalletId || '',
      network: activeWalletNetwork || '',
      assetKind,
      assetId,
      assetName: assetDisplayName,
      amount: rawAmt
    };

    if (isOmaL1SwapAsset && omaL1SwapMeta) {
      ctx.assetSelectValue = rawId;
      ctx.assetCovenantId = omaL1SwapMeta.assetCovenantId;
      ctx.tokenSymbol = omaL1SwapMeta.tokenSymbol;
      ctx.amountRawAvailable = selectedOption && selectedOption.dataset ? String(selectedOption.dataset.amountRaw || '') : '';
      ctx.amountHumanAvailable = selectedOption && selectedOption.dataset ? String(selectedOption.dataset.amountHuman || '') : '';
      ctx.sourceSelection = selectedOption && selectedOption.dataset ? String(selectedOption.dataset.sourceSelection || 'automatic_backend') : 'automatic_backend';
      ctx.route = 'oma_l1_holder_transfer';
      ctx.swapContextKind = 'kcc20_direct_1e_wallet_preserve_oma_l1_swap_context_v1';
    }

    if (isWalletQrAddress(rawTo)) {
      ctx.takerTokenReceiveAddressSeed = rawTo;
    }

    return ctx;
  }
  
  const SWAPS_OFFER_CREATE_GATE_MSG = '';

  function applySwapsEntryGate(walletType){
    const btn = document.getElementById('btnSwaps');
    if (btn) {
      btn.removeAttribute('disabled');
      btn.title = '';
    }

    const nav = document.getElementById('navSwaps');
    if (nav) {
      nav.setAttribute('aria-disabled', 'false');
      nav.title = '';
    }

    return false;
  }

  function openWalletSwaps(){
    (async () => {
      if (!window.SwapsModal || typeof window.SwapsModal.open !== 'function') {
        console.warn('Swaps: SwapsModal not available');
        return;
      }

      let walletType = '';

      // Pull authoritative active wallet id from the server
      try {
        const st = await jget('/api/wallet/status');
        if (st && st.ok === true && st.wallet_id) {
          activeWalletId = String(st.wallet_id);
        } else {
          activeWalletId = '';
        }
        activeWalletNetwork = st && st.ok === true ? String(st.network || st.net || '').trim() : '';
        walletType = st && st.ok === true ? String(st.wallet_type || '').trim() : '';
      } catch (_) {
        activeWalletId = '';
        activeWalletNetwork = '';
        walletType = '';
      }

      if (applySwapsEntryGate(walletType)) {
        if (resultEl) resultEl.textContent = SWAPS_OFFER_CREATE_GATE_MSG;
        return;
      }

      const ctx = buildSendContextKrc();
      if (!ctx) {
        if (resultEl) resultEl.textContent = 'Unable to prepare swap from this wallet.';
        return;
      }
      if (!ctx.wid) {
        if (resultEl) resultEl.textContent = 'No active wallet detected. Select/activate a wallet, refresh, then open Swaps again.';
        return;
      }

      console.log('Swaps ctx from wallet.js:', ctx);
      window.SwapsModal.open(ctx);
    })().catch((e) => {
      const msg = (e && e.message) ? e.message : 'Unable to open Swaps';
      if (resultEl) resultEl.textContent = msg;
    });
  }
  
// ---------- Wire up ----------
if (keyfileFileEl) keyfileFileEl.addEventListener('change', () => { onKeyfileFileChange(); });

if (btnKeyfileExport) btnKeyfileExport.addEventListener('click', (e) => {
  e.preventDefault();
  exportKeyfile().catch((err) => setKeyfileStatus(`Export failed: ${String(err && err.message ? err.message : err)}`));
});

if (btnKeyfileUnlock) btnKeyfileUnlock.addEventListener('click', (e) => {
  e.preventDefault();
  unlockKeyfile().catch((err) => setKeyfileStatus(`Unlock failed: ${String(err && err.message ? err.message : err)}`));
});

if (btnKeyfileClear) btnKeyfileClear.addEventListener('click', (e) => {
  e.preventDefault();
  clearKeyfile();
});

if (btnChangePassphrase) btnChangePassphrase.addEventListener('click', (e) => {
  e.preventDefault();
  setChangePassStatus('—');
  changeKeyfilePassphrase().catch((err) => {
    setChangePassStatus(`Change failed: ${String(err && err.message ? err.message : err)}`);
  });
});

if (sendBtn) sendBtn.addEventListener('click', handleSendClick);

const swapsBtnEl = document.getElementById('btnSwaps');
if (swapsBtnEl) swapsBtnEl.addEventListener('click', (e) => {
  e.preventDefault();
  openWalletSwaps();
});

const navSwapsEl = document.getElementById('navSwaps');
if (navSwapsEl) navSwapsEl.addEventListener('click', (e) => {
  e.preventDefault();
  openWalletSwaps();
});

// Initial load
refreshAll();

// Swaps engine is implemented in Module 4-KRC (Offer → Accept → Finalize).
})();

// === [/APPEND] ===
