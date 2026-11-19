<?php

declare(strict_types=1);

// The API as HttpTest needs it, served by `php -S`: it writes what arrived to the file
// FORMFEED_HTTP_LOG names and answers a finished render, a problem for /v1/missing, and for
// /v1/slow the render two seconds late.

$log = (string) getenv('FORMFEED_HTTP_LOG');
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
file_put_contents($log, json_encode([
    'method' => $_SERVER['REQUEST_METHOD'] ?? null,
    'path' => $path,
    'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
    'idempotency_key' => $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? null,
    'body' => file_get_contents('php://input'),
], JSON_THROW_ON_ERROR));

if ($path === '/v1/missing') {
    http_response_code(404);
    header('Content-Type: application/problem+json');
    header('X-Request-Id: req_404');
    echo json_encode(['type' => 'https://docs.formfeed.dev/errors/not-found', 'title' => 'Not found', 'status' => 404, 'detail' => 'No such thing', 'code' => 'not_found'], JSON_THROW_ON_ERROR);

    return;
}
if ($path === '/v1/slow') {
    sleep(2);
}

header('Content-Type: application/json');
echo json_encode([
    'id' => 'rnd_1',
    'status' => 'succeeded',
    'output' => 'pdf',
    'download_url' => null,
    'expires_at' => null,
    'bytes' => null,
    'page_count' => 1,
    'units' => 1,
    'region' => 'eu',
    'environment' => 'test',
    'template' => null,
    'meta' => new stdClass(),
    'created_at' => '2026-11-18T10:00:00Z',
    'completed_at' => '2026-11-18T10:00:01Z',
], JSON_THROW_ON_ERROR);
