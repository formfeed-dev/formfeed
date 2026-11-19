<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Ids;
use Formfeed\Internal\Multipart;
use Formfeed\Internal\Transport;
use Formfeed\Models\LibraryFile;
use Formfeed\Models\PdfInfo;
use Formfeed\Models\Render;
use Formfeed\Upload;

/**
 * The PDF tools, on the output of an earlier render (a `Render` or its id), a PDF of the file library
 * (a `LibraryFile`, its id or its name), or, for info, split, compress, toImage, redact and fill, an
 * `Upload`, which is never stored. Every tool but info answers a new render, on the Starter plan and
 * above: merge, protect, watermark, split, compress, redact and fill cost 0.5 units each on live
 * keys, toImage one unit per picture; info is free.
 */
final class Pdf
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /**
     * Joins PDFs in the order given.
     *
     * @param list<Render|LibraryFile|string> $sources
     * @param array<string, mixed>            $options `filename`, `expires_in`, …
     */
    public function merge(array $sources, array $options = [], ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/merge', [...$options, 'sources' => array_map(Ids::of(...), $sources)], $idempotencyKey);
    }

    /**
     * Encrypts a PDF with AES-256 (`user_password`, `owner_password`, `permissions`).
     *
     * @param array<string, mixed> $options
     */
    public function protect(Render|LibraryFile|string $source, array $options, ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/protect', [...$options, 'source' => Ids::of($source)], $idempotencyKey);
    }

    /**
     * Stamps a text or a library image on the pages.
     *
     * @param array<string, mixed> $options
     */
    public function watermark(Render|LibraryFile|string $source, array $options, ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/watermark', [...$options, 'source' => Ids::of($source)], $idempotencyKey);
    }

    /**
     * Page count, page sizes, encryption, metadata and the form with every field's name, type, value
     * and options, which is how a form's names are found for `fill`. Free; creates no render.
     */
    public function info(Render|LibraryFile|Upload|string $source): PdfInfo
    {
        return PdfInfo::fromArray($this->transport->object('POST', '/pdf/info', self::body($source, [])));
    }

    /**
     * Cuts a PDF into parts, `every` pages each or one per entry of `ranges`: a ZIP of the parts, or
     * the PDF itself for one part.
     *
     * @param array<string, mixed> $options
     */
    public function split(Render|LibraryFile|Upload|string $source, array $options, ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/split', self::body($source, $options), $idempotencyKey);
    }

    /**
     * Makes a PDF smaller; the render keeps the source when it cannot.
     *
     * @param array<string, mixed> $options
     */
    public function compress(Render|LibraryFile|Upload|string $source, array $options = [], ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/compress', self::body($source, $options), $idempotencyKey);
    }

    /**
     * Draws pages as PNG or JPEG pictures: one page answers the picture, several a ZIP of them.
     *
     * @param array<string, mixed> $options `format`, `pages`, `dpi`, …
     */
    public function toImage(Render|LibraryFile|Upload|string $source, array $options = [], ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/to-image', self::body($source, $options), $idempotencyKey);
    }

    /**
     * Removes what lies under the rectangles (`regions`) and every place a text stands (`text`), from
     * the file itself, and reads the result again: text still there fails the render with
     * `redaction_incomplete`, which names regions and texts by number, never a text.
     *
     * @param array<string, mixed> $options
     */
    public function redact(Render|LibraryFile|Upload|string $source, array $options, ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/redact', self::body($source, $options), $idempotencyKey);
    }

    /**
     * Fills a form's fields by their full names (`fields`) and keeps it fillable, or with `flatten`
     * draws the values into the pages. The values are never stored.
     *
     * @param array<string, mixed> $options
     */
    public function fill(Render|LibraryFile|Upload|string $source, array $options, ?string $idempotencyKey = null): Render
    {
        return $this->render('/pdf/fill', self::body($source, $options), $idempotencyKey);
    }

    /**
     * Converts an office document to a PDF render (Starter plan and above): an `Upload` (Word, Excel,
     * PowerPoint, OpenDocument, RTF or HTML, up to 20 MB, not kept), or the output of a Word or
     * PowerPoint template render.
     *
     * @param array<string, mixed> $options
     */
    public function convert(Render|Upload|string $source, array $options = [], ?string $idempotencyKey = null): Render
    {
        return $this->render(
            '/pdf/convert',
            $source instanceof Upload ? new Multipart($options, $source) : [...$options, 'source' => Ids::of($source)],
            $idempotencyKey,
        );
    }

    /**
     * @param array<string, mixed>|Multipart $body
     */
    private function render(string $path, array|Multipart $body, ?string $idempotencyKey): Render
    {
        return Render::fromArray($this->transport->object('POST', $path, $body, $idempotencyKey ?? Ids::key()));
    }

    /**
     * A tool's request: a stored source by its id as JSON, an upload as multipart beside the options.
     *
     * @param array<string, mixed> $options
     *
     * @return array<string, mixed>|Multipart
     */
    private static function body(Render|LibraryFile|Upload|string $source, array $options): array|Multipart
    {
        return $source instanceof Upload
            ? new Multipart($options, $source)
            : [...$options, 'source' => Ids::of($source)];
    }
}
