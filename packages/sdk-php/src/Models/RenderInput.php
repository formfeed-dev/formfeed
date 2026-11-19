<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/**
 * The stored request of a render, to render it again: a template render carries `template` and
 * `data`, an ad-hoc one `html`, `url` or `markdown`. Passwords are never included.
 */
final class RenderInput
{
    /**
     * @param array<string, mixed>|null $template id, slug, version and channel
     * @param array<string, mixed>|null $data
     * @param array<string, mixed>|null $settings
     * @param array<string, mixed>|null $post
     * @param array<string, mixed>      $meta
     * @param array<string, mixed>      $raw
     */
    public function __construct(
        public readonly string $renderId,
        public readonly ?array $template,
        public readonly ?array $data,
        public readonly ?string $html,
        public readonly ?string $markdown,
        public readonly ?string $url,
        public readonly ?string $engine,
        public readonly ?string $locale,
        public readonly ?string $output,
        public readonly ?array $settings,
        public readonly ?string $filename,
        public readonly ?array $post,
        public readonly array $meta,
        public readonly string $environment,
        public readonly string $createdAt,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            renderId: Fields::string($data, 'render_id'),
            template: Fields::mapOrNull($data, 'template'),
            data: Fields::mapOrNull($data, 'data'),
            html: Fields::stringOrNull($data, 'html'),
            markdown: Fields::stringOrNull($data, 'markdown'),
            url: Fields::stringOrNull($data, 'url'),
            engine: Fields::stringOrNull($data, 'engine'),
            locale: Fields::stringOrNull($data, 'locale'),
            output: Fields::stringOrNull($data, 'output'),
            settings: Fields::mapOrNull($data, 'settings'),
            filename: Fields::stringOrNull($data, 'filename'),
            post: Fields::mapOrNull($data, 'post'),
            meta: Fields::map($data, 'meta'),
            environment: Fields::string($data, 'environment'),
            createdAt: Fields::string($data, 'created_at'),
            raw: $data,
        );
    }
}
