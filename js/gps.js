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
