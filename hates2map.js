/* ===== Back2Maps — clean slate (no legend) ===== */
(function () {
  'use strict';

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // Colour scale remains (legend hidden)
  function getColor(d) {
    return d > 40 ? '#7f0000' :
           d > 30 ? '#b30000' :
           d > 20 ? '#d7301f' :
           d > 10 ? '#ef6548' :
           d >  5 ? '#fdbb84' :
           d >  0 ? '#fee8c8' : '#f7f7f7';
  }
  const styleFor = c => ({
    weight: 1, opacity: 1, color: '#ffffff', dashArray: '3',
    fillOpacity: 0.8, fillColor: getColor(c || 0)
  });

  async function fetchJSON(url, opts = {}) {
    const headers = Object.assign({}, (opts.headers || {}));
    if (typeof B2M !== 'undefined' && B2M.nonce) headers['X-WP-Nonce'] = B2M.nonce;
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Safely try load a JSON file that may not exist (returns null if missing)
  async function tryLoad(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  document.addEventListener('DOMContentLoaded', async function () {
    const root = document.querySelector('.back2maps');
    if (!root) return;

    // Shell
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <p class="b2m-sub">Interactive choropleth by custom regions</p>
        <div id="b2m-map"></div>
        <div class="b2m-note">Hover a region for details. Click to zoom.</div>
      </div>
    `;

    // Map
    const map = L.map('b2m-map', { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Hover info
    const info = L.control();
    info.onAdd = function () {
      this._div = L.DomUtil.create('div', 'b2m-info');
      this.update();
      return this._div;
    };
    info.update = function (p, c) {
      this._div.innerHTML = p
        ? `<b>${p.region_name || p.region_id || p.STATE_NAME || p.name}</b><br/>Reports: <b>${fmt(c || 0)}</b>`
        : 'Hover over a region';
    };
    info.addTo(map);

    // Load optional files
    let geojson = await tryLoad(B2M.regionsGeoJSON);      // null if missing
    let metricsResp = await tryLoad(B2M.metricsJSON);     // null if missing
    let metrics = {};

    // If metrics file missing, try REST endpoint (returns {} if none)
    if (!metricsResp) {
      try { metricsResp = await fetchJSON(`${B2M.restUrl}/region-metrics`); }
      catch { /* ignore */ }
    }
    if (metricsResp && metricsResp.metrics) metrics = metricsResp.metrics;

    // Helper to find a region id/name regardless of property naming in the GeoJSON
    function getIds(props) {
      const id = props.region_id || props.STATE_CODE || props.state_code || props.code || props.abbrev || props.name;
      const name = props.region_name || props.STATE_NAME || props.name || id || 'Region';
      return { id, name };
    }

    // Build layer if we have polygons
    let layer;
    function rebuildLayer() {
      if (!geojson) return; // polygons are optional
      if (layer) layer.remove();
      layer = L.geoJSON(geojson, {
        style: f => {
          const { id } = getIds(f.properties || {});
          return styleFor(metrics[id] || 0);
        },
        onEachFeature: (feature, l) => {
          const p = feature.properties || {};
          const { id, name } = getIds(p);
          const count = metrics[id] || 0;

          l.bindPopup(`<b>${name}</b><br/>Reports: <b>${fmt(count)}</b>`);
          l.on({
            mouseover: e => {
              const x = e.target;
              x.setStyle({ weight: 2, color: '#333', dashArray: '', fillOpacity: 0.9 });
              if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) x.bringToFront();
              info.update(p, count);
            },
            mouseout: e => {
              const x = e.target;
              x.setStyle(styleFor(metrics[id] || 0));
              info.update();
            },
            click: e => map.fitBounds(e.target.getBounds(), { maxZoom: 8 })
          });
        }
      }).addTo(map);
    }

    rebuildLayer();

    // Optional: light auto-refresh of metrics (still safe if no polygons)
    async function refreshMetrics() {
      try {
        const data = await fetchJSON(`${B2M.restUrl}/region-metrics`);
        metrics = data.metrics || {};
        rebuildLayer();
      } catch {/* ignore */}
    }
    setInterval(refreshMetrics, 20000);
    setTimeout(() => map.invalidateSize(), 100);
  });
})();

