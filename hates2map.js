/* ===== Back2Maps — one bubble per CSV row + regional choropleth (bubbles on top) ===== */
(() => {
  "use strict";

  // Theme safety: neutralize missing jQuery UI progressbar
  (function () {
    if (window.jQuery && !jQuery.fn.progressbar) {
      jQuery.fn.progressbar = function () { return this; };
    }
  })();

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID  = "b2m-map";
  const WRAP     = document.querySelector(".back2maps");
  const DIV_ZOOM = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  const STATES_URL  = CFG.statesUrl;
  const REGIONS_URL = CFG.divisionsUrl;
  const CSV_URL     = CFG.cioDataCsv;
  const SUBURBS_URL = CFG.suburbLookup;

  const LOG = (...a) => console.log("[B2M]", ...a);
  const AU_BOUNDS = [[-44,112],[-10,154]];

  const fetchJSON = (u) => fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  const fetchText = (u) => fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.text():"").catch(()=>"")

  // ── helpers
  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState    = s => { const x=(s??"").toString().trim().toUpperCase(); return STS.has(x)?x:""; };
  const asPostcode = s => { const x=(s??"").toString().replace(/\s+/g,""); return /^\d{4}$/.test(x)?x:""; };
  const clean      = s => (s??"").toString().toLowerCase().replace(/[^a-z0-9]/g,"");

  function parseCSVSafe(txt){
    if (!txt || typeof txt!=="string") return [];
    const lines = txt.split(/\r?\n/).filter(l=>l.trim().length);
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h=>h.trim());
    const out=[];
    for (const line of lines){
      const cells=line.split(",");
      const o={};
      for (let i=0;i<header.length;i++) o[header[i]]=(cells[i]??"").trim();
      out.push(o);
    }
    return out;
  }

  // styles
  const styleStates = { color:"#fff", weight:1, fillColor:"#f4ebdf", fillOpacity:1 };
  const styleRegionsInitial = { color:"#fff", weight:0.8, fillOpacity:0.20, fillColor:"#FDE68A" }; // faint tint before counts
  const pointStyle = { radius:4, fillColor:"#d93b2b", color:"#a11e14", weight:0.5, fillOpacity:0.75, opacity:0.35 };

  // suburbs index (lat/lng)
  function buildSuburbIndexes(suburbs){
    const byPC=Object.create(null), bySubState=Object.create(null);
    if (!Array.isArray(suburbs)) return {byPC,bySubState};
    for (const r of suburbs){
      const pc  = asPostcode(String(r.postcode ?? ""));
      const st  = asState(r.state);
      const sub = clean(r.suburb);
      const lat = +r.lat, lon = +r.lng; // ✅ your file uses lat/lng
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (pc && !byPC[pc]) byPC[pc]=[lat,lon];
      if (st && sub && !bySubState[`${st}|${sub}`]) bySubState[`${st}|${sub}`]=[lat,lon];
    }
    LOG("Suburb index sizes:", Object.keys(byPC).length, Object.keys(bySubState).length);
    return {byPC,bySubState};
  }
  function rowToLatLon(row, keys, idx){
    const pc = asPostcode(row[keys.pc]);
    if (pc && idx.byPC[pc]) return idx.byPC[pc];
    const st = asState(row[keys.state]);
    const sb = clean(row[keys.suburb]);
    if (st && sb && idx.bySubState[`${st}|${sb}`]) return idx.bySubState[`${st}|${sb}`];
    return null;
  }

  // Geo helpers
  function pointInPolygon(pt, geom){
    const [x,y]=pt;
    const test=(poly)=>{
      let inside=false;
      for (const ring of poly){
        for (let i=0,j=ring.length-1;i<ring.length;j=i++){
          const [xi,yi]=ring[i],[xj,yj]=ring[j];
          const inter=(yi>y)!==(yj>y) && x < (xj-xi)*(y-yi)/((yj-yi)||1e-12)+xi;
          if (inter) inside=!inside;
        }
      }
      return inside;
    };
    if (!geom) return false;
    if (geom.type==="Polygon") return test(geom.coordinates);
    if (geom.type==="MultiPolygon") return geom.coordinates.some(test);
    return false;
  }
  function ensureRegionIds(regionsFC){
    if (!regionsFC?.features) return;
    let i=0;
    for (const f of regionsFC.features){
      if (!f.properties) f.properties = {};
      const p=f.properties;
      p._b2m_id = p._b2m_id || p.SA4_NAME || p.SA3_NAME || p.REGION_NAME || p.RegionName || p.region_name || p.code || p.id || p.name || `region_${++i}`;
    }
  }
  function latLonToDivision(lat, lon, regionsFC){
    if (!regionsFC?.features?.length) return null;
    const pt=[lon,lat]; // GeoJSON expects [lon,lat]
    for (const f of regionsFC.features){
      if (pointInPolygon(pt, f.geometry)) return f.properties?._b2m_id : null;
    }
    return null;
  }

  // choropleth
  const DIV_COUNTS = new Map();
  let BREAKS = [];
  const PALETTE = ["#FEF3C7","#FDE68A","#F59E0B","#EA580C","#B91C1C"]; // yellow → orange → red
  function computeQuantileBreaks(values, k=5){
    if (!values.length) return [];
    const v=values.slice().sort((a,b)=>a-b);
    const q=[]; for (let i=1;i<k;i++){ q.push(v[Math.floor((i/k)*(v.length-1))]); }
    return q;
  }
  function colorForCount(n){
    if (!n) return "#ffffff";
    let i=0; while (i<BREAKS.length && n>BREAKS[i]) i++; return PALETTE[i];
  }
  function styleForFeature(feat){
    const id = feat.properties?._b2m_id : null;
    const n  = (id && DIV_COUNTS.get(id)) || 0;
    return { color:"#fff", weight:0.8, fillOpacity:0.65, fillColor: colorForCount(n) };
  }

  let regionLayer=null, bubbleLayer=null;

  function recolorRegions(){
    if (!regionLayer) return;
    regionLayer.eachLayer(l => l.setStyle(styleForFeature(l.feature)));
  }

  async function buildMap(){
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded");
    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    const [statesFC, regionsFC] = await Promise.all([ fetchJSON(STATES_URL), fetchJSON(REGIONS_URL) ]);
    if (statesFC?.features) L.geoJSON(statesFC, { style: styleStates }).addTo(map);

    ensureRegionIds(regionsFC);

    if (regionsFC?.features?.length){
      regionLayer = L.geoJSON(regionsFC, { style: styleRegionsInitial }).addTo(map);
    }

    // toggle regions by zoom
    const toggleRegions = () => {
      if (!regionLayer) return;
      const on = map.getZoom() >= DIV_ZOOM;
      if (on && !map.hasLayer(regionLayer)) { map.addLayer(regionLayer); recolorRegions(); }
      if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      if (bubbleLayer) bubbleLayer.bringToFront(); // keep bubbles on top after toggling
    };
    map.on("zoomend", toggleRegions);

    // suburbs
    let suburbs=null;
    try {
      const txt = await fetchText(SUBURBS_URL);
      suburbs = JSON.parse(txt);
      if (suburbs && Array.isArray(suburbs.data)) suburbs = suburbs.data;
    } catch { suburbs=null; }

    if (!Array.isArray(suburbs)){
      console.warn("[B2M] suburbs file missing/unreadable — cannot plot per-row bubbles.");
      return;
    }

    const idx  = buildSuburbIndexes(suburbs);
    const rows = parseCSVSafe(await fetchText(CSV_URL));
    LOG("Rows parsed:", rows.length);
    if (!rows.length) return;

    const sample = rows[0];
    const keys = {
      state:  Object.keys(sample).find(k => /state/i.test(k)) || "",
      suburb: Object.keys(sample).find(k => /suburb|town|city|locality/i.test(k)) || "",
      pc:     Object.keys(sample).find(k => /post.?code|zip/i.test(k)) || ""
    };

    bubbleLayer = L.layerGroup().addTo(map); // ✅ bubbles on their own layer

    let plotted=0;
    for (const r of rows){
      const ll = rowToLatLon(r, keys, idx);
      if (!ll) continue;
      const [lat, lon] = ll;

      const m = L.circleMarker([lat,lon], pointStyle).addTo(bubbleLayer);
      const label = [r[keys.suburb], r[keys.state], r[keys.pc]].filter(Boolean).join(", ");
      m.bindTooltip(label, { sticky:true });
      plotted++;

      if (regionsFC){
        const id = latLonToDivision(lat, lon, regionsFC);
        if (id) DIV_COUNTS.set(id, (DIV_COUNTS.get(id)||0)+1);
      }
    }

    // compute breaks & recolor regions
    if (regionLayer){
      const vals = Array.from(DIV_COUNTS.values()).filter(n=>n>0);
      if (vals.length){
        BREAKS = computeQuantileBreaks(vals, PALETTE.length);
        recolorRegions(); // ✅ per-feature restyle (works reliably)
      } else {
        console.warn("[B2M] No divisions received counts — check overlap of points vs polygons.");
      }
    }

    bubbleLayer.bringToFront(); // ✅ ensure bubbles stay above polygons
    toggleRegions();            // apply initial zoom rule

    LOG("Plotted row-bubbles:", plotted, "Divisions counted:", DIV_COUNTS.size);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
