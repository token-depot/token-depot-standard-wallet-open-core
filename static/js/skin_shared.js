(function () {
  var ACTIVE_SKIN_SESSION_KEY = 'td_active_skin_id';
  var ACTIVE_CLIENT_UI_MODE_SESSION_KEY = 'td_active_client_ui_mode';
  var allowed = { classic_teal: true, pink: true, pink_black: true, gold: true, gold_black: true, blue: true, blue_black: true, green: true, green_black: true, red: true, red_black: true, yellow: true, yellow_black: true, cyan: true, cyan_black: true, orange: true, orange_black: true };
  var allowedClientUiModes = { broker_compliance: true, operator_oma_only: true };
  var operatorOmaOnlyMutationTimer = null;
  var operatorOmaOnlyObserverStarted = false;

  function normalizeSkinId(value) {
    var skinId = String(value || '').trim();
    return allowed[skinId] ? skinId : 'classic_teal';
  }

  function normalizeClientUiMode(value) {
    var mode = String(value || '').trim();
    return allowedClientUiModes[mode] ? mode : 'broker_compliance';
  }

  function readCachedSkinId() {
    try {
      var cachedSkinId = String(sessionStorage.getItem(ACTIVE_SKIN_SESSION_KEY) || '').trim();
      return allowed[cachedSkinId] ? cachedSkinId : '';
    } catch (_) {
      return '';
    }
  }

  function readCachedClientUiMode() {
    try {
      var cachedMode = String(sessionStorage.getItem(ACTIVE_CLIENT_UI_MODE_SESSION_KEY) || '').trim();
      return allowedClientUiModes[cachedMode] ? cachedMode : '';
    } catch (_) {
      return '';
    }
  }

  function writeCachedSkinId(value) {
    var skinId = normalizeSkinId(value);
    try { sessionStorage.setItem(ACTIVE_SKIN_SESSION_KEY, skinId); } catch (_) {}
    return skinId;
  }

  function writeCachedClientUiMode(value) {
    var mode = normalizeClientUiMode(value);
    try { sessionStorage.setItem(ACTIVE_CLIENT_UI_MODE_SESSION_KEY, mode); } catch (_) {}
    return mode;
  }

  function applySkin(value) {
    if (!document.body) return;
    document.body.setAttribute('data-skin', writeCachedSkinId(value));
  }

  function applyClientUiMode(value) {
    if (!document.body) return;
    var mode = writeCachedClientUiMode(value);
    document.body.setAttribute('data-client-ui-mode', mode);
    if (mode === 'operator_oma_only') applyOperatorOmaOnlyUi();
  }

  function applyCachedSkinHint() {
    if (!document.body) return;
    var cachedSkinId = readCachedSkinId();
    if (cachedSkinId) document.body.setAttribute('data-skin', cachedSkinId);
  }

  function applyCachedClientUiModeHint() {
    if (!document.body) return;
    var cachedMode = readCachedClientUiMode();
    if (cachedMode) {
      document.body.setAttribute('data-client-ui-mode', cachedMode);
      if (cachedMode === 'operator_oma_only') applyOperatorOmaOnlyUi();
    }
  }

  function currentPageHref() {
    return (window.location.pathname || '/') + (window.location.search || '') + (window.location.hash || '');
  }

  function hideElement(el) {
    if (!el) return;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
  }

  function hideElementAndFollowingBreak(el) {
    hideElement(el);
    var next = el && el.nextSibling;
    while (next && next.nodeType === 3 && !String(next.nodeValue || '').trim()) next = next.nextSibling;
    if (next && next.nodeType === 1 && String(next.tagName || '').toUpperCase() === 'BR') hideElement(next);
  }

  function replaceTextInElement(el, from, to) {
    if (!el) return;
    el.textContent = String(el.textContent || '').split(from).join(to);
  }

  function replaceVisibleText(from, to) {
    if (!document.body || !from) return;
    var skip = { SCRIPT: true, STYLE: true, TEXTAREA: true, INPUT: true, SELECT: true, OPTION: true, CODE: true, PRE: true };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node && node.parentElement;
        if (!parent || skip[parent.tagName]) return NodeFilter.FILTER_REJECT;
        return String(node.nodeValue || '').indexOf(from) >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      node.nodeValue = String(node.nodeValue || '').split(from).join(to);
    });
  }

  function hideContainingText(text) {
    if (!document.body || !text) return;
    var candidates = Array.prototype.slice.call(document.querySelectorAll('p, small, label, div, section, article'));
    var matches = candidates.filter(function (el) {
      return String(el.textContent || '').indexOf(text) >= 0;
    });
    matches.sort(function (a, b) {
      return String(a.textContent || '').length - String(b.textContent || '').length;
    });
    if (matches[0]) hideElement(matches[0]);
  }

  function hideLabelForInputId(id) {
    var input = document.getElementById(id);
    if (!input) return;
    var label = input.closest('label');
    hideElement(label || input);
  }

  function hideOperatorModeComplianceRows() {
    if (!document.body) return;
    Array.prototype.slice.call(document.querySelectorAll('.grouped-offer-row span, .grouped-offer-row div')).forEach(function (el) {
      if (String(el.textContent || '').trim() !== 'COMPLIANCE') return;
      hideElement(el.closest('.grouped-offer-row') || el);
    });
  }

  function scheduleOperatorOmaOnlyUi() {
    if (readCachedClientUiMode() !== 'operator_oma_only') return;
    if (operatorOmaOnlyMutationTimer) clearTimeout(operatorOmaOnlyMutationTimer);
    operatorOmaOnlyMutationTimer = setTimeout(function () {
      operatorOmaOnlyMutationTimer = null;
      applyOperatorOmaOnlyUi();
    }, 25);
  }

  function startOperatorOmaOnlyObserver() {
    if (operatorOmaOnlyObserverStarted || !document.body || typeof MutationObserver !== 'function') return;
    operatorOmaOnlyObserverStarted = true;
    new MutationObserver(scheduleOperatorOmaOnlyUi).observe(document.body, { childList: true, subtree: true });
  }

  function applyOperatorOmaOnlyUi() {
    if (!document.body) return;

    Array.prototype.slice.call(document.querySelectorAll('a[href="/redeem.html"]')).forEach(function (a) {
      a.textContent = 'AMEKAS';
      a.setAttribute('href', 'https://www.amekas.com');
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('title', 'AMEKAS marketplace coming soon.');
      a.removeAttribute('aria-current');
    });

    hideElementAndFollowingBreak(document.getElementById('menuCreateCompliance'));
    hideElementAndFollowingBreak(document.getElementById('menuRecoverCompliance'));

    replaceTextInElement(document.getElementById('menuCreateStandard'), 'Self Custody Wallet', 'Self Custody OMA Wallet');
    replaceTextInElement(document.getElementById('menuRecoverStandard'), 'Self Custody Wallet', 'Self Custody OMA Wallet');

    hideElement(document.querySelector('section[aria-label="Broker Wrapped Offers"]'));
    hideContainingText('Compliance Only offers');
    hideOperatorModeComplianceRows();
    hideContainingText('Your Broker ID and CN public key are required to create a Compliance Wallet.');
    hideLabelForInputId('profileBrokerId');
    hideLabelForInputId('profileBrokerPubkey');
    hideElement(document.getElementById('profileBrokerWarn'));

    replaceVisibleText('Self Custody Wallet', 'Self Custody OMA Wallet');
    replaceVisibleText('Compliance Wallet registration system', 'Token Depot registration system');
    replaceVisibleText('Issue via CW', 'Issue via OMA Wallet');
    replaceVisibleText('via CW', 'via OMA Wallet');
    replaceVisibleText('active CW wallet', 'active OMA wallet');
    replaceVisibleText('active CW source', 'active OMA source');
    replaceVisibleText('CW source wallet', 'OMA source wallet');
    replaceVisibleText('CW wallet', 'OMA wallet');
    replaceVisibleText('Open CW', 'Open Wallet');
    replaceVisibleText('main CW page', 'main Wallet page');
    replaceVisibleText('Compliance-first workflows', 'OMA wallet workflows');
    startOperatorOmaOnlyObserver();
  }

  async function loadProfileSkin() {
    try {
      var r = await fetch('/api/v1/profile/me', { credentials: 'include' });
      var j = await r.json().catch(function () { return null; });
      if (j && j.ok) {
        var effectiveSkinId = j.wallet_plus && j.wallet_plus.effective_skin_id;
        var savedSkinId = j.user && j.user.skin_id;
        applySkin(effectiveSkinId || savedSkinId);
      }
    } catch (_) {
      /* Keep the cached first-paint hint if the profile cannot be loaded. */
    }
  }

  async function loadClientUiMode() {
    try {
      var r = await fetch('/api/v1/wrapped-config', { credentials: 'include' });
      var j = await r.json().catch(function () { return null; });
      var publicSite = j && j.publicSite && typeof j.publicSite === 'object' ? j.publicSite : null;
      applyClientUiMode(publicSite ? publicSite.clientUiMode : 'broker_compliance');
    } catch (_) {
      applyCachedClientUiModeHint();
    }
  }

  function loadSharedPageState() {
    loadProfileSkin();
    loadClientUiMode();
  }

  window.TdSkinShared = {
    applySkin: applySkin,
    applyCachedSkinHint: applyCachedSkinHint,
    applyClientUiMode: applyClientUiMode,
    applyCachedClientUiModeHint: applyCachedClientUiModeHint,
    loadProfileSkin: loadProfileSkin,
    loadClientUiMode: loadClientUiMode,
    loadSharedPageState: loadSharedPageState,
    normalizeSkinId: normalizeSkinId,
    normalizeClientUiMode: normalizeClientUiMode
  };

  applyCachedSkinHint();
  applyCachedClientUiModeHint();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSharedPageState);
    document.addEventListener('click', function () {
      if (readCachedClientUiMode() === 'operator_oma_only') setTimeout(applyOperatorOmaOnlyUi, 0);
    });
  } else {
    loadSharedPageState();
    document.addEventListener('click', function () {
      if (readCachedClientUiMode() === 'operator_oma_only') setTimeout(applyOperatorOmaOnlyUi, 0);
    });
  }
})();
