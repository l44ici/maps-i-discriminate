<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth and CSV/XLSX-driven markers.
 * Version: 1.5.5
 * Author: You
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init', [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    add_action('wp_ajax_b2m_suburbs', [$this, 'serve_suburbs']);
    add_action('wp_ajax_nopriv_b2m_suburbs', [$this, 'serve_suburbs']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts) {
      $atts = shortcode_atts([
        'height' => '60vh',
        'title' => 'Back2Maps',
        'subtitle' => 'Regional choropleth + markers from CSV/XLSX',
        'divzoom' => '6',
        'markerzoom' => '',
      ], $atts);

      $divzoom = is_numeric($atts['divzoom']) ? $atts['divzoom'] : '6';
      $markerzoom = $atts['markerzoom'] === '' ? $divzoom : $atts['markerzoom'];

      ob_start(); ?>
      <div class="back2maps" data-divzoom="<?php echo esc_attr($divzoom); ?>" data-markerzoom="<?php echo esc_attr($markerzoom); ?>">
        <div class="b2m-card">
          <h2 class="b2m-title"><?php echo esc_html($atts['title']); ?></h2>
          <p class="b2m-sub"><?php echo esc_html($atts['subtitle']); ?></p>
          <div id="b2m-map" style="height:<?php echo esc_attr($atts['height']); ?>"></div>
          <div class="b2m-note">Zoom out for state view; zoom in to see regional divisions.</div>
        </div>
      </div>
      <?php return ob_get_clean();
    });
  }

  private function url($rel) { return plugins_url($rel, __FILE__); }
  private function path($rel) { return plugin_dir_path(__FILE__) . ltrim($rel, '/'); }

  public function enqueue_assets() {
    // Core styles + libs
    wp_enqueue_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.5.5');

    wp_enqueue_script('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('xlsx', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', [], '0.18.5', true);
    wp_enqueue_script('back2maps-js', $this->url('hates2map.js'), ['leaflet', 'xlsx'], '1.5.5', true);

    $base_url = plugin_dir_url(__FILE__);
    $base_dir = plugin_dir_path(__FILE__);

    // Files
    $divisions_url = file_exists($base_dir . 'regional_div.geojson')
      ? $base_url . 'regional_div.geojson'
      : $base_url . 'regional_div.json';
    $states_url  = $base_url . 'australian-states.min.geojson';
    $csv_url     = $base_url . 'testData.csv';
    $xlsx_url    = $base_url . 'testData.xlsx';

    // ✅ Serve “suburbs” file through AJAX if it exists
    $suburbs_url = file_exists($base_dir . 'suburbs')
      ? admin_url('admin-ajax.php?action=b2m_suburbs')
      : '';

    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl' => esc_url_raw($divisions_url),
      'statesUrl'    => esc_url_raw($states_url),
      'suburbLookup' => esc_url_raw($suburbs_url),
      'cioDataCsv'   => esc_url_raw($csv_url),
      'cioDataXlsx'  => esc_url_raw($xlsx_url),
      'minZoomForDiv' => 6,
    ]);
  }

  // Serve extension-less "suburbs" file via AJAX
  public function serve_suburbs() {
    $file = $this->path('suburbs');
    if (!file_exists($file)) wp_send_json_error(['error' => 'suburbs file not found'], 404);
    nocache_headers();
    header('Content-Type: application/json; charset=utf-8');
    readfile($file);
    exit;
  }
}

Back2Maps::instance();
