<?php


if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() {
    if (self::$instance === null) self::$instance = new self();
    return self::$instance;
  }
  private function __construct() {
    add_action('init', [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
    add_action('rest_api_init', [$this, 'register_routes']);
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

    // Leaflet plugin :PPP
    wp_enqueue_style('leaflet-css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_enqueue_script('leaflet-js',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',  [], '1.9.4', true);

    // Other files 
    $css_ver = file_exists($base_dir.'front2maps.css') ? filemtime($base_dir.'front2maps.css') : '0.1.0';
    $js_ver  = file_exists($base_dir.'hates2map.js')   ? filemtime($base_dir.'hates2map.js')   : '0.1.0';
    wp_enqueue_style('back2maps-css', $base.'front2maps.css', ['leaflet-css'], $css_ver);
    wp_enqueue_script('back2maps-js', $base.'hates2map.js', ['leaflet-js'], $js_ver, true);

    // Path to regions GeoJSON - make file later
    $regions_url = $base . 'au_regions.geojson';
    wp_localize_script('back2maps-js', 'B2M', [
      'restUrl'        => esc_url_raw( rest_url('back2maps/v1') ),
      'nonce'          => wp_create_nonce('wp_rest'),
      'regionsGeoJSON' => esc_url_raw($regions_url)
    ]);
  }

  public function register_routes() {
    register_rest_route('back2maps/v1', '/ping', [
      'methods'  => 'GET',
      'callback' => fn()=> ['ok'=>true, 'time'=>current_time('mysql')],
      'permission_callback' => '__return_true'
    ]);

    // Stubbed counts per region_id - replace with real data later. 
    // Might need to change code structure later especially with customised regional divisions
    register_rest_route('back2maps/v1', '/region-metrics', [
      'methods'  => 'GET',
      'callback' => function() {
        return ['metrics' => [
          'NSW_METRO'=>42,'NSW_RURAL'=>13,
          'QLD_SE'=>27,'QLD_NORTH'=>9,
          'VIC_METRO'=>36,'VIC_RURAL'=>11,
          'WA_PERTH'=>15,'WA_REG'=>6,
          'SA_METRO'=>8,'SA_REG'=>4,
          'TAS_ALL'=>5,'NT_ALL'=>3,'ACT_ALL'=>7,
        ]];
      },
      'permission_callback' => '__return_true'
    ]);
  }
}
Back2Maps::instance();
