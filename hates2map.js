/* ===== Back2Maps — states (lighter), division borders + choropleth, CIO dots ===== */
(() => {
  "use strict";

  // ---- Settings ----------------------------------------------------------
  const AU_BOUNDS     = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 5.5;   // divisions & choropleth appear at/above this zoom
  const CHORO_ALPHA   = 0.65;  // choropleth fill opacity
  const DIV_OBJECT    = "regional_div"; // TopoJSON object name (change if yours differs)

  // ---- Styles ------------------------------------------------------------
  const stateBase  = { weight: 2, color: "#71797E", fillColor: "#f8fafc", fillOpacity: 0.25 };
  const stateHover = { weight: 3, color: "#71797E", fillColor: "#eef2ff", fillOpacity: 0.35 };

  // Division borders (no fill by default; choropleth adds fill later)
  const divHidden  = { weight: 0, color: "#71797E", opacity: 0,   fillOpacity: 0 };
  const divShown   = { weight: 2, color: "#71797E", opacity: 0.9, fillOpacity: 0 };

  // ---- Utilities ---------------------------------------------------------
  const VALID_STATES = ["NSW","ACT","VIC","QLD","SA","WA","NT","TAS"];
  const normState = s => {
    if (!s) return null;
    const v = String(s).trim().toUpperCase();
    return VALID_STATES.includes(v) ? v : null;
  };
  const validPC = pc => (/^\d{4}$/).test(String(pc ?? "").trim()) ? String(pc).padStart(4,"0") : null;
  const num = v => Number.isFinite(+v) ? +v : NaN;

  // White → red ramp
  function redRamp(val, vmax){
    if (!vmax || vmax <= 0) return "#ffffff";
    const t = Math.max(0, Math.min(1, val / vmax));
    const r = Math.round(255 - (255-179)*t); // to #b30000
    const g = Math.round(255 - (255-0  )*t);
    const b = Math.round(255 - (255-0  )*t);
    return `rgb(${r},${g},${b})`;
  }

  // ---- Boot --------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  async function init () {
    const root = document.querySelector(".back2maps");
    if (!root) return;

    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
        <div class="b2m-note" style="margin-top:10px">
          <label><strong>Upload CIO location data (CSV/XLSX):</strong>
            <input id="b2m-file" type="file" accept=".csv,.xlsx,.xls" />
          </label>
        </div>
      </div>
    `;

    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Layer order: divisions above states (for visibility), markers on top
    map.createPane("pane-states");    map.getPane("pane-states").style.zIndex = 400;
    map.createPane("pane-divisions"); map.getPane("pane-divisions").style.zIndex = 405;
    map.createPane("pane-markers");   map.getPane("pane-markers").style.zIndex  = 410;

    // ---- States (hover + popup + click) ---------------------------------
    let stateLayer;
    try {
      const states = await (await fetch(B2M.statesGeoJSON, { cache: "no-store" })).json();
      function onOver (e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function onOut  (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      function onClick(e){ map.fitBounds(e.target.getBounds(), { padding:[16,16], maxZoom: 7.5 }); }

      stateLayer = L.geoJSON(states, {
        pane: "pane-states",
        style: () => stateBase,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton:false, autoPan:false });
          l.on({ mouseover: onOver, mouseout: onOut, click: onClick });
        }
      }).addTo(map);
    } catch (e) { console.warn("[B2M] states load failed:", e); }

    // ---- Divisions (TopoJSON/GeoJSON) -----------------------------------
    const divisionsFC = await loadDivisions(B2M.divisionsGeoJSON, DIV_OBJECT);
    if (!divisionsFC) { note("Regional divisions file could not be read."); return; }

    // Borders layer (we'll reuse it for choropleth by returning style function)
    let regionCounts = Object.create(null);
    let maxCount = 0;

    const divisionsLayer = L.geoJSON(divisionsFC, {
      pane: "pane-divisions",
      filter: f => ["Polygon","MultiPolygon"].includes(f?.geometry?.type),
      style: () => divHidden,   // will be updated on zoom/data
      interactive: false,
      pointToLayer: () => null
    }).addTo(map);

    // Toggle + color divisions based on counts & zoom
    const refreshDivisions = () => {
      const show = map.getZoom() >= SHOW_DIV_ZOOM;
      divisionsLayer.setStyle(f => {
        if (!show) return divHidden;
        const key = getDivisionKey(f.properties);
        const c = regionCounts[key] || 0;
        return {
          ...divShown,
          fillOpacity: CHORO_ALPHA,
          fillColor: redRamp(c, maxCount)
        };
      });
    };
    map.on("zoomend", refreshDivisions);
    refreshDivisions();

    // ---- Suburb lookup (fallback geocoding) ------------------------------
    let suburbIndex = null;
    try { suburbIndex = await (await fetch(B2M.suburbLookup, { cache: "no-store" })).json(); }
    catch (e) { console.warn("[B2M] suburbs.json missing/unreadable:", e); }

    // ---- Dots + Choropleth from CIO upload -------------------------------
    const markers = L.layerGroup([], { pane: "pane-markers" }).addTo(map);
    const fileInput = document.getElementById("b2m-file");

    fileInput.addEventListener("change", async (ev) => {
      if (!ev.target.files?.length) return;
      const file = ev.target.files[0];
      const ext  = file.name.toLowerCase().split(".").pop();

      let rows = [];
      try {
        if (ext === "csv") rows = await parseCSV(file);
        else if (ext === "xlsx" || ext === "xls") rows = await parseXLSX(file);
        else return alert("Please upload a CSV or XLSX.");
      } catch (err) {
        console.error("Parse error:", err);
        return alert("Could not parse the file.");
      }

      // Reset layers & counts
      markers.clearLayers();
      regionCounts = Object.create(null);
      maxCount = 0;

      // Iterate rows
      for (const r of rows) {
        const resolved = await classifyRow(r, suburbIndex, divisionsFC);
        if (!resolved || resolved.status !== "ok") continue;

        // dot
        const m = L.circleMarker([resolved.lat, resolved.lon], {
          radius: 5, color: "#b30000", weight: 1, fillColor: "#b30000", fillOpacity: 0.85
        }).bindPopup(buildPopup(r, resolved));
        markers.addLayer(m);

        // region bucket
        if (resolved.regionKey) {
          regionCounts[resolved.regionKey] = (regionCounts[resolved.regionKey] || 0) + 1;
          if (regionCounts[resolved.regionKey] > maxCount) maxCount = regionCounts[resolved.regionKey];
        }
      }

      refreshDivisions();
      if (markers.getLayers().length) {
        const g = L.featureGroup(markers.getLayers());
        map.fitBounds(g.getBounds().pad(0.2));
      }
    });
  }

  // ---- Classification / Geocoding ---------------------------------------
  async function classifyRow(row, suburbIndex, divisionsFC){
    // direct coords?
    const lat0 = num(row.Latitude || row.lat || row.Lat || row.latitude);
    const lon0 = num(row.Longitude|| row.lon || row.Lon || row.longitude);
    if (Number.isFinite(lat0) && Number.isFinite(lon0)) {
      return { status:"ok", method:"coords", lat:lat0, lon:lon0, regionKey: assignRegion({lat:lat0, lon:lon0}, divisionsFC) };
    }

    const state  = normState(row["State / Territory"] || row.State || row.state);
    const pc     = validPC(row["Post Code"] || row.postcode || row.PC || row.Pcode);
    const suburb = String(row.Suburb || row.suburb || row.Town || "").trim().toUpperCase();

    const findPcSt   = (p, s) => suburbIndex?.find(x => String(x.postcode)===p && normState(x.state)===s);
    const findSubSt  = (sb,s) => suburbIndex?.find(x => String(x.suburb).toUpperCase()===sb && normState(x.state)===s);
    const findSubAny = (sb)   => suburbIndex?.find(x => String(x.suburb).toUpperCase()===sb);

    // valid postcode path
    if (pc){
      let hit = (state && findPcSt(pc, state)) || (suburb && state && findSubSt(suburb, state));
      if (!hit && suburb) hit = findSubAny(suburb);
      if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)) {
        const lat = +hit.lat, lon = +hit.lon;
        return { status:"ok", method:"pc", lat, lon, regionKey: assignRegion({lat,lon}, divisionsFC) };
      }
      return { status:"needs_geocoding", reason:"postcode_valid_but_no_match" };
    }

    // invalid postcode → try suburb
    if (suburb){
      let hit = (state && findSubSt(suburb, state)) || findSubAny(suburb);
      if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)) {
        const lat = +hit.lat, lon = +hit.lon;
        return { status:"ok", method:"suburb", lat, lon, regionKey: assignRegion({lat,lon}, divisionsFC) };
      }
      return { status:"needs_geocoding", reason:"suburb_valid_but_no_match" };
    }

    // state only / nothing usable
    if (state) return { status:"insufficient", reason:"state_only" };
    return { status:"invalid", reason:"no_location_fields" };
  }

  function assignRegion(point, divisionsFC){
    try {
      const pt = turf.point([point.lon, point.lat]);
      for (const feat of divisionsFC.features) {
        if (turf.booleanPointInPolygon(pt, feat)) {
          const p = feat.properties || {};
          return p.division_code || p.code || p.name || p.id || null;
        }
      }
    } catch(_) {}
    return null;
  }

  // ---- File parsing ------------------------------------------------------
  function parseCSV(file){
    return new Promise((resolve, reject) => {
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(file, { header:true, skipEmptyLines:true, dynamicTyping:false,
        complete: res => resolve(res.data), error: reject });
    });
  }
  async function parseXLSX(file){
    if (!window.XLSX) throw new Error("SheetJS not loaded");
    const buf = await file.arrayBuffer();
    const wb  = XLSX.read(buf, { type: "array" });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval:"" });
  }

  // ---- Data loaders ------------------------------------------------------
  async function loadDivisions(url, topoObjectName){
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();

      // GeoJSON
      if (raw?.type === "FeatureCollection" && Array.isArray(raw.features)) return raw;

      // TopoJSON
      if (raw?.type === "Topology" && window.topojson) {
        const objs = raw.objects || {};
        const key  = topoObjectName && objs[topoObjectName] ? topoObjectName : Object.keys(objs)[0];
        if (!key) return null;
        const fc = topojson.feature(raw, objs[key]);
        return (fc.type === "FeatureCollection") ? fc : { type:"FeatureCollection", features:[fc] };
      }

      // Bare arrays
      if (Array.isArray(raw))             return { type:"FeatureCollection", features: raw };
      if (Array.isArray(raw?.features))   return { type:"FeatureCollection", features: raw.features };

      console.warn("[B2M] Unexpected divisions JSON format", raw);
      return null;
    } catch (e) {
      console.error("[B2M] divisions load failed:", e);
      return null;
    }
  }

  // ---- UI helper ---------------------------------------------------------
  function buildPopup(row, p){
    const suburb = row.Suburb || row.suburb || row.Town || "";
    const state  = row["State / Territory"] || row.State || row.state || "";
    const pc     = row["Post Code"] || row.postcode || row.PC || row.Pcode || "";
    const name   = row.Name || row.Client || row.Location || "";
    return `
      <div><strong>${name || suburb || "Location"}</strong></div>
      <div>${[suburb, state, pc].filter(Boolean).join(", ")}</div>
      <div><small>Lat:</small> ${p.lat.toFixed(4)}, <small>Lon:</small> ${p.lon.toFixed(4)}</div>
    `;
  }

  function note (msg){
    const box = document.createElement("div");
    box.className = "b2m-info";
    box.style.marginTop = "8px";
    box.textContent = msg;
    document.querySelector(".b2m-card")?.appendChild(box);
  }

  function getDivisionKey(props){
    return props?.division_code || props?.code || props?.name || props?.id || "DIV";
  }
})();
