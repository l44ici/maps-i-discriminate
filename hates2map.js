/* ===== Back2Maps — divisions + upload plotting ===== */
(() => {
  "use strict";

  /* Config */
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  /* Style helpers */
  const baseRegionStyle = { weight: 1, color: "#2b2b2b", fillOpacity: 0.25 };
  const hoverStyle = { weight: 3, color: "#666", fillOpacity: 0.55 };

  /* Utilities */
  const byStr = v => (v ?? "").toString().trim();
  const normPC = s => byStr(s).replace(/\s+/g, "").padStart(4, "0");
  const normKey = (suburb, state) => `${byStr(suburb).toLowerCase()}|${byStr(state).toUpperCase()}`;

  function getFeatName(props = {}) {
    // Robust against different property names
    return props.division_name || props.region_name || props.name || props.STATE_NAME || props.ste_name || "Region";
  }
  function getFeatId(props = {}) {
    return props.division_id || props.region_id || props.id || props.code || props.abbrev || getFeatName(props);
  }
  function getFeatState(props = {}) {
    return props.state || props.STATE || props.STATE_NAME || props.ste_name || "";
  }

  /* DOM boot */
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

    /* Map */
    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Layers
    let stateLayer;          // background states (for context)
    let divisionsLayer;      // interactive regional divisions
    const markersLayer = L.layerGroup().addTo(map);

    // Load background states (optional)
    try {
      if (B2M?.statesGeoJSON) {
        const gj = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r => r.json());
        stateLayer = L.geoJSON(gj, { style: { weight: 2, color: "#4b5563", fillOpacity: 0 } }).addTo(map);
      }
    } catch (e) {
      console.warn("[B2M] statesGeoJSON load failed:", e);
    }

    // Load regional divisions (interactive)
    const divisions = await fetch(B2M.divisionsGeoJSON, { cache: "no-store" }).then(r => r.json()).catch(()=>null);
    if (!divisions?.features?.length) {
      console.error("[B2M] regional_division.geojson missing/empty:", B2M?.divisionsGeoJSON);
      return;
    }

    function highlight(e){ const l=e.target; l.setStyle(hoverStyle); if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) l.bringToFront(); }
    function reset(e){ divisionsLayer && divisionsLayer.resetStyle(e.target); }
    function onEachDivision(f, layer){
      const nm = getFeatName(f.properties);
      const st = getFeatState(f.properties);
      layer.bindPopup(`<strong>${nm}</strong>${st?`<div>${st}</div>`:''}`);
      layer.bindTooltip(nm, { sticky:true, direction:'center', opacity:0.85 });
      layer.on({ mouseover: highlight, mouseout: reset, click: () => {
        map.fitBounds(layer.getBounds(), { padding: [16,16], maxZoom: 9 });
        layer.openPopup();
      }});
    }

    divisionsLayer = L.geoJSON(divisions, {
      style: () => baseRegionStyle,
      onEachFeature: onEachDivision
    }).addTo(map);

    // Build a quick index of division features for point-in-polygon
    const divisionFeatures = divisionsLayer.toGeoJSON().features; // for Turf

    /* ---------- Lookups (suburbs/postcodes) ---------- */
    const lookup = await loadSuburbLookup(B2M.suburbLookup);

    /* ---------- File upload handling ---------- */
    const fileInput = document.getElementById("b2m-file");
    const statsEl = document.getElementById("b2m-stats");

    fileInput.addEventListener("change", async (ev) => {
      const f = ev.target.files?.[0];
      if (!f) return;
      const { rows, errors } = await readTableFile(f);
      const results = await plotClientRows(rows, { map, markersLayer, divisionFeatures, lookup });

      // Show tiny summary
      statsEl.style.display = "block";
      statsEl.innerHTML = `
        <b>${results.total}</b> rows •
        Plotted: <b>${results.plotted}</b> •
        Unresolved: <b>${results.unresolved}</b>${errors.length?` • File errors: ${errors.length}`:''}
      `;
      if (results.plotted > 0) {
        try { map.fitBounds(markersLayer.getBounds(), { padding: [20,20] }); } catch {}
      }
    });

    /* ---------- (Optional) keep hover style tidy after popup close ---------- */
    map.on('popupclose', () => { if (divisionsLayer) divisionsLayer.setStyle(() => baseRegionStyle); });

  });

  /* === helpers === */

  async function loadSuburbLookup(url){
    const idx = { pcToCentroid:new Map(), locToPCs:new Map() };
    if (!url) return idx;
    try {
      const data = await fetch(url, { cache:"no-store" }).then(r=>r.json());
      // Accept both array-of-objects or object maps
      const rows = Array.isArray(data) ? data : (data.rows || []);
      for (const r of rows) {
        const suburb = r.suburb || r.locality || r.Locality || r.SSC_NAME || r.name;
        const state  = r.state || r.State || r.STATE || r.state_abbrev || r.ste;
        const pc     = r.postcode || r.Postcode || r.POA || r.POA_CODE || r.post_code;
        const lat    = + (r.lat || r.latitude || r.Latitude || r.LAT);
        const lon    = + (r.lon || r.lng || r.longitude || r.Longitude || r.LON || r.LNG);
        const key = normKey(suburb, state);
        if (pc) {
          // if lat/lon present, keep one centroid per postcode (last wins is fine for now)
          if (Number.isFinite(lat) && Number.isFinite(lon)) idx.pcToCentroid.set(normPC(pc), [lat, lon]);
          // suburb→postcodes
          const arr = idx.locToPCs.get(key) || []; if (!arr.includes(normPC(pc))) arr.push(normPC(pc));
          idx.locToPCs.set(key, arr);
        }
      }
    } catch (e) {
      console.warn("[B2M] suburbLookup load failed:", e);
    }
    return idx;
  }

  async function readTableFile(file){
    const errors = [];
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
      return { rows, errors };
    } catch(e){
      errors.push(e.message || String(e));
      return { rows: [], errors };
    }
  }

  function resolveLatLon(row, lookup){
    // 1) If lat/lon are present, use them
    const lat = parseFloat(row.Latitude ?? row.lat ?? row.LAT);
    const lon = parseFloat(row.Longitude ?? row.lon ?? row.LON ?? row.lng);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];

    // 2) Try postcode (+ state optional)
    const pc = normPC(row["Post Code"] ?? row.Postcode ?? row.postcode ?? row.POA);
    if (pc && lookup.pcToCentroid.has(pc)) return lookup.pcToCentroid.get(pc);

    // 3) Try suburb + state
    const suburb = row.Suburb ?? row.suburb ?? row.Locality ?? row.locality;
    const state  = row["State / Territory"] ?? row.State ?? row.state ?? row.STE;
    const key = normKey(suburb, state);
    const pcs = lookup.locToPCs.get(key);
    if (pcs && pcs.length) {
      for (const pc2 of pcs) {
        const c = lookup.pcToCentroid.get(pc2);
        if (c) return c;
      }
    }
    return null; // unresolved
  }

  function assignDivision(lat, lon, divisionFeatures){
    if (!divisionFeatures?.length || !window.turf) return null;
    const pt = turf.point([lon, lat]);
    for (const f of divisionFeatures) {
      try { if (turf.booleanPointInPolygon(pt, f)) return getFeatId(f.properties); }
      catch {}
    }
    return null;
  }

  async function plotClientRows(rows, ctx){
    const { markersLayer, divisionFeatures } = ctx;
    markersLayer.clearLayers();

    let total = 0, plotted = 0, unresolved = 0;

    for (const r of rows) {
      total++;
      const coord = resolveLatLon(r, ctx.lookup);
      if (!coord) { unresolved++; continue; }

      const [lat, lon] = coord;
      const divId = assignDivision(lat, lon, divisionFeatures);
      const labelState = r["State / Territory"] ?? r.State ?? r.state ?? "";
      const labelPC    = r["Post Code"] ?? r.Postcode ?? r.postcode ?? "";
      const labelSub   = r.Suburb ?? r.suburb ?? r.Locality ?? r.locality ?? "";

      const html = `
        <b>${labelSub || "Unknown suburb"}</b>
        ${labelState ? ` (${labelState}${labelPC? " "+labelPC:""})` : ""}
        <div>Lat: ${lat.toFixed(5)}, Lon: ${lon.toFixed(5)}</div>
        ${divId ? `<div>Division: <b>${divId}</b></div>` : `<div>Division: <i>not matched</i></div>`}
      `;

      L.circleMarker([lat, lon], {
        radius: 5,
        fillColor: "#d7301f",
        color: "#fff",
        weight: 1,
        opacity: 1,
        fillOpacity: 0.85
      }).addTo(markersLayer).bindPopup(html);

      plotted++;
    }

    return { total, plotted, unresolved };
  }

})();
