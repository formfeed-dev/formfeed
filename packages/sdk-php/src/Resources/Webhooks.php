<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Fields;
use Formfeed\Internal\Transport;
use Formfeed\Models\WebhookEndpoint;

/** The workspace's webhook endpoints. Needs `webhook:manage`. Verify a delivery with `Formfeed\Webhook`. */
final class Webhooks
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /** @return list<WebhookEndpoint> */
    public function list(): array
    {
        return array_map(
            WebhookEndpoint::fromArray(...),
            Fields::objects($this->transport->object('GET', '/webhooks'), 'data'),
        );
    }

    /**
     * Registers an endpoint; the answer carries its `secret`, once.
     *
     * @param array{url: string, events?: list<string>, environments?: list<string>, description?: string} $input
     */
    public function create(array $input): WebhookEndpoint
    {
        return WebhookEndpoint::fromArray($this->transport->object('POST', '/webhooks', $input));
    }

    /**
     * @param array{url?: string, events?: list<string>, environments?: list<string>, description?: string|null, enabled?: bool} $patch
     */
    public function update(string $id, array $patch): WebhookEndpoint
    {
        return WebhookEndpoint::fromArray($this->transport->object('PUT', '/webhooks/' . rawurlencode($id), $patch));
    }

    public function delete(string $id): void
    {
        $this->transport->json('DELETE', '/webhooks/' . rawurlencode($id));
    }

    /**
     * Sends a test delivery to the endpoint.
     *
     * @return array<string, mixed> `queued`
     */
    public function test(string $id): array
    {
        return $this->transport->object('POST', '/webhooks/' . rawurlencode($id) . '/test');
    }

    /**
     * Sends a stored event (`evt_…`) again as a new delivery to an endpoint.
     *
     * @return array<string, mixed> the new delivery
     */
    public function resend(string $eventId, string $endpointId): array
    {
        return $this->transport->object(
            'POST',
            '/webhooks/events/' . rawurlencode($eventId) . '/resend',
            ['endpoint_id' => $endpointId],
        );
    }
}
