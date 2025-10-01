<?php
/**
 * Plugin Name: Back2Maps
 * Description: Clean-slate Leaflet map with regions (divisions) + CSV-driven markers & choropleth.
 * Version: 1.1.0
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
      $atts = shortcode_atts([
        'height' => '60vh',
      ], $atts, 'back2maps');
      ob_start(); ?>
      <div class="back2maps">
        <div class="b2m-card">
          <h2 class="b2m-title">Back2Maps</h2>
          <p class="b2m-sub">Regional choropleth + markers from CSV</p>
          <div id="b2m-map" style="height:<?php echo esc_attr($atts['height']); ?>"></div>
          <div class="b2m-note">Zoom to explore. Regions shade darker where more rows fall inside.</div>
        </div>
      </div>
      <?php return ob_get_clean();
    });
  }

  private function asset_url($rel) {
    return plugins_url($rel, __FILE__);
  }
  private function asset_path($rel) {
    return plugin_dir_path(__FILE__) . ltrim($rel, '/');
  }

  public function enqueue_assets() {
    // CSS
    wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_style('back2maps-css', $this->asset_url('front2maps.css'), [], '1.1.0');

    // JS libs
    wp_enqueue_script('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse', 'https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('turf', 'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);

    // Main JS
    wp_enqueue_script('back2maps-js', $this->asset_url('hates2map.js'), ['leaflet','papaparse','turf'], '1.1.0', true);

    // --- Configure your data files here -----------------------------------
    // Put your files under /wp-content/plugins/back2maps/assets/ and /data/
    $base_assets = $this->asset_url('assets/');
    $base_data   = $this->asset_url('data/');

    // REQUIRED: your regional divisions (GeoJSON FeatureCollection, polygons)
    // Properties should include a stable identifier: id/code/name (any one is fine).
    $divisions_url = $base_assets . 'regional_divisions.geojson';

    // REQUIRED: your incidents CSV (testData.csv). Place it in /data/
    $cio_url = $base_data . 'testData.csv';

    // OPTIONAL: suburbs/postcodes lookup for geocoding when CSV has no lat/lon
    // Expect a FeatureCollection of Points with props: suburb, state, postcode
    // Example filename: suburbs.min.json (keep it ~few MB for front-end).
    $suburbs_url = $base_assets . 'suburbs.min.json';

    // Localize for JS
    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsGeoJSON' => esc_url_raw($divisions_url),
      'cioData'          => esc_url_raw($cio_url),
      'suburbLookup'     => esc_url_raw($suburbs_url),
      // tune marker/choropleth if you want
      'minZoomForDiv'    => 4.3,
    ]);
  }
}

Back2Maps::instance();
