'use strict';

// ================================================================
//  SUPABASE CONFIG  (Phase 2)
//  Fill these in after completing the Supabase dashboard setup:
//    Project Settings → API → Project URL  &  anon/public key
//  The anon key is safe to ship in frontend code — it is access-controlled
//  by Row-Level Security policies (added in Phase 3+).
// ================================================================
const SUPABASE_URL      = 'https://spagrpqdisiebxxuyyvq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wqYKdFLQLN3grMz28O2vUQ_bjkgNdnk';

// Supabase JS client — falls back to null if the SDK CDN script failed to load
// (e.g. completely offline on first visit).
const _supabase = (typeof supabase !== 'undefined' && !SUPABASE_URL.includes('YOUR_PROJECT_REF'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ================================================================
//  DEV OVERRIDE
//  Set true locally to force premium features on without a backend.
//  Must be false before any public deployment.
// ================================================================
const DEV_OVERRIDE = false;

// ================================================================
//  HELPERS
// ================================================================
const get = id  => document.getElementById(id);
const qsa = sel => [...document.querySelectorAll(sel)];


// ================================================================
//  TRIANGULATION ENGINE
//  Identical math to test_runner.html — keep in sync.
// ================================================================

const R_EARTH        = 6_371_000;
const GDOP_THRESHOLD = 0.10;

const Engine = {
  toRad: d => d * Math.PI / 180,
  toDeg: r => r * 180 / Math.PI,

  toENU(lat, lon, rLat, rLon) {
    return {
      E: this.toRad(lon - rLon) * Math.cos(this.toRad(rLat)) * R_EARTH,
      N: this.toRad(lat - rLat) * R_EARTH
    };
  },

  fromENU(E, N, rLat, rLon) {
    return {
      lat: rLat + this.toDeg(N / R_EARTH),
      lon: rLon + this.toDeg(E / (R_EARTH * Math.cos(this.toRad(rLat))))
    };
  },

  /** true = magnetic + declination (east positive) */
  applyDeclination(mag, decl) {
    return (mag + decl + 720) % 360;
  },

  // ── Shared internal helpers ──────────────────────────────────────

  /** Build ENU-projected line coefficients for every observation. */
  _buildLines(obs, rLat, rLon) {
    return obs.map(o => {
      const { E, N } = this.toENU(o.lat, o.lon, rLat, rLon);
      const θ = this.toRad(o.trueBearing);
      const a = Math.cos(θ), b = -Math.sin(θ);
      return { E, N, θ, a, b, c: E*a + N*b };
    });
  },

  /**
   * Solve weighted normal equations.  Weights are normalised so their
   * sum equals the number of lines, keeping the determinant comparable
   * to the GDOP_THRESHOLD regardless of weight scale.
   */
  _solveWeighted(lines, weights) {
    const wSum = weights.reduce((s, w) => s + w, 0);
    if (wSum < 1e-20) return null;
    const n = lines.length;
    let sA2=0, sAB=0, sB2=0, sAC=0, sBC=0;
    lines.forEach((l, i) => {
      const w = weights[i] / wSum * n;
      sA2+=w*l.a*l.a; sAB+=w*l.a*l.b; sB2+=w*l.b*l.b;
      sAC+=w*l.a*l.c; sBC+=w*l.b*l.c;
    });
    const det = sA2*sB2 - sAB*sAB;
    if (det < GDOP_THRESHOLD) return null;
    return {
      PE: (sAC*sB2 - sBC*sAB) / det,
      PN: (sA2*sBC - sAB*sAC) / det,
      det
    };
  },

  /** Perpendicular distance from (PE,PN) to each bearing line. */
  _perpDists(lines, PE, PN) {
    return lines.map(l => Math.abs(l.a*PE + l.b*PN - l.c));
  },

  /** Combined RMS + bearing-uncertainty error radius. */
  _errorRadius(pd, lines, PE, PN, bearingErrDeg) {
    const rms = Math.sqrt(pd.reduce((s, d) => s + d*d, 0) / pd.length);
    const ad  = lines.reduce((s, l) => s + Math.hypot(PE-l.E, PN-l.N), 0) / lines.length;
    return Math.sqrt(rms**2 + (this.toRad(bearingErrDeg)*ad)**2);
  },

  // ── Algorithms ──────────────────────────────────────────────────

  /** OLS: closed-form unweighted least-squares (N ≥ 2 lines). */
  solveOLS(obs, bearingErrDeg = 5) {
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);
    const sol   = this._solveWeighted(lines, new Array(lines.length).fill(1));
    if (!sol) return { gdopWarning: true, det: 0 };
    const { PE, PN, det } = sol;
    const pd = this._perpDists(lines, PE, PN);
    const er = this._errorRadius(pd, lines, PE, PN, bearingErrDeg);
    const pos = this.fromENU(PE, PN, rLat, rLon);
    return { lat: pos.lat, lon: pos.lon, errorRadius: er, det, gdopWarning: false, algorithmUsed: 'OLS' };
  },

  /** Backward-compatible alias. */
  triangulate(obs, bearingErrDeg = 5) { return this.solveOLS(obs, bearingErrDeg); },

  /**
   * MLE (Lenth's): iterative distance-squared weighting.
   * Observers closer to the current estimate receive higher weight
   * because a fixed bearing error produces a smaller perpendicular offset
   * at short range (w ∝ 1/r²).
   */
  solveMLE(obs, bearingErrDeg = 5) {
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);

    // Seed with OLS
    const seed = this._solveWeighted(lines, new Array(lines.length).fill(1));
    if (!seed) return { gdopWarning: true, det: 0 };

    let PE = seed.PE, PN = seed.PN;
    const MAX_ITER = 50, THRESH = 0.01; // 1 cm convergence

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const weights = lines.map(l => {
        const r2 = (PE - l.E)**2 + (PN - l.N)**2;
        return 1 / Math.max(r2, 1);   // floor at 1 m² to avoid /0
      });
      const sol = this._solveWeighted(lines, weights);
      if (!sol) return { gdopWarning: true, det: 0 };
      const δ = Math.hypot(sol.PE - PE, sol.PN - PN);
      PE = sol.PE; PN = sol.PN;
      if (δ < THRESH) {
        const pd = this._perpDists(lines, PE, PN);
        const er = this._errorRadius(pd, lines, PE, PN, bearingErrDeg);
        const pos = this.fromENU(PE, PN, rLat, rLon);
        return { lat: pos.lat, lon: pos.lon, errorRadius: er, det: sol.det,
                 gdopWarning: false, algorithmUsed: 'MLE', iterations: iter + 1 };
      }
    }
    return { convergeError: true };
  },

  /**
   * Huber M-estimator (IRLS): hybrid weighting that down-weights but
   * does not discard large residuals.  k = 1.345 gives 95% Gaussian efficiency.
   */
  solveHuber(obs, bearingErrDeg = 5) {
    const K = 1.345;
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);
    const seed = this._solveWeighted(lines, new Array(lines.length).fill(1));
    if (!seed) return { gdopWarning: true, det: 0 };

    let PE = seed.PE, PN = seed.PN, det = seed.det;
    const MAX_ITER = 50, THRESH = 0.01;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const pd = this._perpDists(lines, PE, PN);
      const sorted = [...pd].sort((a, b) => a - b);
      const σ  = Math.max(sorted[Math.floor(sorted.length / 2)] / 0.6745, 0.1);
      const weights = pd.map(d => { const r = d / σ; return r <= K ? 1 : K / r; });
      const sol = this._solveWeighted(lines, weights);
      if (!sol) break;
      const δ = Math.hypot(sol.PE - PE, sol.PN - PN);
      PE = sol.PE; PN = sol.PN; det = sol.det;
      if (δ < THRESH) break;
    }
    const pd = this._perpDists(lines, PE, PN);
    const er = this._errorRadius(pd, lines, PE, PN, bearingErrDeg);
    const pos = this.fromENU(PE, PN, rLat, rLon);
    return { lat: pos.lat, lon: pos.lon, errorRadius: er, det, gdopWarning: false, algorithmUsed: 'Huber' };
  },

  /**
   * Andrews M-estimator (IRLS): sinc weighting that zeroes out extreme
   * outliers entirely, making the fix immune to badly corrupted bearings.
   */
  solveAndrews(obs, bearingErrDeg = 5) {
    const C = 1.339;
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);
    const seed = this._solveWeighted(lines, new Array(lines.length).fill(1));
    if (!seed) return { gdopWarning: true, det: 0 };

    let PE = seed.PE, PN = seed.PN, det = seed.det;
    const MAX_ITER = 50, THRESH = 0.01;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const pd = this._perpDists(lines, PE, PN);
      const sorted = [...pd].sort((a, b) => a - b);
      const σ  = Math.max(sorted[Math.floor(sorted.length / 2)] / 0.6745, 0.1);
      const weights = pd.map(d => {
        const r = d / σ;
        if (Math.abs(r) >= C * Math.PI) return 1e-10;
        if (Math.abs(r) < 1e-10) return 1;
        return Math.sin(r / C) / (r / C);
      });
      const sol = this._solveWeighted(lines, weights);
      if (!sol) break;
      const δ = Math.hypot(sol.PE - PE, sol.PN - PN);
      PE = sol.PE; PN = sol.PN; det = sol.det;
      if (δ < THRESH) break;
    }
    const pd = this._perpDists(lines, PE, PN);
    const er = this._errorRadius(pd, lines, PE, PN, bearingErrDeg);
    const pos = this.fromENU(PE, PN, rLat, rLon);
    return { lat: pos.lat, lon: pos.lon, errorRadius: er, det, gdopWarning: false, algorithmUsed: 'Andrews' };
  },

  /** Geometric Centroid: arithmetic mean of all pairwise bearing-line intersections. */
  solveGeomCentroid(obs, bearingErrDeg = 5) {
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);
    const ipts = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const l1 = lines[i], l2 = lines[j];
        const d = l1.a * l2.b - l2.a * l1.b;
        if (Math.abs(d) < 1e-10) continue;
        ipts.push({
          E: (l1.c * l2.b - l2.c * l1.b) / d,
          N: (l1.a * l2.c - l2.a * l1.c) / d
        });
      }
    }
    if (ipts.length === 0) return { gdopWarning: true, det: 0 };

    const PE = ipts.reduce((s, p) => s + p.E, 0) / ipts.length;
    const PN = ipts.reduce((s, p) => s + p.N, 0) / ipts.length;

    const pd     = this._perpDists(lines, PE, PN);
    const spread = Math.sqrt(ipts.reduce((s, p) => s + (p.E-PE)**2 + (p.N-PN)**2, 0) / ipts.length);
    const er     = Math.max(this._errorRadius(pd, lines, PE, PN, bearingErrDeg), spread);
    const sol    = this._solveWeighted(lines, new Array(lines.length).fill(1));
    const pos    = this.fromENU(PE, PN, rLat, rLon);
    return { lat: pos.lat, lon: pos.lon, errorRadius: er,
             det: sol ? sol.det : 0, gdopWarning: false, algorithmUsed: 'Geometric Centroid' };
  },

  /**
   * Statistical Means: arithmetic / geometric / harmonic mean of the
   * pairwise intersection cloud.
   * meanType: 'arithmetic' | 'geometric' | 'harmonic'
   */
  solveStatMeans(obs, bearingErrDeg = 5, meanType = 'arithmetic') {
    const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
    const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;
    const lines = this._buildLines(obs, rLat, rLon);
    const ipts = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const l1 = lines[i], l2 = lines[j];
        const d = l1.a * l2.b - l2.a * l1.b;
        if (Math.abs(d) < 1e-10) continue;
        ipts.push({
          E: (l1.c * l2.b - l2.c * l1.b) / d,
          N: (l1.a * l2.c - l2.a * l1.c) / d
        });
      }
    }
    if (ipts.length === 0) return { gdopWarning: true, det: 0 };

    let PE, PN;
    if (meanType === 'geometric') {
      const sE = Math.abs(Math.min(...ipts.map(p => p.E))) + 1;
      const sN = Math.abs(Math.min(...ipts.map(p => p.N))) + 1;
      PE = Math.exp(ipts.reduce((s, p) => s + Math.log(p.E + sE), 0) / ipts.length) - sE;
      PN = Math.exp(ipts.reduce((s, p) => s + Math.log(p.N + sN), 0) / ipts.length) - sN;
    } else if (meanType === 'harmonic') {
      const sInvE = ipts.reduce((s, p) => s + 1 / (p.E || 1e-9), 0);
      const sInvN = ipts.reduce((s, p) => s + 1 / (p.N || 1e-9), 0);
      PE = ipts.length / sInvE;
      PN = ipts.length / sInvN;
    } else { // arithmetic (default)
      PE = ipts.reduce((s, p) => s + p.E, 0) / ipts.length;
      PN = ipts.reduce((s, p) => s + p.N, 0) / ipts.length;
    }

    const pd  = this._perpDists(lines, PE, PN);
    const er  = this._errorRadius(pd, lines, PE, PN, bearingErrDeg);
    const sol = this._solveWeighted(lines, new Array(lines.length).fill(1));
    const pos = this.fromENU(PE, PN, rLat, rLon);
    const lbl = { arithmetic: 'Arith. Mean', geometric: 'Geom. Mean', harmonic: 'Harm. Mean' };
    return { lat: pos.lat, lon: pos.lon, errorRadius: er,
             det: sol ? sol.det : 0, gdopWarning: false,
             algorithmUsed: lbl[meanType] || 'Stat. Mean' };
  },

  /**
   * Biangulation: exact intersection of exactly 2 bearing lines.
   * Uncertainty is the max distance from the fix to the four error-polygon
   * corners produced by ±bearingErr on each line.
   */
  solveBiangulation(obs, bearingErrDeg = 5) {
    if (obs.length !== 2) return { error: 'Biangulation requires exactly 2 active observations.' };
    const rLat = (obs[0].lat + obs[1].lat) / 2;
    const rLon = (obs[0].lon + obs[1].lon) / 2;
    const lines = this._buildLines(obs, rLat, rLon);
    const l1 = lines[0], l2 = lines[1];
    const det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < GDOP_THRESHOLD) return { gdopWarning: true, det: Math.abs(det) };

    const PE = (l1.c * l2.b - l2.c * l1.b) / det;
    const PN = (l1.a * l2.c - l2.a * l1.c) / det;

    // Four corners of the error polygon (±err on each line)
    const corners = [];
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const t0 = { ...obs[0], trueBearing: obs[0].trueBearing + s1 * bearingErrDeg };
        const t1 = { ...obs[1], trueBearing: obs[1].trueBearing + s2 * bearingErrDeg };
        const tl = this._buildLines([t0, t1], rLat, rLon);
        const d  = tl[0].a * tl[1].b - tl[1].a * tl[0].b;
        if (Math.abs(d) < 1e-10) continue;
        corners.push({
          E: (tl[0].c * tl[1].b - tl[1].c * tl[0].b) / d,
          N: (tl[0].a * tl[1].c - tl[1].a * tl[0].c) / d
        });
      }
    }
    const er = corners.length
      ? Math.max(...corners.map(c => Math.hypot(c.E - PE, c.N - PN)))
      : this.toRad(bearingErrDeg) * Math.hypot(PE - l1.E, PN - l1.N);

    const pos = this.fromENU(PE, PN, rLat, rLon);
    return { lat: pos.lat, lon: pos.lon, errorRadius: er, det: Math.abs(det),
             gdopWarning: false, algorithmUsed: 'Biangulation' };
  },

  /** Route to the correct algorithm. */
  solve(obs, bearingErrDeg = 5, algorithm = 'mle', meanType = 'arithmetic') {
    switch (algorithm) {
      case 'ols':          return this.solveOLS(obs, bearingErrDeg);
      case 'mle':          return this.solveMLE(obs, bearingErrDeg);
      case 'huber':        return this.solveHuber(obs, bearingErrDeg);
      case 'andrews':      return this.solveAndrews(obs, bearingErrDeg);
      case 'centroid':     return this.solveGeomCentroid(obs, bearingErrDeg);
      case 'statmeans':    return this.solveStatMeans(obs, bearingErrDeg, meanType);
      case 'biangulation': return this.solveBiangulation(obs, bearingErrDeg);
      default:             return this.solveOLS(obs, bearingErrDeg);
    }
  }
};


// Active algorithm and mean-type (persisted to localStorage)
let _algorithm = 'mle';
let _meanType  = 'arithmetic';


// ================================================================
//  ENTITLEMENT
// ================================================================

/** Generate or retrieve a stable per-device UUID stored in localStorage. */
function _generateDeviceId() {
  try {
    let id = localStorage.getItem('claude-tri-device-id');
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('claude-tri-device-id', id);
    }
    return id;
  } catch (_) { return 'unknown'; }
}

/**
 * Runtime entitlement state.
 * tier:   'free' | 'premium'
 * source: 'local' | 'server' | 'offline'  (Phase 6 will populate 'server'/'offline')
 */
const Entitlement = {
  tier:     'free',
  source:   'local',
  deviceId: _generateDeviceId(),
};

// DEV ONLY: null = use real entitlement; 'free' | 'premium' = forced override.
// Remove (or keep null) before any public deployment.
let _devTierOverride = null;

/** Returns true when the user has an active premium entitlement. */
function isPremium() {
  if (_devTierOverride !== null) return _devTierOverride === 'premium';
  return DEV_OVERRIDE || Entitlement.tier === 'premium';
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
 * Updates Entitlement.tier and re-applies feature gates if the tier changed.
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
    const newTier = data?.tier ?? 'free';
    if (newTier !== Entitlement.tier) {
      Entitlement.tier = newTier;
      applyEntitlementGates();
    }
    console.log('[Entitlement] Tier from server:', newTier);
  } catch (err) {
    console.warn('[Entitlement] Could not fetch tier:', err.message);
  }
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

    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/create-checkout-session`,
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ appUrl }),
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    // Redirect to Stripe's hosted checkout page
    window.location.href = json.url;
  } catch (err) {
    console.error('[Checkout] Failed to start checkout:', err.message);
    btn.textContent = originalLabel;
    btn.disabled = false;
    alert('Could not start checkout. Please try again.');
  }
}

// ================================================================
//  DEVICE REGISTRY  (Phase 4)
// ================================================================

/**
 * Upsert this device into the devices table.
 * On a brand-new device this fires an INSERT → the DB trigger removes any
 * device beyond the 2-device limit automatically.
 * On a returning device it updates last_seen only (no trigger, no eviction).
 */
async function _registerDevice(session) {
  if (!_supabase || !session) return;
  try {
    const { error } = await _supabase.from('devices').upsert(
      {
        user_id:      session.user.id,
        device_id:    Entitlement.deviceId,
        last_seen:    new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' }
    );
    if (error) throw error;
    console.log('[Device] Registered/refreshed:', Entitlement.deviceId);
  } catch (err) {
    console.warn('[Device] Registration failed:', err.message);
  }
}

/**
 * Verify this device is still in the devices table.
 * Returns true if verified (or if Supabase is unreachable — fail open).
 * Returns false if the device was evicted (3rd-device kick).
 */
async function _verifyDevice(session) {
  if (!_supabase || !session) return true;
  try {
    const { data, error } = await _supabase
      .from('devices')
      .select('id')
      .eq('user_id',   session.user.id)
      .eq('device_id', Entitlement.deviceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      _handleDeviceRevoked();
      return false;
    }
    return true;
  } catch (err) {
    // Fail open — if Supabase is unreachable we don't lock the user out
    console.warn('[Device] Verification skipped (network issue):', err.message);
    return true;
  }
}

/**
 * Called when this device has been evicted by the 2-device limit.
 * Signs out locally and shows a clear message to the user.
 */
async function _handleDeviceRevoked() {
  console.warn('[Device] This device was evicted by the 2-device limit.');
  await _supabase.auth.signOut();
  // Show the auth modal with an explanatory info message
  _showAuthModal('signin');
  _showAuthMsg(
    'You were signed out because this account is active on 2 other devices. ' +
    'Sign in again to use this device (the oldest device will be removed).',
    'info'
  );
}

// ================================================================
//  AUTH UI
// ================================================================

let _authMode = 'signin'; // 'signin' | 'signup'

/** Show or hide the Sign In / account badge based on session state. */
function _updateAccountUI(session) {
  const loggedIn = !!session;
  get('accountBadge').classList.toggle('hidden', !loggedIn);
  get('signInBtn').classList.toggle('hidden', loggedIn);
  if (session) {
    get('accountEmail').textContent = session.user.email;
  }
}

/** Open the auth modal in the given mode ('signin' or 'signup'). */
function _showAuthModal(mode = 'signin') {
  _setAuthMode(mode);
  _clearAuthMsg();
  get('authEmailInput').value    = '';
  get('authPasswordInput').value = '';
  get('authOverlay').classList.remove('hidden');
  setTimeout(() => get('authEmailInput').focus(), 60);
}

function _hideAuthModal() {
  get('authOverlay').classList.add('hidden');
  _clearAuthMsg();
}

function _setAuthMode(mode) {
  _authMode = mode;
  const isSignIn = mode === 'signin';
  get('authTitle').textContent        = isSignIn ? 'Sign In' : 'Create Account';
  get('authSubmitBtn').textContent    = isSignIn ? 'Sign In' : 'Create Account';
  get('authToggleLabel').textContent  = isSignIn ? "Don't have an account?" : 'Already have an account?';
  get('authToggleBtn').textContent    = isSignIn ? 'Create one' : 'Sign in';
  get('authPasswordInput').autocomplete = isSignIn ? 'current-password' : 'new-password';
}

function _showAuthMsg(text, type = 'error') {
  const el = get('authMsg');
  el.textContent = text;
  el.className   = `auth-msg ${type}`;
}

function _clearAuthMsg() {
  const el = get('authMsg');
  el.textContent = '';
  el.className   = 'auth-msg hidden';
}

async function _handleAuthSubmit() {
  if (!_supabase) return;

  const email    = get('authEmailInput').value.trim();
  const password = get('authPasswordInput').value;
  const btn      = get('authSubmitBtn');

  if (!email || !password) {
    _showAuthMsg('Please enter your email and password.');
    return;
  }

  btn.disabled    = true;
  btn.textContent = _authMode === 'signin' ? 'Signing in…' : 'Creating account…';
  _clearAuthMsg();

  try {
    let result;
    if (_authMode === 'signin') {
      result = await _supabase.auth.signInWithPassword({ email, password });
    } else {
      result = await _supabase.auth.signUp({ email, password });
    }

    if (result.error) {
      _showAuthMsg(result.error.message);
    } else if (_authMode === 'signup' && !result.data.session) {
      // Email confirmation required (enabled in Supabase Auth settings)
      _showAuthMsg('Check your email for a confirmation link, then sign in.', 'info');
    } else {
      _hideAuthModal();
    }
  } catch (err) {
    _showAuthMsg('Something went wrong. Please try again.');
  } finally {
    btn.disabled    = false;
    btn.textContent = _authMode === 'signin' ? 'Sign In' : 'Create Account';
  }
}

async function _handleSignOut() {
  if (!_supabase) return;
  await _supabase.auth.signOut();
  // onAuthStateChange will fire and update the UI
}

/** DEV ONLY: Destroy the current Leaflet map so it reinitialises with
 *  the correct tile layer when setDevTier() calls compute(). */
function _destroyMap() {
  if (_map) {
    _map.remove();
    _map    = null;
    _layers = null;
  }
  _tileErrCount = 0;
  _tilesHealthy = true;
  _lastDrawArgs = null;
}

/** DEV ONLY: Switch between 'free' and 'premium' at runtime for testing.
 *  Call setDevTier(null) to restore real entitlement logic.
 *  Remove before going live. */
function setDevTier(tier) {
  _devTierOverride = tier;   // 'free' | 'premium' | null
  _destroyMap();
  applyEntitlementGates();
  compute();
}


// ================================================================
//  FORMATTERS
// ================================================================

function toDMS(dec, isLon) {
  const abs = Math.abs(dec);
  const d   = Math.floor(abs);
  const mf  = (abs - d) * 60;
  const m   = Math.floor(mf);
  const s   = (mf - m) * 60;
  const dir = isLon ? (dec >= 0 ? 'E' : 'W') : (dec >= 0 ? 'N' : 'S');
  return `${d}° ${m}′ ${s.toFixed(1)}″ ${dir}`;
}

function fmtDec(lat, lon) {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'},  `
       + `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
}

function fmtRadius(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}


// ================================================================
//  OBSERVER CARD MANAGEMENT
// ================================================================

// Eight-colour palette — cycles for cards beyond 8
const OBS_PALETTE     = ['#38bdf8','#fb923c','#a78bfa','#4ade80','#f472b6','#facc15','#34d399','#fb7185'];
const OBS_PALETTE_SUN = ['#0369a1','#c2410c','#6d28d9','#15803d','#be185d','#b45309','#047857','#be123c'];

// Monotonically increasing ID — ensures GPS button IDs stay unique after deletions
let _nextObsId = 0;

// Cached geo-support result so newly created cards inherit the right disabled state
let _geoSupported = true;

function obsColor(index, sun) {
  const pal = sun ? OBS_PALETTE_SUN : OBS_PALETTE;
  return pal[index % pal.length];
}

/** Apply the correct accent color to a card's left border and dot. */
function colorCard(card, index) {
  const sun   = document.documentElement.dataset.theme === 'sun';
  const color = card.classList.contains('obs-disabled')
    ? 'var(--border2)'
    : obsColor(index, sun);
  card.style.borderLeftColor = color;
  const dot = card.querySelector('.obs-dot');
  if (dot) {
    dot.style.background  = color;
    dot.style.boxShadow   = (card.classList.contains('obs-disabled') || sun) ? 'none' : `0 0 6px ${color}`;
  }
}

/** Re-color all cards and update their sequential "Observer N" titles. */
function refreshCards() {
  qsa('.obs-card').forEach((card, i) => {
    colorCard(card, i);
    const numEl = card.querySelector('.obs-num');
    if (numEl) numEl.textContent = `Observer ${i + 1}`;
  });
}

/**
 * Show/hide toggles and delete buttons based on total card count.
 * Rule: toggles appear on ALL cards once a 4th card exists.
 *       delete buttons appear only on cards beyond the first 3 (index ≥ 3).
 */
function refreshCardControls() {
  const cards      = qsa('.obs-card');
  const showToggle = cards.length > 3;

  cards.forEach((card, i) => {
    card.querySelector('.toggle-wrap').classList.toggle('hidden', !showToggle);
    card.querySelector('.obs-delete').classList.toggle('hidden', i < 3);
  });

  // Obs count badge: only visible when toggles are visible
  const countEl = get('obsCount');
  if (showToggle) {
    const total   = cards.length;
    const enabled = cards.filter(c => c.querySelector('.obs-enabled').checked).length;
    countEl.textContent = `Using ${enabled} of ${total}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }

  // Keep the Add Observation button gate in sync as card count changes
  _refreshAddObsBtn();
}

/**
 * Apply or lift premium feature gates based on current entitlement.
 * Call on page load and whenever entitlement changes (Phase 6+).
 */
function applyEntitlementGates() {
  const premium = isPremium();

  // ── Algorithm selector ──────────────────────────────────────────
  // Lock premium options for free users; restore them for premium users.
  get('algorithmSelect').querySelectorAll('option[data-premium]').forEach(opt => {
    const base = opt.dataset.label;           // clean label stored in data attr
    opt.textContent = premium ? base : `${base}  ✦`;
    opt.disabled    = !premium;
  });

  // If a free user has a premium algorithm active (e.g. from a stale save),
  // fall back to OLS silently.
  if (!premium && _algorithm !== 'ols') {
    _algorithm = 'ols';
    get('algorithmSelect').value = 'ols';
    get('meanTypeWrap').classList.add('hidden');
    applyBiangulationLock(false);
  }

  // ── Upgrade button visibility ────────────────────────────────────
  get('upgradeBtn').classList.toggle('hidden', premium);

  // ── Satellite upgrade hint in diagram card ───────────────────────
  get('satelliteHint').classList.toggle('hidden', premium);

  // ── Add Observation button gate ──────────────────────────────────
  // (Also handled dynamically in refreshCardControls as card count changes.)
  _refreshAddObsBtn();
}

/** Sync the Add Observation button's locked/unlocked appearance. */
function _refreshAddObsBtn() {
  const locked = !isPremium() && qsa('.obs-card').length >= 3;
  const btn    = get('addObsBtn');
  btn.classList.toggle('btn-add-obs-locked', locked);
  btn.textContent = locked ? '+ Add Observation  ✦' : '+ Add Observation';
}

/** Build and return a new observer card DOM element. */
function buildObsCard(obsId, cardNumber) {
  const section = document.createElement('section');
  section.className      = 'card obs-card';
  section.dataset.obsId  = obsId;

  section.innerHTML = `
    <div class="card-title">
      <span class="obs-dot dot"></span>
      <span class="obs-num">Observer ${cardNumber}</span>
      <label class="toggle-wrap hidden" title="Include this observation in the fix">
        <input type="checkbox" class="obs-enabled sr-only" checked>
        <span class="toggle-pill"></span>
      </label>
      <button class="obs-delete hidden" type="button" title="Remove this observation" aria-label="Remove Observer ${cardNumber}">×</button>
    </div>
    <div class="form-stack">
      <div class="field">
        <label>Label (optional)</label>
        <input type="text" class="obs-label" placeholder="OP-${cardNumber}" maxlength="10">
      </div>
      <div class="two-col">
        <div class="field">
          <label>Latitude</label>
          <input type="number" class="obs-lat" step="0.0001" placeholder="e.g. 47.6062" min="-90" max="90">
          <span class="hint">−90 to 90</span>
        </div>
        <div class="field">
          <label>Longitude</label>
          <input type="number" class="obs-lon" step="0.0001" placeholder="e.g. −122.332" min="-180" max="180">
          <span class="hint">−180 to 180</span>
        </div>
      </div>
      <div class="field">
        <button class="gps-btn" id="gpsBtn-${obsId}" type="button">📍 Use My Location</button>
        <span class="gps-accuracy hidden" id="gpsAcc-${obsId}"></span>
      </div>
      <div class="field">
        <label>Magnetic Bearing</label>
        <div class="input-unit">
          <input type="number" class="obs-bearing" step="0.1" placeholder="0 – 359.9" min="0" max="359.9">
          <span class="unit-badge">° mag</span>
        </div>
        <span class="hint">Compass reading toward the signal source</span>
      </div>
    </div>`;

  // ── Wire up listeners ──

  // Input changes → live recompute
  section.querySelectorAll('input[type="number"], input[type="text"]').forEach(inp => {
    inp.addEventListener('input', compute);
  });

  // Toggle → enable/disable card visually + recompute
  const toggle = section.querySelector('.obs-enabled');
  toggle.addEventListener('change', () => {
    section.classList.toggle('obs-disabled', !toggle.checked);
    refreshCards();
    refreshCardControls();
    compute();
  });

  // Delete button → remove card, renumber, recompute
  section.querySelector('.obs-delete').addEventListener('click', () => {
    section.remove();
    refreshCards();
    refreshCardControls();
    compute();
    save();
  });

  // GPS button — query within the card, not the document (card isn't in DOM yet)
  const gpsBtn = section.querySelector('.gps-btn');
  gpsBtn.addEventListener('click', () => handleGpsBtn(obsId));
  if (!_geoSupported) gpsBtn.disabled = true;

  return section;
}

/** Add a new observer card to the container. */
function addObsCard(opts = {}) {
  const container  = get('obsContainer');
  const cardNumber = qsa('.obs-card').length + 1;
  const obsId      = _nextObsId++;
  const card       = buildObsCard(obsId, cardNumber);

  // Optionally pre-populate fields (used by load())
  if (opts.label   != null) card.querySelector('.obs-label').value   = opts.label;
  if (opts.lat     != null) card.querySelector('.obs-lat').value     = opts.lat;
  if (opts.lon     != null) card.querySelector('.obs-lon').value     = opts.lon;
  if (opts.bearing != null) card.querySelector('.obs-bearing').value = opts.bearing;
  if (opts.enabled === false) {
    card.querySelector('.obs-enabled').checked = false;
    card.classList.add('obs-disabled');
  }

  container.appendChild(card);
  refreshCards();
  refreshCardControls();
  if (_algorithm === 'biangulation') applyBiangulationLock(true);
  return card;
}

/** Create the initial 3 cards on page load. */
function initObsCards() {
  for (let i = 0; i < 3; i++) addObsCard();
}

/**
 * Lock/unlock observer cards beyond index 1 for biangulation mode.
 * Locked cards are greyed out and excluded from readInputs(); their
 * data is preserved so unlocking restores the session intact.
 */
function applyBiangulationLock(active) {
  qsa('.obs-card').forEach((card, i) => {
    if (active && i >= 2) {
      if (!card.hasAttribute('data-bia-locked')) {
        card.setAttribute('data-bia-locked', '1');
        card.classList.add('obs-bia-locked', 'obs-disabled');
      }
    } else if (!active && card.hasAttribute('data-bia-locked')) {
      card.removeAttribute('data-bia-locked');
      card.classList.remove('obs-bia-locked');
      const enabled = card.querySelector('.obs-enabled').checked;
      card.classList.toggle('obs-disabled', !enabled);
    }
  });
  refreshCards();
}


// ================================================================
//  STORAGE  (schema v2 — clean break from v1)
// ================================================================

const SK = 'claude-triangulation-v2';

function save() {
  try {
    localStorage.setItem(SK, JSON.stringify({
      decl:      get('declination').value,
      berr:      get('bearingError').value,
      algorithm: _algorithm,
      meanType:  _meanType,
      obs: qsa('.obs-card').map(card => ({
        label:   card.querySelector('.obs-label').value,
        lat:     card.querySelector('.obs-lat').value,
        lon:     card.querySelector('.obs-lon').value,
        bearing: card.querySelector('.obs-bearing').value,
        enabled: card.querySelector('.obs-enabled').checked,
      }))
    }));
  } catch (_) {}
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SK) || 'null');
    if (!s) return;

    if (s.decl != null) get('declination').value = s.decl;
    if (s.berr != null) {
      get('bearingError').value = s.berr;
      get('bearingErrorLabel').textContent = `±${s.berr}°`;
    }
    if (s.algorithm) {
      _algorithm = s.algorithm;
      get('algorithmSelect').value = s.algorithm;
      get('meanTypeWrap').classList.toggle('hidden', s.algorithm !== 'statmeans');
    }
    if (s.meanType) {
      _meanType = s.meanType;
      get('meanTypeSelect').value = s.meanType;
    }

    const savedObs = s.obs || [];

    // Ensure we have exactly as many cards as saved observations
    // (initObsCards already created 3; add or trim as needed)
    while (qsa('.obs-card').length < savedObs.length) addObsCard();
    while (qsa('.obs-card').length > Math.max(savedObs.length, 3)) {
      qsa('.obs-card').at(-1).remove();
    }

    // Populate each card with saved values
    qsa('.obs-card').forEach((card, i) => {
      const o = savedObs[i];
      if (!o) return;
      if (o.label   != null) card.querySelector('.obs-label').value   = o.label;
      if (o.lat     != null) card.querySelector('.obs-lat').value     = o.lat;
      if (o.lon     != null) card.querySelector('.obs-lon').value     = o.lon;
      if (o.bearing != null) card.querySelector('.obs-bearing').value = o.bearing;
      const enabled = o.enabled !== false;
      card.querySelector('.obs-enabled').checked = enabled;
      card.classList.toggle('obs-disabled', !enabled);
    });

    refreshCards();
    refreshCardControls();
    if (_algorithm === 'biangulation') applyBiangulationLock(true);
  } catch (_) {}
}

function wipe() {
  try { localStorage.removeItem(SK); } catch (_) {}

  // Remove any extra cards beyond the first 3
  qsa('.obs-card').slice(3).forEach(c => c.remove());

  // Reset first 3 cards
  qsa('.obs-card').forEach(card => {
    card.querySelectorAll('.obs-label, .obs-lat, .obs-lon, .obs-bearing')
        .forEach(el => { el.value = ''; el.classList.remove('err'); });
    card.querySelector('.obs-enabled').checked = true;
    card.classList.remove('obs-disabled');
    const acc = get(`gpsAcc-${card.dataset.obsId}`);
    if (acc) { acc.textContent = ''; acc.className = 'gps-accuracy hidden'; }
  });

  get('declination').value = 0;
  get('bearingError').value = 5;
  get('bearingErrorLabel').textContent = '±5°';

  // Reset algorithm to default (OLS for free, MLE for premium)
  applyBiangulationLock(false);
  _algorithm = isPremium() ? 'mle' : 'ols';
  _meanType  = 'arithmetic';
  get('algorithmSelect').value  = _algorithm;
  get('meanTypeSelect').value   = 'arithmetic';
  get('meanTypeWrap').classList.add('hidden');

  refreshCards();
  refreshCardControls();
  applyEntitlementGates();
}


// ================================================================
//  INPUT PARSING & VALIDATION
// ================================================================

function pf(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

/**
 * Returns the count of observations that are currently active.
 * In biangulation mode, counts non-locked cards (ignores toggle state).
 * Otherwise uses toggle state when toggles are visible (4+ cards), else all cards.
 */
function activeObsCount() {
  const cards = qsa('.obs-card');
  if (_algorithm === 'biangulation') {
    return cards.filter(c => !c.hasAttribute('data-bia-locked')).length;
  }
  if (cards.length <= 3) return cards.length;
  return cards.filter(c => c.querySelector('.obs-enabled').checked).length;
}

function readInputs() {
  const decl  = pf(get('declination').value) ?? 0;
  const berr  = pf(get('bearingError').value) ?? 5;
  const cards = qsa('.obs-card');
  const useToggles = cards.length > 3;

  const obs = [];
  let allValid = true;
  const isBiaMode = _algorithm === 'biangulation';

  cards.forEach((card, cardIndex) => {
    // Skip biangulation-locked cards always
    if (card.hasAttribute('data-bia-locked')) return;
    // Skip user-disabled cards in normal mode (when toggles are visible)
    if (!isBiaMode && useToggles && !card.querySelector('.obs-enabled').checked) return;

    const latEl  = card.querySelector('.obs-lat');
    const lonEl  = card.querySelector('.obs-lon');
    const bearEl = card.querySelector('.obs-bearing');
    const labEl  = card.querySelector('.obs-label');

    const lat = pf(latEl.value);
    const lon = pf(lonEl.value);
    const mag = pf(bearEl.value);

    const latBad = lat === null || lat < -90  || lat > 90;
    const lonBad = lon === null || lon < -180 || lon > 180;
    const magBad = mag === null || mag < 0    || mag > 359.9;

    latEl.classList.toggle('err',  latEl.value  !== '' && latBad);
    lonEl.classList.toggle('err',  lonEl.value  !== '' && lonBad);
    bearEl.classList.toggle('err', bearEl.value !== '' && magBad);

    if (latBad || lonBad || magBad) { allValid = false; return; }

    obs.push({
      lat, lon,
      trueBearing: Engine.applyDeclination(mag, decl),
      label: labEl.value.trim() || `OP-${cardIndex + 1}`
    });
  });

  const minObs = isBiaMode ? 2 : 3;
  return allValid && obs.length >= minObs ? { obs, berr } : null;
}


// ================================================================
//  SVG DIAGRAM  (offline fallback + primary when Leaflet unavailable)
// ================================================================

const SVG_W = 580, SVG_H = 460;

function mkSvg(tag, attrs, text) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/** Extend a bearing ray from (ox,oy) to the SVG boundary. */
function rayEnd(ox, oy, bearingDeg) {
  const dx =  Math.sin(Engine.toRad(bearingDeg));
  const dy = -Math.cos(Engine.toRad(bearingDeg));   // SVG Y is flipped
  let t = Infinity;
  if (Math.abs(dx) > 1e-9) t = Math.min(t, dx > 0 ? (SVG_W - ox)/dx : -ox/dx);
  if (Math.abs(dy) > 1e-9) t = Math.min(t, dy > 0 ? (SVG_H - oy)/dy : -oy/dy);
  if (!isFinite(t)) t = 3000;
  return { x: ox + dx*t, y: oy + dy*t };
}

function drawSvgDiagram(obs, target, errRadius) {
  const sun = document.documentElement.dataset.theme === 'sun';

  // Build theme palette for however many observers we have
  const rawPal = sun ? OBS_PALETTE_SUN : OBS_PALETTE;
  const obsColors = obs.map((_, i) => rawPal[i % rawPal.length]);
  const tgtClr    = sun ? '#b91c1c' : '#f87171';

  const th = sun ? {
    svgBg:   '#e8eef5', areaBg: '#ffffff', gridClr: '#c8d8e8',
    halo:    '#ffffff',  compass:'#3a5a70', scaleFl:'#7a9ab5',
    legClr:  '#2a4560',  rayOp:  '0.80',   rayW:   '2.5',
    mkR: 7, xhW: 3,
    errFill: 'rgba(185,28,28,0.09)', errStroke: tgtClr,
  } : {
    svgBg:   '#080e1c', areaBg: '#0b1428', gridClr: '#141f35',
    halo:    '#080e1c',  compass:'#5a7a9a', scaleFl:'#3d5570',
    legClr:  '#7a93af',  rayOp:  '0.55',   rayW:   '1.5',
    mkR: 5.5, xhW: 2,
    errFill: 'rgba(248,113,113,0.07)', errStroke: tgtClr,
  };

  const svg = get('svgDiagram');
  svg.innerHTML = '';

  // Project to ENU from observers' centroid
  const rLat = obs.reduce((s, o) => s + o.lat, 0) / obs.length;
  const rLon = obs.reduce((s, o) => s + o.lon, 0) / obs.length;

  const oENU = obs.map(o => Engine.toENU(o.lat, o.lon, rLat, rLon));
  const tENU = Engine.toENU(target.lat, target.lon, rLat, rLon);

  // Bounding box with error padding
  const eAll = [...oENU.map(p => p.E), tENU.E];
  const nAll = [...oENU.map(p => p.N), tENU.N];
  const rawRangeE = Math.max(...eAll) - Math.min(...eAll);
  const rawRangeN = Math.max(...nAll) - Math.min(...nAll);
  const errPad = Math.min(errRadius, Math.max(rawRangeE, rawRangeN, 200) * 0.6);

  const domMinE = Math.min(...eAll) - errPad,  domMaxE = Math.max(...eAll) + errPad;
  const domMinN = Math.min(...nAll) - errPad,  domMaxN = Math.max(...nAll) + errPad;
  const domW    = Math.max(domMaxE - domMinE, 200);
  const domH    = Math.max(domMaxN - domMinN, 200);

  const mg   = { t: 24, r: 24, b: 52, l: 24 };
  const dW   = SVG_W - mg.l - mg.r,  dH = SVG_H - mg.t - mg.b;
  const scale = Math.min(dW / domW, dH / domH);
  const usedW = domW * scale,  usedH = domH * scale;
  const ox0   = mg.l + (dW - usedW) / 2;
  const oy0   = mg.t + (dH - usedH) / 2;

  function s(E, N) {
    return { x: ox0 + (E - domMinE)*scale, y: oy0 + usedH - (N - domMinN)*scale };
  }

  svg.appendChild(mkSvg('rect', { x:0, y:0, width:SVG_W, height:SVG_H, fill:th.svgBg }));
  svg.appendChild(mkSvg('rect', { x:ox0, y:oy0, width:usedW, height:usedH, fill:th.areaBg, rx:'4' }));

  const grid = mkSvg('g', { stroke:th.gridClr, 'stroke-width':'0.5' });
  for (let i = 0; i <= 8; i++) {
    grid.appendChild(mkSvg('line', { x1:ox0+(i/8)*usedW, y1:oy0, x2:ox0+(i/8)*usedW, y2:oy0+usedH }));
    grid.appendChild(mkSvg('line', { x1:ox0, y1:oy0+(i/8)*usedH, x2:ox0+usedW, y2:oy0+(i/8)*usedH }));
  }
  svg.appendChild(grid);

  const defs = mkSvg('defs', {});
  const cp   = mkSvg('clipPath', { id:'drawarea' });
  cp.appendChild(mkSvg('rect', { x:ox0-1, y:oy0-1, width:usedW+2, height:usedH+2 }));
  defs.appendChild(cp);
  svg.appendChild(defs);

  // Error circle
  const tp   = s(tENU.E, tENU.N);
  const erPx = Math.max(errRadius * scale, 5);
  svg.appendChild(mkSvg('circle', {
    cx:tp.x, cy:tp.y, r:erPx, fill:th.errFill,
    stroke:th.errStroke, 'stroke-width':sun?'2':'1.5', 'stroke-dasharray':'6,4'
  }));

  // Bearing rays
  const rayGroup = mkSvg('g', { 'clip-path':'url(#drawarea)' });
  obs.forEach((o, i) => {
    const op = s(oENU[i].E, oENU[i].N);
    const ep = rayEnd(op.x, op.y, o.trueBearing);
    rayGroup.appendChild(mkSvg('line', {
      x1:op.x, y1:op.y, x2:ep.x, y2:ep.y,
      stroke:obsColors[i], 'stroke-width':th.rayW, opacity:th.rayOp, 'stroke-dasharray':'7,4'
    }));
  });
  svg.appendChild(rayGroup);

  // Observer markers
  obs.forEach((o, i) => {
    const op  = s(oENU[i].E, oENU[i].N);
    const c   = obsColors[i];
    const mkR = th.mkR;
    svg.appendChild(mkSvg('circle', { cx:op.x, cy:op.y, r:mkR+5, fill:'none', stroke:c, 'stroke-width':'1', opacity:sun?'0.4':'0.25' }));
    svg.appendChild(mkSvg('circle', { cx:op.x, cy:op.y, r:mkR, fill:c }));
    const lbl = o.label || `OP-${i+1}`;
    svg.appendChild(mkSvg('text', {
      x:op.x+mkR+6, y:op.y-7, fill:c,
      'font-size':sun?'13':'11.5', 'font-family':'monospace', 'font-weight':'bold',
      'paint-order':'stroke', stroke:th.halo, 'stroke-width':sun?'4':'3.5', 'stroke-linejoin':'round'
    }, lbl));
  });

  // Target crosshair
  const CR = sun ? 11 : 9;
  svg.appendChild(mkSvg('circle', { cx:tp.x, cy:tp.y, r:CR+7, fill:'none', stroke:tgtClr, 'stroke-width':sun?'1.5':'0.8', opacity:'0.4' }));
  svg.appendChild(mkSvg('line',   { x1:tp.x-CR, y1:tp.y, x2:tp.x+CR, y2:tp.y, stroke:tgtClr, 'stroke-width':th.xhW }));
  svg.appendChild(mkSvg('line',   { x1:tp.x, y1:tp.y-CR, x2:tp.x, y2:tp.y+CR, stroke:tgtClr, 'stroke-width':th.xhW }));
  svg.appendChild(mkSvg('circle', { cx:tp.x, cy:tp.y, r:sun?4.5:3.5, fill:tgtClr }));
  svg.appendChild(mkSvg('text', {
    x:tp.x, y:tp.y+(sun?30:26), 'text-anchor':'middle', fill:tgtClr,
    'font-size':sun?'11':'9.5', 'font-family':'monospace', 'font-weight':'bold',
    'paint-order':'stroke', stroke:th.halo, 'stroke-width':sun?'4':'3', opacity:'0.9'
  }, 'TARGET'));

  // North arrow
  const nx = SVG_W - 28, ny = 36;
  svg.appendChild(mkSvg('text',    { x:nx, y:ny-14, 'text-anchor':'middle', fill:th.compass, 'font-size':'9.5', 'font-family':'sans-serif', 'font-weight':sun?'bold':'normal' }, 'N'));
  svg.appendChild(mkSvg('line',    { x1:nx, y1:ny-10, x2:nx, y2:ny+6, stroke:th.compass, 'stroke-width':sun?'2':'1.5' }));
  svg.appendChild(mkSvg('polygon', { points:`${nx-4},${ny-4} ${nx},${ny-12} ${nx+4},${ny-4}`, fill:th.compass }));

  // Scale bar
  const candidates = [1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000];
  const mPerPx  = 1 / scale;
  const target80 = 80 * mPerPx;
  const scaleM  = candidates.reduce((b, c) => Math.abs(c - target80) < Math.abs(b - target80) ? c : b);
  const scalePx = scaleM / mPerPx;
  const sbX = ox0 + 10, sbY = oy0 + usedH + 26;
  const barH = sun ? 5 : 4;
  svg.appendChild(mkSvg('rect', { x:sbX, y:sbY-barH/2, width:scalePx, height:barH, fill:th.scaleFl, rx:'2' }));
  svg.appendChild(mkSvg('text', {
    x:sbX+scalePx/2, y:sbY+14, 'text-anchor':'middle', fill:th.compass,
    'font-size':sun?'11':'10', 'font-family':'sans-serif', 'font-weight':sun?'bold':'normal'
  }, scaleM >= 1000 ? `${scaleM/1000} km` : `${scaleM} m`));

  // Legend (supports N observers)
  const items = [
    ...obs.map((o, i) => ({ color: obsColors[i], label: o.label || `OP-${i+1}` })),
    { color: tgtClr, label: 'Target' }
  ];
  const legX = SVG_W - 90, legY = oy0 + usedH + 14;
  items.forEach((item, i) => {
    svg.appendChild(mkSvg('circle', { cx:legX+6, cy:legY+i*14, r:sun?5:4, fill:item.color }));
    svg.appendChild(mkSvg('text', {
      x:legX+16, y:legY+4+i*14, fill:th.legClr,
      'font-size':sun?'11':'9.5', 'font-family':'sans-serif', 'font-weight':sun?'600':'normal'
    }, item.label));
  });
}


// ================================================================
//  MAP DIAGRAM  (Leaflet + Esri World Imagery satellite tiles)
//  Falls back to SVG when offline or Leaflet fails to load.
// ================================================================

let _map          = null;
let _layers       = null;
let _tilesHealthy = true;
let _tileErrCount = 0;
let _lastDrawArgs = null;

/** Compute a point distM metres from (lat,lon) on bearing bearingDeg. */
function destinationPoint(lat, lon, bearingDeg, distM) {
  const δ  = distM / R_EARTH;
  const θ  = Engine.toRad(bearingDeg);
  const φ1 = Engine.toRad(lat);
  const λ1 = Engine.toRad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(θ)
  );
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ)*Math.sin(δ)*Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1)*Math.sin(φ2)
  );
  return { lat: Engine.toDeg(φ2), lon: Engine.toDeg(λ2) };
}

function _showMap() {
  get('mapDiagram').classList.remove('hidden');
  get('svgDiagram').classList.add('hidden');
}

function _showSvg() {
  get('mapDiagram').classList.add('hidden');
  get('svgDiagram').classList.remove('hidden');
}

function _initMap() {
  if (_map) return;
  _map    = L.map('mapDiagram', { zoomControl: true, preferCanvas: true });
  _layers = L.layerGroup().addTo(_map);

  // Phase 6: if entitlement changes mid-session, destroy and recreate the map
  // so the tile layer updates. For now the tier is fixed at load time.
  const tileUrl   = isPremium()
    ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileAttrib = isPremium()
    ? '&copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> &mdash; Esri, USDA, USGS, AEX, GeoEye'
    : '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  const tiles = L.tileLayer(tileUrl, { attribution: tileAttrib, maxZoom: 19 }).addTo(_map);

  tiles.on('tileerror', () => {
    _tileErrCount++;
    if (_tileErrCount >= 5 && _tilesHealthy) {
      _tilesHealthy = false;
      if (_lastDrawArgs) { _showSvg(); drawSvgDiagram(..._lastDrawArgs); }
    }
  });
  tiles.on('tileload', () => {
    _tileErrCount = Math.max(0, _tileErrCount - 1);
    _tilesHealthy = true;
  });
}

function drawDiagram(obs, target, errRadius) {
  _lastDrawArgs = [obs, target, errRadius];

  if (typeof L === 'undefined' || !navigator.onLine || !_tilesHealthy) {
    _showSvg();
    drawSvgDiagram(obs, target, errRadius);
    return;
  }

  _showMap();
  _initMap();

  const sun       = document.documentElement.dataset.theme === 'sun';
  const rawPal    = sun ? OBS_PALETTE_SUN : OBS_PALETTE;
  const obsColors = obs.map((_, i) => rawPal[i % rawPal.length]);
  const tgtColor  = sun ? '#b91c1c' : '#f87171';
  const lineW     = sun ? 2.5 : 2;
  const lineOp    = sun ? 0.85 : 0.70;

  _layers.clearLayers();

  // Error circle
  L.circle([target.lat, target.lon], {
    radius: errRadius, color: tgtColor, weight: 2, opacity: 0.85,
    fillColor: tgtColor, fillOpacity: 0.07, dashArray: '6 4',
  }).addTo(_layers);

  // Bearing rays (100 km each)
  obs.forEach((o, i) => {
    const far = destinationPoint(o.lat, o.lon, o.trueBearing, 100_000);
    L.polyline([[o.lat, o.lon], [far.lat, far.lon]], {
      color: obsColors[i], weight: lineW, opacity: lineOp, dashArray: '8 5',
    }).addTo(_layers);
  });

  // Observer markers + labels
  obs.forEach((o, i) => {
    const c   = obsColors[i];
    const lbl = o.label || `OP-${i+1}`;
    L.circleMarker([o.lat, o.lon], {
      radius: sun?8:7, color:c, weight:2, fillColor:c, fillOpacity:1,
    })
    .bindTooltip(lbl, { permanent:true, direction:'right', offset:[10,0], className:'map-label' })
    .addTo(_layers);
  });

  // Target crosshair icon
  const xhSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="11" fill="none" stroke="${tgtColor}" stroke-width="1.5" opacity="0.45"/>
    <line x1="2"  y1="14" x2="11" y2="14" stroke="${tgtColor}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="17" y1="14" x2="26" y2="14" stroke="${tgtColor}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="14" y1="2"  x2="14" y2="11" stroke="${tgtColor}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="14" y1="17" x2="14" y2="26" stroke="${tgtColor}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="14" cy="14" r="3" fill="${tgtColor}"/>
  </svg>`;
  L.marker([target.lat, target.lon], {
    icon: L.divIcon({ html:xhSvg, className:'', iconSize:[28,28], iconAnchor:[14,14] }),
    zIndexOffset: 1000,
  })
  .bindTooltip('TARGET', { permanent:true, direction:'bottom', offset:[0,10], className:'map-label map-target-label' })
  .addTo(_layers);

  // Fit bounds
  const pts    = obs.map(o => [o.lat, o.lon]);
  pts.push([target.lat, target.lon]);
  const bounds = L.latLngBounds(pts);
  const pad    = errRadius / 111_320;
  bounds.extend([target.lat+pad, target.lon+pad]);
  bounds.extend([target.lat-pad, target.lon-pad]);
  setTimeout(() => {
    _map.invalidateSize();
    _map.fitBounds(bounds, { padding:[48,48], maxZoom:17 });
  }, 60);
}


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
//  GEOLOCATION (GPS AUTO-FILL)
// ================================================================

function detectGeoSupport() {
  if (!('geolocation' in navigator)) return { supported: false, reason: 'no-api' };
  if (!window.isSecureContext)       return { supported: false, reason: 'insecure' };
  return { supported: true };
}

function setGpsState(supported, reason) {
  _geoSupported = supported;
  qsa('.gps-btn').forEach(b => { b.disabled = !supported; });

  const banner = get('gpsBanner');
  const detail = get('gpsBannerDetail');

  if (supported) { banner.classList.add('hidden'); return; }

  detail.innerHTML = reason === 'insecure'
    ? 'Your browser requires a <strong>secure context (HTTPS)</strong> to access GPS. '
      + 'On Android, open this file with <strong>Firefox</strong> — '
      + 'it allows GPS from local HTML files without a server.'
    : 'This browser does not support the Geolocation API. '
      + 'On Android, <strong>Firefox</strong> supports GPS from local HTML files.';
  banner.classList.remove('hidden');
}

function handleGpsBtn(obsId) {
  const card  = document.querySelector(`.obs-card[data-obs-id="${obsId}"]`);
  if (!card) return;
  const latEl = card.querySelector('.obs-lat');
  const lonEl = card.querySelector('.obs-lon');
  const btn   = get(`gpsBtn-${obsId}`);
  const accEl = get(`gpsAcc-${obsId}`);

  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;animation:spin 0.8s linear infinite">⟳</span>&ensp;Getting location…';
  accEl.classList.add('hidden');

  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      latEl.value = latitude.toFixed(6);
      lonEl.value = longitude.toFixed(6);
      latEl.classList.remove('err');
      lonEl.classList.remove('err');

      btn.disabled = false;
      btn.innerHTML = '📍 Use My Location';

      accEl.textContent = `GPS: ±${Math.round(accuracy)} m`;
      accEl.className   = 'gps-accuracy' + (accuracy > 50 ? ' warn' : '');
      accEl.classList.remove('hidden');
      compute();
    },
    err => {
      btn.disabled = false;
      btn.innerHTML = '📍 Use My Location';
      const msgs = {
        [err.PERMISSION_DENIED]:    'Location access denied — allow it in browser settings and retry.',
        [err.POSITION_UNAVAILABLE]: 'Location unavailable — check GPS signal and try again.',
        [err.TIMEOUT]:              'GPS timed out — try again.',
      };
      accEl.textContent = `⚠ ${msgs[err.code] || 'GPS error — try again.'}`;
      accEl.className   = 'gps-accuracy warn';
      accEl.classList.remove('hidden');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}


// ================================================================
//  THEME
// ================================================================

const THEME_KEY = 'claude-tri-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = get('themeBtn');
  if (theme === 'sun') {
    btn.textContent = '☾';
    btn.title = 'Switch to night mode';
    btn.setAttribute('aria-label', 'Switch to night mode');
  } else {
    btn.textContent = '☀';
    btn.title = 'Switch to sunlight mode';
    btn.setAttribute('aria-label', 'Switch to sunlight mode');
  }
  refreshCards();  // update card border/dot colors for new theme
}

get('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'sun' ? 'dark' : 'sun';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  if (!get('diagramCard').classList.contains('hidden')) compute();
});


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

  if (result === 'success') {
    // Re-sync entitlement — webhook should have written the row by now.
    // Small delay gives the webhook a moment to complete if it's still in flight.
    setTimeout(async () => {
      await _syncEntitlement();
      if (isPremium()) {
        console.log('[Checkout] Payment confirmed — premium unlocked.');
      }
    }, 1500);
  }
  // Cancelled: no action needed — user just lands back on the free tier.
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

// ── Auth event listeners ──────────────────────────────────────────────────────

// Sign In button (header)
get('signInBtn').addEventListener('click', () => _showAuthModal('signin'));

// Sign Out button (account badge)
get('signOutBtn').addEventListener('click', _handleSignOut);

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
if (_supabase) {
  _supabase.auth.onAuthStateChange(async (_event, session) => {
    _updateAccountUI(session);
    // Register device on every sign-in (new or returning)
    if (session && (_event === 'SIGNED_IN' || _event === 'TOKEN_REFRESHED')) {
      await _registerDevice(session);
    }
  });
}

// ── DEV ONLY: Tier toggle radio buttons — REMOVE BEFORE GOING LIVE ──────────
(function initDevPanel() {
  const freeRadio    = get('devFreeRadio');
  const premiumRadio = get('devPremiumRadio');
  if (!freeRadio || !premiumRadio) return;

  // Initialise radio state to match real entitlement
  if (isPremium()) {
    premiumRadio.checked = true;
  } else {
    freeRadio.checked = true;
  }

  [freeRadio, premiumRadio].forEach(radio => {
    radio.addEventListener('change', () => {
      setDevTier(radio.value);   // 'free' or 'premium'
    });
  });
})();
