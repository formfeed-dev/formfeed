<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/** A file of the workspace's library: an image or PDF a template names, served at `url`. */
final class LibraryFile
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public readonly string $id,
        public readonly string $name,
        public readonly string $contentType,
        public readonly int $bytes,
        public readonly string $sha256,
        public readonly string $url,
        public readonly string $createdAt,
        public readonly string $updatedAt,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: Fields::string($data, 'id'),
            name: Fields::string($data, 'name'),
            contentType: Fields::string($data, 'content_type'),
            bytes: Fields::int($data, 'bytes'),
            sha256: Fields::string($data, 'sha256'),
            url: Fields::string($data, 'url'),
            createdAt: Fields::string($data, 'created_at'),
            updatedAt: Fields::string($data, 'updated_at'),
            raw: $data,
        );
    }
}
