<?php
if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    add_action('rest_api_init',      [$this, 'register_routes']);
    add_action('admin_menu',         [$this, 'add_admin_page']); // NEW: Admin page hook
  }

  /* ---------- Shortcode ---------- */
  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts(['id' => 'back2maps-root'], $atts, 'back2maps');
      ob_start(); ?>
      <div id="<?php echo esc_attr($atts['id']); ?>" class="back2maps"></div>
      <?php return ob_get_clean();
    });
  }

  /* ---------- Assets ---------- */
  public function enqueue_assets() {
    $base     = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Leaflet
    wp_enqueue_style('leaflet-css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_script('leaflet-js',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',  [], '1.9.4', true);

    // Our assets (cache-busted)
    $css_ver = file_exists($base_dir.'front2maps.css') ? filemtime($base_dir.'front2maps.css') : '1.0.0';
    $js_ver  = file_exists($base_dir.'hates2map.js')   ? filemtime($base_dir.'hates2map.js')   : '1.0.0';
    wp_enqueue_style('back2maps-css', $base.'front2maps.css', ['leaflet-css'], $css_ver);
    wp_enqueue_script('back2maps-js', $base.'hates2map.js', ['leaflet-js'], $js_ver, true);

    // Optional files (safe if missing)
    $regions_url = $base . 'australian-states.min.geojson';
    $metrics_url = $base . 'assets/region_metrics.json';

    wp_localize_script('back2maps-js', 'B2M', [
      'restUrl'        => esc_url_raw( rest_url('back2maps/v1') ),
      'nonce'          => wp_create_nonce('wp_rest'),
      'regionsGeoJSON' => esc_url_raw($regions_url),
      'metricsJSON'    => esc_url_raw($metrics_url),
    ]);
  }

  /* ---------- REST API ---------- */
  public function register_routes() {
    // Health
    register_rest_route('back2maps/v1', '/ping', [
      'methods'  => 'GET',
      'callback' => fn()=> ['ok'=>true, 'time'=>current_time('mysql')],
      'permission_callback' => '__return_true'
    ]);

    // NEW: Test data endpoint (CSV -> JSON)
    register_rest_route('back2maps/v1', '/testdata', [
      'methods'  => 'GET',
      'callback' => function() {
        $csvPath = plugin_dir_path(__FILE__) . 'testData.csv';
        if (!file_exists($csvPath)) {
          return ['rows' => [], 'error' => 'CSV not found'];
        }
        $rows = array_map('str_getcsv', file($csvPath));
        $headers = array_map('trim', array_shift($rows));
        $data = [];
        foreach ($rows as $r) {
          $row = [];
          foreach ($headers as $i => $h) $row[$h] = $r[$i] ?? '';
          $data[] = $row;
        }
        return ['rows' => $data, 'count' => count($data)];
      },
      'permission_callback' => '__return_true'
    ]);

  }

  /* ---------- Admin Page ---------- */
  public function add_admin_page() {
    add_menu_page(
      'Back2Maps Reports',     // Page title
      'Back2Maps',             // Menu label
      'manage_options',        // Capability
      'back2maps-reports',     // Menu slug
      [$this, 'render_admin_page'], // Callback
      'dashicons-location',    // Icon
      90                       // Position
    );
  }

  public function render_admin_page() {
    echo '<div class="wrap"><h1>Back2Maps — Review Reports</h1>';
    echo '<p>Here you can review and moderate submitted reports.</p>';
    echo '<div id="b2m-admin-root">';
    echo '<p><em>This is where we can load ambiguous postcodes or report data via JS.</em></p>';
    echo '</div>';
    echo '</div>';
  }
}

Back2Maps::instance();
