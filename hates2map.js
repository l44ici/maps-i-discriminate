/* ===== Back2Maps — SPLC-style bubble heat map (robust CSV + UI shim) ===== */
(() => {
  "use strict";

  /* ---- neutralize themes that call jQuery UI progressbar (prevents hard crash) */
  (function () {
    if (window.jQuery && !jQuery.fn.progressbar) {
      jQuery.fn.progressbar = function () { return this; };
    }
  })();

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map";
  const DIV_ZOOM = +(document.querySelector(".back2maps")?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx"; // not used here but kept for parity

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = s => { const x=(s??"").trim().toUpperCase(); return STS.has(x)?x:""; };
  const LOG = (...a)=>console.log("[B2M]",...a);

  const fetchJSON = (url) => fetch(url,{cache:"no-cache"}).then(r=>r.ok?r.json():null).catch(()=>null);
  const fetchText = (url) => fetch(url,{cache:"no-cache"}).then(r=>r.ok?r.text():"").catch(()=> "");

  /* ---- safe CSV parser: returns [] on empty/malformed input */
  function parseCSVSafe(txt) {
    if (!txt || typeof txt !== "string") return [];
    // find the first non-empty line for header
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h => h.trim());
    if (!header.length) return [];
    const rows = [];
    for (const line of lines) {
      // minimal CSV: split on commas (your file doesn’t use quotes)
      const cells = line.split(",").map(v => v.trim());
      const obj = {};
      for (let i=0;i<header.length;i++) obj[header[i]] = cells[i] ?? "";
      rows.push(obj);
    }
    return rows;
  }

  // Approx polygon centroid (outer ring only) — good enough for label placement
  function centroidOfGeom(geom){
    const avg = (ring) => {
      let sx=0, sy=0, n=0;
      for (const [x,y] of ring){ sx+=x; sy+=y; n++; }
      return n ? [sy/n, sx/n] : null; // return [lat,lon]
    };
    if (!geom) return null;
    if (geom.type === "Polygon") return avg(geom.coordinates[0]);
    if (geom.type === "MultiPolygon") return avg(geom.coordinates[0][0]);
    return null;
  }

  // Bubble style (SPLC-ish)
  function bubbleStyle(count){
    const r = Math.max(6, Math.sqrt(count) * 2.2); // readable minimum
    return {
      radius: r,
      fillColor: "#d93b2b",
      color: "#a11e14",
      weight: 0.5,
      fillOpacity: 0.7,
      opacity: 0.35
    };
  }

  function labelIcon(text){
    return L.divIcon({
      html: `<div style="color:#fff;font-size:11px;font-weight:700;text-align:center;transform:translateY(-1px)">${text}</div>`,
      className: "b2m-bubble-label",
      iconSize: [22,22]
    });
  }

  async function buildMap(){
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded.");
    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:10 });
    map.fitBounds(AU_BOUNDS);

    // Load polygons first so we can at least render a base map even if CSV fails
    const [states, regions] = await Promise.all([ fetchJSON(STATES_URL), fetchJSON(REGIONS_URL) ]);

    if (states?.features) {
      L.geoJSON(states, { style: { color:"#ffffff", weight:1, fillColor:"#f4ebdf", fillOpacity:1 } }).addTo(map);
    }
    if (!regions?.features?.length) {
      console.warn("[B2M] Regions not loaded or empty.");
      return;
    }
    const regionLayer = L.geoJSON(regions, { style:{ color:"#ffffff", weight:0.6, fillOpacity:0.05 } }).addTo(map);

    // Load CSV safely (never crash if empty/404)
    let rows = [];
    try {
      const txt = await fetchText(CSV_URL);
      rows = parseCSVSafe(txt);
    } catch (e) {
      console.warn("[B2M] CSV load/parse failed:", e);
      rows = [];
    }
    LOG("Rows parsed:", rows.length);

    // Count by state (you can later switch to division if you have postcode->division)
    const countsByState = new Map();
    for (const o of rows) {
      const st = asState(o.State || o["State / Territory"] || o.state);
      if (!st) continue;
      countsByState.set(st, (countsByState.get(st) || 0) + 1);
    }

    // Build simple state lookup on the region feature (common props: ST/state)
    const bubbles = [];
    for (const f of regions.features) {
      const p = f.properties || {};
      const st = asState(p.state || p.ST || p.st || p.STATE || p.STATE_ABBR);
      const count = countsByState.get(st) || 0;
      if (!count) continue;
      const c = centroidOfGeom(f.geometry);
      if (!c) continue;
      const [lat, lon] = c;
      const m = L.circleMarker([lat,lon], bubbleStyle(count)).addTo(map);
      m.bindTooltip(`${p.name || p.id || st}: ${count} report(s)`, { sticky:true });
      L.marker([lat,lon], { icon: labelIcon(count) }).addTo(map);
      bubbles.push(m);
    }

    // Show bubbles only when zoomed in enough (like your old div zoom)
    const toggle = () => {
      const on = map.getZoom() >= DIV_ZOOM;
      for (const m of bubbles) on ? m.addTo(map) : map.removeLayer(m);
    };
    map.on("zoomend", toggle);
    toggle();

    LOG("Map ready. Regions:", regions.features.length, "Bubbles:", bubbles.length);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
