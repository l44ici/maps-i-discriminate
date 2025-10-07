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
  const ROOT_ID = "b2m-map";
  const WRAP = document.querySelector(".back2maps");
  const DIV_ZOOM = +(WRAP?.dataset?.divzoom || CFG.minZoomForDiv || 6);

  // URLs from PHP
  const REGIONS_URL = CFG.divisionsUrl || "regional_div.json";
  const REGIONS_OBJ = CFG.divObject || "regional_div";
  const STATES_URL  = CFG.statesUrl    || "australian-states.min.geojson";
  const SUBURBS_URL = CFG.suburbLookup || "suburbs.json";   // <-- your gazetteer
  const CSV_URL     = CFG.cioDataCsv   || "testData.csv";
  const XLSX_URL    = CFG.cioDataXlsx  || "testData.xlsx";
  const PCINDEX_URL = CFG.pcIndexUrl   || "";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // ---- diagnostics helpers ----
  const LOG = (...a) => console.log("[B2M]", ...a);
  function banner(msg, color = "#7c3aed") {
    try {
      const el = document.createElement("div");
      el.style.cssText = [
        "position: absolute","z-index: 9999","top: 8px","right: 8px",
        "background: #fff","border: 2px solid "+color,"color: "+color,
        "padding: 6px 10px","border-radius: 10px",
        "box-shadow: 0 2px 8px rgba(0,0,0,.08)","font: 12px/1.3 system-ui"
      ].join(";");
      el.textContent = msg;
      (document.getElementById(ROOT_ID) || document.body).appendChild(el);
      setTimeout(() => el.remove(), 8000);
    } catch (_) {}
  }

  // ------- small helpers -------
  const norm = (s) => (s ?? "").toString().trim();
  const cleanSuburb = (s) => norm(s).replace(/\s+/g," ").toLowerCase();
  const STS = new Set(["NSW","ACT","VIC","QLD","SA","WA","TAS","NT"]);
  const asState = (s) => { const x = norm(s).toUpperCase(); return STS.has(x) ? x : ""; };
  const asPostcode = (s) => {
    if (s === null || s === undefined || s === "") return "";
    let x = typeof s === "number" ? String(s) : norm(String(s));
    x = x.replace(/\s+/g,"");
    if (/^\d{1,4}$/.test(x)) x = x.padStart(4,"0");
    return /^\d{4}$/.test(x) ? x : "";
  };

  const fetchText = (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : ""));
  const fetchJSON = (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fetchexists = (url) => url ? fetch(url, { method: "HEAD", cache: "no-cache" }).then((r) => r.ok) : Promise.resolve(false);

  // CSV parser
  function parseCSV(text) {
    const out = []; let i = 0, cell = "", row = [], q = false;
    const pushCell = () => { row.push(cell); cell = ""; };
    const pushRow  = () => { row.push(cell); out.push(row); row = []; cell = ""; };
    while (i < text.length) {
      const c = text[i++]; if (q) { if (c === '"') { if (text[i] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
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
  let statesFC = null, regionsFC = null;

  // suburb gazetteer: Map keys for fast lookups
  // key forms we support (all lowercased):
  //   "ST|suburb|PC", "ST|suburb", "suburb|PC", "suburb"
  const suburbGaz = new Map();

  let pcIndex = null;

  // public counters
  window.B2M_countsDivision = window.B2M_countsDivision || new Map();
  window.B2M_countsState = window.B2M_countsState || new Map();
  const bumpDiv = (id) => { if (!id) return; window.B2M_countsDivision.set(id, (window.B2M_countsDivision.get(id) || 0) + 1); };
  const bumpSt  = (st) => { if (!st) return; window.B2M_countsState.set(st, (window.B2M_countsState.get(st) || 0) + 1); };

  function postcodeToDivision(pc) {
    if (pcIndex && pcIndex[pc]) return pcIndex[pc];
    return null;
  }

  function addGazRecord(rec) {
    if (!rec) return;
    const st = asState(rec.state);
    const sub = cleanSuburb(rec.suburb);
    const pc = asPostcode(rec.postcode);
    const lat = Number(rec.lat), ln = Number(rec.lng ?? rec.lon);
    if (!sub || !st || !Number.isFinite(lat) || !Number.isFinite(ln)) return;

    const val = { lat, lon: ln, st, pc };
    const keys = new Set([
      `${st}|${sub}|${pc}`,
      `${st}|${sub}`,
      `${sub}|${pc}`,
      `${sub}`
    ]);
    keys.forEach(k => suburbGaz.has(k) ? null : suburbGaz.set(k, val));
  }

  function loadGazetteer(raw) {
    const arr = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : null);
    if (!arr) return false;
    arr.forEach(addGazRecord);
    return suburbGaz.size > 0;
  }

  function lookUpSuburb(state, suburb, pc) {
    const st = asState(state);
    const s  = cleanSuburb(suburb);
    const p  = asPostcode(pc);
    if (!s) return null;
    const tries = [
      `${st}|${s}|${p}`,
      `${st}|${s}`,
      `${s}|${p}`,
      `${s}`,
    ];
    for (const k of tries) {
      const v = suburbGaz.get(k);
      if (v) return v;
    }
    return null;
  }

  function latLonToDivision(lat, lon) {
    if (!regionsFC || !Array.isArray(regionsFC.features)) return null;
    const pt = [lon, lat];
    for (const f of regionsFC.features) {
      const g = f.geometry; if (!g) continue;
      const id = f.properties?._b2m_id || f.properties?.id || f.properties?.code || f.properties?.name || null;
      if (g.type === "Polygon" && pointInPolygon(pt, g)) return id;
      if (g.type === "MultiPolygon" && g.coordinates.some((poly) => pointInPolygon(pt, { type: "Polygon", coordinates: poly }))) return id;
    }
    return null;
  }

  // ---- Load incidents ----
  async function loadIncidentRows() {
    const csvText = await fetchText(CSV_URL);
    if (csvText && csvText.trim()) return rowsToObjects(parseCSV(csvText));
    if (await fetchexists(XLSX_URL) && window.XLSX) {
      const ab = await fetch(XLSX_URL).then((r) => (r.ok ? r.arrayBuffer() : null));
      if (!ab) return [];
      const wb = XLSX.read(ab, { type: "array" });
      const first = wb.SheetNames[0];
      return XLSX.utils.sheet_to_json(wb.Sheets[first], { defval: "" });
    }
    return [];
  }

  function rowsToObjects(rows) {
    if (!rows || !rows.length) return [];
    const hdr = rows[0].map((h) => norm(h));
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r.length) continue;
      const o = {};
      for (let c = 0; c < r.length; c++) o[hdr[c] || `col${c}`] = r[c];
      out.push(o);
    }
    return out;
  }

  async function countFromData(objs) {
    window.B2M_countsDivision.clear();
    window.B2M_countsState.clear();

    let viaPc = 0, viaLatLon = 0, viaGaz = 0, viaState = 0;

    const get = (o, names) => { for (const n of names) if (o[n] !== undefined) return o[n]; return ""; };

    for (const o of objs) {
      const suburb = get(o, ["Suburb","suburb","Town","City","Locality","Locality/Town/Suburb"]);
      const state  = get(o, ["State / Territory","State","state","Territory"]);
      const pc     = get(o, ["Post Code","postcode","Postcode","Zip","PC"]);
      const lat    = +get(o, ["Lat","Latitude","lat","latitude"]);
      const lon    = +get(o, ["Lon","Lng","Longitude","lon","lng","longitude"]);

      // 1) postcode → division
      const pc4 = asPostcode(pc);
      if (pc4) {
        const divId = postcodeToDivision(pc4);
        if (divId) { bumpDiv(divId); viaPc++; continue; }
      }

      // 2) direct lat/lon → division (rare for your data, but harmless)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const divId = latLonToDivision(lat, lon);
        if (divId) { bumpDiv(divId); viaLatLon++; continue; }
        const st = asState(state); if (st) { bumpSt(st); viaState++; continue; }
        continue;
      }

      // 3) gazetteer (suburb.json) → lat/lon → division
      if (suburb && state) {
        const pos = lookUpSuburb(state, suburb, pc4);
        if (pos) {
          const divId = latLonToDivision(pos.lat, pos.lon);
          if (divId) { bumpDiv(divId); viaGaz++; continue; }
          // If a suburb resolves but doesn’t sit in our polygons, count to state
          bumpSt(pos.st); viaState++; continue;
        }
      }

      // 4) state-only fallback
      const stOnly = asState(state);
      if (stOnly) { bumpSt(stOnly); viaState++; continue; }
    }

    LOG(`Counts by method — postcode:${viaPc}, lat/lon:${viaLatLon}, gazetteer:${viaGaz}, stateOnly:${viaState}, total:${objs.length}`);
  }

  function applyCountsToRegions() {
    if (!regionLayer) return;
    regionLayer.eachLayer((l) => {
      const p = (l.feature && l.feature.properties) || {};
      const id = p._b2m_id || p.id || p.code || p.name;
      const n = window.B2M_countsDivision.get(id) || 0;
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
      fetchexists(SUBURBS_URL).then((ok) => (ok ? fetchJSON(SUBURBS_URL) : null)),
      fetchexists(PCINDEX_URL).then((ok) => (ok ? fetchJSON(PCINDEX_URL) : null)),
    ]);

    // Normalize
    statesFC = states && states.type ? states : null;
    regionsFC = null;
    if (regions) {
      if (regions.type === "Topology") regionsFC = topoToGeo(regions, REGIONS_OBJ);
      else if (regions.type === "FeatureCollection") regionsFC = regions;
    }

    // Ensure region ids/names
    if (regionsFC?.features?.length) {
      regionsFC.features.forEach((f, i) => {
        const p = f.properties || (f.properties = {});
        p._b2m_id = p.id || p.code || p.name || `R${i + 1}`;
        if (!p.name) p.name = `Region ${i + 1}`;
      });
    }

    const gazOK = suburbs ? loadGazetteer(suburbs) : false;
    pcIndex = pcidx && typeof pcidx === "object" ? pcidx : null;

    LOG("URLs:", { STATES_URL, REGIONS_URL, CSV_URL, SUBURBS_URL });
    LOG("States FC:", statesFC ? "ok" : "missing");
    LOG("Regions FC:", regionsFC ? `ok (features=${regionsFC.features?.length || 0})` : "missing");
    LOG("Suburb gazetteer:", gazOK ? `ok (records=${suburbGaz.size})` : "missing");
    LOG("External PC index:", pcIndex ? "ok" : "missing");

    if (!gazOK && !pcIndex) {
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

    if (regionsFC?.features?.length) {
      regionLayer = L.geoJSON(regionsFC, {
        style: styleRegion,
        onEachFeature: (feat, layer) => {
          const p = feat.properties || {};
          const id = p._b2m_id || p.id || p.code || p.name;
          const n = window.B2M_countsDivision.get(id) || 0;
          const st = p.state || p.ST || p.st || "—";
          layer.bindPopup(`<strong>${p.name || id || "(unknown)"}<\/strong><br>State: ${st}<br>${n} report(s)`);
        },
      });
      B2M_map.addLayer(regionLayer);
      const toggleRegions = () => {
        const on = B2M_map.getZoom() >= DIV_ZOOM;
        if (on && !B2M_map.hasLayer(regionLayer)) B2M_map.addLayer(regionLayer);
        if (!on && B2M_map.hasLayer(regionLayer)) B2M_map.removeLayer(regionLayer);
      };
      B2M_map.on("zoomend", toggleRegions);
    }

    // ---- Load and count data ----
    try {
      const rows = await loadIncidentRows();
      LOG("CSV/XLSX rows:", Array.isArray(rows) ? rows.length : 0);
      if (!rows?.length) banner("No rows loaded from CSV/XLSX", "#b91c1c");
      await countFromData(rows);
      applyCountsToRegions();
      applyCountsToStates();
    } catch (e) {
      console.error("[B2M] Data load/count failed:", e);
      banner("Error counting CSV rows", "#b91c1c");
    }

    setTimeout(() => B2M_map.invalidateSize(), 100);
  }

  document.addEventListener("DOMContentLoaded", buildMap);
})();
