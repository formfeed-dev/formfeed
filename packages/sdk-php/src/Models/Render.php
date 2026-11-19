<?php

declare(strict_types=1);

namespace Formfeed\Models;

use Formfeed\Internal\Fields;

/**
 * A render: its status, its output's signed link and what it cost. `raw` holds the answer as the API
 * sent it, fields of later API versions included.
 */
final class Render
{
    /**
     * @param array<string, mixed>|null $template    id, slug, version, and channel and canary where they apply
     * @param array<string, mixed>|null $storage     the copy to the workspace's own bucket
     * @param array<string, mixed>|null $einvoice    the e-invoice report
     * @param array<string, mixed>|null $accessibility the PDF/UA-1 verdict
     * @param array<string, mixed>|null $pdfa        the PDF/A verdict
     * @param array<string, mixed>|null $form        what a fill did
     * @param array<string, mixed>|null $timings     milliseconds per stage
     * @param array<string, mixed>|null $error       code and message of a failed render
     * @param array<string, mixed>      $meta
     * @param array<string, mixed>      $raw
     */
    public function __construct(
        public readonly string $id,
        public readonly string $status,
        public readonly string $output,
        public readonly ?string $downloadUrl,
        public readonly ?string $expiresAt,
        public readonly ?int $bytes,
        public readonly ?int $pageCount,
        public readonly float $units,
        public readonly string $region,
        public readonly string $environment,
        public readonly ?array $template,
        public readonly ?string $engineVersion,
        public readonly ?string $outputSha256,
        public readonly bool $deduplicated,
        public readonly ?array $storage,
        public readonly ?array $einvoice,
        public readonly ?array $accessibility,
        public readonly ?array $pdfa,
        public readonly ?array $form,
        public readonly ?array $timings,
        public readonly ?array $error,
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
            status: Fields::string($data, 'status'),
            output: Fields::string($data, 'output'),
            downloadUrl: Fields::stringOrNull($data, 'download_url'),
            expiresAt: Fields::stringOrNull($data, 'expires_at'),
            bytes: Fields::intOrNull($data, 'bytes'),
            pageCount: Fields::intOrNull($data, 'page_count'),
            units: Fields::float($data, 'units'),
            region: Fields::string($data, 'region'),
            environment: Fields::string($data, 'environment'),
            template: Fields::mapOrNull($data, 'template'),
            engineVersion: Fields::stringOrNull($data, 'engine_version'),
            outputSha256: Fields::stringOrNull($data, 'output_sha256'),
            deduplicated: Fields::bool($data, 'deduplicated'),
            storage: Fields::mapOrNull($data, 'storage'),
            einvoice: Fields::mapOrNull($data, 'einvoice'),
            accessibility: Fields::mapOrNull($data, 'accessibility'),
            pdfa: Fields::mapOrNull($data, 'pdfa'),
            form: Fields::mapOrNull($data, 'form'),
            timings: Fields::mapOrNull($data, 'timings'),
            error: Fields::mapOrNull($data, 'error'),
            meta: Fields::map($data, 'meta'),
            createdAt: Fields::string($data, 'created_at'),
            completedAt: Fields::stringOrNull($data, 'completed_at'),
            raw: $data,
        );
    }

    /** Succeeded or failed: nothing will change any more. */
    public function finished(): bool
    {
        return $this->status === 'succeeded' || $this->status === 'failed';
    }
}
