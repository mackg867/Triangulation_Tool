// ================================================================
//  UI CONTROLLER
// ================================================================

function hideAll() {
  get('minObsWarning').classList.add('hidden');
  get('gdopWarning').classList.add('hidden');
  get('algoError').classList.add('hidden');
  get('resultsCard').classList.add('hidden');
  get('diagramCard').classList.add('hidden');
  get('statusDot').classList.remove('live');
}

function compute() {
  const isBia    = _algorithm === 'biangulation';
  const minObs   = isBia ? 2 : 3;
  const active   = activeObsCount();

  if (active < minObs) {
    hideAll();
    const warn = get('minObsWarning');
    warn.querySelector('div').innerHTML = isBia
      ? '<strong>Not enough active observations.</strong><br>Enable 2 observations to compute a biangulation fix.'
      : '<strong>Not enough active observations.</strong><br>Enable at least 3 observations to compute a fix.';
    warn.classList.remove('hidden');
    return;
  }
  get('minObsWarning').classList.add('hidden');

  const parsed = readInputs();
  save();

  if (!parsed) { hideAll(); return; }

  const { obs, berr } = parsed;

  // Safety guard: biangulation strictly requires 2
  if (isBia && obs.length !== 2) {
    hideAll();
    get('algoError').classList.remove('hidden');
    get('algoErrorMsg').innerHTML =
      '<strong>Biangulation requires exactly 2 active observations.</strong><br>'
      + 'Disable extra observations or switch to a different algorithm.';
    return;
  }

  const result = Engine.solve(obs, berr, _algorithm, _meanType);

  get('algoError').classList.add('hidden');

  if (result.convergeError) {
    hideAll();
    get('algoError').classList.remove('hidden');
    get('algoErrorMsg').innerHTML =
      '<strong>MLE did not converge with the current geometry.</strong><br>'
      + 'The bearing lines may be too nearly parallel or the fix geometry too irregular. '
      + 'Try <em>Huber</em>, <em>Andrews</em>, or <em>Geometric Centroid</em> instead.';
    return;
  }

  if (result.error) {
    hideAll();
    get('algoError').classList.remove('hidden');
    get('algoErrorMsg').innerHTML = `<strong>Algorithm error:</strong> ${result.error}`;
    return;
  }

  if (result.gdopWarning) {
    get('gdopWarning').classList.remove('hidden');
    get('resultsCard').classList.add('hidden');
    get('diagramCard').classList.add('hidden');
    get('statusDot').classList.remove('live');
    return;
  }

  get('gdopWarning').classList.add('hidden');
  get('resDecimal').textContent = fmtDec(result.lat, result.lon);
  get('resDMS').textContent     = `${toDMS(result.lat, false)},  ${toDMS(result.lon, true)}`;
  get('resRadius').textContent  = fmtRadius(result.errorRadius);

  let badge = result.algorithmUsed || _algorithm.toUpperCase();
  if (result.iterations != null) badge += ` · ${result.iterations} iter`;
  get('algoBadge').textContent = `Algorithm: ${badge}`;

  get('resultsCard').classList.remove('hidden');
  drawDiagram(obs, { lat: result.lat, lon: result.lon }, result.errorRadius);
  get('diagramCard').classList.remove('hidden');
  get('statusDot').classList.add('live');
}


// ================================================================
//  INIT
// ================================================================

// Restore theme before any DOM renders
try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) applyTheme(savedTheme);
} catch (_) {}

// Build the initial 3 observer cards
initObsCards();

// Restore previous session
load();

// Apply premium/free gates (must run after load so saved algorithm is known)
applyEntitlementGates();

compute();

// Non-blocking Supabase sync — fetches session, device check, and entitlement tier.
_syncEntitlement();

// ── Upgrade button ───────────────────────────────────────────────
get('upgradeBtn').addEventListener('click', _startCheckout);

// ── Handle return from Stripe Checkout ──────────────────────────
// Stripe redirects back to ?payment=success or ?payment=cancelled.
(function _handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('payment');
  if (!result) return;

  // Clean the query string from the URL immediately
  history.replaceState({}, '', window.location.pathname);

  if (result !== 'success') return;
  // Cancelled: no action needed — user just lands back on the free tier.

  // Show a slim banner while polling for the webhook to write the entitlement row.
  // Webhooks can occasionally be delayed; a single fixed timeout risks a false
  // "payment failed" impression. Instead we poll every 2s (max 5 attempts).
  const banner = document.createElement('div');
  banner.id = 'paymentBanner';
  banner.textContent = 'Confirming your payment…';
  document.body.appendChild(banner);

  const MAX_ATTEMPTS = 10;
  const INTERVAL_MS  = 2500;
  let attempts = 0;

  async function poll() {
    if (!_supabase) { banner.remove(); return; }
    const { data: { session } } = await _supabase.auth.getSession();
    if (!session)   { banner.remove(); return; }

    attempts++;
    await _fetchEntitlement(session);

    if (isPremium()) {
      banner.remove();
      console.log('[Checkout] Payment confirmed — premium unlocked.');
    } else if (attempts >= MAX_ATTEMPTS) {
      banner.textContent = 'Payment received — still processing. Refresh in a moment to unlock premium.';
      banner.style.background = '#2a6496';
    } else {
      setTimeout(poll, INTERVAL_MS);
    }
  }

  // Give the webhook a moment before the first attempt.
  setTimeout(poll, 1500);
})();

// GPS setup
const _geo = detectGeoSupport();
setGpsState(_geo.supported, _geo.reason);

// Add Observation button
get('addObsBtn').addEventListener('click', () => {
  // Free users are capped at 3 observation cards
  if (!isPremium() && qsa('.obs-card').length >= 3) {
    get('upgradeBtn').classList.add('upgrade-btn-pulse');
    setTimeout(() => get('upgradeBtn').classList.remove('upgrade-btn-pulse'), 1200);
    return;
  }
  addObsCard();
  compute();
  save();
});

// Bearing error slider
get('bearingError').addEventListener('input', function () {
  get('bearingErrorLabel').textContent = `±${this.value}°`;
  compute();
});

// Algorithm selector
get('algorithmSelect').addEventListener('change', function () {
  const wasBia = _algorithm === 'biangulation';
  _algorithm   = this.value;
  get('meanTypeWrap').classList.toggle('hidden', this.value !== 'statmeans');
  if (wasBia !== (_algorithm === 'biangulation')) {
    applyBiangulationLock(_algorithm === 'biangulation');
  }
  compute();
  save();
});

// Mean-type sub-selector (only visible when algorithm = statmeans)
get('meanTypeSelect').addEventListener('change', function () {
  _meanType = this.value;
  compute();
  save();
});

// Settings inputs → live recompute
qsa('#declination, #bearingError').forEach(inp => {
  inp.addEventListener('input', compute);
});

// Clear / Reset
get('clearBtn').addEventListener('click', () => {
  if (confirm('Clear all observation data and start fresh?')) {
    wipe();
    hideAll();
  }
});

// Online/offline map switching
window.addEventListener('offline', () => {
  if (_lastDrawArgs && !get('diagramCard').classList.contains('hidden')) {
    _showSvg();
    drawSvgDiagram(..._lastDrawArgs);
  }
});
window.addEventListener('online', () => {
  if (_lastDrawArgs && !get('diagramCard').classList.contains('hidden')) {
    _tilesHealthy = true;
    _tileErrCount = 0;
    drawDiagram(..._lastDrawArgs);
  }
});

// Theme toggle button
get('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'sun' ? 'dark' : 'sun';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  if (!get('diagramCard').classList.contains('hidden')) compute();
});

// ── Auth event listeners ──────────────────────────────────────────────────────

// Sign In button (header)
// ── Triangulation Fix modal ──────────────────────────────────────────────────
function _showTriangulationModal() {
  get('triangulationOverlay').classList.remove('hidden');
}
function _hideTriangulationModal() {
  get('triangulationOverlay').classList.add('hidden');
}

// ── Learn More modal ──────────────────────────────────────────────────────────
function _showLearnMoreModal() {
  get('learnMoreOverlay').classList.remove('hidden');
}
function _hideLearnMoreModal() {
  get('learnMoreOverlay').classList.add('hidden');
}

// ── Benefits of Upgrading modal ──────────────────────────────────────────────
function _showBenefitsModal() {
  get('benefitsOverlay').classList.remove('hidden');
}

function _hideBenefitsModal() {
  get('benefitsOverlay').classList.add('hidden');
}

// ── Add to Homescreen modal ───────────────────────────────────────────────────
function _detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua))          return 'android';
  if (!/Mobi|Android/i.test(ua))    return 'desktop';
  return 'unknown';
}

function _showHomescreenModal() {
  const platform = _detectPlatform();
  const sectionMap = {
    ios:     'homescreenIos',
    android: 'homescreenAndroid',
    desktop: 'homescreenDesktop',
    unknown: 'homescreenFallback',
  };
  ['homescreenIos', 'homescreenAndroid', 'homescreenDesktop', 'homescreenFallback'].forEach(id => {
    get(id).classList.add('hidden');
  });
  get(sectionMap[platform] || 'homescreenFallback').classList.remove('hidden');
  get('homescreenOverlay').classList.remove('hidden');
}

function _hideHomescreenModal() {
  get('homescreenOverlay').classList.add('hidden');
}

// ── Navigation Drawer ─────────────────────────────────────────────────────────
function _openDrawer() {
  get('navDrawer').classList.add('open');
  get('drawerOverlay').classList.add('open');
  get('navDrawer').setAttribute('aria-hidden', 'false');
  get('menuBtn').setAttribute('aria-expanded', 'true');
}

function _closeDrawer() {
  get('navDrawer').classList.remove('open');
  get('drawerOverlay').classList.remove('open');
  get('navDrawer').setAttribute('aria-hidden', 'true');
  get('menuBtn').setAttribute('aria-expanded', 'false');
}

get('menuBtn').addEventListener('click', _openDrawer);
get('drawerCloseBtn').addEventListener('click', _closeDrawer);
get('drawerOverlay').addEventListener('click', _closeDrawer);

// Drawer menu items
get('drawerManageAccount').addEventListener('click', () => { _closeDrawer(); _showAccountModal(); });
get('drawerSignOut').addEventListener('click', () => { _closeDrawer(); _handleSignOut(); });
get('drawerSignIn').addEventListener('click', () => { _closeDrawer(); _showAuthModal('signin'); });
get('drawerBenefits').addEventListener('click', () => { _closeDrawer(); _showBenefitsModal(); });
get('drawerHowToTriangulation').addEventListener('click', () => { _closeDrawer(); _showTriangulationModal(); });
get('drawerLearnMore').addEventListener('click', () => { _closeDrawer(); _showLearnMoreModal(); });
get('drawerHomescreen').addEventListener('click', () => { _closeDrawer(); _showHomescreenModal(); });

get('signInBtn').addEventListener('click', () => _showAuthModal('signin'));

// Sign Out button (account badge)

// Account email — click to open account management modal

// ── Account modal event listeners ────────────────────────────────────────────
// Null-guarded so a missing element (e.g. cached old HTML) never breaks the
// rest of the script — sign-in and other listeners still register correctly.

if (get('accountModalCloseBtn')) {
  get('accountModalCloseBtn').addEventListener('click', _hideAccountModal);
}
if (get('accountModalOverlay')) {
  get('accountModalOverlay').addEventListener('click', e => {
    if (e.target === get('accountModalOverlay')) _hideAccountModal();
  });
}
if (get('changePasswordBtn')) {
  get('changePasswordBtn').addEventListener('click', _changePassword);
}



// Triangulation Fix modal — close
get('triangulationCloseBtn').addEventListener('click', _hideTriangulationModal);
get('triangulationOverlay').addEventListener('click', e => {
  if (e.target === get('triangulationOverlay')) _hideTriangulationModal();
});

// Learn More modal — close
get('learnMoreCloseBtn').addEventListener('click', _hideLearnMoreModal);
get('learnMoreOverlay').addEventListener('click', e => {
  if (e.target === get('learnMoreOverlay')) _hideLearnMoreModal();
});

// Benefits modal — close
get('benefitsCloseBtn').addEventListener('click', _hideBenefitsModal);
get('benefitsOverlay').addEventListener('click', e => {
  if (e.target === get('benefitsOverlay')) _hideBenefitsModal();
});

// Homescreen modal — close
get('homescreenCloseBtn').addEventListener('click', _hideHomescreenModal);
get('homescreenOverlay').addEventListener('click', e => {
  if (e.target === get('homescreenOverlay')) _hideHomescreenModal();
});

// Benefits modal — upgrade button
get('benefitsUpgradeBtn').addEventListener('click', () => {
  _hideBenefitsModal();
  _startCheckout();
});

// Benefits modal — sign in link
get('benefitsSignInBtn').addEventListener('click', () => {
  _hideBenefitsModal();
  _showAuthModal('signin');
});

// Escape key — close drawer, account modal, or auth modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (get('navDrawer').classList.contains('open')) { _closeDrawer(); return; }
    if (!get('triangulationOverlay').classList.contains('hidden')) { _hideTriangulationModal(); return; }
    if (!get('learnMoreOverlay').classList.contains('hidden')) { _hideLearnMoreModal(); return; }
    if (!get('benefitsOverlay').classList.contains('hidden')) { _hideBenefitsModal(); return; }
    if (!get('homescreenOverlay').classList.contains('hidden')) { _hideHomescreenModal(); return; }
    const acctOverlay = get('accountModalOverlay');
    if (acctOverlay && !acctOverlay.classList.contains('hidden')) {
      _hideAccountModal();
    }
  }
});

// Modal close (X button or clicking outside the card)
get('authCloseBtn').addEventListener('click', _hideAuthModal);
get('authOverlay').addEventListener('click', e => {
  if (e.target === get('authOverlay')) _hideAuthModal();
});

// Escape key closes modal
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !get('authOverlay').classList.contains('hidden')) {
    _hideAuthModal();
  }
});

// Submit button
get('authSubmitBtn').addEventListener('click', _handleAuthSubmit);

// Enter key in password field triggers submit
get('authPasswordInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') _handleAuthSubmit();
});

// Toggle between sign-in and sign-up
get('authToggleBtn').addEventListener('click', () => {
  _setAuthMode(_authMode === 'signin' ? 'signup' : 'signin');
  _clearAuthMsg();
});

// Supabase auth state change — fires on sign-in, sign-out, token refresh
// IMPORTANT: this handler must NOT be async / must not return a Promise.
// Recent Supabase JS v2 releases await the callback before resolving
// signInWithPassword — an async handler that does slow work (like
// _registerDevice) will block sign-in from completing.
if (_supabase) {
  _supabase.auth.onAuthStateChange((_event, session) => {
    _updateAccountUI(session);
    // Fire device registration + entitlement fetch in the background.
    // Do NOT await here — keeping this handler synchronous is required
    // so signInWithPassword resolves immediately.
    if (session && (_event === 'SIGNED_IN' || _event === 'TOKEN_REFRESHED')) {
      (async () => {
        await _registerDevice(session);
        await _verifyDevice(session);
        await _fetchEntitlement(session);
      })().catch(err =>
        console.warn('[Auth] Background sync failed:', err.message)
      );
    }
  });
}

