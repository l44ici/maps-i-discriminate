/* ===== Back2Maps — states + regional divisions (polygons only) ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // Styles
  const stateStyle    = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const stateHover    = { weight: 3, color: "#111827", fillOpacity: 0.10 };
  const divisionBase  = { weight: 1, color: "#2b2b2b", fillOpacity: 0.45 };
  const divisionHover = { weight: 3, color: "#666",    fillOpacity: 0.65 };

  // Property helpers (tolerant to different keys)
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

    // Panes for stacking (divisions above states)
    map.createPane('pane-states');    map.getPane('pane-states').style.zIndex = 400;
    map.createPane('pane-divisions'); map.getPane('pane-divisions').style.zIndex = 405;

    let stateLayer, divisionsLayer;

    // ----- STATES (background) with hover popup -----
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
    } catch (e) {
      console.warn("[B2M] statesGeoJSON load failed:", e);
    }

    // ----- REGIONAL DIVISIONS (foreground) — polygons only -----
    const divisions = await loadDivisions(B2M.divisionsGeoJSON);
    if (!divisions) {
      console.error("[B2M] regional divisions missing/invalid:", B2M?.divisionsGeoJSON);
      return; // keep states only
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
      // draw ONLY Polygon / MultiPolygon
      filter: f => ['Polygon','MultiPolygon'].includes(f?.geometry?.type),
      style: () => divisionBase,
      onEachFeature: onEachDivision,
      // safety: if points are present, do not render them as markers
      pointToLayer: () => null
    }).addTo(map);

    // Tidy up styles after closing any popup
    map.on('popupclose', () => {
      if (divisionsLayer) divisionsLayer.setStyle(() => divisionBase);
      if (stateLayer)     stateLayer.setStyle(() => stateStyle);
    });
  });

  // ---- helpers ----
  async function loadDivisions(url){
    const note = (msg) => {
      const box = document.createElement('div');
      box.className = 'b2m-info';
      box.style.marginTop = '8px';
      box.textContent = msg;
      const card = document.querySelector('.b2m-card');
      if (card) card.appendChild(box);
    };

    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gj = await res.json();
      if (!gj?.features?.length) { note('Regional divisions file has no features.'); return null; }

      // quick geometry type histogram for debugging
      const hist = gj.features.reduce((acc, f) => {
        const t = f?.geometry?.type || 'NULL';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {});
      console.log('[B2M] divisions geometry types:', hist);

      const polyCount = (hist.Polygon || 0) + (hist.MultiPolygon || 0);
      const pointCount = (hist.Point || 0) + (hist.MultiPoint || 0);

      // If there are only points, warn and return null so we don't draw pins
      if (polyCount === 0 && pointCount > 0) {
        note('Your regional divisions file contains points (centroids). Replace it with polygon boundaries (Polygon/MultiPolygon).');
        return null;
      }
      return gj;
    } catch (e) {
      console.error('[B2M] Failed to load divisions:', url, e);
      return null;
    }
  }

})();
