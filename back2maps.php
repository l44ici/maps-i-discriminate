<?php
/**
 * Plugin Name: Back2Maps
 * Description: Clean-slate Leaflet map with optional regions + metrics (no legend, no forms).
 * Version: 1.0.0
 * Author: You
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    add_action('rest_api_init',      [$this, 'register_routes']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts(['id' => 'back2maps-root'], $atts, 'back2maps');
      ob_start(); ?>
      <div id="<?php echo esc_attr($atts['id']); ?>" class="back2maps"></div>
      <?php return ob_get_clean();
    });
  }

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
  }
}
Back2Maps::instance();
