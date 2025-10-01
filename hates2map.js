/* ===== Back2Maps — states, division borders, backend CIO dots + choropleth ===== */
(() => {
  "use strict";


  const AU_BOUNDS     = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 4.3;                 // earlier reveal so you can see shading
  const DIV_OBJECT    = "regional_div";      // TopoJSON object name (ignored for GeoJSON)


  // Styles
  const stateBase  = { weight: 2, color: "#71797E", fillColor: "#f8fafc", fillOpacity: 0.25 };
  const stateHover = { weight: 3, color: "#71797E", fillColor: "#eef2ff", fillOpacity: 0.35 };
  const divHidden  = { weight: 0, color: "#71797E", opacity: 0,   fillOpacity: 0 };
  const divShown   = { weight: 2, color: "#71797E", opacity: 0.9, fillOpacity: 0 };


  const VALID_STATES = ["NSW","ACT","VIC","QLD","SA","WA","NT","TAS"];
  const normState = s => { if(!s) return null; const v=String(s).trim().toUpperCase(); return VALID_STATES.includes(v)?v:null; };
  const validPC   = pc => (/^\d{4}$/).test(String(pc ?? "").trim()) ? String(pc).padStart(4,"0") : null;
  const num       = v => Number.isFinite(+v) ? +v : NaN;


  // white -> red (more reports = darker)
  const colorRamp = (v, vmax) => {
    if (!vmax || vmax <= 0) return "#ffffff";
    const t = Math.max(0, Math.min(1, v / vmax));
    const r = Math.round(255 - (255-179)*t), g = Math.round(255 - (255-0)*t), b = Math.round(255 - (255-0)*t);
    return `rgb(${r},${g},${b})`;
  };


  document.addEventListener("DOMContentLoaded", init);


  async function init () {
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


    // States
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


    // Divisions (GeoJSON or TopoJSON)
    const divisionsFC = await loadDivisions(B2M.divisionsGeoJSON, DIV_OBJECT);
    if (!divisionsFC){ console.warn("[B2M] divisions file missing/unreadable:", B2M.divisionsGeoJSON); return; }


    // Cache polygons as turf objects for fast PIP
    const divPolys = divisionsFC.features.map(f => ({
      key: getDivKey(f.properties),
      f,
      g: turf.multiPolygon(f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates)
    }));


    let counts = Object.create(null), maxCount = 0;
    const divisionsLayer = L.geoJSON(divisionsFC, {
      pane:"pane-divisions",
      filter:f=>["Polygon","MultiPolygon"].includes(f?.geometry?.type),
      style:()=>divHidden, interactive:false
    }).addTo(map);


    const refreshDivisions = () => {
      const show = map.getZoom() >= SHOW_DIV_ZOOM;
      divisionsLayer.setStyle(f=>{
        if(!show) return divHidden;
        const key = getDivKey(f.properties);
        const c = counts[key]||0;
        return { ...divShown, fillOpacity: 0.65, fillColor: colorRamp(c, maxCount) };
      });
    };
    map.on("zoomend", refreshDivisions);
    refreshDivisions();


    // Optional suburb lookup (postcode/suburb → lat/lon)
    let suburbIndex = null;
    try {
      if (B2M.suburbLookup) {
        suburbIndex = await (await fetch(B2M.suburbLookup, { cache:"no-store" })).json();
        console.log("[B2M] Suburb index loaded:", suburbIndex?.length ?? 0);
      }
    } catch(e){ console.warn("[B2M] suburbs.json missing/unreadable:", e); }


    // CIO data from backend only
    const markers = L.layerGroup([], { pane:"pane-markers" }).addTo(map);


    if (!B2M.cioData){
      console.warn("[B2M] No CIO data URL localized (B2M.cioData).");
      return;
    }
    console.log("[B2M] Loading CIO data:", B2M.cioData);


    try {
      const ext = B2M.cioData.toLowerCase().split(".").pop();
      let rows = [];
      if (ext === "csv") {
        rows = await parseCSVWithPapa(B2M.cioData);
      } else if (ext === "xlsx" || ext === "xls") {
        const ab = await (await fetch(B2M.cioData, { cache:"no-store" })).arrayBuffer();
        const wb = XLSX.read(ab, { type:"array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval:"" });
      } else {
        console.warn("[B2M] Unsupported CIO file type:", ext);
        return;
      }


      console.log("[B2M] CIO rows loaded:", rows.length);


      markers.clearLayers(); counts = Object.create(null); maxCount = 0;


      // NORMALIZE COLUMN NAMES ONCE
      const get = (r, keys) => {
        for (const k of keys) { if (r[k] != null && String(r[k]).trim() !== "") return r[k]; }
        return "";
      };


      let placed = 0, classified = 0;
      for (const r of rows) {
        // normalize
        const latStr = get(r, ["Latitude","lat","Lat","latitude"]);
        const lonStr = get(r, ["Longitude","lon","Lon","longitude"]);
        const lat0   = num(latStr);
        const lon0   = num(lonStr);


        let result;
        if (Number.isFinite(lat0) && Number.isFinite(lon0)) {
          result = { status:"ok", lat:lat0, lon:lon0, regionKey: regionFor({lat:lat0,lon:lon0}, divPolys) };
        } else {
          const state  = normState(get(r, ["State / Territory","State","state"]));
          const pc     = validPC(get(r, ["Post Code","postcode","PC","Pcode"]));
          const suburb = String(get(r, ["Suburb","suburb","Town"])).trim().toUpperCase();


          const findPcSt   = (p,s)=> suburbIndex?.find(x=>String(x.postcode)===p && normState(x.state)===s);
          const findSubSt  = (sb,s)=> suburbIndex?.find(x=>String(x.suburb).toUpperCase()===sb && normState(x.state)===s);
          const findSubAny = (sb)  => suburbIndex?.find(x=>String(x.suburb).toUpperCase()===sb);


          if (pc) {
            let hit = (state && findPcSt(pc, state)) || (suburb && state && findSubSt(suburb,state));
            if (!hit && suburb) hit = findSubAny(suburb);
            if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)) {
              result = { status:"ok", lat:+hit.lat, lon:+hit.lon, regionKey: regionFor({lat:+hit.lat,lon:+hit.lon}, divPolys) };
            }
          }
          if (!result && suburb) {
            let hit = (state && findSubSt(suburb,state)) || findSubAny(suburb);
            if (hit && Number.isFinite(+hit.lat) && Number.isFinite(+hit.lon)) {
              result = { status:"ok", lat:+hit.lat, lon:+hit.lon, regionKey: regionFor({lat:+hit.lat,lon:+hit.lon}, divPolys) };
            }
          }
        }


        if (!result || result.status !== "ok") continue;


        // Dot marker (comment out if you only want choropleth)
        L.circleMarker([result.lat,result.lon], {
          radius:5, color:"#b30000", weight:1, fillColor:"#b30000", fillOpacity:.85
        }).bindPopup(buildPopup(r,result)).addTo(markers);
        placed++;


        if (result.regionKey){
          counts[result.regionKey] = (counts[result.regionKey]||0) + 1;
          if (counts[result.regionKey] > maxCount) maxCount = counts[result.regionKey];
          classified++;
        }
      }


      console.log("[B2M] Plotted:", placed, "Classified:", classified, "Divisions with data:", Object.keys(counts).length, "Max:", maxCount);


      refreshDivisions();
      if (markers.getLayers().length){
        const g = L.featureGroup(markers.getLayers());
        map.fitBounds(g.getBounds().pad(0.2));
      }
    } catch(e){
      console.error("[B2M] CIO data load failed:", e);
    }
  }


  function buildPopup(r,res){
    const suburb = r.Suburb || r.suburb || r.Town || "";
    const state  = r["State / Territory"] || r.State || r.state || "";
    const pc     = r["Post Code"] || r.postcode || r.PC || r.Pcode || "";
    return `<div class="b2m-info"><strong>${suburb||"Location"}</strong><br>${[state,pc].filter(Boolean).join(" ")}</div>`;
  }


  function regionFor(pt, divPolys){
    try {
      const point = turf.point([pt.lon, pt.lat]);
      for (const {key, g} of divPolys){
        if (turf.booleanPointInPolygon(point, g)) return key;
      }
    } catch (e) { /* ignore */ }
    return null;
  }


  function getDivKey(props){
    return props?.division_code || props?.region_id || props?.REGION_ID || props?.code || props?.name || props?.id || null;
  }


  async function loadDivisions(url, topoObjectName){
    try {
      const res = await fetch(url, { cache:"no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();


      if (raw?.type === "FeatureCollection") return raw;


      if (raw?.type === "Topology" && window.topojson){
        const objs = raw.objects || {};
        const key  = topoObjectName && objs[topoObjectName] ? topoObjectName : Object.keys(objs)[0];
        if (!key) return null;
        const fc = topojson.feature(raw, objs[key]);
        return (fc.type === "FeatureCollection") ? fc : { type:"FeatureCollection", features:[fc] };
      }
      return null;
    } catch (e) {
      console.error("[B2M] divisions load failed:", e);
      return null;
    }
  }


  // Robust CSV parsing (PapaParse)
  function parseCSVWithPapa(url){
    return new Promise((resolve, reject)=>{
      if (!window.Papa) return reject(new Error("PapaParse not loaded"));
      Papa.parse(url, {
        download: true,
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        complete: res => resolve(res.data || []),
        error: err => reject(err)
      });
    });
  }
})();