/* ===== Back2Maps — state + division hover popups ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // Base styles
  const stateStyle    = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const divisionStyle = { weight: 1, color: "#2b2b2b", fillOpacity: 0.25 };
  const divisionHover = { weight: 3, color: "#666",    fillOpacity: 0.55 };
  const stateHover    = { weight: 3, color: "#111827", fillOpacity: 0.10 };

  // Property helpers (tolerant to different schemas)
  const getName  = p => p?.division_name || p?.region_name || p?.name || p?.STATE_NAME || "Region";
  const getState = p => p?.state || p?.STATE || p?.STATE_NAME || p?.ste_name || "";
  const getId    = p => p?.division_id || p?.region_id || p?.id || getName(p);

  // Build DOM
  document.addEventListener("DOMContentLoaded", async () => {
    const root = document.querySelector(".back2maps");
    if (!root) return;

    // Keep your existing card skeleton (from your CSS):contentReference[oaicite:3]{index=3}
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
      </div>
    `;

    // Map
    const map = L.map("b2m-map", { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // --- Panes so divisions sit above states and receive events first
    map.createPane('pane-states');
    map.getPane('pane-states').style.zIndex = 400;     // below divisions
    map.createPane('pane-divisions');
    map.getPane('pane-divisions').style.zIndex = 405;  // above states

    let stateLayer, divisionsLayer;

    // ---- STATES (background) with hover + popup-on-hover
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r=>r.json());

      function stateOver(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function stateOut (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }

      stateLayer = L.geoJSON(states, {
        pane: 'pane-states',
        style: () => stateStyle,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton: false, autoPan: false, offset: [0,0] });
          l.on({ mouseover: stateOver, mouseout: stateOut });
        }
      }).addTo(map);
    } catch(e){ console.warn("States load failed", e); }

    // ---- REGIONAL DIVISIONS (interactive) with hover + popup-on-hover + click-to-zoom
    const divisions = await fetch(B2M.divisionsGeoJSON, { cache: "no-store" }).then(r=>r.json()).catch(()=>null);
    if (!divisions?.features?.length) {
      console.error("[B2M] regional divisions missing/empty:", B2M?.divisionsGeoJSON);
      return;
    }

    function divOver(e){
      const l=e.target;
      l.setStyle(divisionHover);
      // bring in front of other divisions for crisp border
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) l.bringToFront();
      l.openPopup();
      // prevent state hover from stealing the event while inside a division
      L.DomEvent.stopPropagation(e);
    }
    function divOut(e){
      const l=e.target;
      divisionsLayer.resetStyle(l);
      l.closePopup();
      L.DomEvent.stopPropagation(e);
    }

    divisionsLayer = L.geoJSON(divisions, {
      pane: 'pane-divisions',
      style: () => divisionStyle,
      onEachFeature: (f, l) => {
        const nm = getName(f.properties);
        const st = getState(f.properties);
        l.bindPopup(`<strong>${nm}</strong>${st?`<div>${st}</div>`:''}`, { closeButton:false, autoPan:false });
        l.bindTooltip(nm, { sticky:true, direction:'center', opacity:0.85 });
        l.on({
          mouseover: divOver,
          mouseout : divOut,
          click    : () => {
            map.fitBounds(l.getBounds(), { padding:[16,16], maxZoom: 9 });
            l.openPopup();
          }
        });
      }
    }).addTo(map);

    // Optional nicety: when any popup closes, reset styles
    map.on('popupclose', () => {
      if (divisionsLayer) divisionsLayer.setStyle(() => divisionStyle);
      if (stateLayer)     stateLayer.setStyle(() => stateStyle);
    });
  });
})();
