<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\Internal\Ids;
use Formfeed\Internal\Multipart;
use Formfeed\Internal\Query;
use Formfeed\Internal\Transport;
use Formfeed\Models\LibraryFile;
use Formfeed\Models\Page;
use Formfeed\Upload;

/**
 * The workspace's file library: images and PDFs a template names with `asset('logo.png')`, and the
 * sources of image watermarks and merges. Needs `file:read`, `file:write` or `file:delete`. Files are
 * served without a signature, so keep confidential documents out of it.
 */
final class Files
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /** Uploads a file; one of the same name is replaced in place and keeps its URL. */
    public function upload(Upload $file): LibraryFile
    {
        return LibraryFile::fromArray($this->transport->object('POST', '/files', new Multipart(['name' => $file->name], $file)));
    }

    /**
     * One page of files, newest first.
     *
     * @param array{prefix?: string, limit?: int, cursor?: string|null} $query `prefix` keeps the names that start with it
     *
     * @return Page<LibraryFile>
     */
    public function list(array $query = []): Page
    {
        return Page::fromArray($this->transport->object('GET', '/files' . Query::string($query)), LibraryFile::fromArray(...));
    }

    /**
     * Every file the query matches, page by page as you iterate.
     *
     * @param array{prefix?: string, limit?: int} $query
     *
     * @return \Generator<int, LibraryFile>
     */
    public function all(array $query = []): \Generator
    {
        $cursor = null;
        do {
            $page = $this->list([...$query, 'cursor' => $cursor]);
            foreach ($page->data as $file) {
                yield $file;
            }
            $cursor = $page->nextCursor;
        } while ($cursor !== null);
    }

    public function get(LibraryFile|string $file): LibraryFile
    {
        return LibraryFile::fromArray($this->transport->object('GET', '/files/' . Ids::path($file)));
    }

    /** Removes the file and its bytes; templates that name it render a missing image afterwards. */
    public function delete(LibraryFile|string $file): void
    {
        $this->transport->json('DELETE', '/files/' . Ids::path($file));
    }
}
