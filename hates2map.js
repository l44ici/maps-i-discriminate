/* ===== Back2Maps — regions + CSV choropleth + markers ===== */
(() => {
  "use strict";

  // Map bounds & helpers
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // Choropleth colors (tweak as needed)
  function getColor(d) {
    return d > 40 ? "#7f0000" :
           d > 30 ? "#b30000" :
           d > 20 ? "#d7301f" :
           d > 10 ? "#ef6548" :
           d >  5 ? "#fdbb84" :
           d >  0 ? "#fee8c8" : "#f7f7f7";
  }

  // --- column name normalisation (very forgiving) --------------------------
  const pick = (row, keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") {
        return String(row[k]).trim();
      }
    }
    return undefined;
  };

  // e.g., tries Lat, lat, latitude, Latitude, etc.
  const getLat = r => parseFloat(pick(r, ["lat","Lat","LAT","latitude","Latitude"]));
  const getLon = r => parseFloat(pick(r, ["lon","Lon","LON","lng","Lng","LNG","longitude","Longitude"]));
  const getState = r => pick(r, ["State / Territory","State","state","STATE","Territory"]);
  const getPC = r => {
    const v = pick(r, ["Post Code","postcode","Postcode","PC","Pcode","Zip"]);
    return v ? String(v).padStart(4, "0").replace(/\D/g,"") : undefined;
  };
  const getSuburb = r => pick(r, ["Suburb","suburb","Town","Locality","City"]);

  // region id resolver: prefers explicit id/code/name on the feature
  const regionIdOf = (feat) => {
    const p = (feat && feat.properties) || {};
    return p.division_code || p.region_id || p.REGION_ID || p.code || p.id || p.name;
  };

  // region style presets
  const stateBase  = { weight: 1.5, color: "#71797E", fillColor: "#f8fafc", fillOpacity: 0.25 };
  const stateHover = { weight: 2.5, color: "#71797E", fillColor: "#eef2ff", fillOpacity: 0.35 };
  const divHidden  = { weight: 0, color: "#71797E", opacity: 0,   fillOpacity: 0 };
  const divShown   = { weight: 1, color: "#71797E", opacity: 0.9, fillOpacity: 0 };

  // lookup cache for suburb/postcode -> [lon,lat]
  let suburbIndex = null; // Map key: "NSW|HELENSBURGH|2508" or variants

  function buildSuburbIndex(geojson) {
    const map = new Map();
    if (!geojson || !geojson.features) return map;
    for (const f of geojson.features) {
      if (!f || !f.geometry || f.geometry.type !== "Point") continue;
      const coords = f.geometry.coordinates; // [lon, lat]
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
      for (const k of keys) if (k.replaceAll("|","") !== "") map.set(k, coords);
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

    // Panes for layering
    map.createPane("divisions");
    map.getPane("divisions").style.zIndex = 410;
    map.createPane("markers");
    map.getPane("markers").style.zIndex = 420;

    // Layers & state
    let divisionsFC = null;               // GeoJSON FeatureCollection of regions
    let divisionsLayer = null;            // Leaflet layer for regions
    let markers = L.layerGroup([], { pane: "markers" }).addTo(map);
    const counts = new Map();             // regionId -> count
    const bbox = L.latLngBounds();        // for auto-fit if we get points

    // Load divisions
    async function fetchJSON(url) {
      const r = await fetch(url, { credentials: "omit", cache: "no-cache" });
      if (!r.ok) throw new Error("Failed fetch: " + url);
      return await r.json();
    }

    try {
      divisionsFC = await fetchJSON(B2M.divisionsGeoJSON);
    } catch (e) {
      console.error("Failed to load divisions GeoJSON", e);
      divisionsFC = { type: "FeatureCollection", features: [] };
    }

    // Optional suburbs lookup
    try {
      const subs = await fetchJSON(B2M.suburbLookup);
      suburbIndex = buildSuburbIndex(subs);
    } catch {
      suburbIndex = null; // okay if missing; we’ll only plot rows with lat/lon
    }

    // Build region layer
    function styleForCount(c) {
      return {
        weight: 1,
        color: "#71797E",
        fillOpacity: 0.65,
        fillColor: getColor(c || 0)
      };
    }

    divisionsLayer = L.geoJSON(divisionsFC, {
      pane: "divisions",
      style: styleForCount(0),
      onEachFeature: (feature, layer) => {
        const id = regionIdOf(feature) || "(unknown)";
        layer.on({
          mouseover: () => layer.setStyle(stateHover),
          mouseout:  () => layer.setStyle(styleForCount(counts.get(id) || 0)),
          click:     () => {
            const c = counts.get(id) || 0;
            layer.bindTooltip(`<strong>${id}</strong><br/>${fmt(c)} report(s)`).openTooltip();
          }
        });
      }
    }).addTo(map);

    // Parse CSV and paint markers + counts
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

    function bumpRegionCount(lat, lon, fallbackProps = {}) {
      // Find region via PIP
      const pt = turf.point([lon, lat]);
      for (const f of divisionsFC.features) {
        try {
          if (turf.booleanPointInPolygon(pt, f)) {
            const id = regionIdOf(f) || "(unknown)";
            counts.set(id, (counts.get(id) || 0) + 1);
            return true;
          }
        } catch (e) { /* skip malformed */ }
      }
      // No hit — optionally could aggregate to state, but we keep it as "unassigned"
      counts.set("(unassigned)", (counts.get("(unassigned)") || 0) + 1);
      return false;
    }

    function repaintRegions() {
      divisionsLayer.setStyle(f => styleForCount(counts.get(regionIdOf(f)) || 0));
    }

    // Load CSV with PapaParse
    async function loadCSV(url) {
      const r = await fetch(url, { cache: "no-cache" });
      const text = await r.text();
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

    let rows = [];
    try {
      rows = await loadCSV(B2M.cioData);
    } catch (e) {
      console.error("Failed to load CSV", e);
      rows = [];
    }

    // Iterate rows
    for (const r of rows) {
      let lat = getLat(r);
      let lon = getLon(r);
      const state = getState(r);
      const suburb = getSuburb(r);
      const pc = getPC(r);

      // Fallback geocode by suburb/postcode if no explicit coords
      if ((Number.isNaN(lat) || Number.isNaN(lon) || lat === undefined || lon === undefined) && suburbIndex) {
        const hit = lookupCoords(state, suburb, pc);
        if (hit && Array.isArray(hit) && hit.length === 2) {
          lon = parseFloat(hit[0]);
          lat = parseFloat(hit[1]);
        }
      }

      // If still no coords, skip marker but we cannot count it reliably by region
      if (Number.isNaN(lat) || Number.isNaN(lon) || lat === undefined || lon === undefined) {
        continue;
      }

      bumpRegionCount(lat, lon, { state, suburb, postcode: pc });
      addPoint(lat, lon, { state, suburb, postcode: pc });
    }

    repaintRegions();

    // Fit if we got any points
    if (bbox.isValid()) {
      map.fitBounds(bbox.pad(0.15));
    } else {
      map.fitBounds(AU_BOUNDS);
    }

    // Show divisions earlier/later based on zoom preference
    const SHOW_DIV_ZOOM = Number(B2M.minZoomForDiv || 4.3);
    function updateDivVisibility() {
      const style = map.getZoom() >= SHOW_DIV_ZOOM ? divShown : divHidden;
      divisionsLayer.setStyle(f => Object.assign(style, styleForCount(counts.get(regionIdOf(f)) || 0)));
    }
    map.on("zoomend", updateDivVisibility);
    updateDivVisibility();

    // Resize fix (if inside accordions/tabs)
    setTimeout(() => map.invalidateSize(), 120);
  });
})();
