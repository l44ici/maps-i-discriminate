public function enqueue_assets() {
  // CSS
  wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
  wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.2.0');

  // JS libs
  wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
  wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
  wp_enqueue_script('turf',     'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);
  wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);

  // Main JS
  wp_enqueue_script('back2maps-js', $this->url('hates2map.js'),
    ['leaflet','papaparse','turf','topojson'], '1.2.1', true);

  // ---- Robust path picking (works no matter the folder name) ----
  $assets_dir = $this->path('assets/');
  $assets_url = $this->url('assets/');
  $data_url   = $this->url('data/');

  // Prefer TopoJSON if present, else GeoJSON
  $divisions_url = '';
  $div_object    = '';           // only needed for TopoJSON

  if (file_exists($assets_dir . 'regional_div.json')) {
    $divisions_url = $assets_url . 'regional_div.json';   // TopoJSON
    $div_object    = 'regional_div';                      // change if your object name differs
  } elseif (file_exists($assets_dir . 'regional_divisions.geojson')) {
    $divisions_url = $assets_url . 'regional_divisions.geojson'; // GeoJSON
  } else {
    // fallback: let it 404 loudly so you notice the missing file in Network tab
    $divisions_url = $assets_url . 'regional_divisions.geojson';
  }

  // Optional suburbs lookup
  $suburbs_url = $assets_url . 'suburbs.min.json';

  // Incidents CSV
  $cio_url = $data_url . 'testData.csv';

  wp_localize_script('back2maps-js', 'B2M', [
    'divisionsUrl'  => esc_url_raw($divisions_url),
    'divObject'     => $div_object,      // ignored for GeoJSON
    'cioData'       => esc_url_raw($cio_url),
    'suburbLookup'  => esc_url_raw($suburbs_url),
    'minZoomForDiv' => 0,                // keep regions visible at all zooms
  ]);
}
