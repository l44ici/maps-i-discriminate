<?php
/**
 * Plugin Name: Back2Maps
 * Description: Leaflet map with state vs regional-division choropleth and CSV/XLSX-driven markers.
 * Version: 1.6.0
 * Author: You
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps {
  private static $instance = null;
  public static function instance() { return self::$instance ??= new self(); }

  private function __construct() {
    add_action('init',               [$this, 'register_shortcode']);
    // Prevent jQuery progressbar errors globally
    add_action('wp_enqueue_scripts', function() {
      wp_add_inline_script('jquery-core', 
        'try{if(window.jQuery&&!jQuery.fn.progressbar){jQuery.fn.progressbar=function(){return this;}}}catch(e){}', 
        'before'
      );
    });
    add_action('wp_enqueue_scripts', [$this, 'enqueue_assets']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts([
        'height'     => '60vh',
        'title'      => 'Back2Maps',
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
    wp_enqueue_style('back2maps-css', $this->url('front2maps.css'), [], '1.6.0');

    // JS libs
    wp_enqueue_script('leaflet',  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);
    wp_enqueue_script('papaparse','https://unpkg.com/papaparse@5.4.1/papaparse.min.js', [], '5.4.1', true);

    // main JS
    wp_enqueue_script(
      'back2maps-js',
      $this->url('hates2map.js'),
      ['leaflet','papaparse'],
      '1.6.0',
      true
    );

    $base_url = plugin_dir_url(__FILE__);
    $divisions_url = $base_url . 'regional_div.geojson';
    $states_url    = $base_url . 'australian-states.min.geojson';
    $csv_url       = $base_url . 'testData.csv';
    $suburbs_url   = $base_url . 'suburbs.json'; // ✅ direct JSON

    wp_localize_script('back2maps-js', 'B2M', [
      'divisionsUrl'       => esc_url_raw($divisions_url),
      'statesUrl'          => esc_url_raw($states_url),
      'cioDataCsv'         => esc_url_raw($csv_url),
      'suburbLookup'       => esc_url_raw($suburbs_url),
      'minZoomForDiv'      => 6,
      'minZoomForMarkers'  => 6,
    ]);
  }
}

Back2Maps::instance();
