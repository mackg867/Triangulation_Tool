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
