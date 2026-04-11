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
