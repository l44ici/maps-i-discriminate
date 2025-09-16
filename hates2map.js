/* ===== Back2Maps — map only (no legend, no info chip, no helper note) ===== */
(function () {
  'use strict';

  // Australia view box
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // Choropleth colors
  function getColor(d) {
    return d > 40 ? '#7f0000' :
           d > 30 ? '#b30000' :
           d > 20 ? '#d7301f' :
           d > 10 ? '#ef6548' :
           d >  5 ? '#fdbb84' :
           d >  0 ? '#fee8c8' : '#f7f7f7';
  }

  // Region styles (solid borders)
  const styleFor = c => ({
    weight: 1,
    opacity: 1,
    color: '#ffffff',
    dashArray: '',          // solid line
    fillOpacity: 0.85,
    fillColor: getColor(c || 0)
  });

  // --- helpers --------------------------------------------------------------

  async function fetchJSON(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (typeof B2M !== 'undefined' && B2M.nonce) headers['X-WP-Nonce'] = B2M.nonce;
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function tryLoad(url) {
    if (!url) return null;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // Accept multiple property names from different GeoJSONs
  function getIds(rawProps = {}) {
    const props = rawProps || {};
    const rawId =
      props.region_id ??
      props.STATE_CODE ?? props.state_code ??
      props.code ?? props.abbrev ?? props.name;

    const id = rawId != null ? String(rawId) : undefined;

    const name =
      props.region_name ??
      props.STATE_NAME ?? props.name ?? id ?? 'Region';

    return { id, name };
  }

  // NEW: postcode normaliser + helper
  const normPC = pc => String(pc || '').replace(/\D/g, '').padStart(4, '0');
  const getSuburbOptions = (pc, POSTCODES) => (POSTCODES[normPC(pc)] || []);

  // --- main ---------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', async function () {
    const root = document.querySelector('.back2maps');
    if (!root) return;

    // Minimal shell
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map — Australia</h2>
        <div id="b2m-map"></div>
      </div>
    `;

    // Map
    const map = L.map('b2m-map', { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // NEW: Fetch postcodes data from REST endpoint
    let POSTCODES = {};
    let ambiguous = [];
    try {
      const res = await fetchJSON(`${B2M.restUrl}/postcodes`);
      POSTCODES = res.postcodes || {};
      ambiguous = res.ambiguous || [];
      // Expose globally if you need it in other scripts/inspect in console
      window.B2M_POSTCODES = POSTCODES;
      window.B2M_AMBIGUOUS = ambiguous;
      console.log('Loaded postcodes:', Object.keys(POSTCODES).length);
      console.log('Ambiguous postcodes:', ambiguous);
    } catch (e) {
      console.warn('Failed to load postcodes', e);
    }

    // NEW: Optional — enrich your existing reports (if present)
    if (window.hatemapData?.reports?.length) {
      window.hatemapData.reports = window.hatemapData.reports.map(r => {
        const pc = normPC(r.postcode);
        return {
          ...r,
          postcode: pc,
          suburbOptions: POSTCODES[pc] || []   // resolve in UI if >1
        };
      });
      // If you want to react elsewhere, dispatch a custom event
      document.dispatchEvent(new CustomEvent('b2m:reportsEnriched', {
        detail: { count: window.hatemapData.reports.length }
      }));
    }

    // Load regions + metrics
    let geojson = await tryLoad(B2M && B2M.regionsGeoJSON);
    let metrics = {};
    let metricsResp = await tryLoad(B2M && B2M.metricsJSON);
    if (!metricsResp) {
      try { metricsResp = await fetchJSON(`${B2M.restUrl}/region-metrics`); } catch {}
    }
    if (metricsResp && metricsResp.metrics) metrics = metricsResp.metrics;

    // Build layer
    let layer;

    function valueForFeature(props) {
      const { id, name } = getIds(props);
      // try code first, then name
      return (metrics[id] ?? metrics[name] ?? 0);
    }

    function rebuildLayer() {
      if (!geojson) return;
      if (layer) layer.remove();

      layer = L.geoJSON(geojson, {
        style: f => styleFor(valueForFeature(f.properties)),
        onEachFeature: (feature, l) => {
          const { id, name } = getIds(feature.properties);
          const count = valueForFeature(feature.properties);

          l.bindPopup(`<b>${name}</b><br/>Reports: <b>${fmt(count)}</b>`);

          l.on({
            mouseover: e => {
              const x = e.target;
              x.setStyle({ weight: 2, color: '#333', dashArray: '', fillOpacity: 0.9 });
              if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) x.bringToFront();
            },
            mouseout: e => {
              e.target.setStyle(styleFor(valueForFeature(feature.properties)));
            },
            click: e => map.fitBounds(e.target.getBounds(), { maxZoom: 8 })
          });
        }
      }).addTo(map);
    }

    rebuildLayer();

    const legend = L.control({ position: 'bottomright' });

    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'info legend');
      const grades = [0, 1, 5, 10, 20, 30, 40];

      for (let i = 0; i < grades.length; i++) {
        div.innerHTML +=
          '<i style="background:' + getColor(grades[i] + 1) + '"></i> ' +
          grades[i] + (grades[i + 1] ? '&ndash;' + grades[i + 1] + '<br>' : '+');
      }
      return div;
    };

    legend.addTo(map);

    // Light auto-refresh of metrics (no legend/labels)
    async function refreshMetrics() {
      try {
        const data = await fetchJSON(`${B2M.restUrl}/region-metrics`);
        metrics = data.metrics || {};
        rebuildLayer();
      } catch {
        /* ignore */
      }
    }
    setInterval(refreshMetrics, 20000);

    // Fix initial sizing when inside hidden layouts
    setTimeout(() => map.invalidateSize(), 100);
  });
})();

