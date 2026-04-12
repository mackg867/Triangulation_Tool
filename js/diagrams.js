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

/** Destroy the current Leaflet map so it reinitialises with
 *  the correct tile layer when tier changes. */
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
