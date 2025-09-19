/* ===== Back2Maps — state hover; divisions visible only when zoomed ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 6;        // <-- divisions appear at/above this zoom

  // Styles
  const stateBase  = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const stateHover = { weight: 3, color: "#111827", fillOpacity: 0.10 };

  // Basic division style (no interactivity)
  const divStyleHidden = { weight: 1, color: "#2b2b2b", opacity: 0, fillOpacity: 0 };
  const divStyleShown  = { weight: 1, color: "#2b2b2b", opacity: 1, fillOpacity: 0.35 };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    const root = document.querySelector(".back2maps");
    if (!root) return;

    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
      </div>
    `;

    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Layer order: states above divisions so state hover always works
    map.createPane('pane-divisions'); map.getPane('pane-divisions').style.zIndex = 395;
    map.createPane('pane-states');    map.getPane('pane-states').style.zIndex    = 400;

    /* ---- States (hover + popup + click to zoom a bit) ---- */
    let stateLayer;
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r => r.json());

      function over(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function out (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      function click(e){ map.fitBounds(e.target.getBounds(), { padding:[16,16], maxZoom: 7.5 }); }

      stateLayer = L.geoJSON(states, {
        pane: 'pane-states',
        style: () => stateBase,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton:false, autoPan:false });
          l.on({ mouseover: over, mouseout: out, click });
        }
      }).addTo(map);
    } catch (e) {
      console.warn("[B2M] states load failed:", e);
    }

    /* ---- Regional divisions (non-interactive; visible only when zoomed) ---- */
    const divisions = await loadDivisions(B2M.divisionsGeoJSON);
    if (!divisions) return;

    const divisionsLayer = L.geoJSON(divisions, {
      pane: 'pane-divisions',
      filter: f => ['Polygon','MultiPolygon'].includes(f?.geometry?.type),
      style: () => divStyleHidden,
      interactive: false,          // <- no hover/click; passes events to states
      pointToLayer: () => null     // safety: ignore any stray points
    }).addTo(map);

    // Toggle visibility based on zoom
    function refreshDivisions() {
      const show = map.getZoom() >= SHOW_DIV_ZOOM;
      divisionsLayer.setStyle(() => show ? divStyleShown : divStyleHidden);
    }
    map.on('zoomend', refreshDivisions);
    refreshDivisions(); // set initial state
  }

  // Robust loader (GeoJSON or TopoJSON)
  async function loadDivisions(url){
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();

      // GeoJSON FeatureCollection
      if (raw?.type === 'FeatureCollection' && Array.isArray(raw.features)) return raw;

      // TopoJSON -> GeoJSON
      if (raw?.type === 'Topology' && window.topojson) {
        const names = Object.keys(raw.objects || {});
        if (!names.length) return null;
        const fc = topojson.feature(raw, raw.objects[names[0]]);
        return fc.type === 'FeatureCollection' ? fc : { type:'FeatureCollection', features:[fc] };
      }

      // Fallback: object with features
      if (Array.isArray(raw?.features)) return { type:'FeatureCollection', features: raw.features };

      console.warn('[B2M] Unexpected divisions JSON format', raw);
      return null;
    } catch (e) {
      console.error('[B2M] divisions load failed:', e);
      return null;
    }
  }
})();
