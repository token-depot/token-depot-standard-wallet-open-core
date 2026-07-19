(function () {
  var STYLE_ID = 'td-sponsored-offers-style';
  var STATE_PREFIX = 'td_sponsored_offer_state_';
  var BLOCK_PREFIX = 'td_sponsored_offer_blocked_';
  var POST_LOGIN_PLACEMENT = 'post_login';
  var RENEWAL_REMINDER_PLACEMENT = 'renewal_reminder';
  var WALLET_DASHBOARD_PLACEMENT = 'wallet_dashboard';
  var REPEAT_CHECK_MS = 60 * 1000;
  var fetchInFlight = false;
  var repeatTimerId = null;

  function nowMs() {
    return Date.now();
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function safeText(value, maxLen) {
    var s = String(value || '').trim();
    if (!maxLen || s.length <= maxLen) return s;
    return s.slice(0, maxLen).trim();
  }

  function normalizePositiveNumber(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  function normalizeDestinationUrl(value) {
    var s = String(value || '').trim();
    if (!s) return '';
    try {
      var u = new URL(s, window.location.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (_) {}
    return '';
  }

  function isCloseStyleCta(value) {
    var s = String(value || '').trim().toLowerCase();
    return s === 'close' || s === 'dismiss' || s === 'cancel' || s === 'not now' || s === 'no thanks';
  }

  function resolvePagePlacement() {
    var fromWindow = String(window.TD_SPONSORED_OFFERS_PAGE_PLACEMENT || '').trim();
    if (fromWindow) return fromWindow;

    var fromBody = document.body ? String(document.body.getAttribute('data-sponsored-placement') || '').trim() : '';
    if (fromBody) return fromBody;

    return WALLET_DASHBOARD_PLACEMENT;
  }

  function storageKey(campaignId) {
    return STATE_PREFIX + String(campaignId || '').trim();
  }

  function readCampaignState(campaignId) {
    try {
      var raw = localStorage.getItem(storageKey(campaignId));
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeCampaignState(campaignId, state) {
    try {
      localStorage.setItem(storageKey(campaignId), JSON.stringify(state || {}));
    } catch (_) {}
  }

  function blockStorageKey(campaign) {
    var campaignId = String((campaign && campaign.id) || '').trim();
    var placement = String((campaign && campaign.placement) || '').trim();
    if (!campaignId || !placement) return '';
    return BLOCK_PREFIX + campaignId + '_' + placement;
  }

  function isCampaignBlockedForSession(campaign) {
    var key = blockStorageKey(campaign);
    if (!key) return false;

    try {
      return sessionStorage.getItem(key) === '1';
    } catch (_) {
      return false;
    }
  }

  function blockCampaignForSession(campaign) {
    var key = blockStorageKey(campaign);
    if (!key) return;

    try {
      sessionStorage.setItem(key, '1');
    } catch (_) {}
  }

  function shouldShowCampaign(campaign) {
    if (!campaign || !campaign.id) return false;
    if (isCampaignBlockedForSession(campaign)) return false;

    var state = readCampaignState(campaign.id);
    var currentDay = todayKey();
    var lastShownAt = Number(state.last_shown_at || 0);
    var cooldownMinutes = normalizePositiveNumber(campaign.cooldown_minutes);
    var maxImpressionsPerDay = normalizePositiveNumber(campaign.max_impressions_per_day);

    if (cooldownMinutes && lastShownAt > 0) {
      var cooldownMs = cooldownMinutes * 60 * 1000;
      if (nowMs() - lastShownAt < cooldownMs) return false;
    }

    if (maxImpressionsPerDay) {
      var impressionDay = String(state.impression_day || '');
      var impressionCount = Number(state.impression_count || 0);
      if (impressionDay === currentDay && impressionCount >= maxImpressionsPerDay) return false;
    }

    return true;
  }

  function recordCampaignShown(campaign) {
    if (!campaign || !campaign.id) return;

    var state = readCampaignState(campaign.id);
    var currentDay = todayKey();
    var impressionDay = String(state.impression_day || '');
    var impressionCount = Number(state.impression_count || 0);

    if (impressionDay !== currentDay) {
      impressionDay = currentDay;
      impressionCount = 0;
    }

    state.last_shown_at = nowMs();
    state.impression_day = impressionDay;
    state.impression_count = impressionCount + 1;

    writeCampaignState(campaign.id, state);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.td-sponsored-offer-overlay{position:fixed;inset:0;z-index:99980;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:rgba(var(--td-skin-black-rgb),0.45);backdrop-filter:blur(7px);}',
      '.td-sponsored-offer-card{width:min(560px,100%);border:1px solid rgba(var(--td-skin-border-rgb),0.85);border-radius:24px;background:radial-gradient(circle at top left,rgba(var(--td-skin-primary-rgb),0.22),rgba(var(--td-skin-panel-rgb),0.98));color:var(--td-skin-text);box-shadow:0 0 0 1px rgba(var(--td-skin-panel-rgb),0.9),0 24px 90px rgba(var(--td-skin-primary-glow-rgb),0.32);padding:1.15rem;}',
      '.td-sponsored-offer-top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;border-bottom:1px solid rgba(var(--td-skin-border-rgb),0.42);padding-bottom:.75rem;margin-bottom:.85rem;}',
      '.td-sponsored-offer-kicker{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--td-skin-text-soft);font-weight:700;}',
      '.td-sponsored-offer-title{margin:.22rem 0 0;font-size:1.18rem;line-height:1.25;color:var(--td-skin-text-strong);}',
      '.td-sponsored-offer-close{padding:.35rem .8rem;font-size:.84rem;line-height:1;}',
      '.td-sponsored-offer-body{white-space:pre-wrap;font-size:.98rem;line-height:1.48;color:var(--td-skin-text);margin:.35rem 0 1rem;}',
      '.td-sponsored-offer-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.65rem;margin-top:1rem;}',
      '.td-sponsored-offer-actions a.button{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;}',
      '@media(max-width:640px){.td-sponsored-offer-overlay{align-items:flex-end;padding:.75rem}.td-sponsored-offer-card{border-radius:18px;padding:1rem}.td-sponsored-offer-actions{justify-content:stretch}.td-sponsored-offer-actions button,.td-sponsored-offer-actions a.button{width:100%;}}'
    ].join('\n');

    document.head.appendChild(style);
  }

  async function fetchEligibleCampaigns(placement) {
    var url = '/api/v1/sponsored-offers/eligible?placement=' + encodeURIComponent(placement);
    var r = await fetch(url, { credentials: 'include' });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || !j.ok || !Array.isArray(j.campaigns)) return [];
    return j.campaigns;
  }

  function pickCampaign(campaigns) {
    for (var i = 0; i < campaigns.length; i += 1) {
      if (shouldShowCampaign(campaigns[i])) return campaigns[i];
    }
    return null;
  }

  function closeExistingModal() {
    var existing = document.getElementById('tdSponsoredOfferOverlay');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function showCampaign(campaign) {
    if (!campaign || !campaign.id || !document.body) return;

    closeExistingModal();
    injectStyle();
    recordCampaignShown(campaign);

    var destinationUrl = normalizeDestinationUrl(campaign.destination_url);
    var title = safeText(campaign.title, 140) || 'Sponsored Offer';
    var body = safeText(campaign.body, 1200);
    var ctaLabel = safeText(campaign.cta_label, 40) || 'Learn More';

    var overlay = document.createElement('div');
    overlay.id = 'tdSponsoredOfferOverlay';
    overlay.className = 'td-sponsored-offer-overlay';

    var card = document.createElement('div');
    card.className = 'td-sponsored-offer-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tdSponsoredOfferTitle');

    var top = document.createElement('div');
    top.className = 'td-sponsored-offer-top';

    var titleWrap = document.createElement('div');

    var kicker = document.createElement('div');
    kicker.className = 'td-sponsored-offer-kicker';
    kicker.textContent = 'Sponsored Offer';

    var h = document.createElement('h3');
    h.id = 'tdSponsoredOfferTitle';
    h.className = 'td-sponsored-offer-title';
    h.textContent = title;

    var closeTop = document.createElement('button');
    closeTop.type = 'button';
    closeTop.className = 'td-sponsored-offer-close';
    closeTop.textContent = 'Close';
    closeTop.addEventListener('click', closeExistingModal);

    titleWrap.appendChild(kicker);
    titleWrap.appendChild(h);
    top.appendChild(titleWrap);
    top.appendChild(closeTop);

    var bodyEl = document.createElement('div');
    bodyEl.className = 'td-sponsored-offer-body';
    bodyEl.textContent = body;

    var actions = document.createElement('div');
    actions.className = 'td-sponsored-offer-actions';

    if (destinationUrl && !isCloseStyleCta(ctaLabel)) {
      var cta = document.createElement('a');
      cta.className = 'button';
      cta.href = destinationUrl;
      cta.textContent = ctaLabel;
      cta.addEventListener('click', closeExistingModal);
      actions.appendChild(cta);
    }

    if (campaign.allow_user_block === true) {
      var blockButton = document.createElement('button');
      blockButton.type = 'button';
      blockButton.textContent = 'Don’t show again this session';
      blockButton.addEventListener('click', function () {
        blockCampaignForSession(campaign);
        closeExistingModal();
      });
      actions.appendChild(blockButton);
    }

    card.appendChild(top);
    if (body) card.appendChild(bodyEl);
    if (actions.childNodes.length > 0) card.appendChild(actions);
    overlay.appendChild(card);

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeExistingModal();
    });

    document.addEventListener('keydown', function escHandler(ev) {
      if (ev.key === 'Escape') {
        closeExistingModal();
        document.removeEventListener('keydown', escHandler);
      }
    });

    document.body.appendChild(overlay);
    closeTop.focus();
  }

  async function showPlacement(placement) {
    if (fetchInFlight) return false;
    if (document.getElementById('tdSponsoredOfferOverlay')) return false;

    fetchInFlight = true;

    try {
      var normalizedPlacement = String(placement || POST_LOGIN_PLACEMENT).trim() || POST_LOGIN_PLACEMENT;
      var campaigns = await fetchEligibleCampaigns(normalizedPlacement);
      var campaign = pickCampaign(campaigns);
      if (campaign) {
        showCampaign(campaign);
        return true;
      }
    } catch (_) {
      /* Sponsored offers must never break the wallet page. */
    } finally {
      fetchInFlight = false;
    }

    return false;
  }

  function showRenewalReminder() {
    return showPlacement(RENEWAL_REMINDER_PLACEMENT);
  }

  function showPostLogin() {
    return showPlacement(POST_LOGIN_PLACEMENT);
  }

  async function showInitialLoginPlacement() {
    var shownRenewalReminder = await showRenewalReminder();
    if (!shownRenewalReminder) await showPostLogin();
  }

  function showPagePlacement() {
    return showPlacement(resolvePagePlacement());
  }

  function startPostLoginChecks() {
    if (repeatTimerId !== null) return;
    window.setTimeout(showInitialLoginPlacement, 700);
    window.setTimeout(showPagePlacement, 1500);
    repeatTimerId = window.setInterval(showPagePlacement, REPEAT_CHECK_MS);
  }

  window.TokenDepotSponsoredOffers = {
    showPlacement: showPlacement,
    showRenewalReminder: showRenewalReminder,
    showPostLogin: showPostLogin,
    showPagePlacement: showPagePlacement,
    close: closeExistingModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPostLoginChecks);
  } else {
    startPostLoginChecks();
  }
})();

