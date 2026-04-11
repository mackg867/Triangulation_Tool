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
