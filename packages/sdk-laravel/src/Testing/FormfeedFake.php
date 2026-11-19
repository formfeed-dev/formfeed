<?php

declare(strict_types=1);

namespace Formfeed\Laravel\Testing;

use Formfeed\Client;
use Formfeed\Laravel\Testing\Internal\FakeApi;
use Formfeed\Laravel\Testing\Internal\FakeHttpClient;
use Http\Discovery\Psr17FactoryDiscovery;
use Illuminate\Support\Collection;
use PHPUnit\Framework\Assert;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * `Formfeed::fake()`: a real `Formfeed\Client` over a PSR-18 client that never reaches the network.
 * It answers renders, batches, jobs and the PDF tools as the API would (a sync render finished, an
 * async one queued until it is first read, a PDF with the render's pages behind every link) and
 * keeps what it made, so the SDK's `waitFor`, `download` and lists work on it. Any other call needs
 * an answer from the test. Every request it answered is kept for the assertions.
 *
 * An answer is, by `METHOD /path` pattern:
 * - an array: its keys replace those of the fake's own answer, which keeps them (a later read of the
 *   render sees them too); for a call the fake does not answer by itself, the array is the answer;
 * - `FormfeedFake::response()` or `FormfeedFake::problem()`: exactly that answer;
 * - `FormfeedFake::sequence()`: one answer per request, then the fake's own;
 * - a closure, given the `FormfeedRequest`, returning one of these, or null for the fake's own answer.
 */
final class FormfeedFake
{
    private const BASE_URL = 'https://api.formfeed.test/v1';

    /** @var list<array{string, mixed}> pattern and answer, the ones added last first */
    private array $answers = [];

    /** @var list<FormfeedRequest> */
    private array $recorded = [];

    private readonly FakeApi $api;
    private readonly Client $client;
    private readonly ResponseFactoryInterface $responses;
    private readonly StreamFactoryInterface $streams;

    /**
     * @param array<string, mixed> $answers     by `METHOD /path` pattern
     * @param string               $environment `live` or `test`, which renders say they ran in
     */
    public function __construct(array $answers = [], string $region = 'eu', string $environment = 'live')
    {
        $this->api = new FakeApi($region, $environment === 'test' ? 'test' : 'live');
        $this->responses = Psr17FactoryDiscovery::findResponseFactory();
        $this->streams = Psr17FactoryDiscovery::findStreamFactory();
        $this->client = new Client(
            apiKey: 'ff_test_fake',
            baseUrl: self::BASE_URL,
            httpClient: new FakeHttpClient($this->handle(...)),
            streamFactory: $this->streams,
            // the fake answers at once; a test of retries is the SDK's
            maxRetries: 0,
            sleep: static function (float $seconds): void {},
        );
        $this->answer($answers);
    }

    /** The client that sends to the fake; `Formfeed::fake()` binds it in the container. */
    public function client(): Client
    {
        return $this->client;
    }

    /**
     * Adds answers, before the ones given earlier.
     *
     * @param array<array-key, mixed> $answers by `METHOD /path` pattern; a key that is no pattern is refused
     */
    public function answer(array $answers): self
    {
        $added = [];
        foreach ($answers as $pattern => $answer) {
            if (!is_string($pattern) || trim($pattern) === '') {
                throw new \InvalidArgumentException('an answer is keyed by its pattern, such as POST /renders');
            }
            if (!is_array($answer) && !$answer instanceof FakeResponse && !$answer instanceof FakeSequence && !$answer instanceof \Closure) {
                throw new \InvalidArgumentException(
                    "the answer for {$pattern} is " . get_debug_type($answer)
                    . '; give an array, FormfeedFake::response(), problem(), sequence() or a closure',
                );
            }
            $added[] = [$pattern, $answer];
        }
        $this->answers = [...$added, ...$this->answers];

        return $this;
    }

    /**
     * An answer exactly as written: an array as JSON, a string as it is.
     *
     * @param array<mixed>|string|null $body
     * @param array<string, string>    $headers
     */
    public static function response(array|string|null $body = null, int $status = 200, array $headers = []): FakeResponse
    {
        return new FakeResponse($status, $body, $headers);
    }

    /**
     * A problem as the API answers one (RFC 9457), which the SDK throws as a `FormfeedException`
     * with this code, status and detail.
     */
    public static function problem(string $code, int $status = 422, ?string $detail = null): FakeResponse
    {
        $title = ucfirst(str_replace('_', ' ', $code));

        return new FakeResponse($status, [
            'type' => 'https://docs.formfeed.dev/errors/' . str_replace('_', '-', $code),
            'title' => $title,
            'status' => $status,
            'detail' => $detail ?? $title,
            'code' => $code,
            'request_id' => 'req_fake',
        ], ['Content-Type' => 'application/problem+json', 'X-Request-Id' => 'req_fake']);
    }

    /**
     * The keys of a render that failed, as an async render or a batch item reads once it is done:
     * `'GET /renders/*' => FormfeedFake::failed('render_timeout', 'Render exceeded 30000 ms')`.
     * A sync render that fails is a problem instead: `FormfeedFake::problem('template_runtime_error')`.
     *
     * @return array<string, mixed>
     */
    public static function failed(string $code = 'template_runtime_error', string $message = 'Render failed'): array
    {
        return [
            'status' => 'failed',
            'download_url' => null,
            'expires_at' => null,
            'bytes' => null,
            'page_count' => null,
            'output_sha256' => null,
            'timings' => null,
            'error' => ['code' => $code, 'message' => $message],
        ];
    }

    /** Answers in turn, one per matching request, then the fake's own. */
    public static function sequence(mixed ...$answers): FakeSequence
    {
        return new FakeSequence(...$answers);
    }

    /** The `Webhook-Signature` header of a delivery with this body, as Formfeed signs it. */
    public static function signature(string $secret, string $body, int $timestamp): string
    {
        return "t={$timestamp},v1=" . hash_hmac('sha256', "{$timestamp}.{$body}", $secret);
    }

    /**
     * The requests the fake answered, in order, those the callback accepts. Downloads of its files
     * are not among them: they are no calls of the API.
     *
     * @param (\Closure(FormfeedRequest): bool)|null $filter
     *
     * @return Collection<int, FormfeedRequest>
     */
    public function recorded(?\Closure $filter = null): Collection
    {
        $recorded = new Collection($this->recorded);

        return $filter === null ? $recorded : $recorded->filter(static fn(FormfeedRequest $request): bool => $filter($request) === true)->values();
    }

    /**
     * A render was asked for (`POST /renders`): of the template with that slug or id, or for which
     * the callback, given the request's body and the request, answers true; `$times` exactly so often.
     *
     * @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool)|null $template
     */
    public function assertRendered(string|\Closure|null $template = null, ?int $times = null): void
    {
        $this->assertTimes($this->matching('POST /renders', $template), $times, self::described('A render', $template));
    }

    /** @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool) $template */
    public function assertNotRendered(string|\Closure $template): void
    {
        $matching = $this->matching('POST /renders', $template);
        Assert::assertTrue($matching === [], self::described('A render', $template) . ' was asked for ' . self::times(count($matching)) . '.');
    }

    public function assertNothingRendered(): void
    {
        $matching = $this->matching('POST /renders', null);
        Assert::assertTrue($matching === [], 'Renders were asked for: ' . self::list($matching) . '.');
    }

    /**
     * A batch was queued (`POST /renders/batch`), of the template or matching the callback.
     *
     * @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool)|null $template
     */
    public function assertBatched(string|\Closure|null $template = null, ?int $times = null): void
    {
        $this->assertTimes($this->matching('POST /renders/batch', $template), $times, self::described('A batch', $template));
    }

    /** @param \Closure(FormfeedRequest): bool $callback */
    public function assertSent(\Closure $callback, ?int $times = null): void
    {
        $this->assertTimes($this->recorded($callback)->all(), $times, 'A request matching the callback');
    }

    /** @param \Closure(FormfeedRequest): bool $callback */
    public function assertNotSent(\Closure $callback): void
    {
        $matching = $this->recorded($callback)->all();
        Assert::assertTrue($matching === [], 'Requests matching the callback were sent: ' . self::list($matching) . '.');
    }

    public function assertNothingSent(): void
    {
        Assert::assertTrue($this->recorded === [], 'Requests were sent: ' . self::list($this->recorded) . '.');
    }

    public function assertSentCount(int $count): void
    {
        Assert::assertTrue(
            count($this->recorded) === $count,
            "Expected {$count} requests, the fake answered " . count($this->recorded) . '. ' . $this->sent(),
        );
    }

    /** What the fake's PSR-18 client sends: a download of one of its files, or a call of the API. */
    private function handle(RequestInterface $request): ResponseInterface
    {
        $url = (string) $request->getUri();
        if (str_starts_with($url, FakeApi::FILES)) {
            return $this->psr($this->api->download($url) ?? self::problem('not_found', 404, 'No file behind this link'));
        }

        $recorded = FormfeedRequest::from($request, (string) parse_url(self::BASE_URL, PHP_URL_PATH));
        $this->recorded[] = $recorded;
        $answer = $this->stubbed($recorded);
        if ($answer instanceof FakeResponse) {
            return $this->psr($answer);
        }
        $own = $this->api->answer($recorded, $answer ?? []);
        if ($own !== null) {
            return $this->psr($own);
        }
        if ($answer !== null) {
            return $this->psr(new FakeResponse(200, $answer));
        }

        throw new \LogicException(
            "Formfeed::fake() has no answer for {$recorded}: it answers renders, batches, jobs and the PDF tools "
            . "by itself; give this one its answer, as Formfeed::fake(['{$recorded}' => [...]])",
        );
    }

    /**
     * The test's answer for a request: the first pattern that matches and answers.
     *
     * @return FakeResponse|array<mixed>|null
     */
    private function stubbed(FormfeedRequest $request): FakeResponse|array|null
    {
        foreach ($this->answers as [$pattern, $answer]) {
            if (!$request->is($pattern)) {
                continue;
            }
            if ($answer instanceof FakeSequence) {
                $answer = $answer->next();
            }
            if ($answer instanceof \Closure) {
                $answer = $answer($request);
            }
            if ($answer === null) {
                // a closure that left it to the fake, or a sequence that is used up
                continue;
            }
            if (!is_array($answer) && !$answer instanceof FakeResponse) {
                throw new \InvalidArgumentException(
                    "the answer for {$request} is " . get_debug_type($answer)
                    . '; give an array, FormfeedFake::response() or problem(), or null for the fake\'s own',
                );
            }

            return $answer;
        }

        return null;
    }

    /**
     * @param string|(\Closure(array<string, mixed>, FormfeedRequest): bool)|null $template
     *
     * @return list<FormfeedRequest>
     */
    private function matching(string $route, string|\Closure|null $template): array
    {
        $matching = [];
        foreach ($this->recorded as $request) {
            if (!$request->is($route)) {
                continue;
            }
            $hit = match (true) {
                $template === null => true,
                is_string($template) => $request->input('template') === $template,
                default => $template($request->body, $request) === true,
            };
            if ($hit) {
                $matching[] = $request;
            }
        }

        return $matching;
    }

    /** @param array<int, FormfeedRequest> $matching */
    private function assertTimes(array $matching, ?int $times, string $what): void
    {
        if ($times === null) {
            Assert::assertTrue($matching !== [], "{$what} was not asked for. " . $this->sent());

            return;
        }
        Assert::assertTrue(
            count($matching) === $times,
            "{$what} was asked for " . self::times(count($matching)) . ', not ' . self::times($times) . '. ' . $this->sent(),
        );
    }

    private function sent(): string
    {
        return $this->recorded === [] ? 'Nothing was sent.' : 'Sent: ' . self::list($this->recorded) . '.';
    }

    /** @param string|\Closure|null $template */
    private static function described(string $what, string|\Closure|null $template): string
    {
        return match (true) {
            $template === null => $what,
            is_string($template) => "{$what} of template {$template}",
            default => "{$what} matching the callback",
        };
    }

    /** @param array<int, FormfeedRequest> $requests */
    private static function list(array $requests): string
    {
        return implode(', ', array_map(static function (FormfeedRequest $request): string {
            $template = $request->input('template');

            return is_string($template) ? "{$request} ({$template})" : (string) $request;
        }, $requests));
    }

    private static function times(int $count): string
    {
        return $count === 1 ? 'once' : "{$count} times";
    }

    private function psr(FakeResponse $answer): ResponseInterface
    {
        $headers = $answer->headers;
        if (is_array($answer->body)) {
            $text = json_encode($answer->body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
            $headers += ['Content-Type' => 'application/json'];
        } else {
            $text = $answer->body ?? '';
        }
        $response = $this->responses->createResponse($answer->status);
        foreach ($headers as $name => $value) {
            $response = $response->withHeader($name, $value);
        }

        return $response->withBody($this->streams->createStream($text));
    }
}
