/* ===== Back2Maps — divisions choropleth + hover ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // Color scale for counts (choropleth)
  const getColor = d =>
    d > 200 ? "#084081" :
    d > 100 ? "#0868ac" :
    d >  50 ? "#2b8cbe" :
    d >  20 ? "#4eb3d3" :
    d >  10 ? "#7bccc4" :
    d >   0 ? "#a8ddb5" : "#f7fcfd";

  // Base styles
  const stateStyle    = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const divisionBase  = { weight: 1, color: "#2b2b2b", fillOpacity: 0.45 };
  const divisionHover = { weight: 3, color: "#666",    fillOpacity: 0.65 };
  const stateHover    = { weight: 3, color: "#111827", fillOpacity: 0.10 };

  // Property helpers (tolerant)
  const getDivisionCode = p => p?.division_code || p?.division || p?.code || p?.name || p?.DIVISION || p?.REGION || p?.id;
  const getDivisionName = p => p?.division_name || getDivisionCode(p) || "Region";
  const getStateName    = p => p?.state || p?.STATE || p?.STATE_NAME || p?.ste_name || "";

  // Simple normalizers for lookup resolving
  const byStr = v => (v ?? "").toString().trim();
  const normPC = s => byStr(s).replace(/\s+/g,"").padStart(4,"0");
  const normKey = (sub, st) => `${byStr(sub).toLowerCase()}|${byStr(st).toUpperCase()}`;

  document.addEventListener("DOMContentLoaded", async () => {
    const root = document.querySelector(".back2maps");
    if (!root) return;

    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
        <div class="b2m-controls" style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <label class="b2m-info">Upload client locations (CSV/XLSX):
            <input id="b2m-file" type="file" accept=".csv,.xlsx,.xls" style="display:block; margin-top:6px;">
          </label>
          <div id="b2m-stats" class="b2m-info" style="display:none;"></div>
        </div>
      </div>
    `;

    // Map
    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Panes for stacking
    map.createPane('pane-states');    map.getPane('pane-states').style.zIndex = 400;
    map.createPane('pane-divisions'); map.getPane('pane-divisions').style.zIndex = 405;

    let stateLayer, divisionsLayer;

    // STATES (background) with hover + popup-on-hover
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r=>r.json());
      function stateOver(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function stateOut (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      stateLayer = L.geoJSON(states, {
        pane: 'pane-states',
        style: () => stateStyle,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton: false, autoPan: false });
          l.on({ mouseover: stateOver, mouseout: stateOut });
        }
      }).addTo(map);
    } catch(e){ console.warn("States load failed", e); }

    // DIVISIONS (NSW1/NSW2/etc.) with hover + popup + click zoom
    const divisions = await fetch(B2M.divisionsGeoJSON, { cache: "no-store" }).then(r=>r.json()).catch(()=>null);
    if (!divisions?.features?.length) {
      console.error("[B2M] regional divisions missing/empty:", B2M?.divisionsGeoJSON);
      return;
    }

    // Counts + indexes
    const divisionCounts = new Map();             // code -> number
    const layerByCode    = new Map();             // code -> leaflet layer

    function styleDivisionByCount(p) {
      const code = String(getDivisionCode(p) || "");
      const n = divisionCounts.get(code) || 0;
      return { ...divisionBase, fillColor: getColor(n) };
    }

    function onEachDivision(f, l){
      const code = String(getDivisionCode(f.properties) || "");
      const name = getDivisionName(f.properties);   // will be NSW1/NSW2 if present
      const state= getStateName(f.properties);
      divisionCounts.set(code, divisionCounts.get(code) || 0);
      layerByCode.set(code, l);

      const html = () => `<strong>${name}</strong>${state?`<div>${state}</div>`:''}
                          <div>Locations: <b>${divisionCounts.get(code) || 0}</b></div>`;

      l.bindPopup(html, { closeButton:false, autoPan:false });
      l.bindTooltip(name, { sticky:true, direction:'center', opacity:0.85 });

      l.on({
        mouseover: e => { e.target.setStyle(divisionHover); e.target.openPopup(); L.DomEvent.stopPropagation(e); },
        mouseout : e => { divisionsLayer.resetStyle(e.target); e.target.closePopup(); L.DomEvent.stopPropagation(e); },
        click    : () => { map.fitBounds(l.getBounds(), { padding:[16,16], maxZoom: 9 }); l.openPopup(); }
      });
    }

    divisionsLayer = L.geoJSON(divisions, {
      pane: 'pane-divisions',
      style: f => styleDivisionByCount(f.properties),
      onEachFeature: onEachDivision
    }).addTo(map);

    // For Turf PIP
    const divisionFeatures = divisionsLayer.toGeoJSON().features;

    // Legend
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'b2m-info');
      const grades = [0, 10, 20, 50, 100, 200];
      let html = '<b>Locations</b><br>';
      for (let i = 0; i < grades.length; i++) {
        const from = grades[i], to = grades[i + 1];
        html += `<i style="background:${getColor(from + 0.01)};display:inline-block;width:12px;height:12px;margin-right:6px;border-radius:2px;"></i> ${from}${to ? '&ndash;' + to : '+'}<br>`;
      }
      div.innerHTML = html; return div;
    };
    legend.addTo(map);

    // Lookup data (postcode/suburb centroids)
    const lookup = await loadSuburbLookup(B2M.suburbLookup);

    // Upload handler: aggregate to polygons (no pins)
    const fileInput = document.getElementById("b2m-file");
    const statsEl = document.getElementById("b2m-stats");

    fileInput.addEventListener("change", async (ev) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      const { rows, errors } = await readTableFile(f);
      const res = await aggregateIntoDivisions(rows, { divisionCounts, divisionFeatures, lookup });

      // Repaint polygons
      divisionsLayer.setStyle(g => styleDivisionByCount(g.properties));
      // Refresh any open popup
      divisionsLayer.eachLayer(l => { if (l.isPopupOpen()) { l.closePopup(); l.openPopup(); } });

      statsEl.style.display = "block";
      statsEl.innerHTML = `
        <b>${res.total}</b> rows • Aggregated: <b>${res.assigned}</b> • Unresolved: <b>${res.unresolved}</b>${errors.length?` • File errors: ${errors.length}`:''}
      `;
    });

    map.on('popupclose', () => {
      if (divisionsLayer) divisionsLayer.setStyle(f => styleDivisionByCount(f.properties));
      if (stateLayer)     stateLayer.setStyle(() => stateStyle);
    });
  });

  /* -------- helpers -------- */

  async function loadSuburbLookup(url){
    const idx = { pcToCentroid:new Map(), locToPCs:new Map() };
    if (!url) return idx;
    try {
      const data = await fetch(url, { cache:"no-store" }).then(r=>r.json());
      const rows = Array.isArray(data) ? data : (data.rows || []);
      for (const r of rows) {
        const suburb = r.suburb || r.locality || r.Locality || r.SSC_NAME || r.name;
        const state  = r.state  || r.State  || r.STATE  || r.state_abbrev || r.ste;
        const pc     = r.postcode || r.Postcode || r.POA || r.POA_CODE || r.post_code;
        const lat    = + (r.lat || r.latitude || r.Latitude || r.LAT);
        const lon    = + (r.lon || r.lng || r.longitude || r.Longitude || r.LON || r.LNG);
        const key = normKey(suburb, state);
        if (pc) {
          if (Number.isFinite(lat) && Number.isFinite(lon)) idx.pcToCentroid.set(normPC(pc), [lat, lon]);
          const arr = idx.locToPCs.get(key) || []; if (!arr.includes(normPC(pc))) arr.push(normPC(pc));
          idx.locToPCs.set(key, arr);
        }
      }
    } catch (e) { console.warn("[B2M] suburbLookup load failed:", e); }
    return idx;
  }

  async function readTableFile(file){
    const errors = [];
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const rows= XLSX.utils.sheet_to_json(ws, { defval:"" });
      return { rows, errors };
    } catch(e){ errors.push(e.message || String(e)); return { rows: [], errors }; }
  }

  function resolveLatLon(row, lookup){
    // Priority: Lat/Lon -> Postcode -> Suburb+State
    const lat = parseFloat(row.Latitude ?? row.lat ?? row.LAT);
    const lon = parseFloat(row.Longitude ?? row.lon ?? row.LON ?? row.lng);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];

    const pc = normPC(row["Post Code"] ?? row.Postcode ?? row.postcode ?? row.POA);
    if (pc && lookup.pcToCentroid.has(pc)) return lookup.pcToCentroid.get(pc);

    const suburb = row.Suburb ?? row.suburb ?? row.Locality ?? row.locality;
    const state  = row["State / Territory"] ?? row.State ?? row.state ?? row.STE;
    const pcs = lookup.locToPCs.get(normKey(suburb, state));
    if (pcs && pcs.length) {
      for (const pc2 of pcs) {
        const c = lookup.pcToCentroid.get(pc2);
        if (c) return c;
      }
    }
    return null;
  }

  function assignDivision(lat, lon, divisionFeatures){
    if (!divisionFeatures?.length || !window.turf) return null;
    const pt = turf.point([lon, lat]);
    for (const f of divisionFeatures) {
      try { if (turf.booleanPointInPolygon(pt, f)) {
        const code = getDivisionCode(f.properties);
        return code ? String(code) : null;
      }} catch {}
    }
    return null;
  }

  async function aggregateIntoDivisions(rows, ctx){
    const { divisionCounts, divisionFeatures, lookup } = ctx;
    // reset
    for (const k of divisionCounts.keys()) divisionCounts.set(k, 0);

    let total = 0, assigned = 0, unresolved = 0;
    for (const r of rows) {
      total++;
      const c = resolveLatLon(r, lookup);
      if (!c) { unresolved++; continue; }
      const [lat, lon] = c;
      const code = assignDivision(lat, lon, divisionFeatures);
      if (code) { divisionCounts.set(code, (divisionCounts.get(code) || 0) + 1); assigned++; }
      else { unresolved++; }
    }
    return { total, assigned, unresolved };
  }

})();
