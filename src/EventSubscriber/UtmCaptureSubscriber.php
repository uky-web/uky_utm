<?php

namespace Drupal\uky_utm\EventSubscriber;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Render\HtmlResponse;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\Cookie;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Captures UTM query values and persists them.
 */
class UtmCaptureSubscriber implements EventSubscriberInterface {
  protected const SESSION_KEY = 'uky_utm.values';
  protected const COOKIE_NAME = 'utm_session';
  protected const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days.
  protected const UTM_PARAMS = ['source', 'medium', 'campaign', 'content', 'term'];
  protected const META_PARAMS = ['utm_string', 'landing_url', 'query_string', 'captured'];

  protected TimeInterface $time;
  protected array $captured = [];

  /**
   * Constructs the subscriber.
   */
  public function __construct(TimeInterface $time) {
    $this->time = $time;
  }

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents() {
    return [
      KernelEvents::REQUEST => ['onKernelRequest', 35],
      KernelEvents::RESPONSE => ['onKernelResponse', -35],
    ];
  }

  /**
   * Get the configured cookie name
   *
   * @return string
   */
  public static function getCookieName(): string {
    return self::COOKIE_NAME;
  }

  /**
   * Parse any `utm_*` query string parameters as an associative array.
   *
   * @param  Request $request
   * @return array
   */
  public function extractUtmValues(Request $request): array {
    $keys = self::UTM_PARAMS;
    $values = [];
    foreach ($keys as $key) {
      $value = $request->query->get('utm_' . $key);
      if ($value !== NULL && $value !== '') {
        $values[$key] = $value;
      }
    }
    // Preserve entire UTM string for reference.
    if (!empty($values)) {
      $pairs = [];
      foreach ($keys as $key) {
        if (isset($values[$key])) {
          $pairs[] = 'utm_' . $key . '=' . $values[$key];
        }
      }
      $values['utm_string'] = implode('&', $pairs);
    }
    return $values;
  }

  /**
   * Return an unserialized value for a stored cookie.
   *
   * @param  string  $name    The name of the cookie to fetch.
   * @param  Request $request A request object, defaulting to the current Drupal request.
   * @return mixed            The unserialized cookie value.
   */
  public function getCookie(string $name, ?Request $request = NULL): mixed {
    $request = $request ?? \Drupal::request();
    $cookie = $request->cookies->get($name);

    if (empty($cookie)) {
      return NULL;
    }
    return unserialize($request->cookies->get($name));
  }

  /**
   * Store a cookie with a given value.
   *
   * @param  string       $name     The cookie name to set.
   * @param  mixed        $value    The value of the cookie. Will be serialized.
   * @param  HtmlResponse $response The response object to attach the cookie to.
   * @param  int          $expires  How long in seconds the cookie should be valid for.
   * @param  string       $path
   * @return void
   */
  public function setCookie(
    string $name,
    mixed $value,
    HtmlResponse $response,
    int $expires = self::COOKIE_TTL,
    string $path = '/'): void {

    if (!is_string($value)) {
      $value = serialize($value);
    }

    $cookie = new Cookie($name, $value);
    $response->headers->setCookie($cookie);
  }

  /**
   * Get a UTM value from a hierarchy of local storage sources.
   *
   * @param  string       $name        The name of the param to fetch, excluding the `utm_` prefix.
   * @param  bool|boolean $forceCookie If true, will only fetch values from stored cookies, not the current query string.
   * @return string|null               The value of the UTM param if set, NULL otherwise.
   */
  public function getUtmValue(string $name, bool $forceCookie = FALSE): ?string {
    if (!$forceCookie) {
      // First check for values already captured during the current request
      if (array_key_exists($name, $this->captured)) {
        return $this->captured[$name];
      }

      // Fall back to re-capturing values from the current query string
      $values = $this->extractUtmValues(\Drupal::request());

      if (array_key_exists($name, $values)) {
        return $values[$name];
      }
    }

    // Fall back (or if $forceCookie is TRUE) to fetching data from stored cookies
    $cookie = $this->getCookie(self::COOKIE_NAME);

    if (is_array($cookie) && array_key_exists($name, $cookie)) {
      return $cookie[$name];
    }

    return NULL;
  }

  /**
   * Get an array of all stored UTM values, either from the query string or cookie storage.
   *
   * @param  bool|boolean $forceCookie If true, will only fetch values from stored cookies, not the current query string.
   * @return array
   */
  public function getAllUtmValues(bool $forceCookie = FALSE): array {
    $values = [];

    foreach(array_merge(self::UTM_PARAMS, self::META_PARAMS) as $name) {
      $value = $this->getUtmValue($name, $forceCookie);
      if (!empty($value)) {
        $values[$name] = $value;
      }
    }

    return $values;
  }

  /**
   * Request hook. Parses query string for UTM parameters.
   *
   * @param  RequestEvent $event
   * @return void
   */
  public function onKernelRequest(RequestEvent $event): void {
    if (!$event->isMainRequest()) {
      return;
    }

    $request = $event->getRequest();
    $values = $this->extractUtmValues($request);

    if (empty($values)) {
      return;
    }

    $values['captured'] = $this->time->getRequestTime();
    $values['landing_url'] = $request->getUri();
    $values['query_string'] = $request->getQueryString() ?? '';

    $this->captured = $values;
  }

  /**
   * Response hook. Checks for captured query string values and writes to browser cookies.
   *
   * @param  ResponseEvent $event
   * @return void
   */
  public function onKernelResponse(ResponseEvent $event): void {
    if (!$event->isMainRequest()) {
      return;
    }

    // Store any captured values in a cookie
    $values = $this->captured;

    if (empty($values)) {
      return;
    }

    $this->setCookie(self::COOKIE_NAME, $values, $event->getResponse());
  }
}