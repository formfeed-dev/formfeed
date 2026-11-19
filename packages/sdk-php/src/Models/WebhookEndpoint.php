<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/** A registered webhook endpoint. `secret` is only in the answer that created it. */
final class WebhookEndpoint
{
    /**
     * @param list<string>         $events
     * @param list<string>         $environments
     * @param array<string, mixed> $raw
     */
    public function __construct(
        public readonly string $id,
        public readonly string $url,
        public readonly array $events,
        public readonly array $environments,
        public readonly bool $enabled,
        public readonly ?string $description,
        public readonly int $consecutiveFailures,
        public readonly ?string $secret,
        public readonly string $createdAt,
        public readonly string $updatedAt,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: Fields::string($data, 'id'),
            url: Fields::string($data, 'url'),
            events: Fields::strings($data, 'events'),
            environments: Fields::strings($data, 'environments'),
            enabled: Fields::bool($data, 'enabled', true),
            description: Fields::stringOrNull($data, 'description'),
            consecutiveFailures: Fields::int($data, 'consecutive_failures'),
            secret: Fields::stringOrNull($data, 'secret'),
            createdAt: Fields::string($data, 'created_at'),
            updatedAt: Fields::string($data, 'updated_at'),
            raw: $data,
        );
    }
}
