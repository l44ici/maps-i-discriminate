/* ===== Back2Maps — streamlined (no legend, robust loading) ===== */
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
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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

  // Postcode helpers (optional)
  const normPC = pc => String(pc || '').replace(/\D/g, '').padStart(4, '0');

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

    // Optional: fetch postcodes (safe if not present)
    try {
      const res = await fetchJSON(`${B2M.restUrl}/postcodes`);
      window.B2M_POSTCODES = res.postcodes || {};
      window.B2M_AMBIGUOUS = res.ambiguous || [];
      // If you have hatemapData.reports, enrich them
      if (window.hatemapData?.reports?.length) {
        window.hatemapData.reports = window.hatemapData.reports.map(r => {
          const pc = normPC(r.postcode);
          return { ...r, postcode: pc, suburbOptions: (window.B2M_POSTCODES[pc] || []) };
        });
        document.dispatchEvent(new CustomEvent('b2m:reportsEnriched', {
          detail: { count: window.hatemapData.reports.length }
        }));
      }
    } catch (e) {
      console.debug('[B2M] postcodes endpoint not available (ok):', e?.message || e);
    }

    // Load regions GeoJSON
    let geojson = await tryLoad(B2M && B2M.regionsGeoJSON);
    if (!geojson || !geojson.features || !geojson.features.length) {
      console.error('[B2M] regionsGeoJSON failed to load or is empty:', B2M && B2M.regionsGeoJSON, geojson);
      // Optional: early return if regions are mandatory
      // return;
    }

    // Load metrics (from static JSON or REST)
    let metrics = {};
    let metricsResp = await tryLoad(B2M && B2M.metricsJSON);
    if (!metricsResp) {
      try { metricsResp = await fetchJSON(`${B2M.restUrl}/region-metrics`); }
      catch (e) { console.error('[B2M] region-metrics failed:', e?.message || e); }
    }
    if (metricsResp && metricsResp.metrics) {
      metrics = metricsResp.metrics;
    } else {
      console.warn('[B2M] No region metrics found; regions will render with default colour.');
    }

    // Build layer
    let layer;

    function valueForFeature(props) {
      const { id, name } = getIds(props);
      // Try code first, then name
      return (metrics[id] ?? metrics[name] ?? 0);
    }

    function rebuildLayer() {
      if (!geojson) return;
      if (layer) layer.remove();

      layer = L.geoJSON(geojson, {
        style: f => styleFor(valueForFeature(f.properties)),
        onEachFeature: (feature, l) => {
          const { name } = getIds(feature.properties);
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

    // Auto-refresh metrics (optional)
    async function refreshMetrics() {
      try {
        const data = await fetchJSON(`${B2M.restUrl}/region-metrics`);
        metrics = data.metrics || {};
        rebuildLayer();
      } catch (e) {
        console.debug('[B2M] metrics refresh failed (ignored):', e?.message || e);
      }
    }
    setInterval(refreshMetrics, 20000);

    // Fix sizing if inside hidden layouts
    setTimeout(() => map.invalidateSize(), 100);
  });
})();
