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
      atomicRefundLockDaa: '0',
      receiveSource: null,    // 'active' | 'external' | 'manual'
      complianceOnly: false,
      partialConsidered: false,
      partialMin: '',
      partialStep: '',
      buyAsset: 'KAS',
      buyAmount: '',
      offerDescription: '',
      offerInfoUrl: '',
      ttlMode: 'hours',       // 'hours' | 'eod' | 'gtc'
      ttlHours: 4
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

        <div id="swapCreateSuccess" class="swap-create-success" tabindex="-1" style="display:none"></div>

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
              <input id="recvAddr" type="text" placeholder="Paste your KAS settlement address" autocomplete="off">
              <button id="btnRecvUseActive" type="button" class="secondary">Use this wallet's address</button>
            </div>
            <div id="recvHelp" class="note" style="margin-top:.25rem">
              Paste the Kaspa-family address where you want to receive KAS settlement.
            </div>
          </div>

          <div class="field-block">
            <label>Taker Token Receive Address (Direct Atomic KCC20)</label>
            <div class="row" style="gap:.5rem;margin-top:.25rem">
              <input id="takerRecvAddr" type="text" placeholder="Paste taker kaspa:… address to receive tokens" autocomplete="off">
            </div>
            <div class="note" style="margin-top:.25rem">
              Direct KCC20 atomic swaps lock the selected OMA L1/KCC20 amount to this fixed taker token receive address. Leave this blank to create a KCC20 Open Atomic Swap where the taker receive address is selected dynamically at claim.
            </div>
          </div>

          <div class="field-block" id="atomicRefundLockDaaBlock">
            <label>Maker cancel policy</label>
            <input id="atomicRefundLockDaa" type="hidden" value="0">
            <div class="note" style="margin-top:.25rem">
              Direct KCC20 atomic offers use immediate maker cancel while the offer is live. No DAA lock or expiration is required to cancel your own offer.
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
                    <option value="gtc">Good Till Cancelled (GTC)</option>
                  </select>
                  <input id="ttlHours" type="number" min="1" max="168" step="1" value="4">
                </div>
              </div>
            </div>
            <div class="note" style="margin-top:.25rem">
              TTL controls how long the offer remains visible before expiring automatically. Hours defaults to 4 and may be 1–168. End of Day expires at local midnight. Good Till Cancelled does not expire automatically; use My Swaps → Cancel/Expire to remove it.
            </div>
          </div>

          <div class="field-block">
            <label for="offerDescription">Offer description / terms (optional)</label>
            <textarea id="offerDescription" rows="3" maxlength="2000" placeholder="Example: 10% off Hoymiles equipment order. Valid for one eligible purchase."></textarea>
            <div class="note" style="margin-top:.25rem">
              Use this for coupon terms, merchant instructions, or what the token can be redeemed for.
            </div>
          </div>

          <div class="field-block">
            <label for="offerInfoUrl">More information URL (optional)</label>
            <input id="offerInfoUrl" type="text" maxlength="500" placeholder="https://example.com/offer-terms" autocomplete="off">
            <div class="note" style="margin-top:.25rem">
              Optional http/https link for full offer terms. No image/icon upload in this version.
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
    $('atomicRefundLockDaa')?.addEventListener('input', onAtomicRefundLockDaaChange, {passive:true});
    $('btnRecvUseActive')?.addEventListener('click', onRecvUseActive, {passive:true});
    $('partialToggle')?.addEventListener('change', onPartialToggle, {passive:true});
    $('partialMin')?.addEventListener('input', onPartialMinChange, {passive:true});
    $('partialStep')?.addEventListener('input', onPartialStepChange, {passive:true});
    $('buyAmount')?.addEventListener('input', onBuyAmountChange, {passive:true});
    $('offerDescription')?.addEventListener('input', onOfferDescriptionChange, {passive:true});
    $('offerInfoUrl')?.addEventListener('input', onOfferInfoUrlChange, {passive:true});
    $('ttlMode')?.addEventListener('change', onTtlModeChange, {passive:true});
    $('ttlHours')?.addEventListener('input', onTtlHoursChange, {passive:true});

    $('btnAnalyze')?.addEventListener('click', () => { onAnalyze().catch(() => {}); }, {passive:true});
    $('btnBind')?.addEventListener('click', () => { onBind().catch(() => {}); }, {passive:true});

    // Reset state
    S.form.receiveAddress = '';
    S.form.takerTokenReceiveAddress = '';
    S.form.atomicRefundLockDaa = '0';
    S.form.receiveSource = null;
    setComplianceOnlyDerived(false);
    S.form.partialConsidered = false;
    S.form.partialMin = '';
    S.form.partialStep = '';
    S.form.buyAsset = 'KAS';
    S.form.buyAmount = '';
    S.form.offerDescription = '';
    S.form.offerInfoUrl = '';
    S.form.ttlMode = 'hours';
    S.form.ttlHours = 4;
    S.offerId = null;
    S.fillId = null;
    S.takeOffer = null;

    if ($('recvAddr')) $('recvAddr').value = '';
    if ($('takerRecvAddr')) $('takerRecvAddr').value = '';
    if ($('atomicRefundLockDaa')) $('atomicRefundLockDaa').value = S.form.atomicRefundLockDaa;
    if ($('buyAmount')) $('buyAmount').value = '';
    if ($('offerDescription')) $('offerDescription').value = '';
    if ($('offerInfoUrl')) $('offerInfoUrl').value = '';
    if ($('partialToggle')) $('partialToggle').checked = false;
    if ($('partialMin')) $('partialMin').value = '';
    if ($('partialStep')) $('partialStep').value = '';
    if ($('ttlMode')) $('ttlMode').value = 'hours';
    if ($('ttlHours')) $('ttlHours').value = '4';
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

        const originKind = (ctx.originKind === 'EVM') ? 'EVM' : (ctx.originKind === 'OMA_L1' ? 'OMA_L1' : 'KRC');
        S.originKind = originKind;
        S.sendContext = {
          originKind,
          wid: ctx.wid || '',
          network: ctx.network || '',
          address: ctx.address,
          assetKind: ctx.assetKind || '',
          assetId: ctx.assetId || '',
          assetName: typeof ctx.assetName === 'string' ? ctx.assetName.trim() : '',
          amount: ctx.amount || '',
          assetSelectValue: typeof ctx.assetSelectValue === 'string' ? ctx.assetSelectValue.trim() : '',
          assetCovenantId: typeof ctx.assetCovenantId === 'string' ? ctx.assetCovenantId.trim().toLowerCase() : '',
          tokenSymbol: typeof ctx.tokenSymbol === 'string' ? ctx.tokenSymbol.trim() : '',
          amountRawAvailable: typeof ctx.amountRawAvailable === 'string' ? ctx.amountRawAvailable.trim() : '',
          amountHumanAvailable: typeof ctx.amountHumanAvailable === 'string' ? ctx.amountHumanAvailable.trim() : '',
          sourceSelection: typeof ctx.sourceSelection === 'string' ? ctx.sourceSelection.trim() : '',
          route: typeof ctx.route === 'string' ? ctx.route.trim() : '',
          swapContextKind: typeof ctx.swapContextKind === 'string' ? ctx.swapContextKind.trim() : ''
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

  function onAtomicRefundLockDaaChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.atomicRefundLockDaa = v;
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

  function onOfferDescriptionChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.offerDescription = v.slice(0, 2000);
  }

  function onOfferInfoUrlChange(ev){
    const v = String(ev && ev.target && ev.target.value || '').trim();
    S.form.offerInfoUrl = v.slice(0, 500);
  }

  function promptOpenOfferQuantity(){
    const raw = window.prompt('How many identical open offers do you want to create?', '1');
    if (raw === null) return null;

    const value = String(raw || '').trim();
    if (!/^\d+$/.test(value)) {
      const err = new Error('invalid_open_offer_quantity');
      err.reason = 'Open offer quantity must be a whole number.';
      throw err;
    }

    const quantity = Number(value);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      const err = new Error('invalid_open_offer_quantity');
      err.reason = 'Open offer quantity must be at least 1.';
      throw err;
    }

    if (quantity > 1000) {
      const err = new Error('open_offer_quantity_too_large');
      err.reason = 'Open offer quantity cannot exceed 1000 in one batch.';
      throw err;
    }

    return quantity;
  }

  function makeOpenOfferBatchId(){
    const bytes = new Uint8Array(8);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes).map(function(b){
        return b.toString(16).padStart(2, '0');
      }).join('');
    }

    return String(Date.now()) + '-' + Math.floor(Math.random() * 1000000000);
  }

  function hideOfferCreateSuccess(){
    const elSuccess = $('swapCreateSuccess');
    if (!elSuccess) return;
    elSuccess.style.display = 'none';
    elSuccess.textContent = '';
  }

  function showOfferCreateSuccess(message){
    const elSuccess = $('swapCreateSuccess');
    if (!elSuccess) return;
    elSuccess.textContent = 'Success — ' + String(message || 'offer created.');
    elSuccess.style.display = 'block';
    try {
      elSuccess.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (_) {
      try { elSuccess.scrollIntoView(); } catch (_) {}
    }
    try { elSuccess.focus({ preventScroll: true }); } catch (_) {}
  }

  function onTtlModeChange(ev){
    const v = String(ev && ev.target && ev.target.value || 'hours');
    S.form.ttlMode = (v === 'eod' || v === 'gtc') ? v : 'hours';
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
    const isAtomicKcc20 = isOmaL1Kcc20DirectSwapContext();
    const bindBtn = $('btnBind');
    if (bindBtn) bindBtn.textContent = isAtomicKcc20 ? 'Sign & Create Atomic Direct Swap' : 'Make Offer (Swap)';
    const refundBlock = $('atomicRefundLockDaaBlock');
    if (refundBlock) refundBlock.style.display = isAtomicKcc20 ? '' : 'none';
  }

  // --------------- Payload builder ---------------


  function isOmaL1Kcc20DirectSwapContext(){
    const ctx = S.sendContext || null;
    if (!ctx || typeof ctx !== 'object') return false;
    return String(ctx.assetKind || '').trim() === 'oma_l1_covenant_token' || String(ctx.route || '').trim() === 'oma_l1_holder_transfer';
  }

  function normalizeHex64OrEmpty(value){
    const s = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(s) ? s : '';
  }

  function kasDecimalToSompiString(value){
    const raw = String(value || '').trim();
    const normalized0 = raw.startsWith('.') ? ('0' + raw) : raw;
    const normalized = normalized0.endsWith('.') ? normalized0.slice(0, -1) : normalized0;
    if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('invalid_kas_price_amount');
    const parts = normalized.split('.');
    const whole = String(parts[0] || '0');
    const frac = String(parts[1] || '');
    if (frac.length > 8) throw new Error('invalid_kas_price_precision');
    const sompi = (BigInt(whole || '0') * 100000000n) + BigInt((frac + '00000000').slice(0, 8) || '0');
    if (sompi <= 0n) throw new Error('invalid_kas_price_nonpositive');
    return sompi.toString();
  }

  function decimalTokenAmountToRawString(value, decimals, errorPrefix){
    const raw = String(value || '').trim();
    const normalized0 = raw.startsWith('.') ? ('0' + raw) : raw;
    const normalized = normalized0.endsWith('.') ? normalized0.slice(0, -1) : normalized0;
    const prefix = errorPrefix || 'kcc20_atomic_swap_token_amount';
    const dec = Number(decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error(prefix + '_decimals_invalid');
    if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(prefix + '_human_amount_invalid');
    const parts = normalized.split('.');
    const whole = String(parts[0] || '0');
    const frac = String(parts[1] || '');
    if (frac.length > dec) throw new Error(prefix + '_human_amount_precision_exceeds_decimals');
    const scale = 10n ** BigInt(dec);
    const rawAmount = (BigInt(whole || '0') * scale) + BigInt((frac + '0'.repeat(dec)).slice(0, dec) || '0');
    if (rawAmount <= 0n) throw new Error(prefix + '_human_amount_nonpositive');
    return rawAmount.toString();
  }

  function inferDecimalsFromRawAndHuman(rawText, humanText){
    const raw = String(rawText || '').trim();
    const human = String(humanText || '').trim();
    if (!/^\d+$/.test(raw) || !/^\d+(\.\d+)?$/.test(human)) return null;
    for (let dec = 0; dec <= 18; dec += 1) {
      try {
        if (decimalTokenAmountToRawString(human, dec, 'kcc20_atomic_swap_decimal_infer') === raw) return dec;
      } catch (_) {}
    }
    return null;
  }

  function kcc20DirectSwapTokenDecimals(payload){
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : {};
    const ctx = S.sendContext && typeof S.sendContext === 'object' ? S.sendContext : {};
    const candidates = [
      sell.decimals, sell.token_decimals, sell.tokenDecimals, sell.asset_decimals, sell.assetDecimals,
      ctx.decimals, ctx.token_decimals, ctx.tokenDecimals, ctx.asset_decimals, ctx.assetDecimals
    ];
    for (const value of candidates) {
      if (value === null || value === undefined || value === '') continue;
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0 && n <= 18) return n;
    }
    const inferred = inferDecimalsFromRawAndHuman(ctx.amountRawAvailable, ctx.amountHumanAvailable);
    return inferred !== null ? inferred : 0;
  }

  function kcc20DirectSwapSellAmountRaw(payload){
    return decimalTokenAmountToRawString(
      payload && payload.sell_amount,
      kcc20DirectSwapTokenDecimals(payload),
      'kcc20_direct_swap_sell_amount'
    );
  }

  function isKcc20DirectSwapPayload(payload){
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : null;
    return !!(sell && String(sell.type || '').trim() === 'OMA_L1_COVENANT_TOKEN' && normalizeHex64OrEmpty(sell.asset_covenant_id));
  }

  function kcc20DirectSwapPlanRequest(payload){
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : {};
    return {
      asset_covenant_id: normalizeHex64OrEmpty(sell.asset_covenant_id),
      transfer_amount_raw: kcc20DirectSwapSellAmountRaw(payload),
      kas_price_sompi: kasDecimalToSompiString(payload && payload.buy_amount),
      maker_kas_receive_address: String(payload && payload.receiveEndpoint && payload.receiveEndpoint.address || '').trim(),
      taker_recipient_address: String(S.form.takerTokenReceiveAddress || '').trim()
    };
  }

  function kcc20AtomicRefundLockDaaOrThrow(){
    // Direct KCC20 atomic v4 offers are maker-cancelable at any time while live.
    // Keep the legacy request field as 0 for compatibility, but do not expose or require a DAA lock in the UI.
    const raw = String(S.form.atomicRefundLockDaa || '0').trim() || '0';
    if (!/^\d+$/.test(raw)) throw new Error('kcc20_atomic_swap_refund_lock_daa_invalid');
    return raw;
  }

  function kcc20AtomicDirectMakerLockRequest(payload){
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : {};
    return {
      asset_covenant_id: normalizeHex64OrEmpty(sell.asset_covenant_id),
      lock_amount_raw: kcc20DirectSwapSellAmountRaw(payload),
      kas_price_sompi: kasDecimalToSompiString(payload && payload.buy_amount),
      maker_kas_receive_address: String(payload && payload.receiveEndpoint && payload.receiveEndpoint.address || '').trim(),
      maker_token_refund_address: String(S.sendContext && S.sendContext.address || '').trim(),
      taker_token_receive_address: String(S.form.takerTokenReceiveAddress || '').trim(),
      refund_lock_daa: kcc20AtomicRefundLockDaaOrThrow(),
      ttl: payload && typeof payload.ttl === 'number' ? payload.ttl : 0
    };
  }

  async function buildKcc20AtomicDirectMakerLockFromPayload(payload){
    const req = kcc20AtomicDirectMakerLockRequest(payload);
    if (!req.asset_covenant_id) throw new Error('kcc20_atomic_swap_asset_covenant_id_missing');
    if (!req.lock_amount_raw) throw new Error('kcc20_atomic_swap_lock_amount_raw_missing');
    if (!req.kas_price_sompi) throw new Error('kcc20_atomic_swap_kas_price_sompi_missing');
    if (!req.maker_kas_receive_address) throw new Error('kcc20_atomic_swap_maker_kas_receive_address_missing');
    if (!req.maker_token_refund_address) throw new Error('kcc20_atomic_swap_maker_token_refund_address_missing');
    if (!req.taker_token_receive_address) throw new Error('kcc20_atomic_swap_taker_token_receive_address_required');
    return await postJSON('/api/covenants/issuer-token/atomic-swap/direct/maker-lock/build', req);
  }

  function kcc20AtomicOpenMakerLockRequest(payload){
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : {};
    return {
      asset_covenant_id: normalizeHex64OrEmpty(sell.asset_covenant_id),
      lock_amount_raw: kcc20DirectSwapSellAmountRaw(payload),
      kas_price_sompi: kasDecimalToSompiString(payload && payload.buy_amount),
      maker_kas_receive_address: String(payload && payload.receiveEndpoint && payload.receiveEndpoint.address || '').trim(),
      maker_token_refund_address: String(S.sendContext && S.sendContext.address || '').trim(),
      ttl: payload && typeof payload.ttl === 'number' ? payload.ttl : 0
    };
  }

  async function buildKcc20AtomicOpenMakerLockFromPayload(payload){
    const req = kcc20AtomicOpenMakerLockRequest(payload);
    if (!req.asset_covenant_id) throw new Error('kcc20_atomic_open_swap_asset_covenant_id_missing');
    if (!req.lock_amount_raw) throw new Error('kcc20_atomic_open_swap_lock_amount_raw_missing');
    if (!req.kas_price_sompi) throw new Error('kcc20_atomic_open_swap_kas_price_sompi_missing');
    if (!req.maker_kas_receive_address) throw new Error('kcc20_atomic_open_swap_maker_kas_receive_address_missing');
    if (!req.maker_token_refund_address) throw new Error('kcc20_atomic_open_swap_maker_token_refund_address_missing');
    return await postJSON('/api/covenants/issuer-token/atomic-swap/open/maker-lock/build', req);
  }

  function renderKcc20AtomicOpenMakerLockPanel(build, submitOut){
    const token = build && build.token_definition ? build.token_definition : {};
    const terms = build && build.atomic_swap_terms ? build.atomic_swap_terms : {};
    const plan = build && build.maker_lock_plan ? build.maker_lock_plan : {};
    const locked = plan && plan.swap_locked_holder_output ? plan.swap_locked_holder_output : {};
    const change = plan && plan.maker_change_holder_output ? plan.maker_change_holder_output : null;
    const tracking = submitOut && submitOut.tracking ? submitOut.tracking : null;
    const listing = submitOut && submitOut.open_swap_offer_listing ? submitOut.open_swap_offer_listing : null;
    const rows = [
      ['Mode', 'KCC20 Atomic Open Swap'],
      ['Status', submitOut && submitOut.ok === true ? 'Submitted live' : 'Build ready'],
      ['Token', String(token.token_symbol || build?.token_symbol || 'OMA L1')],
      ['Asset covenant ID', String(build?.asset_covenant_id || '')],
      ['Lock amount raw', String(terms.lock_amount_raw || build?.lock_amount_raw || '')],
      ['KAS price', String(terms.kas_price_kas || build?.kas_price_kas || '') + ' KAS'],
      ['Maker KAS receive', String(terms.maker_kas_receive_address || build?.maker_kas_receive_address || '')],
      ['Maker token refund', String(terms.maker_token_refund_address || build?.maker_token_refund_address || '')],
      ['Taker token receive', 'Dynamic at claim'],
      ['Offer TTL seconds', String(terms.offer_ttl_seconds || build?.offer_ttl_seconds || '')],
      ['Policy kind', String(build?.policy_body?.policy_body_kind || submitOut?.policy_body_kind || 'open_dynamic_taker_atomic_swap_claim_or_maker_cancel_v1')],
      ['Swap locked output', String(locked.address || tracking?.swap_locked_holder_address || '')],
      ['Maker token change raw', change ? String(change.amount_raw || '') : '0'],
      ['Submit txid', submitOut ? String(submitOut.submitted_txid || '') : '—'],
      ['Tracked outpoint', tracking ? String(tracking.source_outpoint_key || '') : '—'],
      ['Tracking status', tracking ? String(tracking.record_status || '') : '—'],
      ['Open offer ID', listing ? String(listing.offerId || '') : '—'],
      ['Open offer state', listing ? String(listing.state || '') : '—']
    ];
    const rowHtml = function(pair){
      return '<div style="opacity:.75">' + escapeHtml(pair[0]) + '</div><div style="word-break:break-all">' + escapeHtml(pair[1]) + '</div>';
    };
    return [
      '<div class="panel">',
        '<div><strong>KCC20 Atomic Open Swap</strong></div>',
        '<div style="color:#059669;margin-top:6px"><strong>' + (submitOut && submitOut.ok === true ? 'Created live.' : 'Build ready.') + '</strong> Dynamic-taker atomic maker-lock path.</div>',
        '<div style="display:grid;grid-template-columns:190px 1fr;gap:4px 10px;margin-top:8px">',
          rows.map(rowHtml).join(''),
        '</div>',
      '</div>'
    ].join('');
  }

  async function signKcc20AtomicOpenMakerLock(build, priv0Hex){
    const signed = await signKcc20AtomicDirectMakerLock(build, priv0Hex);
    return Object.assign({}, signed, { stage: 'kcc20_atomic_open_swap_wallet_ui_maker_lock_signed_v1' });
  }

  async function submitKcc20AtomicOpenMakerLock(build, signed){
    return await submitKcc20AtomicDirectMakerLock(build, signed);
  }

  function renderKcc20AtomicDirectMakerLockPanel(build, submitOut){
    const token = build && build.token_definition ? build.token_definition : {};
    const terms = build && build.atomic_swap_terms ? build.atomic_swap_terms : {};
    const plan = build && build.maker_lock_plan ? build.maker_lock_plan : {};
    const locked = plan && plan.swap_locked_holder_output ? plan.swap_locked_holder_output : {};
    const change = plan && plan.maker_change_holder_output ? plan.maker_change_holder_output : null;
    const tracking = submitOut && submitOut.tracking ? submitOut.tracking : null;
    const rows = [
      ['Mode', 'KCC20 Atomic Direct Swap v3'],
      ['Status', submitOut && submitOut.ok === true ? 'Submitted live' : 'Build ready'],
      ['Token', String(token.token_symbol || build?.token_symbol || 'OMA L1')],
      ['Asset covenant ID', String(build?.asset_covenant_id || '')],
      ['Lock amount raw', String(terms.lock_amount_raw || build?.lock_amount_raw || '')],
      ['KAS price', String(terms.kas_price_kas || build?.kas_price_kas || '') + ' KAS'],
      ['Maker KAS receive', String(terms.maker_kas_receive_address || build?.maker_kas_receive_address || '')],
      ['Maker token refund', String(terms.maker_token_refund_address || build?.maker_token_refund_address || '')],
      ['Taker token receive', String(terms.taker_token_receive_address || build?.taker_token_receive_address || '')],
      ['Refund lock DAA', String(terms.refund_lock_daa || build?.refund_lock_daa || '')],
      ['Policy kind', String(build?.policy_body?.policy_body_kind || submitOut?.policy_body_kind || 'direct_fixed_recipient_atomic_swap_claim_or_refund_with_taker_change_final_true_v3')],
      ['Swap locked output', String(locked.address || tracking?.swap_locked_holder_address || '')],
      ['Maker token change raw', change ? String(change.amount_raw || '') : '0'],
      ['Submit txid', submitOut ? String(submitOut.submitted_txid || '') : '—'],
      ['Tracked outpoint', tracking ? String(tracking.source_outpoint_key || '') : '—'],
      ['Tracking status', tracking ? String(tracking.record_status || '') : '—']
    ];
    const rowHtml = function(pair){
      return '<div style="opacity:.75">' + escapeHtml(pair[0]) + '</div><div style="word-break:break-all">' + escapeHtml(pair[1]) + '</div>';
    };
    return [
      '<div class="panel">',
        '<div><strong>KCC20 Atomic Direct Swap</strong></div>',
        '<div style="color:#059669;margin-top:6px"><strong>' + (submitOut && submitOut.ok === true ? 'Created live.' : 'Build ready.') + '</strong> Fixed-recipient v3 atomic maker-lock path.</div>',
        '<div style="display:grid;grid-template-columns:190px 1fr;gap:4px 10px;margin-top:8px">',
          rows.map(rowHtml).join(''),
        '</div>',
      '</div>'
    ].join('');
  }

  async function signKcc20AtomicDirectMakerLock(build, priv0Hex){
    const kaspaSdk = await getKaspaSdkOrThrow();
    if (!build || build.ok !== true || !build.txToSignSafeJson) throw new Error('kcc20_atomic_swap_maker_lock_build_missing_tx');
    const tx = kaspaSdk.Transaction.deserializeFromSafeJSON(build.txToSignSafeJson);
    const priv0 = new kaspaSdk.PrivateKey(priv0Hex);
    const expectedAddress = String(build.fromAddress || '').trim();
    const networkId = String(build.networkId || '').trim();
    if (expectedAddress && networkId) {
      const derived = String(priv0.toAddress(networkId).toString());
      if (derived !== expectedAddress) throw new Error('kcc20_atomic_swap_active_key_does_not_match_maker_fromAddress');
    }

    const signCtx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
    const signInputIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(function(v){ return Number(v); }) : [];
    const signSet = new Set(signInputIndexes);
    const holderInputs = Array.isArray(signCtx.holder_inputs) ? signCtx.holder_inputs.map(function(input){
      return {
        inputIndex: Number(input.input_index),
        sourceHolderOutpoint: String(input.source_holder_outpoint || ''),
        redeemScriptHex: String(input.source_holder_redeem_script_hex || '').trim()
      };
    }) : [];
    if (!holderInputs.length) throw new Error('kcc20_atomic_swap_maker_lock_holder_inputs_missing');
    holderInputs.forEach(function(input){
      if (!Number.isInteger(input.inputIndex) || input.inputIndex < 0) throw new Error('kcc20_atomic_swap_maker_lock_holder_input_index_invalid');
      if (!signSet.has(input.inputIndex)) throw new Error('kcc20_atomic_swap_maker_lock_holder_input_not_signable');
      if (!/^[0-9a-f]+$/i.test(input.redeemScriptHex) || input.redeemScriptHex.length % 2 !== 0) throw new Error('kcc20_atomic_swap_maker_lock_holder_redeem_script_missing');
    });

    const fundingUsed = signCtx.native_kas_funding_input_used === true;
    const fundingInputIndex = fundingUsed ? Number(signCtx.native_kas_funding_input_index) : null;
    if (fundingUsed && (!Number.isInteger(fundingInputIndex) || fundingInputIndex < 0 || !signSet.has(fundingInputIndex))) throw new Error('kcc20_atomic_swap_maker_lock_native_funding_input_not_signable');

    const beforeHolderSignatureScriptsEmpty = holderInputs.every(function(input){
      const txInput = tx.inputs[input.inputIndex];
      return txInput && (!txInput.signatureScript || String(txInput.signatureScript).length === 0);
    });

    const dummySig = new Uint8Array(65);
    const scripts = holderInputs.map(function(input){
      return { input, script: kaspaSdk.ScriptBuilder.fromScript(input.redeemScriptHex) };
    });

    scripts.forEach(function(item){
      fillKcc20DirectSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(dummySig), 'kcc20_atomic_swap_maker_lock_holder_input_missing_for_dummy_sig');
    });
    scripts.forEach(function(item){
      const sig = kaspaSdk.createInputSignature(tx, item.input.inputIndex, priv0, null);
      fillKcc20DirectSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(sig), 'kcc20_atomic_swap_maker_lock_holder_input_missing_for_final_sig');
    });
    if (fundingUsed && fundingInputIndex !== null) {
      const fundingSig = kaspaSdk.createInputSignature(tx, fundingInputIndex, priv0, null);
      fillKcc20DirectSignatureScript(tx, fundingInputIndex, fundingSig, 'kcc20_atomic_swap_maker_lock_native_funding_input_missing_for_final_sig');
    }

    tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    kaspaSdk.Transaction.deserializeFromSafeJSON(signedSafeJson);
    const signedSafeJsonSha256 = await sha256HexText(signedSafeJson);
    const holderSignatureScriptLengths = holderInputs.map(function(input){ return String(tx.inputs[input.inputIndex] && tx.inputs[input.inputIndex].signatureScript || '').length; });

    return {
      ok: true,
      stage: 'kcc20_atomic_swap_wallet_ui_maker_lock_signed_v1',
      holder_input_count: holderInputs.length,
      native_funding_input_used: fundingUsed,
      native_funding_input_index: fundingInputIndex,
      before_holder_signature_scripts_empty: beforeHolderSignatureScriptsEmpty,
      after_holder_signature_scripts_present: holderSignatureScriptLengths.every(function(n){ return Number(n) > 0; }),
      holder_signature_script_lengths: holderSignatureScriptLengths,
      signed_safe_json_sha256: signedSafeJsonSha256,
      signed_tx_deserialize_check_ok: true,
      private_key_printed: false,
      signed_transaction_printed: false,
      signature_script_printed: false,
      redeem_script_printed: false,
      submit_token_printed: false,
      signedSafeJson
    };
  }

  async function submitKcc20AtomicDirectMakerLock(build, signed){
    if (!build || !signed || !signed.signedSafeJson) throw new Error('kcc20_atomic_swap_maker_lock_submit_missing_signed_tx');
    const submitRoute = String(build.submit_route || '').trim();
    const submitToken = String(build.submit_token || '').trim();
    const submitIntent = String(build.submit_intent_required || '').trim();
    if (!submitRoute || !submitToken || !submitIntent) throw new Error('kcc20_atomic_swap_maker_lock_submit_context_missing');
    return await postJSON(submitRoute, {
      submit_intent: submitIntent,
      submit_token: submitToken,
      signed_safe_json: signed.signedSafeJson,
      signed_safe_json_sha256: signed.signed_safe_json_sha256
    });
  }

  async function buildKcc20DirectSwapPlanFromPayload(payload){
    const req = kcc20DirectSwapPlanRequest(payload);
    if (!req.asset_covenant_id) throw new Error('kcc20_direct_swap_asset_covenant_id_missing');
    if (!req.transfer_amount_raw) throw new Error('kcc20_direct_swap_transfer_amount_raw_missing');
    if (!req.maker_kas_receive_address) throw new Error('kcc20_direct_swap_maker_receive_address_missing');
    if (!req.taker_recipient_address) throw new Error('kcc20_direct_swap_taker_token_receive_address_required');
    return await postJSON('/api/covenants/issuer-token/kcc20-direct-swap/build', req);
  }

  function renderKcc20DirectSwapPlanPanel(out, payload){
    const token = out && out.token_definition ? out.token_definition : {};
    const tokenLeg = out && out.direct_swap_plan && out.direct_swap_plan.token_leg ? out.direct_swap_plan.token_leg : {};
    const kasLeg = out && out.direct_swap_plan && out.direct_swap_plan.kas_leg ? out.direct_swap_plan.kas_leg : {};
    const tokenSymbol = String(token.token_symbol || (payload && payload.sell && payload.sell.symbol) || 'OMA L1');
    const assetCovenantId = String(out && out.asset_covenant_id || '');
    const holderTransferBuildRoute = String(tokenLeg.holder_transfer_build_route || '/api/covenants/issuer-token/holder-transfer/build');
    const rows = [
      ['Mode', 'KCC20-compatible Direct Swap'],
      ['Token', tokenSymbol],
      ['Asset covenant ID', assetCovenantId],
      ['Token amount raw', String(tokenLeg.transfer_amount_raw || '')],
      ['Token recipient', String(out && out.taker_recipient_address || '')],
      ['Maker KAS receive address', String(out && out.maker_kas_receive_address || '')],
      ['KAS price', String(kasLeg.requested_kas_price_kas || '') + ' KAS'],
      ['Selected source count', String(tokenLeg.selected_source_count ?? '')],
      ['Sender token change raw', String(tokenLeg.sender_change_amount_raw || '0')],
      ['Payment status', String(kasLeg.payment_verification_status || '')],
      ['Token submit allowed here', 'No']
    ];
    const analyzerRows = [
      ['Analyzer metadata kind', 'kcc20_direct_1i_visible_analyzer_metadata_for_oma_l1_token_v1'],
      ['Asset kind', 'OMA L1 covenant token'],
      ['Token standard', 'oma_l1_covenant_token_profile_v0_1'],
      ['Transfer route', 'oma_l1_holder_transfer'],
      ['Holder transfer build route', holderTransferBuildRoute],
      ['Selected source count', String(tokenLeg.selected_source_count ?? '')],
      ['Selected holder amount raw total', String(tokenLeg.selected_holder_amount_raw_total || '')],
      ['Transfer amount raw', String(tokenLeg.transfer_amount_raw || '')],
      ['Sender change amount raw', String(tokenLeg.sender_change_amount_raw || '0')],
      ['KAS payment required before token submit', 'Yes'],
      ['Token leg remains unsubmitted until KAS payment is verified', 'Yes']
    ];
    const rowHtml = function(pair){
      return '<div style="opacity:.75">' + escapeHtml(pair[0]) + '</div><div style="word-break:break-all">' + escapeHtml(pair[1]) + '</div>';
    };
    return [
      '<div class="panel">',
        '<div><strong>KCC20 Direct Swap plan</strong></div>',
        '<div style="color:#059669;margin-top:6px"><strong>Plan ready.</strong> No signing, submit, broadcast, or mint occurred.</div>',
        '<div style="display:grid;grid-template-columns:160px 1fr;gap:4px 10px;margin-top:8px">',
          rows.map(rowHtml).join(''),
        '</div>',
      '</div>',
      '<div class="panel" style="margin-top:.75rem">',
        '<div><strong>Analyzer-visible OMA L1 / KCC20 metadata</strong></div>',
        '<div style="color:#059669;margin-top:6px"><strong>Analyzer-visible.</strong> Token leg remains unsubmitted until KAS payment is verified.</div>',
        '<div style="display:grid;grid-template-columns:210px 1fr;gap:4px 10px;margin-top:8px">',
          analyzerRows.map(rowHtml).join(''),
        '</div>',
      '</div>'
    ].join('');
  }

  function buildKcc20DirectSwapAnalyzerMetadata(out, payload){
    const token = out && out.token_definition && typeof out.token_definition === 'object' ? out.token_definition : {};
    const tokenLeg = out && out.direct_swap_plan && out.direct_swap_plan.token_leg ? out.direct_swap_plan.token_leg : {};
    const kasLeg = out && out.direct_swap_plan && out.direct_swap_plan.kas_leg ? out.direct_swap_plan.kas_leg : {};
    const sell = payload && payload.sell && typeof payload.sell === 'object' ? payload.sell : {};
    const assetCovenantId = String((out && out.asset_covenant_id) || sell.asset_covenant_id || '').trim().toLowerCase();
    const symbol = String(token.token_symbol || sell.symbol || sell.name || 'OMA_L1').trim() || 'OMA_L1';
    const displayName = String(token.token_name || sell.name || symbol).trim() || symbol;
    const decimals = token.decimals != null ? token.decimals : (token.token_decimals != null ? token.token_decimals : '0');

    return {
      ok: out && out.ok !== false,
      analyzer_kind: 'kcc20_direct_1h_analyzer_metadata_for_oma_l1_token_v1',
      trade: {
        sell: {
          type: 'OMA_L1_COVENANT_TOKEN',
          symbol,
          name: displayName,
          asset_covenant_id: assetCovenantId,
          standard: 'oma_l1_covenant_token_profile_v0_1',
          route: 'oma_l1_holder_transfer'
        },
        buy: { type: 'KAS', symbol: 'KAS', name: 'KAS' },
        sell_amount: String(tokenLeg.transfer_amount_raw || (payload && payload.sell_amount) || ''),
        buy_amount: String(kasLeg.requested_kas_price_kas || (payload && payload.buy_amount) || ''),
        ttl: payload && typeof payload.ttl === 'number' ? payload.ttl : 0
      },
      sell_amount: String(tokenLeg.transfer_amount_raw || (payload && payload.sell_amount) || ''),
      buy_amount: String(kasLeg.requested_kas_price_kas || (payload && payload.buy_amount) || ''),
      receiveEndpoint: payload && payload.receiveEndpoint ? payload.receiveEndpoint : {},
      assetMeta: {
        sell: {
          kind: 'OMA_L1_COVENANT_TOKEN',
          ticker: symbol,
          symbol,
          name: displayName,
          ca: assetCovenantId,
          decimals,
          totalMinted: token.total_issued_raw || token.issued_supply_raw || token.total_supply_raw || '',
          maxSupply: token.max_supply_raw || token.max_issuable_raw || '',
          holderTotal: tokenLeg.selected_source_count != null ? tokenLeg.selected_source_count : '',
          transferTotal: '',
          mintTotal: '',
          explorerUrl: ''
        },
        buy: {
          kind: 'KAS',
          ticker: 'KAS',
          symbol: 'KAS',
          name: 'KAS',
          decimals: 8
        }
      },
      solvency: {
        sell_ok: out && out.ok === true,
        fee_ok: null
      },
      fees: {}
    };
  }

  async function sha256HexText(text){
    const bytes = new TextEncoder().encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function(b){ return b.toString(16).padStart(2, '0'); }).join('');
  }

  async function getKaspaSdkOrThrow(){
    const direct = window.kaspa && typeof window.kaspa === 'object' ? window.kaspa : null;
    if (direct && direct.Transaction && direct.PrivateKey && direct.ScriptBuilder && typeof direct.createInputSignature === 'function') return direct;
    const ready = window.kaspaReady ? await window.kaspaReady : null;
    if (ready && ready.Transaction && ready.PrivateKey && ready.ScriptBuilder && typeof ready.createInputSignature === 'function') return ready;
    throw new Error('kaspa_sdk_unavailable');
  }

  function fillKcc20DirectSignatureScript(tx, inputIndex, signatureScript, reason){
    const inputs = tx && Array.isArray(tx.inputs) ? tx.inputs : [];
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || !inputs[inputIndex]) throw new Error(reason || 'kcc20_direct_swap_input_missing');
    inputs[inputIndex].signatureScript = signatureScript;
    tx.inputs = inputs;
  }

  async function buildAndSignKcc20DirectHolderTransfer(payload, planOut, priv0Hex){
    const kaspaSdk = await getKaspaSdkOrThrow();
    const transferReq = {
      asset_covenant_id: normalizeHex64OrEmpty(payload && payload.sell && payload.sell.asset_covenant_id),
      source_selection: 'automatic_backend',
      recipient_address: String(S.form.takerTokenReceiveAddress || '').trim(),
      transfer_amount_raw: kcc20DirectSwapSellAmountRaw(payload)
    };
    if (!transferReq.asset_covenant_id) throw new Error('kcc20_direct_swap_holder_transfer_asset_covenant_id_missing');
    if (!transferReq.recipient_address) throw new Error('kcc20_direct_swap_holder_transfer_recipient_required');
    if (!transferReq.transfer_amount_raw) throw new Error('kcc20_direct_swap_holder_transfer_amount_required');

    const build = await postJSON('/api/covenants/issuer-token/holder-transfer/build', transferReq);
    if (!build || build.ok !== true || build.transfer_build_kind !== 'oma_l1_holder_transfer_build_v1') {
      const err = new Error('kcc20_direct_swap_holder_transfer_build_failed');
      err.reason = build && build.reason ? String(build.reason) : 'kcc20_direct_swap_holder_transfer_build_failed';
      throw err;
    }

    const tx = kaspaSdk.Transaction.deserializeFromSafeJSON(build.txToSignSafeJson);
    const priv0 = new kaspaSdk.PrivateKey(priv0Hex);
    const expectedAddress = String(build.fromAddress || '').trim();
    const networkId = String(build.networkId || '').trim();
    if (expectedAddress && networkId) {
      const derived = String(priv0.toAddress(networkId).toString());
      if (derived !== expectedAddress) throw new Error('kcc20_direct_swap_active_key_does_not_match_holder_transfer_fromAddress');
    }

    const signCtx = build.signing_context_public && typeof build.signing_context_public === 'object' ? build.signing_context_public : {};
    const signInputIndexes = Array.isArray(build.signInputIndexes) ? build.signInputIndexes.map(function(v){ return Number(v); }) : [];
    const signSet = new Set(signInputIndexes);
    const holderInputs = Array.isArray(signCtx.holder_inputs) ? signCtx.holder_inputs.map(function(input){
      return {
        inputIndex: Number(input.input_index),
        sourceHolderOutpoint: String(input.source_holder_outpoint || ''),
        redeemScriptHex: String(input.source_holder_redeem_script_hex || '').trim()
      };
    }) : [];
    const fundingInputIndex = Number.isInteger(Number(signCtx.native_kas_funding_input_index)) ? Number(signCtx.native_kas_funding_input_index) : null;

    if (!holderInputs.length) throw new Error('kcc20_direct_swap_holder_inputs_missing');
    holderInputs.forEach(function(input){
      if (!Number.isInteger(input.inputIndex) || input.inputIndex < 0) throw new Error('kcc20_direct_swap_holder_input_index_invalid');
      if (!signSet.has(input.inputIndex)) throw new Error('kcc20_direct_swap_holder_input_not_signable');
      if (!/^[0-9a-f]+$/i.test(input.redeemScriptHex) || input.redeemScriptHex.length % 2 !== 0) throw new Error('kcc20_direct_swap_holder_redeem_script_missing');
    });
    if (fundingInputIndex !== null && !signSet.has(fundingInputIndex)) throw new Error('kcc20_direct_swap_native_funding_input_not_signable');

    const beforeHolderSignatureScriptsEmpty = holderInputs.every(function(input){
      const txInput = tx.inputs[input.inputIndex];
      return txInput && (!txInput.signatureScript || String(txInput.signatureScript).length === 0);
    });

    const dummySig = new Uint8Array(65);
    const scripts = holderInputs.map(function(input){
      return { input, script: kaspaSdk.ScriptBuilder.fromScript(input.redeemScriptHex) };
    });

    scripts.forEach(function(item){
      fillKcc20DirectSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(dummySig), 'kcc20_direct_swap_holder_input_missing_for_dummy_sig');
    });
    scripts.forEach(function(item){
      const sig = kaspaSdk.createInputSignature(tx, item.input.inputIndex, priv0, null);
      fillKcc20DirectSignatureScript(tx, item.input.inputIndex, item.script.encodePayToScriptHashSignatureScript(sig), 'kcc20_direct_swap_holder_input_missing_for_final_sig');
    });
    if (fundingInputIndex !== null) {
      const fundingSig = kaspaSdk.createInputSignature(tx, fundingInputIndex, priv0, null);
      fillKcc20DirectSignatureScript(tx, fundingInputIndex, fundingSig, 'kcc20_direct_swap_native_funding_input_missing_for_final_sig');
    }

    tx.finalize();
    const signedSafeJson = tx.serializeToSafeJSON();
    kaspaSdk.Transaction.deserializeFromSafeJSON(signedSafeJson);

    const holderSignatureScriptLengths = holderInputs.map(function(input){ return String(tx.inputs[input.inputIndex] && tx.inputs[input.inputIndex].signatureScript || '').length; });
    const signedSafeJsonSha256 = await sha256HexText(signedSafeJson);

    return {
      ok: true,
      stage: 'kcc20_direct_1h_holder_transfer_signed_no_submit_v1',
      plan_kind: planOut && planOut.plan_kind ? String(planOut.plan_kind) : '',
      transfer_build_kind: build.transfer_build_kind,
      application_status: 'kcc20_direct_swap_token_leg_signed_no_submit_v1',
      asset_covenant_id: build.asset_covenant_id || transferReq.asset_covenant_id,
      token_symbol: build.token_definition && build.token_definition.token_symbol ? String(build.token_definition.token_symbol) : String(payload && payload.sell && payload.sell.symbol || ''),
      fromAddress: build.fromAddress || '',
      recipient_address: transferReq.recipient_address,
      transfer_amount_raw: transferReq.transfer_amount_raw,
      selected_source_count: build.transfer_plan && build.transfer_plan.source_selection ? build.transfer_plan.source_selection.selected_source_count : null,
      selected_amount_raw_total: build.transfer_plan && build.transfer_plan.source_selection ? build.transfer_plan.source_selection.selected_amount_raw_total : '',
      recipient_amount_raw: build.transfer_plan && build.transfer_plan.recipient_holder_output ? build.transfer_plan.recipient_holder_output.amount_raw : '',
      sender_change_amount_raw: build.transfer_plan && build.transfer_plan.sender_change_holder_output ? build.transfer_plan.sender_change_holder_output.amount_raw : '0',
      same_asset_covenant_id_preserved: build.invariants && build.invariants.same_asset_covenant_id_preserved === true,
      amount_raw_conserved: build.invariants && build.invariants.amount_raw_conserved === true,
      native_refund_covenant_present: build.transfer_plan && build.transfer_plan.native_carrier_refund_output ? build.transfer_plan.native_carrier_refund_output.covenant_present === true : null,
      native_refund_normal_send_expected: build.transfer_plan && build.transfer_plan.native_carrier_refund_output ? build.transfer_plan.native_carrier_refund_output.normal_send_expected === true : null,
      submit_route: build.submit_route || '/api/covenants/issuer-token/holder-transfer/submit',
      submit_token_present: typeof build.submit_token === 'string' && build.submit_token.length > 0,
      signInputIndexes,
      holder_input_count: holderInputs.length,
      funding_input_index: fundingInputIndex,
      before_holder_signature_scripts_empty: beforeHolderSignatureScriptsEmpty,
      after_holder_signature_scripts_present: holderSignatureScriptLengths.every(function(n){ return Number(n) > 0; }),
      holder_signature_script_lengths: holderSignatureScriptLengths,
      native_funding_signature_script_present: fundingInputIndex === null ? null : (typeof tx.inputs[fundingInputIndex].signatureScript === 'string' && tx.inputs[fundingInputIndex].signatureScript.length > 0),
      signed_safe_json_sha256: signedSafeJsonSha256,
      signed_tx_deserialize_check_ok: true,
      submit_called: false,
      broadcasting: 'none',
      minting: 'none',
      wallet_mutation: 'none',
      private_key_printed: false,
      signed_transaction_printed: false,
      signature_script_printed: false,
      redeem_script_printed: false,
      submit_token_printed: false,
      signedSafeJson,
      submit_token: build.submit_token || '',
      transfer_build_safe_sha256: build.unsigned_safe_json_sha256 || ''
    };
  }

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

    const offerDescription = String(S.form.offerDescription || '').trim().slice(0, 2000);
    const offerInfoUrl = String(S.form.offerInfoUrl || '').trim().slice(0, 500);
    if (offerInfoUrl) {
      let parsedUrl = null;
      try { parsedUrl = new URL(offerInfoUrl); } catch (_) { parsedUrl = null; }
      if (!parsedUrl || (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:')) {
        const err = new Error('invalid_offer_info_url');
        err.reason = 'More information URL must start with https:// or http://.';
        throw err;
      }
    }

    // SELL from wallet token selector/context. KCC20-DIRECT-1F preserves OMA L1 covenant-token identity.
    const tokenSel = document.getElementById('tokenSelect');
    const assetRaw = tokenSel ? String(tokenSel.value || 'KAS').trim() : 'KAS';
    const sellName = S.sendContext && typeof S.sendContext.assetName === 'string'
      ? S.sendContext.assetName.trim()
      : '';
    let sellType = 'KAS';
    let sellSymbol = 'KAS';
    let sell = null;
    if (isOmaL1Kcc20DirectSwapContext()) {
      const assetCovenantId = normalizeHex64OrEmpty(S.sendContext && S.sendContext.assetCovenantId);
      if (!assetCovenantId) {
        const err = new Error('kcc20_direct_swap_asset_covenant_id_missing');
        err.reason = 'Selected OMA L1 / KCC20-compatible asset is missing its covenant ID. Refresh holdings and try again.';
        throw err;
      }
      sellType = 'OMA_L1_COVENANT_TOKEN';
      sellSymbol = String((S.sendContext && S.sendContext.tokenSymbol) || sellName || 'OMA_L1').trim() || 'OMA_L1';
      sell = {
        type: sellType,
        symbol: sellSymbol,
        name: sellName || sellSymbol,
        asset_covenant_id: assetCovenantId,
        route: 'oma_l1_holder_transfer',
        standard: 'oma_l1_covenant_token_profile_v0_1',
        swap_context_kind: 'kcc20_direct_1f_swaps_modal_preserve_oma_l1_direct_context_v1'
      };
    } else if (assetRaw.toUpperCase() === 'KAS') {
      sellType = 'KAS';
      sellSymbol = 'KAS';
      sell = { type: sellType, symbol: sellSymbol };
    } else {
      sellType = 'KRC20';
      sellSymbol = assetRaw.toUpperCase();
      sell = { type: sellType, symbol: sellSymbol };
      if (sellName && /^CA:/i.test(sellSymbol)) {
        sell.name = sellName;
      }
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

    // TTL → seconds for analyzer. ttl=0 means Good Till Cancelled (no automatic expiry).
    let ttlSeconds = 0;
    if (S.form.ttlMode === 'eod') {
      const now = new Date();
      const end = new Date(now);
      end.setHours(24, 0, 0, 0);
      let diff = Math.floor((end.getTime() - now.getTime()) / 1000);
      if (!Number.isFinite(diff) || diff <= 0) diff = 60;
      if (diff > 168*60*60) diff = 168*60*60;
      ttlSeconds = diff;
    } else if (S.form.ttlMode === 'gtc') {
      ttlSeconds = 0;
    } else {
      const h = Number(S.form.ttlHours || 0);
      const hours = (Number.isFinite(h) && h > 0) ? Math.min(168, Math.max(1, h)) : 4;
      ttlSeconds = Math.round(hours * 60 * 60);
    }

    // After (return object with explicit sell_amount & buy_amount)
    return {
      sell,
      buy,
      amount,
      sell_amount: amount,
      buy_amount: buyAmountRaw,
      offerDescription,
      offerInfoUrl,
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
      case 'ttl_out_of_range': return 'TTL must be 0 for GTC, or between 1 hour and 7 days (168 hours).';
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
      if (isKcc20DirectSwapPayload(payload)) {
        const takerAddr = String(S.form.takerTokenReceiveAddress || '').trim();
        const isKcc20AtomicOpen = !takerAddr;
        const out = isKcc20AtomicOpen
          ? await buildKcc20AtomicOpenMakerLockFromPayload(payload)
          : await buildKcc20AtomicDirectMakerLockFromPayload(payload);
        if (r) r.innerHTML = isKcc20AtomicOpen
          ? renderKcc20AtomicOpenMakerLockPanel(out, null)
          : renderKcc20AtomicDirectMakerLockPanel(out, null);
        const analyzerOut = buildKcc20DirectSwapAnalyzerMetadata({
          ok: out && out.ok === true,
          asset_covenant_id: out && out.asset_covenant_id,
          token_definition: out && out.token_definition,
          direct_swap_plan: {
            token_leg: {
              transfer_amount_raw: out && out.atomic_swap_terms ? out.atomic_swap_terms.lock_amount_raw : payload.sell_amount,
              selected_source_count: out && out.source_selection ? out.source_selection.selected_source_count : '',
              selected_holder_amount_raw_total: out && out.source_selection ? out.source_selection.selected_amount_raw_total : '',
              sender_change_amount_raw: out && out.maker_lock_plan && out.maker_lock_plan.maker_change_holder_output ? out.maker_lock_plan.maker_change_holder_output.amount_raw : '0',
              holder_transfer_build_route: isKcc20AtomicOpen ? '/api/covenants/issuer-token/atomic-swap/open/maker-lock/build' : '/api/covenants/issuer-token/atomic-swap/direct/maker-lock/build'
            },
            kas_leg: {
              requested_kas_price_kas: out && out.atomic_swap_terms ? out.atomic_swap_terms.kas_price_kas : payload.buy_amount,
              payment_verification_status: 'atomic_maker_lock_build_ready'
            }
          },
          taker_recipient_address: isKcc20AtomicOpen ? 'Dynamic at claim' : (out && out.atomic_swap_terms ? out.atomic_swap_terms.taker_token_receive_address : S.form.takerTokenReceiveAddress),
          maker_kas_receive_address: out && out.atomic_swap_terms ? out.atomic_swap_terms.maker_kas_receive_address : payload.receiveEndpoint.address
        }, payload);
        renderAnalyzerPanel(
          analyzerOut,
          payload,
          [],
          [isKcc20AtomicOpen
            ? 'KCC20 Atomic Open Swap build is ready. Click Sign & Create Atomic Open Swap to sign and submit the dynamic-taker maker-lock from this wallet UI.'
            : 'KCC20 Atomic Direct Swap build is ready. Click Sign & Create Atomic Direct Swap to sign and submit the maker-lock from this wallet UI.']
        );
        const expectedStatus = isKcc20AtomicOpen
          ? 'kcc20_atomic_open_swap_maker_lock_unsigned_build_only_no_submit_v1'
          : 'kcc20_atomic_swap_maker_lock_unsigned_build_only_no_submit_v1';
        if (out && out.ok === true && out.application_status === expectedStatus) {
          $('btnBind')?.removeAttribute('disabled');
        } else {
          $('btnBind')?.setAttribute('disabled','');
        }
        await enforceOfferCreateGate();
        return;
      }

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
    hideOfferCreateSuccess();

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

    if (isKcc20DirectSwapPayload(payload)) {
      const isKcc20AtomicOpen = !takerAddr;
      const cfm = await window.CW_showConfirm({
        to: isKcc20AtomicOpen ? recv : takerAddr,
        amount: String(payload.sell_amount || '').trim() || '—',
        ticker: String(sellSym || 'OMA L1'),
        network,
        confirmLabel: isKcc20AtomicOpen ? 'Sign & Create Atomic Open Swap' : 'Sign & Create Atomic Direct Swap',
        cancelLabel: 'Cancel',
        sendingText: isKcc20AtomicOpen ? 'Building Open atomic maker-lock…' : 'Building atomic maker-lock…'
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

      try {
        try { cfm.setSendingText && cfm.setSendingText(isKcc20AtomicOpen ? 'Building Open atomic maker-lock…' : 'Building atomic maker-lock…'); } catch (_) {}
        if (r) r.textContent = isKcc20AtomicOpen ? 'Building Open atomic maker-lock…' : 'Building atomic maker-lock…';
        const build = isKcc20AtomicOpen
          ? await buildKcc20AtomicOpenMakerLockFromPayload(payload)
          : await buildKcc20AtomicDirectMakerLockFromPayload(payload);
        if (r) r.innerHTML = isKcc20AtomicOpen
          ? renderKcc20AtomicOpenMakerLockPanel(build, null)
          : renderKcc20AtomicDirectMakerLockPanel(build, null);

        try { cfm.setSendingText && cfm.setSendingText(isKcc20AtomicOpen ? 'Signing Open atomic maker-lock…' : 'Signing atomic maker-lock…'); } catch (_) {}
        if (r) r.textContent = isKcc20AtomicOpen ? 'Signing Open atomic maker-lock…' : 'Signing atomic maker-lock…';
        const signed = isKcc20AtomicOpen
          ? await signKcc20AtomicOpenMakerLock(build, priv0Hex)
          : await signKcc20AtomicDirectMakerLock(build, priv0Hex);

        try { cfm.setSendingText && cfm.setSendingText(isKcc20AtomicOpen ? 'Submitting Open atomic maker-lock…' : 'Submitting atomic maker-lock…'); } catch (_) {}
        if (r) r.textContent = isKcc20AtomicOpen ? 'Submitting Open atomic maker-lock…' : 'Submitting atomic maker-lock…';
        const submitOut = isKcc20AtomicOpen
          ? await submitKcc20AtomicOpenMakerLock(build, signed)
          : await submitKcc20AtomicDirectMakerLock(build, signed);

        if (!submitOut || submitOut.ok !== true) {
          throw new Error(submitOut && submitOut.reason ? String(submitOut.reason) : (isKcc20AtomicOpen ? 'kcc20_atomic_open_swap_maker_lock_submit_failed' : 'kcc20_atomic_swap_maker_lock_submit_failed'));
        }

        S.kcc20AtomicDirectDraft = {
          draft_kind: isKcc20AtomicOpen ? 'kcc20_atomic_open_swap_wallet_ui_maker_lock_submitted_v1' : 'kcc20_atomic_swap_wallet_ui_maker_lock_submitted_v1',
          created_at_ms: Date.now(),
          payload,
          build_summary: {
            build_kind: build.build_kind,
            application_status: build.application_status,
            unsigned_safe_json_sha256: build.unsigned_safe_json_sha256,
            txid_preview: build.txid_preview
          },
          signed_summary: Object.assign({}, signed, { signedSafeJson: undefined }),
          submit_summary: submitOut
        };

        if (r) r.innerHTML = isKcc20AtomicOpen
          ? renderKcc20AtomicOpenMakerLockPanel(build, submitOut)
          : renderKcc20AtomicDirectMakerLockPanel(build, submitOut);
        const submittedMsg = isKcc20AtomicOpen
          ? 'KCC20 Atomic Open Swap created. Maker-lock is live and listed; any taker can claim it from Open Swap Offers.'
          : 'KCC20 Atomic Direct Swap created. Maker-lock is live and tracked; the taker can claim it from the swap listing flow.';
        showOfferCreateSuccess(submittedMsg);
        try { cfm.setSuccess(submittedMsg); } catch (_) {}
        try { cfm.close(); } catch (_) {}
        $('btnBind')?.setAttribute('disabled','');
        return submitOut;
      } catch (e) {
        const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : (isKcc20AtomicOpen ? 'KCC20 Open atomic maker-lock failed.' : 'KCC20 atomic maker-lock failed.');
        if (r) r.textContent = 'Make Offer failed: ' + msg;
        try { cfm.setError('Make Offer failed: ' + msg); } catch (_) {}
        return;
      }
    }

    const isOpenOffer = !takerAddr;
    let openOfferQuantity = 1;
    if (isOpenOffer) {
      try {
        const requestedQuantity = promptOpenOfferQuantity();
        if (requestedQuantity === null) {
          if (r) r.textContent = 'Cancelled.';
          return;
        }
        openOfferQuantity = requestedQuantity;
      } catch (e) {
        const msg = e && (e.reason || e.message) ? String(e.reason || e.message) : 'Invalid open offer quantity.';
        if (r) r.textContent = 'Make Offer failed: ' + msg;
        return;
      }
    }

    // This is a signing operation (swap offer); requires unlocked keyfile session
    const cfm = await window.CW_showConfirm({
      to: recv || '—',
      amount: String(payload.buy_amount || '').trim() || '—',
      ticker: String(sellSym || 'Swap'),
      network,
      confirmLabel: takerAddr ? 'Create Offer' : (openOfferQuantity > 1 ? ('Create ' + openOfferQuantity + ' Open Offers') : 'Create Open Offer'),
      cancelLabel: 'Cancel',
      sendingText: takerAddr ? 'Creating offer…' : (openOfferQuantity > 1 ? ('Creating open offers 1 of ' + openOfferQuantity + '…') : 'Creating open offer…')
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

    if (r) r.textContent = isOpenOffer
      ? (openOfferQuantity > 1 ? ('Creating open offers 1 of ' + openOfferQuantity + '…') : 'Creating open offer…')
      : 'Making swap offer…';

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
          offerDescription: String(payload.offerDescription || '').trim(),
          offerInfoUrl: String(payload.offerInfoUrl || '').trim(),
          complianceOnly: !!payload.complianceOnly,
          ttl: (typeof payload.ttl === 'number' ? payload.ttl : 0) || 0,
          partial: { enabled: false }
        };

        const openOfferBatchId = openOfferQuantity > 1 ? makeOpenOfferBatchId() : '';

        let createdOpenCount = 0;
        for (let openOfferIndex = 0; openOfferIndex < openOfferQuantity; openOfferIndex++) {
          if (r) r.textContent = openOfferQuantity > 1
            ? ('Creating open offer ' + (openOfferIndex + 1) + ' of ' + openOfferQuantity + '…')
            : 'Creating open offer…';

          const openOfferRequest = Object.assign({}, openReq);

          if (openOfferBatchId) {
            openOfferRequest.openOfferBatchId = openOfferBatchId;
            openOfferRequest.openOfferBatchIndex = openOfferIndex + 1;
            openOfferRequest.openOfferBatchTotal = openOfferQuantity;
          }

          const openPrep = await window.openSwapV2.prepare(openOfferRequest);
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

          createdOpenCount += 1;
        }

        var createdOpenMsg = createdOpenCount === 1
          ? 'Open offer draft created.'
          : ('Created ' + createdOpenCount + ' open offers.');
        if (r) r.textContent = createdOpenMsg;
        showOfferCreateSuccess(createdOpenMsg);
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
      showOfferCreateSuccess(createdMsg);

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
  .omodal{
    position:fixed;
    inset:0;
    padding:1rem;
    background:rgba(var(--td-skin-black-rgb), 0.42);
    backdrop-filter: blur(6px);
    display:flex;
    align-items:center;
    justify-content:center;
    z-index:10000;
    overflow:auto;
  }

  /* Keep modal CSS layout-only. The actual skin surfaces come from static/css/style.css:
     .card, input/select/textarea, button, and table[role="grid"]. */
  .omodal .card{
    width:min(940px, 92vw);
    max-height:92vh;
    overflow:auto;
  }

  .omodal .h{
    display:flex;
    align-items:center;
    justify-content:space-between;
    font-weight:600;
    margin-bottom:8px;
  }

  .omodal .grid{ display:grid; gap:12px }
  .omodal .grid.two{ grid-template-columns: 1fr 1fr }
  .omodal .row{ display:flex; gap:8px; align-items:center }

  .omodal label{
    display:block;
    font-size:12px;
    margin-bottom:4px;
  }

  .omodal .note{
    font-size:12px;
  }

  .omodal .swap-create-success{
    margin:.75rem 0 1rem;
    padding:.75rem .85rem;
    border:1px solid var(--td-skin-success);
    border-radius:12px;
    background:rgba(var(--td-skin-table-row-rgb), .98);
    color:var(--td-skin-text-strong);
    box-shadow:
      0 0 0 1px rgba(var(--td-skin-border-rgb), .12),
      0 0 18px rgba(var(--td-skin-primary-glow-rgb), .14);
    font-weight:850;
    word-break:break-word;
    overflow-wrap:anywhere;
    outline:none;
  }

  .omodal .panel{
    border-radius:14px;
    border:1px solid rgba(var(--td-skin-border-rgb), 0.55);
    padding:10px;
    background:rgba(var(--td-skin-table-bg-rgb), 0.72);
    color:var(--td-skin-text);
    box-shadow:
      0 0 0 1px rgba(var(--td-skin-panel-rgb), 0.82),
      0 0 18px rgba(var(--td-skin-primary-glow-rgb), 0.18);
  }

  .omodal hr{
    border:none;
    border-top:1px solid rgba(var(--td-skin-muted-rgb), 0.35);
    margin:12px 0;
  }

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
    border:1px solid rgba(var(--td-skin-border-rgb), 0.55);
    background:rgba(var(--td-skin-table-row-rgb), 0.45);
    box-shadow:none;
    pointer-events:none;
    flex:0 0 auto;
  }

  .omodal #complianceOnly:checked{
    background:var(--td-skin-primary);
    border-color:var(--td-skin-primary);
    box-shadow:0 0 0 1px rgba(var(--td-skin-primary-rgb), 0.45), 0 0 12px rgba(var(--td-skin-primary-glow-rgb), 0.35);
  }

  .omodal .suggest{ position:relative }
  .omodal .suggest .menu{
    position:absolute;
    top:calc(100% + 6px);
    left:0;
    right:0;
    background:
      radial-gradient(circle at top left, rgba(var(--td-skin-primary-glow-rgb), 0.18), rgba(var(--td-skin-panel-rgb), 0.98));
    border: 1px solid rgba(var(--td-skin-border-rgb), 0.65);
    border-radius:12px;
    overflow:hidden;
    color:var(--td-skin-text);
    box-shadow:
      0 0 0 1px rgba(var(--td-skin-panel-rgb), 1),
      0 18px 40px rgba(var(--td-skin-black-rgb), 0.28);
  }
  .omodal .suggest .item{ padding:8px 10px; cursor:pointer }
  .omodal .suggest .item:hover{ background: rgba(var(--td-skin-primary-glow-rgb), 0.14) }
  .omodal .suggest .t{ font-weight:600; color:var(--td-skin-text-strong) }
  .omodal .suggest .s{ font-size:12px; color:var(--td-skin-text-muted); opacity:1 }

  .omodal .trade-row{ display:grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap:8px; align-items:flex-end }
  .omodal .trade-col{ min-width:0 }
  .omodal .ttl-fields{ display:flex; gap:6px; align-items:center }
  @media (max-width: 900px){
    .trade-row{ grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  }
  
`;
  document.head.append(css);

})();
