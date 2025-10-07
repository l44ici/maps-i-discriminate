/* ===== Back2Maps — bubbles on top + regional choropleth + smooth zoom fade (no bubble popups) ===== */
(() => {
  "use strict";

  // Theme quirk guard: neutralize missing jQuery UI progressbar
  if (window.jQuery && !jQuery.fn.progressbar) jQuery.fn.progressbar = function(){ return this; };

  // Smooth polygon fades
  (function injectCSS(){
    const s = document.createElement("style");
    s.textContent = `
      #b2m-map .leaflet-interactive{transition:fill-opacity .25s linear,stroke-opacity .25s linear}
    `;
    document.head.appendChild(s);
  })();

  // ---- Config from PHP
  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID  = "b2m-map";
  const DIV_ZOOM = +(CFG.minZoomForDiv || 6);

  const STATES_URL  = CFG.statesUrl;
  const REGIONS_URL = CFG.divisionsUrl;
  const CSV_URL     = CFG.cioDataCsv;
  const SUBURBS_URL = CFG.suburbLookup;

  const AU_BOUNDS = [[-44,112],[-10,154]];
  const LOG = (...a)=>console.log("[B2M]",...a);

  const fetchJSON = (u)=>fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  const fetchText = (u)=>fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.text():"").catch(()=>"");

  // ---- Helpers
  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState    = s => { const x=(s??"").toString().trim().toUpperCase(); return STS.has(x)?x:""; };
  const asPostcode = s => { const x=(s??"").toString().replace(/\s+/g,""); return /^\d{4}$/.test(x)?x:""; };
  const clean      = s => (s??"").toString().toLowerCase().replace(/[^a-z0-9]/g,"");

  function parseCSVSafe(txt){
    if (!txt) return [];
    const lines = txt.split(/\r?\n/).filter(l=>l.trim());
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h=>h.trim());
    return lines.map(line=>{
      const cells=line.split(","); const o={};
      for (let i=0;i<header.length;i++) o[header[i]]=(cells[i]??"").trim();
      return o;
    });
  }

  // ---- Styles
  const styleStates  = { color:"#fff", weight:1,   fillColor:"#f4ebdf", fillOpacity:1,   opacity:1 };
  const styleRegions = { color:"#fff", weight:0.8, fillColor:"#FDE68A", fillOpacity:0.20, opacity:1 }; // initial tint
  const pointStyle   = {                 // bubbles: slightly bigger, no popups
    radius: 6,                          // ← bigger dots
    fillColor: "#d93b2b",
    color: "#a11e14",
    weight: 0.7,
    fillOpacity: 0.80,
    opacity: 0.35
  };

  // ---- Suburb index (lat/lng)
  function buildSuburbIndex(rows){
    const byPC={}, bySubState={};
    for (const r of rows){
      const pc  = asPostcode(r.postcode);
      const st  = asState(r.state);
      const sub = clean(r.suburb);
      const lat = +r.lat, lon = +r.lng; // file uses lat/lng
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (pc && !byPC[pc]) byPC[pc]=[lat,lon];
      if (st && sub && !bySubState[`${st}|${sub}`]) bySubState[`${st}|${sub}`]=[lat,lon];
    }
    LOG("Suburb index sizes:", Object.keys(byPC).length, Object.keys(bySubState).length);
    return { byPC, bySubState };
  }
  function rowToLatLon(row, keys, idx){
    const pc = asPostcode(row[keys.pc]);
    if (pc && idx.byPC[pc]) return idx.byPC[pc];
    const st = asState(row[keys.state]); const sb = clean(row[keys.suburb]);
    if (st && sb && idx.bySubState[`${st}|${sb}`]) return idx.bySubState[`${st}|${sb}`];
    return null;
  }

  // ---- Geo helpers
  function ensureRegionIds(fc){
    if (!fc?.features) return;
    let i=0;
    for (const f of fc.features){
      const p=f.properties||(f.properties={});
      p._b2m_id = p._b2m_id || p.SA4_NAME || p.SA3_NAME || p.REGION_NAME || p.RegionName || p.region_name || p.code || p.id || p.name || `region_${++i}`;
    }
  }
  function pointInPolygon(pt, geom){
    const [x,y]=pt; const test=(poly)=>{
      let inside=false;
      for (const ring of poly){
        for (let i=0,j=ring.length-1;i<ring.length;j=i++){
          const [xi,yi]=ring[i],[xj,yj]=ring[j];
          const inter=(yi>y)!==(yj>y) && x < (xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi;
          if (inter) inside=!inside;
        }
      } return inside;
    };
    if (!geom) return false;
    if (geom.type==="Polygon") return test(geom.coordinates);
    if (geom.type==="MultiPolygon") return geom.coordinates.some(test);
    return false;
  }
  function latLonToDivision(lat, lon, regionsFC){
    const pt=[lon,lat];
    for (const f of regionsFC.features){
      if (pointInPolygon(pt, f.geometry)) return f.properties._b2m_id;
    }
    return null;
  }
  const regionName = (p={}) => p.SA4_NAME||p.SA3_NAME||p.REGION_NAME||p.name||p._b2m_id;

  // ---- Choropleth
  const DIV_COUNTS = new Map();
  const PALETTE = ["#FEF3C7","#FDE68A","#F59E0B","#EA580C","#B91C1C"];
  let BREAKS=[];
  function quantiles(vals){
    if (!vals.length) return [];
    const v=vals.slice().sort((a,b)=>a-b);
    return [0.2,0.4,0.6,0.8].map(q=>v[Math.floor(q*(v.length-1))]);
  }
  const colorFor = n => { if (!n) return "#ffffff"; let i=0; while(i<BREAKS.length && n>BREAKS[i]) i++; return PALETTE[i]; };

  // keep references
  let statesLayer=null, regionLayer=null, bubbleLayer=null, regionsFC=null;

  function recolorAndRetitleRegions(){
    if (!regionLayer) return;
    regionLayer.eachLayer(l=>{
      const p = l.feature.properties || {};
      const id = p._b2m_id;
      const n  = DIV_COUNTS.get(id) || 0;
      l.setStyle({ fillColor: colorFor(n), fillOpacity: 0.65, color:"#fff", weight:0.8, opacity:1 });
      const title = `${regionName(p)}<br><small>${n} report${n===1?"":"s"}</small>`;
      if (l.getTooltip()) l.setTooltipContent(title); else l.bindTooltip(title, {sticky:true});
    });
  }

  function applyZoomFade(map){
    const showRegions = map.getZoom() >= DIV_ZOOM;
    if (statesLayer) {
      statesLayer.eachLayer(l=>l.setStyle({ fillOpacity: showRegions ? 0.18 : 1, opacity:1 }));
    }
    if (regionLayer) {
      const target = showRegions ? (DIV_COUNTS.size ? 0.65 : 0.20) : 0;
      regionLayer.eachLayer(l=>l.setStyle({ fillOpacity: target, opacity: showRegions ? 1 : 0 }));
    }
    if (bubbleLayer) bubbleLayer.bringToFront(); // dots always above
  }

  // ---- Main
  async function buildMap(){
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded");

    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    const [statesFC, regions] = await Promise.all([ fetchJSON(STATES_URL), fetchJSON(REGIONS_URL) ]);
    regionsFC = regions;
    ensureRegionIds(regionsFC);

    if (statesFC?.features)  statesLayer = L.geoJSON(statesFC,  { style: styleStates  }).addTo(map);
    if (regionsFC?.features) regionLayer = L.geoJSON(regionsFC, { style: styleRegions }).addTo(map);

    // initial empty tooltips per region (counts update later)
    if (regionLayer){
      regionLayer.eachLayer(l=>{
        const p=l.feature.properties||{};
        const title = `${regionName(p)}<br><small>0 report(s)</small>`;
        l.bindTooltip(title, { sticky:true });
      });
    }

    // Bubbles layer (no tooltips/popups for privacy)
    bubbleLayer = L.layerGroup().addTo(map);

    // Load suburbs + CSV
    let suburbs=null;
    try {
      const txt = await fetchText(SUBURBS_URL);
      suburbs = JSON.parse(txt);
      if (suburbs && Array.isArray(suburbs.data)) suburbs = suburbs.data;
    } catch { suburbs=null; }
    if (!Array.isArray(suburbs)) { console.warn("[B2M] suburbs missing/unreadable"); return; }

    const idx  = buildSuburbIndex(suburbs);
    const rows = parseCSVSafe(await fetchText(CSV_URL));
    LOG("Rows parsed:", rows.length);
    if (!rows.length) return;

    const sample = rows[0];
    const keys = {
      state:  Object.keys(sample).find(k=>/state/i.test(k)) || "",
      suburb: Object.keys(sample).find(k=>/suburb|town|city|locality/i.test(k)) || "",
      pc:     Object.keys(sample).find(k=>/post.?code|zip/i.test(k)) || ""
    };

    // Plot dots (NO tooltip/popup)
    let plotted=0;
    for (const r of rows){
      const ll = rowToLatLon(r, keys, idx);
      if (!ll) continue;
      const [lat, lon] = ll;
      L.circleMarker([lat,lon], pointStyle).addTo(bubbleLayer);
      plotted++;

      const id = latLonToDivision(lat, lon, regionsFC);
      if (id) DIV_COUNTS.set(id, (DIV_COUNTS.get(id)||0)+1);
    }

    // Compute breaks + recolor + update region tooltips
    const vals = Array.from(DIV_COUNTS.values()).filter(v=>v>0);
    if (vals.length) {
      BREAKS = quantiles(vals);
      recolorAndRetitleRegions();
    }

    // Smooth fade behaviour
    applyZoomFade(map);
    map.on("zoomend", ()=>applyZoomFade(map));

    bubbleLayer.bringToFront();
    LOG("Plotted bubbles:", plotted, "Divisions counted:", DIV_COUNTS.size);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
