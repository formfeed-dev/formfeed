<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing;

use Formfeed\Laravel\Internal\Settings;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Support\Carbon;
use Illuminate\Testing\TestResponse;

/**
 * For a Laravel test case: posts a webhook delivery the way Formfeed sends one, so a test reaches the
 * route behind `formfeed.webhook` through the real signature check.
 *
 *     $this->postFormfeedWebhook('/formfeed/webhook', 'render.completed', $render->raw)->assertNoContent();
 */
trait InteractsWithFormfeedWebhooks
{
    /**
     * Posts the event as JSON with Formfeed's headers, signed now (Laravel's clock) with
     * `FORMFEED_WEBHOOK_SECRET`, or with `$secret` to see a wrong one refused.
     *
     * @param array<string, mixed> $data  the event's `data`: the render, the job or the copy it is about
     * @param array<string, mixed> $event the event's other fields, over the made-up `id`, `created_at`
     *                                    and `workspace_id`
     *
     * @return TestResponse<\Symfony\Component\HttpFoundation\Response>
     */
    public function postFormfeedWebhook(string $uri, string $type, array $data = [], array $event = [], ?string $secret = null): TestResponse
    {
        $app = $this->app ?? throw new \LogicException('postFormfeedWebhook() needs the test case\'s application');
        $secret ??= (new Settings($app->make(Repository::class)))->webhookSecret();
        if ($secret === null) {
            throw new \LogicException('postFormfeedWebhook() signs with FORMFEED_WEBHOOK_SECRET, which is not set; set it in the test, or pass the secret');
        }
        $now = Carbon::now();
        $event = [
            'id' => 'evt_' . bin2hex(random_bytes(16)),
            'type' => $type,
            'created_at' => $now->copy()->utc()->format('Y-m-d\TH:i:s\Z'),
            'workspace_id' => '00000000-0000-4000-8000-000000000000',
            'data' => $data === [] ? new \stdClass() : $data,
            ...$event,
        ];
        $body = json_encode($event, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $timestamp = $now->getTimestamp();

        return $this->call('POST', $uri, [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_ACCEPT' => 'application/json',
            'HTTP_USER_AGENT' => 'Formfeed-Webhooks/1.0',
            'HTTP_WEBHOOK_ID' => is_string($event['id']) ? $event['id'] : '',
            'HTTP_WEBHOOK_TIMESTAMP' => (string) $timestamp,
            'HTTP_WEBHOOK_ATTEMPT' => '1',
            'HTTP_WEBHOOK_SIGNATURE' => FormfeedFake::signature($secret, $body, $timestamp),
        ], $body);
    }
}
