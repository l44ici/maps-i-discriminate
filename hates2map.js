/* ===== Back2Maps — regions + CSV choropleth + markers (TopoJSON/GeoJSON safe) ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // Choropleth colors
  function getColor(d) {
    return d > 40 ? "#7f0000" :
           d > 30 ? "#b30000" :
           d > 20 ? "#d7301f" :
           d > 10 ? "#ef6548" :
           d >  5 ? "#fdbb84" :
           d >  0 ? "#fee8c8" : "#f7f7f7";
  }

  // forgiving header picks
  const pick = (row, keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
        return String(row[k]).trim();
      }
    }
    return undefined;
  };
  const getLat    = r => parseFloat(pick(r, ["lat","Lat","LAT","latitude","Latitude"]));
  const getLon    = r => parseFloat(pick(r, ["lon","Lon","LON","lng","Lng","LNG","longitude","Longitude"]));
  const getState  = r => pick(r, ["State / Territory","State","state","STATE","Territory"]);
  const getPC     = r => { const v = pick(r, ["Post Code","postcode","Postcode","PC","Pcode","Zip"]); return v ? String(v).replace(/\D/g,"").padStart(4,"0") : undefined; };
  const getSuburb = r => pick(r, ["Suburb","suburb","Town","Locality","City"]);

  // region id selection
  const regionIdOf = feat => {
    const p = (feat && feat.properties) || {};
    return p.division_code || p.region_id || p.REGION_ID || p.code || p.id || p.name;
  };

  // styles
  const styleForCount = c => ({
    weight: 1,
    color: "#71797E",
    fillOpacity: 0.65,
    fillColor: getColor(c || 0)
  });

  // optional suburb/postcode index
  let suburbIndex = null; // Map key "STATE|SUBURB|POSTCODE" -> [lon,lat]
  function buildSuburbIndex(geojson) {
    const map = new Map();
    if (!geojson || !geojson.features) return map;
    for (const f of geojson.features) {
      if (!f || !f.geometry || f.geometry.type !== "Point") continue;
      const [lon, lat] = f.geometry.coordinates || [];
      const p = f.properties || {};
      const s = String(p.state || p.State || "").toUpperCase();
      const sub = String(p.suburb || p.Suburb || p.locality || "").toUpperCase();
      const pc = String(p.postcode || p.Postcode || p.pc || "").replace(/\D/g,"");
      const keys = new Set();
      if (s || sub || pc) {
        keys.add([s, sub, pc].join("|"));
        keys.add([s, sub, "" ].join("|"));
        keys.add([ "", sub, pc].join("|"));
      }
      for (const k of keys) if (k.replaceAll("|","") !== "") map.set(k, [lon, lat]);
    }
    return map;
  }
  function lookupCoords(state, suburb, pc) {
    if (!suburbIndex) return null;
    const s = String(state||"").toUpperCase();
    const sub = String(suburb||"").toUpperCase();
    const p = (pc||"").replace(/\D/g,"");
    const keys = [
      [s, sub, p].join("|"),
      [s, sub, ""].join("|"),
      ["", sub, p].join("|")
    ];
    for (const k of keys) if (suburbIndex.has(k)) return suburbIndex.get(k);
    return null;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Map
    const map = L.map("b2m-map", { preferCanvas: true, worldCopyJump: true });
    map.fitBounds(AU_BOUNDS);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 18
    }).addTo(map);

    // Panes
    map.createPane("divisions"); map.getPane("divisions").style.zIndex = 410;
    map.createPane("markers");   map.getPane("markers").style.zIndex = 420;

    // Layers & state
    let divisionsFC = { type: "FeatureCollection", features: [] };
    let divisionsLayer = null;
    let markers = L.layerGroup([], { pane: "markers" }).addTo(map);
    const counts = new Map();
    const bbox = L.latLngBounds();

    // Fetch helpers
    async function fetchJSON(url) {
      const r = await fetch(url, { cache: "no-cache", credentials: "omit" });
      if (!r.ok) throw new Error(`Failed fetch: ${url}`);
      return await r.json();
    }
    async function fetchText(url) {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`Failed fetch: ${url}`);
      return await r.text();
    }

    // Load divisions (TopoJSON or GeoJSON)
    try {
      const raw = await fetchJSON(B2M.divisionsUrl);
      if (raw && raw.type === "Topology") {
        const objName = (B2M.divObject || "").trim() || Object.keys(raw.objects || {})[0];
        if (!objName) throw new Error("No objects found in Topology");
        divisionsFC = topojson.feature(raw, raw.objects[objName]);
      } else {
        divisionsFC = raw;
      }
      if (!divisionsFC || !Array.isArray(divisionsFC.features)) {
        throw new Error("Divisions file has no features");
      }
    } catch (e) {
      console.error("Failed to load divisions", e);
      divisionsFC = { type: "FeatureCollection", features: [] };
    }

    // Optional suburbs lookup
    try {
      const subs = await fetchJSON(B2M.suburbLookup);
      suburbIndex = buildSuburbIndex(subs);
    } catch {
      suburbIndex = null; // fine if not provided
    }

    // Render regions (always visible)
    divisionsLayer = L.geoJSON(divisionsFC, {
      pane: "divisions",
      style: f => styleForCount(0),
      onEachFeature: (feature, layer) => {
        const id = regionIdOf(feature) || "(unknown)";
        layer.on({
          mouseover: () => layer.setStyle({ weight: 2, color: "#71797E", fillOpacity: 0.75, fillColor: getColor(counts.get(id)||0) }),
          mouseout:  () => layer.setStyle(styleForCount(counts.get(id) || 0)),
          click:     () => {
            const c = counts.get(id) || 0;
            layer.bindTooltip(`<strong>${id}</strong><br/>${fmt(c)} report(s)`).openTooltip();
          }
        });
      }
    }).addTo(map);

    // CSV loader
    async function loadCSV(url) {
      const text = await fetchText(url);
      return await new Promise((resolve, reject) => {
        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: h => String(h).trim(),
          complete: res => resolve(res.data || []),
          error: err => reject(err)
        });
      });
    }

    // Paint helpers
    function addPoint(lat, lon, props) {
      const m = L.circleMarker([lat, lon], {
        radius: 5,
        weight: 1,
        color: "#5b6b75",
        fillOpacity: 0.85,
        fillColor: "#1f78b4"
      }).bindTooltip(() => {
        const lines = [];
        if (props.suburb) lines.push(`<strong>${props.suburb}</strong>`);
        if (props.state || props.postcode) lines.push([props.state, props.postcode].filter(Boolean).join(" "));
        return lines.join("<br/>") || "Report";
      });
      m.addTo(markers);
      bbox.extend([lat, lon]);
    }

    function bumpRegionCount(lat, lon) {
      const pt = turf.point([lon, lat]);
      for (const f of divisionsFC.features) {
        try {
          if (turf.booleanPointInPolygon(pt, f)) {
            const id = regionIdOf(f) || "(unknown)";
            counts.set(id, (counts.get(id) || 0) + 1);
            return true;
          }
        } catch { /* skip malformed */ }
      }
      counts.set("(unassigned)", (counts.get("(unassigned)") || 0) + 1);
      return false;
    }

    function repaintRegions() {
      divisionsLayer.setStyle(f => styleForCount(counts.get(regionIdOf(f)) || 0));
    }

    // Load CSV and render
    let rows = [];
    try { rows = await loadCSV(B2M.cioData); }
    catch (e) { console.error("Failed to load CSV", e); rows = []; }

    for (const r of rows) {
      let lat = getLat(r);
      let lon = getLon(r);
      const state  = getState(r);
      const suburb = getSuburb(r);
      const pc     = getPC(r);

      // fallback geocode
      if ((Number.isNaN(lat) || Number.isNaN(lon) || lat === undefined || lon === undefined) && suburbIndex) {
        const hit = lookupCoords(state, suburb, pc);
        if (hit && hit.length === 2) { lon = parseFloat(hit[0]); lat = parseFloat(hit[1]); }
      }

      if (Number.isNaN(lat) || Number.isNaN(lon) || lat === undefined || lon === undefined) continue;

      bumpRegionCount(lat, lon);
      addPoint(lat, lon, { state, suburb, postcode: pc });
    }

    repaintRegions();

    // Fit view
    if (bbox.isValid()) map.fitBounds(bbox.pad(0.15));
    else               map.fitBounds(AU_BOUNDS);

    // Keep regions visible regardless of zoom (use minZoomForDiv if you want to hide)
    const SHOW_DIV_ZOOM = Number(B2M.minZoomForDiv || 0);
    function updateDivVisibility() {
      if (map.getZoom() >= SHOW_DIV_ZOOM) {
        divisionsLayer.setStyle(f => styleForCount(counts.get(regionIdOf(f)) || 0));
      } else {
        // even below threshold, keep them visible (lighter)
        divisionsLayer.setStyle(f => styleForCount(counts.get(regionIdOf(f)) || 0));
      }
    }
    map.on("zoomend", updateDivVisibility);
    updateDivVisibility();

    setTimeout(() => map.invalidateSize(), 120);
  });
})();
