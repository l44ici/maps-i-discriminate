<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth and CSV/XLSX-driven markers.
 * Version: 1.5.4
 * Author: You
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    // AJAX proxy for extension-less suburbs file
    add_action('wp_ajax_b2m_suburbs',        [$this, 'serve_suburbs']);
    add_action('wp_ajax_nopriv_b2m_suburbs', [$this, 'serve_suburbs']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
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
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.5.4');

    // JS libs
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('turf',     'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);
    wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    wp_enqueue_script('xlsx',     'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);

    // Main JS
    wp_enqueue_script(
      'back2maps-js',
      $this->url('hates2map.js'),
      ['leaflet','papaparse','turf','topojson','xlsx'],
      '1.5.4', // bump to break caches
      true
    );

    $base_url = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Regional divisions
    $divisions_url = '';
    $div_object    = 'regional_div';
    foreach (['regional_div.geojson','regional_div.json','regional_divisions.geojson','regional_divisions.json'] as $fname) {
      if (file_exists($base_dir . $fname)) { $divisions_url = $base_url . $fname; break; }
    }
    if (!$divisions_url) $divisions_url = $base_url . 'regional_div.geojson';

    // States
    $states_url  = $base_url . 'australian-states.min.geojson';

    // Suburbs: if `suburbs.json` exists use it; else if `suburbs` exists, proxy via AJAX
    if (file_exists($base_dir . 'suburbs.json')) {
      $suburbs_url = $base_url . 'suburbs.json';
    } elseif (file_exists($base_dir . 'suburbs')) {
      $suburbs_url = admin_url('admin-ajax.php?action=b2m_suburbs'); // proxy
    } else {
      $suburbs_url = ''; // will log "missing" in JS
    }

    // Optional postcode index
    $pcindex_url = file_exists($base_dir.'postcode-index.json') ? $base_url.'postcode-index.json' : '';

    // Data
    $csv_url  = $base_url . 'testData.csv';
    $xlsx_url = $base_url . 'testData.xlsx';

    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl'      => esc_url_raw($divisions_url),
      'divObject'         => $div_object,
      'statesUrl'         => esc_url_raw($states_url),

      'suburbLookup'      => esc_url_raw($suburbs_url),
      'pcIndexUrl'        => esc_url_raw($pcindex_url),
      'cioDataCsv'        => esc_url_raw($csv_url),
      'cioDataXlsx'       => esc_url_raw($xlsx_url),

      'minZoomForDiv'     => 6,
      'minZoomForMarkers' => 6,
    ]);
  }

  /**
   * AJAX proxy: outputs the contents of the extension-less "suburbs" file
   * as application/json so hosts that 404 extension-less files still work.
   */
  public function serve_suburbs() {
    $file = $this->path('suburbs'); // extension-less file
    if (!file_exists($file)) {
      wp_send_json_error(['error' => 'suburbs file not found'], 404);
    }
    // Output raw file contents with JSON header; tolerate text/plain bodies
    nocache_headers();
    header('Content-Type: application/json; charset=utf-8');
    // In case file is NDJSON or wrapped, we just stream raw; JS handles variants.
    readfile($file);
    exit;
  }
}

Back2Maps::instance();
// no closing PHP tag
