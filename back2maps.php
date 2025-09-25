<?php
if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance(){ return self::$instance ??= new self(); }

  private function __construct(){
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
  }

  public function register_shortcode(){
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts(['id'=>'back2maps-root'], $atts, 'back2maps');
      ob_start(); ?>
        <div id="<?php echo esc_attr($atts['id']); ?>" class="back2maps"></div>
      <?php return ob_get_clean();
    });
  }

  public function enqueue_assets(){
    $base = plugin_dir_url(__FILE__);
    $dir  = plugin_dir_path(__FILE__);

    /* ---------- Vendor libs ---------- */
    wp_enqueue_style ('leaflet-css',   'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_script('leaflet-js',    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',  [], '1.9.4', true);
    wp_enqueue_script('topojson-client','https://unpkg.com/topojson-client@3/dist/topojson-client.min.js', [], '3.1.0', true);
    wp_enqueue_script('papaparse',     'https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);
    wp_enqueue_script('xlsx',          'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);
    wp_enqueue_script('turf',          'https://unpkg.com/@turf/turf@6.5.0/turf.min.js', [], '6.5.0', true);

    /* ---------- Your assets (cache-busted) ---------- */
    $css_file = $dir.'front2maps.css';
    $js_file  = $dir.'hates2map.js';
    $css_ver  = file_exists($css_file) ? filemtime($css_file) : '1.0.0';
    $js_ver   = file_exists($js_file)  ? filemtime($js_file)  : '1.0.0';

    wp_enqueue_style ('back2maps-css', $base.'front2maps.css', ['leaflet-css'], $css_ver);
    wp_enqueue_script(
      'back2maps-js',
      $base.'hates2map.js',
      ['leaflet-js','topojson-client','papaparse','xlsx','turf'],
      $js_ver,
      true
    );

    /* ---------- Data files (robust auto-pick) ---------- */

    // States (GeoJSON)
    $states_url = $base.'australian-states.min.geojson';

    // Regional divisions: try common names/extensions
    $div_candidates = [
      'regional_div.topo.json',
      'regional_div.json',
      'regional_div.geojson',
    ];
    $divisions_url = '';
    foreach ($div_candidates as $fname) {
      if (file_exists($dir.$fname)) { $divisions_url = $base.$fname; break; }
    }

    // Suburb lookup
    $suburbs_url = file_exists($dir.'suburbs.json') ? $base.'suburbs.json' : '';

    // CIO data: prefer XLSX, else CSV
    $cio_xlsx = $dir.'data/cio_loc_data.xlsx';
    $cio_csv  = $dir.'data/cio_loc_data.csv';
    $cio_url  = file_exists($cio_xlsx) ? $base.'data/cio_loc_data.xlsx'
              : (file_exists($cio_csv) ? $base.'data/cio_loc_data.csv' : '');

    wp_localize_script('back2maps-js', 'B2M', [
      'statesGeoJSON'    => esc_url_raw($states_url),
      'divisionsGeoJSON' => esc_url_raw($divisions_url), // may be empty if not found
      'suburbLookup'     => esc_url_raw($suburbs_url),   // may be empty if not found
      'cioData'          => esc_url_raw($cio_url),       // one of xlsx/csv or empty
    ]);
  }
}
Back2Maps::instance();
