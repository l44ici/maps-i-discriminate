/* ===== Back2Maps — Map + postcode-first ingestion (error rows skipped) ===== */
(function () {
  'use strict';

  // --- config from PHP ---
  const CFG = (typeof B2M === 'object' && B2M) || {};
  const ROOT_ID     = CFG.rootId     || 'back2maps-root';
  const CSV_URL     = CFG.csvUrl     || 'testData.csv';
  const REGIONS_URL = CFG.regionalUrl|| '';
  const STATES_URL  = CFG.statesUrl  || '';
  const SUBURBS_URL = CFG.suburbsUrl || '';
  const PCINDEX_URL = CFG.pcIndexUrl || '';
  const DIV_ZOOM    = +CFG.divZoom   || 6;
  const MRK_ZOOM    = +CFG.markerZoom|| 6;

  // Australia view box
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // ---------- utilities ----------
  const ST_ABBR = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const norm    = s => (s ?? '').toString().trim();
  const asState = s => { const x = norm(s).toUpperCase(); return ST_ABBR.has(x) ? x : ""; };
  const asPostcode = s => { const x = norm(s).replace(/\s+/g,''); return /^\d{4}$/.test(x) ? x : ""; };

  const fetchText = url => fetch(url, {cache:'no-cache'}).then(r => r.ok ? r.text() : '');
  const fetchJSON = url => fetch(url, {cache:'no-cache'}).then(r => r.ok ? r.json() : null).catch(()=>null);

  // Basic CSV parser (handles quotes, commas). Good enough for our 3–5 columns.
  function parseCSV(text) {
    const out = [];
    let i = 0, f = 0, row = [], cell = '', q = false;
    const push = () => { row.push(cell); cell=''; };
    const endRow = () => { row.push(cell); out.push(row); row=[]; cell=''; };
    while (i < text.length) {
      const c = text[i++];
      if (q) {
        if (c === '"') {
          if (text[i] === '"') { cell += '"'; i++; } else { q = false; }
        } else cell += c;
        continue;
      }
      if (c === '"') { q = true; continue; }
      if (c === ',') { push(); continue; }
      if (c === '\n') { endRow(); f=0; continue; }
      if (c === '\r') { continue; }
      cell += c;
    }
    if (cell.length || row.length) endRow();
    return out;
  }

  // point-in-polygon (ray casting) for [lon,lat] in GeoJSON polygon/multipolygon
  function pointInPolygon(pt, geom) {
    const x = pt[0], y = pt[1];
    const testPoly = (poly) => {
      let inside = false;
      for (let ring of poly) {
        for (let i=0, j=ring.length-1; i<ring.length; j=i++) {
          const xi = ring[i][0], yi = ring[i][1];
          const xj = ring[j][0], yj = ring[j][1];
          const intersect = ((yi>y)!==(yj>y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
          if (intersect) inside = !inside;
        }
      }
      return inside;
    };
    if (!geom) return false;
    if (geom.type === 'Polygon') return testPoly(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.some(testPoly);
    return false;
  }

  // topojson → geojson (supports the common "objects.regional_div")
  function topoToGeo(topology, objectName) {
    if (!topology || !topology.objects) return null;
    const obj = topology.objects[objectName] || Object.values(topology.objects)[0];
    // ultra light convert (arcs already absolute in many exported files). If not, user should supply GeoJSON.
    // We try a naive approach: if 'geometries' contains coordinates directly, pass through.
    if (obj && obj.type === 'GeometryCollection') {
      const fc = { type:'FeatureCollection', features: [] };
      for (const g of obj.geometries) {
        fc.features.push({ type:'Feature', properties: g.properties || {}, geometry: g });
      }
      return fc;
    }
    return null;
  }

  // ---------- state ----------
  let map, stateLayer, regionLayer, markers;
  let regionsFC = null;       // GeoJSON FeatureCollection of regional divisions
  let statesFC  = null;       // GeoJSON FeatureCollection of states
  let suburbIdx = null;       // [{state,suburb,postcode,lat,lon},...]
  let pcIndex   = null;       // {"2000":"NSW-07", ...}
  const countsDivision = new Map(); // divisionId -> count
  const countsState    = new Map(); // stateAbbr  -> count

  function bumpDivisionCount(id) { if (!id) return; countsDivision.set(id, (countsDivision.get(id)||0)+1); }
  function bumpStateCount(st)    { if (!st) return; countsState.set(st, (countsState.get(st)||0)+1); }

  // locate a division by postcode via table, else null
  function postcodeToDivision(pc) {
    if (pcIndex && pcIndex[pc]) return { divisionId: pcIndex[pc] };
    return null;
  }

  // suburb/state(/pc) to lat/lon via gazetteer
  function gazetteerLookup({state, suburb, postcode}) {
    if (!suburbIdx) return null;
    const s = asState(state), sub = norm(suburb).toLowerCase();
    let hit = suburbIdx.find(r =>
      asState(r.state) === s &&
      norm(r.suburb).toLowerCase() === sub &&
      (!postcode || asPostcode(r.postcode) === asPostcode(postcode))
    );
    return hit ? {lat: +hit.lat, lon: +hit.lon} : null;
  }

  // point → divisionId via polygon hit
  function pointToDivisionLatLon(lat, lon) {
    if (!regionsFC) return null;
    const pt = [lon, lat];
    for (const f of regionsFC.features) {
      if (pointInPolygon(pt, f.geometry)) {
        return { divisionId: (f.properties && (f.properties.id || f.properties.code || f.properties.name)) || null,
                 state: (f.properties && (f.properties.state || f.properties.ST || f.properties.st)) || null };
      }
    }
    return null;
  }

  // ---------- ingestion (priority: postcode → suburb → state; else skip) ----------
  function ingestRow(rec) {
    const suburb = norm(rec.Suburb ?? rec.suburb ?? rec.Town ?? rec.Locality ?? rec.City);
    const state  = asState(rec['State / Territory'] ?? rec.State ?? rec.state ?? rec.Territory);
    const pc     = asPostcode(rec['Post Code'] ?? rec.Postcode ?? rec.postcode ?? rec.PC ?? rec.Zip);

    // 1) postcode → division
    if (pc) {
      const hit = postcodeToDivision(pc);
      if (hit && hit.divisionId) {
        const st = state || '';
        if (st) bumpDivisionCount(hit.divisionId); else bumpStateCount(st);
        // postcode markers are optional; disabled by default to avoid clutter
        return;
      }
    }

    // 2) suburb+state → lat/lon → division
    if (suburb && state) {
      const pos = gazetteerLookup({state, suburb, postcode: pc});
      if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
        const div = pointToDivisionLatLon(pos.lat, pos.lon);
        if (div && div.divisionId) { bumpDivisionCount(div.divisionId); }
        else { bumpStateCount(state); }
        if (map.getZoom() >= MRK_ZOOM) {
          L.circleMarker([pos.lat, pos.lon], {radius:4, weight:1, color:'#334155', fillColor:'#334155', fillOpacity:.8})
            .addTo(markers)
            .bindPopup(`${suburb}, ${state}${pc?(' '+pc):''}`);
        }
        return;
      }
    }

    // 3) state-only fallback
    if (state) {
      bumpStateCount(state);
      return;
    }

    // 4) otherwise ignore silently
  }

  // ---------- CSV loading ----------
  async function loadCSVRows() {
    const txt = await fetchText(CSV_URL);
    if (!txt) return [];
    const rows = parseCSV(txt);
    if (!rows.length) return [];
    const hdr = rows[0].map(h => norm(h));
    const out = [];
    for (let i=1;i<rows.length;i++) {
      const r = rows[i];
      if (r.length===1 && norm(r[0])==='') continue;
      const obj = {};
      for (let c=0;c<r.length;c++) obj[hdr[c]||('col'+c)] = r[c];
      out.push(obj);
    }
    return out;
  }

  // ---------- map + layers ----------
  function styleState()  { return {weight:2, color:'#64748b', fillColor:'#f8fafc', fillOpacity:0.2}; }
  function styleRegion() { return {weight:1, color:'#475569', fillColor:'#cbd5e1', fillOpacity:0.05}; }

  async function buildMap() {
    const root = document.getElementById(ROOT_ID) || document.querySelector('.b2m-map');
    if (!root) return;

    map = L.map(root, {zoomControl:true, minZoom:3, maxZoom:12});
    map.fitBounds(AU_BOUNDS);
    markers = L.layerGroup().addTo(map);

    // Load datasets (optional ones won’t break)
    const [states, regions, suburbs, pcidx] = await Promise.all([
      STATES_URL ? fetchJSON(STATES_URL) : null,
      REGIONS_URL ? fetchJSON(REGIONS_URL) : null,
      SUBURBS_URL ? fetchJSON(SUBURBS_URL) : null,
      PCINDEX_URL ? fetchJSON(PCINDEX_URL) : null,
    ]);

    statesFC  = states && states.type ? states : null;

    // handle TopoJSON for regions if needed
    if (regions && regions.type === 'Topology') {
      regionsFC = topoToGeo(regions, 'regional_div');
    } else {
      regionsFC = regions && regions.type ? regions : null;
    }
    suburbIdx = Array.isArray(suburbs) ? suburbs : null;
    pcIndex   = pcidx && typeof pcidx === 'object' ? pcidx : null;

    if (statesFC) {
      stateLayer = L.geoJSON(statesFC, { style: styleState }).addTo(map);
    }
    if (regionsFC) {
      regionLayer = L.geoJSON(regionsFC, { style: styleRegion });
      // show regions only when zoomed in
      const toggleRegions = () => {
        if (!regionLayer) return;
        const on = map.getZoom() >= DIV_ZOOM;
        if (on && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      };
      map.on('zoomend', toggleRegions);
      toggleRegions();
    }

    // ingest CSV
    const rows = await loadCSVRows();
    rows.forEach(ingestRow);

    // optional: update a quick title tooltip on hover for regions
    if (regionLayer) {
      regionLayer.eachLayer(l => {
        const p = l.feature && l.feature.properties || {};
        const id = p.id || p.code || p.name || 'region';
        const count = countsDivision.get(id) || 0;
        l.bindTooltip(`${p.name || id}: ${count}`, {sticky:true});
      });
    }

    // state counts can be shown later if you add a legend; for now we just keep them.
    setTimeout(() => map.invalidateSize(), 150);
  }

  document.addEventListener('DOMContentLoaded', buildMap);
})();
