/* ===== Back2Maps — State hover; divisions visible only when zoomed ===== */
(() => {
  "use strict";

  // ---- Settings ----------------------------------------------------------
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const SHOW_DIV_ZOOM = 5.5;   // divisions appear at/above this zoom level

  // Styles
  const stateBase  = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const stateHover = { weight: 3, color: "#111827", fillOpacity: 0.10 };

  // Hidden style (zoomed out)
  const divHidden  = { weight: 0, color: '#000000', opacity: 0, fillOpacity: 0 };

  // Shown style (zoomed in)
  const divShown   = {
    weight: 2,              // thicker border
    color: '#000000',       // solid black border
    opacity: 0.8,           // strong line visibility
    fillOpacity: 0          // no fill (transparent inside)
  };


  // ---- Boot --------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  async function init () {
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

    // Panes: divisions must be ABOVE states to be visible,
    // but set interactive:false so state hover still receives events.
    map.createPane("pane-states");    map.getPane("pane-states").style.zIndex = 400;
    map.createPane("pane-divisions"); map.getPane("pane-divisions").style.zIndex = 405;

    // ---- States (hover + popup + click-to-zoom) -------------------------
    let stateLayer;
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r => r.json());

      function onOver (e) { const l = e.target; l.setStyle(stateHover); l.openPopup(); }
      function onOut  (e) { const l = e.target; stateLayer.resetStyle(l); l.closePopup(); }
      function onClick(e) { map.fitBounds(e.target.getBounds(), { padding: [16,16], maxZoom: 7.5 }); }

      stateLayer = L.geoJSON(states, {
        pane: "pane-states",
        style: () => stateBase,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton: false, autoPan: false });
          l.on({ mouseover: onOver, mouseout: onOut, click: onClick });
        }
      }).addTo(map);
    } catch (err) {
      console.warn("[B2M] Failed to load states:", err);
    }

    // ---- Regional divisions (non-interactive; show when zoomed) ---------
    const divisions = await loadDivisions(B2M.divisionsGeoJSON);
    if (divisions) {
      const divisionsLayer = L.geoJSON(divisions, {
        pane: "pane-divisions",
        filter: f => ["Polygon","MultiPolygon"].includes(f?.geometry?.type),
        style: () => divHidden,
        interactive: false,      // important: so state hover still works
        pointToLayer: () => null // ignore any stray points
      }).addTo(map);

      const refreshDivisions = () => {
        const show = map.getZoom() >= SHOW_DIV_ZOOM;
        divisionsLayer.setStyle(() => show ? divShown : divHidden);
      };
      map.on("zoomend", refreshDivisions);
      refreshDivisions();
    }
  }

  // ---- Helpers -----------------------------------------------------------
  async function loadDivisions (url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();

      // Case 1: GeoJSON FeatureCollection
      if (raw?.type === "FeatureCollection" && Array.isArray(raw.features)) {
        return raw;
      }

      // Case 2: TopoJSON -> convert to GeoJSON (first object)
      if (raw?.type === "Topology" && window.topojson) {
        const names = Object.keys(raw.objects || {});
        if (!names.length) return null;
        const fc = topojson.feature(raw, raw.objects[names[0]]);
        return (fc.type === "FeatureCollection") ? fc : { type: "FeatureCollection", features: [fc] };
      }

      // Case 3: object with features but missing type
      if (Array.isArray(raw?.features)) {
        return { type: "FeatureCollection", features: raw.features };
      }

      note("Regional divisions file could not be read (expect GeoJSON polygons or TopoJSON).");
      console.warn("[B2M] Unexpected divisions JSON:", raw);
      return null;
    } catch (e) {
      note("Failed to load regional divisions.");
      console.error("[B2M] divisions load failed:", e);
      return null;
    }
  }

  function note (msg) {
    const box = document.createElement("div");
    box.className = "b2m-info";
    box.style.marginTop = "8px";
    box.textContent = msg;
    const card = document.querySelector(".b2m-card");
    if (card) card.appendChild(box);
  }
})();
