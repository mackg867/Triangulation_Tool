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
