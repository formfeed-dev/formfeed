<?php

declare(strict_types=1);

namespace Formfeed\Tests\Support;

use Formfeed\Client;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7\Response;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

abstract class ClientTestCase extends TestCase
{
    /** A finished render as the API answers it. */
    protected const RENDER = [
        'id' => 'rnd_1',
        'status' => 'succeeded',
        'output' => 'pdf',
        'download_url' => 'https://cdn.formfeed.test/o/x.pdf?exp=1&sig=2',
        'expires_at' => '2026-12-18T10:00:00Z',
        'bytes' => 5681,
        'page_count' => 1,
        'units' => 1,
        'region' => 'eu',
        'environment' => 'test',
        'template' => ['id' => 'tpl_1', 'slug' => 'invoice', 'version' => 3],
        'meta' => [],
        'created_at' => '2026-11-18T10:00:00Z',
        'completed_at' => '2026-11-18T10:00:01Z',
    ];

    /** @var list<float> the seconds the client waited, in order */
    protected array $waits = [];

    /**
     * A client that sends to a stub and records its waits instead of sleeping.
     *
     * @param \Closure(RequestInterface, int): ResponseInterface $respond
     *
     * @return array{Client, StubHttp}
     */
    protected function client(\Closure $respond, int $maxRetries = 3, string $region = 'eu', ?string $baseUrl = null): array
    {
        $http = new StubHttp($respond);
        $factory = new Psr17Factory();
        $this->waits = [];
        $client = new Client(
            apiKey: 'ff_test_k',
            region: $region,
            baseUrl: $baseUrl,
            httpClient: $http,
            requestFactory: $factory,
            streamFactory: $factory,
            maxRetries: $maxRetries,
            sleep: function (float $seconds): void {
                $this->waits[] = $seconds;
            },
        );

        return [$client, $http];
    }

    /** @param array<string, string> $headers */
    protected static function json(mixed $body, int $status = 200, array $headers = []): ResponseInterface
    {
        return new Response($status, ['Content-Type' => 'application/json', ...$headers], json_encode($body, JSON_THROW_ON_ERROR));
    }

    /** @return array<string, mixed> */
    protected static function body(RequestInterface $request): array
    {
        $decoded = json_decode((string) $request->getBody(), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /**
     * The fields of a multipart request, the file under `file` as [filename, content type, bytes].
     *
     * @return array<string, string|array{string, string, string}>
     */
    protected static function parts(RequestInterface $request): array
    {
        self::assertMatchesRegularExpression('/^multipart\/form-data; boundary=/', $request->getHeaderLine('Content-Type'));
        $boundary = substr($request->getHeaderLine('Content-Type'), strlen('multipart/form-data; boundary='));
        $parts = [];
        foreach (explode("--{$boundary}", (string) $request->getBody()) as $chunk) {
            if (!str_contains($chunk, "\r\n\r\n")) {
                continue;
            }
            [$head, $content] = explode("\r\n\r\n", ltrim($chunk, "\r\n"), 2);
            $content = substr($content, 0, -2);
            if (preg_match('/name="([^"]*)"/', $head, $name) !== 1) {
                continue;
            }
            if (preg_match('/filename="([^"]*)"/', $head, $file) === 1) {
                preg_match('/Content-Type: (.*)/', $head, $type);
                $parts[$name[1]] = [$file[1], trim($type[1] ?? ''), $content];
            } else {
                $parts[$name[1]] = $content;
            }
        }

        return $parts;
    }
}
