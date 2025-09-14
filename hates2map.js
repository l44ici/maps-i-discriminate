(function () {
  const AU_BOUNDS = [[-44.0, 112.0], [-10.0, 154.0]]; // SW, NE
  const fmt = n => new Intl.NumberFormat().format(n);

  document.addEventListener('DOMContentLoaded', async function () {
    const root = document.querySelector('.back2maps');
    if (!root) return;

    // UI shell
    root.innerHTML = `
      <div class="b2m-card">
        <h2 class="b2m-title">Hate Map</h2>
        <p class="b2m-sub">chloropleth pls show ...</p>
        <div id="b2m-map"></div>
        <div class="b2m-note">Hover a region for details. Click to zoom.</div>
      </div>
    `;

    const map = L.map('b2m-map', { zoomSnap: 0.5, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);
    map.fitBounds(AU_BOUNDS);

    // Info control
    const info = L.control();
    info.onAdd = function () { this._div = L.DomUtil.create('div', 'b2m-info'); this.update(); return this._div; };
    info.update = function (props, count) {
      this._div.innerHTML = props
        ? `<b>${props.region_name || props.region_id}</b><br/>Reports: <b>${fmt(count || 0)}</b>`
        : 'Hover over a region';
    };
    info.addTo(map);

    // Fetch metrics + regions
    let metrics = {};
    try {
      const res = await fetch(`${B2M.restUrl}/region-metrics`, { headers: { 'X-WP-Nonce': B2M.nonce } });
      const json = await res.json();
      metrics = json.metrics || {};
    } catch (e) { console.warn('Metrics fetch failed', e); }

    let geojson;
    try {
      const r = await fetch(B2M.regionsGeoJSON);
      geojson = await r.json();
    } catch (e) {
      console.error('GeoJSON load failed', e);
      return;
    }

    function highlight(e) {
      const layer = e.target;
      layer.setStyle({ weight: 2, color: '#333', dashArray: '', fillOpacity: 0.9 });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) layer.bringToFront();
      const rid = layer.feature?.properties?.region_id;
      info.update(layer.feature?.properties, metrics[rid] || 0);
    }
    function reset(e) {
      const layer = e.target;
      const rid = layer.feature?.properties?.region_id;
      layer.setStyle(styleFor(metrics[rid] || 0));
      info.update();
    }
    function zoomTo(e) { map.fitBounds(e.target.getBounds(), { maxZoom: 8 }); }

    L.geoJSON(geojson, {
      style: f => styleFor(metrics[f.properties?.region_id] || 0),
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const rid = p.region_id, name = p.region_name || rid || 'Region';
        const count = metrics[rid] || 0;
        layer.bindPopup(`<b>${name}</b><br/>Reports: <b>${fmt(count)}</b>`);
        layer.on({ mouseover: highlight, mouseout: reset, click: zoomTo });
      }
    }).addTo(map);

    setTimeout(() => map.invalidateSize(), 100);
  });
})();
