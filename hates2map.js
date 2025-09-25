/* ===== Back2Maps — states (lighter), division borders + choropleth, CIO dots ===== */
(() => {
  "use strict";

  const AU_BOUNDS     = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 5.5;          // show divisions/choropleth from this zoom
  const CHORO_ALPHA   = 0.65;         // choropleth fill opacity
  const DIV_OBJECT    = "regional_div"; // TopoJSON object name (change if needed)

  // --- Styles ---
  const stateBase  = { weight: 2, color: "#71797E", fillColor: "#f8fafc", fillOpacity: 0.25 };
  const stateHover = { weight: 3, color: "#71797E", fillColor: "#eef2ff", fillOpacity: 0.35 };
  const divHidden  = { weight: 0, color: "#71797E", opacity: 0,   fillOpacity: 0 };
  const divShown   = { weight: 2, color: "#71797E", opacity: 0.9, fillOpacity: 0 };

  const VALID_STATES = ["NSW","ACT","VIC","QLD","SA","WA","NT","TAS"];
  const normState = s => { if(!s) return null; const v=String(s).trim().toUpperCase(); return VALID_STATES.includes(v)?v:null; };
  const validPC = pc => (/^\d{4}$/).test(String(pc ?? "").trim()) ? String(pc).padStart(4,"0") : null;
  const num = v => Number.isFinite(+v) ? +v : NaN;

  const ramp = (v, vmax) => {
    if (!vmax || vmax<=0) return "#ffffff";
    const t = Math.max(0, Math.min(1, v/vmax));
    const r = Math.round(255 - (255-179)*t), g = Math.round(255 - (255-0)*t), b = Math.round(255 - (255-0)*t);
    return `rgb(${r},${g},${b})`;
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init(){
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

    map.createPane("pane-states");    map.getPane("pane-states").style.zIndex = 400;
    map.createPane("pane-divisions"); map.getPane("pane-divisions").style.zIndex = 405;
    map.createPane("pane-markers");   map.getPane("pane-markers").style.zIndex  = 410;

    // --- States ---
    let stateLayer;
    try {
      const states = await (await fetch(B2M.statesGeoJSON, { cache: "no-store" })).json();
      function over(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function out (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      function click(e){ map.fitBounds(e.target.getBounds(), { padding:[16,16], maxZoom: 7.5 }); }
      stateLayer = L.geoJSON(states, {
        pane:"pane-states", style:()=>stateBase,
        onEachFeature:(f,l)=>{
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton:false, autoPan:false });
          l.on({ mouseover:over, mouseout:out, click });
        }
      }).addTo(map);
    } catch(e){ console.warn("[B2M] states load failed:", e); }

    // --- Divisions ---
    const divisionsFC = await loadDivisions(B2M.divisionsGeoJSON, DIV_OBJECT);
    if (!divisionsFC){ note("Regional divisions file could not be read."); return; }

    let counts = Object.create(null), maxCount = 0;
    const divisionsLayer = L.geoJSON(divisionsFC, {
      pane:"pane-divisions",
      filter:f=>["Polygon","MultiPolygon"].includes(f?.geometry?.type),
      style:()=>divHidden, interactive:false, pointToLayer:()=>null
    }).addTo(map);

    const refreshDivisions = () => {
      const show = map.getZoom() >= SHOW_DIV_ZOOM;
      divisionsLayer.setStyle(f=>{
        if(!show) return divHidden;
        const key = getDivKey(f.properties);
        const c = counts[key]||0;
        return { ...divShown, fillOpacity: CHORO_ALPHA, fillColor: ramp(c, maxCount) };
      });
    };
    map.on("zoomend", refreshDivisions);
    refreshDivisions();

    // --- Suburb lookup (geocoding fallback) ---
    let suburbIndex = null;
    try { suburbIndex = await (await fetch(B2M.suburbLookup, { cache:"no-store" })).json(); }
    catch(e){ console.warn("[B2M] suburbs.json missing/unreadable:", e); }

    // --- Dots + choropleth (auto from bundled file + manual upload) ---
    const markers = L.layerGroup([], { pane:"pane-markers" }).addTo(map);
    const processRows = async (rows) => {
      markers.clearLayers(); counts = Object.create(null); maxCount = 0;

      for (const r of rows) {
        const res = await classifyRow(r, suburbIndex, divisionsFC);
        if (!res || res.status!=="ok") continue;

        L.circleMarker([res.lat,res.lon], {
          radius:5, color:"#b30000", weight:1, fillColor:"#b30000", fillOpacity:.85
        }).bindPopup(buildPopup(r,res)).addTo(markers);

        if (res.regionKey){
          counts[res.regionKey] = (counts[res.regionKey]||0) + 1;
          if (counts[res.regionKey] > maxCount) maxCount = counts[res.regionKey];
        }
      }
      refreshDivisions();
      if (markers.getLayers().length){
        const g = L.featureGroup(markers.getLayers());
        map.fitBounds(g.getBounds().pad(0.2));
      }
    };

    // 1) Auto load your bundled CIO file (if provided)
    if (B2M.cioData){
      try {
        const ext = B2M.cioData.toLowerCase().split(".").pop();
        if (ext==="csv") {
          const rows = await parseCSV(B2M.cioData, /*remote*/true);
          processRows(rows);
        } else if (ext==="xlsx" || ext==="xls") {
          // fetch and parse XLSX from URL
          const ab = await (await fetch(B2M.cioData, { cache:"no-store" })).arrayBuffer();
          const wb = XLSX.read(ab, { type:"array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
          processRows(rows);
        }
      } catch(e){ console.warn("[B2M] auto CIO load failed:", e); }
    }

    // 2) Manual upload (optional override)
    document.getElementById("b2m-file").addEventListener("change", async (ev)=>{
      if (!ev.target.files?.length) return;
      const f   = ev.target.files[0];
      const ext = f.name.toLowerCase().split(".").pop();
      try {
        if (ext==="csv") {
          const rows = await parseCSV(f, false);
          processRows(rows);
        } else if (ext==="xlsx" || ext==="xls") {
          const buf = await f.arrayBuffer();
          const wb = XLSX.read(buf, { type:"array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
          processRows(rows);
        } else {
          alert("Please upload a CSV or XLSX file.");
        }
      } catch(err){ console.error("Upload parse error:", err); alert("Could not parse the file."); }
    });
  }

  // ---- Classification / region assignment ----
  async function classifyRow(row, index, divisionsFC){
    const lat0 = num(row.Latitude || row.lat || row.Lat || row.latitude);
    const lon0 = num(row.Longitude|| row.lon || row.Lon || row.longitude);
    if (Number.isFinite(lat0) && Number.isFinite(lon0))
      return { status:"ok", method:"coords", lat:lat0, lon:lon0, regionKey: regionFor({lat:lat0,lon:lon0}, divisionsFC) };

    const state  = normState(row["State / Territory"] || row.State || row.state);
    const pc     = validPC(row["Post Code"] || row.postcode || row.PC || row.Pcode);
    const suburb = String(row.Suburb || row.suburb || row.Town || "").trim().toUpperCase();

    const findPcSt   = (p,s)=> index?.find(x=>String(x.postcode)===p && normState(x.state)===s);
    const findSubSt  = (sb,s)=> index?.find(x=>String(x.suburb).toUpperCase()===sb && normState(x.state)===s);
    const findSubAny = (sb)  => index?.find(x=>String(x.suburb).toUpperCase()===sb);

    if (pc){
      let hit = (state && findPcSt(pc, state)) || (suburb && state && findSubSt(suburb,state));
      if (!hit && suburb) hit = findSubAny(suburb);
      if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)){
        const lat=+hit.lat, lon=+hit.lon;
        return { status:"ok", method:"pc", lat, lon, regionKey: regionFor({lat,lon}, divisionsFC) };
      }
      return { status:"needs_geocoding", reason:"postcode_valid_but_no_match" };
    }

    if (suburb){
      let hit = (state && findSubSt(suburb,state)) || findSubAny(suburb);
      if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)){
        const lat=+hit.lat, lon=+hit.lon;
        return { status:"ok", method:"suburb", lat, lon, regionKey: regionFor({lat,lon}, divisionsFC) };
      }
      return { status:"needs_geocoding", reason:"suburb_valid_but_no_match" };
    }

    if (state) return { status:"insufficient", reason:"state_only" };
    return { status:"invalid", reason:"no_location_fields" };
  }

  function regionFor(point, divisionsFC){
    try{
      const pt = turf.point([point.lon, point.lat]);
      for (const feat of divisionsFC.features){
        if (turf.booleanPointInPolygon(pt, feat)){
          const p = feat.properties || {};
          return p.division_code || p.code || p.name || p.id || null;
        }
      }
    }catch(_){}
    return null;
  }

  // ---- Parsers ----
  function parseCSV(src, isUrl){
    return new Promise((resolve,reject)=>{
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      const opts = { header:true, skipEmptyLines:true, dynamicTyping:false,
        complete: res => resolve(res.data), error: reject };
      if (isUrl) { opts.download = true; opts.worker = false; }
      Papa.parse(src, opts);
    });
  }

  // ---- Loaders ----
  async function loadDivisions(url, topoObjectName){
    try {
      const res = await fetch(url, { cache:"no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();

      if (raw?.type==="FeatureCollection" && Array.isArray(raw.features)) return raw;

      if (raw?.type==="Topology" && window.topojson){
        const objs = raw.objects || {};
        const key  = topoObjectName && objs[topoObjectName] ? topoObjectName : Object.keys(objs)[0];
        if (!key) return null;
        const fc = topojson.feature(raw, objs[key]);
        return (fc.type==="FeatureCollection") ? fc : { type:"FeatureCollection", features:[fc] };
      }

      if (Array.isArray(raw))           return { type:"FeatureCollection", features: raw };
      if (Array.isArray(raw?.features)) return { type:"FeatureCollection", features: raw.features };

      console.warn("[B2M] Unexpected divisions JSON format", raw);
      return null;
    } catch(e){
      console.error("[B2M] divisions load failed:", e);
      return null;
    }
  }

  // ---- UI helpers ----
  function getDivKey(props){ return props?.division_code || props?.code || props?.name || props?.id || "DIV"; }

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

  function note(msg){
    const box = document.createElement("div");
    box.className = "b2m-info"; box.style.marginTop = "8px";
    box.textContent = msg;
    document.querySelector(".b2m-card")?.appendChild(box);
  }
})();
