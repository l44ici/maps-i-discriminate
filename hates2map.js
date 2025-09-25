/* ===== Back2Maps — states, division borders, CIO dots + choropleth ===== */
(() => {
  "use strict";

  const AU_BOUNDS     = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 5.5;
  const DIV_OBJECT    = "regional_div"; // name inside TopoJSON
  const VALID_STATES  = ["NSW","ACT","VIC","QLD","SA","WA","NT","TAS"];

  // Styles
  const stateBase  = { weight: 2, color: "#71797E", fillColor: "#f8fafc", fillOpacity: 0.25 };
  const stateHover = { weight: 3, color: "#71797E", fillColor: "#eef2ff", fillOpacity: 0.35 };
  const divHidden  = { weight: 0, color: "#71797E", opacity: 0, fillOpacity: 0 };
  const divShown   = { weight: 2, color: "#71797E", opacity: 0.9, fillOpacity: 0 };

  // Helpers
  const normState = s => { if(!s) return null; const v=String(s).trim().toUpperCase(); return VALID_STATES.includes(v)?v:null; };
  const validPC   = pc => (/^\d{4}$/).test(String(pc ?? "").trim()) ? String(pc).padStart(4,"0") : null;
  const num       = v => Number.isFinite(+v) ? +v : NaN;

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

    // ----- States
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

    // ----- Divisions
    const divisionsFC = await loadDivisions(B2M.divisionsGeoJSON, DIV_OBJECT);
    if (!divisionsFC){ console.warn("Divisions file missing"); return; }

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
        return { ...divShown, fillOpacity: 0.65, fillColor: ramp(c, maxCount) };
      });
    };
    map.on("zoomend", refreshDivisions);
    refreshDivisions();

    // ----- Suburb lookup
    let suburbIndex = null;
    try { suburbIndex = await (await fetch(B2M.suburbLookup, { cache:"no-store" })).json(); }
    catch(e){ console.warn("[B2M] suburbs.json missing/unreadable:", e); }

    // ----- CIO Data
    const markers = L.layerGroup([], { pane:"pane-markers" }).addTo(map);

    if (B2M.cioData){
      try {
        const ext = B2M.cioData.toLowerCase().split(".").pop();
        let rows = [];
        if (ext==="csv") {
          rows = await parseCSV(B2M.cioData, true);
        } else if (ext==="xlsx" || ext==="xls") {
          const ab = await (await fetch(B2M.cioData, { cache:"no-store" })).arrayBuffer();
          const wb = XLSX.read(ab, { type:"array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
        }

        markers.clearLayers(); counts = Object.create(null); maxCount = 0;

        for (const r of rows) {
          const res = await classifyRow(r, suburbIndex, divisionsFC);
          if (!res || res.status!=="ok") continue;

          // Dot marker (remove if you only want choropleth)
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
      } catch(e){ console.error("[B2M] CIO data load failed:", e); }
    }
  }

  // ----- Classification / region assignment
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
        return { status:"ok", method:"lookup", lat:+hit.lat, lon:+hit.lon, regionKey: regionFor(hit, divisionsFC) };
      }
    }

    if (suburb){
      let hit = (state && findSubSt(suburb,state)) || findSubAny(suburb);
      if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)){
        return { status:"ok", method:"lookup", lat:+hit.lat, lon:+hit.lon, regionKey: regionFor(hit, divisionsFC) };
      }
    }

    return { status:"skip" };
  }

  // ----- Popup HTML
  function buildPopup(r,res){
    const pc = r["Post Code"]||r.postcode||"";
    const sb = r.Suburb||r.suburb||"";
    const st = r["State / Territory"]||r.State||"";
    return `
      <div class="b2m-info">
        <div><strong>${sb||"Suburb"} ${pc||""}</strong></div>
        <div>${st||""}</div>
      </div>`;
  }

  // ----- Region assignment (point-in-polygon)
  function regionFor(pt, fc){
    if (!fc?.features) return null;
    for (const f of fc.features){
      if (leafletPip.pointInLayer([pt.lon, pt.lat], L.geoJSON(f)).length){
        return getDivKey(f.properties);
      }
    }
    return null;
  }

  function getDivKey(props){ return props?.region_id || props?.REGION_ID || props?.name || JSON.stringify(props); }

  // ----- Load divisions
  async function loadDivisions(url, topoObjectName){
    try {
      const raw = await (await fetch(url, { cache: "no-store" })).json();
      if (raw?.type==="FeatureCollection") return raw;
      if (raw?.type==="Topology" && window.topojson){
        const objs = raw.objects||{};
        const key  = topoObjectName && objs[topoObjectName] ? topoObjectName : Object.keys(objs)[0];
        if (!key) return null;
        const fc = topojson.feature(raw, objs[key]);
        return (fc.type==="FeatureCollection") ? fc : { type:"FeatureCollection", features:[fc] };
      }
      return null;
    } catch(e){ console.error("[B2M] divisions load failed:", e); return null; }
  }

  // ----- CSV parser (minimal)
  async function parseCSV(url, header=true){
    const txt = await (await fetch(url, { cache:"no-store" })).text();
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const keys = header ? lines.shift().split(",") : [];
    return lines.map(l=>{
      const parts = l.split(",");
      if (header){ const obj={}; keys.forEach((k,i)=> obj[k]=parts[i]||""); return obj; }
      return parts;
    });
  }
})();
