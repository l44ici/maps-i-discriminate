/* ===== Back2Maps — states by default, regions on zoom, CSV-driven bubbles ===== */
(() => {
  "use strict";

  // — prevent theme jQuery UI progressbar crashes
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

  // AU view
  const AU_BOUNDS = [[-44, 112], [-10, 154]];

  // helpers
  const LOG = (...a) => console.log("[B2M]", ...a);
  const fetchJSON = (u) => fetch(u, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
  const fetchText = (u) => fetch(u, { cache: "no-cache" }).then(r => r.ok ? r.text() : "").catch(() => "");

  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = (s) => { const x=(s??"").toString().trim().toUpperCase(); return STS.has(x)?x:""; };

  // try to find a key in an object by exact or fuzzy terms
  function keyLike(obj, needles) {
    const keys = Object.keys(obj || {});
    const lows = keys.map(k => k.toLowerCase());
    const want = needles.map(n => n.toLowerCase());
    for (let i = 0; i < lows.length; i++) {
      const k = lows[i];
      if (want.some(n => k === n || k.includes(n))) return keys[i];
    }
    return "";
  }

  // safe CSV → array of objects
  function parseCSVSafe(txt) {
    if (!txt || typeof txt !== "string") return [];
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h => h.trim());
    const out = [];
    for (const line of lines) {
      const cells = line.split(","); // your file isn’t quoted; simple split is fine
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = (cells[i] ?? "").trim();
      out.push(o);
    }
    return out;
  }

  // centroid (lat,lon) for label placement
  function centroid(geom) {
    if (!geom) return null;
    const avg = (ring) => {
      let sx = 0, sy = 0, n = 0;
      for (const [x, y] of ring) { sx += x; sy += y; n++; }
      return n ? [sy / n, sx / n] : null; // [lat, lon]
    };
    if (geom.type === "Polygon") return avg(geom.coordinates[0]);
    if (geom.type === "MultiPolygon") return avg(geom.coordinates[0][0]);
    return null;
  }

  // SPLC-style bubble visuals
  function bubbleStyle(count) {
    const r = Math.max(6, Math.sqrt(count) * 2.2); // keep small ones readable
    return { radius:r, fillColor:"#d93b2b", color:"#a11e14", weight:0.5, fillOpacity:0.75, opacity:0.35 };
  }
  function labelIcon(text) {
    return L.divIcon({
      html: `<div style="color:#fff;font-size:11px;font-weight:700;text-align:center;transform:translateY(-1px)">${text}</div>`,
      className: "b2m-bubble-label",
      iconSize: [24, 24]
    });
  }

  // map state abbrev from region props
  function propToStateAbbr(props = {}) {
    const direct = props.ST || props.STATE_ABBR || props.state || props.State || props.st;
    const ab = asState(direct);
    if (ab) return ab;
    const name = (props.STATE_NAME || props.STATE || props.Name || props.name || "").toString().trim().toUpperCase();
    const MAP = {
      "NEW SOUTH WALES":"NSW","VICTORIA":"VIC","QUEENSLAND":"QLD","SOUTH AUSTRALIA":"SA",
      "WESTERN AUSTRALIA":"WA","TASMANIA":"TAS","NORTHERN TERRITORY":"NT","AUSTRALIAN CAPITAL TERRITORY":"ACT","ACT":"ACT"
    };
    return MAP[name] || "";
  }

  async function buildMap() {
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded");
    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    // 1) base layers
    const [statesFC, regionsFC] = await Promise.all([fetchJSON(STATES_URL), fetchJSON(REGIONS_URL)]);

    // draw states in beige (visible at all zooms)
    let stateLayer = null;
    if (statesFC?.features) {
      stateLayer = L.geoJSON(statesFC, {
        style: { color:"#ffffff", weight:1, fillColor:"#f4ebdf", fillOpacity:1 }
      }).addTo(map);
    }

    // draw regions faint (we’ll toggle with zoom)
    let regionLayer = null;
    if (regionsFC?.features?.length) {
      regionLayer = L.geoJSON(regionsFC, {
        style: { color:"#ffffff", weight:0.8, fillOpacity:0.05 }
      });
    }

    // 2) data → counts (robust header pick)
    let rows = [];
    try {
      rows = parseCSVSafe(await fetchText(CSV_URL));
    } catch { rows = []; }

    // find the column that holds state codes/names
    let stateKey = "";
    if (rows[0]) {
      stateKey = keyLike(rows[0], ["State / Territory", "State", "Incident State", "Territory", "st", "state"]);
    }
    const countsByState = new Map();
    for (const r of rows) {
      const st = asState(r[stateKey]);
      if (!st) continue;
      countsByState.set(st, (countsByState.get(st) || 0) + 1);
    }

    // 3) bubbles layer (per STATE centroid) — always shown
    const stateBubbles = [];
    if (statesFC?.features?.length) {
      for (const f of statesFC.features) {
        const st = propToStateAbbr(f.properties || {});
        const count = countsByState.get(st) || 0;
        if (!count) continue;
        const c = centroid(f.geometry);
        if (!c) continue;
        const [lat, lon] = c;
        const circle = L.circleMarker([lat, lon], bubbleStyle(count)).addTo(map);
        L.marker([lat, lon], { icon: labelIcon(count) }).addTo(map);
        circle.bindTooltip(`${f.properties.STATE_NAME || st}: ${count} report(s)`, { sticky:true });
        stateBubbles.push(circle);
      }
    }

    // 4) toggle regions layer with zoom (states remain visible)
    if (regionLayer) {
      const syncRegions = () => {
        const on = map.getZoom() >= DIV_ZOOM;
        if (on && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      };
      map.on("zoomend", syncRegions);
      syncRegions();
    }

    LOG("Rows:", rows.length, "States with bubbles:", stateBubbles.length, "Regions:", regionsFC?.features?.length || 0);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
