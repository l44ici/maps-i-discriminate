/* ===== Back2Maps — postcode-first regional counts ===== */
(() => {
  "use strict";

  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map";
  const DIV_ZOOM = +(document.querySelector(".back2maps")?.dataset?.divzoom || CFG.minZoomForDiv || 6);
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const SUBURBS_URL = CFG.suburbLookup || "";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const STS = new Set(["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"]);
  const asState = (s) => { const x = (s ?? "").trim().toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = (s) => { const x = (s ?? "").replace(/\s+/g, ""); return /^\d{4}$/.test(x) ? x : ""; };
  const norm = (s) => (s ?? "").toString().trim();
  const LOG = (...a) => console.log("[B2M]", ...a);

  const fetchJSON = (url) => fetch(url, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
  const fetchText = (url) => fetch(url, { cache: "no-cache" }).then(r => r.ok ? r.text() : "");

  function pointInPolygon(pt, geom) {
    const [x, y] = pt;
    if (!geom) return false;
    const testPoly = (poly) => {
      let inside = false;
      for (const ring of poly)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          const inter = (yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi;
          if (inter) inside = !inside;
        }
      return inside;
    };
    if (geom.type === "Polygon") return testPoly(geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.some(testPoly);
    return false;
  }

  function latLonToDivision(lat, lon, regions) {
    const pt = [lon, lat];
    for (const f of regions.features) {
      const g = f.geometry;
      if (!g) continue;
      const id = f.properties?.id || f.properties?.code || f.properties?.name;
      if (pointInPolygon(pt, g)) return id;
    }
    return null;
  }

  async function loadSuburbs() {
    if (!SUBURBS_URL) return null;
    try {
      const res = await fetch(SUBURBS_URL);
      if (!res.ok) return null;
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    } catch { return null; }
  }

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map(r => r.split(","));
    const [hdr, ...data] = rows;
    return data.map(r => Object.fromEntries(r.map((v, i) => [hdr[i].trim(), v.trim()])));
  }

  function buildPcIndex(suburbs, regions) {
    const idx = {};
    if (!suburbs || !regions) return idx;
    for (const r of suburbs) {
      const pc = asPostcode(r.postcode);
      const lat = +r.lat, lon = +r.lon;
      if (!pc || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const div = latLonToDivision(lat, lon, regions);
      if (div) idx[pc] = div;
    }
    LOG("Built postcode index:", Object.keys(idx).length);
    return idx;
  }

  async function buildMap() {
    if (typeof L === "undefined") return console.error("[B2M] Leaflet not loaded.");
    const map = L.map(ROOT_ID).fitBounds(AU_BOUNDS);
    const [states, regions, suburbs] = await Promise.all([
      fetchJSON(STATES_URL),
      fetchJSON(REGIONS_URL),
      loadSuburbs()
    ]);

    if (!regions?.features?.length) return;
    const pcIndex = buildPcIndex(suburbs, regions);

    const csv = await fetchText(CSV_URL);
    const rows = csv ? parseCSV(csv) : [];
    const counts = new Map(), stateCounts = new Map();

    for (const o of rows) {
      const st = asState(o.State || o["State / Territory"]);
      const pc = asPostcode(o.Postcode || o["Post Code"]);
      const div = pc && pcIndex[pc] ? pcIndex[pc] : null;
      if (div) counts.set(div, (counts.get(div) || 0) + 1);
      else if (st) stateCounts.set(st, (stateCounts.get(st) || 0) + 1);
    }

    const styleState  = { weight: 2, color: "#475569", fillOpacity: 0.2 };
    const styleRegion = { weight: 1, color: "#475569", fillOpacity: 0.05 };

    const stateLayer = L.geoJSON(states, {
      style: styleState,
      onEachFeature: (f, l) => {
        const n = stateCounts.get(asState(f.properties.STATE_ABBR)) || 0;
        l.bindPopup(`<strong>${f.properties.STATE_NAME}</strong><br>${n} report(s)`);
      }
    }).addTo(map);

    const regionLayer = L.geoJSON(regions, {
      style: styleRegion,
      onEachFeature: (f, l) => {
        const id = f.properties?.id || f.properties?.name;
        const n = counts.get(id) || 0;
        l.bindPopup(`<strong>${id}</strong><br>${n} report(s)`);
      }
    });

    map.on("zoomend", () => {
      const show = map.getZoom() >= DIV_ZOOM;
      if (show && !map.hasLayer(regionLayer)) map.addLayer(regionLayer);
      if (!show && map.hasLayer(regionLayer)) map.removeLayer(regionLayer);
    });

    LOG("Regions:", regions.features.length, "Rows:", rows.length);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
