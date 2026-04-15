// ================================================================
//  ENTITLEMENT
// ================================================================

/**
 * Runtime entitlement state.
 * tier:   'free' | 'premium'
 * source: 'local' | 'server' | 'offline'  (Phase 6 will populate 'server'/'offline')
 */
const Entitlement = {
  tier:       'free',
  source:     'local',   // 'local' | 'server' | 'offline'
  verifiedAt: null,      // timestamp (ms) of last successful server verification
  deviceId:   _generateDeviceId(),
};

// ── Entitlement cache ─────────────────────────────────────────────────────────
// Persists the last-known tier to localStorage so premium features work offline.
// The server is always consulted when online — this cache is only a fallback.
// No TTL: a paid-once user should never lose premium just for being offline.
// Keyed per-user so switching accounts never bleeds entitlements.
const _ENT_CACHE_KEY = 'pinpoint_ent_v1';

function _saveEntitlementCache(userId, tier) {
  try {
    localStorage.setItem(_ENT_CACHE_KEY, JSON.stringify(
      { userId, tier, verifiedAt: Date.now() }
    ));
  } catch (_) { /* storage unavailable — silently skip */ }
}

function _loadEntitlementCache(userId) {
  try {
    const raw = localStorage.getItem(_ENT_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached?.userId === userId ? cached : null; // never use another user's cache
  } catch (_) { return null; }
}

/** Returns true when the user has an active premium entitlement. */
function isPremium() {
  return Entitlement.tier === 'premium';
}

/**
 * Sync entitlement state via Supabase SDK (Phase 3+).
 * Restores any stored session and updates Entitlement.source + header UI.
 *
 *   'server'  — SDK initialized, session check succeeded
 *   'offline' — SDK unavailable (CDN failed to load) or network error
 *   'local'   — SDK present but session check failed unexpectedly
 *
 * Non-blocking: called at init; resolves in the background.
 * Phase 6 will call getUser() (server round-trip) instead of getSession() (local).
 */
async function _syncEntitlement() {
  if (!_supabase) {
    Entitlement.source = navigator.onLine ? 'local' : 'offline';
    return;
  }
  try {
    const { data: { session }, error } = await _supabase.auth.getSession();
    if (error) throw error;
    Entitlement.source = 'server';
    _updateAccountUI(session);
    if (session) {
      // Re-register on load to refresh last_seen, then verify not evicted
      await _registerDevice(session);
      await _verifyDevice(session);
      // Phase 5: fetch the real entitlement tier from the database
      await _fetchEntitlement(session);
    }
    console.log('[Entitlement] SDK ready, logged in =', !!session);
  } catch (err) {
    Entitlement.source = navigator.onLine ? 'local' : 'offline';
    console.log('[Entitlement] SDK error:', err.message);
  }
}

/**
 * Fetch the user's entitlement tier from the entitlements table.
 *
 * On success  — saves result to localStorage cache; updates Entitlement.tier,
 *               source, and verifiedAt; reinitialises the map if tier changed.
 * On failure  — falls back to localStorage cache (honours 7-day TTL).
 *               If cache is expired, defaults to free.
 */
async function _fetchEntitlement(session) {
  if (!_supabase || !session) return;

  try {
    const { data, error } = await _supabase
      .from('entitlements')
      .select('tier')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw error;

    const newTier    = data?.tier ?? 'free';
    const verifiedAt = Date.now();

    // Persist to cache so offline visits can read it
    _saveEntitlementCache(session.user.id, newTier);
    Entitlement.source     = 'server';
    Entitlement.verifiedAt = verifiedAt;

    _applyTierChange(newTier);
    _updateVerifiedLabel();
    console.log('[Entitlement] Tier from server:', newTier);

  } catch (err) {
    // Server unreachable — try localStorage cache
    console.warn('[Entitlement] Server unreachable, checking cache:', err.message);
    const cached = _loadEntitlementCache(session.user.id);

    if (cached) {
      // No TTL — a buy-once user should never lose premium for being offline
      Entitlement.source     = 'offline';
      Entitlement.verifiedAt = cached.verifiedAt;
      console.log('[Entitlement] Using cached tier (offline):', cached.tier);
      _applyTierChange(cached.tier);
    }

    _updateVerifiedLabel();
  }
}

/**
 * Apply a tier value to Entitlement.tier.
 * If the tier actually changed, reinitialises the map (so the tile layer
 * switches between satellite and OpenStreetMap) and re-applies feature gates.
 */
function _applyTierChange(newTier) {
  if (newTier === Entitlement.tier) return;
  const prevTier = Entitlement.tier;
  Entitlement.tier = newTier;

  // If the user was previously confirmed premium (not just the default 'free')
  // and the server is now saying free, their access has been revoked.
  if (prevTier === 'premium' && newTier === 'free') {
    _showDowngradeNotice();
  }

  // Destroy and recreate the map so _initMap picks the correct tile layer
  _destroyMap();
  applyEntitlementGates();
  compute(); // calls _initMap() internally
}

/**
 * Show a calm, non-alarming notice when a user's premium access is revoked.
 * Uses the auth modal as a lightweight info display — no new UI needed.
 */
function _showDowngradeNotice() {
  _showAuthModal('signin');
  _showAuthMsg(
    'Your premium access is no longer active. If you believe this is an error, ' +
    'please contact support.',
    'info'
  );
}

// ================================================================
//  STRIPE CHECKOUT  (Phase 5)
// ================================================================

/**
 * Redirect the user to a Stripe Checkout page for the one-time premium purchase.
 * Calls the create-checkout-session Edge Function which creates the session
 * server-side (so user_id metadata can be securely embedded).
 */
async function _startCheckout() {
  if (!_supabase) {
    alert('Please sign in before upgrading.');
    return;
  }
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) {
    _showAuthModal('signin');
    return;
  }

  const btn = get('upgradeBtn');
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ Loading…';
  btn.disabled = true;

  try {
    // The app URL is used for Stripe's success/cancel redirect targets.
    // Works for both file:// local use and hosted deployments.
    const appUrl = window.location.href.split('?')[0].split('#')[0];

    // Use the Supabase SDK to invoke the Edge Function — it handles auth headers
    // and token refresh automatically, avoiding "Invalid JWT" errors from raw fetch.
    const { data, error: fnError } = await _supabase.functions.invoke(
      'create-checkout-session',
      { body: { appUrl } }
    );
    if (fnError) throw fnError;
    if (!data?.url) throw new Error('No checkout URL returned from edge function');
    // Redirect to Stripe's hosted checkout page
    window.location.href = data.url;
  } catch (err) {
    console.error('[Checkout] Failed to start checkout:', err.message);
    btn.textContent = originalLabel;
    btn.disabled = false;
    alert('Could not start checkout. Please try again.');
  }
}
