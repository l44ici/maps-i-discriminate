<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with regional divisions + CSV/XLSX-driven markers & choropleth.
 * Version: 1.4.0
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
      $atts = shortcode_atts(['height' => '60vh'], $atts, 'back2maps');
      ob_start(); ?>
      <div class="back2maps">
        <div class="b2m-card">
          <h2 class="b2m-title">Back2Maps</h2>
          <p class="b2m-sub">Regional choropleth + markers from CSV/XLSX</p>
          <div id="b2m-map" style="height:<?php echo esc_attr($atts['height']); ?>"></div>
          <div class="b2m-note">Zoom to explore. Regions shade darker where more rows fall inside.</div>
        </div>
      </div>
      <?php return ob_get_clean();
    });
  }

  private function url($rel)  { return plugins_url($rel, __FILE__); }
  private function path($rel) { return plugin_dir_path(__FILE__) . ltrim($rel, '/'); }

  public function enqueue_assets() {
    // CSS
    wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.4.0');

    // JS libs
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('turf',     'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);
    wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    // XLSX support for testData.xlsx
    wp_enqueue_script('xlsx',     'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);

    // Main JS
    wp_enqueue_script('back2maps-js', $this->url('hates2map.js'),
      ['leaflet','papaparse','turf','topojson','xlsx'], '1.4.0', true);

    // All files are in the plugin root (as per your screenshot)
    $base = plugin_dir_url(__FILE__);

    // Divisions (TopoJSON) + object name
    $divisions_url = $base . 'regional_div.json';
    $div_object    = 'regional_div'; // change only if your TopoJSON object name differs

    // States (GeoJSON) for fallback classification
    $states_url    = $base . 'australian-states.min.geojson';

    // Optional suburb/postcode lookup (Point FC with suburb/state/postcode)
    $suburbs_url   = $base . 'suburbs.json';

    // Incidents data (CSV primary, XLSX fallback)
    $csv_url       = $base . 'testData.csv';
    $xlsx_url      = $base . 'testData.xlsx';

    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl'  => esc_url_raw($divisions_url),
      'divObject'     => $div_object,              // ignored if GeoJSON
      'statesUrl'     => esc_url_raw($states_url), // for state fallback PIP
      'suburbLookup'  => esc_url_raw($suburbs_url),
      'cioDataCsv'    => esc_url_raw($csv_url),
      'cioDataXlsx'   => esc_url_raw($xlsx_url),
      'minZoomForDiv' => 0, // keep regions visible at all zooms
    ]);
  }
}

Back2Maps::instance();
// no closing PHP tag
