<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/** A template of the workspace, without its versions' content. */
final class Template
{
    /**
     * @param list<string>         $tags
     * @param array<string, mixed> $raw
     */
    public function __construct(
        public readonly string $id,
        public readonly string $slug,
        public readonly string $name,
        public readonly ?string $description,
        public readonly string $kind,
        public readonly string $engine,
        public readonly array $tags,
        public readonly ?int $publishedVersion,
        public readonly int $latestVersion,
        public readonly string $createdAt,
        public readonly string $updatedAt,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            id: Fields::string($data, 'id'),
            slug: Fields::string($data, 'slug'),
            name: Fields::string($data, 'name'),
            description: Fields::stringOrNull($data, 'description'),
            kind: Fields::string($data, 'kind'),
            engine: Fields::string($data, 'engine'),
            tags: Fields::strings($data, 'tags'),
            publishedVersion: Fields::intOrNull($data, 'published_version'),
            latestVersion: Fields::int($data, 'latest_version'),
            createdAt: Fields::string($data, 'created_at'),
            updatedAt: Fields::string($data, 'updated_at'),
            raw: $data,
        );
    }
}
