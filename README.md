# UKY UTM Capture Module

This module does one main job:

> **Capture UTM parameters from incoming URLs, store them, and make them available everywhere in Drupal**
> – via tokens, and via `drupalSettings` for JavaScript.

This README walks through the code step-by-step so you can understand exactly what’s happening and where.

---

## High-Level Overview

When a visitor hits your site with UTM parameters, e.g.

```text
https://example.com/programs?utm_source=google&utm_medium=cpc&utm_campaign=spring2026
```

this module:

1. **Reads UTM values from the query string** on the initial request.
2. **Builds a structured array** containing:
   - Standard UTM pieces: `source`, `medium`, `campaign`, `content`, `term`
   - Meta info: full UTM string, full landing URL, full query string, and a timestamp.
3. **Stores that array in a cookie** (named `utm_session`) on the response.
4. **Provides a service API** to:
   - Get one UTM value by name (`getUtmValue('source')`, etc.).
   - Get all known values as a single array (`getAllUtmValues()`).
5. **Exposes everything as Drupal tokens**, so you can use them in things like:
   - Email templates
   - Webform handlers
   - Tokenized field values
6. **Passes the captured values into JS** via `drupalSettings.utmSession`, so your front-end code can use them too.

The bulk of this behavior lives in:

- `src/EventSubscriber/UtmCaptureSubscriber.php`
- `uky_utm.module`

---

## 1. `UtmCaptureSubscriber` – Capturing & Storing UTM Data

Namespace:
`Drupal\uky_utm\EventSubscriber\UtmCaptureSubscriber`

Implements:
`EventSubscriberInterface`

Subscribes to Symfony kernel events:

```php
public static function getSubscribedEvents() {
  return [
    KernelEvents::REQUEST => ['onKernelRequest', 35],
    KernelEvents::RESPONSE => ['onKernelResponse', -35],
  ];
}
```

So it runs:

- **Early in the REQUEST cycle** (`onKernelRequest`) to capture query parameters.
- **Late in the RESPONSE cycle** (`onKernelResponse`) to write any captured data to cookies.

### 1.1. Constants

```php
protected const SESSION_KEY = 'uky_utm.values';
protected const COOKIE_NAME = 'utm_session';
protected const COOKIE_TTL = 60 * 60 * 24 * 30; // 30 days.
protected const UTM_PARAMS = ['source', 'medium', 'campaign', 'content', 'term'];
protected const META_PARAMS = ['utm_string', 'landing_url', 'query_string', 'captured'];
```

- `COOKIE_NAME`: Cookie where all UTM data is stored.
- `COOKIE_TTL`: Intended lifetime in seconds (30 days) – note that expiration isn’t actually passed into `Cookie` in the current implementation (see “Notes / Caveats” below).
- `UTM_PARAMS`: The main UTM fields this module understands.
- `META_PARAMS`: Extra data derived from the initial request.

### 1.2. Constructor & Time Service

```php
public function __construct(TimeInterface $time) {
  $this->time = $time;
}
```

The class uses `TimeInterface` to get a **request timestamp** when values are captured. That’s stored as the `captured` meta field.

### 1.3. `extractUtmValues(Request $request): array`

This method pulls UTM values out of the request query string.

```php
foreach ($keys as $key) {
  $value = $request->query->get('utm_' . $key);
  if ($value !== NULL && $value !== '') {
    $values[$key] = $value;
  }
}
```

- Looks for keys like `utm_source`, `utm_medium`, etc.
- Only stores non-empty values in `$values`.

Then, if any UTM values were found, it builds a canonical `utm_string`:

```php
if (!empty($values)) {
  $pairs = [];
  foreach ($keys as $key) {
    if (isset($values[$key])) {
      $pairs[] = 'utm_' . $key . '=' . $values[$key];
    }
  }
  $values['utm_string'] = implode('&', $pairs);
}
```

**Resulting array example:**

```php
[
  'source'     => 'google',
  'medium'     => 'cpc',
  'campaign'   => 'spring2026',
  'utm_string' => 'utm_source=google&utm_medium=cpc&utm_campaign=spring2026',
]
```

*(Other UTM keys like `content` / `term` are included if present.)*

### 1.4. `getCookie(string $name, ?Request $request = NULL): mixed`

Fetches and **unserializes** a cookie value:

```php
$request = $request ?? \Drupal::request();
$cookie = $request->cookies->get($name);

if (empty($cookie)) {
  return NULL;
}
return unserialize($request->cookies->get($name));
```

- Defaults to the current Drupal request if no `Request` is passed.
- Returns `NULL` if no cookie is set.
- Otherwise, returns the unserialized value (expected to be an array of UTM data).

### 1.5. `setCookie(...)`

```php
public function setCookie(
  string $name,
  mixed $value,
  HtmlResponse $response,
  int $expires = self::COOKIE_TTL,
  string $path = '/'
): void {
  if (!is_string($value)) {
    $value = serialize($value);
  }

  $cookie = new Cookie($name, $value);
  $response->headers->setCookie($cookie);
}
```

- Serializes any non-string value.
- Creates a `Cookie` object and attaches it to the response.
- Note: the `$expires` and `$path` parameters exist but are not actually passed into the `Cookie` constructor, so as written this sets a **session cookie**, not a 30-day persistent cookie.

### 1.6. `getUtmValue(string $name, bool $forceCookie = FALSE): ?string`

This method encapsulates **where** a UTM value comes from and in what priority:

1. **Captured during current request** (if any)
2. **Re-parsed from the current query string**
3. **Read from the stored cookie**

```php
if (!$forceCookie) {
  if (array_key_exists($name, $this->captured)) {
    return $this->captured[$name];
  }

  $values = $this->extractUtmValues(\Drupal::request());
  if (array_key_exists($name, $values)) {
    return $values[$name];
  }
}

$cookie = $this->getCookie(self::COOKIE_NAME);

if (is_array($cookie) && array_key_exists($name, $cookie)) {
  return $cookie[$name];
}

return NULL;
```

So:

- **Fresh data wins:** If you’re on the same page load where UTM values were captured, those values are returned.
- If not, the method tries to see whether the current request still has UTM parameters.
- If none of that works, it falls back to whatever is stored in the `utm_session` cookie.

If `$forceCookie` is `TRUE`, it skips the current request entirely and only reads from the cookie.

### 1.7. `getAllUtmValues(bool $forceCookie = FALSE): array`

Builds a **complete dictionary** of all UTM and meta values that are available:

```php
$values = [];

foreach(array_merge(self::UTM_PARAMS, self::META_PARAMS) as $name) {
  $value = $this->getUtmValue($name, $forceCookie);
  if (!empty($value)) {
    $values[$name] = $value;
  }
}

return $values;
```

The result may look like:

```php
[
  'source'      => 'google',
  'medium'      => 'cpc',
  'campaign'    => 'spring2026',
  'utm_string'  => 'utm_source=google&utm_medium=cpc&utm_campaign=spring2026',
  'landing_url' => 'https://example.com/programs?utm_source=google&utm_medium=cpc&utm_campaign=spring2026',
  'query_string'=> 'utm_source=google&utm_medium=cpc&utm_campaign=spring2026',
  'captured'    => 1732199172,
]
```

Any keys that are missing or empty simply won’t be included.

### 1.8. `onKernelRequest(RequestEvent $event): void`

This is where the **initial capture** happens.

```php
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
```

Step-by-step:

1. Only runs for the **main** HTTP request (ignores sub-requests).
2. Extracts UTM values from the **current URL**.
3. If there are none, it does nothing.
4. If there *are* UTM values:
   - Records a `captured` timestamp.
   - Adds `landing_url` (full URL, including scheme, host, path, query).
   - Adds `query_string` (raw query string).
5. Stores everything in the `$captured` property for use later in the same request.

### 1.9. `onKernelResponse(ResponseEvent $event): void`

This is where any **captured** values get written out as a cookie.

```php
if (!$event->isMainRequest()) {
  return;
}

$values = $this->captured;

if (empty($values)) {
  return;
}

$this->setCookie(self::COOKIE_NAME, $values, $event->getResponse());
```

- Only runs for the main response.
- If nothing was captured during `onKernelRequest`, it does nothing.
- If values were captured, it calls `setCookie()` to write them to `utm_session`.

---

## 2. Token Integration (`uky_utm.module`)

The module exposes the captured values as **Drupal tokens**, which lets you use them in:

- Tokenized fields
- Email messages
- Webform handlers
- Views, etc.

### 2.1. `uky_utm_token_info()`

Registers a new token type called `uky_utm` and defines individual tokens.

```php
'types' => [
  'uky_utm' => [
    'name' => t('UKY UTM'),
    'description' => t('UTM parameters captured from visitor query strings.'),
  ],
],
```

Tokens are defined like:

```php
'tokens' => [
  'uky_utm' => [
    'source' => [
      'name' => t('UTM source'),
      'description' => t('Value of the utm_source parameter.'),
    ],
    // ...
    'utm-string' => [
      'name' => t('UTM string'),
      'description' => t('Concatenated UTM query string captured for the visitor.'),
    ],
    'landing-url' => [
      'name' => t('Landing URL'),
      'description' => t('Full URL where the UTM parameters were captured.'),
    ],
    'query-string' => [
      'name' => t('Query string'),
      'description' => t('Full query string present when the UTM parameters were captured.'),
    ],
    'captured' => [
      'name' => t('Captured timestamp'),
      'description' => t('Unix timestamp for when the UTM values were stored.'),
    ],
    'all' => [
      'name' => t('All values'),
      'description' => t('JSON encoded object containing every captured UTM value.'),
    ],
  ],
],
```

**Examples of actual token strings you can use:**

- `[uky_utm:source]` – value of `utm_source`
- `[uky_utm:medium]`
- `[uky_utm:campaign]`
- `[uky_utm:utm-string]` – the whole UTM query string as captured
- `[uky_utm:landing-url]`
- `[uky_utm:query-string]`
- `[uky_utm:captured]` – Unix timestamp
- `[uky_utm:all]` – JSON‐encoded bundle of all known values

### 2.2. `uky_utm_tokens(...)`

This is the implementation of `hook_tokens()` that actually provides values for the tokens.

```php
function uky_utm_tokens(string $type, array $tokens, array $data, array $options, BubbleableMetadata $metadata): array {
  $metadata->addCacheContexts(['session']);
  $replacements = [];
  $utm_service = \Drupal::service('uky_utm.capture_subscriber');

  if ($type === 'uky_utm') {
    foreach ($tokens as $name => $original) {
      switch($name) {
        case 'source':
        case 'medium':
        case 'campaign':
        case 'content':
        case 'term':
          $replacements[$original] = $utm_service->getUtmValue($name);
          break;

        case 'utm-string':
          $replacements[$original] = $utm_service->getUtmValue('utm_string');
          break;

        case 'landing-url':
          $replacements[$original] = $utm_service->getUtmValue('landing_url');
          break;

        case 'query-string':
          $replacements[$original] = $utm_service->getUtmValue('query_string');
          break;

        case 'captured':
          $replacements[$original] = $utm_service->getUtmValue('captured');
          break;

        case 'all':
          $replacements[$original] = json_encode($utm_service->getAllUtmValues());
          break;
      }
    }
  }

  return $replacements;
}
```

Key points:

1. **Cache context:**

   ```php
   $metadata->addCacheContexts(['session']);
   ```

   This tells Drupal that token values depend on the user’s **session**, so Drupal won’t wrongly cache a page with one visitor’s UTM token values and serve those to others.

2. **Service usage:**

   ```php
   $utm_service = \Drupal::service('uky_utm.capture_subscriber');
   ```

   This is the same `UtmCaptureSubscriber` we discussed earlier, used as the data source for tokens.

3. **Token → internal key mapping:**

   - Token name `source` → internal key `'source'`
   - Token name `utm-string` → internal key `'utm_string'`
   - Token name `landing-url` → internal key `'landing_url'`
   - Token name `query-string` → internal key `'query_string'`

4. **All values token `[uky_utm:all]`:**

   Returns `json_encode($utm_service->getAllUtmValues())`.

   Example output:

   ```json
   {
     "source": "google",
     "medium": "cpc",
     "campaign": "spring2026",
     "utm_string": "utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
     "landing_url": "https://example.com/programs?utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
     "query_string": "utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
     "captured": 1732199172
   }
   ```

---

## 3. Passing UTM Data to JavaScript

The last function in `uky_utm.module` exposes UTM data to the front-end.

```php
/**
 * Pass stored UTM params to JS for use as needed.
 *
 * Implements hook_preprocess_node()
 *
 * @param  array  &$variables
 * @return void
 */
function uky_utm_page_attachments(array &$variables): void {
  $utm_service = \Drupal::service('uky_utm.capture_subscriber');
  $node = $variables['node'];

  $variables['#attached']['library'][] = 'uky_utm/utm_tokens';
  $variables['#attached']['drupalSettings']['utmSession'] = $utm_service->getAllUtmValues();
}
```

> **Note:** Despite the docblock mentioning `hook_preprocess_node()`, the function name `uky_utm_page_attachments` matches `hook_page_attachments()`. The exact hook this is wired to depends on how it’s declared in the `.module`/YAML, but the idea is the same: it attaches assets and settings to page render arrays.

What it does:

1. Fetches all current UTM values:

   ```php
   $utm_service = \Drupal::service('uky_utm.capture_subscriber');
   $variables['#attached']['drupalSettings']['utmSession'] = $utm_service->getAllUtmValues();
   ```

2. Attaches a library named `uky_utm/utm_tokens`:

   ```php
   $variables['#attached']['library'][] = 'uky_utm/utm_tokens';
   ```

   (This library definition would live in `uky_utm.libraries.yml` – not shown here.)

**Result in JS:**

On the client side, you get:

```js
drupalSettings.utmSession = {
  source: "google",
  medium: "cpc",
  campaign: "spring2026",
  utm_string: "utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
  landing_url: "https://example.com/programs?utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
  query_string: "utm_source=google&utm_medium=cpc&utm_campaign=spring2026",
  captured: 1732199172
};
```

Your JS in the `utm_tokens` library (or elsewhere) can then:

- Attach UTM tags to outbound links.
- Fire analytics events with UTM context.
- Store or display information about how the user arrived at this page.

---

## 4. Request Lifecycle Summary (End-to-End)

**First visit with UTM parameters:**

1. Visitor hits `/programs?utm_source=google&utm_medium=cpc`.
2. `onKernelRequest()` runs:
   - `extractUtmValues()` finds `source = google`, `medium = cpc`.
   - `utm_string` built as `utm_source=google&utm_medium=cpc`.
   - `captured`, `landing_url`, `query_string` added.
   - `$this->captured` populated with all of this.
3. Drupal builds a response.
4. `onKernelResponse()` runs:
   - Sees `$this->captured` is not empty.
   - Calls `setCookie('utm_session', $values, $response)`.
   - Browser receives a `utm_session` cookie with serialized data.
5. On the rendered page:
   - `[uky_utm:*]` tokens on that request resolve via `getUtmValue()` using `$this->captured`.
   - `drupalSettings.utmSession` gets the **same** values from `getAllUtmValues()`.

**Subsequent page views (no UTM in URL):**

1. Visitor navigates to `/program-details`.
2. `onKernelRequest()`:
   - `extractUtmValues()` finds nothing in the query string.
   - `$this->captured` stays empty.
3. `onKernelResponse()`:
   - No captured values → no new cookie is set (existing cookie remains).
4. Tokens & JS:
   - `getUtmValue()` falls back to `getCookie('utm_session')`.
   - `getAllUtmValues()` reads from the cookie as well.
   - `[uky_utm:*]` tokens and `drupalSettings.utmSession` still reflect the original UTM values from the very first landing page.

---

## 5. Notes / Caveats

A few implementation details worth calling out:

1. **Cookie TTL vs implementation**

   - `COOKIE_TTL` is defined as 30 days, but `setCookie()` does **not** pass that into the `Cookie` constructor.
   - As written, this likely creates a **session cookie** (ends when the browser is closed).
   - If you actually want a 30-day persistent cookie, you’d need to pass `$expires` to the `Cookie` constructor.

2. **Unserialize on cookie values**

   - `getCookie()` does `unserialize()` on a value coming from a client-controlled cookie.
   - In general, unserializing untrusted data is risky; this is something to be aware of if you extend this module further or use it in environments with stricter security requirements.

3. **Service coupling**

   - Tokens and JS attachment both rely on the `uky_utm.capture_subscriber` service.
   - This is good for centralizing logic: all reads go through the same place that manages precedence (captured → query → cookie).

4. **Cache context**

   - Adding `session` cache context in `uky_utm_tokens()` is important; any time you rely on per-visitor data, make sure you also align your caching strategy appropriately.

---

## 6. Quick Usage Examples

### 6.1. Tokens in an email template

Use `[uky_utm:source]` to log where a user originally came from:

> “You originally found us through `[uky_utm:source]`.”

Or log full JSON blob with `[uky_utm:all]` into a system log or CRM field.

### 6.2. JS usage

In your `utm_tokens` library JS:

```js
(function (Drupal, drupalSettings) {
  Drupal.behaviors.utmExample = {
    attach: function (context, settings) {
      const utm = settings.utmSession || {};
      if (utm.source) {
        console.log('User source:', utm.source);
      }
    }
  };
})(Drupal, drupalSettings);
```

---

That’s the full picture of what this module is doing:

- **Capture once** on a landing page,
- **Persist via cookie**,
- **Expose everywhere** via tokens and `drupalSettings`.