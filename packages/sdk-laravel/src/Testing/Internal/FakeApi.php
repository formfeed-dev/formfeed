<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing\Internal;

use Formfeed\Laravel\Testing\FakeResponse;
use Formfeed\Laravel\Testing\FormfeedFake;
use Formfeed\Laravel\Testing\FormfeedRequest;
use Illuminate\Support\Carbon;

/**
 * What the fake answers by itself, the way the API does: renders (sync ones finished, async ones
 * queued until they are first read), batches and their jobs, the PDF tools and PDF info, and the files
 * behind the download links. It keeps what it made, so a render can be read, listed, downloaded and
 * waited for. Everything else is the test's to answer.
 *
 * @internal
 */
final class FakeApi
{
    /** Where the fake's files are, under the reserved .test domain. */
    public const FILES = 'https://files.formfeed.test/';

    private const TOOLS = ['merge', 'protect', 'watermark', 'split', 'compress', 'to-image', 'redact', 'fill', 'convert'];

    /** @var array<string, array<string, mixed>> renders by id, as the API answers them */
    private array $renders = [];

    /** @var array<string, array<string, mixed>> the request a render was made from, by render id */
    private array $inputs = [];

    /** @var array<string, array{job: array<string, mixed>, renders: list<string>, zip: bool}> */
    private array $jobs = [];

    /** @var array<string, int> */
    private array $counters = [];

    public function __construct(
        private readonly string $region,
        private readonly string $environment,
    ) {}

    /**
     * The answer to a request, with the keys of `$override` over it, and kept; null for a request the
     * fake does not answer by itself.
     *
     * @param array<string, mixed> $override
     */
    public function answer(FormfeedRequest $request, array $override): ?FakeResponse
    {
        $route = "{$request->method} {$request->path}";
        if ($route === 'POST /renders') {
            return $this->createRender($request->body, $override);
        }
        if ($route === 'POST /renders/batch') {
            return $this->createBatch($request->body, $override);
        }
        if ($route === 'GET /renders') {
            return $this->listRenders($request->query, $override);
        }
        if (($id = self::segment('#^GET /renders/([^/]+)$#', $route)) !== null) {
            return $this->getRender($id, $override);
        }
        if (($id = self::segment('#^GET /renders/([^/]+)/input$#', $route)) !== null) {
            return $this->input($id, $override);
        }
        if (($id = self::segment('#^DELETE /renders/([^/]+)/outputs$#', $route)) !== null) {
            return $this->deleteOutputs($id);
        }
        if (($id = self::segment('#^GET /jobs/([^/]+)$#', $route)) !== null) {
            return $this->getJob($id, $override);
        }
        if ($route === 'POST /pdf/info') {
            return $this->info($request, $override);
        }
        $tool = self::segment('#^POST /pdf/([a-z-]+)$#', $route);
        if ($tool !== null && in_array($tool, self::TOOLS, true)) {
            return $this->tool($tool, $request->body, $override);
        }

        return null;
    }

    /** The file behind one of the fake's links, null for a link it never gave or whose file is deleted. */
    public function download(string $url): ?FakeResponse
    {
        foreach ($this->renders as $render) {
            if (($render['download_url'] ?? null) === $url) {
                $output = self::text($render, 'output') ?? 'pdf';

                return new FakeResponse(200, FakeFiles::for($output, self::pages($render)), ['Content-Type' => FakeFiles::contentType($output)]);
            }
        }
        foreach ($this->jobs as $job) {
            if (($job['job']['zip_url'] ?? null) === $url) {
                return new FakeResponse(200, FakeFiles::zip(), ['Content-Type' => 'application/zip']);
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $body
     * @param array<string, mixed> $override
     */
    private function createRender(array $body, array $override): FakeResponse
    {
        $async = ($body['mode'] ?? null) === 'async';
        $id = $this->id('rnd');
        $output = self::text($body, 'output') ?? 'pdf';
        $render = $this->render($id, $output, self::template($body), $body['meta'] ?? null, $this->units());
        $this->inputs[$id] = $body;

        return new FakeResponse($async ? 202 : 200, $this->keep($async ? $render : $this->finish($render), $override));
    }

    /**
     * @param array<string, mixed> $body
     * @param array<string, mixed> $override
     */
    private function createBatch(array $body, array $override): FakeResponse
    {
        $items = is_array($body['items'] ?? null) ? array_values($body['items']) : [];
        $ids = [];
        $renders = [];
        foreach ($items as $item) {
            $item = is_array($item) ? self::stringKeys($item) : [];
            $request = [
                ...$item,
                'template' => $item['template'] ?? $body['template'] ?? null,
                'output' => $item['output'] ?? $body['output'] ?? null,
            ];
            $id = $this->id('rnd');
            $output = self::text($request, 'output') ?? 'pdf';
            $render = $this->render($id, $output, self::template($request), $item['meta'] ?? null, $this->units());
            $this->renders[$id] = $render;
            $this->inputs[$id] = $request;
            $ids[] = $id;
            $renders[] = $render;
        }

        $job = array_replace([
            'id' => $this->id('job'),
            'type' => 'batch',
            'status' => 'queued',
            'total' => count($renders),
            'succeeded' => 0,
            'failed' => 0,
            'zip_url' => null,
            'zip_expires_at' => null,
            'storage' => null,
            'items' => $renders,
            'meta' => self::map($body['meta'] ?? null),
            'created_at' => self::time(),
            'completed_at' => null,
        ], $override);
        $this->jobs[self::text($job, 'id') ?? ''] = ['job' => $job, 'renders' => $ids, 'zip' => ($body['zip'] ?? false) === true];

        return new FakeResponse(202, $job);
    }

    /**
     * @param array<string, mixed> $query
     * @param array<string, mixed> $override
     */
    private function listRenders(array $query, array $override): FakeResponse
    {
        $renders = array_reverse(array_values($this->renders));
        $renders = array_values(array_filter($renders, static function (array $render) use ($query): bool {
            $template = $query['template'] ?? null;
            if (is_string($template) && $template !== '') {
                $named = is_array($render['template'] ?? null) ? $render['template'] : [];
                if (($named['slug'] ?? null) !== $template && ($named['id'] ?? null) !== $template) {
                    return false;
                }
            }
            foreach (['status', 'environment'] as $field) {
                if (is_string($query[$field] ?? null) && $query[$field] !== '' && ($render[$field] ?? null) !== $query[$field]) {
                    return false;
                }
            }

            return true;
        }));

        return new FakeResponse(200, array_replace(['data' => $renders, 'next_cursor' => null], $override));
    }

    /** @param array<string, mixed> $override */
    private function getRender(string $id, array $override): FakeResponse
    {
        $render = $this->renders[$id] ?? null;
        if ($render === null) {
            return FormfeedFake::problem('not_found', 404, "Render {$id} not found");
        }
        // an async render is done the first time it is read
        if (in_array($render['status'] ?? null, ['queued', 'rendering'], true)) {
            $render = $this->finish($render);
        }

        return new FakeResponse(200, $this->keep($render, $override));
    }

    /** @param array<string, mixed> $override */
    private function input(string $id, array $override): FakeResponse
    {
        $render = $this->renders[$id] ?? null;
        $body = $this->inputs[$id] ?? null;
        if ($render === null || $body === null) {
            return FormfeedFake::problem('not_found', 404, "Render {$id} not found");
        }
        $template = is_array($render['template'] ?? null) ? $render['template'] : null;
        $post = is_array($body['post'] ?? null) ? $body['post'] : null;
        // a stored request never carries a password
        unset($post['password']);

        return new FakeResponse(200, array_replace([
            'render_id' => $id,
            'template' => $template === null ? null : [
                'id' => $template['id'] ?? null,
                'slug' => $template['slug'] ?? null,
                'version' => $template['version'] ?? null,
                'channel' => $template['channel'] ?? null,
            ],
            'data' => is_array($body['data'] ?? null) ? self::map($body['data']) : null,
            'html' => self::text($body, 'html'),
            'markdown' => self::text($body, 'markdown'),
            'url' => self::text($body, 'url'),
            'engine' => self::text($body, 'engine'),
            'locale' => self::text($body, 'locale'),
            'output' => self::text($body, 'output') ?? self::text($render, 'output'),
            'settings' => is_array($body['settings'] ?? null) ? self::map($body['settings']) : null,
            'filename' => self::text($body, 'filename'),
            'post' => $post === null ? null : self::map($post),
            'meta' => self::map($body['meta'] ?? null),
            'environment' => $this->environment,
            'created_at' => $render['created_at'] ?? self::time(),
        ], $override));
    }

    private function deleteOutputs(string $id): FakeResponse
    {
        if (!isset($this->renders[$id])) {
            return FormfeedFake::problem('not_found', 404, "Render {$id} not found");
        }
        $this->renders[$id] = array_replace($this->renders[$id], ['download_url' => null, 'expires_at' => null]);

        return new FakeResponse(204);
    }

    /** @param array<string, mixed> $override */
    private function getJob(string $id, array $override): FakeResponse
    {
        $kept = $this->jobs[$id] ?? null;
        if ($kept === null) {
            return FormfeedFake::problem('not_found', 404, "Job {$id} not found");
        }
        // a batch is done the first time it is read, like an async render
        $items = [];
        foreach ($kept['renders'] as $renderId) {
            $render = $this->renders[$renderId];
            if (in_array($render['status'] ?? null, ['queued', 'rendering'], true)) {
                $render = $this->renders[$renderId] = $this->finish($render);
            }
            $items[] = $render;
        }
        $succeeded = count(array_filter($items, static fn(array $item): bool => ($item['status'] ?? null) === 'succeeded'));
        $failed = count(array_filter($items, static fn(array $item): bool => ($item['status'] ?? null) === 'failed'));
        $zip = $kept['zip'] && $succeeded > 0;
        $job = array_replace($kept['job'], [
            'status' => match (true) {
                $failed === 0 => 'completed',
                $succeeded === 0 => 'failed',
                default => 'partially_failed',
            },
            'succeeded' => $succeeded,
            'failed' => $failed,
            'zip_url' => $zip ? self::FILES . "{$id}.zip" : null,
            'zip_expires_at' => $zip ? $this->expiry() : null,
            'items' => $items,
            'completed_at' => $kept['job']['completed_at'] ?? self::time(),
        ], $override);
        $this->jobs[$id]['job'] = $job;

        return new FakeResponse(200, $job);
    }

    /** @param array<string, mixed> $override */
    private function info(FormfeedRequest $request, array $override): FakeResponse
    {
        $source = $request->file->name ?? self::text($request->body, 'source') ?? 'document.pdf';
        // a render the fake made has the pages it said it had
        $pages = isset($this->renders[$source]) ? self::pages($this->renders[$source]) : 1;

        return new FakeResponse(200, array_replace([
            'source' => $source,
            'page_count' => $pages,
            'pages' => array_fill(0, $pages, ['width_pt' => 595.28, 'height_pt' => 841.89, 'width_mm' => 210.0, 'height_mm' => 297.0]),
            'encrypted' => false,
            'metadata' => ['title' => null, 'author' => null, 'subject' => null, 'producer' => null, 'creator' => null],
            'form' => ['type' => null, 'signed' => false, 'fields' => []],
        ], $override));
    }

    /**
     * @param array<string, mixed> $body
     * @param array<string, mixed> $override
     */
    private function tool(string $tool, array $body, array $override): FakeResponse
    {
        $output = match ($tool) {
            'split' => 'zip',
            'to-image' => self::text($body, 'format') === 'jpg' ? 'jpg' : 'png',
            default => 'pdf',
        };
        $units = $this->environment === 'test' ? 0.0 : ($tool === 'to-image' ? 1.0 : 0.5);
        $render = $this->render($this->id('rnd'), $output, null, $body['meta'] ?? null, $units);

        return new FakeResponse(200, $this->keep($this->finish($render), $override));
    }

    /**
     * A render as the API answers one that is queued.
     *
     * @param array<string, mixed>|null $template
     *
     * @return array<string, mixed>
     */
    private function render(string $id, string $output, ?array $template, mixed $meta, float $units): array
    {
        return [
            'id' => $id,
            'status' => 'queued',
            'output' => $output,
            'download_url' => null,
            'expires_at' => null,
            'bytes' => null,
            'page_count' => null,
            'units' => $units,
            'region' => $this->region,
            'environment' => $this->environment,
            'template' => $template,
            'engine_version' => null,
            'template_checksum' => $template === null ? null : hash('sha256', 'formfeed fake ' . ($template['slug'] ?? '')),
            'output_sha256' => null,
            'deduplicated' => false,
            'storage' => null,
            'einvoice' => null,
            'accessibility' => null,
            'pdfa' => null,
            'form' => null,
            'timings' => null,
            'error' => null,
            'meta' => self::map($meta),
            'created_at' => self::time(),
            'completed_at' => null,
        ];
    }

    /**
     * The render succeeded: its file, link and timings.
     *
     * @param array<string, mixed> $render
     *
     * @return array<string, mixed>
     */
    private function finish(array $render): array
    {
        $output = self::text($render, 'output') ?? 'pdf';
        $id = self::text($render, 'id') ?? '';

        return array_replace($render, [
            'status' => 'succeeded',
            'download_url' => self::FILES . "{$id}." . self::extension($output),
            'expires_at' => $this->expiry(),
            // the pages an override gave the queued render stay
            'page_count' => $output === 'pdf' ? self::pages($render) : null,
            'engine_version' => 'formfeed-laravel fake',
            'timings' => ['queue_ms' => 0, 'compile_ms' => 0, 'render_ms' => 0, 'post_ms' => 0, 'upload_ms' => 0, 'total_ms' => 0],
            'completed_at' => self::time(),
        ]);
    }

    /**
     * Puts the override over a render and keeps it, the size and hash of its file following its
     * output and pages unless the override names them.
     *
     * @param array<string, mixed> $render
     * @param array<string, mixed> $override
     *
     * @return array<string, mixed>
     */
    private function keep(array $render, array $override): array
    {
        $render = array_replace($render, $override);
        if (is_string($render['download_url'] ?? null)) {
            $bytes = FakeFiles::for(self::text($render, 'output') ?? 'pdf', self::pages($render));
            $render['bytes'] = array_key_exists('bytes', $override) ? $render['bytes'] : strlen($bytes);
            $render['output_sha256'] = array_key_exists('output_sha256', $override) ? $render['output_sha256'] : hash('sha256', $bytes);
        }
        $this->renders[self::text($render, 'id') ?? ''] = $render;

        return $render;
    }

    /** A render of up to five pages or one picture costs a unit on a live key, nothing on a test key. */
    private function units(): float
    {
        return $this->environment === 'test' ? 0.0 : 1.0;
    }

    /** The first group of a route's pattern, null when the route is another. */
    private static function segment(string $pattern, string $route): ?string
    {
        return preg_match($pattern, $route, $match) === 1 ? $match[1] : null;
    }

    /** Test outputs are kept for 24 hours; a live one here for seven days, as on the Starter plan. */
    private function expiry(): string
    {
        return self::time($this->environment === 'test' ? 86_400 : 7 * 86_400);
    }

    private function id(string $prefix): string
    {
        $this->counters[$prefix] = ($this->counters[$prefix] ?? 0) + 1;

        return sprintf('%s_%032x', $prefix, $this->counters[$prefix]);
    }

    /**
     * The template a request names, as a render carries it.
     *
     * @param array<string, mixed> $body
     *
     * @return array<string, mixed>|null
     */
    private static function template(array $body): ?array
    {
        $name = self::text($body, 'template');
        if ($name === null) {
            return null;
        }
        $version = $body['version'] ?? null;
        $number = is_int($version) ? $version : (is_string($version) && ctype_digit($version) ? (int) $version : null);
        $channel = $number !== null || $version === 'latest' ? null : (is_string($version) && $version !== '' ? $version : 'published');

        return [
            'id' => str_starts_with($name, 'tpl_') ? $name : 'tpl_' . md5($name),
            'slug' => $name,
            'version' => $number ?? 1,
            'channel' => $channel,
            'canary' => false,
        ];
    }

    /** @param array<string, mixed> $render */
    private static function pages(array $render): int
    {
        $pages = $render['page_count'] ?? null;

        return is_int($pages) && $pages > 0 ? $pages : 1;
    }

    private static function extension(string $output): string
    {
        return $output === 'jpeg' ? 'jpg' : $output;
    }

    private static function time(int $seconds = 0): string
    {
        return Carbon::now()->utc()->addSeconds($seconds)->format('Y-m-d\TH:i:s\Z');
    }

    /** @param array<string, mixed> $values */
    private static function text(array $values, string $key): ?string
    {
        $value = $values[$key] ?? null;

        return is_string($value) && $value !== '' ? $value : null;
    }

    /**
     * A JSON object, also when it is empty (an empty PHP array would be sent as `[]`).
     *
     * @return \stdClass|array<string, mixed>
     */
    private static function map(mixed $value): \stdClass|array
    {
        return is_array($value) && $value !== [] ? self::stringKeys($value) : new \stdClass();
    }

    /**
     * @param array<mixed> $value
     *
     * @return array<string, mixed>
     */
    private static function stringKeys(array $value): array
    {
        $result = [];
        foreach ($value as $key => $item) {
            $result[(string) $key] = $item;
        }

        return $result;
    }
}
