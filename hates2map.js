/* ===== Back2Maps — postcode-first counting into divisions/states (no markers) ===== */
(() => {
  "use strict";

  // ---- Theme safety: neutralize missing jQuery UI progressbar so errors don't halt JS
  (function () {
    if (window.jQuery && !jQuery.fn.progressbar) {
      jQuery.fn.progressbar = function () { return this; };
    }
  })();

  // ------- config from PHP / shortcode -------
  const CFG = (typeof B2M === "object" && B2M) || {};
  const ROOT_ID = "b2m-map"; // matches your shortcode
  // data-* overrides from the shortcode wrapper (optional)
  const WRAP = document.querySelector(".back2maps");
  const DIV_ZOOM = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  // URLs provided by back2maps.php
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const REGIONS_OBJ = CFG.divObject || "regional_div"; // only for TopoJSON
  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const SUBURBS_URL = CFG.suburbLookup || "suburbs.json";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx";
  // (Optional) postcode→division index; add later if you have one
  const PCINDEX_URL = CFG.pcIndexUrl || ""; // not in PHP now; okay to be blank

  // Australia view box
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // ------- small helpers -------
  const norm = s => (s ?? "").toString().trim();
  const STS = new Set(["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"]);
  const asState = s => { const x = norm(s).toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = s => { const x = norm(s).replace(/\s+/g, ""); return /^\d{4}$/.test(x) ? x : ""; };

  const fetchText = url => fetch(url, { cache: "no-cache" }).then(r => r.ok ? r.text() : "");
  const fetchJSON = url => fetch(url, { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null);
  const fetchexists = url => url ? fetch(url, { method: "HEAD", cache: "no-cache" }).then(r => r.ok) : Promise.resolve(false);

  // CSV parser (quoted cells ok)
  function parseCSV(text) {
    const out = []; let i = 0, cell = "", row = [], q = false;
    const pushCell = () => { row.push(cell); cell = ""; };
    const pushRow = () => { row.push(cell); out.push(row); row = []; cell = ""; };
    while (i < text.length) {
      const c = text[i++];
      if (q) { if (c === '"') { if (text[i] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') { q = true; continue; }
      if (c === ',') { pushCell(); continue; }
      if (c === '\n') { pushRow(); continue; }
      if (c === '\r') continue;
      cell += c;
    }
    if (cell.length || row.length) pushRow();
    return out;
  }

  // point-in-polygon for [lon,lat]
  function pointInPolygon(pt, geom) {
    const x = pt[0], y = pt[1];
    const testPoly = (poly) => {
      let inside = false;
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
          const inter = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
          if (inter) inside = !inside;
        }
      }
      return inside;
    };
    if (!geom) return false;
    if (geom.type === "Polygon") return testPoly(geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.some(testPoly);
    return false;
  }

  // TopoJSON -> GeoJSON (uses B2M.divObject)
  function topoToGeo(topology, objectName) {
    if (!topology || !topology.objects) return null;
    const obj = topology.objects[objectName] || Object.values(topology.objects)[0];
    if (obj && obj.type === "GeometryCollection") {
      return {
        type: "FeatureCollection",
        features: obj.geometries.map(g => ({ type: "Feature", properties: g.properties || {}, geometry: g }))
      };
    }
    return null;
  }

  // ------- state -------
  let map, stateLayer, regionLayer;
  let statesFC = null;
  let regionsFC = null;
  let suburbIdx = null;  // [{state,suburb,postcode,lat,lon}, ...]
  let pcIndex   = null;  // {"2541":"NSW-SouthCoast", ...}

  // public counters
  window.B2M_countsDivision = window.B2M_countsDivision || new Map(); // divisionId -> n
  window.B2M_countsState    = window.B2M_countsState    || new Map(); // stateAbbr  -> n
  const bumpDiv = id => { if (!id) return; window.B2M_countsDivision.set(id, (window.B2M_countsDivision.get(id) || 0) + 1); };
  const bumpSt  = st => { if (!st) return; window.B2M_countsState.set(st, (window.B2M_countsState.get(st) || 0) + 1); };

  function postcodeToDivision(pc) {
    if (pcIndex && pcIndex[pc]) return pcIndex[pc];
    return null;
  }

  function suburbToLatLon(state, suburb, pc) {
    if (!Array.isArray(suburbIdx)) return null;
    const st = asState(state), sub = norm(suburb).toLowerCase(), p = asPostcode(pc);
    const hit = suburbIdx.find(r =>
      asState(r.state) === st &&
      norm(r.suburb).toLowerCase() === sub &&
      (!p || asPostcode(r.postcode) === p)
    );
    return hit ? { lat: +hit.lat, lon: +hit.lon } : null;
  }

  function latLonToDivision(lat, lon) {
    if (!regionsFC) return null;
    const pt = [lon, lat];
    for (const f of regionsFC.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon" && pointInPolygon(pt, g)) {
        return (f.properties && (f.properties.id || f.properties.code || f.properties.name)) || null;
      }
      if (g.type === "MultiPolygon" && g.coordinates.some(poly => pointInPolygon(pt, { type: "Polygon", coordinates: poly }))) {
        return (f.properties && (f.properties.id || f.properties.code || f.properties.name)) || null;
      }
    }
    return null;
  }

  // ---- Load incidents from CSV; if empty and XLSX exists, load XLSX
  async function loadIncidentRows() {
    // try CSV
    const csvText = await fetchText(CSV_URL);
    if (csvText && csvText.trim()) {
      const rows = parseCSV(csvText);
      return rowsToObjects(rows);
    }

    // fallback to XLSX if provided
    if (await fetchexists(XLSX_URL) && window.XLSX) {
      const ab = await fetch(XLSX_URL).then(r => r.ok ? r.arrayBuffer() : null);
      if (!ab) return [];
      const wb = XLSX.read(ab, { type: "array" });
      const first = wb.SheetNames[0];
      const json = XLSX.utils.sheet_to_json(wb.Sheets[first], { defval: "" });
      return json;
    }
    return [];
  }

  function rowsToObjects(rows) {
    if (!rows || !rows.length) return [];
    const hdr = rows[0].map(h => norm(h));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const o = {};
      for (let c = 0; c < r.length; c++) o[hdr[c] || `col${c}`] = r[c];
      out.push(o);
    }
    return out;
  }

  async function countFromData(objs) {
    window.B2M_countsDivision.clear();
    window.B2M_countsState.clear();

    // index helpers (accept various header names)
    const get = (o, names) => {
      for (const n of names) if (o[n] !== undefined) return o[n];
      return "";
    };

    for (const o of objs) {
      const suburb = norm(get(o, ["Suburb", "suburb", "Town", "City", "Locality"]));
      const state  = asState(get(o, ["State / Territory", "State", "state", "Territory"]));
      const pc     = asPostcode(get(o, ["Post Code", "postcode", "Postcode", "Zip", "PC"]));
      const lat    = +get(o, ["Lat", "Latitude", "lat", "latitude"]);
      const lon    = +get(o, ["Lon", "Lng", "Longitude", "lon", "lng", "longitude"]);

      // 1) postcode → division
      if (pc) {
        const divId = postcodeToDivision(pc);
        if (divId) { bumpDiv(divId); continue; }
      }

      // 2) lat/lon direct → division
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const divId = latLonToDivision(lat, lon);
        if (divId) { bumpDiv(divId); continue; }
        if (state) { bumpSt(state); continue; }
        continue;
      }

      // 3) suburb+state → lat/lon → division
      if (suburb && state) {
        const pos = suburbToLatLon(state, suburb, pc);
        if (pos) {
          const divId = latLonToDivision(pos.lat, pos.lon);
          if (divId) { bumpDiv(divId); continue; }
          bumpSt(state); continue;
        }
      }

      // 4) state-only fallback
      if (state) { bumpSt(state); continue; }

      // 5) otherwise ignore
    }
  }

  function applyCountsToRegions() {
    if (!regionLayer) return;
    regionLayer.eachLayer(l => {
      const p = (l.feature && l.feature.properties) || {};
      const id = p.id || p.code || p.name;
      const n = window.B2M_countsDivision.get(id) || 0;
      p.report_count = n;

      const title = (p.name || id || "(unknown)");
      const st = p.state || p.ST || p.st || "—";
      const html = `<strong>${title}</strong><br>State: ${st}<br>${n} report(s)`;
      if (l.getPopup && l.getPopup()) l.setPopupContent(html);
      else l.bindPopup(html);
    });
  }

  function styleState()  { return { weight: 2, color: "#64748b", fillColor: "#f8fafc", fillOpacity: 0.18 }; }
  function styleRegion() { return { weight: 1, color: "#475569", fillColor: "#cbd5e1", fillOpacity: 0.04 }; }

  function ensureRootElement() {
    let root = document.getElementById(ROOT_ID) || document.querySelector(".b2m-map");
    if (root) return root;
    const parent = document.querySelector(".back2maps") || document.querySelector(".entry-content, main, #content, body");
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.className = "b2m-map";
    root.style.minHeight = "420px";
    root.style.borderRadius = "12px";
    parent.appendChild(root);
    console.warn("[Back2Maps] Root container was missing — created one automatically.");
    return root;
  }

  async function buildMap() {
    if (typeof L === "undefined") {
      const cont = ensureRootElement();
      cont.innerHTML = '<div style="padding:12px;color:#b91c1c">Leaflet library did not load. Check enqueue order.</div>';
      console.error("[Back2Maps] Leaflet not found (L is undefined).");
      return;
    }

    const root = ensureRootElement();

    // Map
    window.B2M_map = L.map(root, { zoomControl: true, minZoom: 3, maxZoom: 12 });
    window.B2M_map.fitBounds(AU_BOUNDS);

    // Load datasets
    const [states, regions, suburbs, pcidx] = await Promise.all([
      fetchJSON(STATES_URL),
      fetchJSON(REGIONS_URL),
      fetchexists(SUBURBS_URL).then(ok => ok ? fetchJSON(SUBURBS_URL) : null),
      fetchexists(PCINDEX_URL).then(ok => ok ? fetchJSON(PCINDEX_URL) : null),
    ]);

    statesFC = states && states.type ? states : null;

    // Regions: TopoJSON or GeoJSON
    if (regions && regions.type === "Topology") {
      regionsFC = topoToGeo(regions, REGIONS_OBJ);
    } else {
      regionsFC = regions && regions.type ? regions : null;
    }

    suburbIdx = Array.isArray(suburbs) ? suburbs : null;
    pcIndex   = (pcidx && typeof pcidx === "object") ? pcidx : null;

    if (statesFC) {
      stateLayer = L.geoJSON(statesFC, { style: styleState }).addTo(B2M_map);
    }

    if (regionsFC) {
      regionLayer = L.geoJSON(regionsFC, {
        style: styleRegion,
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const id = p.id || p.code || p.name;
          const n  = window.B2M_countsDivision.get(id) || 0;
          const st = p.state || p.ST || p.st || "—";
          layer.bindPopup(`<strong>${p.name || id || "(unknown)"}</strong><br>State: ${st}<br>${n} report(s)`);
        }
      });

      // Show divisions only when zoomed in
      const toggleRegions = () => {
        const on = B2M_map.getZoom() >= DIV_ZOOM;
        if (on && !B2M_map.hasLayer(regionLayer)) B2M_map.addLayer(regionLayer);
        if (!on && B2M_map.hasLayer(regionLayer)) B2M_map.removeLayer(regionLayer);
      };
      B2M_map.on("zoomend", toggleRegions);
      toggleRegions();
    }

    // Load incidents, count, then update UI
    const rows = await loadIncidentRows();
    await countFromData(rows);
    applyCountsToRegions();

    setTimeout(() => B2M_map.invalidateSize(), 100);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
