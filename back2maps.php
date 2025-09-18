<?php
if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;

  public static function instance() { return self::$instance ??= new self(); }

  /** Hook into WP on construction */
  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);   // Adds [back2maps] shortcode
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);       // Loads CSS/JS on front-end
    add_action('rest_api_init',      [$this, 'register_routes']);      // Registers REST API endpoints
  }

  /** Shortcode: outputs container div */
  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts(['id' => 'back2maps-root'], $atts, 'back2maps');
      ob_start(); ?>
      <div id="<?php echo esc_attr($atts['id']); ?>" class="back2maps"></div>
      <?php return ob_get_clean();
    });
  }

  /** Enqueues Leaflet + plugin assets and passes data to JS */
  public function enqueue_assets() {
    $base = plugin_dir_url(__FILE__);
    $dir  = plugin_dir_path(__FILE__);

    // Leaflet
    wp_enqueue_style('leaflet-css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',[], '1.9.4');
    wp_enqueue_script('leaflet-js','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',[], '1.9.4', true);

    // Plugin assets with cache-busting
    $css_file = $dir.'front2maps.css';
    $js_file  = $dir.'hates2map.js';
    $css_ver  = file_exists($css_file) ? filemtime($css_file) : '1.0.0';
    $js_ver   = file_exists($js_file)  ? filemtime($js_file)  : '1.0.0';

    wp_enqueue_style('back2maps-css', $base.'front2maps.css', ['leaflet-css'], $css_ver);
    wp_enqueue_script('back2maps-js', $base.'hates2map.js', ['leaflet-js'], $js_ver, true);

    // Pass REST + GeoJSON URLs to JS
    // Data files
    $states_url    = $base.'australian-states.min.geojson';   // background states
    $divisions_url = $base.'regional_divisons.geojson';       // << your actual filename
    $suburbs_url   = $base.'suburbs.json';

    wp_localize_script('back2maps-js', 'B2M', [
      'restUrl'          => esc_url_raw(rest_url('back2maps/v1')),
      'nonce'            => wp_create_nonce('wp_rest'),
      'statesGeoJSON'    => esc_url_raw($states_url),
      'divisionsGeoJSON' => esc_url_raw($divisions_url),
      'suburbLookup'     => esc_url_raw($suburbs_url),
    ])
  }

  /** Registers REST API routes (/ping, /testdata) */
  public function register_routes() {
    // Health check
    register_rest_route('back2maps/v1', '/ping', [
      'methods'  => 'GET',
      'callback' => fn()=> ['ok'=>true,'time'=>current_time('mysql')],
      'permission_callback' => '__return_true'
    ]);

    // CSV -> JSON data endpoint
    register_rest_route('back2maps/v1', '/testdata', [
      'methods'  => 'GET',
      'callback' => function() {
        $path = plugin_dir_path(__FILE__).'testData.csv';
        if (!file_exists($path)) return ['rows'=>[], 'count'=>0, 'error'=>'CSV not found'];

        $fh = fopen($path, 'r');
        if (!$fh) return ['rows'=>[], 'count'=>0, 'error'=>'CSV open failed'];

        $headers = fgetcsv($fh);
        if (!$headers) { fclose($fh); return ['rows'=>[], 'count'=>0, 'error'=>'CSV empty']; }
        $headers = array_map('trim', $headers);

        $rows = [];
        while (($r = fgetcsv($fh)) !== false) {
          $row = [];
          foreach ($headers as $i => $h) $row[$h] = $r[$i] ?? '';
          $rows[] = $row;
        }
        fclose($fh);
        return ['rows'=>$rows, 'count'=>count($rows)];
      },
      'permission_callback' => '__return_true'
    ]);
  }
}

Back2Maps::instance();
