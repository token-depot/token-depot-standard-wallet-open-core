(() => {
  const KEYRING_SESSION_KEY = 'cw_keyring_session';
  const ACTIVE_SKIN_SESSION_KEY = 'td_active_skin_id';
  const LIVE_UNLOCK_WINDOW_KEY = '__cwWalletLiveUnlock';

  function toText(value) {
    if (value === 0 || value === false) return String(value);
    return String(value || '').trim();
  }

  function clearUnlockedState() {
    try { sessionStorage.removeItem(KEYRING_SESSION_KEY); } catch (_) {}
    try { sessionStorage.removeItem(ACTIVE_SKIN_SESSION_KEY); } catch (_) {}
    try { window[LIVE_UNLOCK_WINDOW_KEY] = null; } catch (_) {}
  }

  async function logoutNow(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const endpoint = toText(opts.endpoint) || '/api/v1/session/logout';
    const redirectTo = toText(opts.redirectTo) || '/login.html';
    const redirect = opts.redirect === false ? false : true;

    clearUnlockedState();

    try {
      await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
    } catch (_) {}

    clearUnlockedState();

    if (redirect && redirectTo) {
      window.location.href = redirectTo;
    }

    return { ok: true };
  }

  const api = Object.freeze({
    clearUnlockedState,
    logoutNow
  });

  if (typeof window !== 'undefined') {
    window.CwLogoutShared = api;
  }
})();
