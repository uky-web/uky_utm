<?php

namespace Drupal\uky_utm\Form;

use Drupal\Core\Form\ConfigFormBase;
use Drupal\Core\Form\FormStateInterface;

/**
 * Settings form for UKY UTM.
 */
class UtmSettingsForm extends ConfigFormBase {

  /**
   * {@inheritdoc}
   */
  public function getFormId() {
    return 'uky_utm_settings_form';
  }

  /**
   * {@inheritdoc}
   */
  protected function getEditableConfigNames() {
    return ['uky_utm.settings'];
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state) {
    $config = $this->config('uky_utm.settings');

    // Preserve nested values.
    $form['#tree'] = TRUE;

    $form['#prefix'] = '<div id="uky-utm-form-wrapper">';
    $form['#suffix'] = '</div>';

    // Attach small admin helper to show document.referrer preview.
    $form['#attached']['library'][] = 'uky_utm/admin';

    // Cookie & capture settings.
    $form['cookie'] = [
      '#type' => 'details',
      '#title' => $this->t('Cookie & capture'),
      '#open' => TRUE,
    ];

    $form['cookie']['cookie_name'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Cookie name'),
      '#default_value' => $config->get('cookie_name') ?: 'utm_session',
      '#required' => TRUE,
      '#description' => $this->t('Name of the JSON cookie that stores the UTM bag (e.g., utm_session).'),
    ];

    $form['cookie']['ttl_minutes'] = [
      '#type' => 'number',
      '#title' => $this->t('Cookie TTL (minutes)'),
      '#default_value' => (int) ($config->get('ttl_minutes') ?? 30),
      '#min' => 1,
      '#step' => 1,
    ];

    $form['cookie']['landing_mode'] = [
      '#type' => 'select',
      '#title' => $this->t('Landing page mode'),
      '#default_value' => $config->get('landing_mode') ?: 'absolute',
      '#options' => [
        'absolute' => $this->t('Full URL (with query)'),
        'absoluteNoQuery' => $this->t('Full URL (no query)'),
        'path' => $this->t('Path only'),
        'path+query' => $this->t('Path + query'),
      ],
    ];

    $form['cookie']['debug'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Enable console debug'),
      '#default_value' => (bool) ($config->get('debug') ?? TRUE),
    ];

    // --- Traffic Referrer assignment -----------------------------------------
    $form['referrer'] = [
      '#type' => 'details',
      '#title' => $this->t('Traffic Referrer'),
      '#open' => TRUE,
      '#description' => $this->t('Assign the browser referrer (document.referrer) to a specific field (always overwrites).'),
    ];

    $form['referrer']['referrer_enabled'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Assign Traffic Referrer to a field'),
      '#default_value' => (bool) ($config->get('referrer_enabled') ?? FALSE),
    ];

    // Live preview (populated by admin.js). Shows "Direct Traffic" when empty.
    $form['referrer']['referrer_preview'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Referrer (preview from your browser)'),
      '#default_value' => '',
      '#attributes' => ['data-uky-utm-referrer-preview' => '1'],
      '#disabled' => TRUE,
      '#description' => $this->t('This is document.referrer as seen on this page. On direct visits, shows "Direct Traffic".'),
    ];

    $attr_options = [
      'id' => 'id',
      'name' => 'name',
      'class' => 'class',
      'placeholder' => 'placeholder',
      'title' => 'title',
      'value' => 'value',
      'data-utm' => 'data-utm',
      'data-drupal-selector' => 'data-drupal-selector',
      'aria-label' => 'aria-label',
      'default' => 'default (legacy token attr)',
    ];

    $form['referrer']['referrer_attribute_name'] = [
      '#type' => 'select',
      '#title' => $this->t('Form attribute'),
      '#options' => $attr_options,
      '#default_value' => $config->get('referrer_attribute_name') ?: 'id',
      '#states' => [
        'visible' => [
          ':input[name="referrer[referrer_enabled]"]' => ['checked' => TRUE],
        ],
      ],
    ];

    $form['referrer']['referrer_attribute_value'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Attribute value'),
      '#default_value' => $config->get('referrer_attribute_value') ?: '',
      '#placeholder' => 'e.g., edit-referrer, rfi_referrer',
      '#states' => [
        'visible' => [
          ':input[name="referrer[referrer_enabled]"]' => ['checked' => TRUE],
        ],
      ],
    ];

    // --- UTM Mappings (simplified) -------------------------------------------
    $form['mappings_fs'] = [
      '#type' => 'details',
      '#title' => $this->t('UTM mappings'),
      '#open' => TRUE,
      '#description' => $this->t('Add one row per field to populate from the UTM cookie. Always overwrites.'),
    ];

    // Prefer in-progress values during AJAX add, else use saved config.
    $saved = $config->get('mappings') ?: [];
    $working = $form_state->get('mappings_temp');
    if ($working === NULL) {
      $working = $saved;
      $form_state->set('mappings_temp', $working);
    }

    $row_count = $form_state->get('row_count');
    if ($row_count === NULL) {
      $row_count = max(1, count($working));
      $form_state->set('row_count', $row_count);
    }

    $form['mappings_fs']['mappings'] = [
      '#type' => 'table',
      '#header' => [
        $this->t('UTM key'),
        $this->t('Attribute'),
        $this->t('Attribute value'),
      ],
      '#empty' => $this->t('No mappings yet. Click "Add row".'),
      '#tree' => TRUE,
      '#sticky' => TRUE,
    ];

    for ($i = 0; $i < $row_count; $i++) {
      $row = $working[$i] ?? [];

      $form['mappings_fs']['mappings'][$i]['utm_key'] = [
        '#type' => 'textfield',
        '#default_value' => $row['utm_key'] ?? '',
        '#placeholder' => 'source, medium, campaign, landingpage',
      ];
      $form['mappings_fs']['mappings'][$i]['attribute_name'] = [
        '#type' => 'select',
        '#options' => $attr_options,
        '#default_value' => $row['attribute_name'] ?? 'id',
      ];
      $form['mappings_fs']['mappings'][$i]['attribute_value'] = [
        '#type' => 'textfield',
        '#default_value' => $row['attribute_value'] ?? '',
        '#placeholder' => 'e.g., edit-email, rfi_source',
      ];
    }

    $form['mappings_actions'] = ['#type' => 'actions'];
    $form['mappings_actions']['add_row'] = [
      '#type' => 'submit',
      '#value' => $this->t('Add row'),
      '#submit' => ['::addRow'],
      '#limit_validation_errors' => [],
      '#ajax' => [
        'callback' => '::ajaxRebuild',
        'wrapper' => 'uky-utm-form-wrapper',
      ],
    ];

    return parent::buildForm($form, $form_state);
  }

  /**
   * AJAX callback to rebuild form when adding rows.
   */
  public function ajaxRebuild(array &$form, FormStateInterface $form_state) {
    return $form;
  }

  /**
   * Add-row handler.
   */
  public function addRow(array &$form, FormStateInterface $form_state) {
    $current = $form_state->getValue(['mappings_fs', 'mappings']);
    if ($current === NULL) {
      $current = $form_state->get('mappings_temp') ?? [];
    }
    $current[] = ['utm_key' => '', 'attribute_name' => 'id', 'attribute_value' => ''];
    $form_state->set('mappings_temp', array_values($current));
    $form_state->set('row_count', count($current));
    $form_state->setRebuild(TRUE);
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state) {
    // Save referrer section.
    $ref_enabled = (bool) ($form_state->getValue(['referrer', 'referrer_enabled']) ?? FALSE);
    $ref_attr_name = $form_state->getValue(['referrer', 'referrer_attribute_name']) ?? 'id';
    $ref_attr_value = trim($form_state->getValue(['referrer', 'referrer_attribute_value']) ?? '');

    // Save mappings rows.
    $rows = $form_state->getValue(['mappings_fs', 'mappings']) ?? [];
    $clean = [];
    foreach ($rows as $row) {
      $utm_key = trim($row['utm_key'] ?? '');
      $attr_name = $row['attribute_name'] ?? 'id';
      $attr_value = trim($row['attribute_value'] ?? '');
      if ($utm_key === '' && $attr_value === '') {
        continue;
      }
      $clean[] = [
        'utm_key' => $utm_key,
        'attribute_name' => $attr_name,
        'attribute_value' => $attr_value,
      ];
    }

    // Cookie & flags.
    $cookie_name = $form_state->getValue(['cookie', 'cookie_name']) ?? 'utm_session';
    $ttl_minutes = (int) ($form_state->getValue(['cookie', 'ttl_minutes']) ?? 30);
    $landing_mode = $form_state->getValue(['cookie', 'landing_mode']) ?? 'absolute';
    $debug = (bool) ($form_state->getValue(['cookie', 'debug']) ?? TRUE);

    $this->configFactory()->getEditable('uky_utm.settings')
      ->set('cookie_name', $cookie_name)
      ->set('ttl_minutes', $ttl_minutes)
      ->set('landing_mode', $landing_mode)
      ->set('debug', $debug)
      ->set('referrer_enabled', $ref_enabled)
      ->set('referrer_attribute_name', $ref_attr_name)
      ->set('referrer_attribute_value', $ref_attr_value)
      ->set('mappings', $clean)
      ->save();

    $form_state->set('mappings_temp', $clean);
    $form_state->set('row_count', max(1, count($clean)));

    parent::submitForm($form, $form_state);
  }

}
