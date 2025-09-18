/* ===== Back2Maps — states + regional divisions (polygons only) ===== */
(() => {
  "use strict";

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];

  // Styles
  const stateBase    = { weight: 2, color: "#4b5563", fillOpacity: 0.05 };
  const stateHover   = { weight: 3, color: "#111827", fillOpacity: 0.10 };
  const divBase      = { weight: 1, color: "#2b2b2b", fillOpacity: 0.45 };
  const divHover     = { weight: 3, color: "#666",    fillOpacity: 0.65 };

  // If you know your property keys, set them explicitly here:
  const getDivisionCode = p => p?.division_code || p?.code || p?.name || p?.id;
  const getDivisionName = p => p?.division_code || p?.division_name || p?.name || "Region";
  const getStateName    = p => p?.state || p?.STATE || p?.STATE_NAME || p?.ste_name || "";

  document.addEventListener("DOMContentLoaded", init);

  async function init(){
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

    // Layer order: states under divisions
    map.createPane('pane-states');    map.getPane('pane-states').style.zIndex = 400;
    map.createPane('pane-divisions'); map.getPane('pane-divisions').style.zIndex = 405;

    let stateLayer, divisionsLayer;

    // ---- STATES (background) with hover
    try {
      const states = await fetch(B2M.statesGeoJSON, { cache: "no-store" }).then(r=>r.json());
      function over(e){ const l=e.target; l.setStyle(stateHover); l.openPopup(); }
      function out (e){ const l=e.target; stateLayer.resetStyle(l); l.closePopup(); }

      stateLayer = L.geoJSON(states, {
        pane: 'pane-states',
        style: () => stateBase,
        onEachFeature: (f, l) => {
          const label = f.properties?.STATE_NAME || f.properties?.name || "State";
          l.bindPopup(`<strong>${label}</strong>`, { closeButton:false, autoPan:false });
          l.on({ mouseover: over, mouseout: out });
        }
      }).addTo(map);
    } catch(e){ console.warn("[B2M] states load failed:", e); }

    // ---- REGIONAL DIVISIONS (foreground) — polygons only
    const divisions = await loadDivisions(B2M.divisionsGeoJSON);
    if (!divisions) return;

    function onEachDivision(f, l){
      const code = String(getDivisionCode(f.properties) || "");
      const name = getDivisionName(f.properties);
      const state= getStateName(f.properties);

      l.bindPopup(`<strong>${name}</strong>${state?`<div>${state}</div>`:''}`, { closeButton:false, autoPan:false });
      l.bindTooltip(name, { sticky:true, direction:'center', opacity:0.85 });

      l.on({
        mouseover: e => { e.target.setStyle(divHover); e.target.openPopup(); L.DomEvent.stopPropagation(e); },
        mouseout : e => { divisionsLayer.resetStyle(e.target); e.target.closePopup(); L.DomEvent.stopPropagation(e); },
        click    : () => { map.fitBounds(l.getBounds(), { padding:[16,16], maxZoom: 9 }); l.openPopup(); }
      });
    }

    divisionsLayer = L.geoJSON(divisions, {
      pane: 'pane-divisions',
      filter: f => ['Polygon','MultiPolygon'].includes(f?.geometry?.type),
      style: () => divBase,
      onEachFeature: onEachDivision,
      pointToLayer: () => null // ignore any stray points
    }).addTo(map);

    // Reset styles whenever any popup closes
    map.on('popupclose', () => {
      if (divisionsLayer) divisionsLayer.setStyle(() => divBase);
      if (stateLayer)     stateLayer.setStyle(() => stateBase);
    });
  }

  // Load divisions; if the file is points-only, warn and skip drawing
  async function loadDivisions(url){
    const note = msg => {
      const box = document.createElement('div');
      box.className = 'b2m-info'; box.style.marginTop = '8px'; box.textContent = msg;
      document.querySelector('.b2m-card').appendChild(box);
    };
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gj = await res.json();
      if (!gj?.features?.length) { note('Regional divisions file has no features.'); return null; }

      // Quick geometry check
      const types = gj.features.reduce((a,f)=>{ const t=f?.geometry?.type||'NULL'; a[t]=(a[t]||0)+1; return a; },{});
      const polyCount = (types.Polygon||0)+(types.MultiPolygon||0);
      const pointCount= (types.Point||0)+(types.MultiPoint||0);
      console.log('[B2M] division geometry types:', types);

      if (polyCount===0 && pointCount>0){ note('Divisions file contains points; need polygons.'); return null; }
      return gj;
    } catch(e){ console.error('[B2M] divisions load failed:', e); return null; }
  }
})();
