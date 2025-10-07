<?php
/**
 * Plugin Name: Back2Maps – Hate Map
 * Description: Shortcode + assets for the interactive hate map.
 * Version: 1.2.0
 */

if (!defined('ABSPATH')) exit;

final class Back2Maps_Plugin {
  public function __construct() {
    add_action('init',              [$this, 'register_shortcode']);
    add_action('wp_enqueue_scripts',[$this, 'enqueue_assets']);
  }

  public function register_shortcode() {
    add_shortcode('back2maps', function($atts){
      $atts = shortcode_atts([
        'id'       => 'back2maps-root',
        'title'    => '',
        'subtitle' => '',
        'divzoom'  => '6',
        'markerzoom' => '6'
      ], $atts, 'back2maps');

      ob_start(); ?>
        <div class="back2maps">
          <?php if ($atts['title']) : ?>
            <div class="b2m-card">
              <h2 class="b2m-title"><?php echo esc_html($atts['title']); ?></h2>
              <?php if ($atts['subtitle']) : ?>
                <p class="b2m-sub"><?php echo esc_html($atts['subtitle']); ?></p>
              <?php endif; ?>
              <div id="<?php echo esc_attr($atts['id']); ?>" class="b2m-map"></div>
            </div>
          <?php else : ?>
            <div id="<?php echo esc_attr($atts['id']); ?>" class="b2m-map"></div>
          <?php endif; ?>
        </div>
      <?php return ob_get_clean();
    });
  }

  private function asset_url($rel) {
    return plugin_dir_url(__FILE__) . ltrim($rel, '/');
  }
  private function asset_path($rel) {
    return plugin_dir_path(__FILE__) . ltrim($rel, '/');
  }

  public function enqueue_assets() {
    // Leaflet (WP installs often already have it; load if missing)
    wp_register_style('leaflet', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', [], '1.9.4');
    wp_register_script('leaflet','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', [], '1.9.4', true);

    // Our assets
    wp_enqueue_style('b2m', $this->asset_url('front2maps.css'), ['leaflet'], '1.2.0');
    wp_enqueue_script('b2m', $this->asset_url('hates2map.js'), ['leaflet'], '1.2.0', true);

    // Data file URLs (these are optional except the CSV)
    $data = [
      'rootId'         => 'back2maps-root',
      'restUrl'        => esc_url_raw(rest_url()), // kept for future if you already poll
      'divZoom'        => 6,
      'markerZoom'     => 6,
      // REQUIRED: your CSV of reports (same folder as this PHP)
      'csvUrl'         => $this->asset_url('testData.csv'),
      // OPTIONAL: regional division polygons (GeoJSON preferred; TopoJSON accepted if object name is "regional_div")
      'regionalUrl'    => $this->asset_url('regional_div.json'),
      // OPTIONAL: Australian states GeoJSON (used for state fallback + outline)
      'statesUrl'      => $this->asset_url('australian-states.min.geojson'),
      // OPTIONAL: suburb gazetteer for suburb→lat/lon (JSON [{state,suburb,postcode,lat,lon},...])
      'suburbsUrl'     => $this->asset_url('suburbs.json'),
      // OPTIONAL: postcode index for postcode→division (JSON {"2000":"NSW-REG-07", ...})
      'pcIndexUrl'     => $this->asset_url('postcode-index.json')
    ];
    wp_localize_script('b2m', 'B2M', $data);
  }
}
new Back2Maps_Plugin();
