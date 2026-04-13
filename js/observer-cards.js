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
    opt.textContent = base;
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

  // ── Algorithm upgrade hint ──────────────────────────────────────
  get('algoUpgradeHint').classList.toggle('hidden', premium);

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
  btn.textContent = locked ? '+ Add Observation  —  Upgrade to unlock' : '+ Add Observation';
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
