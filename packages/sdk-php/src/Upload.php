<?php

declare(strict_types=1);

namespace Formfeed;

/**
 * A file sent with a request: a PDF for the PDF tools, an office document to convert, an e-invoice
 * to validate, a file for the library. It is read into memory and sent as multipart; the API keeps
 * only what the library stores.
 */
final class Upload
{
    private function __construct(
        public readonly string $contents,
        public readonly string $name,
        public readonly string $contentType,
    ) {}

    public static function fromPath(string $path, ?string $name = null, ?string $contentType = null): self
    {
        $contents = is_file($path) ? file_get_contents($path) : false;
        if ($contents === false) {
            throw new \InvalidArgumentException("cannot read {$path}");
        }
        $name ??= basename($path);

        return new self($contents, $name, $contentType ?? self::typeOf($name));
    }

    public static function fromString(string $contents, string $name, ?string $contentType = null): self
    {
        return new self($contents, $name, $contentType ?? self::typeOf($name));
    }

    /** What the name says the file is; the API reads the format from the bytes either way. */
    private static function typeOf(string $name): string
    {
        return match (strtolower(pathinfo($name, PATHINFO_EXTENSION))) {
            'pdf' => 'application/pdf',
            'xml' => 'application/xml',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'odt' => 'application/vnd.oasis.opendocument.text',
            'ods' => 'application/vnd.oasis.opendocument.spreadsheet',
            'odp' => 'application/vnd.oasis.opendocument.presentation',
            'rtf' => 'application/rtf',
            'html', 'htm' => 'text/html',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'gif' => 'image/gif',
            'svg' => 'image/svg+xml',
            default => 'application/octet-stream',
        };
    }
}
