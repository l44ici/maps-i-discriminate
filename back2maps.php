<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth and CSV/XLSX-driven markers.
 * Version: 1.5.1
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
      // [back2maps height="60vh" divzoom="6" markerzoom="6" title="Back2Maps" subtitle="Regional choropleth + markers from CSV/XLSX"]
      $atts = shortcode_atts([
        'height'     => '60vh',
        'title'      => 'Back2Maps',
        'subtitle'   => 'Regional choropleth + markers from CSV/XLSX',
        'divzoom'    => '6',
        'markerzoom' => '',
      ], $atts, 'back2maps');

      $divzoom    = is_numeric($atts['divzoom']) ? $atts['divzoom'] : '6';
      $markerzoom = ($atts['markerzoom'] === '' ? $divzoom : $atts['markerzoom']);

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
    // CSS
    wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.5.1');

    // JS libs
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('turf',     'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);
    wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    wp_enqueue_script('xlsx',     'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);

    // Main JS (keep your current filename)
    wp_enqueue_script(
      'back2maps-js',
      $this->url('hates2map.js'),
      ['leaflet','papaparse','turf','topojson','xlsx'],
      '1.5.1',
      true
    );

    $base_url = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Regional divisions: prefer your actual files
    $divisions_url = '';
    $div_object    = 'regional_div'; // only for TopoJSON

    foreach (['regional_div.geojson','regional_div.json','regional_divisions.geojson','regional_divisions.json'] as $fname) {
      if (file_exists($base_dir . $fname)) { $divisions_url = $base_url . $fname; break; }
    }
    if (!$divisions_url) { $divisions_url = $base_url . 'regional_div.geojson'; }

    // States
    $states_url  = $base_url . 'australian-states.min.geojson';

    // Suburb gazetteer: your file is named "suburbs" (no extension)
    $suburbs_url = $base_url . 'suburbs';

    // Optional postcode index (leave blank if you don't have it)
    $pcindex_url = file_exists($base_dir.'postcode-index.json') ? $base_url.'postcode-index.json' : '';

    // Data
    $csv_url  = $base_url . 'testData.csv';
    $xlsx_url = $base_url . 'testData.xlsx';

    // Defaults (JS can override via data-* on the container)
    $default_div_zoom     = 6;
    $default_marker_zoom  = 6;

    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl'      => esc_url_raw($divisions_url),
      'divObject'         => $div_object,
      'statesUrl'         => esc_url_raw($states_url),

      'suburbLookup'      => esc_url_raw($suburbs_url),
      'pcIndexUrl'        => esc_url_raw($pcindex_url),

      'cioDataCsv'        => esc_url_raw($csv_url),
      'cioDataXlsx'       => esc_url_raw($xlsx_url),

      'minZoomForDiv'     => $default_div_zoom,
      'minZoomForMarkers' => $default_marker_zoom,
    ]);
  }
}

Back2Maps::instance();
// no closing PHP tag
