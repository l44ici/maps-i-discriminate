/* ===== Back2Maps — postcode-first counting into divisions/states (no markers) ===== */
(() => {
  "use strict";

  // ------- config from PHP -------
  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID     = CFG.rootId      || "back2maps-root";
  const CSV_URL     = CFG.csvUrl      || "testData.csv";
  const REGIONS_URL = CFG.regionalUrl || "regional_div.json";
  const STATES_URL  = CFG.statesUrl   || "australian-states.min.geojson";
  const SUBURBS_URL = CFG.suburbsUrl  || "suburbs.json";
  const PCINDEX_URL = CFG.pcIndexUrl  || "postcode-index.json";
  const DIV_ZOOM    = +CFG.divZoom    || 6;

  // Australia view box
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // ------- small helpers -------
  const norm = s => (s ?? '').toString().trim();
  const STS  = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = s => { const x = norm(s).toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = s => { const x = norm(s).replace(/\s+/g,''); return /^\d{4}$/.test(x) ? x : ""; };

  const fetchText = url => fetch(url, {cache:'no-cache'}).then(r => r.ok ? r.text() : '');
  const fetchJSON = url => fetch(url, {cache:'no-cache'}).then(r => r.ok ? r.json() : null).catch(()=>null);

  // CSV parser (handles quoted fields)
  function parseCSV(text){
    const out=[]; let i=0, cell="", row=[], q=false;
    const pushCell=()=>{row.push(cell);cell="";};
    const pushRow =()=>{row.push(cell);out.push(row);row=[];cell="";};
    while(i<text.length){
      const c=text[i++];
      if(q){ if(c==='\"'){ if(text[i]==='\"'){cell+='\"'; i++;} else q=false; } else cell+=c; continue; }
      if(c==='\"'){ q=true; continue; }
      if(c===','){ pushCell(); continue; }
      if(c==='\n'){ pushRow(); continue; }
      if(c==='\r') continue;
      cell+=c;
    }
    if(cell.length||row.length) pushRow();
    return out;
  }

  // point-in-polygon for [lon,lat]
  function pointInPolygon(pt, geom){
    const x=pt[0], y=pt[1];
    const testPoly = (poly) => {
      let inside=false;
      for(const ring of poly){
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
          const inter=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-12)+xi);
          if(inter) inside=!inside;
        }
      }
      return inside;
    };
    if(!geom) return false;
    if(geom.type==="Polygon") return testPoly(geom.coordinates);
    if(geom.type==="MultiPolygon") return geom.coordinates.some(testPoly);
    return false;
  }

  // naive TopoJSON -> GeoJSON (expects objects.regional_div)
  function topoToGeo(topology, objectName){
    if(!topology || !topology.objects) return null;
    const obj = topology.objects[objectName] || Object.values(topology.objects)[0];
    if(obj && obj.type === "GeometryCollection"){
      return {
        type: "FeatureCollection",
        features: obj.geometries.map(g => ({ type:"Feature", properties: g.properties || {}, geometry: g }))
      };
    }
    return null;
  }

  // ------- state -------
  let map, stateLayer, regionLayer;
  let statesFC  = null;
  let regionsFC = null;
  let suburbIdx = null;   // [{state,suburb,postcode,lat,lon}, ...]
  let pcIndex   = null;   // {"2541":"NSW-SouthCoast", ...}

  // public counters (accessible elsewhere if needed)
  window.B2M_countsDivision = window.B2M_countsDivision || new Map(); // divisionId -> n
  window.B2M_countsState    = window.B2M_countsState    || new Map(); // stateAbbr  -> n
  const bumpDiv = id => { if(!id) return; window.B2M_countsDivision.set(id,(window.B2M_countsDivision.get(id)||0)+1); };
  const bumpSt  = st => { if(!st) return; window.B2M_countsState.set(st,(window.B2M_countsState.get(st)||0)+1); };

  // postcode -> division via optional index
  function postcodeToDivision(pc){
    if(pcIndex && pcIndex[pc]) return pcIndex[pc];
    return null;
  }

  // suburb/state(/pc) -> lat/lon via optional gazetteer
  function suburbToLatLon(state, suburb, pc){
    if(!Array.isArray(suburbIdx)) return null;
    const st = asState(state), sub = norm(suburb).toLowerCase(), p = asPostcode(pc);
    const hit = suburbIdx.find(r =>
      asState(r.state)===st &&
      norm(r.suburb).toLowerCase()===sub &&
      (!p || asPostcode(r.postcode)===p)
    );
    return hit ? {lat:+hit.lat, lon:+hit.lon} : null;
  }

  // point -> divisionId via polygons
  function latLonToDivision(lat, lon){
    if(!regionsFC) return null;
    const pt=[lon,lat];
    for(const f of regionsFC.features){
      const g=f.geometry;
      if(!g) continue;
      if(g.type==="Polygon" && pointInPolygon(pt,g)) {
        return (f.properties && (f.properties.id || f.properties.code || f.properties.name)) || null;
      }
      if(g.type==="MultiPolygon" && g.coordinates.some(poly => pointInPolygon(pt,{type:"Polygon",coordinates:poly}))){
        return (f.properties && (f.properties.id || f.properties.code || f.properties.name)) || null;
      }
    }
    return null;
  }

  // read CSV and increment counts only (no markers)
  async function countFromCSV(url){
    const txt = await fetchText(url);
    if(!txt) return;

    // reset
    window.B2M_countsDivision.clear();
    window.B2M_countsState.clear();

    const rows = parseCSV(txt); if(!rows.length) return;
    const headers = rows[0].map(h => norm(h).toLowerCase());
    const idx = names => { const set=names.map(n=>n.toLowerCase()); for(let i=0;i<headers.length;i++) if(set.includes(headers[i])) return i; return -1; };

    const iLat = idx(['lat','latitude']);
    const iLon = idx(['lon','lng','longitude']);
    const iSub = idx(['suburb','town','city','locality']);
    const iSta = idx(['state / territory','state','territory']);
    const iPc  = idx(['post code','postcode','zip','pc']);

    for(let r=1;r<rows.length;r++){
      const row = rows[r]; if(!row || !row.length) continue;

      const state  = iSta>=0 ? asState(row[iSta]) : '';
      const pc     = iPc>=0  ? asPostcode(row[iPc]) : '';
      const suburb = iSub>=0 ? norm(row[iSub]) : '';

      // 1) postcode → division
      if(pc){
        const divId = postcodeToDivision(pc);
        if(divId){ bumpDiv(divId); continue; }
      }

      // 2) lat/lon direct → division (if CSV has coords)
      const lat = iLat>=0 ? +row[iLat] : NaN;
      const lon = iLon>=0 ? +row[iLon] : NaN;
      if(Number.isFinite(lat) && Number.isFinite(lon)){
        const divId = latLonToDivision(lat, lon);
        if(divId){ bumpDiv(divId); continue; }
        if(state){ bumpSt(state); continue; }
        continue;
      }

      // 3) suburb+state → lat/lon → division
      if(suburb && state){
        const pos = suburbToLatLon(state, suburb, pc);
        if(pos){
          const divId = latLonToDivision(pos.lat, pos.lon);
          if(divId){ bumpDiv(divId); continue; }
          bumpSt(state); continue;
        }
      }

      // 4) state-only
      if(state){ bumpSt(state); continue; }

      // 5) otherwise ignore (bad row)
    }
  }

  // apply counts to region layer tooltips/popups
  function applyCountsToRegions(){
    if(!regionLayer) return;
    regionLayer.eachLayer(l => {
      const p = (l.feature && l.feature.properties) || {};
      const id = p.id || p.code || p.name;
      const n  = window.B2M_countsDivision.get(id) || 0;
      p.report_count = n;

      // if you already bind popups elsewhere, skip rebinding.
      // We keep a minimal default so you see numbers without touching your theme.
      const title = (p.name || id || '(unknown)');
      const st    = p.state || p.ST || p.st || '—';
      const html  = `<strong>${title}</strong><br>State: ${st}<br>${n} report(s)`;
      if (l.getPopup && l.getPopup()) l.setPopupContent(html);
      else l.bindPopup(html);
    });
  }

  // map styles (kept subdued)
  function styleState () { return {weight:2, color:'#64748b', fillColor:'#f8fafc', fillOpacity:0.18}; }
  function styleRegion() { return {weight:1, color:'#475569', fillColor:'#cbd5e1', fillOpacity:0.04}; }

  async function buildMap(){
    const root = document.getElementById(ROOT_ID) || document.querySelector('.b2m-map');
    if(!root){ console.warn('[Back2Maps] Root container not found'); return; }

    map = L.map(root, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    // load datasets (optional ones won’t break)
    const [states, regions, suburbs, pcidx] = await Promise.all([
      STATES_URL  ? fetchJSON(STATES_URL)  : null,
      REGIONS_URL ? fetchJSON(REGIONS_URL): null,
      SUBURBS_URL ? fetchJSON(SUBURBS_URL): null,
      PCINDEX_URL ? fetchJSON(PCINDEX_URL): null,
    ]);

    statesFC = states && states.type ? states : null;

    // regions may be TopoJSON or GeoJSON
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
      regionLayer = L.geoJSON(regionsFC, {
        style: styleRegion,
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const id = p.id || p.code || p.name;
          const n  = window.B2M_countsDivision.get(id) || 0;
          const st = p.state || p.ST || p.st || '—';
          layer.bindPopup(`<strong>${p.name || id || '(unknown)'}</strong><br>State: ${st}<br>${n} report(s)`);
        }
      });

      // show divisions only when zoomed in
      const toggleRegions = () => {
        const on = map.getZoom() >= DIV_ZOOM;
        if (on && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      };
      map.on('zoomend', toggleRegions);
      toggleRegions();
    }

    // count CSV, then apply to UI
    await countFromCSV(CSV_URL);
    applyCountsToRegions();

    setTimeout(() => map.invalidateSize(), 100);
  }

  document.addEventListener('DOMContentLoaded', buildMap);

})();
