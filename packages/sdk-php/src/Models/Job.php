<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/**
 * A batch, or a render queued with its own webhook URL: its renders in the order of the request and,
 * once they are done, a ZIP of their files.
 */
final class Job
{
    /**
     * @param list<Render>              $items
     * @param array<string, mixed>|null $storage
     * @param array<string, mixed>      $meta
     * @param array<string, mixed>      $raw
     */
    public function __construct(
        public readonly string $id,
        public readonly string $type,
        public readonly string $status,
        public readonly int $total,
        public readonly int $succeeded,
        public readonly int $failed,
        public readonly ?string $zipUrl,
        public readonly ?string $zipExpiresAt,
        public readonly ?array $storage,
        public readonly array $items,
        public readonly array $meta,
        public readonly string $createdAt,
        public readonly ?string $completedAt,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: Fields::string($data, 'id'),
            type: Fields::string($data, 'type'),
            status: Fields::string($data, 'status'),
            total: Fields::int($data, 'total'),
            succeeded: Fields::int($data, 'succeeded'),
            failed: Fields::int($data, 'failed'),
            zipUrl: Fields::stringOrNull($data, 'zip_url'),
            zipExpiresAt: Fields::stringOrNull($data, 'zip_expires_at'),
            storage: Fields::mapOrNull($data, 'storage'),
            items: array_map(Render::fromArray(...), Fields::objects($data, 'items')),
            meta: Fields::map($data, 'meta'),
            createdAt: Fields::string($data, 'created_at'),
            completedAt: Fields::stringOrNull($data, 'completed_at'),
            raw: $data,
        );
    }

    /** No render of it is queued or running any more. */
    public function finished(): bool
    {
        return $this->status !== 'queued' && $this->status !== 'processing';
    }
}
