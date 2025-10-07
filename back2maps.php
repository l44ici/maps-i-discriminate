<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth, counted from CSV/XLSX (postcode-first; no markers).
 * Version: 1.6.0
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
      // [back2maps height="60vh" divzoom="6" title="Back2Maps" subtitle="Regional choropleth from CSV"]
      $atts = shortcode_atts([
        'height'   => '60vh',
        'title'    => 'Back2Maps',
        'subtitle' => 'Regional choropleth from CSV',
        'divzoom'  => '6',
      ], $atts, 'back2maps');

      ob_start(); ?>
      <div class="back2maps" data-divzoom="<?php echo esc_attr($atts['divzoom']); ?>">
        <div class="b2m-card">
          <h2 class="b2m-title"><?php echo esc_html($atts['title']); ?></h2>
          <p class="b2m-sub"><?php echo esc_html($atts['subtitle']); ?></p>
          <div id="b2m-map" style="height:<?php echo esc_attr($atts['height']); ?>"></div>
          <div class="b2m-note">Zoom out for states; zoom in to see regional divisions.</div>
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
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.6.0');

    // JS libs
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('topojson', 'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    wp_enqueue_script('xlsx',     'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);

    // ---- Main JS (fixed filename)
    wp_enqueue_script(
      'back2maps-js',
      $this->url('hate2map.js'),
      ['leaflet','topojson','xlsx'],
      '1.6.0',
      true
    );

    // Base dir/URL
    $base_url = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Regional divisions: try known filenames (your folder shows regional_div.geojson)
    $divisions_url = '';
    $div_object    = 'regional_div'; // only used if a Topology object

    foreach ([
      'regional_div.geojson',
      'regional_div.json',
      'regional_divisions.geojson',
      'regional_divisions.json'
    ] as $fname) {
      if (file_exists($base_dir . $fname)) {
        $divisions_url = $base_url . $fname;
        break;
      }
    }
    if (!$divisions_url) $divisions_url = $base_url . 'regional_div.geojson';

    // States (your repo has australian-states.min.geojson)
    $states_url = $base_url . 'australian-states.min.geojson';

    // Optional postcode index (if you ever generate one)
    $pcindex_url = file_exists($base_dir.'postcode-index.json') ? $base_url.'postcode-index.json' : '';

    // Suburb gazetteer (centroids) – your `suburbs` file is JSON
    $suburbs_url = $base_url . 'suburbs';

    // Incident data
    $csv_url  = $base_url . 'testData.csv';   // keep alongside plugin files
    $xlsx_url = $base_url . 'testData.xlsx';  // optional fallback

    // Pass config to JS
    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl' => esc_url_raw($divisions_url),
      'divObject'    => $div_object,
      'statesUrl'    => esc_url_raw($states_url),

      'pcIndexUrl'   => esc_url_raw($pcindex_url),
      'suburbLookup' => esc_url_raw($suburbs_url),

      'cioDataCsv'   => esc_url_raw($csv_url),
      'cioDataXlsx'  => esc_url_raw($xlsx_url),

      'minZoomForDiv' => 6,
    ]);
  }
}

Back2Maps::instance();
