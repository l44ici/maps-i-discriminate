<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth and CSV/XLSX-driven markers.
 * Version: 1.5.0
 * Author: You
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      // Allow easy control from the shortcode:
      // [back2maps height="60vh" divzoom="6" markerzoom="6" title="Back2Maps" subtitle="Regional choropleth + markers from CSV/XLSX"]
      $atts = shortcode_atts([
        'height'     => '60vh',
        'title'      => 'Back2Maps',
        'subtitle'   => 'Regional choropleth + markers from CSV/XLSX',
        'divzoom'    => '6',   // divisions appear from this zoom
        'markerzoom' => '',    // defaults to divzoom if empty
      ], $atts, 'back2maps');

      $divzoom    = is_numeric($atts['divzoom']) ? $atts['divzoom'] : '6';
      $markerzoom = ($atts['markerzoom'] === '' ? $divzoom : $atts['markerzoom']);

      // Stash zoom prefs in a data attribute so JS can read even if localization is cached
      ob_start(); ?>
      <div class="back2maps" data-divzoom="<?php echo esc_attr($divzoom); ?>" data-markerzoom="<?php echo esc_attr($markerzoom); ?>">
        <div class="b2m-card">
          <h2 class="b2m-title"><?php echo esc_html($atts['title']); ?></h2>
          <p class="b2m-sub"><?php echo esc_html($atts['subtitle']); ?></p>
          <div id="b2m-map" style="height:<?php echo esc_attr($atts['height']); ?>"></div>
          <div class="b2m-note">Zoom out for state view; zoom in to see regional divisions and markers.</div>
        </div>
      </div>
      <?php return ob_get_clean();
    });
  }

  private function url($rel)  { return plugins_url($rel, __FILE__); }
  private function path($rel) { return plugin_dir_path(__FILE__) . ltrim($rel, '/'); }

  public function enqueue_assets() {
    // ---- CSS
    wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.5.0');

    // ---- JS libraries
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('turf',     'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);
    wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    // XLSX support (optional; used only if CSV is missing/empty)
    wp_enqueue_script('xlsx',     'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);

    // ---- Main JS
    wp_enqueue_script(
      'back2maps-js',
      $this->url('hates2map.js'),
      ['leaflet','papaparse','turf','topojson','xlsx'],
      '1.5.0',
      true
    );

    // ---- Your files live in the plugin ROOT (per your screenshot)
    $base_url = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Regional divisions: prefer your TopoJSON; fall back to .geojson if you ever add it
    $divisions_url = $base_url . 'regional_div.json';
    $div_object    = 'regional_div'; // <-- must match the TopoJSON "objects" key in regional_div.json
    if (!file_exists($base_dir . 'regional_div.json') && file_exists($base_dir . 'regional_divisions.geojson')) {
      $divisions_url = $base_url . 'regional_divisions.geojson';
      $div_object    = ''; // ignored for GeoJSON
    }

    // States GeoJSON (used for zoomed-out layer and as PIP fallback)
    $states_url  = $base_url . 'australian-states.min.geojson';

    // Optional suburb/postcode centroid lookup (Point FeatureCollection)
    $suburbs_url = $base_url . 'suburbs.json';

    // Incidents data: CSV primary, XLSX fallback
    $csv_url  = $base_url . 'testData.csv';
    $xlsx_url = $base_url . 'testData.xlsx';

    // Defaults for zoom thresholds (JS will also read data-* from the container)
    $default_div_zoom     = 6;
    $default_marker_zoom  = 6;

    wp_localize_script('back2maps-js', 'B2M', [
      // Polygons
      'divisionsUrl'  => esc_url_raw($divisions_url),
      'divObject'     => $div_object,                 // ignored for GeoJSON
      'statesUrl'     => esc_url_raw($states_url),

      // Lookup + data
      'suburbLookup'  => esc_url_raw($suburbs_url),
      'cioDataCsv'    => esc_url_raw($csv_url),
      'cioDataXlsx'   => esc_url_raw($xlsx_url),

      // Zoom toggles (JS can override with data attributes)
      'minZoomForDiv'     => $default_div_zoom,
      'minZoomForMarkers' => $default_marker_zoom,
    ]);
  }
}

Back2Maps::instance();
// no closing PHP tag
