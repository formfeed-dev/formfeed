<?php

declare(strict_types=1);

namespace Formfeed\Internal;

use Formfeed\FormfeedException;
use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamFactoryInterface;

/**
 * Auth, retries and problems, the rules every Formfeed SDK keeps (plan 34, decision 3): up to
 * `maxRetries` retries on 429, 503 and network errors, waiting a positive numeric `Retry-After` in
 * seconds, else 0.5 s doubling, plus up to 0.25 s of jitter, at most 30 s; a problem becomes one
 * `FormfeedException` with the code, the detail (else the title), the status and `X-Request-Id`.
 * `packages/api-types/fixtures/sdk` holds the cases, which every SDK's tests play.
 *
 * @internal
 */
final class Transport
{
    public const USER_AGENT = 'formfeed-sdk-php/0.3';

    /** @var \Closure(float): void */
    private readonly \Closure $sleep;

    /**
     * @param array<string, string>        $headers sent with every request, after the SDK's own
     * @param (\Closure(float): void)|null $sleep   how to wait, in seconds
     */
    public function __construct(
        private readonly string $apiKey,
        private readonly string $baseUrl,
        private readonly ClientInterface $http,
        private readonly RequestFactoryInterface $requests,
        private readonly StreamFactoryInterface $streams,
        private readonly int $maxRetries,
        private readonly array $headers,
        ?\Closure $sleep,
    ) {
        $this->sleep = $sleep ?? static function (float $seconds): void {
            usleep((int) round($seconds * 1_000_000));
        };
    }

    /**
     * The decoded JSON answer, null for one without a body (204).
     *
     * @param array<string, mixed>|Multipart|null $body
     */
    public function json(string $method, string $path, array|Multipart|null $body = null, ?string $idempotencyKey = null): mixed
    {
        $response = $this->send($method, $path, $body, $idempotencyKey);
        $text = (string) $response->getBody();
        if ($response->getStatusCode() === 204 || $text === '') {
            return null;
        }
        try {
            return json_decode($text, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new FormfeedException(
                'invalid_response',
                sprintf('the API answered HTTP %d with a body that is not JSON', $response->getStatusCode()),
                $response->getStatusCode(),
                null,
                null,
                $e,
            );
        }
    }

    /**
     * An answer that is a JSON object.
     *
     * @param array<string, mixed>|Multipart|null $body
     *
     * @return array<string, mixed>
     */
    public function object(string $method, string $path, array|Multipart|null $body = null, ?string $idempotencyKey = null): array
    {
        $value = $this->json($method, $path, $body, $idempotencyKey);
        if (!is_array($value)) {
            throw new FormfeedException('invalid_response', "the API answered {$method} {$path} without a JSON object");
        }

        return Fields::stringKeys($value);
    }

    /** Waits, the way the client was told to (seconds). */
    public function wait(float $seconds): void
    {
        ($this->sleep)($seconds);
    }

    /** A signed link of the CDN as bytes, without the API key, which the link does not need. */
    public function download(string $url): string
    {
        try {
            $response = $this->http->sendRequest($this->requests->createRequest('GET', $url));
        } catch (ClientExceptionInterface $e) {
            throw new FormfeedException('network_error', $e->getMessage(), 0, null, null, $e);
        }
        if ($response->getStatusCode() >= 400) {
            throw new FormfeedException(
                'download_failed',
                sprintf('download answered HTTP %d', $response->getStatusCode()),
                $response->getStatusCode(),
            );
        }

        return (string) $response->getBody();
    }

    /** The seconds to wait before retry number `$attempt` (from 1), with the server's Retry-After. */
    public static function backoff(int $attempt, ?string $retryAfter): float
    {
        $base = 0.5 * 2 ** ($attempt - 1);
        $header = $retryAfter === null ? '' : trim($retryAfter);
        if ($header !== '' && is_numeric($header)) {
            $value = (float) $header;
            if ($value > 0 && is_finite($value)) {
                $base = $value;
            }
        }

        return min(30.0, $base + mt_rand(0, 250_000) / 1_000_000);
    }

    /**
     * @param array<string, mixed>|Multipart|null $body
     */
    private function send(string $method, string $path, array|Multipart|null $body, ?string $idempotencyKey): ResponseInterface
    {
        for ($attempt = 0; ; ++$attempt) {
            $request = $this->requests->createRequest($method, $this->baseUrl . $path)
                ->withHeader('Authorization', 'Bearer ' . $this->apiKey)
                ->withHeader('Accept', 'application/json')
                ->withHeader('User-Agent', self::USER_AGENT);
            foreach ($this->headers as $name => $value) {
                $request = $request->withHeader($name, $value);
            }
            if ($idempotencyKey !== null) {
                $request = $request->withHeader('Idempotency-Key', $idempotencyKey);
            }
            // a fresh stream for every attempt, so a retry sends the same bytes again
            if ($body instanceof Multipart) {
                $request = $request
                    ->withHeader('Content-Type', $body->contentType())
                    ->withBody($this->streams->createStream($body->body()));
            } elseif ($body !== null) {
                $request = $request
                    ->withHeader('Content-Type', 'application/json')
                    ->withBody($this->streams->createStream(Json::encode($body)));
            }

            try {
                $response = $this->http->sendRequest($request);
            } catch (ClientExceptionInterface $e) {
                if ($attempt < $this->maxRetries) {
                    $this->wait(self::backoff($attempt + 1, null));
                    continue;
                }
                throw new FormfeedException('network_error', $e->getMessage(), 0, null, null, $e);
            }

            $status = $response->getStatusCode();
            if (($status === 429 || $status === 503) && $attempt < $this->maxRetries) {
                $retryAfter = $response->getHeaderLine('Retry-After');
                $this->wait(self::backoff($attempt + 1, $retryAfter === '' ? null : $retryAfter));
                continue;
            }
            if ($status >= 400) {
                throw self::problem($response);
            }

            return $response;
        }
    }

    private static function problem(ResponseInterface $response): FormfeedException
    {
        $status = $response->getStatusCode();
        $problem = [];
        $text = (string) $response->getBody();
        if ($text !== '') {
            try {
                $decoded = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decoded) && ($decoded === [] || !array_is_list($decoded))) {
                    $problem = Fields::stringKeys($decoded);
                }
            } catch (\JsonException) {
                // a body that is not JSON, such as a proxy's page: the status speaks for it
            }
        }
        $code = Fields::stringOrNull($problem, 'code');
        $detail = Fields::stringOrNull($problem, 'detail');
        $title = Fields::stringOrNull($problem, 'title');
        $requestId = $response->getHeaderLine('X-Request-Id');

        return new FormfeedException(
            $code !== null && $code !== '' ? $code : "http_{$status}",
            $detail !== null && $detail !== '' ? $detail : ($title !== null && $title !== '' ? $title : "HTTP {$status}"),
            $status,
            $problem === [] ? null : $problem,
            $requestId === '' ? null : $requestId,
        );
    }
}
