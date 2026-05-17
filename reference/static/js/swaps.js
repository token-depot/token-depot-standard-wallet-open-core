/*!
 * OMA Wallet — Swaps Modal (Create Offer v2)
 * Behavior-Lock: single path, no parallel send logic, server-mediation only.
 *
 * Canonical model:
 *   - Wallet pages own holdings, asset selection, amount, and the /api/wallet/send path.
 *   - Swaps modal is a thin overlay that:
 *       • Reads the current send context from the active wallet (asset + amount + from address).
 *       • Collects only the extra swap metadata: receive address, buy asset, TTL.
 *       • Talks to /api/offers/analyze for review, /api/swaps/offer for Direct offers,
 *         and /api/open-swaps/offer for Open Swap V2 offers.
 *       • Does not lock the wallet; swap lifecycle is Offer → Accept → Finalize via PSKT/PSKB.
 *
 * This file intentionally does NOT:
 *   - Rebuild a mini-wallet: no independent holdings fetch, no separate Sell dropdown, no Send path.
 *   - Override the wallet send logic or create a second completion path.
 */

(() => {
  // Public API
  window.SwapsModal = { open };

  // --------------- State ---------------
  const S = {
    originKind: 'KRC',        // 'KRC' or 'EVM' based on current page
    sendWallet: null,         // { kind:'KRC'|'EVM', wid, address }
    sendContext: null,        // { wid, address, assetKind, assetId, assetName, amount }
    form: {
      receiveAddress: '',
      takerTokenReceiveAddress: '',
      receiveSource: null,    // 'active' | 'external' | 'manual'
      complianceOnly: false,
      partialConsidered: false,
      partialMin: '',
      partialStep: '',
      buyAsset: 'KAS',
      buyAmount: '',
      ttlMode: 'hours',       // 'hours' | 'eod' | 'otc'
      ttlHours: 168
    },
    offerId: null,
    fillId: null,
    takeOffer: null
  };

  const path = (window.location && window.location.pathname) || '';
  if (path.includes('/evm')) {
    S.originKind = 'EVM';
  }

  // Singletons for async helpers
  let walletsPromise = null;
  let evmSendWalletPromise = null;

  // --------------- DOM helpers ---------------
  function $(id){ return document.getElementById(id); }
  const $$ = (q, r=document) => Array.from(r.querySelectorAll(q));
  function el(tag, attrs={}, ...kids){
    const n = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs||{})){
      if (k === 'onClick') n.addEventListener('click', v, {passive:true});
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids) n.append(k);
    return n;
  }
  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function getNetworkSharedOrNull(){
    try {
      const shared = window.CwNetworkShared;
      if (shared && typeof shared === 'object') return shared;
    } catch (_) {}
    return null;
  }
  function getNetworkMeta(raw){
    const shared = getNetworkSharedOrNull();
    if (!shared || typeof shared.getNetworkMeta !== 'function') return null;
    const meta = shared.getNetworkMeta(raw);
    if (!meta || typeof meta !== 'object') return null;
    return meta;
  }
  function getKaspaFamilyAddressMeta(addr){
    const value = String(addr || '').trim().toLowerCase();
    if (!value) return null;
    const mainMeta = getNetworkMeta('mainnet');
    if (mainMeta && typeof mainMeta.addressPrefix === 'string') {
      const mainPrefix = String(mainMeta.addressPrefix).trim().toLowerCase();
      if (mainPrefix && value.startsWith(mainPrefix)) return mainMeta;
    }
    const testMeta = getNetworkMeta('tn10');
    if (testMeta && typeof testMeta.addressPrefix === 'string') {
      const testPrefix = String(testMeta.addressPrefix).trim().toLowerCase();
      if (testPrefix && value.startsWith(testPrefix)) return testMeta;
    }
    return null;
  }
  function isKaspaFamilyAddress(addr){
    return !!getKaspaFamilyAddressMeta(addr);
  }
  async function postJSON(path, body){
    const r = await fetch(path, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body || {})
    });
    let out = null;
    try { out = await r.json(); } catch { out = { ok:false, reason:'invalid_json' }; }

    if (!r.ok) {
      const reason = out && out.reason ? String(out.reason) : ('http_'+r.status);
      const stage = out && out.stage ? String(out.stage) : '';
      const detail = out && out.error ? String(out.error) : '';
      const msg = [reason, stage ? `stage=${stage}` : '', detail ? detail : ''].filter(Boolean).join(' — ');

      const e = new Error(msg);
      e.code = r.status;
      e.reason = msg;
      e.stage = stage || null;
      e.detail = detail || null;
      throw e;
    }

    return out;
  }

  // --------------- Wallet discovery (single-path) ---------------

  async function loadActiveWalletOnce(){
    // Kaspa/KRC side: use /api/wallets for WID + address0
    if (
      S.sendWallet &&
      S.sendWallet.kind === 'KRC' &&
      S.sendWallet.wid &&
      S.sendWallet.address &&
      typeof S.sendWallet.wallet_type === 'string' &&
      S.sendWallet.wallet_type
    ) {
      return S.sendWallet;
    }
    if (!walletsPromise) {
      walletsPromise = (async () => {
        try {
          const r = await fetch('/api/wallets', { cache:'no-store' });
          if (!r.ok) return null;
          const j = await r.json().catch(() => null);
          if (!j) return null;

          const items = Array.isArray(j.items) ? j.items : [];
          const activeId = j.active_id || (items[0] && items[0].id) || null;
          if (!activeId) return null;

          const activeItem = items.find(it => it && it.id === activeId) || items[0];
          let wAddr = '';
          if (activeItem && typeof activeItem.address0 === 'string') {
            wAddr = activeItem.address0;
          }

          let wType = '';
          if (activeItem && typeof activeItem.wallet_type === 'string') {
            wType = activeItem.wallet_type;
          } else if (activeItem && typeof activeItem.walletType === 'string') {
            wType = activeItem.walletType;
          } else if (activeItem && typeof activeItem.type === 'string') {
            wType = activeItem.type;
          }

          let wNet = '';
          if (activeItem && typeof activeItem.network === 'string') {
            wNet = activeItem.network;
          }
          const walletNetworkMeta = getNetworkMeta(wNet);
          const expectedPrefix = walletNetworkMeta && typeof walletNetworkMeta.addressPrefix === 'string'
            ? String(walletNetworkMeta.addressPrefix).trim().toLowerCase()
            : '';

          if (!wAddr || !expectedPrefix || !String(wAddr).trim().toLowerCase().startsWith(expectedPrefix)) {
            return null;
          }

          S.sendWallet = { kind: 'KRC', wid: String(activeId), address: wAddr, wallet_type: wType, network: wNet };
          return S.sendWallet;
        } catch {
          return null;
        }
      })();
    }
    return walletsPromise;
  }

  const OFFER_CREATE_GATE_MSG = '';

  function setOfferCreateGateMsg(on){
    const elMsg = $('offerCreateGateMsg');
    if (!elMsg) return;
    elMsg.textContent = '';
  }

  async function enforceOfferCreateGate(){
    setOfferCreateGateMsg(false);
    return false;
  }

  async function loadActiveEvmWalletOnce(){
    // EVM side: use /api/evm/holdings to discover account + address
    if (S.sendWallet && S.sendWallet.kind === 'EVM' && S.sendWallet.wid && S.sendWallet.address) {
      return S.sendWallet;
    }
    if (!evmSendWalletPromise) {
      evmSendWalletPromise = (async () => {
        try {
          const chainSel = document.getElementById('evmChain');
          const chain = (chainSel && chainSel.value) || 'sepolia';
          const r = await fetch(`/api/evm/holdings?chain=${encodeURIComponent(chain)}`, { cache: 'no-store' });
          if (!r.ok) return null;
          const j = await r.json().catch(() => null);
          if (!j || j.ok === false) return null;
          const wid = (j.account && String(j.account)) || '';
          const addr = (j.address && String(j.address)) || '';
          if (!wid || !addr || !addr.startsWith('0x')) return null;
          S.sendWallet = { kind: 'EVM', wid, address: addr };
          return S.sendWallet;
        } catch {
          return null;
        }
      })();
    }
    return evmSendWalletPromise;
  }

  function readWalletSendContext(){
    // Read asset + amount from the wallet send form.
    const tokenSel = document.getElementById('tokenSelect');
    const amtEl    = document.getElementById('wAmt');
    const addrEl   = document.getElementById('wAddress');

    const assetRaw = tokenSel ? String(tokenSel.value || 'KAS').trim() : 'KAS';
    const amount   = amtEl ? String(amtEl.value || '').trim() : '';
    const fromAddr = addrEl ? String(addrEl.textContent || addrEl.value || '').trim() : '';
    const selectedOption = tokenSel && tokenSel.options && tokenSel.selectedIndex >= 0 ? tokenSel.options[tokenSel.selectedIndex] : null;
    const assetName = selectedOption && selectedOption.dataset && typeof selectedOption.dataset.name === 'string'
      ? selectedOption.dataset.name.trim()
      : '';

    let assetKind = 'KAS';
    let assetId   = assetRaw;
    if (S.originKind === 'KRC') {
      if (assetRaw.toUpperCase() === 'KAS') {
        assetKind = 'KAS';
      } else {
        assetKind = 'KRC20';
      }
    } else {
      // EVM page — we will explicitly block create-offer for now (see collectPayload),
      // but we still record what the wallet thinks it's sending.
      if (assetRaw.toUpperCase() === 'ETH') {
        assetKind = 'ETH';
      } else {
        assetKind = 'ERC20';
      }
    }

    return {
      wid: S.sendWallet ? S.sendWallet.wid : '',
      address: S.sendWallet ? S.sendWallet.address : fromAddr,
      assetKind,
      assetId,
      assetName,
      amount
    };
  }

  // --------------- Modal entrypoint ---------------
  function open(sendContext){
    console.log('Swaps open() got ctx:', sendContext);
    // Host
    let host = document.getElementById('swapsModalHost');
    if (!host) {
      host = el('div', { id:'swapsModalHost' });
      document.body.append(host);
    }

    host.innerHTML = '';

    // Modal
    const modal = el('div', { class:'omodal', role:'dialog', 'aria-modal':'true' });
    modal.innerHTML = `
      <div class="card">
        <header class="h">
          <div class="l">OMA Wallet — Swaps</div>
          <button id="swapsClose" class="secondary" type="button">Close</button>
        </header>

        <section id="step">
          <div class="grid two">
            <div>
              <h3>Create Offer</h3>
              <p class="note">
                Swaps uses your current wallet send settings (asset + amount).
                This modal only adds the receive address, payment method, and TTL.
              </p>
            </div>
            <div class="note">
              <div>From: <span id="makerFrom">(loading…)</span></div>
              <div>Asset: <span id="makerAsset">(loading…)</span></div>
            </div>
          </div>

          <hr>

          <div class="field-block">
            <label>Maker Receive Address</label>
            <div class="row" style="gap:.5rem;margin-top:.25rem">
              <input id="recvAddr" placeholder="Paste your KAS settlement address" autocomplete="off">
              <button id="btnRecvUseActive" type="button" class="secondary">Use this wallet's address</button>
            </div>
            <div id="recvHelp" class="note" style="margin-top:.25rem">
              Paste the Kaspa-family address where you want to receive KAS settlement.
            </div>
          </div>

          <div class="field-block">
            <label>Taker Token Receive Address (P2P)</label>
            <div class="row" style="gap:.5rem;margin-top:.25rem">
              <input id="takerRecvAddr" placeholder="Paste taker kaspa:… address to receive tokens" autocomplete="off">
            </div>
            <div class="note" style="margin-top:.25rem">
              Module 4a (P2P): Maker must embed the recipient address for the token transfer.
            </div>
          </div>

          <div class="field-block">
            <div class="row compliance-only-row" style="gap:.5rem;align-items:center">
              <input id="complianceOnly" type="checkbox" disabled>
              <span>Compliance Only</span>
            </div>
            <div class="note" style="margin-top:.25rem">
              Automatically determined after Analyze from the selected CA and the CN regulated-securities policy.
            </div>
          </div>

          <div class="field-block">
            <div class="trade-row">
              <div class="trade-col">
                <label for="buyAssetDisplay">Payment method</label>
                <div class="buy-row">
                  <input id="buyAssetDisplay" type="text" readonly autocomplete="off">
                  <input id="buyAsset" type="hidden" value="KAS">
                </div>
              </div>
              <div class="trade-col">
                <label for="buyAmount">Payment amount</label>
                <input id="buyAmount" type="text" inputmode="decimal" placeholder="How much payment you want to receive" autocomplete="off">
              </div>
              <div class="trade-col">
                <label>TTL</label>
                <div class="ttl-fields">
                  <select id="ttlMode">
                    <option value="hours" selected>Hours</option>
                    <option value="eod">End of Day</option>
                    <option value="otc">OTC (manual)</option>
                  </select>
                  <input id="ttlHours" type="number" min="1" max="168" step="1" value="168">
                </div>
              </div>
            </div>
            <div class="note" style="margin-top:.25rem">
              Enter 1 to 168 hours. OTC/manual offers are good until the 7-day maximum.
            </div>
          </div>

          <div id="swapSummaryPanel" class="panel" style="margin-top:1rem">
            <div><strong>Offer structure</strong></div>
            <div class="overflow-auto">
              <table id="swapSummaryTable" role="grid">
                <thead>
                  <tr>
                    <th style="width:160px">Role</th>
                    <th>Asset</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Offered asset</td>
                    <td id="summarySellAsset">—</td>
                    <td id="summarySellAmount">—</td>
                  </tr>
                  <tr>
                    <td>Settlement asset</td>
                    <td id="summaryBuyAsset">—</td>
                    <td id="summaryBuyAmount">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="row" style="margin-top:.75rem;gap:.5rem">
            <button id="btnAnalyze" class="half secondary" type="button">Analyze</button>

            <button id="btnBind" class="half contrast" type="button" disabled>Make Offer (Swap)</button>
          </div>

          <div id="offerCreateGateMsg" class="note" style="margin-top:.5rem"></div>

          <div id="results" style="margin-top:.75rem"></div>

          <section id="analyzerPanel" class="analyzer-panel" style="margin-top:1rem">
            <div id="analyzerSummary" class="analyzer-summary"></div>
            <div id="analyzerHints" class="analyzer-hints note"></div>

          <!-- Legacy 3-row Analyzer value table removed; Ask/Bid summary table above the toolbar is now the primary view. -->

            <div id="analyzerStatusRow" class="analyzer-status-row">
              <div id="analyzerStatusBadge" class="analyzer-status-badge"></div>
              <div id="analyzerBlockers" class="analyzer-blockers"></div>
              <div id="analyzerNotes" class="analyzer-notes note"></div>
            </div>

            <div id="assetMetaPanel" class="analyzer-meta-panel" style="margin-top:.75rem">
              <div class="row" style="gap:.75rem;align-items:flex-start">
                <div style="flex:1">
                  <strong id="assetMetaSellHeader">Offered asset</strong>
                  <div><small>Ticker:</small> <span id="assetMetaSellTicker">—</span></div>
                  <div><small>Name:</small> <span id="assetMetaSellName">—</span></div>
                  <div><small>Type:</small> <span id="assetMetaSellType">—</span></div>
                  <div><small>Decimals:</small> <span id="assetMetaSellDecimals">—</span></div>
                  <div><small>Contract address:</small> <span id="assetMetaSellContractAddress">—</span></div>
                  <div><small>Total minted:</small> <span id="assetMetaSellTotalMinted">—</span></div>
                  <div><small>Max supply:</small> <span id="assetMetaSellMaxSupply">—</span></div>
                  <div><small>Holders:</small> <span id="assetMetaSellHolders">—</span></div>
                  <div><small>Transfers:</small> <span id="assetMetaSellTransfers">—</span></div>
                  <div><small>Mints:</small> <span id="assetMetaSellMints">—</span></div>
                </div>
                <div style="flex:1">
                  <strong id="assetMetaBuyHeader">Settlement asset</strong>
                  <div><small>Ticker:</small> <span id="assetMetaBuyTicker">—</span></div>
                  <div><small>Name:</small> <span id="assetMetaBuyName">—</span></div>
                  <div><small>Type:</small> <span id="assetMetaBuyType">—</span></div>
                  <div><small>Decimals:</small> <span id="assetMetaBuyDecimals">—</span></div>
                </div>
              </div>
            </div>
          </section>
        </section>
      </div>
    `;

    host.append(modal);

    // Wire close/cancel
    document.getElementById('swapsClose')?.addEventListener('click', () => { host.innerHTML = ''; }, {passive:true});
    
    // After (CB-4A — Swaps form event wiring, fixed to use bare ids)
    // After (CB-6A — form wiring + reset + buy-amount handler hook)
    // Wire form events
    $('recvAddr')?.addEventListener('input', onRecvChange, {passive:true});
    $('takerRecvAddr')?.addEventListener('input', onTakerRecvChange, {passive:true});
    $('btnRecvUseActive')?.addEventListener('click', onRecvUseActive, {passive:true});
    $('partialToggle')?.addEventListener('change', onPartialToggle, {passive:true});
    $('partialMin')?.addEventListener('input', onPartialMinChange, {passive:true});
    $('partialStep')?.addEventListener('input', onPartialStepChange, {passive:true});
    $('buyAmount')?.addEventListener('input', onBuyAmountChange, {passive:true});
    $('ttlMode')?.addEventListener('change', onTtlModeChange, {passive:true});
    $('ttlHours')?.addEventListener('input', onTtlHoursChange, {passive:true});

    $('btnAnalyze')?.addEventListener('click', () => { onAnalyze().catch(() => {}); }, {passive:true});
    $('btnBind')?.addEventListener('click', () => { onBind().catch(() => {}); }, {passive:true});

    // Reset state
    S.form.receiveAddress = '';
    S.form.takerTokenReceiveAddress = '';
    S.form.receiveSource = null;
    setComplianceOnlyDerived(false);
    S.form.partialConsidered = false;
    S.form.partialMin = '';
    S.form.partialStep = '';
    S.form.buyAsset = 'KAS';
    S.form.buyAmount = '';
    S.form.ttlMode = 'hours';
    S.form.ttlHours = 168;
    S.offerId = null;
    S.fillId = null;
    S.takeOffer = null;

    if ($('recvAddr')) $('recvAddr').value = '';
    if ($('takerRecvAddr')) $('takerRecvAddr').value = '';
    if ($('buyAmount')) $('buyAmount').value = '';
    if ($('partialToggle')) $('partialToggle').checked = false;
    if ($('partialMin')) $('partialMin').value = '';
    if ($('partialStep')) $('partialStep').value = '';
    if ($('ttlMode')) $('ttlMode').value = 'hours';
    if ($('ttlHours')) $('ttlHours').value = '168';
    syncPaymentMethodUi();
    if ($('addrRules')) $('addrRules').innerHTML = '';
    if ($('results')) $('results').textContent = '';
    $('btnBind')?.setAttribute('disabled','');

    syncPartialControlsDisabled();

    // Async hydrate from wallet-provided send context
    (async () => {
      try {
        const widSpan  = $('widActive');
        const fromSpan = $('makerFrom');
        const assetSpan = $('makerAsset');

        console.log('Swaps spans before:',
          {
            widSpan,
            widText: widSpan && widSpan.textContent,
            fromSpan,
            fromText: fromSpan && fromSpan.textContent,
            assetSpan,
            assetText: assetSpan && assetSpan.textContent,
            widCount: document.querySelectorAll('widActive').length,
            fromCount: document.querySelectorAll('makerFrom').length,
            assetCount: document.querySelectorAll('makerAsset').length
          }
        );

        const ctx = (typeof sendContext === 'object' && sendContext) ? sendContext : null;
        console.log('Swaps hydrate ctx:', ctx);

        await enforceOfferCreateGate();

        if (!ctx || !ctx.address || !ctx.assetId || !ctx.amount) {
          if (widSpan) widSpan.textContent = '(no context)';
          if (fromSpan) fromSpan.textContent = '';
          if (assetSpan) assetSpan.textContent = '';
          const res = $('results');
          if (res) {
            res.textContent = 'Swaps requires a send context from the wallet. Close Swaps and open it from the wallet page after selecting an asset and amount.';
          }
          $('btnAnalyze')?.setAttribute('disabled','');
          $('btnBind')?.setAttribute('disabled','');
          console.log('Swaps spans after invalid ctx:',
            {
              widText: widSpan && widSpan.textContent,
              fromText: fromSpan && fromSpan.textContent,
              assetText: assetSpan && assetSpan.textContent
            }
          );
          return;
        }

        const originKind = (ctx.originKind === 'EVM') ? 'EVM' : 'KRC';
        S.originKind = originKind;
        S.sendContext = {
          originKind,
          wid: ctx.wid || '',
          network: ctx.network || '',
          address: ctx.address,
          assetKind: ctx.assetKind || '',
          assetId: ctx.assetId || '',
          assetName: typeof ctx.assetName === 'string' ? ctx.assetName.trim() : '',
          amount: ctx.amount || ''
        };
        S.sendWallet = {
          kind: originKind === 'EVM' ? 'EVM' : 'KRC',
          wid: S.sendContext.wid,
          network: S.sendContext.network,
          address: S.sendContext.address
        };

        const takerSeed = String(ctx.takerTokenReceiveAddressSeed || '').trim();
        const takerRecvInput = $('takerRecvAddr');
        if (
          takerSeed &&
          isKaspaFamilyAddress(takerSeed) &&
          takerRecvInput &&
          !takerRecvInput.value
        ) {
          takerRecvInput.value = takerSeed;
          S.form.takerTokenReceiveAddress = takerSeed;
        }

        // EVM Swaps are still blocked for now (Analyzer/send path not extended yet)
        if (S.originKind === 'EVM') {
          if (widSpan) widSpan.textContent = '(EVM not yet supported)';
          if (fromSpan) fromSpan.textContent = '';
          if (assetSpan) assetSpan.textContent = '';
          const res = $('results');
          if (res) {
            res.textContent = 'Creating swap offers from the EVM wallet is not yet supported. Use the Kaspa wallet to create offers.';
          }
          $('btnAnalyze')?.setAttribute('disabled','');
          $('btnBind')?.setAttribute('disabled','');
          return;
        }

        // Header: show only From + Asset (no WID row in the UI anymore)
        if (fromSpan) fromSpan.textContent = S.sendContext.address;
        if (assetSpan) {
          const amt = S.sendContext.amount || '';
          const assetId = S.sendContext.assetId || (S.sendContext.assetKind || '');
          const assetName = S.sendContext.assetName || '';
          const assetLabel = assetName && /^CA:/i.test(String(assetId)) ? assetName + ' ' + assetId : assetId;
          assetSpan.textContent = (amt ? (amt + ' ') : '') + assetLabel;
        }

        // Auto-fill Maker Receive Address with this wallet's address by default
        const recvInput = $('recvAddr');
        if (recvInput && !recvInput.value && S.sendContext.address) {
          recvInput.value = S.sendContext.address;
          S.form.receiveAddress = S.sendContext.address;
          S.form.receiveSource = 'active';
        }

        console.log('Swaps spans after set:', {
          widText: widSpan && widSpan.textContent,
          fromText: fromSpan && fromSpan.textContent,
          assetText: assetSpan && assetSpan.textContent
        });

        applyLocalHints();
      } catch (e) {
        console.warn('SwapsModal hydrate error', e);
        const res = $('results');
        if (res) res.textContent = 'Unable to read wallet send context. Close Swaps and reload the wallet page.';
        $('btnAnalyze')?.setAttribute('disabled','');
        $('btnBind')?.setAttribute('disabled','');
      }
    })();
  }

  // --------------- Form handlers ---------------

  function onRecvChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.receiveAddress = v;
    // Track whether this matches the active wallet
    if (S.sendContext && v && v === S.sendContext.address) {
      S.form.receiveSource = 'active';
    } else if (v) {
      S.form.receiveSource = 'manual';
    } else {
      S.form.receiveSource = null;
    }
    applyLocalHints();
  }

  function onRecvUseActive(){
    if (!S.sendContext || !S.sendContext.address) return;
    const addr = S.sendContext.address;
    const inp = $('recvAddr');
    if (inp) {
      inp.value = addr;
      S.form.receiveAddress = addr;
      S.form.receiveSource = 'active';
      inp.dispatchEvent(new Event('input', { bubbles:true }));
    } else {
      S.form.receiveAddress = addr;
      S.form.receiveSource = 'active';
    }
    applyLocalHints();
  }

  function onTakerRecvChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.takerTokenReceiveAddress = v;
  }

  function setComplianceOnlyDerived(value){
    const checked = !!value;
    S.form.complianceOnly = checked;
    if ($('complianceOnly')) $('complianceOnly').checked = checked;
  }

  function onPartialToggle(ev){
    const checked = !!(ev && ev.target && ev.target.checked);
    S.form.partialConsidered = checked;
    syncPartialControlsDisabled();
    applyLocalHints();
  }

  function onPartialMinChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.partialMin = v;
  }

  function onPartialStepChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.partialStep = v;
  }

  function syncPartialControlsDisabled(){
    const enabled = !!S.form.partialConsidered;
    const minInput = $('partialMin');
    const stepInput = $('partialStep');
    if (minInput) {
      if (enabled) minInput.removeAttribute('disabled');
      else minInput.setAttribute('disabled','');
    }
    if (stepInput) {
      if (enabled) stepInput.removeAttribute('disabled');
      else stepInput.setAttribute('disabled','');
    }
  }

  // After (CB-6A — buy-asset + buy-amount change handlers)

  function onBuyChange(){
    S.form.buyAsset = 'KAS';
    syncPaymentMethodUi();
  }

  function onBuyAmountChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.buyAmount = v;
    applyLocalHints();
  }

  function onTtlModeChange(ev){
    const v = String(ev && ev.target && ev.target.value || 'hours');
    S.form.ttlMode = (v === 'eod' || v === 'otc') ? v : 'hours';
    const hoursInput = $('ttlHours');
    if (!hoursInput) return;
    if (S.form.ttlMode === 'hours') {
      hoursInput.removeAttribute('disabled');
    } else {
      hoursInput.setAttribute('disabled','');
    }
  }

  function onTtlHoursChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) {
      S.form.ttlHours = n;
    }
  }

  // --------------- Local hints & chain rules ---------------

  function classifyReceiveAddress(addr){
    const v = String(addr || '').trim();
    if (!v) return null;
    if (v.startsWith('kaspa:')) return 'KASPA';
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) return 'EVM';
    return 'UNKNOWN';
  }

  function classifyBuyAsset(raw){
    const v = String(raw || '').trim();
    if (!v) return null;
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) return 'ERC20';
    const up = v.toUpperCase();
    if (up === 'ETH') return 'ETH';
    if (up === 'KAS') return 'KAS';
    if (/^CA:/.test(up)) return 'KRC';
    if (/^[A-Z0-9]{2,16}$/.test(up)) return 'KRC';
    return 'UNKNOWN';
  }

  function paymentMethodDisplayLabel(){
    return 'KAS';
  }

  function syncPaymentMethodUi(){
    S.form.buyAsset = 'KAS';
    const hidden = $('buyAsset');
    if (hidden) hidden.value = 'KAS';
    const display = $('buyAssetDisplay');
    if (display) display.value = paymentMethodDisplayLabel();
  }

  function applyLocalHints(){
    syncPaymentMethodUi();
  }

  // --------------- Payload builder ---------------

function collectPayload(){
    if (!S.sendContext || !S.sendContext.address) {
      const err = new Error('missing_send_context');
      err.code = 'missing_send_context';
      err.reason = 'Wallet send context not detected. Close Swaps and re-open.';
      throw err;
    }
    if (!S.sendContext.wid) {
      const err = new Error('missing_wallet_id');
      err.code = 'missing_wallet_id';
      err.reason = 'Active wallet ID not detected. Select an active wallet, then close and re-open Swaps.';
      throw err;
    }

    if (S.originKind === 'EVM') {
      const err = new Error('evm_not_supported');
      err.reason = 'Creating swap offers from the EVM wallet is not yet supported. Use the Kaspa wallet to create offers.';
      throw err;
    }

    // After (in collectPayload, with Buy Amount validation added)

    const amount = String(S.sendContext.amount || '').trim();
    if (!amount) {
      const err = new Error('no_amount');
      err.reason = 'Set an Amount in the wallet send form before creating a swap offer.';
      throw err;
    }

    // PAYMENT amount from modal
    const buyAmountRaw = String(S.form.buyAmount || '').trim();
    if (!buyAmountRaw) {
      const err = new Error('no_buy_amount');
      err.reason = 'Enter the payment amount you want to receive.';
      throw err;
    }

    const buyAmountStr0 = buyAmountRaw.startsWith('.') ? ('0' + buyAmountRaw) : buyAmountRaw;
    const buyAmountStr = buyAmountStr0.endsWith('.') ? buyAmountStr0.slice(0, -1) : buyAmountStr0;

    if (!/^\d+(\.\d+)?$/.test(buyAmountStr)) {
      const err = new Error('invalid_buy_amount');
      err.reason = 'Payment amount must be a valid KAS amount (no scientific notation).';
      throw err;
    }

    const parts = buyAmountStr.split('.');
    const frac = (parts.length > 1 ? (parts[1] || '') : '');
    if (frac.length > 8) {
      const err = new Error('invalid_buy_amount');
      err.reason = 'Payment amount may have at most 8 decimal places.';
      throw err;
    }

    const nonZero = buyAmountStr.replace('.', '').replace(/^0+/, '');
    if (!nonZero) {
      const err = new Error('invalid_buy_amount');
      err.reason = 'Payment amount must be greater than zero.';
      throw err;
    }

    const wholeKasPart = String(parts[0] || '').replace(/^0+/, '');
    if (!wholeKasPart) {
      const err = new Error('kas_ask_below_minimum');
      err.reason = 'Minimum KAS ask price is 1 KAS for swap offers.';
      throw err;
    }

    // SELL from wallet token selector (KAS/KRC-only for now)
    const tokenSel = document.getElementById('tokenSelect');
    const assetRaw = tokenSel ? String(tokenSel.value || 'KAS').trim() : 'KAS';
    let sellType = 'KAS';
    let sellSymbol = 'KAS';
    if (assetRaw.toUpperCase() === 'KAS') {
      sellType = 'KAS';
      sellSymbol = 'KAS';
    } else {
      sellType = 'KRC20';
      sellSymbol = assetRaw.toUpperCase();
    }
    const sell = { type: sellType, symbol: sellSymbol };
    const sellName = S.sendContext && typeof S.sendContext.assetName === 'string'
      ? S.sendContext.assetName.trim()
      : '';
    if (sellName && /^CA:/i.test(sellSymbol)) {
      sell.name = sellName;
    }

    // PAYMENT method is fixed to KAS internally. Display is normalized to KAS for all Kaspa-family networks.
    S.form.buyAsset = 'KAS';
    const buyRaw = 'KAS';
    const buy = { type:'KAS', symbol:'KAS' };

    // Receive endpoint
    const recvRaw = String(S.form.receiveAddress || '').trim();
    if (!recvRaw) {
      const err = new Error('no_receive');
      err.reason = 'Paste a receive address to continue.';
      throw err;
    }
    const addrKind = classifyReceiveAddress(recvRaw);
    const buyKind = classifyBuyAsset(buyRaw);

    // Chain-rule enforcement (local)
    if (addrKind === 'KASPA' && (buyKind === 'ETH' || buyKind === 'ERC20')) {
      const err = new Error('addr_asset_mismatch');
      err.reason = 'Receive address is kaspa:…, but the payment method looks like ETH/ERC-20. Use a 0x… address for ETH/ERC-20.';
      throw err;
    }
    if ((buyKind === 'ETH' || buyKind === 'ERC20') && addrKind && addrKind !== 'EVM') {
      const err = new Error('addr_requires_0x');
      err.reason = 'ETH/ERC-20 payment method requires a 0x… receive address.';
      throw err;
    }
    if (addrKind === 'EVM' && (buyKind === 'KAS' || buyKind === 'KRC')) {
      const err = new Error('addr_asset_mismatch_kas');
      err.reason = 'Receive address is 0x…, but the payment method is KAS/TKAS. Use a kaspa:… address.';
      throw err;
    }

    let receiveChainKind = 'KASPA';
    let receiveChainId = 0;
    if (addrKind === 'EVM') {
      receiveChainKind = 'EVM';
      receiveChainId = 1;
    }

    const receiveEndpoint = {
      chain_kind: receiveChainKind,
      chain_id: receiveChainId,
      address: recvRaw
    };
    const source = S.form.receiveSource || (recvRaw === S.sendContext.address ? 'active' : 'external');
    if (source) receiveEndpoint.source = source;
    if (source === 'active' && S.sendContext.wid) {
      receiveEndpoint.wid = S.sendContext.wid;
    }

    // Partial policy
    const partial = { enabled: !!S.form.partialConsidered };
    if (partial.enabled) {
      const minRaw = String(S.form.partialMin || '').trim();
      if (minRaw) {
        const minNum = Number(minRaw);
        if (Number.isFinite(minNum) && minNum > 0) {
          partial.min = minRaw;
        }
      }
      const stepRaw = String(S.form.partialStep || '').trim();
      if (stepRaw) {
        const stepNum = Number(stepRaw);
        if (Number.isFinite(stepNum) && stepNum > 0) {
          partial.step = stepRaw;
        }
      }
    }

    // TTL → seconds for analyzer
    let ttlSeconds = 0;
    if (S.form.ttlMode === 'eod') {
      const now = new Date();
      const end = new Date(now);
      end.setHours(23, 59, 0, 0);
      let diff = Math.floor((end.getTime() - now.getTime()) / 1000);
      if (!Number.isFinite(diff) || diff <= 0) diff = 60;
      if (diff > 168*60*60) diff = 168*60*60;
      ttlSeconds = diff;
    } else if (S.form.ttlMode === 'otc') {
      // For OTC/manual offers, cap at 7 days for now so posted offers remain visible longer.
      ttlSeconds = 168*60*60;
    } else {
      const h = Number(S.form.ttlHours || 0);
      const hours = (Number.isFinite(h) && h > 0) ? h : 4;
      ttlSeconds = Math.round(hours * 60 * 60);
    }

    // After (return object with explicit sell_amount & buy_amount)
    return {
      sell,
      buy,
      amount,
      sell_amount: amount,
      buy_amount: buyAmountRaw,
      complianceOnly: !!S.form.complianceOnly,
      partial,
      ttl: ttlSeconds,
      maker: {
        wid: S.sendContext.wid,
        originKind: S.originKind,
        fromAddr: S.sendContext.address
      },
      receiveEndpoint
    };
  }

  // --------------- Analyze / Bind (Make Offer) ---------------

  function describeBlocker(code){
    const c = String(code || '').toLowerCase();
    switch (c) {
      case 'invalid_json': return 'Malformed request sent to analyzer.';
      case 'invalid_amount': return 'Amount must be a valid number.';
      case 'amount_must_be_positive': return 'Amount must be greater than zero.';
      case 'sell_type_invalid': return 'Sell asset type is invalid (server expects KAS or KRC-20 for now).';
      case 'sell_asset_invalid': return 'Sell asset is not a known KRC-20 ticker or CA.';
      case 'buy_chain_missing': return 'ERC-20 payment method is missing a chainId.';
      case 'buy_asset_invalid': return 'Payment method must be KAS for this flow.';
      case 'partial_min_fill_required':
      case 'partial_step_size_required':
      case 'partial_min_exceeds_amount':
      case 'partial_fields_invalid':
        return 'Offer settings are invalid for this flow.';
      case 'ttl_out_of_range': return 'TTL must be between 1 hour and 7 days (168 hours).';
      case 'ttl_invalid': return 'TTL is invalid.';
      default:
        return code || 'Unknown blocker';
    }
  }

  function getSwapAnalyzerSharedOrThrow(){
    const shared = window.SwapAnalyzerShared;
    if (!shared || typeof shared.renderAnalyzer !== 'function' || typeof shared.clearAnalyzer !== 'function') {
      throw new Error('swap_analyzer_shared_unavailable');
    }
    return shared;
  }

  function getAnalyzerRefs(){
    return {
      panel: $('analyzerPanel'),
      summary: $('analyzerSummary'),
      hints: $('analyzerHints'),
      statusBadge: $('analyzerStatusBadge'),
      blockers: $('analyzerBlockers'),
      notes: $('analyzerNotes'),
      summarySellAsset: $('summarySellAsset'),
      summarySellAmount: $('summarySellAmount'),
      summaryBuyAsset: $('summaryBuyAsset'),
      summaryBuyAmount: $('summaryBuyAmount'),
      sellMeta: {
        header: $('assetMetaSellHeader'),
        ticker: $('assetMetaSellTicker'),
        name: $('assetMetaSellName'),
        type: $('assetMetaSellType'),
        decimals: $('assetMetaSellDecimals'),
        contractAddress: $('assetMetaSellContractAddress'),
        totalMinted: $('assetMetaSellTotalMinted'),
        maxSupply: $('assetMetaSellMaxSupply'),
        holders: $('assetMetaSellHolders'),
        transfers: $('assetMetaSellTransfers'),
        mints: $('assetMetaSellMints'),
        explorerLink: $('assetMetaSellExplorerLink')
      },
      buyMeta: {
        header: $('assetMetaBuyHeader'),
        ticker: $('assetMetaBuyTicker'),
        name: $('assetMetaBuyName'),
        type: $('assetMetaBuyType'),
        decimals: $('assetMetaBuyDecimals'),
        contractAddress: $('assetMetaBuyContractAddress'),
        totalMinted: $('assetMetaBuyTotalMinted'),
        maxSupply: $('assetMetaBuyMaxSupply'),
        holders: $('assetMetaBuyHolders'),
        transfers: $('assetMetaBuyTransfers'),
        mints: $('assetMetaBuyMints'),
        explorerLink: $('assetMetaBuyExplorerLink')
      }
    };
  }

  function renderAnalyzerPanel(out, payload, blockers, notes){
    const refs = getAnalyzerRefs();
    if (!refs.panel) return;

    const shared = getSwapAnalyzerSharedOrThrow();

    if (!out) {
      shared.clearAnalyzer(refs);
      return;
    }

    const fromAddr = S.sendContext && S.sendContext.address
      ? String(S.sendContext.address)
      : '';

    shared.renderAnalyzer({
      refs,
      out,
      payload,
      blockers,
      notes,
      paymentDisplayLabel: paymentMethodDisplayLabel(),
      fromAddress: fromAddr
    });
  }

  async function onAnalyze(){
    const r = $('results');
    if (r) r.textContent = 'Analyzing…';
    let payload;
    try {
      payload = collectPayload();
    } catch (e) {
      const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : 'Form is incomplete.';
      if (r) r.textContent = msg;
      $('btnBind')?.setAttribute('disabled','');
      renderAnalyzerPanel(null, null, [], []);
      return;
    }

    try {
      const out = await postJSON('/api/offers/analyze', payload);
      const blockers = Array.isArray(out?.blockers) ? out.blockers : [];
      const notes    = Array.isArray(out?.notes)    ? out.notes    : [];

      setComplianceOnlyDerived(!!out?.complianceOnlyDerived);
      renderAnalyzerPanel(out, payload, blockers, notes);

      if (r) {
        const blist = blockers.map((b) => {
          const raw = String(b || '');
          const human = describeBlocker(raw);
          return `<li>${escapeHtml(human)}</li>`;
        }).join('');
        const nlist = notes.map(n => `<li>${escapeHtml(String(n||''))}</li>`).join('');
        r.innerHTML = [
          '<div class="panel">',
            `<div><strong>Analyze</strong> ${out?.ok === false ? '(failed)' : ''}</div>`,
            blockers.length ? `<div style="color:#b91c1c;margin-top:6px"><strong>Blockers:</strong><ul>${blist}</ul></div>`
                            : '<div style="color:#059669;margin-top:6px"><strong>No blockers.</strong></div>',
            notes.length ? `<div style="opacity:.8;margin-top:6px"><strong>Notes:</strong><ul>${nlist}</ul></div>` : '',
          '</div>'
        ].join('');
      }

      const sellSym = String(payload?.sell?.symbol || '').trim();
      const isTick = !!sellSym && !/^CA:/i.test(sellSym);
      const onlySellAssetInvalid =
        blockers.length === 1 && String(blockers[0] || '').toLowerCase() === 'sell_asset_invalid';

      const canSwapOfferNow =
        (out?.ok !== false) &&
        ((blockers.length === 0) || (isTick && onlySellAssetInvalid));

      if (canSwapOfferNow) {
        $('btnBind')?.removeAttribute('disabled');
      } else {
        $('btnBind')?.setAttribute('disabled','');
      }

      await enforceOfferCreateGate();
    } catch (e) {
      if (e && e.code === 404) {
        if (r) r.textContent = 'Analyzer not available (server pending).';
        $('btnBind')?.setAttribute('disabled','');
        renderAnalyzerPanel(null, payload, [], []);
        return;
      }
      const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : 'Analyze failed.';
      if (r) r.textContent = 'Analyze failed: ' + msg;
      $('btnBind')?.setAttribute('disabled','');
      renderAnalyzerPanel(null, payload, [], []);
    }
  }

  async function onBind(){
    const r = $('results');

    if (await enforceOfferCreateGate()) {
      if (r) r.textContent = OFFER_CREATE_GATE_MSG;
      return;
    }

    let payload;
    try {
      payload = collectPayload();
    } catch (e) {
      const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : 'Form is incomplete.';
      if (r) r.textContent = msg;
      return;
    }

    if (!window.CW_showConfirm || typeof window.CW_showConfirm !== 'function') {
      if (r) r.textContent = 'Make Offer failed: confirm_modal_unavailable';
      return;
    }

    const recv = (payload.receiveEndpoint && payload.receiveEndpoint.address)
      ? String(payload.receiveEndpoint.address).trim()
      : '';

    const networkMeta = getNetworkMeta(S.sendWallet && S.sendWallet.network ? S.sendWallet.network : '');
    if (!networkMeta || !networkMeta.kasplexNetworkId || !networkMeta.addressPrefix) {
      if (r) r.textContent = 'Make Offer failed: unsupported_wallet_network';
      return;
    }
    const network = String(networkMeta.kasplexNetworkId).trim();
    const expectedPrefix = String(networkMeta.addressPrefix).trim().toLowerCase();

    const sellSym = String(payload?.sell?.symbol || '').trim();
    if (!sellSym) {
      if (r) r.textContent = 'Make Offer failed: missing_sell_asset';
      return;
    }

    const kind = /^CA:/i.test(sellSym) ? 'ca_to_kas' : 'tick_to_kas';
    const tokenId = kind === 'ca_to_kas' ? sellSym.trim() : sellSym.trim().toUpperCase();

    const buyType = String(payload?.buy?.type || '').trim().toUpperCase();
    const buySym  = String(payload?.buy?.symbol || '').trim().toUpperCase();
    if (buyType !== 'KAS' || buySym !== 'KAS') {
      if (r) r.textContent = 'Make Offer failed: requires Payment method = KAS';
      return;
    }

    if (!recv || String(recv).trim().toLowerCase().indexOf(expectedPrefix) !== 0) {
      if (r) r.textContent = 'Make Offer failed: maker_receive_address_invalid';
      return;
    }

    const takerAddr = String(S.form.takerTokenReceiveAddress || '').trim();
    if (takerAddr && String(takerAddr).trim().toLowerCase().indexOf(expectedPrefix) !== 0) {
      if (r) r.textContent = 'Make Offer failed: taker_token_receive_address_invalid';
      return;
    }

    // This is a signing operation (swap offer); requires unlocked keyfile session
    const cfm = await window.CW_showConfirm({
      to: recv || '—',
      amount: String(payload.buy_amount || '').trim() || '—',
      ticker: String(sellSym || 'Swap'),
      network,
      confirmLabel: takerAddr ? 'Create Offer' : 'Create Open Offer',
      cancelLabel: 'Cancel',
      sendingText: takerAddr ? 'Creating offer…' : 'Creating open offer…'
    });

    if (!cfm || !cfm.ok) {
      if (r) r.textContent = 'Cancelled.';
      return;
    }

    const KEYRING_SESSION_KEY = 'cw_keyring_session';
    const ksTxt = sessionStorage.getItem(KEYRING_SESSION_KEY) || '';
    let keyring = null;
    try { keyring = ksTxt ? JSON.parse(ksTxt) : null; } catch (_) { keyring = null; }

    const unlockWalletMsg = 'Unlock active wallet in the Wallet tab first (same browser tab).';
    const priv0Hex = keyring && typeof keyring.priv0_hex === 'string' ? String(keyring.priv0_hex).trim() : '';
    if (!priv0Hex) {
      try { cfm.setError(unlockWalletMsg); } catch (_) {}
      if (r) r.textContent = unlockWalletMsg;
      return;
    }

    const activeWallet = await loadActiveWalletOnce();
    const activeWalletId = activeWallet && typeof activeWallet.wid === 'string' ? String(activeWallet.wid).trim() : '';
    const activeWalletAddress = activeWallet && typeof activeWallet.address === 'string' ? String(activeWallet.address).trim() : '';
    const sessWalletId = keyring && typeof keyring.wallet_id === 'string' ? String(keyring.wallet_id).trim() : '';
    const sessAddress0 = keyring && typeof keyring.address0 === 'string' ? String(keyring.address0).trim() : '';

    if (!activeWalletId || !activeWalletAddress) {
      try { cfm.setError('Select an active wallet first.'); } catch (_) {}
      if (r) r.textContent = 'Select an active wallet first.';
      return;
    }

    if (!sessWalletId || !sessAddress0 || sessWalletId !== activeWalletId || sessAddress0 !== activeWalletAddress) {
      try { cfm.setError(unlockWalletMsg); } catch (_) {}
      if (r) r.textContent = unlockWalletMsg;
      return;
    }

    const priv0 = new kaspa.PrivateKey(priv0Hex);

    const req = {
      kind,
      tokenId,
      amt: String(payload.sell_amount || '').trim(),
      priceKas: String(payload.buy_amount || '').trim(),
      makerReceiveAddress: recv,
      takerTokenReceiveAddress: takerAddr,
      tokenName: payload.sell && typeof payload.sell.name === 'string' ? payload.sell.name.trim() : '',
      complianceOnly: !!payload.complianceOnly,
      expiry: (typeof payload.ttl === 'number' ? payload.ttl : 0) || 0,
    };

    const isOpenOffer = !takerAddr;
    if (r) r.textContent = isOpenOffer ? 'Creating open offer…' : 'Making swap offer…';

    try {
      if (isOpenOffer) {
        if (!window.openSwapV2 || typeof window.openSwapV2.prepare !== 'function') {
          throw new Error('open_swap_v2_prepare_unavailable');
        }

        const openReq = {
          sell: payload.sell,
          buy: payload.buy,
          sell_amount: String(payload.sell_amount || '').trim(),
          buy_amount: String(payload.buy_amount || '').trim(),
          complianceOnly: !!payload.complianceOnly,
          ttl: (typeof payload.ttl === 'number' ? payload.ttl : 0) || 0,
          partial: { enabled: false }
        };

        const openPrep = await window.openSwapV2.prepare(openReq);
        if (!openPrep || openPrep.ok === false) {
          const reason = openPrep && openPrep.reason ? String(openPrep.reason) : 'open_swap_prepare_failed';
          const detail = openPrep && openPrep.error ? String(openPrep.error).trim() : '';
          const blockerList = Array.isArray(openPrep && openPrep.blockers) ? openPrep.blockers.map(function (x) { return String(x); }) : [];
          const blockers = blockerList.length ? ' — blockers=' + blockerList.join(',') : '';

          if (reason === 'missing_keyring_session' || blockerList.indexOf('missing_keyring_session') >= 0) {
            throw new Error(unlockWalletMsg);
          }

          if (reason === 'active_wallet_missing' || blockerList.indexOf('active_wallet_missing') >= 0) {
            throw new Error('Select an active wallet first.');
          }

          if (reason === 'open_swap_offer_failed' && detail) {
            const detailLc = detail.toLowerCase();
            if (detailLc.indexOf('missing_keyring_session') >= 0 || detailLc.indexOf('unlock') >= 0 || detailLc.indexOf('keyring') >= 0) {
              throw new Error(unlockWalletMsg);
            }
            throw new Error(detail);
          }

          throw new Error(reason + blockers);
        }

        const offerBlob = typeof openPrep.offerBlob === 'string' ? openPrep.offerBlob : '';
        if (!offerBlob) {
          throw new Error('open_swap_prepare_invalid');
        }

        var createdOpenMsg = 'Open offer draft created.';
        if (r) r.textContent = createdOpenMsg;
        try { cfm.setSuccess(createdOpenMsg); } catch (_) {}
        try { cfm.close(); } catch (_) {}
        $('btnBind')?.setAttribute('disabled','');
        return;
      }

      const prepReq = Object.assign({}, req, { stage: 'prepare' });
      const prep = await postJSON('/api/swaps/offer', prepReq);
      if (!prep || prep.ok === false) {
        return prep;
      }

      if (String(prep.stage || '') === 'bcw_direct_swap_maker_intent') {
        const intent = prep && prep.intent && typeof prep.intent === 'object' ? prep.intent : null;
        const intentMessage = prep && typeof prep.intent_message === 'string' ? String(prep.intent_message || '').trim() : '';
        const offerRid = prep && typeof prep.offerRid === 'string' ? String(prep.offerRid || '').trim() : '';
        if (!intent) {
          return { ok: false, reason: 'bcw_direct_swap_maker_intent_missing' };
        }
        if (!intentMessage) {
          return { ok: false, reason: 'bcw_direct_swap_maker_intent_message_missing' };
        }
        if (!offerRid) {
          return { ok: false, reason: 'bcw_direct_swap_maker_offerRid_missing' };
        }
        if (typeof kaspa.signMessage !== 'function') {
          return { ok: false, reason: 'signMessage_unavailable' };
        }

        const bcwAuthSignature = await kaspa.signMessage({
          message: intentMessage,
          privateKey: priv0
        });

        const bcwMakerReq = Object.assign({}, req, {
          stage: 'bcw_maker_submit',
          offerRid,
          bcw_direct_swap_maker_intent: intent,
          bcw_auth_signature: String(bcwAuthSignature || ''),
          intent_message: intentMessage
        });

        const out = await postJSON('/api/swaps/offer', bcwMakerReq);
        if (!out || out.ok === false) {
          return out;
        }

        var bcwCreatedMsg = 'Swap offer created.';
        if (r) r.textContent = bcwCreatedMsg;
        try { cfm.setSuccess(bcwCreatedMsg); } catch (_) {}
        try { cfm.close(); } catch (_) {}
        $('btnBind')?.setAttribute('disabled','');
        return out;
      }

      const unsignedCommit = Array.isArray(prep.unsignedCommit) ? prep.unsignedCommit : null;
      const offerRid = (typeof prep.offerRid === 'string') ? prep.offerRid : '';
      if (!unsignedCommit || !offerRid) {
        return { ok: false, reason: 'swap_offer_prepare_invalid' };
      }

      const commitInputSigs = [];
      for (let ti = 0; ti < unsignedCommit.length; ti++) {
        const item = unsignedCommit[ti] || null;
        const txStr = item && typeof item.tx === 'string' ? item.tx : '';
        const inputCount = item && typeof item.inputCount === 'number' ? item.inputCount : 0;
        if (!txStr || inputCount < 1) return { ok: false, reason: 'swap_offer_prepare_invalid_tx' };

        const signMode = String(prep && prep.sign_mode ? prep.sign_mode : '');
        if (signMode === 'compliance') {
          return { ok: false, reason: 'legacy_compliance_swap_maker_commit_signing_removed' };
        }

        const tx = kaspa.Transaction.deserializeFromSafeJSON(txStr);
        const sigs = [];
        for (let i = 0; i < inputCount; i++) {
          const sigScriptHex = kaspa.createInputSignature(tx, i, priv0, null);
          sigs.push(sigScriptHex);
        }
        commitInputSigs.push(sigs);
      }

      const commitReq = Object.assign({}, req, { stage: 'commit_submit', offerRid, commitInputSigs });
      const committed = await postJSON('/api/swaps/offer', commitReq);
      if (!committed || committed.ok === false) {
        return committed;
      }

      const txToSignSafeJson = committed.txToSignSafeJson || '';
      if (!txToSignSafeJson) return { ok: false, reason: 'swap_offer_commit_invalid' };

      const txToSign = kaspa.Transaction.deserializeFromSafeJSON(txToSignSafeJson);
      const signature0 = kaspa.createInputSignature(txToSign, 0, priv0, kaspa.SighashType.SingleAnyOneCanPay);

      if (committed && committed.walletType === 'compliance') {
        throw new Error('legacy_compliance_swap_maker_reveal_signing_removed');
      }

      const revealReq = Object.assign({}, req, { stage: 'reveal_submit', offerRid, signature0 });

      const out = await postJSON('/api/swaps/offer', revealReq);

      const offerBlob = {
        v: 1,
        kind: req.kind,
        network: String(out.network || network),
        tokenId: req.tokenId,
        amt: req.amt,
        priceKas: req.priceKas,
        makerReceiveAddress: req.makerReceiveAddress,
        takerTokenReceiveAddress: req.takerTokenReceiveAddress,
        expiry: req.expiry || null,
        p2shAddress: String(out.p2shAddress || ''),
        pskb: String(out.pskb || ''),
        commitTxids: Array.isArray(out.commitTxids) ? out.commitTxids : []
      };

      var createdMsg = takerAddr ? 'Swap offer created.' : 'Open offer created.';
      if (r) r.textContent = createdMsg;

      try { cfm.setSuccess(createdMsg); } catch (_) {}
      try { cfm.close(); } catch (_) {}

      $('btnBind')?.setAttribute('disabled','');
    } catch (e) {
      const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : 'Make Offer failed.';
      if (r) r.textContent = 'Make Offer failed: ' + msg;
      try { cfm.setError('Make Offer failed: ' + msg); } catch (_) {}
    }
  }

  // --------------- CSS ---------------

  const css = document.createElement('style');
  css.textContent = `
  .omodal{ position:fixed; inset:0; background:rgba(2, 6, 23, 0.72); backdrop-filter: blur(6px); display:flex; align-items:center; justify-content:center; z-index:10000 }
  .omodal .card{ width:min(940px, 92vw); max-height:92vh; overflow:auto; box-shadow: 0 20px 50px rgba(0,0,0,.35) }

  .omodal .h{ display:flex; align-items:center; justify-content:space-between; font-weight:600; margin-bottom:8px }
  .omodal .grid{ display:grid; gap:12px }
  .omodal .grid.two{ grid-template-columns: 1fr 1fr }
  .omodal .row{ display:flex; gap:8px; align-items:center }

  .omodal label{ display:block; font-size:12px; opacity:.85; margin-bottom:4px }
  .omodal .note{ font-size:12px; opacity:.75 }

  .omodal input,
  .omodal select,
  .omodal button{
    border-radius:12px;
    border:1px solid rgba(125, 252, 255, 0.55);
    font-family: system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .omodal input,
  .omodal select{
    width:100%;
    box-sizing:border-box;
    background: radial-gradient(circle at top left, rgba(15, 23, 42, 0.95), rgba(15, 23, 42, 1));
    color:#e5f4ff;
    box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.55);
  }

  .omodal button{ cursor:pointer }
  .omodal button.primary{ background:#111827; color:#fff }
  .omodal button.contrast{ background:#2563eb; color:#fff }
  .omodal .secondary{ background:rgba(15, 23, 42, 0.65); border-color:rgba(125, 252, 255, 0.55); color:#e5f4ff }

  .omodal .panel{
    border-radius:12px;
    border:1px solid rgba(125, 252, 255, 0.35);
    padding:10px;
    background: radial-gradient(circle at top left, rgba(56, 189, 248, 0.14), rgba(15, 23, 42, 0.95));
  }

  .omodal hr{ border:none; border-top:1px solid rgba(125, 252, 255, 0.25); margin:12px 0 }

  .omodal .buy-row{ display:flex; gap:8px; align-items:center }
  .omodal .field-block{ margin-top:.5rem }

  .omodal .compliance-only-row,
  .omodal .compliance-only-row *{
    cursor: default !important;
  }

  .omodal #complianceOnly{
    appearance:none;
    -webkit-appearance:none;
    width:42px;
    height:24px;
    margin:0;
    border-radius:999px;
    border:1px solid rgba(148, 163, 184, 0.55);
    background:rgba(71, 85, 105, 0.45);
    box-shadow:none;
    pointer-events:none;
    flex:0 0 auto;
  }

  .omodal #complianceOnly:checked{
    background:#fde047;
    border-color:#facc15;
    box-shadow:0 0 0 1px rgba(250, 204, 21, 0.45), 0 0 12px rgba(250, 204, 21, 0.35);
  }

  .omodal .suggest{ position:relative }
  .omodal .suggest .menu{
    position:absolute;
    top:calc(100% + 6px);
    left:0;
    right:0;
    background: rgba(2, 6, 23, 0.98);
    border: 1px solid rgba(125, 252, 255, 0.35);
    border-radius:12px;
    overflow:hidden;
    box-shadow: 0 18px 40px rgba(0,0,0,.35);
  }
  .omodal .suggest .item{ padding:8px 10px; cursor:pointer }
  .omodal .suggest .item:hover{ background: rgba(56, 189, 248, 0.12) }
  .omodal .suggest .t{ font-weight:600 }
  .omodal .suggest .s{ font-size:12px; opacity:.7 }

  .omodal .trade-row{ display:grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap:8px; align-items:flex-end }
  .omodal .trade-col{ min-width:0 }
  .omodal .ttl-fields{ display:flex; gap:6px; align-items:center }
  @media (max-width: 900px){
    .trade-row{ grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  }
  
`;
  document.head.append(css);

})();
