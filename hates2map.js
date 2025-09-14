/* ===== Back2Maps — hates2map.js (legend removed) ===== */
(function () {
  'use strict';

  // Approx bounds for Australia
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]];
  const fmt = n => new Intl.NumberFormat().format(n);

  // Choropleth colours (legend hidden but colours still used)
  function getColor(d) {
    return d > 40 ? '#7f0000' :
           d > 30 ? '#b30000' :
           d > 20 ? '#d7301f' :
           d > 10 ? '#ef6548' :
           d >  5 ? '#fdbb84' :
           d >  0 ? '#fee8c8' : '#f7f7f7';
  }
  const styleFor = c => ({
    weight: 1,
    opacity: 1,
    color: '#ffffff',
    dashArray: '3',
    fillOpacity: 0.8,
    fillColor: getColor(c || 0)
  });

  async function fetchJSON(url, opts = {}) {
    const headers = Object.assign({}, (opts.headers || {}));
    if (typeof B2M !== 'undefined' && B2M.nonce) headers['X-WP-Nonce'] = B2M.nonce;
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  document.addEventListener('DOMContentLoaded', async function () {
    /* ---------- MAP ---------- */
    const root = document.querySelector('.back2maps');
    let geojson, layer, metrics = {};

    if (root) {
      root.innerHTML = `
        <div class="b2m-card">
          <h2 class="b2m-title">Hate Map — Australia</h2>
          <p class="b2m-sub">Interactive choropleth by custom regions</p>
          <div id="b2m-map"></div>
          <div class="b2m-note">Hover a region for details. Click to zoom.</div>
        </div>
      `;

      const map = L.map('b2m-map', { zoomSnap: 0.5, worldCopyJump: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);
      map.fitBounds(AU_BOUNDS);

      // Info box (top-left)
      const info = L.control();
      info.onAdd = function () {
        this._div = L.DomUtil.create('div', 'b2m-info');
        this.update();
        return this._div;
      };
      info.update = function (p, c) {
        this._div.innerHTML = p
          ? `<b>${p.region_name || p.region_id}</b><br/>Reports: <b>${fmt(c || 0)}</b>`
          : 'Hover over a region';
      };
      info.addTo(map);

      // Load regions (once)
      try {
        geojson = await (await fetch(B2M.regionsGeoJSON)).json();
      } catch (e) {
        console.error('GeoJSON load failed', e);
        return;
      }

      function rebuildLayer() {
        if (layer) layer.remove();
        layer = L.geoJSON(geojson, {
          style: f => styleFor(metrics[f.properties?.region_id] || 0),
          onEachFeature: (feature, l) => {
            const p   = feature.properties || {};
            const rid = p.region_id;
            const name  = p.region_name || rid || 'Region';
            const count = metrics[rid] || 0;

            l.bindPopup(`<b>${name}</b><br/>Reports: <b>${fmt(count)}</b>`);

            l.on({
              mouseover: e => {
                const x = e.target;
                x.setStyle({ weight: 2, color: '#333', dashArray: '', fillOpacity: 0.9 });
                if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) x.bringToFront();
                info.update(p, metrics[rid] || 0);
              },
              mouseout: e => {
                const x = e.target;
                x.setStyle(styleFor(metrics[rid] || 0));
                info.update();
              },
              click: e => map.fitBounds(e.target.getBounds(), { maxZoom: 8 })
            });
          }
        }).addTo(map);
      }

      async function refreshMetrics() {
        try {
          const data = await fetchJSON(`${B2M.restUrl}/region-metrics`);
          metrics = data.metrics || {};
          rebuildLayer();
        } catch (e) {
          console.warn('Failed to refresh metrics', e);
        }
      }

      await refreshMetrics();
      setInterval(refreshMetrics, 20000);      // auto-refresh counts every 20s
      setTimeout(() => map.invalidateSize(), 100);
    }

    /* ---------- MINIMAL SUBMIT FORM (optional) ---------- */
    // If you add the shortcode [back2maps_report_form], this enables it.
    const form = document.querySelector('.b2m-form');
    if (form) {
      try {
        const gj = geojson || await (await fetch(B2M.regionsGeoJSON)).json();
        const sel = form.querySelector('select[name="region_id"]');
        const items = (gj.features || [])
          .map(f => ({ id: f.properties?.region_id, name: f.properties?.region_name || f.properties?.region_id }))
          .filter(x => x.id);
        items.sort((a, b) => a.name.localeCompare(b.name));
        sel.innerHTML = items.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
      } catch (e) {
        console.warn('Could not build region list', e);
      }

      const msg = form.querySelector('.b2m-form-msg');
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        msg.textContent = 'Submitting…';
        const fd = new FormData(form);
        const payload = new URLSearchParams({ region_id: fd.get('region_id') || '' });

        try {
          await fetchJSON(`${B2M.restUrl}/report`, { method: 'POST', body: payload });
          msg.textContent = 'Thanks! Your report was submitted and is pending review.';
          form.reset();
        } catch (e) {
          msg.textContent = 'Submission failed. Please try again.';
        }
      });
    }

    // Admin helper (optional): run approveReport(ID) from the console
    window.approveReport = async id => {
      if (!B2M || !B2M.canApprove) return console.warn('Not allowed');
      await fetchJSON(`${B2M.restUrl}/report/${id}/approve`, { method: 'PUT' });
    };
  });
})();
