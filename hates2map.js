/* ===== Back2Maps — state hover; divisions (TopoJSON) as borders when zoomed ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 5.5;   // divisions turn on at/above this zoom

  // State styles
  const stateBase  = { weight: 2, color: "#D3D3D3", fillOpacity: 0.05 };
  const stateHover = { weight: 3, color: "#D3D3D3", fillOpacity: 0.10 };

  // Division “border” styles (no fill)
  const divHidden  = { weight: 0, color: "#D3D3D3", opacity: 0,   fillOpacity: 0 };
  const divShown   = { weight: 2, color: "#D3D3D3", opacity: 0.9, fillOpacity: 0 /*, dashArray:"4,3"*/ };

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

    // Put divisions ABOVE states so borders are visible but make them non-interactive
    map.createPane("pane-states");    map.getPane("pane-states").style.zIndex = 400;
    map.createPane("pane-divisions"); map.getPane("pane-divisions").style.zIndex = 405;

    // ----- States: hover + popup + click-to-zoom
    let stateLayer;
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r => r.json());
      function over(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function out (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      function click(e){ map.fitBounds(e.target.getBounds(), { padding:[16,16], maxZoom: 7.5 }); }

      stateLayer = L.geoJSON(states, {
        pane: "pane-states",
        style: () => stateBase,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton:false, autoPan:false });
          l.on({ mouseover: over, mouseout: out, click });
        }
      }).addTo(map);
    } catch (e) { console.warn("[B2M] states load failed:", e); }

    // ----- Regional divisions: TopoJSON/GeoJSON -> non-interactive borders
    const divisions = await loadDivisions(B2M.divisionsGeoJSON, "regional_div"); // <- object name from Mapshaper
    if (divisions) {
      const divisionsLayer = L.geoJSON(divisions, {
        pane: "pane-divisions",
        filter: f => ["Polygon","MultiPolygon"].includes(f?.geometry?.type),
        style: () => divHidden,
        interactive: false,         // let state layer handle hover/click
        pointToLayer: () => null
      }).addTo(map);

      const refresh = () => {
        const show = map.getZoom() >= SHOW_DIV_ZOOM;
        divisionsLayer.setStyle(() => show ? divShown : divHidden);
      };
      map.on("zoomend", refresh);
      refresh();
    }
  }

  // Robust loader: GeoJSON, TopoJSON (with preferred object name), or raw features[]
  async function loadDivisions(url, topoObjectName) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();

      // A) GeoJSON FeatureCollection
      if (raw?.type === "FeatureCollection" && Array.isArray(raw.features)) return raw;

      // B) TopoJSON -> choose named object if present, else first
      if (raw?.type === "Topology" && window.topojson) {
        const objs = raw.objects || {};
        const key  = topoObjectName && objs[topoObjectName] ? topoObjectName : Object.keys(objs)[0];
        if (!key) return null;
        const fc = topojson.feature(raw, objs[key]);
        return (fc.type === "FeatureCollection") ? fc : { type: "FeatureCollection", features: [fc] };
      }

      // C) Raw array of Features
      if (Array.isArray(raw)) return { type: "FeatureCollection", features: raw };
      if (Array.isArray(raw?.features)) return { type: "FeatureCollection", features: raw.features };

      console.warn("[B2M] Unexpected divisions JSON format", raw);
      return null;
    } catch (e) {
      console.error("[B2M] divisions load failed:", e);
      return null;
    }
  }
})();
