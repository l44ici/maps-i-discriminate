<?php
if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    add_action('rest_api_init',      [$this, 'register_routes']);
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
    $regions_url = $base . 'au_regions.geojson';
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

    // Region metrics: read from assets/region_metrics.json if present; else empty
    register_rest_route('back2maps/v1', '/region-metrics', [
      'methods'  => 'GET',
      'callback' => function() {
        $path_file = plugin_dir_path(__FILE__) . 'assets/region_metrics.json';
        if (file_exists($path_file)) {
          $raw = file_get_contents($path_file);
          $json = json_decode($raw, true);
          if (is_array($json)) return ['metrics' => $json, 'source' => 'file'];
        }
        return ['metrics' => [], 'source' => 'empty'];
      },
      'permission_callback' => '__return_true'
    ]);

    // NEW: Postcodes endpoint (CSV -> JSON)
    register_rest_route('back2maps/v1', '/postcodes', [
      'methods'  => 'GET',
      'callback' => [$this, 'rest_get_postcodes'],
      'permission_callback' => '__return_true'
    ]);
  }

  /* ---------- Helpers for CSV parsing ---------- */

  /** Normalize to 4-digit numeric postcode string */
  private function norm_pc($pc) {
    $pc = preg_replace('/\D+/', '', (string)$pc);
    return str_pad($pc, 4, '0', STR_PAD_LEFT);
  }

  /** Load CSV and build [ 'postcodes' => ..., 'ambiguous' => ..., 'rows' => N ] */
  private function build_postcode_payload() {
    $csvPath = plugin_dir_path(__FILE__) . 'testData.csv';

    if (!file_exists($csvPath)) {
      return new WP_Error('b2m_csv_missing', 'CSV not found. Expected testData.csv in plugin folder.', ['status' => 404]);
    }

    $fh = fopen($csvPath, 'r');
    if ($fh === false) {
      return new WP_Error('b2m_csv_open', 'Failed to open CSV.', ['status' => 500]);
    }

    $headers = fgetcsv($fh);
    if ($headers === false) {
      fclose($fh);
      return new WP_Error('b2m_csv_empty', 'CSV appears empty.', ['status' => 400]);
    }

    // Header indices (case-sensitive to your file)
    $idxSuburb = array_search('Suburb', $headers);
    $idxState  = array_search('State / Territory', $headers);
    $idxPC     = array_search('Post Code', $headers);

    if ($idxSuburb === false || $idxState === false || $idxPC === false) {
      fclose($fh);
      return new WP_Error('b2m_csv_headers', 'CSV must contain headers: Suburb, State / Territory, Post Code', [
        'status'  => 400,
        'headers' => $headers
      ]);
    }

    $postcodes = [];
    $rows = 0;

    while (($row = fgetcsv($fh)) !== false) {
      $rows++;
      $suburb = isset($row[$idxSuburb]) ? trim((string)$row[$idxSuburb]) : '';
      $state  = isset($row[$idxState])  ? trim((string)$row[$idxState])  : '';
      $pcRaw  = isset($row[$idxPC])     ? $row[$idxPC]                  : '';

      $pc = $this->norm_pc($pcRaw);

      if ($pc && $suburb !== '') {
        if (!isset($postcodes[$pc])) $postcodes[$pc] = [];
        $postcodes[$pc][] = ['suburb' => $suburb, 'state' => $state];
      }
    }
    fclose($fh);

    // Build ambiguous list
    $ambiguous = [];
    foreach ($postcodes as $pc => $list) {
      $states  = array_unique(array_map(fn($x) => $x['state'], $list));
      $suburbs = array_unique(array_map(fn($x) => $x['suburb'], $list));
      if (count($states) > 1 || count($suburbs) > 1) {
        $ambiguous[] = ['postcode' => $pc, 'possibilities' => $list];
      }
    }

    return [
      'postcodes' => $postcodes,
      'ambiguous' => $ambiguous,
      'source'    => 'file',
      'rows'      => $rows
    ];
  }

  /** REST callback */
  public function rest_get_postcodes(\WP_REST_Request $request) {
    $payload = $this->build_postcode_payload();
    if (is_wp_error($payload)) {
      return $payload;
    }

    // Optional: light client-side caching hint
    $response = rest_ensure_response($payload);
    // $response->set_headers(['Cache-Control' => 'no-store']); // or max-age=3600 in production
    return $response;
  }
}

Back2Maps::instance();
