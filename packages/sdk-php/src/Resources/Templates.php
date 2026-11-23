<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Json;
use Formfeed\Internal\Query;
use Formfeed\Internal\Transport;
use Formfeed\Models\Page;
use Formfeed\Models\Template;

/**
 * The workspace's templates, read and checked. Writing them (versions, publishing, channels) is the
 * command line's and the app's; `Client::request()` reaches those calls.
 */
final class Templates
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /**
     * One page of templates.
     *
     * @param array{kind?: string, engine?: string, tag?: string, q?: string, limit?: int, cursor?: string|null} $query
     *
     * @return Page<Template>
     */
    public function list(array $query = []): Page
    {
        return Page::fromArray($this->transport->object('GET', '/templates' . Query::string($query)), Template::fromArray(...));
    }

    /**
     * Every template the query matches, page by page as you iterate.
     *
     * @param array{kind?: string, engine?: string, tag?: string, q?: string, limit?: int} $query
     *
     * @return \Generator<int, Template>
     */
    public function all(array $query = []): \Generator
    {
        $cursor = null;
        do {
            $page = $this->list([...$query, 'cursor' => $cursor]);
            foreach ($page->data as $template) {
                yield $template;
            }
            $cursor = $page->nextCursor;
        } while ($cursor !== null);
    }

    /** A template by its slug, `tpl_…` id or UUID. */
    public function get(string $idOrSlug): Template
    {
        return Template::fromArray($this->transport->object('GET', '/templates/' . rawurlencode($idOrSlug)));
    }

    /**
     * The JSON Schema of the template's data: stored, else inferred from the sample data. Of the
     * published (else the latest) version, or of `$version`: `published`, `latest`, a number or a
     * channel name.
     *
     * @return array<string, mixed>
     */
    public function schema(string $idOrSlug, string|int|null $version = null): array
    {
        return $this->transport->object(
            'GET',
            '/templates/' . rawurlencode($idOrSlug) . '/schema' . Query::string(['version' => $version]),
        );
    }

    /**
     * Checks a version with data without rendering: syntax, header and footer, missing partials,
     * runtime errors and the data against the stored schema. Free. Without `data`, the version's
     * sample data is checked.
     *
     * @param array{version?: string|int, data?: array<string, mixed>} $input
     *
     * @return array<string, mixed> `ok`, the `template` checked and the `diagnostics` found
     */
    public function validate(string $idOrSlug, array $input = []): array
    {
        return $this->transport->object(
            'POST',
            '/templates/' . rawurlencode($idOrSlug) . '/validate',
            Json::objects($input, ['data']),
        );
    }
}
