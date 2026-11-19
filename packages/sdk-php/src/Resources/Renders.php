<?php

declare(strict_types=1);

namespace Formfeed\Resources;

use Formfeed\FormfeedException;
use Formfeed\Internal\Ids;
use Formfeed\Internal\Json;
use Formfeed\Internal\Query;
use Formfeed\Internal\Transport;
use Formfeed\Models\Job;
use Formfeed\Models\Page;
use Formfeed\Models\Render;
use Formfeed\Models\RenderInput;

final class Renders
{
    /** @internal */
    public function __construct(private readonly Transport $transport) {}

    /**
     * Renders a template, HTML, a URL or Markdown. Sync by default, so the answer is the finished
     * render; `'mode' => 'async'` answers it queued. A retry of the same call sends the same
     * Idempotency-Key, generated unless you pass one, so it cannot charge twice.
     *
     * @param array<string, mixed> $request `template` with `data`, or `html`, `url` or `markdown`; `output`, `settings`, …
     */
    public function create(array $request, ?string $idempotencyKey = null): Render
    {
        return Render::fromArray($this->transport->object(
            'POST',
            '/renders',
            Json::objects($request, ['data', 'settings', 'meta']),
            $idempotencyKey ?? Ids::key(),
        ));
    }

    public function get(Render|string $render): Render
    {
        return Render::fromArray($this->transport->object('GET', '/renders/' . Ids::path($render)));
    }

    /**
     * One page of renders, newest first.
     *
     * @param array{template?: string, status?: string, environment?: string, since?: string, until?: string, limit?: int, cursor?: string|null} $query
     *
     * @return Page<Render>
     */
    public function list(array $query = []): Page
    {
        return Page::fromArray($this->transport->object('GET', '/renders' . Query::string($query)), Render::fromArray(...));
    }

    /**
     * Every render the query matches, page by page as you iterate.
     *
     * @param array{template?: string, status?: string, environment?: string, since?: string, until?: string, limit?: int} $query
     *
     * @return \Generator<int, Render>
     */
    public function all(array $query = []): \Generator
    {
        $cursor = null;
        do {
            $page = $this->list([...$query, 'cursor' => $cursor]);
            foreach ($page->data as $render) {
                yield $render;
            }
            $cursor = $page->nextCursor;
        } while ($cursor !== null);
    }

    /** Removes the stored files of a render before they expire. Needs the `file:delete` scope. */
    public function deleteOutputs(Render|string $render): void
    {
        $this->transport->json('DELETE', '/renders/' . Ids::path($render) . '/outputs');
    }

    /**
     * The stored request of a render, to render it again. Needs `render:input`; answers
     * `render_input_expired` (410) when the workspace keeps no requests or the period ended.
     */
    public function input(Render|string $render): RenderInput
    {
        return RenderInput::fromArray($this->transport->object('GET', '/renders/' . Ids::path($render) . '/input'));
    }

    /**
     * Queues many renders as one job; its renders keep the order of `items`.
     *
     * @param array<string, mixed> $request `items`, and `template`, `output`, `settings` shared by them
     */
    public function batch(array $request, ?string $idempotencyKey = null): Job
    {
        return Job::fromArray($this->transport->object(
            'POST',
            '/renders/batch',
            Json::objects($request, ['settings', 'meta']),
            $idempotencyKey ?? Ids::key(),
        ));
    }

    /** Polls until the render succeeded or failed (an async one), at most `$timeout` seconds. */
    public function waitFor(Render|string $render, float $timeout = 120.0, float $interval = 1.0): Render
    {
        $id = Ids::of($render);
        $started = microtime(true);
        $waited = 0.0;
        while (true) {
            $current = $this->get($id);
            if ($current->finished()) {
                return $current;
            }
            if (max(microtime(true) - $started, $waited) + $interval > $timeout) {
                throw new FormfeedException('timeout', "render {$id} did not finish within the wait time");
            }
            $this->transport->wait($interval);
            $waited += $interval;
        }
    }

    /** The output of a finished render, as bytes. */
    public function download(Render|string $render): string
    {
        $target = is_string($render) ? $this->get($render) : $render;
        if ($target->downloadUrl === null) {
            throw new FormfeedException('not_ready', "render {$target->id} has no output ({$target->status})");
        }

        return $this->transport->download($target->downloadUrl);
    }

    /** Writes the output of a finished render to a file; answers the bytes written. */
    public function downloadTo(Render|string $render, string $path): int
    {
        $written = file_put_contents($path, $this->download($render));
        if ($written === false) {
            throw new \RuntimeException("cannot write {$path}");
        }

        return $written;
    }
}
