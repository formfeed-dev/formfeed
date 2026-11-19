<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/**
 * What a PDF holds: its pages and their sizes, whether it is encrypted, its metadata, and its form
 * with every field's full name, the names `pdf->fill()` takes.
 */
final class PdfInfo
{
    /**
     * @param list<array<string, mixed>> $pages    width_pt, height_pt, width_mm and height_mm of each page
     * @param array<string, mixed>       $metadata
     * @param array<string, mixed>|null  $form     the fields, each with name, type, value and options
     * @param array<string, mixed>       $raw
     */
    public function __construct(
        public readonly string $source,
        public readonly int $pageCount,
        public readonly array $pages,
        public readonly bool $encrypted,
        public readonly array $metadata,
        public readonly ?array $form,
        public readonly array $raw,
    ) {}

    /** @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        return new self(
            source: Fields::string($data, 'source'),
            pageCount: Fields::int($data, 'page_count'),
            pages: Fields::objects($data, 'pages'),
            encrypted: Fields::bool($data, 'encrypted'),
            metadata: Fields::map($data, 'metadata'),
            form: Fields::mapOrNull($data, 'form'),
            raw: $data,
        );
    }
}
