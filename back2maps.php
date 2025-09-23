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

    // Leaflet
    wp_enqueue_style('leaflet-css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',[], '1.9.4');
    wp_enqueue_script('leaflet-js','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',[], '1.9.4', true);

    // TopoJSON client (safe even if your file is plain GeoJSON)
    wp_enqueue_script(
      'topojson-client',
      'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js',
      [],
      '3.1.0',
      true
    );
    wp_enqueue_script('back2maps-js', $base.'hates2map.js', ['leaflet-js','topojson-client'], filemtime($js_file), true);


    // Your assets (cache-busted safely)
    $css_file = $dir.'front2maps.css';
    $js_file  = $dir.'hates2map.js';
    $css_ver  = file_exists($css_file) ? filemtime($css_file) : '1.0.0';
    $js_ver   = file_exists($js_file)  ? filemtime($js_file)  : '1.0.0';

    wp_enqueue_style ('back2maps-css', $base.'front2maps.css', ['leaflet-css'], $css_ver);
    wp_enqueue_script('back2maps-js',  $base.'hates2map.js', ['leaflet-js','topojson-client'], $js_ver, true);

    // Data files (adjust names if yours differ)
    $states_url    = $base.'australian-states.min.geojson';
    $divisions_url = $base.'regional_div.json'; // can be .geojson or TopoJSON .json

    wp_localize_script('back2maps-js', 'B2M', [
      'statesGeoJSON'    => esc_url_raw($states_url),
      'divisionsGeoJSON' => esc_url_raw($divisions_url),
    ]);
  }
}
Back2Maps::instance();
