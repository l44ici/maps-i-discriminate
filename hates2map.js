/* ===== Back2Maps — states + regional divisions only ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  const stateStyle    = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const divisionBase  = { weight: 1, color: "#2b2b2b", fillOpacity: 0.45 };
  const divisionHover = { weight: 3, color: "#666",    fillOpacity: 0.65 };
  const stateHover    = { weight: 3, color: "#111827", fillOpacity: 0.10 };

  // Property helpers (tolerant)
  const getDivisionCode = p => p?.division_code || p?.division || p?.code || p?.name || p?.DIVISION || p?.REGION || p?.id;
  const getDivisionName = p => p?.division_name || getDivisionCode(p) || "Region";
  const getStateName    = p => p?.state || p?.STATE || p?.STATE_NAME || p?.ste_name || "";

  document.addEventListener("DOMContentLoaded", async () => {
    const root = document.querySelector(".back2maps");
    if (!root) return;

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

    // Panes for stacking
    map.createPane('pane-states');    map.getPane('pane-states').style.zIndex = 400;
    map.createPane('pane-divisions'); map.getPane('pane-divisions').style.zIndex = 405;

    let stateLayer, divisionsLayer;

    // STATES (background)
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r=>r.json());
      function stateOver(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function stateOut (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }
      stateLayer = L.geoJSON(states, {
        pane: 'pane-states',
        style: () => stateStyle,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton: false, autoPan: false });
          l.on({ mouseover: stateOver, mouseout: stateOut });
        }
      }).addTo(map);
    } catch(e){ console.warn("States load failed", e); }

    // REGIONAL DIVISIONS (foreground)
    const divisions = await fetch(B2M.divisionsGeoJSON, { cache: "no-store" }).then(r=>r.json()).catch(()=>null);
    if (!divisions?.features?.length) {
      console.error("[B2M] regional divisions missing/empty:", B2M?.divisionsGeoJSON);
      return;
    }

    function onEachDivision(f, l){
      const code = String(getDivisionCode(f.properties) || "");
      const name = getDivisionName(f.properties);
      const state= getStateName(f.properties);

      l.bindPopup(`<strong>${name}</strong>${state?`<div>${state}</div>`:''}`, { closeButton:false, autoPan:false });
      l.bindTooltip(name, { sticky:true, direction:'center', opacity:0.85 });

      l.on({
        mouseover: e => { e.target.setStyle(divisionHover); e.target.openPopup(); L.DomEvent.stopPropagation(e); },
        mouseout : e => { divisionsLayer.resetStyle(e.target); e.target.closePopup(); L.DomEvent.stopPropagation(e); },
        click    : () => { map.fitBounds(l.getBounds(), { padding:[16,16], maxZoom: 9 }); l.openPopup(); }
      });
    }

    divisionsLayer = L.geoJSON(divisions, {
      pane: 'pane-divisions',
      style: () => divisionBase,
      onEachFeature: onEachDivision
    }).addTo(map);

    map.on('popupclose', () => {
      if (divisionsLayer) divisionsLayer.setStyle(() => divisionBase);
      if (stateLayer)     stateLayer.setStyle(() => stateStyle);
    });
  });

})();
