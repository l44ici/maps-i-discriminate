/* ===== Back2Maps — map only (no legend, no info chip, no helper note) ===== */
(function () {
  'use strict';

  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

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

    // Clean shell (note removed)
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <p class="b2m-sub">Interactive choropleth by custom regions</p>
        <div id="b2m-map"></div>
      </div>
    `;

    // Map
    const map = L.map('b2m-map', { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Optional files
    let geojson = await tryLoad(B2M.regionsGeoJSON);   // ok if null
    let metricsResp = await tryLoad(B2M.metricsJSON);  // ok if null
    let metrics = {};
    if (!metricsResp) {
      try { metricsResp = await fetchJSON(`${B2M.restUrl}/region-metrics`); } catch {}
    }
    if (metricsResp && metricsResp.metrics) metrics = metricsResp.metrics;

    // Flexible property names for various GeoJSONs
    function getIds(props) {
      const id = props.region_id || props.STATE_CODE || props.state_code || props.code || props.abbrev || props.name;
      const name = props.region_name || props.STATE_NAME || props.name || id || 'Region';
      return { id, name };
    }

    // Draw polygons (if provided)
    let layer;
    function rebuildLayer() {
      if (!geojson) return;
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
            },
            mouseout: e => {
              const x = e.target;
              x.setStyle(styleFor(metrics[id] || 0));
            },
            click: e => map.fitBounds(e.target.getBounds(), { maxZoom: 8 })
          });
        }
      }).addTo(map);
    }

    rebuildLayer();

    // Light auto-refresh of metrics (safe if no polygons)
    async function refreshMetrics() {
      try {
        const data = await fetchJSON(`${B2M.restUrl}/region-metrics`);
        metrics = data.metrics || {};
        rebuildLayer();
      } catch {}
    }
    setInterval(refreshMetrics, 20000);
    setTimeout(() => map.invalidateSize(), 100);
  });
})();
