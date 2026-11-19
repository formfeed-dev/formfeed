<?php

declare(strict_types=1);

// Formfeed's settings: `php artisan vendor:publish --tag=formfeed-config` copies this file to
// config/formfeed.php. The first four come from .env.

return [
    // An API key of the workspace, made on the app's Keys page. Renders with an ff_live_… key count
    // against the plan's units; renders with an ff_test_… key do not, and are kept 24 hours at most.
    'key' => env('FORMFEED_API_KEY'),

    // The workspace's region: eu (Frankfurt), where every workspace is today. Ignored with a base_url.
    'region' => env('FORMFEED_REGION', 'eu'),

    // The API's address with /v1, for a gateway other than the region's, such as a local one.
    'base_url' => env('FORMFEED_BASE_URL'),

    // The signing secret (whsec_…) the formfeed.webhook middleware checks deliveries with: the
    // endpoint's, or during development the one `formfeed listen` prints.
    'webhook_secret' => env('FORMFEED_WEBHOOK_SECRET'),

    // How far a delivery's signature time may be from this server's clock, in seconds.
    'webhook_tolerance' => 300,

    // Retries on 429, 503 and network errors, waiting as long as the API asks; 0 turns them off.
    'max_retries' => 3,

    // Seconds a request may take, for the HTTP client the SDK picks itself (Guzzle in Laravel).
    'timeout' => 120,
];
