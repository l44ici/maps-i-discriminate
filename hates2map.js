/* ===== Back2Maps — per-row bubbles + regional choropleth ===== */
(() => {
  "use strict";

  (function () {
    if (window.jQuery && !jQuery.fn.progressbar) {
      jQuery.fn.progressbar = function () { return this; };
    }
  })();

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map";
  const WRAP = document.querySelector(".back2maps");
  const DIV_ZOOM = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);
  const STATES_URL = CFG.statesUrl;
  const REGIONS_URL = CFG.divisionsUrl;
  const CSV_URL = CFG.cioDataCsv;
  const SUBURBS_URL = CFG.suburbLookup;
  const LOG = (...a) => console.log("[B2M]", ...a);
  const AU_BOUNDS = [[-44, 112], [-10, 154]];

  const fetchJSON = (u) => fetch(u, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
  const fetchText = (u) => fetch(u, { cache: "no-cache" }).then(r => r.ok ? r.text() : "").catch(() => "");

  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = s => { const x = (s ?? "").toString().trim().toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = s => { const x = (s ?? "").toString().replace(/\s+/g, ""); return /^\d{4}$/.test(x) ? x : ""; };
  const clean = s => (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");

  function parseCSVSafe(txt) {
    if (!txt || typeof txt !== "string") return [];
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return [];
    const header = lines.shift().split(",").map(h => h.trim());
    const out = [];
    for (const line of lines) {
      const cells = line.split(",");
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = (cells[i] ?? "").trim();
      out.push(o);
    }
    return out;
  }

  const styleStates  = { color:"#fff", weight:1, fillColor:"#f4ebdf", fillOpacity:1 };
  const pointStyle   = { radius:4, fillColor:"#d93b2b", color:"#a11e14", weight:0.5, fillOpacity:0.75, opacity:0.35 };

  // Choropleth data
  const DIV_COUNTS = new Map();
  let MAX_DIV_COUNT = 0;

  // --- Point-in-polygon test ---
  function pointInPolygon(pt, geom) {
    const [x, y] = pt;
    const test = (poly) => {
      let inside = false;
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          const inter = (yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi;
          if (inter) inside = !inside;
        }
      }
      return inside;
    };
    if (!geom) return false;
    if (geom.type === "Polygon") return test(geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.some(test);
    return false;
  }

  function divisionIdFromProps(p = {}) {
    return p.id || p.code || p.name || p._b2m_id;
  }

  function latLonToDivision(lat, lon, regionsFC) {
    if (!regionsFC?.features?.length) return null;
    const pt = [lon, lat];
    for (const f of regionsFC.features) {
      if (pointInPolygon(pt, f.geometry)) return divisionIdFromProps(f.properties || {});
    }
    return null;
  }

  function buildSuburbIndexes(suburbs) {
    const byPC = Object.create(null), bySubState = Object.create(null);
    if (!Array.isArray(suburbs)) return { byPC, bySubState };
    for (const r of suburbs) {
      const pc  = asPostcode(String(r.postcode ?? ""));
      const st  = asState(r.state);
      const sub = clean(r.suburb);
      const lat = +r.lat, lon = +(r.lon ?? r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (pc && !byPC[pc]) byPC[pc] = [lat, lon];
      if (st && sub && !bySubState[`${st}|${sub}`]) bySubState[`${st}|${sub}`] = [lat, lon];
    }
    LOG("Suburb index sizes:", Object.keys(byPC).length, Object.keys(bySubState).length);
    return { byPC, bySubState };
  }

  function rowToLatLon(row, keys, idx) {
    const pc = asPostcode(row[keys.pc]);
    if (pc && idx.byPC[pc]) return idx.byPC[pc];
    const st = asState(row[keys.state]);
    const sb = clean(row[keys.suburb]);
    if (st && sb && idx.bySubState[`${st}|${sb}`]) return idx.bySubState[`${st}|${sb}`];
    return null;
  }

  // Choropleth color ramp
  const RAMP = ["#fff5f0","#fcbba1","#fc9272","#fb6a4a","#de2d26","#a50f15"];
  function colorForCount(n) {
    if (!n || MAX_DIV_COUNT === 0) return "#ffffff";
    const idx = Math.min(RAMP.length - 1, Math.floor((n / MAX_DIV_COUNT) * (RAMP.length - 1)));
    return RAMP[idx];
  }
  function regionStyleWithCounts(feat) {
    const id = divisionIdFromProps(feat.properties || {});
    const n  = DIV_COUNTS.get(id) || 0;
    return { color:"#fff", weight:0.8, fillOpacity:0.65, fillColor: colorForCount(n) };
  }

  async function buildMap() {
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded");

    const map = L.map(ROOT_ID, { zoomControl:true, minZoom:3, maxZoom:12 });
    map.fitBounds(AU_BOUNDS);

    const [statesFC, regionsFC] = await Promise.all([ fetchJSON(STATES_URL), fetchJSON(REGIONS_URL) ]);
    if (statesFC?.features) L.geoJSON(statesFC, { style: styleStates }).addTo(map);

    let regionLayer = null;
    if (regionsFC?.features?.length) {
      regionLayer = L.geoJSON(regionsFC, { style: regionStyleWithCounts });
      const toggle = () => {
        const on = map.getZoom() >= DIV_ZOOM;
        if (on && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
        if (!on && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
      };
      map.on("zoomend", toggle); toggle();
    }

    // suburbs
    let suburbs = null;
    try {
      const txt = await fetchText(SUBURBS_URL);
      suburbs = JSON.parse(txt);
      if (suburbs && Array.isArray(suburbs.data)) suburbs = suburbs.data;
    } catch { suburbs = null; }

    if (!Array.isArray(suburbs)) {
      console.warn("[B2M] suburbs file missing/unreadable — cannot plot per-row bubbles.");
      return;
    }

    const idx = buildSuburbIndexes(suburbs);
    const rows = parseCSVSafe(await fetchText(CSV_URL));
    LOG("Rows parsed:", rows.length);

    if (!rows.length) return;

    const sample = rows[0];
    const keys = {
      state:  Object.keys(sample).find(k => /state/i.test(k)) || "",
      suburb: Object.keys(sample).find(k => /suburb|town|city/i.test(k)) || "",
      pc:     Object.keys(sample).find(k => /post.?code|zip/i.test(k)) || ""
    };

    let plotted = 0;
    for (const r of rows) {
      const ll = rowToLatLon(r, keys, idx);
      if (!ll) continue;
      const [lat, lon] = ll;

      // plot bubble
      const m = L.circleMarker([lat, lon], pointStyle).addTo(map);
      const label = [r[keys.suburb], r[keys.state], r[keys.pc]].filter(Boolean).join(", ");
      m.bindTooltip(label, { sticky:true });
      plotted++;

      // update division counts
      if (regionsFC) {
        const divId = latLonToDivision(lat, lon, regionsFC);
        if (divId) {
          const v = (DIV_COUNTS.get(divId) || 0) + 1;
          DIV_COUNTS.set(divId, v);
          if (v > MAX_DIV_COUNT) MAX_DIV_COUNT = v;
        }
      }
    }

    // refresh choropleth colors
    if (regionLayer) regionLayer.setStyle(regionStyleWithCounts);
    LOG(`Plotted ${plotted} points across ${DIV_COUNTS.size} divisions.`);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
