/* ===== Back2Maps — streamlined (hover + click polished) ===== */
(() => {
  "use strict";

  /* Config */
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  /* Color scale */
  const getColor = d =>
    d > 40 ? "#7f0000" :
    d > 30 ? "#b30000" :
    d > 20 ? "#d7301f" :
    d > 10 ? "#ef6548" :
    d >  5 ? "#fdbb84" :
    d >  0 ? "#fee8c8" : "#f7f7f7";

  /* Static style (always uses default colour) */
  const styleFor = () => ({
    weight: 1,
    opacity: 1,
    color: "#ffffff",
    dashArray: "",
    fillOpacity: 0.85,
    fillColor: getColor(0)
  });

  /* HTTP helpers */
  async function fetchJSON(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (window.B2M?.nonce) headers["X-WP-Nonce"] = B2M.nonce;
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  async function tryLoad(url) {
    if (!url) return null;
    try {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? r.json() : null;
    } catch { return null; }
  }

  /* Safe id/name extraction */
  function getIds(props = {}) {
    const rawId = props.region_id ?? props.STATE_CODE ?? props.state_code ?? props.code ?? props.abbrev ?? props.name;
    const id = rawId != null ? String(rawId) : undefined;
    const name = props.region_name ?? props.STATE_NAME ?? props.name ?? id ?? "Region";
    return { id, name };
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const root = document.querySelector(".back2maps");
    if (!root) return;

    /* Shell */
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
      </div>
    `;

    /* Map */
    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    /* Test points (CSV -> markers) */
    try {
      const td = await fetchJSON(`${B2M.restUrl}/testdata`);
      if (td.rows?.length) {
        td.rows.forEach(r => {
          const lat = parseFloat(r.Latitude);
          const lon = parseFloat(r.Longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const suburb = r.Suburb || "";
            const state  = r["State / Territory"] || "";
            const pc     = r["Post Code"] || "";
            L.circleMarker([lat, lon], {
              radius: 5, fillColor: "#d7301f", color: "#fff", weight: 1, opacity: 1, fillOpacity: 0.8
            }).addTo(map).bindPopup(
              `<b>${suburb}</b> (${state} ${pc})<br/>Lat: ${lat}, Lon: ${lon}`
            );
          }
        });
      }
    } catch (e) {
      console.error("[B2M] /testdata failed:", e);
    }

    /* Regions GeoJSON (just outline, no metrics) */
    const geojson = await tryLoad(B2M?.regionsGeoJSON);
    if (!geojson?.features?.length) {
      console.error("[B2M] regionsGeoJSON missing/empty:", B2M?.regionsGeoJSON);
      return;
    }

    // Keep a reference so we can reset styles cleanly
    let regionsLayer;

    function highlightFeature(e) {
      const layer = e.target;
      layer.setStyle({
        weight: 3,
        color: "#666",          // fixed: valid hex
        dashArray: "",
        fillOpacity: 0.9
      });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
        layer.bringToFront();
      }
    }
    function resetHighlight(e) {
      // Use Leaflet's resetStyle for this layer only
      regionsLayer && regionsLayer.resetStyle(e.target);
    }

    regionsLayer = L.geoJSON(geojson, {
      style: styleFor,
      onEachFeature: (feature, l) => {
        const { name } = getIds(feature.properties);
        l.bindPopup(`<b>${name}</b>`);
        l.on({
          mouseover: highlightFeature,
          mouseout: resetHighlight,
          click: e => {
            const layer = e.target;
            map.fitBounds(layer.getBounds(), { maxZoom: 8, padding: [16,16] });
            // popup will auto-open because we bound one above
          }
        });
      }
    }).addTo(map);

    /* Resize fix */
    setTimeout(() => map.invalidateSize(), 100);

    /* Optional: pointer cursor on polygons */
    const css = document.createElement('style');
    css.textContent = `.leaflet-interactive{cursor:pointer}`;
    document.head.appendChild(css);
  });
})();
