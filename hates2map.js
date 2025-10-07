/* ===== Back2Maps — one bubble per row (postcode/suburb → coords), states default, regions on zoom ===== */
(() => {
  "use strict";

  // prevent theme jQuery UI "progressbar" crashes
  (function () {
    if (window.jQuery && !jQuery.fn.progressbar) {
      jQuery.fn.progressbar = function () { return this; };
    }
  })();

  const CFG        = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID    = "b2m-map";
  const WRAP       = document.querySelector(".back2maps");
  const DIV_ZOOM   = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.geojson";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const SUBURBS_URL = CFG.suburbLookup || "suburbs.json";

  const AU_BOUNDS   = [[-44, 112], [-10, 154]];
  const LOG = (...a)=>console.log("[B2M]",...a);

  // fetching
  const fetchJSON = (u) => fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  const fetchText = (u) => fetch(u,{cache:"no-cache"}).then(r=>r.ok?r.text():"").catch(()=> "");

  // normalisers
  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = s => { const x=(s??"").toString().trim().toUpperCase(); return STS.has(x)?x:""; };
  const asPostcode = s => { const x=(s??"").toString().replace(/\s+/g,""); return /^\d{4}$/.test(x)?x:""; };
  const clean = s => (s??"").toString().toLowerCase().replace(/[^a-z0-9]/g,"");

  // find likely header key
  const keyLike = (obj, needles) => {
    const keys = Object.keys(obj||{}), lows = keys.map(k=>k.toLowerCase());
    const want = needles.map(n=>n.toLowerCase());
    for (let i=0;i<lows.length;i++){ const k=lows[i]; if (want.some(n=>k===n || k.includes(n))) return keys[i]; }
    return "";
  };

  // safe CSV -> array of objects
  function parseCSVSafe(txt){
    if (!txt || typeof txt!=="string") return [];
    const lines = txt.split(/\r?\n/).filter(l=>l.trim().length);
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h=>h.trim());
    const out = [];
    for (const line of lines){
      const cells = line.split(","); // your file uses simple CSV
      const o = {};
      for (let i=0;i<header.length;i++) o[header[i]] = (cells[i] ?? "").trim();
      out.push(o);
    }
    return out;
  }

  // region/state styles
  const styleStates  = { color:"#ffffff", weight:1, fillColor:"#f4ebdf", fillOpacity:1 };
  const styleRegions = { color:"#ffffff", weight:0.8, fillOpacity:0.05 };

  // small red bubble for each row
  const pointStyle = {
    radius: 4,
    fillColor: "#d93b2b",
    color: "#a11e14",
    weight: 0.5,
    fillOpacity: 0.75,
    opacity: 0.35
  };

  function centroid(geom){
    const avg = (ring)=>{ let sx=0,sy=0,n=0; for (const [x,y] of ring){sx+=x;sy+=y;n++;} return n?[sy/n,sx/n]:null; };
    if (!geom) return null;
    if (geom.type==="Polygon") return avg(geom.coordinates[0]);
    if (geom.type==="MultiPolygon") return avg(geom.coordinates[0][0]);
    return null;
  }

  // Build lookups from suburbs: postcode -> [lat,lon], and (state|suburb) -> [lat,lon]
  function buildSuburbIndexes(suburbs){
    const byPC = Object.create(null), bySubState = Object.create(null);
    if (!Array.isArray(suburbs)) return { byPC, bySubState };
    for (const r of suburbs){
      const pc  = asPostcode(r.postcode);
      const st  = asState(r.state);
      const sub = clean(r.suburb);
      const lat = +r.lat, lon = +r.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (pc && !byPC[pc]) byPC[pc] = [lat,lon];
      if (st && sub && !bySubState[`${st}|${sub}`]) bySubState[`${st}|${sub}`] = [lat,lon];
    }
    LOG("Suburb index sizes:", Object.keys(byPC).length, Object.keys(bySubState).length);
    return { byPC, bySubState };
  }

  // resolve a row to lat/lon via postcode first, then suburb+state
  function rowToLatLon(row, keys, idx){
    const pc = asPostcode(row[keys.pc]);
    if (pc && idx.byPC[pc]) return idx.byPC[pc];
    const st = asState(row[keys.state]);
    const sb = clean(row[keys.suburb]);
    if (st && sb && idx.bySubState[`${st}|${sb}`]) return idx.bySubState[`${st}|${sb}`];
    return null;
  }

  async function buildMap(){
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded");

    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    // load base polygons
    const [statesFC, regionsFC] = await Promise.all([ fetchJSON(STATES_URL), fetchJSON(REGIONS_URL) ]);

    if (statesFC?.features) L.geoJSON(statesFC, { style: styleStates }).addTo(map);

    let regionLayer = null;
    if (regionsFC?.features?.length) {
      regionLayer = L.geoJSON(regionsFC, { style: styleRegions });
      // toggle regions only at zoom >= DIV_ZOOM
      const toggle = () => {
        const on = map.getZoom() >= DIV_ZOOM;
        if (on && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      };
      map.on("zoomend", toggle); toggle();
    }

    // load suburbs gazetteer (for coordinates)
    let suburbs = null;
    try {
      if (SUBURBS_URL) {
        const txt = await fetchText(SUBURBS_URL);
        try { suburbs = JSON.parse(txt); } catch { suburbs = null; }
      }
    } catch { suburbs = null; }

    if (!Array.isArray(suburbs)) {
      console.warn("[B2M] suburbs file missing/unreadable — cannot plot per-row bubbles.");
      return; // we can’t derive lat/lon per row without this
    }
    const idx = buildSuburbIndexes(suburbs);

    // load CSV rows
    let rows = [];
    try { rows = parseCSVSafe(await fetchText(CSV_URL)); } catch { rows = []; }
    LOG("Rows parsed:", rows.length);

    if (!rows.length) return;

    // discover header keys
    const sample = rows[0] || {};
    const keys = {
      state:  keyLike(sample, ["State / Territory","State","Incident State","Territory","st","state"]),
      suburb: keyLike(sample, ["Suburb","Town","City","Locality","suburb","town","city","locality"]),
      pc:     keyLike(sample, ["Post Code","Postcode","postcode","Zip","PC","post code","zip"])
    };

    let plotted = 0;
    for (const r of rows){
      const ll = rowToLatLon(r, keys, idx);
      if (!ll) continue;
      const [lat, lon] = ll;
      const m = L.circleMarker([lat,lon], pointStyle).addTo(map);
      const st = r[keys.state] || "";
      const sb = r[keys.suburb] || "";
      const pc = r[keys.pc] || "";
      m.bindTooltip(`${sb ? `${sb}, ` : ""}${st}${pc ? ` ${pc}` : ""}`, { sticky:true });
      plotted++;
    }

    LOG("Plotted row-bubbles:", plotted);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
