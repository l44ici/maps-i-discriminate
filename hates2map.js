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
  const ROOT_ID = "b2m-map"; // matches shortcode output
  const WRAP = document.querySelector(".back2maps");
  const DIV_ZOOM = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  // URLs from PHP
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const REGIONS_OBJ = CFG.divObject || "regional_div"; // for TopoJSON
  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const SUBURBS_URL = CFG.suburbLookup || "suburbs.json";
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx";
  const PCINDEX_URL = CFG.pcIndexUrl   || "";

  // Australia bounds
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // ---- diagnostics helpers ----
  const LOG = (...a) => console.log("[B2M]", ...a);
  function banner(msg, color = "#7c3aed") { // purple so it stands out but friendly
    try {
      const el = document.createElement("div");
      el.style.cssText =
        `position:absolute;z-index:9999;top:8px;right:8px;background:#fff;border:2px solid ${color};` +
        `color:${color};padding:6px 10px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.06);font:12px/1.2 system-ui`;
      el.textContent = msg;
      (document.getElementById(ROOT_ID) || document.body).appendChild(el);
      setTimeout(() => el.remove(), 8000);
    } catch (_) {}
  }

  // ------- small helpers -------
  const norm = (s) => (s ?? "").toString().trim();
  const STS = new Set(["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"]);
  const asState = (s) => { const x = norm(s).toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = (s) => { const x = norm(s).replace(/\s+/g, ""); return /^\d{4}$/.test(x) ? x : ""; };

  const fetchText = (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : ""));
  const fetchJSON = (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fetchexists = (url) => url ? fetch(url, { method: "HEAD", cache: "no-cache" }).then((r) => r.ok) : Promise.resolve(false);

  // CSV parser
  function parseCSV(text) {
    const out = []; let i = 0, cell = "", row = [], q = false;
    const pushCell = () => { row.push(cell); cell = ""; };
    const pushRow  = () => { row.push(cell); out.push(row); row = []; cell = ""; };
    while (i < text.length) {
      const c = text[i++];
      if (q) { if (c === '"') { if (text[i] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') { q = true; continue; }
      if (c === ",") { pushCell(); continue; }
      if (c === "\n") { pushRow(); continue; }
      if (c === "\r") continue;
      cell += c;
    }
    if (cell.length || row.length) pushRow();
    return out;
  }

  // point-in-polygon
  function pointInPolygon(pt, geom) {
    const x = pt[0], y = pt[1];
    const testPoly = (poly) => {
      let inside = false;
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
          const inter = (yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi;
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

  // TopoJSON -> GeoJSON
  function topoToGeo(topology, objectName) {
    if (!topology || !topology.objects) return null;
    const obj = topology.objects[objectName] || Object.values(topology.objects)[0];
    if (obj && obj.type === "GeometryCollection") {
      return {
        type: "FeatureCollection",
        features: obj.geometries.map((g) => ({
          type: "Feature",
          properties: g.properties || {},
          geometry: g,
        })),
      };
    }
    return null;
  }

  // ------- global state -------
  let stateLayer, regionLayer;
  let statesFC = null;
  let regionsFC = null;
  let suburbIdx = null;   // array of gazetteer rows
  let pcIndex = null;     // optional postcode->division map

  // public counters
  window.B2M_countsDivision = window.B2M_countsDivision || new Map();
  window.B2M_countsState    = window.B2M_countsState    || new Map();
  const bumpDiv = (id) => { if (!id) return; window.B2M_countsDivision.set(id, (window.B2M_countsDivision.get(id) || 0) + 1); };
  const bumpSt  = (st) => { if (!st) return; window.B2M_countsState.set(st, (window.B2M_countsState.get(st) || 0) + 1); };

  // postcode -> division via optional index
  function postcodeToDivision(pc) {
    if (pcIndex && pcIndex[pc]) return pcIndex[pc];
    return null;
  }

  // suburb/state(/pc) -> lat/lng via gazetteer
  function suburbToLatLon(state, suburb, pc) {
    if (!Array.isArray(suburbIdx)) return null;
    const st = asState(state), sub = norm(suburb).toLowerCase(), p = asPostcode(pc);
    const hit = suburbIdx.find(r => {
      const rState = asState(r.state || r.State || r.state_abbrev);
      const rSub   = norm(r.suburb || r.Suburb || r.town || r.city || r.locality).toLowerCase();
      const rPC    = asPostcode(r.postcode || r.Postcode || r.post_code || r.pc);
      return rState === st && rSub === sub && (!p || rPC === p);
    });
    if (!hit) return null;
    const lat = + (hit.lat || hit.Lat || hit.latitude || hit.Latitude);
    const lng = + (hit.lng || hit.lon || hit.Lng || hit.Lon || hit.longitude || hit.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lon: lng };
  }

  // lat/lon -> divisionId via polygons
  function latLonToDivision(lat, lon) {
    if (!regionsFC || !Array.isArray(regionsFC.features)) return null;
    const pt = [lon, lat];
    for (const f of regionsFC.features) {
      const g = f.geometry;
      if (!g) continue;
      const id = f.properties?._b2m_id || f.properties?.id || f.properties?.code || f.properties?.name || null;
      if (g.type === "Polygon"      && pointInPolygon(pt, g)) return id;
      if (g.type === "MultiPolygon" && g.coordinates.some(poly => pointInPolygon(pt, { type:"Polygon", coordinates: poly }))) return id;
    }
    return null;
  }

  // ---- Load incidents ----
  async function loadIncidentRows() {
    const csvText = await fetchText(CSV_URL);
    if (csvText && csvText.trim()) return rowsToObjects(parseCSV(csvText));
    if (await fetchexists(XLSX_URL) && window.XLSX) {
      const ab = await fetch(XLSX_URL).then(r => r.ok ? r.arrayBuffer() : null);
      if (!ab) return [];
      const wb = XLSX.read(ab, { type: "array" });
      const first = wb.SheetNames[0];
      return XLSX.utils.sheet_to_json(wb.Sheets[first], { defval: "" });
    }
    return [];
  }

  // make objects from CSV rows + fuzzy header matching
  function rowsToObjects(rows) {
    if (!rows || !rows.length) return [];
    const hdr = rows[0].map(h => norm(h));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const o = {};
      for (let c = 0; c < r.length; c++) o[hdr[c] || `col${c}`] = r[c];
      out.push(o);
    }
    return out;
  }

  // get field with fuzzy keys
  function pick(o, patterns) {
    for (const p of patterns) {
      if (typeof p === "string" && o[p] !== undefined) return o[p];
      if (p instanceof RegExp) {
        const k = Object.keys(o).find(k => p.test(k));
        if (k) return o[k];
      }
    }
    return "";
  }

  async function countFromData(objs) {
    window.B2M_countsDivision.clear();
    window.B2M_countsState.clear();

    let matchedDivs = 0, matchedStates = 0;

    for (const o of objs) {
      const suburb = norm(pick(o, ["Suburb","suburb","Town","City","Locality", /suburb|town|city|local/i]));
      const state  = asState(pick(o, ["State / Territory","State / Terri","State","state","Territory", /state/i]));
      const pc     = asPostcode(pick(o, ["Post Code","postcode","Postcode","Zip","PC", /post.*code|zip|pc/i]));
      const lat    = +pick(o, ["Lat","Latitude","lat","latitude"]);
      const lon    = +pick(o, ["Lon","Lng","Longitude","lon","lng","longitude"]);

      // 1) postcode → division (only if external index provided)
      if (pc) {
        const divId = postcodeToDivision(pc);
        if (divId) { bumpDiv(divId); matchedDivs++; continue; }
      }

      // 2) lat/lon direct → division (won't fire for your CSV, but safe)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const divId = latLonToDivision(lat, lon);
        if (divId) { bumpDiv(divId); matchedDivs++; continue; }
        if (state) { bumpSt(state); matchedStates++; continue; }
        continue;
      }

      // 3) suburb+state → lat/lon via gazetteer → division
      if (suburb && state) {
        const pos = suburbToLatLon(state, suburb, pc);
        if (pos) {
          const divId = latLonToDivision(pos.lat, pos.lon);
          if (divId) { bumpDiv(divId); matchedDivs++; continue; }
          bumpSt(state); matchedStates++; continue;
        }
      }

      // 4) state-only fallback
      if (state) { bumpSt(state); matchedStates++; continue; }
    }

    LOG(`Counts by method — postcode:${window.B2M_countsDivision.size}, lat/lon:${matchedDivs}, gazetteer:${matchedDivs}, stateOnly:${matchedStates}, total:${objs.length}`);
  }

  function applyCountsToRegions() {
    if (!regionLayer) return;
    regionLayer.eachLayer((l) => {
      const p = (l.feature && l.feature.properties) || {};
      const id = p._b2m_id || p.id || p.code || p.name;
      const n  = window.B2M_countsDivision.get(id) || 0;
      const title = p.name || id || "(unknown)";
      const st = p.state || p.ST || p.st || "—";
      const html = `<strong>${title}</strong><br>State: ${st}<br>${n} report(s)`;
      if (l.getPopup && l.getPopup()) l.setPopupContent(html);
      else l.bindPopup(html);
    });
  }

  function applyCountsToStates() {
    if (!stateLayer) return;
    stateLayer.eachLayer((l) => {
      const p = (l.feature && l.feature.properties) || {};
      const name = p.STATE_NAME || p.STATE || p.Name || p.name || "State";
      const abbr = (p.ST || p.STATE_ABBR || p.state_abbrev || p.State || p.state || name).toString().toUpperCase();
      const n = (window.B2M_countsState && window.B2M_countsState.get(abbr)) || 0;
      if (l.getPopup && l.getPopup()) l.setPopupContent(`<strong>${name}</strong><br>${n} report(s)`);
    });
  }

  const styleState  = () => ({ weight: 2.5, color: "#475569", fillColor: "#e5e7eb", fillOpacity: 0.25 });
  const styleRegion = () => ({ weight: 1,   color: "#475569", fillColor: "#cbd5e1", fillOpacity: 0.04 });

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
      console.error("[Back2Maps] Leaflet not found.");
      return;
    }

    const root = ensureRootElement();
    window.B2M_map = L.map(root, { zoomControl: true, minZoom: 3, maxZoom: 12 });
    window.B2M_map.fitBounds(AU_BOUNDS);

    // ---- Load datasets ----
    const [states, regions, suburbs, pcidx] = await Promise.all([
      fetchJSON(STATES_URL),
      fetchJSON(REGIONS_URL),
      fetchexists(SUBURBS_URL).then(ok => ok ? fetchJSON(SUBURBS_URL) : null),
      fetchexists(PCINDEX_URL).then(ok => ok ? fetchJSON(PCINDEX_URL) : null),
    ]);

    // Normalize
    statesFC = states && states.type ? states : null;
    regionsFC = null;
    if (regions) {
      if (regions.type === "Topology") regionsFC = topoToGeo(regions, REGIONS_OBJ);
      else if (regions.type === "FeatureCollection") regionsFC = regions;
    }

    // suburbs.json may be an array OR {data:[…]}
    if (Array.isArray(suburbs)) {
      suburbIdx = suburbs;
    } else if (suburbs && Array.isArray(suburbs.data)) {
      suburbIdx = suburbs.data;
    } else {
      suburbIdx = null;
    }

    pcIndex = pcidx && typeof pcidx === "object" ? pcidx : null;

    // Ensure each region has an id/name for counting
    if (regionsFC && Array.isArray(regionsFC.features)) {
      regionsFC.features.forEach((f, i) => {
        const p = f.properties || (f.properties = {});
        p._b2m_id = p.id || p.code || p.name || `R${i + 1}`;
        if (!p.name) p.name = `Region ${i + 1}`;
      });
    }

    LOG("URLs:", { STATES_URL, REGIONS_URL, CSV_URL });
    LOG("States FC:", statesFC ? "ok" : "missing");
    LOG("Regions FC:", regionsFC ? `ok (features=${regionsFC.features?.length || 0})` : "missing");
    LOG("Suburb gazetteer:", suburbIdx ? `ok (${suburbIdx.length})` : "missing");
    LOG("External PC index:", pcIndex ? "ok" : "missing");

    if (!suburbIdx && !pcIndex) {
      banner("No postcode index and no suburbs.json — division counts impossible. Counting to states only.");
    }

    // ---- Layers ----
    if (statesFC) {
      stateLayer = L.geoJSON(statesFC, {
        style: styleState,
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const name = p.STATE_NAME || p.STATE || p.Name || p.name || "State";
          const abbr = (p.ST || p.STATE_ABBR || p.state_abbrev || p.State || p.state || name).toString().toUpperCase();
          const n = window.B2M_countsState.get(abbr) || 0;
          layer.bindPopup(`<strong>${name}</strong><br>${n} report(s)`);
          layer.on({
            mouseover: (e) => e.target.setStyle({ weight: 3 }),
            mouseout:  (e) => stateLayer.resetStyle(e.target),
          });
        },
      }).addTo(B2M_map);
    }

    if (regionsFC && Array.isArray(regionsFC.features) && regionsFC.features.length) {
      regionLayer = L.geoJSON(regionsFC, {
        style: styleRegion,
        onEachFeature: (feat, layer) => {
          const p  = feat.properties || {};
          const id = p._b2m_id || p.id || p.code || p.name;
          const n  = window.B2M_countsDivision.get(id) || 0;
          const st = p.state || p.ST || p.st || "—";
          layer.bindPopup(`<strong>${p.name || id || "(unknown)"}<\/strong><br>State: ${st}<br>${n} report(s)`);
        },
      });
      // show now + keep zoom toggle
      B2M_map.addLayer(regionLayer);
      const toggleRegions = () => {
        const on = B2M_map.getZoom() >= DIV_ZOOM;
        if (on && !B2M_map.hasLayer(regionLayer)) B2M_map.addLayer(regionLayer);
        if (!on && B2M_map.hasLayer(regionLayer)) B2M_map.removeLayer(regionLayer);
      };
      B2M_map.on("zoomend", toggleRegions);
    }

    // ---- Load + count data ----
    try {
      const rows = await loadIncidentRows();
      LOG("CSV/XLSX rows:", Array.isArray(rows) ? rows.length : 0);
      await countFromData(rows);
      applyCountsToRegions();
      applyCountsToStates();
    } catch (e) {
      console.error("[B2M] Data load/count failed:", e);
      banner("Error counting CSV rows");
    }

    setTimeout(() => B2M_map.invalidateSize(), 100);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
