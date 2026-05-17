(() => {
  function toText(value) {
    if (value === 0 || value === false) return String(value);
    return String(value || '').trim();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setNodeText(node, value, fallback) {
    if (!node) return;
    const text = toText(value);
    node.textContent = text || (fallback != null ? String(fallback) : '—');
  }

  function setNodeHtml(node, html) {
    if (!node) return;
    node.innerHTML = html || '';
  }

  function setNodeHref(node, url) {
    if (!node) return;
    const href = toText(url);
    if (href) {
      node.href = href;
      node.style.display = '';
    } else {
      node.removeAttribute('href');
      node.style.display = 'none';
    }
  }

  function formatInt(value) {
    if (value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function addThousandsSeparators(value) {
    const digits = String(value || '').trim();
    if (!digits) return '0';
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatSupply(value, decimals) {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';

    const dec = Number(decimals);
    if (!/^-?\d+$/.test(raw) || !Number.isFinite(dec) || dec < 0) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw;
      return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    const negative = raw.startsWith('-');
    const digits = negative ? raw.slice(1) : raw;
    const padded = digits.padStart(dec + 1, '0');
    const intRaw = padded.slice(0, padded.length - dec) || '0';
    const fracRaw = dec > 0 ? padded.slice(padded.length - dec) : '';
    const fracTrimmed = fracRaw.replace(/0+$/, '');
    const intDisplay = addThousandsSeparators(intRaw.replace(/^0+(?=\d)/, '') || '0');
    const display = fracTrimmed ? `${intDisplay}.${fracTrimmed}` : intDisplay;
    return negative ? `-${display}` : display;
  }

  function normalizeRefs(refs) {
    const root = refs && typeof refs === 'object' ? refs : {};
    return {
      panel: root.panel || null,
      summary: root.summary || null,
      hints: root.hints || null,
      statusBadge: root.statusBadge || null,
      blockers: root.blockers || null,
      notes: root.notes || null,
      summarySellAsset: root.summarySellAsset || null,
      summarySellAmount: root.summarySellAmount || null,
      summaryBuyAsset: root.summaryBuyAsset || null,
      summaryBuyAmount: root.summaryBuyAmount || null,
      sellMeta: root.sellMeta && typeof root.sellMeta === 'object' ? root.sellMeta : {},
      buyMeta: root.buyMeta && typeof root.buyMeta === 'object' ? root.buyMeta : {}
    };
  }

  function getTrade(out, payload) {
    const trade = out && typeof out.trade === 'object' ? out.trade : {};
    const sell = trade.sell && typeof trade.sell === 'object' ? trade.sell : ((payload && payload.sell) || {});
    const buy = trade.buy && typeof trade.buy === 'object' ? trade.buy : ((payload && payload.buy) || {});
    return { trade, sell, buy };
  }

  function formatAssetDisplayLabel(asset, symbol) {
    const sym = toText(symbol);
    const name = asset && typeof asset.name === 'string' ? asset.name.trim() : '';
    if (name && /^CA:/i.test(sym)) return `${name} ${sym}`;
    return sym;
  }

  function getSellAmount(out, payload, trade) {
    return toText(
      out && out.sell_amount != null ? out.sell_amount :
      trade && trade.sell_amount != null ? trade.sell_amount :
      payload && payload.sell_amount != null ? payload.sell_amount :
      payload && payload.amount != null ? payload.amount : ''
    );
  }

  function getBuyAmount(out, payload, trade) {
    return toText(
      out && out.buy_amount != null ? out.buy_amount :
      trade && trade.buy_amount != null ? trade.buy_amount :
      payload && payload.buy_amount != null ? payload.buy_amount : ''
    );
  }

  function clearOfferStructure(refs) {
    setNodeText(refs.summarySellAsset, '', '—');
    setNodeText(refs.summarySellAmount, '', '—');
    setNodeText(refs.summaryBuyAsset, '', '—');
    setNodeText(refs.summaryBuyAmount, '', '—');
  }

  function renderOfferStructure(refs, out, payload, paymentDisplayLabel) {
    const tradeBits = getTrade(out, payload);
    const sell = tradeBits.sell;
    const buy = tradeBits.buy;
    const trade = tradeBits.trade;

    const sellSym = toText(sell.symbol || sell.ticker || sell.assetId);
    const buySym = toText(buy.symbol || buy.ticker || buy.assetId);
    const sellLabel = formatAssetDisplayLabel(sell, sellSym);
    const buyLabelRaw = formatAssetDisplayLabel(buy, buySym);
    const buySymDisplay = buySym === 'KAS' ? (toText(paymentDisplayLabel) || 'KAS') : buyLabelRaw;

    const sellAmtStr = getSellAmount(out, payload, trade);
    const buyAmtStr = getBuyAmount(out, payload, trade);

    setNodeText(refs.summarySellAsset, sellLabel, '—');
    setNodeText(refs.summarySellAmount, sellAmtStr, '—');
    setNodeText(refs.summaryBuyAsset, buySymDisplay, '—');
    setNodeText(refs.summaryBuyAmount, buyAmtStr, '—');

    return {
      sellSym,
      sellLabel,
      buySym,
      buySymDisplay,
      sellAmtStr,
      buyAmtStr,
      trade
    };
  }

  function clearAssetMetaSide(sideRefs) {
    setNodeText(sideRefs.header, '', '—');
    setNodeText(sideRefs.ticker, '', '—');
    setNodeText(sideRefs.name, '', '—');
    setNodeText(sideRefs.type, '', '—');
    setNodeText(sideRefs.decimals, '', '—');
    setNodeText(sideRefs.contractAddress, '', '—');
    setNodeText(sideRefs.totalMinted, '', '—');
    setNodeText(sideRefs.maxSupply, '', '—');
    setNodeText(sideRefs.holders, '', '—');
    setNodeText(sideRefs.transfers, '', '—');
    setNodeText(sideRefs.mints, '', '—');
    setNodeHref(sideRefs.explorerLink, null);
  }

  function renderAssetMetaSide(sideName, sideRefs, meta, paymentDisplayLabel) {
    const kind = toText(meta && meta.kind);
    const ticker = toText(meta && meta.ticker);
    const symbol = toText(meta && meta.symbol);
    const name = toText(meta && meta.name);
    const ca = toText(meta && meta.ca);

    const paymentDisplay = toText(paymentDisplayLabel) || 'KAS';
    const isBuyKas = sideName === 'Buy' && (ticker === 'KAS' || symbol === 'KAS' || kind === 'KAS');
    const headerText = sideName === 'Buy' ? 'Settlement asset' : 'Offered asset';
    const tickerText = isBuyKas ? paymentDisplay : ticker;
    const nameText = isBuyKas ? paymentDisplay : name;

    setNodeText(sideRefs.header, headerText, sideName === 'Buy' ? 'Settlement asset' : 'Offered asset');
    setNodeText(sideRefs.ticker, tickerText, '—');
    setNodeText(sideRefs.name, nameText, '—');
    setNodeText(sideRefs.type, kind, '—');
    setNodeText(sideRefs.decimals, meta && meta.decimals != null ? String(meta.decimals) : '', '—');

    if (sideName === 'Sell') {
      setNodeText(sideRefs.contractAddress, ca, '—');
      setNodeText(sideRefs.totalMinted, formatSupply(meta && meta.totalMinted, meta && meta.decimals), '—');
      setNodeText(sideRefs.maxSupply, formatSupply(meta && meta.maxSupply, meta && meta.decimals), '—');
      setNodeText(sideRefs.holders, formatInt(meta && meta.holderTotal), '—');
      setNodeText(sideRefs.transfers, formatInt(meta && meta.transferTotal), '—');
      setNodeText(sideRefs.mints, formatInt(meta && meta.mintTotal), '—');
    }

    setNodeHref(sideRefs.explorerLink, meta && meta.explorerUrl ? meta.explorerUrl : null);
  }

  function clearAnalyzer(refsInput) {
    const refs = normalizeRefs(refsInput);

    setNodeText(refs.summary, '', '');
    setNodeText(refs.hints, '', '');
    setNodeText(refs.statusBadge, '', '');
    setNodeHtml(refs.blockers, '');
    setNodeHtml(refs.notes, '');

    clearOfferStructure(refs);
    clearAssetMetaSide(refs.sellMeta);
    clearAssetMetaSide(refs.buyMeta);
  }

  function renderAnalyzer(args) {
    const opts = args && typeof args === 'object' ? args : {};
    const refs = normalizeRefs(opts.refs);
    const out = opts.out || null;
    const payload = opts.payload || null;
    const blockers = Array.isArray(opts.blockers) ? opts.blockers : [];
    const notes = Array.isArray(opts.notes) ? opts.notes : [];
    const paymentDisplayLabel = toText(opts.paymentDisplayLabel) || 'KAS';
    const fromAddress = toText(opts.fromAddress);

    if (!refs.panel) return;

    if (!out) {
      clearAnalyzer(refs);
      return;
    }

    const structure = renderOfferStructure(refs, out, payload, paymentDisplayLabel);

    if (refs.summary) {
      if (structure.sellSym || structure.buySymDisplay) {
        const parts = [];
        if (structure.sellAmtStr && structure.sellLabel) {
          parts.push(`Offered asset: ${structure.sellAmtStr} ${structure.sellLabel}`);
        }
        if (structure.buyAmtStr && structure.buySymDisplay) {
          parts.push(`Settlement: ${structure.buyAmtStr} ${structure.buySymDisplay}`);
        }
        refs.summary.textContent = parts.join(' · ') || 'Offer summary unavailable.';
      } else {
        refs.summary.textContent = 'Offer summary unavailable.';
      }
    }

    const receiveEndpoint = out && typeof out.receiveEndpoint === 'object'
      ? out.receiveEndpoint
      : ((payload && payload.receiveEndpoint) || {});

    const recvAddr = toText(receiveEndpoint.address);
    let ttlSec = null;
    if (typeof out.ttl === 'number') ttlSec = out.ttl;
    else if (typeof structure.trade.ttl === 'number') ttlSec = structure.trade.ttl;
    else if (payload && typeof payload.ttl === 'number') ttlSec = payload.ttl;

    let ttlHint = '';
    if (typeof ttlSec === 'number' && ttlSec > 0) {
      const hrs = ttlSec / 3600;
      const hrsRounded = Math.round(hrs * 10) / 10;
      ttlHint = `${hrsRounded}h TTL`;
    }

    if (refs.hints) {
      const bits = [];
      if (fromAddress) bits.push(`From wallet: ${fromAddress}`);
      if (recvAddr) bits.push(`Settlement address: ${recvAddr}`);
      if (ttlHint) bits.push(`Offer lifetime: ${ttlHint}`);
      refs.hints.textContent = bits.join(' · ');
    }

    const assetMeta = out && typeof out.assetMeta === 'object' ? out.assetMeta : {};
    const sellMeta = assetMeta.sell && typeof assetMeta.sell === 'object' ? assetMeta.sell : {};
    const buyMeta = assetMeta.buy && typeof assetMeta.buy === 'object' ? assetMeta.buy : {};

    renderAssetMetaSide('Sell', refs.sellMeta, sellMeta, paymentDisplayLabel);
    renderAssetMetaSide('Buy', refs.buyMeta, buyMeta, paymentDisplayLabel);

    const filteredNotes = notes.filter((note) => {
      return toText(note) !== 'Analyzer: M4-KRC-4a (KRC20 TICK/CA for KAS).';
    });

    if (refs.blockers) {
      if (!blockers.length) {
        refs.blockers.innerHTML = '';
      } else {
        refs.blockers.innerHTML = `<ul>${blockers.map((b) => `<li>${escapeHtml(toText(b))}</li>`).join('')}</ul>`;
      }
    }

    const solvency = out && typeof out.solvency === 'object' ? out.solvency : {};
    const fees = out && typeof out.fees === 'object' ? out.fees : {};
    const sellOk = typeof solvency.sell_ok === 'boolean' ? solvency.sell_ok : null;
    const feeOk = typeof solvency.fee_ok === 'boolean' ? solvency.fee_ok : null;
    const feeKas = typeof fees.kas === 'number' ? fees.kas : null;

    const extraNotes = [];
    if (sellOk === true) {
      extraNotes.push('Sufficient offered asset balance confirmed.');
    } else if (sellOk === false) {
      extraNotes.push('Not enough offered asset balance for this offer.');
    }

    if (feeOk === true) {
      extraNotes.push('Sufficient KAS is available for the estimated network fee.');
    } else if (feeOk === false) {
      extraNotes.push('Not enough KAS is available for the estimated network fee.');
    }

    if (sellOk === null && feeOk === null && feeKas === null) {
      extraNotes.push('Balance and fee checks are not yet available; Analyzer validated the current offer structure only.');
    }

    if (refs.notes) {
      const combinedNotes = filteredNotes.concat(extraNotes);
      if (!combinedNotes.length) {
        refs.notes.innerHTML = '';
      } else {
        refs.notes.innerHTML = `<ul>${combinedNotes.map((n) => `<li>${escapeHtml(toText(n))}</li>`).join('')}</ul>`;
      }
    }

    if (refs.statusBadge) {
      if (blockers.length > 0 || out.ok === false) {
        refs.statusBadge.textContent = 'Resolve issues before creating offer';
      } else if (sellOk === false || feeOk === false) {
        refs.statusBadge.textContent = 'Action required before offer creation';
      } else {
        refs.statusBadge.textContent = 'Ready for offer creation';
      }
    }
  }

  window.SwapAnalyzerShared = Object.freeze({
    formatInt,
    addThousandsSeparators,
    formatSupply,
    clearAnalyzer,
    renderAnalyzer
  });
})();
